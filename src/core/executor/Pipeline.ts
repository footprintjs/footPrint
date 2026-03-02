/**
 * Pipeline.ts (formerly GraphTraverser.ts)
 *
 * WHY: This is the core execution engine for flowchart-based pipelines.
 * It traverses a tree of StageNodes, executing stage functions in a
 * programmer-friendly order that mirrors natural async/await patterns.
 *
 * DESIGN: The traversal follows a unified order for all node shapes:
 *   // prep        →     parallel gather     →     aggregate/continue
 *   const pre = await prep();
 *   const [x, y] = await Promise.all([fx(pre), fy(pre)]);
 *   return await next(x, y);
 *
 * RESPONSIBILITIES:
 * - Execute stage functions in correct order (stage → children → next)
 * - Handle different node shapes (linear, fork, decider, selector)
 * - Manage break semantics for early termination
 * - Coordinate with extracted handler modules (StageRunner, LoopHandler, etc.)
 * - Support dynamic stages that return StageNode for continuation
 * - Execute subflows with isolated contexts
 *
 * RELATED:
 * - {@link FlowChartExecutor} - Public API wrapper around Pipeline
 * - {@link StageRunner} - Executes individual stage functions
 * - {@link ChildrenExecutor} - Handles parallel children execution
 * - {@link SubflowExecutor} - Handles subflow execution with isolation
 * - {@link LoopHandler} - Handles dynamic next and loop-back logic
 * - {@link DeciderHandler} - Handles decider evaluation and branching
 *
 * Concretely, for each node shape we execute:
 *
 * 1) Linear node (no children; may have `next`)
 *    • Run **this node's stage** (if any) → commit → (break?) → **next**
 *
 * 2) Fork-only (has `children`, **no** `next`, not a decider)
 *    • Run **stage** (if any) → commit
 *    • Run **ALL children in parallel** (each child commits after it settles)
 *    • **RETURN** children bundle: `{ [childId]: { result, isError } }`
 *
 * 3) Fork + next (has `children` and `next`, not a decider)
 *    • Run **stage** (if any) → commit
 *    • Run **ALL children in parallel** (commit on settle)
 *    • **Continue** to `next` (downstream stages read children's committed writes)
 *
 * 4) Decider (has `children` and `nextNodeDecider`)
 *    • Run **stage** (if any) → commit
 *    • **Decider** picks EXACTLY ONE child `id`
 *    • **Continue** into that chosen child (only that branch runs)
 *
 * Break semantics:
 *    If a stage calls `breakFn()`, we commit and **STOP** at this node:
 *      – for fork-only: children do **not** run; nothing continues
 *      – for fork + next: children and next do **not** run
 *      – for linear: next does **not** run
 *      – for decider: we do **not** evaluate the decider; no child runs
 *
 * Patch/visibility model:
 *   – A stage writes into a local patch; we always `commitPatch()` after it returns or throws
 *   – Children always `commitPatch()` after they settle; throttled children can flag
 *     `monitor.isThrottled = true` via `throttlingErrorChecker`
 *
 * Sync + Async stages:
 *   – We keep the original engine's behavior: **only** `await` real Promises
 *     (using `output instanceof Promise`), otherwise return the value directly.
 *     This avoids "thenable assimilation" side-effects/probes on arbitrary objects.
 */

import { StageContext } from '../memory/StageContext';
import { PipelineRuntime, RuntimeSnapshot } from '../memory/PipelineRuntime';
import { ScopeFactory } from '../memory/types';
import { logger } from '../../utils/logger';
import {
  NodeResultType,
  PipelineStageFunction,
  StreamHandlers,
  SubflowResult,
  TreeOfFunctionsResponse,
  TraversalExtractor,
  ExtractorError,
  StageSnapshot,
  PipelineContext,
  RuntimeStructureMetadata,
  SubflowMountOptions,
} from './types';
import { ScopeProtectionMode } from '../../scope/protection/types';
import { NodeResolver } from './handlers/NodeResolver';
import { ChildrenExecutor } from './handlers/ChildrenExecutor';
import { SubflowExecutor } from './handlers/SubflowExecutor';
import { StageRunner } from './handlers/StageRunner';
import { LoopHandler } from './handlers/LoopHandler';
import { DeciderHandler } from './handlers/DeciderHandler';
import { NarrativeGenerator } from './narrative/NarrativeGenerator';
import { NullNarrativeGenerator } from './narrative/NullNarrativeGenerator';
import type { INarrativeGenerator } from './narrative/types';
import type { SerializedPipelineStructure } from '../builder/FlowChartBuilder';

export type Decider = (nodeArgs: any) => string | Promise<string>;

/**
 * Selector
 * ------------------------------------------------------------------
 * A function that picks ONE OR MORE children from a children array to execute.
 * Unlike Decider (which picks exactly one), Selector can return:
 * - A single string ID (behaves like Decider)
 * - An array of string IDs (selected children execute in parallel)
 * - An empty array (skip all children, continue to next if present)
 *
 * WHY: This enables selective parallel branching where only a subset of
 * children are executed based on runtime conditions.
 *
 * @param nodeArgs - The stage output or input passed to the selector
 * @returns Single ID, array of IDs, or Promise resolving to either
 *
 */
export type Selector = (nodeArgs: any) => string | string[] | Promise<string | string[]>;

export type StageNode<TOut = any, TScope = any> = {
  /** Human-readable stage name; also used as the stageMap key */
  name: string;
  /** Optional stable id (required by decider/fork aggregation) */
  id?: string;
  /** Human-readable display name for UI visualization (e.g., "User Prompt" instead of "useQuestion") */
  displayName?: string;
  /**
   * Human-readable description of what this stage does.
   * Used for execution context descriptions and auto-generated tool descriptions.
   */
  description?: string;
  /** Linear continuation */
  next?: StageNode<TOut, TScope>;
  /** Parallel children (fork) */
  children?: StageNode<TOut, TScope>[];
  /** Decider (mutually exclusive with `next`); must select a child `id` */
  nextNodeDecider?: Decider;
  /**
   * When true, this node's `fn` is a scope-based decider function.
   * The fn receives (scope, breakFn) and its string return value
   * is used as the branch ID to select the child node to execute.
   *
   * WHY: Distinguishes scope-based deciders (new `addDeciderFunction` API)
   * from legacy output-based deciders (`addDecider` API) so that Pipeline
   * and DeciderHandler can route to the correct execution path.
   *
   * DESIGN: A boolean flag rather than storing the function separately
   * because the function is already in `node.fn` and the stageMap.
   * The flag tells Pipeline to interpret the return value as a branch ID.
   *
   * Mutually exclusive with `nextNodeDecider`:
   * - `deciderFn = true` → scope-based decider (reads from scope, fn returns branch ID)
   * - `nextNodeDecider` set → legacy output-based decider (reads from previous stage output)
   *
   * When set, `fn` MUST be defined (either embedded or in stageMap).
   * When set, `children` MUST be defined with at least one branch.
   *
   */
  deciderFn?: boolean;
  /**
   * Selector for multi-choice branching.
   * Unlike Decider (picks ONE), Selector can pick MULTIPLE children to execute in parallel.
   * Mutually exclusive with `nextNodeDecider`.
   *
   */
  nextNodeSelector?: Selector;
  /** Optional embedded function for this node; otherwise resolved from stageMap by `name` */
  fn?: PipelineStageFunction<TOut, TScope>;
  /**
   * Indicates this stage emits tokens incrementally via a stream callback.
   * When true, TreePipeline will inject a streamCallback as the 3rd parameter to the stage function.
   */
  isStreaming?: boolean;
  /**
   * Unique identifier for the stream, used to route tokens to the correct handler.
   * Defaults to the stage name if not provided when using addStreamingFunction.
   */
  streamId?: string;
  /** True if this is the root node of a mounted subflow */
  isSubflowRoot?: boolean;
  /** Mount id of the subflow (e.g., "llm-core") */
  subflowId?: string;
  /** Display name of the subflow (e.g., "LLM Core") */
  subflowName?: string;
  /**
   * Reference to a subflow definition in the `subflows` dictionary.
   * When present, this node is a lightweight reference that should be resolved
   * by looking up `subflows[$ref]` to get the actual subflow structure.
   * 
   * Used by reference-based subflow architecture to avoid deep-copying.
   */
  $ref?: string;
  /**
   * Unique identifier for this mount instance.
   * Distinguishes multiple mounts of the same subflow definition.
   */
  mountId?: string;
  /**
   * Options for subflow mounting (input/output mapping, scope mode).
   * Only present on nodes where isSubflowRoot is true.
   * 
   * Enables explicit data contracts between parent and subflow:
   * - inputMapper: Extract data from parent scope to seed subflow's initial scope
   * - outputMapper: Extract data from subflow output to write back to parent scope
   * - scopeMode: 'isolated' (default) or 'inherit' for scope inheritance behavior
   * 
   */
  subflowMountOptions?: SubflowMountOptions;

  /**
   * Inline subflow definition for dynamic subflow attachment.
   *
   * WHY: Enables runtime subflow attachment without build-time registration.
   * A stage function can construct or select a compiled FlowChart at runtime
   * and return it inline on the StageNode. Pipeline auto-registers the
   * definition in the subflows dictionary before routing to SubflowExecutor.
   *
   * DESIGN: When present alongside `isSubflowRoot: true` and `subflowId`,
   * Pipeline registers `{ root, buildTimeStructure }` in the subflows
   * dictionary using first-write-wins semantics, merges stageMap entries,
   * and then proceeds with normal subflow resolution and execution.
   *
   * Use cases:
   * - Agent tools that are compiled sub-agent FlowCharts
   * - Microservice orchestration where service pipelines are compiled at startup
   * - Plugin systems where plugins register FlowCharts dynamically
   *
   * @example
   * ```typescript
   * // A stage returns a dynamic subflow:
   * return {
   *   name: 'run-sub-agent',
   *   isSubflowRoot: true,
   *   subflowId: 'social-media-agent',
   *   subflowDef: compiledAgentFlowChart,  // { root, stageMap, buildTimeStructure }
   *   subflowMountOptions: {
   *     inputMapper: (parentScope) => ({ agent: { messages: [...] } }),
   *   },
   * };
   * ```
   *
   */
  subflowDef?: {
    root: StageNode;
    stageMap?: Map<string, PipelineStageFunction<TOut, TScope>>;
    buildTimeStructure?: unknown;
    subflows?: Record<string, { root: StageNode }>;
  };
};

// Note: Dynamic behavior is detected via isStageNodeReturn() duck-typing on stage output.
// No isDynamic flag needed on node definition - stages that return StageNode are automatically
// treated as dynamic continuations.

/**
 * isStageNodeReturn
 * ------------------------------------------------------------------
 * Detects if a stage output is a StageNode for dynamic continuation.
 * Uses duck-typing: must have 'name' (string) AND at least one continuation property.
 *
 * WHY: This enables stage functions to return a StageNode directly for dynamic
 * pipeline continuation (parallel children, loops, etc.) without requiring
 * explicit flags on the node definition.
 *
 * DESIGN: We use duck-typing rather than instanceof because:
 * 1. StageNode is a type alias, not a class
 * 2. Allows plain objects to be used as dynamic continuations
 * 3. Safely handles proxy objects (like Zod scopes) that may throw on property access
 *
 * @param output - The stage function's return value
 * @returns true if the output is a StageNode for dynamic continuation
 *
 */
export function isStageNodeReturn(output: unknown): output is StageNode {
  // Must be a non-null object
  if (!output || typeof output !== 'object') return false;

  // Use try-catch to safely handle proxy objects that throw on property access
  try {
    const obj = output as Record<string, unknown>;

    // Must have 'name' property as a string
    if (typeof obj.name !== 'string') return false;

    // Must have at least one continuation property
    // Note: children must be a non-empty array to count as continuation
    // Note: `deciderFn` is a boolean flag on StageNode, NOT a continuation property.
    // It marks a node's fn as a scope-based decider but doesn't itself indicate
    // dynamic continuation. We intentionally exclude it from this check to prevent
    // false positives when duck-typing stage output objects.
    const hasContinuation =
      (Array.isArray(obj.children) && obj.children.length > 0) ||
      obj.next !== undefined ||
      typeof obj.nextNodeDecider === 'function' ||
      typeof obj.nextNodeSelector === 'function';

    return hasContinuation;
  } catch {
    // If property access throws (e.g., Zod scope proxy), it's not a StageNode
    return false;
  }
}


/**
 * Pipeline
 * ------------------------------------------------------------------
 * Core execution engine for flowchart-based pipelines.
 *
 * WHY: Provides a unified traversal algorithm that handles all node shapes
 * (linear, fork, decider, selector) with consistent semantics.
 *
 * RESPONSIBILITIES:
 * - Execute stage functions in correct order
 * - Coordinate with extracted handler modules
 * - Manage execution state (iteration counters, subflow results, etc.)
 * - Support dynamic stages and subflows
 *
 * DESIGN DECISIONS:
 * - Handler modules (StageRunner, LoopHandler, etc.) are injected for testability
 * - Uses PipelineContext to share state with handlers
 * - Supports both sync and async stages without thenable assimilation
 *
 * @example
 * ```typescript
 * const pipeline = new Pipeline(root, stageMap, scopeFactory);
 * const result = await pipeline.execute();
 * ```
 */
export class Pipeline<TOut, TScope> {
  private stageMap: Map<string, PipelineStageFunction<TOut, TScope>>;
  private root: StageNode;
  private pipelineRuntime: PipelineRuntime;

  /** Normalized scope factory injected by the caller (class | factory | plugin → factory) */
  private readonly ScopeFactory: ScopeFactory<TScope>;

  private readonly readOnlyContext?: unknown;
  private readonly throttlingErrorChecker?: (error: unknown) => boolean;

  /**
   * Stream handlers for streaming stages.
   * Contains callbacks for token emission and lifecycle events (start/end).
   */
  private readonly streamHandlers?: StreamHandlers;

  /**
   * Iteration counter for loop support.
   * Tracks how many times each node ID has been visited (for context path generation).
   * Key: node.id, Value: iteration count (0 = first visit)
   */
  private iterationCounters: Map<string, number> = new Map();

  /**
   * Collected subflow execution results during pipeline run.
   * Keyed by subflowId for lookup during API response construction.
   *
   */
  private subflowResults: Map<string, SubflowResult> = new Map();

  /**
   * Optional traversal extractor function.
   * Called after each stage completes to extract data.
   */
  private readonly extractor?: TraversalExtractor;

  /**
   * Collected extracted results during pipeline run.
   * Keyed by stage path (e.g., "root.child.grandchild").
   */
  private extractedResults: Map<string, unknown> = new Map();

  /**
   * Errors encountered during extraction.
   * Logged but don't stop pipeline execution.
   */
  private extractorErrors: ExtractorError[] = [];

  /**
   * Step counter for execution order tracking.
   * Incremented before each extractor call.
   * 1-based: first stage gets stepNumber 1.
   * 
   */
  private stepCounter: number = 0;

  /**
   * Current subflow context for subflowId propagation.
   * Set when entering a subflow, cleared when exiting.
   * Propagated to all children within the subflow via structureMetadata.
   * 
   */
  private currentSubflowId?: string;

  /**
   * Current fork context for parallelGroupId propagation.
   * Set when executing fork children, cleared after children complete.
   * Propagated to parallel children via structureMetadata.
   * 
   */
  private currentForkId?: string;

  /**
   * Protection mode for scope access.
   * When 'error' (default), throws on direct property assignment.
   * When 'warn', logs warning but allows assignment.
   * When 'off', no protection is applied.
   *
   */
  private readonly scopeProtectionMode: ScopeProtectionMode;

  /**
   * Memoized subflow definitions.
   * Key is the subflow's root name, value contains the subflow root node.
   * Used to resolve reference nodes (nodes with `isSubflowRoot` but no `fn`).
   */
  private readonly subflows?: Record<string, { root: StageNode<TOut, TScope> }>;

  /**
   * Whether to enrich StageSnapshots with scope state, debug metadata,
   * stage output, and history index during traversal.
   *
   * WHY: When enabled, the extractor receives full stage data during traversal,
   * eliminating the need for a redundant post-traversal walk via
   * PipelineRuntime.getSnapshot(). Defaults to false for zero-overhead
   * backward compatibility.
   *
   * DESIGN: Opt-in flag so existing consumers pay no additional cost.
   * When true, callExtractor() captures additional data from StageContext
   * and GlobalStore at commit time.
   *
   */
  private readonly enrichSnapshots: boolean;

  /**
   * NodeResolver module for node lookup and subflow reference resolution.
   * Extracted from Pipeline.ts for Single Responsibility Principle.
   *
   */
  private readonly nodeResolver: NodeResolver<TOut, TScope>;

  /**
   * ChildrenExecutor module for parallel children execution.
   * Extracted from Pipeline.ts for Single Responsibility Principle.
   *
   */
  private readonly childrenExecutor: ChildrenExecutor<TOut, TScope>;

  /**
   * SubflowExecutor module for subflow execution with isolated contexts.
   * Extracted from Pipeline.ts for Single Responsibility Principle.
   *
   */
  private readonly subflowExecutor: SubflowExecutor<TOut, TScope>;

  /**
   * StageRunner module for executing individual stage functions.
   * Extracted from Pipeline.ts for Single Responsibility Principle.
   *
   */
  private readonly stageRunner: StageRunner<TOut, TScope>;

  /**
   * LoopHandler module for dynamic next, iteration counting, and loop-back logic.
   * Extracted from Pipeline.ts for Single Responsibility Principle.
   *
   */
  private readonly loopHandler: LoopHandler<TOut, TScope>;

  /**
   * DeciderHandler module for decider evaluation and branching.
   * Extracted from Pipeline.ts for Single Responsibility Principle.
   *
   */
  private readonly deciderHandler: DeciderHandler<TOut, TScope>;

  /**
   * Narrative generator for producing human-readable execution story.
   *
   * WHY: Holds either a NarrativeGenerator (when enabled) or a
   * NullNarrativeGenerator (when disabled). The Null Object pattern
   * lets handlers call narrative methods unconditionally — zero cost
   * when narrative is not needed.
   *
   */
  private readonly narrativeGenerator: INarrativeGenerator;

  /**
   * Static build-time pipeline structure snapshot from FlowChartBuilder.
   *
   * WHY: Stored so that Pipeline can deep-clone it into `runtimePipelineStructure`
   * during initialization (task 2.1). Kept as an immutable reference — never
   * mutated during execution — so consumers can still access the original
   * static structure for diffing or caching.
   *
   */
  private readonly buildTimeStructure?: SerializedPipelineStructure;

  /**
   * Mutable runtime pipeline structure that starts as a deep clone of buildTimeStructure
   * and gets updated as dynamic stages are discovered during execution.
   *
   * WHY: Makes the library the single source of truth for the complete execution structure,
   * eliminating the need for UI-side reconstruction (runtimeMerger).
   *
   */
  private runtimePipelineStructure?: SerializedPipelineStructure;

  /**
   * Lookup map from node ID/name to its SerializedPipelineStructure node
   * in the runtimePipelineStructure tree. Enables O(1) updates.
   *
   * WHY: When a dynamic event occurs, we need to find the corresponding
   * structure node quickly. Walking the tree each time would be O(n).
   *
   */
  private structureNodeMap: Map<string, SerializedPipelineStructure> = new Map();

  constructor(
    root: StageNode,
    stageMap: Map<string, PipelineStageFunction<TOut, TScope>>,
    scopeFactory: ScopeFactory<TScope>,
    defaultValuesForContext?: unknown,
    initialContext?: unknown,
    readOnlyContext?: unknown,
    throttlingErrorChecker?: (error: unknown) => boolean,
    streamHandlers?: StreamHandlers,
    extractor?: TraversalExtractor,
    scopeProtectionMode?: ScopeProtectionMode,
    subflows?: Record<string, { root: StageNode<TOut, TScope> }>,
    enrichSnapshots?: boolean,
    narrativeEnabled?: boolean,
    buildTimeStructure?: SerializedPipelineStructure,
  ) {
    this.root = root;
    this.stageMap = stageMap;
    this.readOnlyContext = readOnlyContext;
    this.pipelineRuntime = new PipelineRuntime(this.root.name, defaultValuesForContext, initialContext);
    this.throttlingErrorChecker = throttlingErrorChecker;
    this.ScopeFactory = scopeFactory;
    this.streamHandlers = streamHandlers;
    this.extractor = extractor;
    this.scopeProtectionMode = scopeProtectionMode ?? 'error';
    this.subflows = subflows;
    this.enrichSnapshots = enrichSnapshots ?? false;
    this.buildTimeStructure = buildTimeStructure;

    // Deep-clone buildTimeStructure into runtimePipelineStructure and build
    // the O(1) lookup map. No-op when buildTimeStructure is not provided.
    this.initRuntimeStructure(buildTimeStructure);

    // Create narrative generator based on opt-in flag.
    // WHY: NullNarrativeGenerator is the default — zero allocation, zero string
    // formatting. Only when the consumer explicitly enables narrative do we
    // allocate the real NarrativeGenerator with its sentences array.
    this.narrativeGenerator = narrativeEnabled
      ? new NarrativeGenerator()
      : new NullNarrativeGenerator();

    // Initialize NodeResolver with shared context
    this.nodeResolver = new NodeResolver(this.createPipelineContext());

    // Initialize ChildrenExecutor with shared context and executeNode callback
    // Note: We bind executeNode to preserve 'this' context
    this.childrenExecutor = new ChildrenExecutor(
      this.createPipelineContext(),
      this.executeNode.bind(this),
    );

    // Initialize SubflowExecutor with shared context and required callbacks
    // Note: We bind methods to preserve 'this' context
    this.subflowExecutor = new SubflowExecutor(
      this.createPipelineContext(),
      this.nodeResolver,
      this.executeStage.bind(this),
      this.callExtractor.bind(this),
      this.getStageFn.bind(this),
    );

    // Initialize StageRunner with shared context
    this.stageRunner = new StageRunner(this.createPipelineContext());

    // Initialize LoopHandler with shared context and NodeResolver
    this.loopHandler = new LoopHandler(
      this.createPipelineContext(),
      this.nodeResolver,
      // Callback to update runtime pipeline structure with iteration count
      (nodeId: string, count: number) => this.updateStructureIterationCount(nodeId, count),
    );

    // Initialize DeciderHandler with shared context and NodeResolver
    this.deciderHandler = new DeciderHandler(this.createPipelineContext(), this.nodeResolver);
  }

  /**
   * Create a PipelineContext object for use by extracted modules.
   * This provides all the shared state needed by NodeResolver, ChildrenExecutor, etc.
   *
   * @returns PipelineContext with all required fields
   *
   */
  private createPipelineContext(): PipelineContext<TOut, TScope> {
    return {
      stageMap: this.stageMap,
      root: this.root,
      pipelineRuntime: this.pipelineRuntime,
      ScopeFactory: this.ScopeFactory,
      subflows: this.subflows,
      throttlingErrorChecker: this.throttlingErrorChecker,
      streamHandlers: this.streamHandlers,
      scopeProtectionMode: this.scopeProtectionMode,
      readOnlyContext: this.readOnlyContext,
      extractor: this.extractor,
      narrativeGenerator: this.narrativeGenerator,
    };
  }

  /** Execute the pipeline from the root node. */
  async execute(): Promise<TreeOfFunctionsResponse> {
    const context = this.pipelineRuntime.rootStageContext;
    return await this.executeNode(this.root, context, { shouldBreak: false }, '');
  }

  /**
   * Returns the runtime pipeline structure with all dynamic updates applied.
   *
   * WHY: Provides the complete, authoritative pipeline structure including
   * dynamically added children, subflows, next nodes, and loop iteration counts.
   * Consumers can use this for visualization without needing to reconstruct
   * the structure from separate data sources.
   *
   * Before execution: returns the initial deep clone of buildTimeStructure.
   * After execution: returns the fully enriched structure.
   * When buildTimeStructure was not provided: returns undefined.
   *
   */
  getRuntimePipelineStructure(): SerializedPipelineStructure | undefined {
    return this.runtimePipelineStructure;
  }


  /**
   * Initialize the runtime pipeline structure from the build-time structure.
   *
   * WHY: Creates a mutable deep clone so that dynamic changes during execution
   * (children, subflows, next nodes, loop iterations) can be reflected in a
   * single authoritative structure without mutating the original buildTimeStructure.
   *
   * DESIGN: Uses JSON.parse(JSON.stringify(...)) for deep cloning — simple and
   * sufficient since SerializedPipelineStructure contains only JSON-safe values.
   *
   * @param buildTimeStructure - The static structure from FlowChartBuilder, or undefined
   *
   */
  private initRuntimeStructure(buildTimeStructure?: SerializedPipelineStructure): void {
    if (!buildTimeStructure) return;

    this.runtimePipelineStructure = JSON.parse(JSON.stringify(buildTimeStructure));
    this.buildStructureNodeMap(this.runtimePipelineStructure!);
  }

  /**
   * Build the StructureNodeMap by recursively walking the structure tree.
   * Keys are node IDs (preferred) or names (fallback).
   *
   * WHY: Enables O(1) lookups when dynamic events occur during execution,
   * avoiding an O(n) tree walk for each update.
   *
   * @param node - The current structure node to register and recurse into
   *
   */
  private buildStructureNodeMap(node: SerializedPipelineStructure): void {
    const key = node.id ?? node.name;
    this.structureNodeMap.set(key, node);

    if (node.children) {
      for (const child of node.children) {
        this.buildStructureNodeMap(child);
      }
    }
    if (node.next) {
      this.buildStructureNodeMap(node.next);
    }
    if (node.subflowStructure) {
      this.buildStructureNodeMap(node.subflowStructure);
    }
  }

  /**
   * Convert a runtime StageNode into a SerializedPipelineStructure node.
   *
   * WHY: When dynamic stages are discovered during execution, we need to create
   * corresponding structure nodes for the runtimePipelineStructure. This method
   * provides a consistent conversion that reuses computeNodeType for the type field
   * and recursively handles children/next chains.
   *
   * DESIGN: Copies only the serialization-relevant fields from StageNode.
   * Metadata flags (isStreaming, isSubflowRoot, hasDecider, hasSelector) are set
   * conditionally to keep the serialized output sparse. Subflow buildTimeStructure
   * is attached as-is since it's already in serialized form.
   *
   * @param node - The runtime StageNode to convert
   * @returns A SerializedPipelineStructure node representing the same stage
   *
   */
  private stageNodeToStructure(node: StageNode): SerializedPipelineStructure {
    const structure: SerializedPipelineStructure = {
      name: node.name,
      id: node.id,
      type: this.computeNodeType(node),
      displayName: node.displayName,
      description: node.description,
    };

    // Streaming metadata
    if (node.isStreaming) {
      structure.isStreaming = true;
      structure.streamId = node.streamId;
    }

    // Subflow root metadata
    if (node.isSubflowRoot) {
      structure.isSubflowRoot = true;
      structure.subflowId = node.subflowId;
      structure.subflowName = node.subflowName;
    }

    // Decider metadata — legacy (nextNodeDecider) or scope-based (deciderFn)
    if (node.nextNodeDecider || node.deciderFn) {
      structure.hasDecider = true;
      structure.branchIds = node.children?.map(c => c.id ?? c.name);
    }

    // Selector metadata
    if (node.nextNodeSelector) {
      structure.hasSelector = true;
      structure.branchIds = node.children?.map(c => c.id ?? c.name);
    }

    // Recursively convert children
    if (node.children?.length) {
      structure.children = node.children.map(c => this.stageNodeToStructure(c));
    }

    // Recursively convert next chain
    if (node.next) {
      structure.next = this.stageNodeToStructure(node.next);
    }

    // Attach subflow's build-time structure if available
    if (node.subflowDef?.buildTimeStructure) {
      structure.subflowStructure = node.subflowDef.buildTimeStructure as SerializedPipelineStructure;
    }

    return structure;
  }

  /**
   * Update the runtime structure when dynamic children are discovered.
   *
   * WHY: When a stage returns a StageNode with dynamic children via isStageNodeReturn(),
   * the runtime StageNode tree is mutated but the serialized structure would be stale.
   * This method keeps runtimePipelineStructure in sync by converting each dynamic child
   * into a SerializedPipelineStructure node and inserting it under the parent.
   *
   * DESIGN: Uses structureNodeMap for O(1) parent lookup, then delegates to
   * stageNodeToStructure for recursive conversion and buildStructureNodeMap for
   * registration. Selector/decider flags are set on the parent so the UI can
   * render branching controls correctly.
   *
   * @param parentNodeId - The ID (or name) of the parent node in the structure
   * @param dynamicChildren - The runtime StageNode children to convert and insert
   * @param hasSelector - Whether the dynamic node has a nextNodeSelector
   * @param hasDecider - Whether the dynamic node has a nextNodeDecider
   *
   */
  private updateStructureWithDynamicChildren(
    parentNodeId: string,
    dynamicChildren: StageNode[],
    hasSelector?: boolean,
    hasDecider?: boolean,
  ): void {
    // Guard: no-op when structure tracking is disabled
    if (!this.runtimePipelineStructure) return;

    // O(1) lookup for the parent node
    const parentStructure = this.structureNodeMap.get(parentNodeId);
    if (!parentStructure) {
      // Defensive: shouldn't happen in practice but prevents crashes
      // eslint-disable-next-line no-console
      console.warn(
        `[Pipeline] updateStructureWithDynamicChildren: parent node "${parentNodeId}" not found in structureNodeMap`,
      );
      return;
    }

    // Convert each dynamic child StageNode into a SerializedPipelineStructure node
    const childStructures = dynamicChildren.map(child => this.stageNodeToStructure(child));

    // Set the converted children on the parent's children array
    parentStructure.children = childStructures;

    // Register each new child (and its descendants) in the structureNodeMap
    for (const childStructure of childStructures) {
      this.buildStructureNodeMap(childStructure);
    }

    // Set selector flag and compute branchIds when the dynamic node has a selector
    if (hasSelector) {
      parentStructure.hasSelector = true;
      parentStructure.branchIds = childStructures.map(c => c.id ?? c.name);
    }

    // Set decider flag and compute branchIds when the dynamic node has a decider
    if (hasDecider) {
      parentStructure.hasDecider = true;
      parentStructure.branchIds = childStructures.map(c => c.id ?? c.name);
    }
  }

  /**
   * Update the runtime structure when a dynamic subflow is registered.
   *
   * WHY: When a subflow is auto-registered at runtime (e.g., tool dispatch spawning
   * a sub-agent), the serialized structure needs to reflect the subflow hierarchy so
   * consumers get the complete picture without UI-side reconstruction.
   *
   * DESIGN: Marks the mount node as a subflow root and attaches the subflow's
   * build-time structure for drill-down visualization. Registers subflow nodes
   * in the structureNodeMap so subsequent dynamic updates within the subflow
   * can find their targets via O(1) lookup.
   *
   * @param mountNodeId - ID of the node where the subflow is mounted
   * @param subflowId - Unique identifier for the subflow
   * @param subflowName - Optional display name for the subflow
   * @param subflowBuildTimeStructure - Optional build-time structure of the subflow for drill-down
   */
  private updateStructureWithDynamicSubflow(
    mountNodeId: string,
    subflowId: string,
    subflowName?: string,
    subflowBuildTimeStructure?: unknown,
  ): void {
    // Guard: no-op when structure tracking is disabled
    if (!this.runtimePipelineStructure) return;

    // O(1) lookup for the mount node
    const mountStructure = this.structureNodeMap.get(mountNodeId);
    if (!mountStructure) {
      // Defensive: shouldn't happen in practice but prevents crashes
      // eslint-disable-next-line no-console
      console.warn(
        `[Pipeline] updateStructureWithDynamicSubflow: mount node "${mountNodeId}" not found in structureNodeMap`,
      );
      return;
    }

    // Mark the mount node as a subflow root with its identity
    mountStructure.isSubflowRoot = true;
    mountStructure.subflowId = subflowId;

    // Set display name only when provided to avoid overwriting existing values with undefined
    if (subflowName !== undefined) {
      mountStructure.subflowName = subflowName;
    }

    // Attach the subflow's build-time structure for drill-down visualization
    if (subflowBuildTimeStructure) {
      mountStructure.subflowStructure = subflowBuildTimeStructure as SerializedPipelineStructure;

      // Register all subflow structure nodes for future O(1) lookups
      this.buildStructureNodeMap(mountStructure.subflowStructure);
    }
  }


  /**
   * Update the runtime structure when a dynamic next is discovered.
   *
   * WHY: When a stage returns a StageNode with a `next` chain via `isStageNodeReturn()`,
   * the runtime StageNode tree is mutated but the serialized structure is not. This method
   * keeps `runtimePipelineStructure` in sync so consumers get the complete linear
   * continuation without external reconstruction.
   *
   * DESIGN: Mirrors the pattern of `updateStructureWithDynamicChildren` and
   * `updateStructureWithDynamicSubflow` — guard, lookup, convert, attach, register.
   *
   * @param currentNodeId - ID of the node whose stage returned the dynamic next
   * @param dynamicNext   - The StageNode to attach as the next continuation
   *
   */
  private updateStructureWithDynamicNext(
    currentNodeId: string,
    dynamicNext: StageNode,
  ): void {
    // Guard: no-op when structure tracking is disabled
    if (!this.runtimePipelineStructure) return;

    // O(1) lookup for the current node
    const currentStructure = this.structureNodeMap.get(currentNodeId);
    if (!currentStructure) {
      // Defensive: shouldn't happen in practice but prevents crashes
      // eslint-disable-next-line no-console
      console.warn(
        `[Pipeline] updateStructureWithDynamicNext: node "${currentNodeId}" not found in structureNodeMap`,
      );
      return;
    }

    // Convert the dynamic StageNode into a serialized structure node
    const nextStructure = this.stageNodeToStructure(dynamicNext);

    // Attach as the next continuation on the current structure node
    currentStructure.next = nextStructure;

    // Register the new node (and any descendants) for future O(1) lookups
    this.buildStructureNodeMap(nextStructure);
  }

  /**
   * Update the runtime structure with loop iteration count for a node.
   *
   * WHY: When a node is visited more than once due to a loop, the runtime
   * structure should reflect the total number of executions so that
   * consumers (e.g., debug UI) can display iteration counts without
   * reconstructing them from runtime data.
   *
   * DESIGN: Called via an onIterationUpdate callback from LoopHandler,
   * which owns the iteration counters. The count passed here is the
   * total number of visits (1-based: first loop-back = 2).
   *
   * @param nodeId - The ID of the node being iterated
   * @param count - The total iteration count (number of times visited)
   *
   */
  private updateStructureIterationCount(nodeId: string, count: number): void {
    // Guard: no-op when structure tracking is disabled
    if (!this.runtimePipelineStructure) return;

    // O(1) lookup for the target node
    const nodeStructure = this.structureNodeMap.get(nodeId);
    // Guard: expected for nodes without IDs — no warning needed
    if (!nodeStructure) return;

    // Set the iteration count on the structure node
    nodeStructure.iterationCount = count;
  }


  /** Resolve a stage function: prefer embedded `node.fn`, else look up by `node.name` in `stageMap`. */
  private getStageFn(node: StageNode<TOut, TScope>): PipelineStageFunction<TOut, TScope> | undefined {
    if (typeof node.fn === 'function') return node.fn as PipelineStageFunction<TOut, TScope>;
    return this.stageMap.get(node.name);
  }


  /**
   * Execute a single node with the unified order described in the file header.
   *
   * @param node         Current node to execute
   * @param context      Current StageContext
   * @param breakFlag    Break flag bubbled through recursion
   * @param branchPath   Logical pipeline id/path (for logs); inherited by children
   */
  private async executeNode(
    node: StageNode,
    context: StageContext,
    breakFlag: { shouldBreak: boolean },
    branchPath?: string,
  ): Promise<any> {
    // ───────────────────────── 0) Subflow Detection ─────────────────────────
    // If this node is a subflow root, execute it with an isolated nested context
    if (node.isSubflowRoot && node.subflowId) {
      // Resolve reference node if needed
      // Reference nodes have isSubflowRoot but no fn/children - they point to subflows dictionary
      const resolvedNode = this.nodeResolver.resolveSubflowReference(node);
      
      // Set subflow context for structureMetadata propagation
      // All nodes within this subflow will have subflowId in their structureMetadata
      const previousSubflowId = this.currentSubflowId;
      this.currentSubflowId = node.subflowId;
      
      let subflowOutput: any;
      try {
        subflowOutput = await this.subflowExecutor.executeSubflow(
          resolvedNode,
          context,
          breakFlag,
          branchPath,
          this.subflowResults,
        );
      } finally {
        // Clear subflow context when exiting (restore previous if nested)
        this.currentSubflowId = previousSubflowId;
      }
      
      // After subflow completes, continue with node.next in the PARENT context (if present)
      // 
      // IMPORTANT: We need to determine if `next` is a continuation after the subflow
      // or if it was already executed as part of the subflow's internal structure.
      //
      // Heuristic:
      // - If the subflow has `children` (fork pattern), `next` is the continuation
      // - If the subflow has no `children` (linear pattern), `next` was already executed internally
      //
      // For reference-based subflows (resolvedNode !== node), the original reference node's
      // `next` is always the continuation (the subflow's internal structure is in the definition).
      const isReferenceBasedSubflow = resolvedNode !== node;
      const hasChildren = Boolean(node.children && node.children.length > 0);
      const shouldExecuteContinuation = isReferenceBasedSubflow || hasChildren;
      
      if (node.next && shouldExecuteContinuation) {
        const nextStageContext = context.createNext(branchPath as string, node.next.name);
        return await this.executeNode(node.next, nextStageContext, breakFlag, branchPath);
      }
      
      return subflowOutput;
    }

    const stageFunc = this.getStageFn(node);
    const hasStageFunction = Boolean(stageFunc);
    const isLegacyDecider = Boolean(node.nextNodeDecider);
    const isScopeBasedDecider = Boolean(node.deciderFn);
    const isDeciderNode = isLegacyDecider || isScopeBasedDecider;
    const hasChildren = Boolean(node.children?.length);
    const hasNext = Boolean(node.next);
    // Save original next reference before stage execution.
    // WHY: Dynamic stage handling (step 3) may mutate node.next for serialization
    // visibility (getRuntimeRoot). We must use the ORIGINAL next for step 6 to
    // avoid following a dynamicNext reference that was attached during a previous
    // iteration's stage execution.
    const originalNext = node.next;
    // Note: Dynamic behavior is detected via isStageNodeReturn() on stage output, not via node flags

    // ───────────────────────── 1) Validation ─────────────────────────
    // A node must provide at least one of: stage, children, or decider.
    if (!hasStageFunction && !isDeciderNode && !hasChildren) {
      const errorMessage = `Node '${node.name}' must define: embedded fn OR a stageMap entry OR have children/decider`;
      logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error: errorMessage });
      throw new Error(errorMessage);
    }
    if (isDeciderNode && !hasChildren) {
      const errorMessage = 'Decider node needs to have children to execute';
      logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error: errorMessage });
      throw new Error(errorMessage);
    }

    // Mark role when there is no stage function (useful for debug panels)
    if (!hasStageFunction) {
      if (isDeciderNode) context.setAsDecider();
      else if (hasChildren) context.setAsFork();
    }

    const breakFn = () => (breakFlag.shouldBreak = true);

    // ───────────────────────── 2) Decider node ─────────────────────────
    // decider order: stage (optional) → commit → decider → chosen child
    // Route to the correct DeciderHandler method based on decider type:
    // - Scope-based (deciderFn): fn IS the decider, returns branch ID directly
    // - Legacy (nextNodeDecider): separate decider function evaluates after optional stage
    if (isDeciderNode) {
      if (isScopeBasedDecider) {
        // Scope-based decider: fn is required (it IS the decider)
        return this.deciderHandler.handleScopeBased(
          node,
          stageFunc!,
          context,
          breakFlag,
          branchPath,
          this.executeStage.bind(this),
          this.executeNode.bind(this),
          this.callExtractor.bind(this),
          this.getStagePath.bind(this),
        );
      } else {
        // Legacy output-based decider: stage is optional, decider is separate
        return this.deciderHandler.handle(
          node,
          stageFunc,
          context,
          breakFlag,
          branchPath,
          this.executeStage.bind(this),
          this.executeNode.bind(this),
          this.callExtractor.bind(this),
          this.getStagePath.bind(this),
        );
      }
    }

    // ───────────────────────── 3) Non-decider: STAGE FIRST ─────────────────────────
    // unified order: stage (optional) → commit → (break?) → children (optional) → dynamicNext (optional) → next (optional)
    let stageOutput: TOut | undefined;
    let dynamicNext: StageNode | undefined;

    if (stageFunc) {
      try {
        stageOutput = await this.executeStage(node, stageFunc, context, breakFn);
      } catch (error: any) {
        context.commit(); // apply patch on error as before
        // Pass undefined for stageOutput and error details for enrichment
        // WHY: On error path, there's no successful output, but we capture
        // the error info so enriched snapshots include what went wrong.
        this.callExtractor(node, context, this.getStagePath(node, branchPath, context.stageName), undefined, {
          type: 'stageExecutionError',
          message: error.toString(),
        });
        // Narrative: record the error so the story captures what went wrong
        this.narrativeGenerator.onError(node.name, error.toString(), node.displayName);
        logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error });
        context.addError('stageExecutionError', error.toString());
        throw error;
      }
      context.commit();
      // Pass stageOutput so enriched snapshots capture the stage's return value
      this.callExtractor(node, context, this.getStagePath(node, branchPath, context.stageName), stageOutput);

      // Narrative: record that this stage executed successfully
      this.narrativeGenerator.onStageExecuted(node.name, node.displayName, node.description);

      if (breakFlag.shouldBreak) {
        // Narrative: record that execution stopped here due to break
        this.narrativeGenerator.onBreak(node.name, node.displayName);
        logger.info(`Execution stopped in pipeline (${branchPath}) after ${node.name} due to break condition.`);
        return stageOutput; // leaf/early stop returns the stage's output
      }

      // ───────────────────────── Handle dynamic stages ─────────────────────────
      // Check if the handler's return object is a StageNode for dynamic continuation.
      // Detection uses duck-typing via isStageNodeReturn().
      if (stageOutput && typeof stageOutput === 'object' && isStageNodeReturn(stageOutput)) {
        const dynamicNode = stageOutput as StageNode;
        context.addLog('isDynamic', true);
        context.addLog('dynamicPattern', 'StageNodeReturn');

        // ───────────────────── Dynamic Subflow Auto-Registration ─────────────────────
        // WHY: When a stage returns a StageNode with isSubflowRoot + subflowDef,
        // it's requesting dynamic subflow attachment. We auto-register the compiled
        // FlowChart in the subflows dictionary so SubflowExecutor can resolve it.
        // This enables runtime subflow attachment without build-time registration.
        //
        // DESIGN: First-write-wins — if a subflow with the same ID already exists
        // in the dictionary, we preserve the existing definition. StageMap entries
        // from the subflow are merged into the parent (parent entries preserved).
        //
        // After registration, we transfer subflow properties to the current node
        // and recurse into executeNode so step 0 (subflow detection) picks it up.
        //
        if (dynamicNode.isSubflowRoot && dynamicNode.subflowDef && dynamicNode.subflowId) {
          context.addLog('dynamicPattern', 'dynamicSubflow');
          context.addLog('dynamicSubflowId', dynamicNode.subflowId);

          this.autoRegisterSubflowDef(dynamicNode.subflowId, dynamicNode.subflowDef, node.id ?? node.name);

          // Transfer subflow properties to current node for step 0 detection
          node.isSubflowRoot = true;
          node.subflowId = dynamicNode.subflowId;
          node.subflowName = dynamicNode.subflowName;
          node.subflowMountOptions = dynamicNode.subflowMountOptions;

          // Update runtime pipeline structure with dynamic subflow
          this.updateStructureWithDynamicSubflow(
            node.id ?? node.name,
            dynamicNode.subflowId!,
            dynamicNode.subflowName,
            dynamicNode.subflowDef?.buildTimeStructure,
          );

          // Recurse into executeNode — step 0 will detect isSubflowRoot
          return await this.executeNode(node, context, breakFlag, branchPath);
        }

        // Also check children for subflowDef (e.g., tool dispatch returns
        // parallel children where some are subflow references)
        if (dynamicNode.children) {
          for (const child of dynamicNode.children) {
            if (child.isSubflowRoot && child.subflowDef && child.subflowId) {
              this.autoRegisterSubflowDef(child.subflowId, child.subflowDef, child.id ?? child.name);
              // Update runtime pipeline structure with dynamic subflow for each child
              this.updateStructureWithDynamicSubflow(
                child.id ?? child.name,
                child.subflowId!,
                child.subflowName,
                child.subflowDef?.buildTimeStructure,
              );
            }
          }
        }

        // Handle dynamic children (fork pattern)
        if (dynamicNode.children && dynamicNode.children.length > 0) {
          node.children = dynamicNode.children;
          context.addLog('dynamicChildCount', dynamicNode.children.length);
          context.addLog('dynamicChildIds', dynamicNode.children.map(c => c.id || c.name));

          // Update runtime pipeline structure with dynamic children
          this.updateStructureWithDynamicChildren(
            node.id ?? node.name,
            dynamicNode.children,
            Boolean(dynamicNode.nextNodeSelector),
            Boolean(dynamicNode.nextNodeDecider || dynamicNode.deciderFn),
          );

          // Handle dynamic selector (multi-choice branching)
          if (typeof dynamicNode.nextNodeSelector === 'function') {
            node.nextNodeSelector = dynamicNode.nextNodeSelector;
            context.addLog('hasSelector', true);
          }
          // Handle dynamic decider (single-choice branching)
          else if (typeof dynamicNode.nextNodeDecider === 'function') {
            node.nextNodeDecider = dynamicNode.nextNodeDecider;
            context.addLog('hasDecider', true);
          }
        }

        // Handle dynamic next (linear continuation)
        if (dynamicNode.next) {
          dynamicNext = dynamicNode.next;
          // Update runtime pipeline structure with dynamic next
          this.updateStructureWithDynamicNext(
            node.id ?? node.name,
            dynamicNode.next,
          );
          // Attach to node for serialization visibility (getRuntimeRoot)
          node.next = dynamicNode.next;
          context.addLog('hasDynamicNext', true);
        }

        // Clear stageOutput since the StageNode is the continuation, not the output
        stageOutput = undefined;
      }

      // Restore node.next to its original value after capturing dynamicNext.
      // WHY: The mutation `node.next = dynamicNode.next` above is for serialization
      // visibility (getRuntimeRoot), but it persists on the node object. If this node
      // is visited again in a loop, the stale dynamicNext reference would cause step 6
      // to follow it incorrectly. Restoring ensures loop-back visits see the original
      // node structure.
      if (dynamicNext) {
        node.next = originalNext;
      }
    }

    // ───────────────────────── 4) Children (if any) ─────────────────────────
    // Re-evaluate hasChildren after stage execution, as the stage may have
    // dynamically populated node.children (e.g., toolBranch injects tool nodes)
    const hasChildrenAfterStage = Boolean(node.children?.length);
    
    if (hasChildrenAfterStage) {
      // Breadcrumbs
      context.addLog('totalChildren', node.children?.length);
      context.addLog('orderOfExecution', 'ChildrenAfterStage');

      let nodeChildrenResults: Record<string, NodeResultType>;

      // Check for selector (multi-choice) - can pick multiple children
      if (node.nextNodeSelector) {
        // Set fork context for structureMetadata propagation
        // All parallel children will have parallelGroupId in their structureMetadata
        const previousForkId = this.currentForkId;
        this.currentForkId = node.id ?? node.name;
        
        try {
          nodeChildrenResults = await this.childrenExecutor.executeSelectedChildren(
            node.nextNodeSelector,
            node.children!,
            stageOutput,
            context,
            branchPath as string,
          );
        } finally {
          // Clear fork context after children complete (restore previous if nested)
          this.currentForkId = previousForkId;
        }
      }
      // Check for decider (single-choice) - picks exactly one child
      else if (node.nextNodeDecider) {
        // Decider was dynamically injected, execute it
        const chosen = await this.nodeResolver.getNextNode(
          node.nextNodeDecider,
          node.children!,
          stageOutput,
          context,
        );
        const nextStageContext = context.createNext(branchPath as string, chosen.name);
        return await this.executeNode(chosen, nextStageContext, breakFlag, branchPath);
      }
      // Default: execute all children in parallel (fork pattern)
      else {
        // Log flow control decision for fork children
        const childCount = node.children?.length ?? 0;
        const childNames = node.children?.map(c => c.displayName || c.name).join(', ');
        context.addFlowDebugMessage('children', `Executing all ${childCount} children in parallel: ${childNames}`, {
          count: childCount,
          targetStage: node.children?.map(c => c.name),
        });
        
        // Set fork context for structureMetadata propagation
        // All parallel children will have parallelGroupId in their structureMetadata
        const previousForkId = this.currentForkId;
        this.currentForkId = node.id ?? node.name;
        
        try {
          nodeChildrenResults = await this.childrenExecutor.executeNodeChildren(node, context, undefined, branchPath);
        } finally {
          // Clear fork context after children complete (restore previous if nested)
          this.currentForkId = previousForkId;
        }
      }

      // Fork-only (no next, no dynamicNext): return bundle object
      if (!hasNext && !dynamicNext) {
        return nodeChildrenResults;
      }

      // ── Capture dynamic children as subflow result for debug visualization ──
      // WHY: When a stage dynamically creates children (e.g., tool execution),
      // the UI needs subflowResults data to render them as a drillable subflow.
      // ChildrenExecutor doesn't produce subflowResults — only SubflowExecutor does.
      // So we create a synthetic entry here from the children's execution data.
      //
      // DESIGN: Only for dynamic children (isDynamic flag in context). Static
      // children (build-time fork) don't need this — they're in the pipelineStructure.
      const isDynamic = context.debug?.logContext?.isDynamic;
      if (isDynamic && node.children && node.children.length > 0) {
        const parentStageId = context.getStageId();

        // Mark this node as a subflow root in context so the UI renders it
        // with drill-down capability
        context.addLog('isSubflowContainer', true);
        context.addLog('subflowId', node.id || node.name);
        context.addLog('subflowName', node.displayName || node.name);
        context.addLog('hasSubflowData', true);

        const childStructure: any = {
          id: `${node.id || node.name}-children`,
          name: 'Dynamic Children',
          type: 'fork',
          children: node.children.map(c => ({
            id: c.id || c.name,
            name: c.name,
            displayName: c.displayName || c.name,
            type: 'stage',
          })),
        };

        // Build treeContext from the children's actual execution data.
        // WHY: The drill-down UI renders from the subflow's treeContext.
        // We extract each child's snapshot (logs, errors, metrics) from
        // the parent context's children array.
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

        this.subflowResults.set(node.id || node.name, {
          subflowId: node.id || node.name,
          subflowName: node.displayName || node.name,
          treeContext: {
            globalContext: {},
            stageContexts: childStages as unknown as Record<string, unknown>,
            history: [],
          },
          parentStageId,
          pipelineStructure: childStructure,
        });
      }

      // Fork + next or dynamicNext: continue below
    }

    // ───────────────────────── 5) Dynamic Next (loop support) ─────────────────────────
    // If dynamicNext is set, delegate to LoopHandler for resolution and execution
    if (dynamicNext) {
      return this.loopHandler.handle(
        dynamicNext,
        node,
        context,
        breakFlag,
        branchPath,
        this.executeNode.bind(this),
      );
    }

    // ───────────────────────── 6) Linear `next` (if provided) ─────────────────────────
    if (hasNext) {
      // Use originalNext (captured before stage execution) to avoid following
      // a dynamicNext reference that was attached to node.next during stage handling.
      const nextNode = originalNext!;
      
      // Narrative: record the transition to the next stage
      this.narrativeGenerator.onNext(node.name, nextNode.name, nextNode.displayName, nextNode.description);
      
      // Log flow control decision for linear next
      context.addFlowDebugMessage('next', `Moving to ${nextNode.displayName || nextNode.name} stage`, {
        targetStage: nextNode.name,
      });
      
      const nextStageContext = context.createNext(branchPath as string, nextNode.name);
      return await this.executeNode(nextNode, nextStageContext, breakFlag, branchPath);
    }

    // ───────────────────────── 7) Leaf ─────────────────────────
    // No children & no next & no dynamicNext → return this node's stage output (may be undefined)
    return stageOutput;
  }


  /**
   * Execute a node's stage function with **sync+async safety**:
   *  - If it's a real Promise, await it
   *  - Otherwise return the value as-is (no thenable assimilation)
   *
   * For streaming stages (node.isStreaming === true):
   *  - Creates a bound streamCallback that routes tokens to the registered handler
   *  - Calls onStart lifecycle hook before execution
   *  - Accumulates tokens during streaming
   *  - Calls onEnd lifecycle hook after execution with accumulated text
   *
   * Note: Dynamic behavior is detected via isStageNodeReturn() on the stage output,
   * not via node flags. Any stage can return a StageNode for dynamic continuation.
   *
   * Delegates to StageRunner module for actual execution.
   */
  private async executeStage(
    node: StageNode,
    stageFunc: PipelineStageFunction<TOut, TScope>,
    context: StageContext,
    breakFn: () => void,
  ) {
    return this.stageRunner.run(node, stageFunc, context, breakFn);
  }

  // ───────────────────────── Extractor helpers ─────────────────────────

  /**
   * Compute the node type based on node properties.
   * This logic was previously in service-layer serializePipelineStructure().
   * 
   * @param node - The stage node to compute type for
   * @returns The computed node type
   * 
   */
  private computeNodeType(node: StageNode): 'stage' | 'decider' | 'fork' | 'streaming' {
    // Decider takes precedence (has decision logic)
    // Check both legacy (nextNodeDecider) and scope-based (deciderFn) deciders
    if (node.nextNodeDecider || node.nextNodeSelector || node.deciderFn) return 'decider';
    
    // Streaming stages
    if (node.isStreaming) return 'streaming';
    
    // Fork: has static children (not dynamic)
    // Dynamic children are detected by having children + fn (stage that returns children)
    const hasDynamicChildren = Boolean(
      node.children?.length &&
      !node.nextNodeDecider &&
      !node.nextNodeSelector &&
      node.fn
    );
    if (node.children && node.children.length > 0 && !hasDynamicChildren) return 'fork';
    
    // Default: regular stage
    return 'stage';
  }

  /**
   * Build the RuntimeStructureMetadata for a node.
   * Called during traversal to provide pre-computed metadata to the extractor.
   * 
   * @param node - The stage node to build metadata for
   * @returns The computed RuntimeStructureMetadata
   * 
   */
  private buildStructureMetadata(node: StageNode): RuntimeStructureMetadata {
    const metadata: RuntimeStructureMetadata = {
      type: this.computeNodeType(node),
    };

    // Subflow metadata
    if (node.isSubflowRoot) {
      metadata.isSubflowRoot = true;
      metadata.subflowId = node.subflowId;
      metadata.subflowName = node.subflowName;
    } else if (this.currentSubflowId) {
      // Propagate subflowId to children within the subflow
      metadata.subflowId = this.currentSubflowId;
    }

    // Parallel child metadata (set by ChildrenExecutor)
    if (this.currentForkId) {
      metadata.isParallelChild = true;
      metadata.parallelGroupId = this.currentForkId;
    }

    // Streaming metadata
    if (node.isStreaming) {
      metadata.streamId = node.streamId;
    }

    // Dynamic children detection
    const hasDynamicChildren = Boolean(
      node.children?.length &&
      !node.nextNodeDecider &&
      !node.nextNodeSelector &&
      node.fn
    );
    if (hasDynamicChildren) {
      metadata.isDynamic = true;
    }

    return metadata;
  }

  /**
   * Call the extractor for a stage and store the result.
   * Handles errors gracefully - logs and continues execution.
   * 
   * Increments stepCounter before creating snapshot to provide
   * 1-based step numbers for time traveler synchronization.
   * 
   * Includes pre-computed structureMetadata so consumers can build
   * serialized structure at runtime without post-processing getRuntimeRoot().
   * 
   * @param node - The stage node
   * @param context - The stage context (after commitPatch)
   * @param stagePath - The full path to this stage (e.g., "root.child")
   * @param stageOutput - The stage function's return value (undefined for stages
   *   that return a StageNode for dynamic continuation or stages without functions).
   *   Used by enrichment to populate StageSnapshot.stageOutput.
   * @param errorInfo - Error details when the stage threw during execution.
   *   Contains `type` (error classification) and `message` (error description).
   *   Used by enrichment to populate StageSnapshot.errorInfo.
   * 
   */
  private callExtractor(
    node: StageNode,
    context: StageContext,
    stagePath: string,
    stageOutput?: unknown,
    errorInfo?: { type: string; message: string },
  ): void {
    if (!this.extractor) return;
    
    // Increment step counter before creating snapshot (1-based)
    this.stepCounter++;
    
    try {
      const snapshot: StageSnapshot = { 
        node, 
        context,
        stepNumber: this.stepCounter,
        structureMetadata: this.buildStructureMetadata(node),
      };

      // ── Enrich snapshot when opt-in is enabled ──
      // WHY: Captures full stage data during traversal, eliminating the need
      // for a redundant post-traversal walk via PipelineRuntime.getSnapshot().
      // Wrapped in its own try-catch so enrichment failures don't break the
      // base snapshot — the extractor still receives node/context/stepNumber.
      if (this.enrichSnapshots) {
        try {
          // Shallow clone of committed scope state
          // WHY: Shallow clone is sufficient because each stage's commit()
          // produces a new top-level object via structural sharing.
          // Deep values are immutable by convention (WriteBuffer enforces this).
          snapshot.scopeState = { ...this.pipelineRuntime.globalStore.getState() };

          // Capture debug metadata from StageMetadata
          // WHY: Eliminates the need to walk StageContext.debug after traversal.
          snapshot.debugInfo = {
            logs: { ...context.debug.logContext },
            errors: { ...context.debug.errorContext },
            metrics: { ...context.debug.metricContext },
            evals: { ...context.debug.evalContext },
          };
          if (context.debug.flowMessages.length > 0) {
            snapshot.debugInfo.flowMessages = [...context.debug.flowMessages];
          }

          // Capture stage output (undefined for dynamic stages that return StageNode)
          snapshot.stageOutput = stageOutput;

          // Capture error info if present (stage threw during execution)
          if (errorInfo) {
            snapshot.errorInfo = errorInfo;
          }

          // Capture history index (number of commits so far)
          // WHY: Enables scope reconstruction via executionHistory.materialise(historyIndex)
          // without a separate history replay pass.
          snapshot.historyIndex = this.pipelineRuntime.executionHistory.list().length;
        } catch (enrichError: any) {
          // Log but don't fail — the base snapshot is still valid
          logger.warn(`Enrichment error at stage '${stagePath}':`, { error: enrichError });
        }
      }

      const result = this.extractor(snapshot);
      
      // Only store if extractor returned a value
      if (result !== undefined && result !== null) {
        this.extractedResults.set(stagePath, result);
      }
    } catch (error: any) {
      // Log error but don't stop execution
      logger.error(`Extractor error at stage '${stagePath}':`, { error });
      this.extractorErrors.push({
        stagePath,
        message: error?.message ?? String(error),
        error,
      });
    }
  }

  /**
   * Generate the stage path for extractor results.
   * Uses node.id if available, otherwise node.name.
   * Combines with branchPath for nested stages.
   *
   * @param node - The stage node
   * @param branchPath - The branch path prefix (e.g., "root.child")
   * @param contextStageName - Optional stage name from StageContext, which includes
   *   iteration suffixes (e.g., "CallLLM.1") for loop iterations. When the context
   *   name differs from the base node name (indicating an iteration), we use it
   *   to ensure loop iterations produce unique keys in extractedResults.
   */
  private getStagePath(node: StageNode, branchPath?: string, contextStageName?: string): string {
    const baseName = node.id ?? node.name;
    // Use contextStageName only when it indicates an iteration (differs from base node.name).
    // WHY: During loop iterations, LoopHandler creates a StageContext with an iterated name
    // (e.g., "CallLLM.1"), but the node object still has the base name ("CallLLM").
    // For non-iterated stages, we prefer node.id (stable identifier) over node.name.
    const nodeId = (contextStageName && contextStageName !== node.name) ? contextStageName : baseName;
    if (!branchPath) return nodeId;
    return `${branchPath}.${nodeId}`;
  }

  /**
   * Auto-register a dynamic subflow definition in the subflows dictionary.
   *
   * WHY: When a stage returns a dynamic StageNode with `subflowDef`, the
   * compiled FlowChart needs to be registered so SubflowExecutor and
   * NodeResolver can resolve it. This method handles the registration,
   * stageMap merging, and handler context updates.
   *
   * DESIGN: First-write-wins — existing definitions are preserved.
   * StageMap entries from the subflow are merged (parent entries preserved).
   * Handler contexts are updated if the subflows dictionary was just created.
   *
   * @param subflowId - The subflow ID to register under
   * @param subflowDef - The compiled FlowChart definition
   *
   */
  private autoRegisterSubflowDef(
    subflowId: string,
    subflowDef: NonNullable<StageNode['subflowDef']>,
    mountNodeId?: string,
  ): void {
    let subflowsDict = this.subflows as Record<string, { root: StageNode<TOut, TScope> }> | undefined;
    if (!subflowsDict) {
      subflowsDict = {};
      (this as any).subflows = subflowsDict;
      // Update all handler contexts to see the new dictionary
      (this.nodeResolver as any).ctx.subflows = subflowsDict;
      (this.subflowExecutor as any).ctx.subflows = subflowsDict;
      (this.childrenExecutor as any).ctx.subflows = subflowsDict;
    }

    // First-write-wins
    if (!subflowsDict[subflowId]) {
      subflowsDict[subflowId] = {
        root: subflowDef.root as StageNode<TOut, TScope>,
        ...(subflowDef.buildTimeStructure
          ? { buildTimeStructure: subflowDef.buildTimeStructure }
          : {}),
      } as any;
    }

    // Merge stageMap entries (parent entries preserved)
    if (subflowDef.stageMap) {
      for (const [key, fn] of subflowDef.stageMap.entries()) {
        if (!this.stageMap.has(key)) {
          this.stageMap.set(key, fn as PipelineStageFunction<TOut, TScope>);
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

    // Update runtime pipeline structure with dynamic subflow
    if (mountNodeId) {
      this.updateStructureWithDynamicSubflow(
        mountNodeId,
        subflowId,
        subflowDef.root?.subflowName || subflowDef.root?.displayName,
        subflowDef.buildTimeStructure,
      );
    }
  }

  // ───────────────────────── Introspection helpers ─────────────────────────

  /** Returns the full context tree (global + stage contexts) for observability panels. */
  getContextTree(): RuntimeSnapshot {
    return this.pipelineRuntime.getSnapshot();
  }

  /** Returns the PipelineRuntime (root holder of StageContexts). */
  getContext(): PipelineRuntime {
    return this.pipelineRuntime;
  }

  /** Sets a root object value into the global context (utility). */
  setRootObject(path: string[], key: string, value: unknown) {
    this.pipelineRuntime.setRootObject(path, key, value);
  }

  /** Returns pipeline ids inherited under this root (for debugging fan-out). */
  getInheritedPipelines() {
    return this.pipelineRuntime.getPipelines();
  }

  /**
   * Returns the current pipeline root node (including runtime modifications).
   * 
   * This is useful for serializing the pipeline structure after execution,
   * which includes any dynamic children or loop targets added at runtime
   * by stages that return StageNode.
   * 
   * @returns The root StageNode with runtime modifications
   */
  getRuntimeRoot(): StageNode {
    return this.root;
  }

  /**
   * Returns the collected SubflowResultsMap after pipeline execution.
   * Used by the service layer to include subflow data in API responses.
   *
   */
  getSubflowResults(): Map<string, SubflowResult> {
    return this.subflowResults;
  }

  /**
   * Returns the collected extracted results after pipeline execution.
   * Map keys are stage paths (e.g., "root.child.grandchild").
   */
  getExtractedResults<TResult = unknown>(): Map<string, TResult> {
    return this.extractedResults as Map<string, TResult>;
  }

  /**
   * Returns any errors that occurred during extraction.
   * Useful for debugging extractor issues.
   */
  getExtractorErrors(): ExtractorError[] {
    return this.extractorErrors;
  }

  /**
   * Returns the narrative sentences from the current execution.
   *
   * WHY: Delegates to the narrative generator's getSentences() method.
   * When narrative is disabled (NullNarrativeGenerator), returns an empty array.
   * When enabled, returns the ordered array of human-readable sentences
   * produced during traversal.
   *
   * @returns Ordered array of narrative sentences, or empty array if disabled
   *
   */
  getNarrative(): string[] {
    return this.narrativeGenerator.getSentences();
  }
}
