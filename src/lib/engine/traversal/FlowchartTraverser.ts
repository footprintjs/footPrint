/**
 * FlowchartTraverser — Pre-order DFS traversal of StageNode graph.
 *
 * Unified traversal algorithm for all node shapes:
 *   const pre = await prep();
 *   const [x, y] = await Promise.all([fx(pre), fy(pre)]);
 *   return await next(x, y);
 *
 * For each node, executeNode follows 7 phases:
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
import { isStageNodeReturn } from '../graph/StageNode.js';
import { ChildrenExecutor } from '../handlers/ChildrenExecutor.js';
import { ContinuationResolver } from '../handlers/ContinuationResolver.js';
import { DeciderHandler } from '../handlers/DeciderHandler.js';
import { ExtractorRunner } from '../handlers/ExtractorRunner.js';
import { NodeResolver } from '../handlers/NodeResolver.js';
import { RuntimeStructureManager } from '../handlers/RuntimeStructureManager.js';
import { SelectorHandler } from '../handlers/SelectorHandler.js';
import { StageRunner } from '../handlers/StageRunner.js';
import { SubflowExecutor } from '../handlers/SubflowExecutor.js';
import { FlowRecorderDispatcher } from '../narrative/FlowRecorderDispatcher.js';
import { NarrativeFlowRecorder } from '../narrative/NarrativeFlowRecorder.js';
import { NullControlFlowNarrativeGenerator } from '../narrative/NullControlFlowNarrativeGenerator.js';
import type { FlowRecorder, IControlFlowNarrative, TraversalContext } from '../narrative/types.js';
import type {
  ExtractorError,
  HandlerDeps,
  IExecutionRuntime,
  ILogger,
  NodeResultType,
  ScopeFactory,
  SerializedPipelineStructure,
  StageFunction,
  StageNode,
  StreamHandlers,
  SubflowResult,
  SubflowTraverserFactory,
  TraversalExtractor,
  TraversalResult,
} from '../types.js';

export interface TraverserOptions<TOut = any, TScope = any> {
  root: StageNode<TOut, TScope>;
  stageMap: Map<string, StageFunction<TOut, TScope>>;
  scopeFactory: ScopeFactory<TScope>;
  executionRuntime: IExecutionRuntime;
  readOnlyContext?: unknown;
  /** Execution environment — propagates to subflows automatically. */
  executionEnv?: import('../../engine/types').ExecutionEnv;
  throttlingErrorChecker?: (error: unknown) => boolean;
  streamHandlers?: StreamHandlers;
  extractor?: TraversalExtractor;
  scopeProtectionMode?: ScopeProtectionMode;
  subflows?: Record<string, { root: StageNode<TOut, TScope> }>;
  enrichSnapshots?: boolean;
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
   * Maximum recursive executeNode depth. Defaults to FlowchartTraverser.MAX_EXECUTE_DEPTH (500).
   * Override in tests or unusually deep pipelines.
   */
  maxDepth?: number;
  /**
   * When this traverser runs inside a subflow, set this to the subflow's ID.
   * Propagated to TraversalContext so narrative entries carry the correct subflowId.
   */
  parentSubflowId?: string;
}

export class FlowchartTraverser<TOut = any, TScope = any> {
  private readonly root: StageNode<TOut, TScope>;
  private stageMap: Map<string, StageFunction<TOut, TScope>>;
  private readonly executionRuntime: IExecutionRuntime;
  private subflows: Record<string, { root: StageNode<TOut, TScope> }>;
  private readonly logger: ILogger;
  private readonly signal?: AbortSignal;
  private readonly parentSubflowId?: string;

  // Handler modules
  private readonly nodeResolver: NodeResolver<TOut, TScope>;
  private readonly childrenExecutor: ChildrenExecutor<TOut, TScope>;
  private readonly subflowExecutor: SubflowExecutor<TOut, TScope>;
  private readonly stageRunner: StageRunner<TOut, TScope>;
  private readonly continuationResolver: ContinuationResolver<TOut, TScope>;
  private readonly deciderHandler: DeciderHandler<TOut, TScope>;
  private readonly selectorHandler: SelectorHandler<TOut, TScope>;
  private readonly structureManager: RuntimeStructureManager;
  private readonly extractorRunner: ExtractorRunner<TOut, TScope>;
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
   * Recursion depth counter for executeNode.
   * Each recursive executeNode call increments this; decrements on exit (try/finally).
   * Prevents call-stack overflow on infinite loops or excessively deep stage chains.
   */
  private _executeDepth = 0;

  /**
   * Per-instance maximum depth (set from TraverserOptions.maxDepth or the class default).
   */
  private readonly _maxDepth: number;

  /**
   * Default maximum recursive executeNode depth before an error is thrown.
   * 500 comfortably covers any realistic pipeline depth (including deeply nested
   * subflows) while preventing call-stack overflow (~10 000 frames in V8).
   *
   * **Note on counting:** the counter increments once per `executeNode` call, not once per
   * logical user stage. Subflow root entry and subflow continuation after return each cost
   * one tick. For pipelines with many nested subflows, budget roughly 2 × (avg stages per
   * subflow) of headroom when computing a custom `maxDepth` via `RunOptions.maxDepth`.
   *
   * **Note on loops:** for `loopTo()` pipelines, this depth guard and `ContinuationResolver`'s
   * iteration limit are independent — the lower one fires first. The default depth guard (500)
   * fires before the default iteration limit (1000) for loop-heavy pipelines.
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

    // Structure manager (deep-clones build-time structure)
    this.structureManager = new RuntimeStructureManager();
    this.structureManager.init(opts.buildTimeStructure);

    // Extractor runner
    this.extractorRunner = new ExtractorRunner(
      opts.extractor,
      opts.enrichSnapshots ?? false,
      this.executionRuntime,
      this.logger,
    );

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

    // Initialize handler modules
    this.nodeResolver = new NodeResolver(deps, nodeIdMap);
    this.childrenExecutor = new ChildrenExecutor(deps, this.executeNode.bind(this));
    this.stageRunner = new StageRunner(deps);
    this.continuationResolver = new ContinuationResolver(deps, this.nodeResolver, (nodeId, count) =>
      this.structureManager.updateIterationCount(nodeId, count),
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
        extractor: parentOpts.extractor,
        scopeProtectionMode: parentOpts.scopeProtectionMode,
        subflows: parentSubflows, // Constructor shallow-copies this
        enrichSnapshots: parentOpts.enrichSnapshots,
        narrativeGenerator, // Share parent's — all events flow to one place
        logger: parentOpts.logger,
        signal: parentOpts.signal,
        maxDepth: this._maxDepth,
        parentSubflowId: subflowOpts.subflowId,
      });

      return {
        execute: () => traverser.execute(),
        getSubflowResults: () => traverser.getSubflowResults(),
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
    };
  }

  // ─────────────────────── Public API ───────────────────────

  async execute(branchPath?: string): Promise<TraversalResult> {
    const context = this.executionRuntime.rootStageContext;
    return await this.executeNode(this.root, context, { shouldBreak: false }, branchPath ?? '');
  }

  getRuntimeStructure(): SerializedPipelineStructure | undefined {
    return this.structureManager.getStructure();
  }

  getSnapshot() {
    return this.executionRuntime.getSnapshot();
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

  getExtractedResults<TResult = unknown>(): Map<string, TResult> {
    return this.extractorRunner.getExtractedResults() as Map<string, TResult>;
  }

  getExtractorErrors(): ExtractorError[] {
    return this.extractorRunner.getExtractorErrors();
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
   * Depth-guarded at MAX_EXECUTE_DEPTH to prevent infinite recursion on cyclic graphs.
   * Dynamic subflows and lazy-resolved nodes are added to stageMap at runtime but not to this map —
   * those use the DFS fallback in NodeResolver.
   */
  private buildNodeIdMap(root: StageNode<TOut, TScope>): Map<string, StageNode<TOut, TScope>> {
    const map = new Map<string, StageNode<TOut, TScope>>();
    const visit = (node: StageNode<TOut, TScope>, depth: number): void => {
      if (depth > FlowchartTraverser.MAX_EXECUTE_DEPTH) return;
      if (map.has(node.id)) return; // already visited (avoids infinite loops on cyclic refs)
      map.set(node.id, node);
      if (node.children) {
        for (const child of node.children) visit(child, depth + 1);
      }
      if (node.next) visit(node.next, depth + 1);
    };
    visit(root, 0);
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

  private async executeStage(
    node: StageNode<TOut, TScope>,
    stageFunc: StageFunction<TOut, TScope>,
    context: StageContext,
    breakFn: () => void,
  ) {
    return this.stageRunner.run(node, stageFunc, context, breakFn);
  }

  /**
   * Pre-order DFS traversal — the core algorithm.
   * Each call processes one node through all 7 phases.
   */
  private async executeNode(
    node: StageNode<TOut, TScope>,
    context: StageContext,
    breakFlag: { shouldBreak: boolean },
    branchPath?: string,
  ): Promise<any> {
    // ─── Recursion depth guard ───
    // Each `await executeNode(...)` keeps the calling frame on the stack.
    // Without a cap, an infinite loop or an excessively deep stage chain will
    // eventually overflow the V8 call stack (~10 000 frames) with a cryptic
    // "Maximum call stack size exceeded" error.  We fail early with a clear
    // message so users can diagnose the cause (infinite loop, missing break, etc.).
    // The increment is inside `try` so `finally` always decrements — no fragile
    // gap between check and try entry.
    try {
      if (++this._executeDepth > this._maxDepth) {
        throw new Error(
          `FlowchartTraverser: maximum traversal depth exceeded (${this._maxDepth}). ` +
            'Check for infinite loops or missing break conditions in your flowchart. ' +
            `Last stage: '${node.name}'. ` +
            'For loopTo() pipelines, consider adding a break condition or using RunOptions.maxDepth to raise the limit.',
        );
      }

      // Attach builder metadata to context for snapshot enrichment
      if (node.description) context.description = node.description;
      if (node.isSubflowRoot && node.subflowId) context.subflowId = node.subflowId;

      // Build traversal context for recorder events — created once per stage, shared by all events
      const traversalContext: TraversalContext = {
        stageId: node.id ?? context.stageId,
        stageName: node.name,
        parentStageId: context.parent?.stageId,
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
      if (node.isSubflowRoot && node.subflowId) {
        const resolvedNode = this.nodeResolver.resolveSubflowReference(node);
        const previousSubflowId = this.extractorRunner.currentSubflowId;
        this.extractorRunner.currentSubflowId = node.subflowId;

        let subflowOutput: any;
        try {
          subflowOutput = await this.subflowExecutor.executeSubflow(
            resolvedNode,
            context,
            breakFlag,
            branchPath,
            this.subflowResults,
            traversalContext,
          );
        } finally {
          this.extractorRunner.currentSubflowId = previousSubflowId;
        }

        const isReferenceBasedSubflow = resolvedNode !== node;
        const hasChildren = Boolean(node.children && node.children.length > 0);
        const shouldExecuteContinuation = isReferenceBasedSubflow || hasChildren;

        if (node.next && shouldExecuteContinuation) {
          const nextCtx = context.createNext(branchPath as string, node.next.name, node.next.id);
          return await this.executeNode(node.next, nextCtx, breakFlag, branchPath);
        }

        return subflowOutput;
      }

      const stageFunc = this.getStageFn(node);
      const hasStageFunction = Boolean(stageFunc);
      const isScopeBasedDecider = Boolean(node.deciderFn);
      const isScopeBasedSelector = Boolean(node.selectorFn);
      const isDeciderNode = isScopeBasedDecider;
      const hasChildren = Boolean(node.children?.length);
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

      const breakFn = () => (breakFlag.shouldBreak = true);

      // ─── Phase 2a: SELECTOR — scope-based multi-choice ───
      if (isScopeBasedSelector) {
        const previousForkId = this.extractorRunner.currentForkId;
        this.extractorRunner.currentForkId = node.id;

        try {
          const selectorResult = await this.selectorHandler.handleScopeBased(
            node,
            stageFunc!,
            context,
            breakFlag,
            branchPath,
            this.executeStage.bind(this),
            this.executeNode.bind(this),
            this.extractorRunner.callExtractor.bind(this.extractorRunner),
            this.extractorRunner.getStagePath.bind(this.extractorRunner),
            traversalContext,
          );

          if (hasNext) {
            const nextCtx = context.createNext(branchPath as string, node.next!.name, node.next!.id);
            return await this.executeNode(node.next!, nextCtx, breakFlag, branchPath);
          }
          return selectorResult;
        } finally {
          this.extractorRunner.currentForkId = previousForkId;
        }
      }

      // ─── Phase 2b: DECIDER — scope-based single-choice conditional branch ───
      if (isDeciderNode) {
        const deciderResult = await this.deciderHandler.handleScopeBased(
          node,
          stageFunc!,
          context,
          breakFlag,
          branchPath,
          this.executeStage.bind(this),
          this.executeNode.bind(this),
          this.extractorRunner.callExtractor.bind(this.extractorRunner),
          this.extractorRunner.getStagePath.bind(this.extractorRunner),
          traversalContext,
        );

        // After branch execution, follow decider's own next (e.g., loopTo target)
        if (hasNext && !breakFlag.shouldBreak) {
          const nextNode = originalNext!;
          // Use the isLoopRef flag set by loopTo() — do not rely on stageMap absence,
          // since id-keyed stageMaps would otherwise cause loop targets to be executed directly.
          const isLoopRef =
            nextNode.isLoopRef === true ||
            (!this.getStageFn(nextNode) &&
              !nextNode.children?.length &&
              !nextNode.deciderFn &&
              !nextNode.selectorFn &&
              !nextNode.isSubflowRoot);

          if (isLoopRef) {
            return this.continuationResolver.resolve(
              nextNode,
              node,
              context,
              breakFlag,
              branchPath,
              this.executeNode.bind(this),
            );
          }

          this.narrativeGenerator.onNext(node.name, nextNode.name, nextNode.description, traversalContext);
          const nextCtx = context.createNext(branchPath as string, nextNode.name, nextNode.id);
          return await this.executeNode(nextNode, nextCtx, breakFlag, branchPath);
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
          this.extractorRunner.callExtractor(
            node,
            context,
            this.extractorRunner.getStagePath(node, branchPath, context.stageName),
            undefined,
            { type: 'stageExecutionError', message: error.toString() },
          );
          this.narrativeGenerator.onError(node.name, error.toString(), error, traversalContext);
          this.logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error });
          context.addError('stageExecutionError', error.toString());
          throw error;
        }
        context.commit();
        this.extractorRunner.callExtractor(
          node,
          context,
          this.extractorRunner.getStagePath(node, branchPath, context.stageName),
          stageOutput,
        );
        this.narrativeGenerator.onStageExecuted(node.name, node.description, traversalContext);

        if (breakFlag.shouldBreak) {
          this.narrativeGenerator.onBreak(node.name, traversalContext);
          this.logger.info(`Execution stopped in pipeline (${branchPath}) after ${node.name} due to break condition.`);
          return stageOutput;
        }

        // ─── Phase 4: DYNAMIC — StageNode return detection ───
        if (stageOutput && typeof stageOutput === 'object' && isStageNodeReturn(stageOutput)) {
          const dynamicNode = stageOutput as StageNode<TOut, TScope>;
          context.addLog('isDynamic', true);
          context.addLog('dynamicPattern', 'StageNodeReturn');

          // Dynamic subflow auto-registration
          if (dynamicNode.isSubflowRoot && dynamicNode.subflowDef && dynamicNode.subflowId) {
            context.addLog('dynamicPattern', 'dynamicSubflow');
            context.addLog('dynamicSubflowId', dynamicNode.subflowId);

            // Structural-only subflow: has buildTimeStructure but no executable root.
            // Used for pre-executed subflows (e.g., inner flows that already ran).
            // Annotates the node for visualization without re-executing.
            if (!dynamicNode.subflowDef.root) {
              context.addLog('dynamicPattern', 'structuralSubflow');
              node.isSubflowRoot = true;
              node.subflowId = dynamicNode.subflowId;
              node.subflowName = dynamicNode.subflowName;
              node.description = dynamicNode.description ?? node.description;

              this.structureManager.updateDynamicSubflow(
                node.id,
                dynamicNode.subflowId!,
                dynamicNode.subflowName,
                dynamicNode.subflowDef.buildTimeStructure,
              );

              // Fall through to Phase 5 (continuation) — no subflow execution needed
            } else {
              // Full dynamic subflow: register + execute
              this.autoRegisterSubflowDef(dynamicNode.subflowId, dynamicNode.subflowDef, node.id);

              node.isSubflowRoot = true;
              node.subflowId = dynamicNode.subflowId;
              node.subflowName = dynamicNode.subflowName;
              node.subflowMountOptions = dynamicNode.subflowMountOptions;

              this.structureManager.updateDynamicSubflow(
                node.id,
                dynamicNode.subflowId!,
                dynamicNode.subflowName,
                dynamicNode.subflowDef?.buildTimeStructure,
              );

              return await this.executeNode(node, context, breakFlag, branchPath);
            }
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

          // Dynamic children (fork pattern)
          if (dynamicNode.children && dynamicNode.children.length > 0) {
            node.children = dynamicNode.children;
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
              node.nextNodeSelector = dynamicNode.nextNodeSelector;
              context.addLog('hasSelector', true);
            }
          }

          // Dynamic next (linear continuation)
          if (dynamicNode.next) {
            dynamicNext = dynamicNode.next;
            this.structureManager.updateDynamicNext(node.id, dynamicNode.next);
            node.next = dynamicNode.next;
            context.addLog('hasDynamicNext', true);
          }

          stageOutput = undefined;
        }

        // Restore original next to avoid stale reference on loop revisit
        if (dynamicNext) {
          node.next = originalNext;
        }
      }

      // ─── Phase 5: CHILDREN — fork dispatch ───
      const hasChildrenAfterStage = Boolean(node.children?.length);

      if (hasChildrenAfterStage) {
        context.addLog('totalChildren', node.children?.length);
        context.addLog('orderOfExecution', 'ChildrenAfterStage');

        let nodeChildrenResults: Record<string, NodeResultType>;

        if (node.nextNodeSelector) {
          const previousForkId = this.extractorRunner.currentForkId;
          this.extractorRunner.currentForkId = node.id;
          try {
            nodeChildrenResults = await this.childrenExecutor.executeSelectedChildren(
              node.nextNodeSelector,
              node.children!,
              stageOutput,
              context,
              branchPath as string,
              traversalContext,
            );
          } finally {
            this.extractorRunner.currentForkId = previousForkId;
          }
        } else {
          const childCount = node.children?.length ?? 0;
          const childNames = node.children?.map((c) => c.name).join(', ');
          context.addFlowDebugMessage('children', `Executing all ${childCount} children in parallel: ${childNames}`, {
            count: childCount,
            targetStage: node.children?.map((c) => c.name),
          });

          const previousForkId = this.extractorRunner.currentForkId;
          this.extractorRunner.currentForkId = node.id;
          try {
            nodeChildrenResults = await this.childrenExecutor.executeNodeChildren(
              node,
              context,
              undefined,
              branchPath,
              traversalContext,
            );
          } finally {
            this.extractorRunner.currentForkId = previousForkId;
          }
        }

        // Fork-only: return bundle
        if (!hasNext && !dynamicNext) {
          return nodeChildrenResults!;
        }

        // Capture dynamic children as synthetic subflow result for UI
        const isDynamic = context.debug?.logContext?.isDynamic;
        if (isDynamic && node.children && node.children.length > 0) {
          this.captureDynamicChildrenResult(node, context);
        }
      }

      // ─── Phase 6: CONTINUE — dynamic next / linear next ───
      if (dynamicNext) {
        return this.continuationResolver.resolve(
          dynamicNext,
          node,
          context,
          breakFlag,
          branchPath,
          this.executeNode.bind(this),
        );
      }

      if (hasNext) {
        const nextNode = originalNext!;

        // Detect loop reference nodes created by loopTo() — marked with isLoopRef flag.
        // Route through ContinuationResolver for proper ID resolution, iteration
        // tracking, and narrative generation.
        const isLoopReference = nextNode.isLoopRef;

        if (isLoopReference) {
          return this.continuationResolver.resolve(
            nextNode,
            node,
            context,
            breakFlag,
            branchPath,
            this.executeNode.bind(this),
            traversalContext,
          );
        }

        this.narrativeGenerator.onNext(node.name, nextNode.name, nextNode.description, traversalContext);
        context.addFlowDebugMessage('next', `Moving to ${nextNode.name} stage`, {
          targetStage: nextNode.name,
        });
        const nextCtx = context.createNext(branchPath as string, nextNode.name, nextNode.id);
        return await this.executeNode(nextNode, nextCtx, breakFlag, branchPath);
      }

      // ─── Phase 7: LEAF — no continuation ───
      return stageOutput;
    } finally {
      this._executeDepth--;
    }
  }

  // ─────────────────────── Private Helpers ───────────────────────

  private captureDynamicChildrenResult(node: StageNode<TOut, TScope>, context: StageContext): void {
    const parentStageId = context.getStageId();

    const childStructure: any = {
      id: `${node.id}-children`,
      name: 'Dynamic Children',
      type: 'fork',
      children: node.children!.map((c) => ({
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

  private computeContextDepth(context: StageContext): number {
    let depth = 0;
    let current = context.parent;
    while (current) {
      depth++;
      current = current.parent;
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
