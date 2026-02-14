/**
 * FlowChartBuilder.ts
 *
 * WHY: This is the primary API for building flowchart-based pipelines.
 * It provides a fluent builder pattern for constructing StageNode trees
 * and FlowChartSpec structures that can be executed by FlowChartExecutor.
 *
 * RESPONSIBILITIES:
 * - Build StageNode trees directly (no intermediate classes)
 * - Build FlowChartSpec incrementally alongside StageNode
 * - Support linear chaining, branching (decider/selector), and subflow mounting
 * - Manage stage function registry and stream handlers
 *
 * DESIGN DECISIONS:
 * - Simplified from original: no _N class, no parent pointer, no build callbacks
 * - Promotes subgraph composition over callback-based nesting
 * - Builds SerializedPipelineStructure with type field incrementally
 * - Applies buildTimeExtractor immediately when nodes are created
 *
 * RELATED:
 * - {@link FlowChartExecutor} - Executes the built flowchart
 * - {@link Pipeline} - Core execution engine
 * - {@link StageNode} - The node type built by this builder
 *
 * _Requirements: flowchart-builder-simplification 1.1, 1.4, 4.1_
 */

// Import from executor module (canonical location)
import type { Selector, StageNode } from '../executor/Pipeline';
import { FlowChartExecutor } from '../executor/FlowChartExecutor';
import type {
  PipelineStageFunction,
  StreamHandlers,
  StreamTokenHandler,
  StreamLifecycleHandler,
  TraversalExtractor,
  SubflowMountOptions,
} from '../executor/types';
import type { ScopeFactory } from '../memory/types';
import type { ScopeProtectionMode } from '../../scope/protection/types';

// Re-export stream types for consumers
export type { StreamHandlers, StreamTokenHandler, StreamLifecycleHandler };

// Re-export Selector type for consumers
export type { Selector };

// Re-export SubflowMountOptions for consumers
export type { SubflowMountOptions };

/**
 * Pure JSON Flow Chart spec for FE → BE transport (no functions/closures).
 */
export interface FlowChartSpec {
  name: string;
  id?: string;
  displayName?: string;
  children?: FlowChartSpec[];
  next?: FlowChartSpec;
  hasDecider?: boolean;
  hasSelector?: boolean;
  branchIds?: string[];
  loopTarget?: string;
  isStreaming?: boolean;
  streamId?: string;
  isParallelChild?: boolean;
  parallelGroupId?: string;
  isSubflowRoot?: boolean;
  subflowId?: string;
  subflowName?: string;
}

/**
 * Metadata provided to the build-time extractor for each node.
 */
export interface BuildTimeNodeMetadata {
  name: string;
  id?: string;
  displayName?: string;
  children?: BuildTimeNodeMetadata[];
  next?: BuildTimeNodeMetadata;
  hasDecider?: boolean;
  hasSelector?: boolean;
  branchIds?: string[];
  loopTarget?: string;
  isStreaming?: boolean;
  streamId?: string;
  isParallelChild?: boolean;
  parallelGroupId?: string;
  isSubflowRoot?: boolean;
  subflowId?: string;
  subflowName?: string;
}

/**
 * Build-time extractor function type.
 */
export type BuildTimeExtractor<TResult = FlowChartSpec> = (
  metadata: BuildTimeNodeMetadata
) => TResult;

/**
 * Simplified parallel spec without build callback.
 * _Requirements: flowchart-builder-simplification 2.2_
 */
export type SimplifiedParallelSpec<TOut = any, TScope = any> = {
  id: string;
  name: string;
  displayName?: string;
  fn?: PipelineStageFunction<TOut, TScope>;
  // REMOVED: build?: (b: FlowChartBuilder<TOut, TScope>) => void;
};

/**
 * Serialized pipeline structure for frontend consumption.
 */
export interface SerializedPipelineStructure {
  name: string;
  id?: string;
  type: 'stage' | 'decider' | 'fork' | 'streaming';
  displayName?: string;
  children?: SerializedPipelineStructure[];
  next?: SerializedPipelineStructure;
  hasDecider?: boolean;
  hasSelector?: boolean;
  branchIds?: string[];
  loopTarget?: string;
  isStreaming?: boolean;
  streamId?: string;
  isParallelChild?: boolean;
  parallelGroupId?: string;
  isSubflowRoot?: boolean;
  subflowId?: string;
  subflowName?: string;
  /** 
   * Complete subflow structure for drill-down visualization.
   * When a subflow is mounted, this contains the subflow's internal structure
   * (its first stage with its own ID, and the full next/children chain).
   * This is separate from the mount node to preserve the subflow's original IDs.
   * 
   * TODO: PAYLOAD OPTIMIZATION - Consider removing this field to reduce payload size.
   * FE could lookup structure from subflowResults[subflowId].pipelineStructure instead.
   * Currently kept as fallback for non-executed subflows (where no runtime data exists).
   * When removing, update FE useTreeLayout.ts to handle the lookup properly.
   */
  subflowStructure?: SerializedPipelineStructure;
}

/**
 * Compiled flowchart ready for execution.
 */
export type FlowChart<TOut = any, TScope = any> = {
  root: StageNode<TOut, TScope>;
  stageMap: Map<string, PipelineStageFunction<TOut, TScope>>;
  extractor?: TraversalExtractor;
  subflows?: Record<string, { root: StageNode<TOut, TScope> }>;
  buildTimeStructure: SerializedPipelineStructure;
  /**
   * Whether narrative generation is enabled at build time.
   *
   * WHY: Allows consumers to enable narrative at build time via FlowChartBuilder,
   * so the FlowChartExecutor can respect it as a default without requiring
   * an explicit enableNarrative() call.
   *
   * DESIGN: FlowChartExecutor reads this as a default for narrativeEnabled.
   * An explicit enableNarrative() call on the executor takes precedence.
   *
   * _Requirements: pipeline-narrative-generation 1.4_
   */
  enableNarrative?: boolean;
};

/**
 * Options for the execute sugar.
 */
export type ExecOptions = {
  defaults?: unknown;
  initial?: unknown;
  readOnly?: unknown;
  throttlingErrorChecker?: (e: unknown) => boolean;
  scopeProtectionMode?: ScopeProtectionMode;
  /**
   * Enable narrative generation at build time.
   *
   * WHY: Allows consumers to opt into narrative via the builder's execute()
   * convenience method, which sets the flag on the FlowChart object.
   *
   * _Requirements: pipeline-narrative-generation 1.4_
   */
  enableNarrative?: boolean;
};

/* ============================================================================
 * Internal helpers
 * ========================================================================== */

const fail = (msg: string): never => {
  throw new Error(`[FlowChartBuilder] ${msg}`);
};

/**
 * Internal cursor state - tracks both StageNode and FlowChartSpec together.
 * This replaces the _N class with a simpler structure.
 */
interface CursorState<TOut, TScope> {
  node: StageNode<TOut, TScope>;
  spec: FlowChartSpec;
}


/* ============================================================================
 * DeciderList (simplified - no build callbacks)
 * ========================================================================== */

/**
 * Fluent helper returned by addDecider / addDeciderFunction to add branches.
 *
 * WHY: Provides a fluent API for configuring decider branches regardless of
 * whether the decider is legacy (output-based) or scope-based. The `isScopeBased`
 * flag controls how `end()` wires the node — setting `nextNodeDecider` (legacy)
 * vs `deciderFn` (new scope-based).
 *
 * DESIGN: Reuses the same class for both old and new decider types. Only the
 * constructor parameters and `end()` behavior differ based on `isScopeBased`.
 * All branch methods (addFunctionBranch, addSubFlowChartBranch, addBranchList,
 * setDefault) remain identical for both modes.
 *
 * _Requirements: flowchart-builder-simplification 2.1, 6.1, 6.3, 6.4_
 * _Requirements: decider-first-class-stage 4.4, 5.1, 6.2_
 */
export class DeciderList<TOut = any, TScope = any> {
  private readonly b: FlowChartBuilder<TOut, TScope>;
  private readonly curNode: StageNode<TOut, TScope>;
  private readonly curSpec: SerializedPipelineStructure;
  private readonly originalDecider: ((out?: TOut) => string | Promise<string>) | null;
  private readonly branchIds = new Set<string>();
  private defaultId?: string;

  /**
   * Whether this DeciderList is for a scope-based decider (addDeciderFunction)
   * vs a legacy output-based decider (addDecider).
   *
   * WHY: Controls how `end()` wires the StageNode — scope-based sets `deciderFn = true`
   * while legacy wraps the decider function and sets `nextNodeDecider`.
   *
   * _Requirements: decider-first-class-stage 4.4, 5.1_
   */
  private readonly isScopeBased: boolean;

  constructor(
    builder: FlowChartBuilder<TOut, TScope>,
    curNode: StageNode<TOut, TScope>,
    curSpec: SerializedPipelineStructure,
    decider: ((out?: TOut) => string | Promise<string>) | null,
    isScopeBased: boolean = false,
  ) {
    this.b = builder;
    this.curNode = curNode;
    this.curSpec = curSpec;
    this.originalDecider = decider;
    this.isScopeBased = isScopeBased;
  }

  /**
   * Add a simple function branch (no nested flowchart).
   * REMOVED: build callback parameter
   * _Requirements: flowchart-builder-simplification 2.1_
   */
  addFunctionBranch(
    id: string,
    name: string,
    fn?: PipelineStageFunction<TOut, TScope>,
    displayName?: string,
  ): DeciderList<TOut, TScope> {
    if (this.branchIds.has(id)) fail(`duplicate decider branch id '${id}' under '${this.curNode.name}'`);
    this.branchIds.add(id);

    // Create StageNode directly
    const node: StageNode<TOut, TScope> = { name: name ?? id };
    if (id) node.id = id;
    if (displayName) node.displayName = displayName;
    if (fn) {
      node.fn = fn;
      this.b._addToMap(name, fn);
    }

    // Create SerializedPipelineStructure with type='stage' and apply extractor
    let spec: SerializedPipelineStructure = { name: name ?? id, type: 'stage' };
    if (id) spec.id = id;
    if (displayName) spec.displayName = displayName;
    
    // Apply extractor immediately
    spec = this.b._applyExtractorToNode(spec);

    // Add to parent's children
    this.curNode.children = this.curNode.children || [];
    this.curNode.children.push(node);
    this.curSpec.children = this.curSpec.children || [];
    this.curSpec.children.push(spec);

    return this;
  }

  /**
   * Mount a prebuilt flowchart as a branch.
   * _Requirements: flowchart-builder-simplification 6.2_
   * _Requirements: subflow-input-mapping 1.2, 1.5, 7.3_
   * 
   * IMPORTANT: This creates a WRAPPER node for the subflow mount point.
   * The subflow's internal structure is preserved in `subflowStructure` property,
   * NOT merged with the wrapper node. This ensures:
   * 1. The subflow's first stage keeps its original ID
   * 2. The mount point has its own distinct ID for navigation
   * 3. Drill-down can access the full subflow structure via `subflowStructure`
   * 
   * @param id - Unique identifier for the subflow mount point
   * @param subflow - The prebuilt FlowChart to mount
   * @param mountName - Optional display name for the mount point
   * @param options - Optional input/output mapping options for data flow between parent and subflow
   */
  addSubFlowChartBranch(
    id: string,
    subflow: FlowChart<TOut, TScope>,
    mountName?: string,
    options?: SubflowMountOptions,
  ): DeciderList<TOut, TScope> {
    if (this.branchIds.has(id)) fail(`duplicate decider branch id '${id}' under '${this.curNode.name}'`);
    this.branchIds.add(id);

    const displayName = mountName || id;

    // Register subflow definition
    if (!this.b._subflowDefs.has(id)) {
      this.b._subflowDefs.set(id, { root: subflow.root });
    }

    // Create reference StageNode
    const node: StageNode<TOut, TScope> = {
      name: displayName,
      id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName: displayName,
    };

    // Store subflowMountOptions if provided
    if (options) {
      node.subflowMountOptions = options;
    }

    // Create a WRAPPER spec for the subflow mount point.
    // CRITICAL: We do NOT spread subflow.buildTimeStructure here!
    // Instead, we store the subflow's structure in `subflowStructure` property.
    // This preserves the subflow's first stage ID and creates a clear boundary.
    const spec: SerializedPipelineStructure = {
      name: displayName,
      type: 'stage',
      id,
      displayName,
      isSubflowRoot: true,
      subflowId: id,
      subflowName: displayName,
      // Store the COMPLETE subflow structure for drill-down visualization
      subflowStructure: subflow.buildTimeStructure,
    };

    // Add to parent's children
    this.curNode.children = this.curNode.children || [];
    this.curNode.children.push(node);
    this.curSpec.children = this.curSpec.children || [];
    this.curSpec.children.push(spec);

    // Merge stage maps
    this.b._mergeStageMap(subflow.stageMap);

    // Merge nested subflows
    if (subflow.subflows) {
      for (const [key, def] of Object.entries(subflow.subflows)) {
        if (!this.b._subflowDefs.has(key)) {
          this.b._subflowDefs.set(key, def);
        }
      }
    }

    return this;
  }

  /**
   * Add multiple simple branches.
   * REMOVED: build callback in branch spec
   * _Requirements: flowchart-builder-simplification 2.3_
   */
  addBranchList(
    branches: Array<{
      id: string;
      name: string;
      fn?: PipelineStageFunction<TOut, TScope>;
      displayName?: string;
    }>,
  ): DeciderList<TOut, TScope> {
    for (const { id, name, fn, displayName } of branches) {
      this.addFunctionBranch(id, name, fn, displayName);
    }
    return this;
  }

  /**
   * Set default branch id.
   */
  setDefault(id: string): DeciderList<TOut, TScope> {
    this.defaultId = id;
    return this;
  }

  /**
   * Finalize the decider and return to main builder.
   *
   * WHY: Wires the StageNode differently based on whether this is a scope-based
   * or legacy decider. Scope-based sets `deciderFn = true` (the fn IS the decider),
   * while legacy wraps the decider function with default handling and sets `nextNodeDecider`.
   *
   * _Requirements: flowchart-builder-simplification 6.4_
   * _Requirements: decider-first-class-stage 4.4, 5.1, 6.2_
   */
  end(): FlowChartBuilder<TOut, TScope> {
    const children = this.curNode.children;
    if (!children || children.length === 0) {
      throw new Error(`[FlowChartBuilder] decider at '${this.curNode.name}' requires at least one branch`);
    }

    if (this.isScopeBased) {
      // Scope-based: mark node's fn as the decider, don't set nextNodeDecider.
      // The fn receives (scope, breakFn) and returns a branch ID string.
      // Pipeline/DeciderHandler will use the deciderFn flag to route to the
      // scope-based execution path.
      // _Requirements: decider-first-class-stage 5.1_
      this.curNode.deciderFn = true;
    } else {
      // Legacy: wrap decider with default handling, set nextNodeDecider
      const validIds = new Set(children.map((c) => c.id));
      const fallbackId = this.defaultId;

      this.curNode.nextNodeDecider = async (out?: TOut) => {
        const raw = this.originalDecider!(out);
        const id = raw instanceof Promise ? await raw : raw;
        if (id && validIds.has(id)) return id;
        if (fallbackId && validIds.has(fallbackId)) return fallbackId;
        return id;
      };
    }

    // Common: set branchIds and type on spec
    this.curSpec.branchIds = children
      .map((c) => c.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    // Set type to 'decider' now that we know it has branches
    this.curSpec.type = 'decider';

    return this.b;
  }
}


/* ============================================================================
 * SelectorList (simplified - no build callbacks)
 * ========================================================================== */

/**
 * Fluent helper returned by addSelector to add branches.
 * _Requirements: flowchart-builder-simplification 6.5_
 */
export class SelectorList<TOut = any, TScope = any> {
  private readonly b: FlowChartBuilder<TOut, TScope>;
  private readonly curNode: StageNode<TOut, TScope>;
  private readonly curSpec: SerializedPipelineStructure;
  private readonly originalSelector: Selector;
  private readonly branchIds = new Set<string>();

  constructor(
    builder: FlowChartBuilder<TOut, TScope>,
    curNode: StageNode<TOut, TScope>,
    curSpec: SerializedPipelineStructure,
    selector: Selector,
  ) {
    this.b = builder;
    this.curNode = curNode;
    this.curSpec = curSpec;
    this.originalSelector = selector;
  }

  /**
   * Add a simple function branch (no nested flowchart).
   */
  addFunctionBranch(
    id: string,
    name: string,
    fn?: PipelineStageFunction<TOut, TScope>,
    displayName?: string,
  ): SelectorList<TOut, TScope> {
    if (this.branchIds.has(id)) fail(`duplicate selector branch id '${id}' under '${this.curNode.name}'`);
    this.branchIds.add(id);

    // Create StageNode directly
    const node: StageNode<TOut, TScope> = { name: name ?? id };
    if (id) node.id = id;
    if (displayName) node.displayName = displayName;
    if (fn) {
      node.fn = fn;
      this.b._addToMap(name, fn);
    }

    // Create SerializedPipelineStructure with type='stage' and apply extractor
    let spec: SerializedPipelineStructure = { name: name ?? id, type: 'stage' };
    if (id) spec.id = id;
    if (displayName) spec.displayName = displayName;
    
    // Apply extractor immediately
    spec = this.b._applyExtractorToNode(spec);

    // Add to parent's children
    this.curNode.children = this.curNode.children || [];
    this.curNode.children.push(node);
    this.curSpec.children = this.curSpec.children || [];
    this.curSpec.children.push(spec);

    return this;
  }

  /**
   * Mount a prebuilt flowchart as a branch.
   * _Requirements: subflow-input-mapping 1.2, 1.5, 7.3_
   * 
   * IMPORTANT: This creates a WRAPPER node for the subflow mount point.
   * The subflow's internal structure is preserved in `subflowStructure` property,
   * NOT merged with the wrapper node. This ensures:
   * 1. The subflow's first stage keeps its original ID
   * 2. The mount point has its own distinct ID for navigation
   * 3. Drill-down can access the full subflow structure via `subflowStructure`
   * 
   * @param id - Unique identifier for the subflow mount point
   * @param subflow - The prebuilt FlowChart to mount
   * @param mountName - Optional display name for the mount point
   * @param options - Optional input/output mapping options for data flow between parent and subflow
   */
  addSubFlowChartBranch(
    id: string,
    subflow: FlowChart<TOut, TScope>,
    mountName?: string,
    options?: SubflowMountOptions,
  ): SelectorList<TOut, TScope> {
    if (this.branchIds.has(id)) fail(`duplicate selector branch id '${id}' under '${this.curNode.name}'`);
    this.branchIds.add(id);

    const displayName = mountName || id;

    // Register subflow definition
    if (!this.b._subflowDefs.has(id)) {
      this.b._subflowDefs.set(id, { root: subflow.root });
    }

    // Create reference StageNode
    const node: StageNode<TOut, TScope> = {
      name: displayName,
      id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName: displayName,
    };

    // Store subflowMountOptions if provided
    if (options) {
      node.subflowMountOptions = options;
    }

    // Create a WRAPPER spec for the subflow mount point.
    // CRITICAL: We do NOT spread subflow.buildTimeStructure here!
    // Instead, we store the subflow's structure in `subflowStructure` property.
    // This preserves the subflow's first stage ID and creates a clear boundary.
    const spec: SerializedPipelineStructure = {
      name: displayName,
      type: 'stage',
      id,
      displayName,
      isSubflowRoot: true,
      subflowId: id,
      subflowName: displayName,
      // Store the COMPLETE subflow structure for drill-down visualization
      subflowStructure: subflow.buildTimeStructure,
    };

    // Add to parent's children
    this.curNode.children = this.curNode.children || [];
    this.curNode.children.push(node);
    this.curSpec.children = this.curSpec.children || [];
    this.curSpec.children.push(spec);

    // Merge stage maps
    this.b._mergeStageMap(subflow.stageMap);

    // Merge nested subflows
    if (subflow.subflows) {
      for (const [key, def] of Object.entries(subflow.subflows)) {
        if (!this.b._subflowDefs.has(key)) {
          this.b._subflowDefs.set(key, def);
        }
      }
    }

    return this;
  }

  /**
   * Add multiple simple branches.
   */
  addBranchList(
    branches: Array<{
      id: string;
      name: string;
      fn?: PipelineStageFunction<TOut, TScope>;
      displayName?: string;
    }>,
  ): SelectorList<TOut, TScope> {
    for (const { id, name, fn, displayName } of branches) {
      this.addFunctionBranch(id, name, fn, displayName);
    }
    return this;
  }

  /**
   * Finalize the selector and return to main builder.
   */
  end(): FlowChartBuilder<TOut, TScope> {
    const children = this.curNode.children;
    if (!children || children.length === 0) {
      throw new Error(`[FlowChartBuilder] selector at '${this.curNode.name}' requires at least one branch`);
    }

    // Store selector directly
    this.curNode.nextNodeSelector = this.originalSelector;

    // Update branch IDs in spec
    this.curSpec.branchIds = children
      .map((c) => c.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    // Set type to 'decider' now that we know it has branches
    this.curSpec.type = 'decider';

    return this.b;
  }
}


/* ============================================================================
 * FlowChartBuilder (simplified)
 * ========================================================================== */

/**
 * Simplified FlowChartBuilder that builds StageNode and SerializedPipelineStructure directly.
 * 
 * Key differences from original:
 * - No _N intermediate class
 * - No parent pointer on nodes
 * - No end() for navigation (only DeciderList.end() and SelectorList.end())
 * - No into() method
 * - No _spawnAt() method
 * - No build callbacks in addFunctionBranch, addListOfFunction, etc.
 * - Builds SerializedPipelineStructure directly with type field (incremental type computation)
 * - Applies buildTimeExtractor immediately when nodes are created (not at build time)
 * 
 * _Requirements: flowchart-builder-simplification 1.1, 3.1, 3.2, 3.3, 3.4_
 * _Requirements: incremental-type-computation 1.1, 2.1, 2.2, 3.1, 3.2_
 */
export class FlowChartBuilder<TOut = any, TScope = any> {
  // Root node (StageNode) - built incrementally
  private _root?: StageNode<TOut, TScope>;
  
  // Root spec (SerializedPipelineStructure) - built incrementally with type field
  private _rootSpec?: SerializedPipelineStructure;
  
  // Current cursor for linear chaining
  private _cursor?: StageNode<TOut, TScope>;
  private _cursorSpec?: SerializedPipelineStructure;
  
  // Stage function registry
  private _stageMap = new Map<string, PipelineStageFunction<TOut, TScope>>();
  
  // Subflow definitions (for reference-based mounting)
  _subflowDefs = new Map<string, { root: StageNode<TOut, TScope> }>();
  
  // Stream handlers
  private _streamHandlers: StreamHandlers = {};
  
  // Extractors
  private _extractor?: TraversalExtractor;
  private _buildTimeExtractor?: BuildTimeExtractor<any>;
  private _buildTimeExtractorErrors: Array<{ message: string; error: unknown }> = [];

  /**
   * Whether narrative generation is enabled at build time.
   *
   * WHY: Stored as a field so setEnableNarrative() or execute(opts) can set it
   * before build() is called. build() includes it in the FlowChart object.
   *
   * _Requirements: pipeline-narrative-generation 1.4_
   */
  private _enableNarrative = false;

  /**
   * Enable narrative generation at build time.
   *
   * WHY: Allows consumers to opt into narrative via the builder API,
   * so the resulting FlowChart carries the flag and FlowChartExecutor
   * respects it as a default without requiring an explicit
   * enableNarrative() call on the executor.
   *
   * DESIGN: Fluent API — returns `this` for chaining.
   *
   * @returns this builder for chaining
   *
   * @example
   * ```typescript
   * const chart = flowChart('entry', entryFn)
   *   .addFunction('process', processFn)
   *   .setEnableNarrative()
   *   .build();
   * // chart.enableNarrative === true
   * ```
   *
   * _Requirements: pipeline-narrative-generation 1.4_
   */
  setEnableNarrative(): this {
    this._enableNarrative = true;
    return this;
  }

  /**
   * Create a new FlowChartBuilder.
   * @param buildTimeExtractor Optional extractor to apply to each node as it's created.
   *                           Pass this in the constructor to ensure it's applied to ALL nodes.
   * _Requirements: incremental-type-computation 3.2_
   */
  constructor(buildTimeExtractor?: BuildTimeExtractor<any>) {
    if (buildTimeExtractor) {
      this._buildTimeExtractor = buildTimeExtractor;
    }
  }

  /* ─────────────────────────── Linear Chaining API ─────────────────────────── */

  /**
   * Define the root function of the flow.
   * _Requirements: flowchart-builder-simplification 4.1, 5.1_
   * _Requirements: incremental-type-computation 1.1_
   */
  start(
    name: string,
    fn?: PipelineStageFunction<TOut, TScope>,
    id?: string,
    displayName?: string,
  ): this {
    if (this._root) fail('root already defined; create a new builder');

    // Create StageNode directly
    const node: StageNode<TOut, TScope> = { name };
    if (id) node.id = id;
    if (displayName) node.displayName = displayName;
    if (fn) {
      node.fn = fn;
      this._addToMap(name, fn);
    }

    // Create SerializedPipelineStructure with type='stage' and apply extractor
    let spec: SerializedPipelineStructure = { name, type: 'stage' };
    if (id) spec.id = id;
    if (displayName) spec.displayName = displayName;
    
    // Apply extractor immediately
    spec = this._applyExtractorToNode(spec);

    this._root = node;
    this._rootSpec = spec;
    this._cursor = node;
    this._cursorSpec = spec;

    return this;
  }

  /**
   * Append a linear "next" function and move to it.
   * _Requirements: flowchart-builder-simplification 4.2, 5.2_
   * _Requirements: incremental-type-computation 1.2_
   */
  addFunction(
    name: string,
    fn?: PipelineStageFunction<TOut, TScope>,
    id?: string,
    displayName?: string,
  ): this {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();

    // Create StageNode directly
    const node: StageNode<TOut, TScope> = { name };
    if (id) node.id = id;
    if (displayName) node.displayName = displayName;
    if (fn) {
      node.fn = fn;
      this._addToMap(name, fn);
    }

    // Create SerializedPipelineStructure with type='stage' and apply extractor
    let spec: SerializedPipelineStructure = { name, type: 'stage' };
    if (id) spec.id = id;
    if (displayName) spec.displayName = displayName;
    
    // Apply extractor immediately
    spec = this._applyExtractorToNode(spec);

    // Link to current node
    cur.next = node;
    curSpec.next = spec;

    // Move cursor
    this._cursor = node;
    this._cursorSpec = spec;

    return this;
  }

  /**
   * Add a streaming function.
   * _Requirements: flowchart-builder-simplification 5.3_
   * _Requirements: incremental-type-computation 1.3_
   */
  addStreamingFunction(
    name: string,
    streamId?: string,
    fn?: PipelineStageFunction<TOut, TScope>,
    id?: string,
    displayName?: string,
  ): this {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();

    // Create StageNode directly with streaming properties
    const node: StageNode<TOut, TScope> = {
      name,
      isStreaming: true,
      streamId: streamId ?? name,
    };
    if (id) node.id = id;
    if (displayName) node.displayName = displayName;
    if (fn) {
      node.fn = fn;
      this._addToMap(name, fn);
    }

    // Create SerializedPipelineStructure with type='streaming' and apply extractor
    let spec: SerializedPipelineStructure = {
      name,
      type: 'streaming',
      isStreaming: true,
      streamId: streamId ?? name,
    };
    if (id) spec.id = id;
    if (displayName) spec.displayName = displayName;
    
    // Apply extractor immediately
    spec = this._applyExtractorToNode(spec);

    // Link to current node
    cur.next = node;
    curSpec.next = spec;

    // Move cursor
    this._cursor = node;
    this._cursorSpec = spec;

    return this;
  }

  /* ─────────────────────────── Branching API ─────────────────────────── */

  /**
   * Add a legacy output-based decider — returns DeciderList for adding branches.
   *
   * WHY: This is the original decider API where the decider function receives
   * the previous stage's output and returns a branch ID. Kept for backward
   * compatibility with existing consumers.
   *
   * @deprecated Use {@link addDeciderFunction} instead. The new API makes the decider
   * a first-class stage function that reads from scope, providing better decoupling,
   * debug visibility, and alignment with modern state-based routing patterns.
   *
   * _Requirements: flowchart-builder-simplification 6.1_
   * _Requirements: incremental-type-computation 1.4_
   * _Requirements: decider-first-class-stage 4.1, 4.2_
   */
  addDecider(
    decider: (out?: TOut) => string | Promise<string>,
  ): DeciderList<TOut, TScope> {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();

    if (cur.nextNodeDecider) fail(`decider already defined at '${cur.name}'`);
    if (cur.deciderFn) fail(`decider already defined at '${cur.name}'`);
    if (cur.nextNodeSelector) fail(`decider and selector are mutually exclusive at '${cur.name}'`);

    // Mark as decider in spec (type will be set to 'decider' in DeciderList.end())
    curSpec.hasDecider = true;

    return new DeciderList<TOut, TScope>(this, cur, curSpec, decider, false);
  }

  /**
   * Add a scope-based decider function — returns DeciderList for adding branches.
   *
   * WHY: Makes the decider a first-class stage function that reads from scope
   * (shared state) instead of the previous stage's output. This decouples the
   * decider from the preceding stage's return type, provides debug visibility
   * (step number, extractor call, snapshot), and aligns with how LangGraph
   * reads from state and Airflow reads from XCom.
   *
   * DESIGN: The decider function IS the stage function — its return value (a string)
   * is the branch ID. No separate decider invocation step. The function is registered
   * in the stageMap like any other stage, and `deciderFn = true` on the StageNode
   * tells Pipeline to interpret the return value as a branch ID.
   *
   * @param name - Stage name for the decider node
   * @param fn - Stage function that receives (scope, breakFn) and returns a branch ID string
   * @param id - Optional stable ID for the node (for debug UI, time-travel, etc.)
   * @param displayName - Optional display name for UI visualization
   * @returns DeciderList for fluent branch configuration
   *
   * @example
   * ```typescript
   * flowChart('entry', entryFn)
   *   .addDeciderFunction('RouteDecider', async (scope) => {
   *     const type = scope.get('type');
   *     return type === 'express' ? 'express-branch' : 'standard-branch';
   *   }, 'route-decider')
   *     .addFunctionBranch('express-branch', 'Express', expressFn)
   *     .addFunctionBranch('standard-branch', 'Standard', standardFn)
   *   .end()
   *   .build();
   * ```
   *
   * _Requirements: decider-first-class-stage 1.1, 1.2, 1.3, 1.4, 1.5, 6.1_
   */
  addDeciderFunction(
    name: string,
    fn: PipelineStageFunction<TOut, TScope>,
    id?: string,
    displayName?: string,
  ): DeciderList<TOut, TScope> {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();

    if (cur.nextNodeDecider) fail(`decider already defined at '${cur.name}'`);
    if (cur.deciderFn) fail(`decider already defined at '${cur.name}'`);
    if (cur.nextNodeSelector) fail(`decider and selector are mutually exclusive at '${cur.name}'`);

    // Create StageNode with the decider function as the stage function
    const node: StageNode<TOut, TScope> = { name };
    if (id) node.id = id;
    if (displayName) node.displayName = displayName;
    node.fn = fn;

    // Register fn in stageMap so Pipeline can resolve it during execution
    // _Requirements: decider-first-class-stage 1.3_
    this._addToMap(name, fn);

    // Create SerializedPipelineStructure with hasDecider: true
    // Type will be set to 'decider' in DeciderList.end()
    // _Requirements: decider-first-class-stage 6.1_
    let spec: SerializedPipelineStructure = { name, type: 'stage', hasDecider: true };
    if (id) spec.id = id;
    if (displayName) spec.displayName = displayName;

    // Apply build-time extractor to the node
    // _Requirements: decider-first-class-stage 6.3_
    spec = this._applyExtractorToNode(spec);

    // Link to current node as next
    cur.next = node;
    curSpec.next = spec;

    // Move cursor to the new decider node
    this._cursor = node;
    this._cursorSpec = spec;

    // Return DeciderList with isScopeBased = true and decider = null
    // (no legacy decider function — the fn IS the decider)
    // _Requirements: decider-first-class-stage 1.2_
    return new DeciderList<TOut, TScope>(this, node, spec, null, true);
  }

  /**
   * Add a selector - returns SelectorList for adding branches.
   * _Requirements: flowchart-builder-simplification 6.5_
   * _Requirements: incremental-type-computation 1.5_
   */
  addSelector(selector: Selector): SelectorList<TOut, TScope> {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();

    if (cur.nextNodeSelector) fail(`selector already defined at '${cur.name}'`);
    if (cur.nextNodeDecider) fail(`decider and selector are mutually exclusive at '${cur.name}'`);

    // Mark as selector in spec (type will be set to 'decider' in SelectorList.end())
    curSpec.hasSelector = true;

    return new SelectorList<TOut, TScope>(this, cur, curSpec, selector);
  }


  /* ─────────────────────────── Subflow Mounting API ─────────────────────────── */

  /**
   * Mount a prebuilt flowchart as a child (fork pattern).
   * _Requirements: flowchart-builder-simplification 5.4_
   * _Requirements: incremental-type-computation 1.7, 4.1_
   * _Requirements: subflow-input-mapping 1.1, 1.5, 7.3_
   * 
   * IMPORTANT: This creates a WRAPPER node for the subflow mount point.
   * The subflow's internal structure is preserved in `subflowStructure` property,
   * NOT merged with the wrapper node. This ensures:
   * 1. The subflow's first stage keeps its original ID
   * 2. The mount point has its own distinct ID for navigation
   * 3. Drill-down can access the full subflow structure via `subflowStructure`
   * 
   * @param id - Unique identifier for the subflow mount point
   * @param subflow - The prebuilt FlowChart to mount
   * @param mountName - Optional display name for the mount point
   * @param options - Optional input/output mapping options for data flow between parent and subflow
   */
  addSubFlowChart(
    id: string,
    subflow: FlowChart<TOut, TScope>,
    mountName?: string,
    options?: SubflowMountOptions,
  ): this {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();

    if (cur.children?.some((c) => c.id === id)) {
      fail(`duplicate child id '${id}' under '${cur.name}'`);
    }

    const displayName = mountName || id;
    const forkId = cur.id ?? cur.name;

    // Register subflow definition
    if (!this._subflowDefs.has(id)) {
      this._subflowDefs.set(id, { root: subflow.root });
    }

    // Create reference StageNode
    const node: StageNode<TOut, TScope> = {
      name: displayName,
      id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName: displayName,
    };

    // Store subflowMountOptions if provided
    if (options) {
      node.subflowMountOptions = options;
    }

    // Create a WRAPPER spec for the subflow mount point.
    // CRITICAL: We do NOT spread subflow.buildTimeStructure here!
    // Instead, we store the subflow's structure in `subflowStructure` property.
    // This preserves the subflow's first stage ID and creates a clear boundary.
    let spec: SerializedPipelineStructure = {
      name: displayName,
      type: 'stage',
      id,
      displayName,
      isSubflowRoot: true,
      subflowId: id,
      subflowName: displayName,
      isParallelChild: true,
      parallelGroupId: forkId,
      // Store the COMPLETE subflow structure for drill-down visualization
      subflowStructure: subflow.buildTimeStructure,
    };
    
    // Apply extractor to the reference spec
    spec = this._applyExtractorToNode(spec);

    // Set parent type to 'fork' since it has children
    curSpec.type = 'fork';

    // Add to parent's children
    cur.children = cur.children || [];
    cur.children.push(node);
    curSpec.children = curSpec.children || [];
    curSpec.children.push(spec);

    // Merge stage maps
    this._mergeStageMap(subflow.stageMap);

    // Merge nested subflows
    if (subflow.subflows) {
      for (const [key, def] of Object.entries(subflow.subflows)) {
        if (!this._subflowDefs.has(key)) {
          this._subflowDefs.set(key, def);
        }
      }
    }

    return this;
  }

  /**
   * Mount a prebuilt flowchart as next (linear continuation).
   * _Requirements: flowchart-builder-simplification 5.5_
   * _Requirements: incremental-type-computation 4.4_
   * _Requirements: subflow-input-mapping 1.3, 1.5, 7.3_
   * 
   * IMPORTANT: This creates a WRAPPER node for the subflow mount point.
   * The subflow's internal structure is preserved in `subflowStructure` property,
   * NOT merged with the wrapper node. This ensures:
   * 1. The subflow's first stage keeps its original ID
   * 2. The mount point has its own distinct ID for navigation
   * 3. Drill-down can access the full subflow structure via `subflowStructure`
   * 
   * @param id - Unique identifier for the subflow mount point
   * @param subflow - The prebuilt FlowChart to mount
   * @param mountName - Optional display name for the mount point
   * @param options - Optional input/output mapping options for data flow between parent and subflow
   */
  addSubFlowChartNext(
    id: string,
    subflow: FlowChart<TOut, TScope>,
    mountName?: string,
    options?: SubflowMountOptions,
  ): this {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();

    if (cur.next) {
      fail(`cannot add subflow as next when next is already defined at '${cur.name}'`);
    }

    const displayName = mountName || id;

    // Register subflow definition
    if (!this._subflowDefs.has(id)) {
      this._subflowDefs.set(id, { root: subflow.root });
    }

    // Create reference StageNode
    const node: StageNode<TOut, TScope> = {
      name: displayName,
      id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName: displayName,
    };

    // Store subflowMountOptions if provided
    if (options) {
      node.subflowMountOptions = options;
    }

    // Create a WRAPPER spec for the subflow mount point.
    // CRITICAL: We do NOT spread subflow.buildTimeStructure here!
    // Instead, we store the subflow's structure in `subflowStructure` property.
    // This preserves the subflow's first stage ID and creates a clear boundary.
    let attachedSpec: SerializedPipelineStructure = {
      name: displayName,
      type: 'stage',
      id,
      displayName,
      isSubflowRoot: true,
      subflowId: id,
      subflowName: displayName,
      // Store the COMPLETE subflow structure for drill-down visualization
      subflowStructure: subflow.buildTimeStructure,
    };
    
    // Apply extractor to the attached spec
    attachedSpec = this._applyExtractorToNode(attachedSpec);

    // Set as next (linear continuation)
    cur.next = node;
    curSpec.next = attachedSpec;

    // Move cursor to the reference node AND the attached spec.
    // IMPORTANT: We use the SAME attachedSpec object for the cursor so that
    // subsequent addFunction calls will correctly set attachedSpec.next,
    // which is what appears in buildTimeStructure.
    this._cursor = node;
    this._cursorSpec = attachedSpec;

    // Merge stage maps
    this._mergeStageMap(subflow.stageMap);

    // Merge nested subflows
    if (subflow.subflows) {
      for (const [key, def] of Object.entries(subflow.subflows)) {
        if (!this._subflowDefs.has(key)) {
          this._subflowDefs.set(key, def);
        }
      }
    }

    return this;
  }

  /**
   * Add parallel children (fork) - simplified, no build callbacks.
   * _Requirements: flowchart-builder-simplification 2.2_
   * _Requirements: incremental-type-computation 1.6_
   */
  addListOfFunction(children: SimplifiedParallelSpec<TOut, TScope>[]): this {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();
    const forkId = cur.id ?? cur.name;

    // Set parent type to 'fork' since it has children
    curSpec.type = 'fork';

    for (const { id, name, displayName, fn } of children) {
      if (!id) fail(`child id required under '${cur.name}'`);
      if (cur.children?.some((c) => c.id === id)) {
        fail(`duplicate child id '${id}' under '${cur.name}'`);
      }

      // Create StageNode directly
      const node: StageNode<TOut, TScope> = { name: name ?? id };
      if (id) node.id = id;
      if (displayName) node.displayName = displayName;
      if (fn) {
        node.fn = fn;
        this._addToMap(name, fn);
      }

      // Create SerializedPipelineStructure with type='stage' and apply extractor
      let spec: SerializedPipelineStructure = {
        name: name ?? id,
        type: 'stage',
        isParallelChild: true,
        parallelGroupId: forkId,
      };
      if (id) spec.id = id;
      if (displayName) spec.displayName = displayName;
      
      // Apply extractor immediately
      spec = this._applyExtractorToNode(spec);

      // Add to parent's children
      cur.children = cur.children || [];
      cur.children.push(node);
      curSpec.children = curSpec.children || [];
      curSpec.children.push(spec);
    }

    return this;
  }

  /* ─────────────────────────── Loop API ─────────────────────────── */

  /**
   * Set a loop target for the current node.
   * _Requirements: flowchart-builder-simplification 5.6_
   * _Requirements: incremental-type-computation 6.1_
   */
  loopTo(stageId: string): this {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();

    if (curSpec.loopTarget) fail(`loopTo already defined at '${cur.name}'`);
    if (cur.next) fail(`cannot set loopTo when next is already defined at '${cur.name}'`);

    // Set loop target in both structures with type='stage'
    cur.next = { name: stageId, id: stageId };
    curSpec.loopTarget = stageId;
    curSpec.next = { name: stageId, id: stageId, type: 'stage' };

    return this;
  }


  /* ─────────────────────────── Streaming API ─────────────────────────── */

  onStream(handler: StreamTokenHandler): this {
    this._streamHandlers.onToken = handler;
    return this;
  }

  onStreamStart(handler: StreamLifecycleHandler): this {
    this._streamHandlers.onStart = handler;
    return this;
  }

  onStreamEnd(handler: StreamLifecycleHandler): this {
    this._streamHandlers.onEnd = handler;
    return this;
  }

  /* ─────────────────────────── Extractor API ─────────────────────────── */

  addTraversalExtractor<TResult = unknown>(
    extractor: TraversalExtractor<TResult>,
  ): this {
    this._extractor = extractor;
    return this;
  }

  addBuildTimeExtractor<TResult = FlowChartSpec>(
    extractor: BuildTimeExtractor<TResult>,
  ): this {
    this._buildTimeExtractor = extractor;
    return this;
  }

  getBuildTimeExtractorErrors(): Array<{ message: string; error: unknown }> {
    return this._buildTimeExtractorErrors;
  }

  /* ─────────────────────────── Output API ─────────────────────────── */

  /**
   * Compile to FlowChart (returns pre-built structures).
   * _Requirements: flowchart-builder-simplification 4.4, 5.7_
   * _Requirements: incremental-type-computation 3.1, 3.3, 3.4_
   */
  build(): FlowChart<TOut, TScope> {
    const root = this._root ?? fail('empty tree; call start() first');
    const rootSpec = this._rootSpec ?? fail('empty spec; call start() first');

    // Convert subflow defs map to plain object
    const subflows: Record<string, { root: StageNode<TOut, TScope> }> = {};
    for (const [key, def] of this._subflowDefs) {
      subflows[key] = def;
    }

    // Return _rootSpec directly - O(1) instead of O(n)
    // Type computation and extractor application already done incrementally
    return {
      root,
      stageMap: this._stageMap,
      extractor: this._extractor,
      buildTimeStructure: rootSpec,
      ...(Object.keys(subflows).length > 0 ? { subflows } : {}),
      ...(this._enableNarrative ? { enableNarrative: true } : {}),
    };
  }

  /**
   * Emit pure JSON spec (returns pre-built structure).
   * _Requirements: flowchart-builder-simplification 4.5_
   * _Requirements: incremental-type-computation 3.1_
   */
  toSpec<TResult = SerializedPipelineStructure>(): TResult {
    const rootSpec = this._rootSpec ?? fail('empty tree; call start() first');
    // Return _rootSpec directly - type computation and extractor already applied incrementally
    return rootSpec as TResult;
  }

  /**
   * Convenience: build & execute.
   */
  async execute(scopeFactory: ScopeFactory<TScope>, opts?: ExecOptions): Promise<any> {
    // Set narrative flag before build() so it's included in the FlowChart object.
    // WHY: execute() is a convenience that combines build + run. When the consumer
    // passes enableNarrative in opts, we need to set the builder field before
    // build() serializes it into the FlowChart.
    // _Requirements: pipeline-narrative-generation 1.4_
    if (opts?.enableNarrative) {
      this._enableNarrative = true;
    }
    const flowChart = this.build();
    const executor = new FlowChartExecutor<TOut, TScope>(
      flowChart,
      scopeFactory,
      opts?.defaults,
      opts?.initial,
      opts?.readOnly,
      opts?.throttlingErrorChecker,
      this._streamHandlers,
      opts?.scopeProtectionMode,
    );
    return await executor.run();
  }

  /**
   * Mermaid diagram generator.
   */
  toMermaid(): string {
    const lines: string[] = ['flowchart TD'];
    const idOf = (k: string) => (k || '').replace(/[^a-zA-Z0-9_]/g, '_') || '_';
    const root = this._root ?? fail('empty tree; call start() first');

    const walk = (n: StageNode<TOut, TScope>) => {
      const nid = idOf(n.id ?? n.name);
      lines.push(`${nid}["${n.name}"]`);
      for (const c of n.children || []) {
        const cid = idOf(c.id ?? c.name);
        lines.push(`${nid} --> ${cid}`);
        walk(c);
      }
      if (n.next) {
        const mid = idOf(n.next.id ?? n.next.name);
        lines.push(`${nid} --> ${mid}`);
        walk(n.next);
      }
    };
    walk(root);
    return lines.join('\n');
  }

  /* ─────────────────────────── Internals ─────────────────────────── */

  private _needCursor(): StageNode<TOut, TScope> {
    return this._cursor ?? fail('cursor undefined; call start() first');
  }

  private _needCursorSpec(): SerializedPipelineStructure {
    return this._cursorSpec ?? fail('cursor undefined; call start() first');
  }

  /**
   * Apply build-time extractor to a single node immediately.
   * If no extractor registered, returns spec as-is.
   * _Requirements: incremental-type-computation 3.2_
   */
  _applyExtractorToNode(spec: SerializedPipelineStructure): SerializedPipelineStructure {
    if (!this._buildTimeExtractor) {
      return spec;
    }
    try {
      return this._buildTimeExtractor(spec as any) as SerializedPipelineStructure;
    } catch (error: any) {
      console.error('[FlowChartBuilder] Build-time extractor error:', error);
      this._buildTimeExtractorErrors.push({
        message: error?.message ?? String(error),
        error,
      });
      return spec;
    }
  }

  /** Add a function to the shared stageMap; fail on conflicting names. */
  _addToMap(name: string, fn: PipelineStageFunction<TOut, TScope>) {
    if (this._stageMap.has(name)) {
      const existing = this._stageMap.get(name);
      if (existing !== fn) fail(`stageMap collision for '${name}'`);
    }
    this._stageMap.set(name, fn);
  }

  /** Merge another flow's stageMap; throw on name collisions. */
  _mergeStageMap(other: Map<string, PipelineStageFunction<TOut, TScope>>) {
    for (const [k, v] of other) {
      if (this._stageMap.has(k)) {
        const existing = this._stageMap.get(k);
        if (existing !== v) fail(`stageMap collision while mounting flowchart at '${k}'`);
      } else {
        this._stageMap.set(k, v);
      }
    }
  }
}


/* ============================================================================
 * Factory Function
 * ========================================================================== */

/**
 * Convenience factory to create a FlowChartBuilder with start() already called.
 * Recommended way to create flows.
 * 
 * _Requirements: flowchart-builder-simplification 7.1_
 * _Requirements: incremental-type-computation 3.2_
 * 
 * @example
 * ```typescript
 * // Simple branch
 * const branchA = flowChart('handleA', handleAFn)
 *   .addFunction('stepA1', stepA1Fn)
 *   .build();
 * 
 * // Main flow with subflow branches
 * const main = flowChart('entry', entryFn)
 *   .addDecider(deciderFn)
 *     .addSubFlowChartBranch('branchA', branchA)
 *   .end()
 *   .build();
 * 
 * // With custom extractor (applied to all nodes)
 * const customExtractor = (node) => ({ ...node, custom: true });
 * const flow = flowChart('entry', entryFn, 'id', 'display', customExtractor)
 *   .addFunction('next', nextFn)
 *   .build();
 * ```
 */
export function flowChart<TOut = any, TScope = any>(
  name: string,
  fn?: PipelineStageFunction<TOut, TScope>,
  id?: string,
  displayName?: string,
  buildTimeExtractor?: BuildTimeExtractor<any>,
): FlowChartBuilder<TOut, TScope> {
  return new FlowChartBuilder<TOut, TScope>(buildTimeExtractor).start(name, fn, id, displayName);
}


/* ============================================================================
 * Spec to StageNode Converter
 * ========================================================================== */

/**
 * Convert a pure JSON FlowChartSpec to a StageNode tree.
 * Used by backends to reconstruct the tree from a spec received from frontend.
 * 
 * Note: nextNodeDecider is intentionally omitted - runtime uses your BE decider.
 */
export function specToStageNode(spec: FlowChartSpec): StageNode<any, any> {
  const inflate = (s: FlowChartSpec): StageNode<any, any> => ({
    name: s.name,
    id: s.id,
    children: s.children?.length ? s.children.map(inflate) : undefined,
    next: s.next ? inflate(s.next) : undefined,
  });
  return inflate(spec);
}

/* ============================================================================
 * Legacy Type Aliases (for backward compatibility)
 * ========================================================================== */

/**
 * @deprecated Use FlowChart instead. This alias exists for backward compatibility.
 */
export type BuiltFlow<TOut = any, TScope = any> = FlowChart<TOut, TScope>;

/**
 * A stage function (relaxed generics for builder ergonomics).
 */
export type StageFn = PipelineStageFunction<any, any>;

/**
 * Legacy ParallelSpec with build callback (for backward compatibility).
 * @deprecated Use SimplifiedParallelSpec instead.
 */
export type ParallelSpec<TOut = any, TScope = any> = SimplifiedParallelSpec<TOut, TScope> & {
  /** @deprecated Build callbacks are no longer supported. Use addSubFlowChartBranch instead. */
  build?: never;
};

/**
 * A branch body for deciders.
 * @deprecated Use addSubFlowChartBranch for nested flowcharts.
 */
export type BranchBody<TOut = any, TScope = any> =
  | { name?: string; fn?: PipelineStageFunction<TOut, TScope> }
  | ((b: FlowChartBuilder<TOut, TScope>) => void);

/**
 * Branch spec for deciders.
 * @deprecated Use addSubFlowChartBranch for nested flowcharts.
 */
export type BranchSpec<TOut = any, TScope = any> = Record<string, BranchBody<TOut, TScope>>;

/**
 * A reference node that points to a subflow definition.
 */
export interface SubflowRef {
  $ref: string;
  mountId: string;
  displayName?: string;
}
