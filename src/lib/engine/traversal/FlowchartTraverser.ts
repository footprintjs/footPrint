/**
 * FlowchartTraverser — Pre-order DFS traversal of StageNode graph.
 *
 * Unified traversal algorithm for all node shapes. `executeNode` is a
 * TRAMPOLINE driver: it runs `executeNodeStep` (one node, all 7 phases) in
 * a flat loop, following tail continuations (linear `next`, loop edges,
 * dynamic next, flat decider dispatch) iteratively — so chain length and
 * loop iterations never grow the call stack. Only true tree nesting (fork
 * children, with-continuation decider/selector branches, subflow mounts)
 * recurses.
 *
 * For each node, executeNodeStep follows 7 phases:
 *   0. CLASSIFY  — subflow detection, early delegation
 *   1. VALIDATE  — node invariants, role markers
 *   2. EXECUTE   — run stage fn, commit, break check
 *   3. DYNAMIC   — StageNode return detection, subflow auto-registration, structure updates
 *   4. CHILDREN  — fork/selector/decider dispatch
 *   5. CONTINUE  — dynamic next / linear next resolution
 *   6. LEAF      — no continuation, return output
 *
 * Break semantics: If a stage calls breakFn(), commit and STOP.
 * Patch model: Stage writes into local patch; commitPatch() after return or throw.
 */

import type { StageContext } from '../../memory/StageContext.js';
import { isPauseSignal } from '../../pause/types.js';
import type { ScopeProtectionMode } from '../../scope/protection/types.js';
import { extractErrorInfo } from '../errors/errorInfo.js';
import { isStageNodeReturn } from '../graph/StageNode.js';
import { ChildrenExecutor } from '../handlers/ChildrenExecutor.js';
import { ContinuationResolver } from '../handlers/ContinuationResolver.js';
import { DeciderHandler } from '../handlers/DeciderHandler.js';
import { NodeResolver } from '../handlers/NodeResolver.js';
import { RuntimeStructureManager } from '../handlers/RuntimeStructureManager.js';
import { SelectorHandler } from '../handlers/SelectorHandler.js';
import { StageRunner } from '../handlers/StageRunner.js';
import { SubflowExecutor } from '../handlers/SubflowExecutor.js';
import type { BreakFlag } from '../handlers/types.js';
import { FlowRecorderDispatcher } from '../narrative/FlowRecorderDispatcher.js';
import { NarrativeFlowRecorder } from '../narrative/NarrativeFlowRecorder.js';
import { NullControlFlowNarrativeGenerator } from '../narrative/NullControlFlowNarrativeGenerator.js';
import type { FlowRecorder, IControlFlowNarrative, TraversalContext } from '../narrative/types.js';
import { buildRuntimeStageId } from '../runtimeStageId.js';
import type {
  HandlerDeps,
  IExecutionRuntime,
  ILogger,
  NodeResultType,
  ScopeFactory,
  Selector,
  SerializedPipelineStructure,
  StageFunction,
  StageNode,
  StreamHandlers,
  SubflowMountOptions,
  SubflowResult,
  SubflowTraverserFactory,
  TraversalResult,
} from '../types.js';

export interface TraverserOptions<TOut = any, TScope = any> {
  root: StageNode<TOut, TScope>;
  stageMap: Map<string, StageFunction<TOut, TScope>>;
  scopeFactory: ScopeFactory<TScope>;
  executionRuntime: IExecutionRuntime;
  readOnlyContext?: unknown;
  /** Execution environment — propagates to subflows automatically. */
  executionEnv?: import('../../engine/types.js').ExecutionEnv;
  throttlingErrorChecker?: (error: unknown) => boolean;
  streamHandlers?: StreamHandlers;
  scopeProtectionMode?: ScopeProtectionMode;
  subflows?: Record<string, { root: StageNode<TOut, TScope> }>;
  narrativeEnabled?: boolean;
  buildTimeStructure?: SerializedPipelineStructure;
  logger: ILogger;
  signal?: AbortSignal;
  /** Pre-configured FlowRecorders to attach when narrative is enabled. */
  flowRecorders?: FlowRecorder[];
  /**
   * Pre-configured narrative generator. If provided, takes precedence over
   * flowRecorders and narrativeEnabled. Used by the subflow traverser factory
   * to share the parent's narrative generator with subflow traversers.
   */
  narrativeGenerator?: IControlFlowNarrative;
  /**
   * Maximum nested executeNode depth (tree nesting — branch/fork dispatch and
   * dynamic recursion, NOT linear chains or loop iterations, which run flat).
   * Defaults to FlowchartTraverser.MAX_EXECUTE_DEPTH (500).
   */
  maxDepth?: number;
  /**
   * Maximum loop iterations per node (the ContinuationResolver guard).
   * Defaults to DEFAULT_MAX_ITERATIONS (1000). Propagated to subflow
   * traversers. Must be >= 1.
   */
  maxIterations?: number;
  /**
   * When this traverser runs inside a subflow, set this to the subflow's ID.
   * Propagated to TraversalContext so narrative entries carry the correct subflowId.
   */
  parentSubflowId?: string;
  /**
   * When this traverser runs inside a subflow, the runtimeStageId of the
   * subflow MOUNT stage in the parent traverser. Used as the
   * `parentRuntimeStageId` fallback for stages whose StageContext has no
   * parent (the subflow's own root context is created fresh by
   * SubflowExecutor) so runtime ancestor chains cross subflow boundaries
   * (RFC-003 D1).
   */
  parentMountRuntimeStageId?: string;
  /** Shared execution counter from parent traverser. Subflows continue the parent's numbering. */
  executionCounter?: { value: number };
  /**
   * Shared per-run visit-count map (keyed by stageId) from the parent traverser.
   * Drives `TraversalContext.loopIteration`. Shared with subflows so a stage
   * re-entered across a subflow re-mount keeps a correct, monotonic iteration
   * count — the same single-map semantics the narrative recorder uses.
   */
  visitCounts?: Map<string, number>;
  /**
   * Per-subflow scope captures from a checkpoint, on the resume path.
   * Forwarded to `HandlerDeps.subflowStatesForResume` so SubflowExecutor
   * can re-seed nested runtimes from pre-pause state instead of running
   * the inputMapper. Undefined on normal `run()` paths.
   */
  subflowStatesForResume?: Record<string, Record<string, unknown>>;
  /**
   * Per-`executor.run()` identifier. Threaded into every TraversalContext
   * this traverser produces so recorders can scope state to a single run.
   * Subflow traversers inherit the parent's runId (the subflow is part of
   * the same run from the consumer's POV). Required field — every event
   * needs it. See `runner/runId.ts`.
   */
  runId: string;
}

/**
 * Traverser-local overlay entry for a node whose stage function returned a
 * StageNode (dynamic continuation). Holds the dynamic values that earlier
 * versions wrote DIRECTLY onto the shared built-chart node — which leaked the
 * dynamic shape into every later run of the same built chart and raced
 * concurrent executors. The overlay keeps the built graph immutable: patches
 * live in a per-traverser Map keyed by `node.id` and die with the run.
 *
 * `next` is intentionally ABSENT: a dynamic `next` only ever applies to the
 * visit that produced it (the old code wrote `node.next` and restored it
 * before anything could observe the write), so it stays a local variable in
 * `executeNode` and is routed through `ContinuationResolver` directly.
 */
export interface DynamicNodePatch<TOut = any, TScope = any> {
  /**
   * Subflow mount metadata from a dynamic-subflow return. Grouped so the
   * merged view reproduces the old field-wise overwrite exactly — including
   * `subflowName`/`subflowMountOptions` becoming undefined when the dynamic
   * return omitted them.
   */
  subflowMeta?: {
    isSubflowRoot: true;
    subflowId: string;
    subflowName: string | undefined;
    subflowMountOptions: SubflowMountOptions | undefined;
  };
  /** Dynamic fork children (replaces the built node's children for this run). */
  children?: StageNode<TOut, TScope>[];
  /** Dynamic output-based selector accompanying dynamic children. */
  nextNodeSelector?: Selector;
}

/**
 * Trampoline brand — marks a continuation hop returned by `executeNodeStep`
 * to the driver loop in `executeNode`. Module-private symbol so a stage's own
 * return value (which can be any object) can never be mistaken for a hop.
 */
const CONTINUE_HOP: unique symbol = Symbol('footprintjs.executeNode.continue');

/**
 * A flat continuation — "execute this node next, in this context" — returned
 * by `executeNodeStep` for every TAIL continuation (linear `next`, loop
 * edges, dynamic next, dynamic-subflow re-entry, no-continuation decider
 * dispatch). The driver loop in `executeNode` consumes hops iteratively:
 * `current = hop; continue;` — so neither the call stack nor the retained
 * promise chain grows with chain length or loop iterations.
 */
interface ContinuationHop<TOut = any, TScope = any> {
  readonly [CONTINUE_HOP]: true;
  readonly node: StageNode<TOut, TScope>;
  readonly context: StageContext;
  readonly branchPath: string | undefined;
  /**
   * Present when the hop is a decider's branch dispatch (decider without its
   * own `next`). The driver records it so a PauseSignal thrown anywhere in
   * the continued chain still gets the decider stamped as its invoker —
   * exactly what the recursive dispatch's catch used to do.
   */
  readonly invokerStamp?: InvokerStamp;
}

/** Pause-invoker context recorded by the driver for flat decider dispatches. */
interface InvokerStamp {
  readonly invokerStageId: string;
  readonly continuationStageId?: string;
}

function isContinuationHop<TOut, TScope>(value: unknown): value is ContinuationHop<TOut, TScope> {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[CONTINUE_HOP] === true;
}

export class FlowchartTraverser<TOut = any, TScope = any> {
  private readonly root: StageNode<TOut, TScope>;
  private stageMap: Map<string, StageFunction<TOut, TScope>>;
  private readonly executionRuntime: IExecutionRuntime;
  private subflows: Record<string, { root: StageNode<TOut, TScope> }>;
  private readonly logger: ILogger;
  private readonly signal?: AbortSignal;
  private readonly parentSubflowId?: string;
  /** RFC-003 D1: runtimeStageId of the subflow mount stage in the parent
   *  traverser. Fallback `parentRuntimeStageId` for stages whose context has
   *  no parent (the subflow root). Undefined at the top level. */
  private readonly parentMountRuntimeStageId?: string;
  /** Frozen value passed via `run({input})`. Surfaced on `onRunStart` at the
   *  top-level traversal so consumers (e.g. `InOutRecorder`) can bracket
   *  the run with the same payload shape that subflows already have. */
  private readonly readOnlyContext?: unknown;
  /** Per-`executor.run()` identifier. Stamped onto every TraversalContext.
   *  Inherited by subflow traversers so all events of one run share one runId. */
  private readonly runId: string;

  // Handler modules
  private readonly nodeResolver: NodeResolver<TOut, TScope>;
  private readonly childrenExecutor: ChildrenExecutor<TOut, TScope>;
  private readonly subflowExecutor: SubflowExecutor<TOut, TScope>;
  private readonly stageRunner: StageRunner<TOut, TScope>;
  private readonly continuationResolver: ContinuationResolver<TOut, TScope>;
  private readonly deciderHandler: DeciderHandler<TOut, TScope>;
  private readonly selectorHandler: SelectorHandler<TOut, TScope>;
  private readonly structureManager: RuntimeStructureManager;
  private readonly narrativeGenerator: IControlFlowNarrative;
  private readonly flowRecorderDispatcher: FlowRecorderDispatcher | undefined;

  // Execution state
  private subflowResults: Map<string, SubflowResult> = new Map();

  /**
   * Per-traverser set of lazy subflow IDs that have been resolved by THIS run.
   * Used instead of writing `node.subflowResolver = undefined` back to the shared
   * StageNode graph — avoids a race where a concurrent traverser clears the shared
   * resolver before another traverser has finished using it.
   */
  private readonly resolvedLazySubflows = new Set<string>();

  /**
   * Per-traverser overlay of dynamic StageNode returns, keyed by `node.id`.
   * Phase 4 writes patches HERE instead of mutating the shared built-chart
   * node objects (same isolation convention as `resolvedLazySubflows`).
   * All engine reads of the patched fields go through the `eff*` accessors
   * below. The map dies with the traverser — one run, one overlay — so a
   * fresh executor over the same built chart always sees the original graph.
   *
   * Keyed by the node OBJECT (WeakMap), not `node.id`: a dynamic child that
   * reuses a built node's id must NOT make the built node inherit the patch
   * (id-keyed lookup caused phantom double-execution). `patchCount` is the
   * fast-path check — WeakMap has no `size`.
   */
  private readonly dynamicPatches = new WeakMap<StageNode<TOut, TScope>, DynamicNodePatch<TOut, TScope>>();
  private patchCount = 0;

  /**
   * TREE-nesting depth counter for executeNode (the trampoline driver).
   * Each driver invocation increments this; decrements on exit (try/finally).
   *
   * Linear `next` chains, loop edges, and dynamic continuations are followed
   * ITERATIVELY inside one driver invocation, so they never grow this
   * counter. Only true tree recursion does: fork children, decider/selector
   * branch dispatch (when the decider has its own continuation), and
   * unbounded dynamic recursion. Prevents call-stack overflow on runaway
   * recursive composition.
   */
  private _executeDepth = 0;

  /**
   * Memoized parent-chain depth per StageContext. The context tree deepens
   * by one per executed stage along a chain, so the naive parent-walk in
   * `computeContextDepth` is O(chain length) per stage — O(n²) per run once
   * the trampoline allows chains of tens of thousands of stages. Contexts
   * are visited parent-before-child, so the memo makes each lookup O(1)
   * amortized. WeakMap — dies with the traverser.
   */
  private readonly contextDepthCache = new WeakMap<StageContext, number>();

  /**
   * Shared mutable execution counter — monotonic, incremented per stage execution.
   * Shared with child traversers (subflows) so indices are globally unique within a run.
   */
  private readonly _executionCounter: { value: number };

  /**
   * Shared per-run visit counts keyed by stageId — how many times each stage
   * has executed in this run. Shared with child traversers (subflows) so a
   * looped-back stage's iteration count is monotonic across subflow re-mounts,
   * matching the narrative recorder's single-map semantics. Drives
   * `TraversalContext.loopIteration`.
   */
  private readonly _visitCounts: Map<string, number>;

  /**
   * Per-instance maximum depth (set from TraverserOptions.maxDepth or the class default).
   */
  private readonly _maxDepth: number;

  /**
   * Per-instance loop-iteration limit forwarded to the ContinuationResolver
   * and propagated to subflow traversers. Undefined → resolver default (1000).
   */
  private readonly _maxIterations?: number;

  /**
   * Default maximum nested executeNode depth before an error is thrown.
   *
   * **What counts as depth (trampoline model):** `executeNode` is an iterative
   * driver — linear `next` hops, loop edges (`loopTo`/dynamic next), and
   * dynamic-subflow re-entry are followed in a flat loop and consume NO depth.
   * Depth grows only with true tree nesting: one tick per fork child, one per
   * decider/selector branch dispatch that must return to its invoker (decider
   * with its own `next`), one per subflow mount frame in the parent (the
   * subflow body itself runs on a FRESH traverser with its own budget).
   *
   * 500 therefore covers any realistic chart — it bounds recursive
   * COMPOSITION, not chain length or loop count. Loops are bounded by
   * `ContinuationResolver`'s independent iteration limit (default 1000,
   * configurable via `RunOptions.maxIterations`), which is now the binding
   * constraint for loop-heavy pipelines.
   *
   * @remarks Not safe for concurrent `.execute()` calls on the same instance — concurrent
   * executions race on `_executeDepth`. Use a separate `FlowchartTraverser` per concurrent
   * execution. `FlowChartExecutor.run()` always creates a fresh traverser per call.
   */
  static readonly MAX_EXECUTE_DEPTH = 500;

  constructor(opts: TraverserOptions<TOut, TScope>) {
    const maxDepth = opts.maxDepth ?? FlowchartTraverser.MAX_EXECUTE_DEPTH;
    if (maxDepth < 1) throw new Error('FlowchartTraverser: maxDepth must be >= 1');
    this._maxDepth = maxDepth;
    if (opts.maxIterations !== undefined && opts.maxIterations < 1) {
      throw new Error('FlowchartTraverser: maxIterations must be >= 1');
    }
    this._maxIterations = opts.maxIterations;
    this._executionCounter = opts.executionCounter ?? { value: 0 };
    this._visitCounts = opts.visitCounts ?? new Map();
    this.root = opts.root;
    // Shallow-copy stageMap and subflows so that lazy-resolution mutations
    // (prefixed entries added during execution) stay scoped to THIS traverser
    // and do not escape to the shared FlowChart object. Without the copy,
    // concurrent FlowChartExecutor runs sharing the same FlowChart would race
    // on these two mutable dictionaries.
    this.stageMap = new Map(opts.stageMap);
    this.executionRuntime = opts.executionRuntime;
    this.subflows = opts.subflows ? { ...opts.subflows } : {};
    this.logger = opts.logger;
    this.signal = opts.signal;
    this.parentSubflowId = opts.parentSubflowId;
    this.parentMountRuntimeStageId = opts.parentMountRuntimeStageId;
    this.readOnlyContext = opts.readOnlyContext;
    this.runId = opts.runId;

    // Structure manager (deep-clones build-time structure)
    this.structureManager = new RuntimeStructureManager();
    this.structureManager.init(opts.buildTimeStructure);

    // Narrative generator
    // Priority: explicit narrativeGenerator > flowRecorders > default NarrativeFlowRecorder > null.
    // Subflow traversers receive the parent's narrativeGenerator so all events flow to one place.
    if (opts.narrativeGenerator) {
      this.narrativeGenerator = opts.narrativeGenerator;
    } else if (opts.narrativeEnabled) {
      const dispatcher = new FlowRecorderDispatcher();
      this.flowRecorderDispatcher = dispatcher;

      // If custom FlowRecorders are provided, use them; otherwise attach default NarrativeFlowRecorder
      if (opts.flowRecorders && opts.flowRecorders.length > 0) {
        for (const recorder of opts.flowRecorders) {
          dispatcher.attach(recorder);
        }
      } else {
        dispatcher.attach(new NarrativeFlowRecorder());
      }

      this.narrativeGenerator = dispatcher;
    } else {
      this.narrativeGenerator = new NullControlFlowNarrativeGenerator();
    }

    // Build shared deps bag
    const deps = this.createDeps(opts);

    // Build O(1) node ID map from the root graph (avoids repeated DFS on every loopTo())
    const nodeIdMap = this.buildNodeIdMap(opts.root);

    // Initialize handler modules.
    // NodeResolver's DFS fallback resolves loop targets against the LIVE
    // runtime shape, so it reads children through the dynamic-patch overlay
    // (a loop can target a node added by a dynamic StageNode return).
    this.nodeResolver = new NodeResolver(deps, nodeIdMap, (n) => this.effChildren(n));
    this.childrenExecutor = new ChildrenExecutor(deps, this.executeNode.bind(this));
    this.stageRunner = new StageRunner(deps);
    this.continuationResolver = new ContinuationResolver(
      deps,
      this.nodeResolver,
      (nodeId, count) => this.structureManager.updateIterationCount(nodeId, count),
      this._maxIterations,
    );
    this.deciderHandler = new DeciderHandler(deps);
    this.selectorHandler = new SelectorHandler(deps, this.childrenExecutor);
    this.subflowExecutor = new SubflowExecutor(deps, this.createSubflowTraverserFactory(opts));
  }

  /**
   * Create a factory that produces FlowchartTraverser instances for subflow execution.
   * Captures parent config in closure — SubflowExecutor provides subflow-specific overrides.
   * Each subflow gets a full traverser with all 7 phases (deciders, selectors, loops, etc.).
   */
  private createSubflowTraverserFactory(
    parentOpts: TraverserOptions<TOut, TScope>,
  ): SubflowTraverserFactory<TOut, TScope> {
    // Capture references to mutable state — factory reads the CURRENT state when called,
    // not the state at factory creation time. This is correct because lazy subflow resolution
    // may add entries to stageMap/subflows before a nested subflow is encountered.
    const parentStageMap = this.stageMap;
    const parentSubflows = this.subflows;
    const narrativeGenerator = this.narrativeGenerator;

    return (subflowOpts) => {
      const traverser = new FlowchartTraverser<TOut, TScope>({
        root: subflowOpts.root,
        stageMap: parentStageMap, // Constructor shallow-copies this
        scopeFactory: parentOpts.scopeFactory,
        executionRuntime: subflowOpts.executionRuntime,
        readOnlyContext: subflowOpts.readOnlyContext,
        executionEnv: parentOpts.executionEnv,
        throttlingErrorChecker: parentOpts.throttlingErrorChecker,
        streamHandlers: parentOpts.streamHandlers,
        scopeProtectionMode: parentOpts.scopeProtectionMode,
        subflows: parentSubflows, // Constructor shallow-copies this
        narrativeGenerator, // Share parent's — all events flow to one place
        logger: parentOpts.logger,
        signal: parentOpts.signal,
        maxDepth: this._maxDepth,
        ...(this._maxIterations !== undefined && { maxIterations: this._maxIterations }),
        parentSubflowId: subflowOpts.subflowId,
        // RFC-003 D1: the mount stage's runtimeStageId — parent fallback for
        // the subflow's root stage so ancestor chains cross the boundary.
        parentMountRuntimeStageId: subflowOpts.parentMountRuntimeStageId,
        executionCounter: this._executionCounter, // Share counter — subflow continues global numbering
        visitCounts: this._visitCounts, // Share visit counts — loopIteration stays monotonic across subflow re-mounts
        runId: this.runId, // Subflow inherits parent's runId — same logical run
        // Forward the resume-only subflow scope captures so nested
        // SubflowExecutors can re-seed deeper-nested runtimes (e.g.
        // Sequence(Agent(...)) where the inner Agent subflow paused).
        ...(parentOpts.subflowStatesForResume && {
          subflowStatesForResume: parentOpts.subflowStatesForResume,
        }),
      });

      return {
        execute: () => traverser.execute(),
        getSubflowResults: () => traverser.getSubflowResults(),
        getBreakState: () => traverser.getBreakState(),
      };
    };
  }

  private createDeps(opts: TraverserOptions<TOut, TScope>): HandlerDeps<TOut, TScope> {
    return {
      stageMap: this.stageMap,
      root: this.root,
      executionRuntime: this.executionRuntime,
      scopeFactory: opts.scopeFactory,
      subflows: this.subflows,
      throttlingErrorChecker: opts.throttlingErrorChecker,
      streamHandlers: opts.streamHandlers,
      scopeProtectionMode: opts.scopeProtectionMode ?? 'error',
      readOnlyContext: opts.readOnlyContext,
      executionEnv: opts.executionEnv,
      narrativeGenerator: this.narrativeGenerator,
      logger: this.logger,
      signal: opts.signal,
      ...(opts.subflowStatesForResume && {
        subflowStatesForResume: opts.subflowStatesForResume,
      }),
    };
  }

  // ─────────────────────── Public API ───────────────────────

  /**
   * Holds the top-level break flag for the duration of `execute()`. Kept as
   * a field (not a local) so `getBreakState()` can surface the final state
   * for callers like `SubflowExecutor` that implement `propagateBreak`.
   */
  private _topBreakFlag: { shouldBreak: boolean; reason?: string } = { shouldBreak: false };

  async execute(branchPath?: string): Promise<TraversalResult> {
    const context = this.executionRuntime.rootStageContext;
    this._topBreakFlag = { shouldBreak: false };

    // Fire onRunStart ONLY at the top-level traversal — subflow traversers
    // already produce onSubflowEntry/onSubflowExit pairs, so emitting run
    // events for them would double-bracket the boundary stream. The
    // top-level traverser is the one without a parentSubflowId.
    const isTopLevel = this.parentSubflowId === undefined;
    // Synthetic TraversalContext for run.entry / run.exit. Fields use
    // root-stage defaults (stageId='__root__', runtimeStageId='__root__#0',
    // depth 0) so the runId is reliably available on run events without
    // forcing recorders to handle `traversalContext === undefined`.
    const rootContext: TraversalContext = {
      runId: this.runId,
      stageId: '__root__',
      runtimeStageId: '__root__#0',
      stageName: '__root__',
      depth: 0,
    };
    if (isTopLevel) {
      // `readOnlyContext` is the engine's view of `run({input})` — passed
      // through from `FlowChartExecutor.run()` as the validated input.
      this.narrativeGenerator.onRunStart(this.readOnlyContext, rootContext);
    }

    // Top-level runs close their boundary SYMMETRICALLY: every onRunStart
    // is followed by exactly one onRunEnd (clean) or onRunFailed (error).
    // Without the catch, a thrown run fired onRunStart then nothing — a
    // monitor couldn't tell "still running" from "crashed." Pause is NOT
    // an error (it's expected suspension), so it skips onRunFailed and
    // re-throws untouched. The stage-level catch already recorded the
    // failing stage (onError + commit); this adds the run-level terminal
    // signal. The error still propagates — this is observation, not
    // recovery. Subflow traversers don't fire run events; their errors
    // bubble up and surface here at the top level.
    if (!isTopLevel) {
      return this.executeNode(this.root, context, this._topBreakFlag, branchPath ?? '');
    }
    let result: TraversalResult;
    try {
      result = await this.executeNode(this.root, context, this._topBreakFlag, branchPath ?? '');
    } catch (error: unknown) {
      if (!isPauseSignal(error)) {
        this.narrativeGenerator.onRunFailed(extractErrorInfo(error), rootContext);
      }
      throw error;
    }
    this.narrativeGenerator.onRunEnd(result, rootContext);
    return result;
  }

  /**
   * Break state captured at the top-level of the most recent `execute()`.
   * `shouldBreak` is true when a stage called `scope.$break(reason)`; the
   * optional `reason` carries the string passed to `$break`.
   *
   * Used by `SubflowExecutor` to propagate an inner subflow's break up to
   * the parent traverser when the mount sets `propagateBreak: true`.
   */
  getBreakState(): { shouldBreak: boolean; reason?: string } {
    return { ...this._topBreakFlag };
  }

  getRuntimeStructure(): SerializedPipelineStructure | undefined {
    return this.structureManager.getStructure();
  }

  getSnapshot(options?: { redact?: boolean }) {
    return this.executionRuntime.getSnapshot(options);
  }

  getRuntime() {
    return this.executionRuntime;
  }

  setRootObject(path: string[], key: string, value: unknown) {
    this.executionRuntime.setRootObject(path, key, value);
  }

  getBranchIds() {
    return this.executionRuntime.getPipelines();
  }

  getRuntimeRoot(): StageNode {
    return this.root;
  }

  getSubflowResults(): Map<string, SubflowResult> {
    return this.subflowResults;
  }

  getNarrative(): string[] {
    return this.narrativeGenerator.getSentences();
  }

  /** Returns the FlowRecorderDispatcher, or undefined if narrative is disabled. */
  getFlowRecorderDispatcher(): FlowRecorderDispatcher | undefined {
    return this.flowRecorderDispatcher;
  }

  // ─────────────────────── Core Traversal ───────────────────────

  /**
   * Build an O(1) ID→node map from the root graph.
   * Used by NodeResolver to avoid repeated DFS on every loopTo() call.
   * Iterative worklist (no recursion) so arbitrarily long chains index fully;
   * the `map.has` guard handles cyclic refs. First-visited node wins per ID —
   * worklist order matches the old recursive pre-order (children, then next).
   * Dynamic subflows and lazy-resolved nodes are added to stageMap at runtime but not to this map —
   * those use the DFS fallback in NodeResolver.
   */
  private buildNodeIdMap(root: StageNode<TOut, TScope>): Map<string, StageNode<TOut, TScope>> {
    const map = new Map<string, StageNode<TOut, TScope>>();
    const stack: StageNode<TOut, TScope>[] = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (map.has(node.id)) continue; // already visited (avoids infinite loops on cyclic refs)
      map.set(node.id, node);
      // Push in reverse visit order (LIFO stack): next first, then children
      // reversed — so children are visited before next, first child first,
      // matching the recursive pre-order exactly.
      if (node.next) stack.push(node.next);
      if (node.children) {
        for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
      }
    }
    return map;
  }

  private getStageFn(node: StageNode<TOut, TScope>): StageFunction<TOut, TScope> | undefined {
    if (typeof node.fn === 'function') return node.fn as StageFunction<TOut, TScope>;
    // Primary: look up by id (stable identifier, keyed by FlowChartBuilder)
    const byId = this.stageMap.get(node.id);
    if (byId !== undefined) return byId;
    // Fallback: look up by name (supports hand-crafted stageMaps in tests and advanced use)
    return this.stageMap.get(node.name);
  }

  // ─────────────── Dynamic-patch overlay accessors ───────────────
  //
  // Every engine read of a field that Phase 4 can patch (children,
  // nextNodeSelector, subflow meta) goes through these. Fast path: charts
  // with no dynamic returns never allocate and pay one `size === 0` check.

  private getPatch(node: StageNode<TOut, TScope>): DynamicNodePatch<TOut, TScope> | undefined {
    if (this.patchCount === 0) return undefined;
    return this.dynamicPatches.get(node);
  }

  private getOrCreatePatch(node: StageNode<TOut, TScope>): DynamicNodePatch<TOut, TScope> {
    let patch = this.dynamicPatches.get(node);
    if (!patch) {
      patch = {};
      this.dynamicPatches.set(node, patch);
      this.patchCount++;
    }
    return patch;
  }

  /** Effective children: dynamic patch first, then the built node's children. */
  private effChildren(node: StageNode<TOut, TScope>): StageNode<TOut, TScope>[] | undefined {
    return this.getPatch(node)?.children ?? node.children;
  }

  /** Effective output-based selector: dynamic patch first, then the built node's. */
  private effSelector(node: StageNode<TOut, TScope>): Selector | undefined {
    return this.getPatch(node)?.nextNodeSelector ?? node.nextNodeSelector;
  }

  /** Effective subflow-root marker (true when a dynamic subflow was patched on). */
  private effIsSubflowRoot(node: StageNode<TOut, TScope>): boolean | undefined {
    const meta = this.getPatch(node)?.subflowMeta;
    return meta ? true : node.isSubflowRoot;
  }

  /** Effective subflow id (patched verbatim by a dynamic subflow return). */
  private effSubflowId(node: StageNode<TOut, TScope>): string | undefined {
    const meta = this.getPatch(node)?.subflowMeta;
    return meta ? meta.subflowId : node.subflowId;
  }

  /**
   * Materialize the effective view of a node — field-identical to what the
   * pre-overlay code produced by mutating the shared node. Used where a node
   * is handed to a helper executor (NodeResolver / SubflowExecutor /
   * ChildrenExecutor) so helpers never read stale built fields. Returns the
   * node itself (no allocation) when it carries no patch.
   */
  private effNode(node: StageNode<TOut, TScope>): StageNode<TOut, TScope> {
    const patch = this.getPatch(node);
    if (!patch) return node;
    const merged: StageNode<TOut, TScope> = { ...node };
    if (patch.subflowMeta) {
      merged.isSubflowRoot = true;
      merged.subflowId = patch.subflowMeta.subflowId;
      merged.subflowName = patch.subflowMeta.subflowName;
      merged.subflowMountOptions = patch.subflowMeta.subflowMountOptions;
    }
    if (patch.children) merged.children = patch.children;
    if (patch.nextNodeSelector) merged.nextNodeSelector = patch.nextNodeSelector;
    return merged;
  }

  private async executeStage(
    node: StageNode<TOut, TScope>,
    stageFunc: StageFunction<TOut, TScope>,
    context: StageContext,
    breakFn: () => void,
  ) {
    // runtimeStageId is assigned in executeNode() before traversalContext creation,
    // ensuring scope events and flow events use the same value.
    return this.stageRunner.run(node, stageFunc, context, breakFn);
  }

  /**
   * Trampoline driver — pre-order DFS traversal entry point.
   *
   * Runs `executeNodeStep` (one node, all 7 phases) in a flat loop: every
   * TAIL continuation (linear `next`, loop edge, dynamic next / dynamic
   * re-entry, no-continuation decider dispatch) comes back as a
   * `ContinuationHop` and is followed ITERATIVELY — neither the call stack
   * nor the retained promise chain grows with chain length or loop count.
   *
   * Recursion remains ONLY for true tree nesting (each gets a nested driver
   * call): fork children (`ChildrenExecutor`), selector branches (parallel
   * fan-out), decider branch dispatch when the decider has its own `next`
   * (the branch must complete BEFORE the decider's continuation runs), and
   * subflow mounts (fresh traverser; the mount frame stays in the parent).
   * `_executeDepth` therefore counts chart COMPOSITION depth only, guarded
   * by `_maxDepth` (default `MAX_EXECUTE_DEPTH` = 500).
   *
   * PauseSignal: a flat decider dispatch records an `InvokerStamp`; if the
   * continued chain later pauses, the driver stamps the signal during
   * unwind — same invoker context the recursive dispatch's catch used to
   * stamp, innermost (most recent dispatch) first.
   */
  private async executeNode(
    node: StageNode<TOut, TScope>,
    context: StageContext,
    breakFlag: BreakFlag,
    branchPath?: string,
  ): Promise<any> {
    // Invoker stamps from flat decider dispatches in THIS driver — kept
    // local so nested drivers (fork children, with-next decider branches)
    // get their own windows, matching the old frame-on-stack stamping scope.
    let pendingInvokers: InvokerStamp[] | undefined;
    // ─── Tree-depth guard ───
    // The increment is inside `try` so `finally` always decrements — no
    // fragile gap between check and try entry.
    try {
      if (++this._executeDepth > this._maxDepth) {
        throw new Error(
          `FlowchartTraverser: maximum traversal depth exceeded (${this._maxDepth}). ` +
            'Depth counts NESTED dispatch (fork children, decider/selector branches, recursive composition) — ' +
            'linear chains and loop iterations run flat and do not consume it. ' +
            `Last stage: '${node.name}'. ` +
            'Check for unbounded recursive chart composition, or raise the limit via RunOptions.maxDepth.',
        );
      }

      let current: ContinuationHop<TOut, TScope> = { [CONTINUE_HOP]: true, node, context, branchPath };
      for (;;) {
        const result = await this.executeNodeStep(current.node, current.context, breakFlag, current.branchPath);
        if (!isContinuationHop<TOut, TScope>(result)) {
          return result;
        }
        if (result.invokerStamp) (pendingInvokers ??= []).push(result.invokerStamp);
        current = result;
      }
    } catch (error: unknown) {
      // Replay invoker stamps most-recent-first. `setInvoker` is
      // first-write-wins, so the innermost dispatch's stamp lands — exactly
      // the old bubble-up order through nested catch frames.
      if (pendingInvokers !== undefined && isPauseSignal(error)) {
        for (let i = pendingInvokers.length - 1; i >= 0; i--) {
          error.setInvoker(pendingInvokers[i].invokerStageId, pendingInvokers[i].continuationStageId);
        }
      }
      throw error;
    } finally {
      this._executeDepth--;
    }
  }

  /** Build a flat continuation hop for the driver loop. */
  private hop(
    node: StageNode<TOut, TScope>,
    context: StageContext,
    branchPath: string | undefined,
    invokerStamp?: InvokerStamp,
  ): ContinuationHop<TOut, TScope> {
    return { [CONTINUE_HOP]: true, node, context, branchPath, ...(invokerStamp && { invokerStamp }) };
  }

  /**
   * Execute ONE node through all 7 phases — the old recursive `executeNode`
   * body; only the tail calls became `ContinuationHop` returns. Returns the
   * node's result, or a hop for the driver loop to follow.
   */
  private async executeNodeStep(
    node: StageNode<TOut, TScope>,
    context: StageContext,
    breakFlag: BreakFlag,
    branchPath?: string,
  ): Promise<any> {
    // Attach builder metadata to context for snapshot enrichment.
    // Subflow meta reads go through the dynamic-patch overlay — a node
    // patched by a dynamic-subflow return re-enters executeNode and must
    // classify as a subflow without the shared node ever being mutated.
    if (node.description) context.description = node.description;
    const effSubflowId = this.effSubflowId(node);
    if (this.effIsSubflowRoot(node) && effSubflowId) context.subflowId = effSubflowId;

    // Assign runtimeStageId BEFORE traversalContext creation — ensures scope events
    // (buffered by runtimeStageId) and flow events (flushed by traversalContext.runtimeStageId)
    // use the same value. Must happen before executeStage AND before traversalContext.
    const idx = this._executionCounter.value++;
    context.runtimeStageId = buildRuntimeStageId(node.id, idx);

    // RFC-003 D1: runtime parent — the previous execution step's runtimeStageId.
    // Falls back to the subflow MOUNT's runtimeStageId for the subflow root
    // stage (its StageContext is created fresh with no parent), so runtime
    // ancestor chains cross subflow boundaries. `||` (not `??`) on purpose:
    // a parent context that never executed still carries the field's
    // initial `''`, which must also fall through to the mount fallback.
    const parentRuntimeStageId = context.parent?.runtimeStageId || this.parentMountRuntimeStageId;

    // loopIteration — how many times THIS stage has run before in this run.
    // Keyed by the same stageId we stamp on the context (and the same value the
    // narrative recorder counts on), run-scoped and shared across subflow
    // re-mounts via `_visitCounts`. undefined on the first visit; 1 on the
    // first loop-back, 2 on the next, … — i.e. visitCount - 1. Counted for
    // EVERY stage kind (any node can be a loop target), unlike the narrative
    // recorder which only renders it for linear stages.
    const contextStageId = node.id ?? context.stageId;
    const visitCount = (this._visitCounts.get(contextStageId) ?? 0) + 1;
    this._visitCounts.set(contextStageId, visitCount);
    const loopIteration = visitCount > 1 ? visitCount - 1 : undefined;

    // Build traversal context for recorder events — created once per stage, shared by all events
    const traversalContext: TraversalContext = {
      runId: this.runId,
      stageId: contextStageId,
      runtimeStageId: context.runtimeStageId,
      stageName: node.name,
      parentStageId: context.parent?.stageId,
      ...(parentRuntimeStageId && { parentRuntimeStageId }),
      ...(loopIteration !== undefined && { loopIteration }),
      subflowId: context.subflowId ?? this.parentSubflowId,
      subflowPath: branchPath || undefined,
      depth: this.computeContextDepth(context),
    };

    // ─── Phase 0a: LAZY RESOLVE — deferred subflow resolution ───
    // Guard uses the per-traverser resolvedLazySubflows set (not the shared node) so
    // concurrent traversers do not race on node.subflowResolver or clear it for each other.
    if (node.isSubflowRoot && node.subflowResolver && !this.resolvedLazySubflows.has(node.subflowId!)) {
      const resolved = node.subflowResolver();
      const prefixedRoot = this.prefixNodeTree(resolved.root as StageNode<TOut, TScope>, node.subflowId!);

      // Register the resolved subflow (same path as eager registration)
      this.subflows[node.subflowId!] = { root: prefixedRoot };

      // Merge stageMap entries
      for (const [key, fn] of resolved.stageMap) {
        const prefixedKey = `${node.subflowId}/${key}`;
        if (!this.stageMap.has(prefixedKey)) {
          this.stageMap.set(prefixedKey, fn as StageFunction<TOut, TScope>);
        }
      }

      // Merge nested subflows
      if (resolved.subflows) {
        for (const [key, def] of Object.entries(resolved.subflows)) {
          const prefixedKey = `${node.subflowId}/${key}`;
          if (!this.subflows[prefixedKey]) {
            this.subflows[prefixedKey] = def as { root: StageNode<TOut, TScope> };
          }
        }
      }

      // Update runtime structure with the now-resolved spec
      this.structureManager.updateDynamicSubflow(
        node.id,
        node.subflowId!,
        node.subflowName,
        resolved.buildTimeStructure,
      );

      // Mark as resolved for THIS traverser — per-traverser set prevents re-entry
      // without mutating the shared StageNode graph (which would race concurrent traversers).
      this.resolvedLazySubflows.add(node.subflowId!);
    }

    // ─── Phase 0: CLASSIFY — subflow detection ───
    if (this.effIsSubflowRoot(node) && effSubflowId) {
      // Hand helpers the EFFECTIVE node view (built fields + dynamic patch)
      // so SubflowExecutor/NodeResolver never read stale built fields.
      const mountNode = this.effNode(node);
      const resolvedNode = this.nodeResolver.resolveSubflowReference(mountNode);

      const subflowOutput = await this.subflowExecutor.executeSubflow(
        resolvedNode,
        context,
        breakFlag,
        branchPath,
        this.subflowResults,
        traversalContext,
      );

      const isReferenceBasedSubflow = resolvedNode !== mountNode;
      const hasChildren = Boolean(mountNode.children && mountNode.children.length > 0);
      const shouldExecuteContinuation = isReferenceBasedSubflow || hasChildren;

      // ─── Break-flag check AFTER subflow returns ───
      // If the subflow was mounted with `propagateBreak: true` and broke
      // internally, `SubflowExecutor` has already flipped our breakFlag.
      // Stop the outer traversal here — do not run the next linear stage.
      if (breakFlag.shouldBreak) {
        return subflowOutput;
      }

      if (node.next && shouldExecuteContinuation) {
        const nextCtx = context.createNext(branchPath as string, node.next.name, node.next.id);
        return this.hop(node.next, nextCtx, branchPath);
      }

      return subflowOutput;
    }

    const stageFunc = this.getStageFn(node);
    const hasStageFunction = Boolean(stageFunc);
    const isScopeBasedDecider = Boolean(node.deciderFn);
    const isScopeBasedSelector = Boolean(node.selectorFn);
    const isDeciderNode = isScopeBasedDecider;
    const hasChildren = Boolean(this.effChildren(node)?.length);
    // `next` is never overlaid — a dynamic next applies only to the visit
    // that produced it (handled via the `dynamicNext` local below), so the
    // built chart's next is always the correct continuation here.
    const hasNext = Boolean(node.next);
    const originalNext = node.next;

    // ─── Phase 1: VALIDATE — node invariants ───
    if (!hasStageFunction && !isDeciderNode && !isScopeBasedSelector && !hasChildren) {
      const errorMessage = `Node '${node.name}' must define: embedded fn OR a stageMap entry OR have children/decider`;
      this.logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error: errorMessage });
      throw new Error(errorMessage);
    }
    if (isDeciderNode && !hasChildren) {
      const errorMessage = 'Decider node needs to have children to execute';
      this.logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error: errorMessage });
      throw new Error(errorMessage);
    }
    if (isScopeBasedSelector && !hasChildren) {
      const errorMessage = 'Selector node needs to have children to execute';
      this.logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error: errorMessage });
      throw new Error(errorMessage);
    }

    // Role markers for debug panels
    if (!hasStageFunction) {
      if (isDeciderNode) context.setAsDecider();
      else if (hasChildren) context.setAsFork();
    }

    // Break handler wired to the scope. Captures the optional reason
    // passed via `scope.$break(reason)` and parks it on the breakFlag so
    // downstream code (FlowRecorder.onBreak, subflow propagation) can
    // surface it. A second $break call in the same stage keeps the FIRST
    // reason — first-break-wins — matching the "execution stopped" story.
    const breakFn = (reason?: string) => {
      breakFlag.shouldBreak = true;
      if (reason !== undefined && breakFlag.reason === undefined) {
        breakFlag.reason = reason;
      }
    };

    // ─── Phase 2a: SELECTOR — scope-based multi-choice ───
    if (isScopeBasedSelector) {
      const selectorResult = await this.selectorHandler.handleScopeBased(
        node,
        stageFunc!,
        context,
        breakFlag,
        branchPath,
        this.executeStage.bind(this),
        this.executeNode.bind(this),
        traversalContext,
      );

      if (hasNext) {
        const nextCtx = context.createNext(branchPath as string, node.next!.name, node.next!.id);
        return this.hop(node.next!, nextCtx, branchPath);
      }
      return selectorResult;
    }

    // ─── Phase 2b: DECIDER — scope-based single-choice conditional branch ───
    if (isDeciderNode) {
      const dispatch = await this.deciderHandler.prepareDispatch(
        node,
        stageFunc!,
        context,
        breakFlag,
        branchPath,
        this.executeStage.bind(this),
        traversalContext,
      );

      // No decider-level continuation → the branch dispatch is a tail
      // call. Hand it to the driver as a flat hop so loop-heavy decider
      // charts (e.g. agent ReAct loops with branch-sourced `loopTo`) stay
      // flat-stacked. The invoker stamp preserves PauseSignal semantics —
      // the decider is the invoker of whatever pauses in the chain.
      if (!hasNext && dispatch.kind === 'dispatch') {
        return this.hop(dispatch.chosen, dispatch.branchContext, branchPath, {
          invokerStageId: node.id!,
          continuationStageId: node.next?.id,
        });
      }

      // Decider WITH its own next: the branch chain must complete BEFORE
      // the decider's continuation runs — true tree nesting, kept
      // recursive (a nested driver). Mirrors handleScopeBased exactly,
      // including the PauseSignal invoker stamp on bubble-up.
      let deciderResult: any;
      if (dispatch.kind === 'break') {
        deciderResult = dispatch.branchId;
      } else {
        try {
          deciderResult = await this.executeNode(dispatch.chosen, dispatch.branchContext, breakFlag, branchPath);
        } catch (error: unknown) {
          if (isPauseSignal(error)) {
            error.setInvoker(node.id!, node.next?.id);
          }
          throw error;
        }
      }

      // After branch execution, follow decider's own next (e.g., loopTo target)
      if (hasNext && !breakFlag.shouldBreak) {
        const nextNode = originalNext!;
        // Use the isLoopRef flag set by loopTo() — do not rely on stageMap absence,
        // since id-keyed stageMaps would otherwise cause loop targets to be executed directly.
        const isLoopRef =
          nextNode.isLoopRef === true ||
          (!this.getStageFn(nextNode) &&
            !this.effChildren(nextNode)?.length &&
            !nextNode.deciderFn &&
            !nextNode.selectorFn &&
            !this.effIsSubflowRoot(nextNode));

        if (isLoopRef) {
          const target = this.continuationResolver.resolveTarget(nextNode, node, context, branchPath);
          return this.hop(target.node, target.context, branchPath);
        }

        this.narrativeGenerator.onNext(node.name, nextNode.name, nextNode.description, traversalContext);
        const nextCtx = context.createNext(branchPath as string, nextNode.name, nextNode.id);
        return this.hop(nextNode, nextCtx, branchPath);
      }

      return deciderResult;
    }

    // ─── Abort check — cooperative cancellation ───
    if (this.signal?.aborted) {
      const reason =
        this.signal.reason instanceof Error ? this.signal.reason : new Error(this.signal.reason ?? 'Aborted');
      throw reason;
    }

    // ─── Phase 3: EXECUTE — run stage function ───
    let stageOutput: TOut | undefined;
    let dynamicNext: StageNode<TOut, TScope> | undefined;

    if (stageFunc) {
      try {
        stageOutput = await this.executeStage(node, stageFunc, context, breakFn);
      } catch (error: any) {
        // PauseSignal is expected control flow, not an error — fire narrative, commit, re-throw.
        if (isPauseSignal(error)) {
          context.commit();
          this.narrativeGenerator.onPause(node.name, node.id, error.pauseData, error.subflowPath, traversalContext);
          throw error;
        }
        context.commit();
        this.narrativeGenerator.onError(node.name, error.toString(), error, traversalContext);
        this.logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error });
        context.addError('stageExecutionError', error.toString());
        throw error;
      }
      context.commit();
      this.narrativeGenerator.onStageExecuted(node.name, node.description, traversalContext, 'linear');

      if (breakFlag.shouldBreak) {
        // Forward the optional reason captured on breakFlag — set by the
        // stage's $break(reason) call OR by a subflow's propagateBreak.
        this.narrativeGenerator.onBreak(node.name, traversalContext, breakFlag.reason);
        return stageOutput;
      }

      // ─── Phase 4: DYNAMIC — StageNode return detection ───
      if (stageOutput && typeof stageOutput === 'object' && isStageNodeReturn(stageOutput)) {
        const dynamicNode = stageOutput as StageNode<TOut, TScope>;
        context.addLog('isDynamic', true);
        context.addLog('dynamicPattern', 'StageNodeReturn');

        // Dynamic subflow auto-registration. The subflow meta lands in the
        // traverser-local overlay (NOT on the shared node); the immediate
        // executeNode re-entry sees it through the eff* accessors and
        // classifies the node as a subflow mount in Phase 0.
        if (dynamicNode.isSubflowRoot && dynamicNode.subflowDef && dynamicNode.subflowId) {
          context.addLog('dynamicPattern', 'dynamicSubflow');
          context.addLog('dynamicSubflowId', dynamicNode.subflowId);

          this.autoRegisterSubflowDef(dynamicNode.subflowId, dynamicNode.subflowDef, node.id);

          this.getOrCreatePatch(node).subflowMeta = {
            isSubflowRoot: true,
            subflowId: dynamicNode.subflowId,
            subflowName: dynamicNode.subflowName,
            subflowMountOptions: dynamicNode.subflowMountOptions,
          };

          this.structureManager.updateDynamicSubflow(
            node.id,
            dynamicNode.subflowId!,
            dynamicNode.subflowName,
            dynamicNode.subflowDef?.buildTimeStructure,
          );

          // Re-enter THIS node (same context): the overlay patch makes the
          // next step classify it as a subflow mount in Phase 0.
          return this.hop(node, context, branchPath);
        }

        // Check children for subflowDef
        if (dynamicNode.children) {
          for (const child of dynamicNode.children) {
            if (child.isSubflowRoot && child.subflowDef && child.subflowId) {
              this.autoRegisterSubflowDef(child.subflowId, child.subflowDef, child.id);
              this.structureManager.updateDynamicSubflow(
                child.id,
                child.subflowId!,
                child.subflowName,
                child.subflowDef?.buildTimeStructure,
              );
            }
          }
        }

        // Dynamic children (fork pattern) — patched into the overlay;
        // Phase 5 below reads them back through effChildren/effSelector.
        if (dynamicNode.children && dynamicNode.children.length > 0) {
          this.getOrCreatePatch(node).children = dynamicNode.children;
          context.addLog('dynamicChildCount', dynamicNode.children.length);
          context.addLog(
            'dynamicChildIds',
            dynamicNode.children.map((c) => c.id),
          );

          this.structureManager.updateDynamicChildren(
            node.id,
            dynamicNode.children,
            Boolean(dynamicNode.nextNodeSelector),
            Boolean(dynamicNode.deciderFn),
          );

          if (typeof dynamicNode.nextNodeSelector === 'function') {
            this.getOrCreatePatch(node).nextNodeSelector = dynamicNode.nextNodeSelector;
            context.addLog('hasSelector', true);
          }
        }

        // Dynamic next (linear continuation) — stays a LOCAL: it applies
        // only to this visit (Phase 6 routes it through the
        // ContinuationResolver), so the shared node's next is never touched
        // and a loop revisit naturally sees the built continuation.
        if (dynamicNode.next) {
          dynamicNext = dynamicNode.next;
          this.structureManager.updateDynamicNext(node.id, dynamicNode.next);
          context.addLog('hasDynamicNext', true);
        }

        stageOutput = undefined;
      }
    }

    // ─── Phase 5: CHILDREN — fork dispatch ───
    // Re-read through the overlay: Phase 4 may have just patched dynamic
    // children/selector for THIS visit (or an earlier visit in this run).
    const childrenAfterStage = this.effChildren(node);
    const hasChildrenAfterStage = Boolean(childrenAfterStage?.length);

    if (hasChildrenAfterStage) {
      context.addLog('totalChildren', childrenAfterStage?.length);
      context.addLog('orderOfExecution', 'ChildrenAfterStage');

      let nodeChildrenResults: Record<string, NodeResultType>;

      const effSelectorFn = this.effSelector(node);
      if (effSelectorFn) {
        nodeChildrenResults = await this.childrenExecutor.executeSelectedChildren(
          effSelectorFn,
          childrenAfterStage!,
          stageOutput,
          context,
          branchPath as string,
          traversalContext,
          node.failFast,
        );
      } else {
        const childCount = childrenAfterStage?.length ?? 0;
        const childNames = childrenAfterStage?.map((c) => c.name).join(', ');
        context.addFlowDebugMessage('children', `Executing all ${childCount} children in parallel: ${childNames}`, {
          count: childCount,
          targetStage: childrenAfterStage?.map((c) => c.name),
        });

        // effNode: ChildrenExecutor reads node.children/node.failFast itself.
        nodeChildrenResults = await this.childrenExecutor.executeNodeChildren(
          this.effNode(node),
          context,
          undefined,
          branchPath,
          traversalContext,
        );
      }

      // Fork-only: return bundle
      if (!hasNext && !dynamicNext) {
        return nodeChildrenResults!;
      }

      // Capture dynamic children as synthetic subflow result for UI
      const isDynamic = context.debug?.logContext?.isDynamic;
      if (isDynamic && childrenAfterStage && childrenAfterStage.length > 0) {
        this.captureDynamicChildrenResult(node, childrenAfterStage, context);
      }
    }

    // ─── Phase 6: CONTINUE — dynamic next / linear next ───
    if (dynamicNext) {
      const target = this.continuationResolver.resolveTarget(dynamicNext, node, context, branchPath);
      return this.hop(target.node, target.context, branchPath);
    }

    if (hasNext) {
      const nextNode = originalNext!;

      // Detect loop reference nodes created by loopTo() — marked with isLoopRef flag.
      // Route through ContinuationResolver for proper ID resolution, iteration
      // tracking, and narrative generation. The resolved target comes back
      // as a hop — loop edges consume no stack, so the iteration limit
      // (not call-stack depth) is what bounds a loop.
      const isLoopReference = nextNode.isLoopRef;

      if (isLoopReference) {
        const target = this.continuationResolver.resolveTarget(nextNode, node, context, branchPath, traversalContext);
        return this.hop(target.node, target.context, branchPath);
      }

      this.narrativeGenerator.onNext(node.name, nextNode.name, nextNode.description, traversalContext);
      context.addFlowDebugMessage('next', `Moving to ${nextNode.name} stage`, {
        targetStage: nextNode.name,
      });
      const nextCtx = context.createNext(branchPath as string, nextNode.name, nextNode.id);
      return this.hop(nextNode, nextCtx, branchPath);
    }

    // ─── Phase 7: LEAF — no continuation ───
    return stageOutput;
  }

  // ─────────────────────── Private Helpers ───────────────────────

  private captureDynamicChildrenResult(
    node: StageNode<TOut, TScope>,
    children: StageNode<TOut, TScope>[],
    context: StageContext,
  ): void {
    const parentStageId = context.getStageId();

    const childStructure: any = {
      id: `${node.id}-children`,
      name: 'Dynamic Children',
      type: 'fork',
      children: children.map((c) => ({
        id: c.id,
        name: c.name,
        type: 'stage',
      })),
    };

    const childStages: Record<string, unknown> = {};
    if (context.children) {
      for (const childCtx of context.children) {
        const snapshot = childCtx.getSnapshot();
        childStages[snapshot.name || snapshot.id] = {
          name: snapshot.name,
          output: snapshot.logs,
          errors: snapshot.errors,
          metrics: snapshot.metrics,
          status: snapshot.errors && Object.keys(snapshot.errors).length > 0 ? 'error' : 'success',
        };
      }
    }

    this.subflowResults.set(node.id, {
      subflowId: node.id,
      subflowName: node.name,
      treeContext: {
        globalContext: {},
        stageContexts: childStages as unknown as Record<string, unknown>,
        history: [],
      },
      parentStageId,
      pipelineStructure: childStructure,
    });
  }

  /**
   * Parent-chain length of a StageContext — same value the pre-trampoline
   * walk produced, memoized. The context tree deepens by one per executed
   * stage along a chain, so the naive walk is O(chain length) per stage —
   * O(n²) per run once chains reach trampoline scale. Contexts are visited
   * parent-before-child, so the cached parent makes this O(1) amortized.
   */
  private computeContextDepth(context: StageContext): number {
    const cached = this.contextDepthCache.get(context);
    if (cached !== undefined) return cached;

    // Walk up to the nearest cached ancestor (or the root), then fill the
    // cache back down — iterative, so a cold deep chain can't overflow.
    const uncached: StageContext[] = [];
    let depth = -1; // depth of the node ABOVE the first uncached entry
    let current: StageContext | undefined = context;
    while (current) {
      const hit = this.contextDepthCache.get(current);
      if (hit !== undefined) {
        depth = hit;
        break;
      }
      uncached.push(current);
      current = current.parent;
    }
    for (let i = uncached.length - 1; i >= 0; i--) {
      depth++;
      this.contextDepthCache.set(uncached[i], depth);
    }
    return depth;
  }

  private prefixNodeTree(node: StageNode<TOut, TScope>, prefix: string): StageNode<TOut, TScope> {
    if (!node) return node;
    const clone: StageNode<TOut, TScope> = { ...node };
    clone.name = `${prefix}/${node.name}`;
    clone.id = `${prefix}/${clone.id}`;
    if (clone.subflowId) clone.subflowId = `${prefix}/${clone.subflowId}`;
    if (clone.next) clone.next = this.prefixNodeTree(clone.next, prefix);
    if (clone.children) {
      clone.children = clone.children.map((c) => this.prefixNodeTree(c, prefix));
    }
    return clone;
  }

  private autoRegisterSubflowDef(
    subflowId: string,
    subflowDef: NonNullable<StageNode['subflowDef']>,
    mountNodeId?: string,
  ): void {
    // this.subflows is always initialized in the constructor; the null guard below is unreachable.
    const subflowsDict = this.subflows;

    // First-write-wins
    const isNewRegistration = !subflowsDict[subflowId];
    if (isNewRegistration && subflowDef.root) {
      subflowsDict[subflowId] = {
        root: subflowDef.root as StageNode<TOut, TScope>,
        ...(subflowDef.buildTimeStructure ? { buildTimeStructure: subflowDef.buildTimeStructure } : {}),
      } as any;
    }

    // Merge stageMap entries (parent entries preserved)
    if (subflowDef.stageMap) {
      for (const [key, fn] of Array.from(subflowDef.stageMap.entries())) {
        if (!this.stageMap.has(key)) {
          this.stageMap.set(key, fn as StageFunction<TOut, TScope>);
        }
      }
    }

    // Merge nested subflows
    if (subflowDef.subflows) {
      for (const [key, def] of Object.entries(subflowDef.subflows)) {
        if (!subflowsDict[key]) {
          subflowsDict[key] = def as { root: StageNode<TOut, TScope> };
        }
      }
    }

    if (mountNodeId) {
      this.structureManager.updateDynamicSubflow(
        mountNodeId,
        subflowId,
        subflowDef.root?.subflowName || subflowDef.root?.name,
        subflowDef.buildTimeStructure,
      );
    }

    // Notify FlowRecorders only on first registration (matches first-write-wins)
    if (isNewRegistration) {
      const subflowName = subflowDef.root?.subflowName || subflowDef.root?.name || subflowId;
      this.narrativeGenerator.onSubflowRegistered(
        subflowId,
        subflowName,
        subflowDef.root?.description,
        subflowDef.buildTimeStructure,
      );
    }
  }
}
