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
  /** Human-readable description of what this stage does. */
  description?: string;
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
  /** Human-readable description of what this stage does. */
  description?: string;
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
  /** Human-readable description of what this stage does. */
  description?: string;
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
  /**
   * Number of times this node was executed in a loop.
   * Only present when the node was visited more than once.
   *
   * WHY: Enables the runtime pipeline structure to track loop iterations
   * so consumers can visualize how many times a looping node was executed
   * without needing external reconstruction from runtime data.
   */
  iterationCount?: number;
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
   */
  enableNarrative?: boolean;
  /** Pre-built execution context description string. Empty string when no descriptions provided. */
  description: string;
  /** Individual stage descriptions keyed by stage name. Empty map when no descriptions provided. */
  stageDescriptions: Map<string, string>;
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
   */
  private readonly isScopeBased: boolean;

  /* ── Description accumulator references ── */
  private readonly parentDescriptionParts: string[];
  private readonly parentStageDescriptions: Map<string, string>;
  private readonly reservedStepNumber: number;
  private readonly deciderDescription?: string;
  /** Collected branch info for description accumulation at end() */
  private readonly branchDescInfo: Array<{ id: string; displayName?: string; description?: string }> = [];

  constructor(
    builder: FlowChartBuilder<TOut, TScope>,
    curNode: StageNode<TOut, TScope>,
    curSpec: SerializedPipelineStructure,
    decider: ((out?: TOut) => string | Promise<string>) | null,
    isScopeBased: boolean = false,
    parentDescriptionParts: string[] = [],
    parentStageDescriptions: Map<string, string> = new Map(),
    reservedStepNumber: number = 0,
    deciderDescription?: string,
  ) {
    this.b = builder;
    this.curNode = curNode;
    this.curSpec = curSpec;
    this.originalDecider = decider;
    this.isScopeBased = isScopeBased;
    this.parentDescriptionParts = parentDescriptionParts;
    this.parentStageDescriptions = parentStageDescriptions;
    this.reservedStepNumber = reservedStepNumber;
    this.deciderDescription = deciderDescription;
  }

  /**
   * Add a simple function branch (no nested flowchart).
   * REMOVED: build callback parameter
   */
  addFunctionBranch(
    id: string,
    name: string,
    fn?: PipelineStageFunction<TOut, TScope>,
    displayName?: string,
    description?: string,
  ): DeciderList<TOut, TScope> {
    if (this.branchIds.has(id)) fail(`duplicate decider branch id '${id}' under '${this.curNode.name}'`);
    this.branchIds.add(id);

    // Create StageNode directly
    const node: StageNode<TOut, TScope> = { name: name ?? id };
    if (id) node.id = id;
    if (displayName) node.displayName = displayName;
    if (description) node.description = description;
    if (fn) {
      node.fn = fn;
      this.b._addToMap(name, fn);
    }

    // Create SerializedPipelineStructure with type='stage' and apply extractor
    let spec: SerializedPipelineStructure = { name: name ?? id, type: 'stage' };
    if (id) spec.id = id;
    if (displayName) spec.displayName = displayName;
    if (description) spec.description = description;
    
    // Apply extractor immediately
    spec = this.b._applyExtractorToNode(spec);

    // Add to parent's children
    this.curNode.children = this.curNode.children || [];
    this.curNode.children.push(node);
    this.curSpec.children = this.curSpec.children || [];
    this.curSpec.children.push(spec);

    // Track branch info for description accumulation at end()
    this.branchDescInfo.push({ id, displayName, description });

    return this;
  }

  /**
   * Mount a prebuilt flowchart as a branch.
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

    // Namespace the subflow's stage names with mount id to prevent collisions
    const prefixedRoot = (this.b as any)._prefixNodeTree(subflow.root, id);

    // Register subflow definition with prefixed root
    if (!this.b._subflowDefs.has(id)) {
      this.b._subflowDefs.set(id, { root: prefixedRoot });
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

    // Merge stage maps with namespace prefix
    this.b._mergeStageMap(subflow.stageMap, id);

    // Merge nested subflows with namespace prefix
    if (subflow.subflows) {
      for (const [key, def] of Object.entries(subflow.subflows)) {
        const prefixedKey = `${id}/${key}`;
        if (!this.b._subflowDefs.has(prefixedKey)) {
          this.b._subflowDefs.set(prefixedKey, {
            root: (this.b as any)._prefixNodeTree(
              def.root as StageNode<TOut, TScope>,
              id,
            ),
          });
        }
      }
    }

    return this;
  }

  /**
   * Add multiple simple branches.
   * REMOVED: build callback in branch spec
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

    // Accumulate description lines for the decider and its branches
    if (this.reservedStepNumber > 0) {
      const deciderLabel = this.curNode.displayName || this.curNode.name;
      const branchIdList = this.branchDescInfo.map((b) => b.id).join(', ');
      const mainLine = this.deciderDescription
        ? `${this.reservedStepNumber}. ${deciderLabel} — ${this.deciderDescription}`
        : `${this.reservedStepNumber}. ${deciderLabel} — Decides between: ${branchIdList}`;
      this.parentDescriptionParts.push(mainLine);

      if (this.deciderDescription) {
        this.parentStageDescriptions.set(this.curNode.name, this.deciderDescription);
      }

      // Append arrow lines for each branch
      for (const branch of this.branchDescInfo) {
        const branchText = branch.description || branch.displayName;
        if (branchText) {
          this.parentDescriptionParts.push(`   → ${branch.id}: ${branchText}`);
        }
        // Store individual branch descriptions
        if (branch.description) {
          this.parentStageDescriptions.set(branch.id, branch.description);
        }
      }
    }

    return this.b;
  }
}


/* ============================================================================
 * SelectorList (simplified - no build callbacks)
 * ========================================================================== */

/**
 * Fluent helper returned by addSelector to add branches.
 */
export class SelectorList<TOut = any, TScope = any> {
  private readonly b: FlowChartBuilder<TOut, TScope>;
  private readonly curNode: StageNode<TOut, TScope>;
  private readonly curSpec: SerializedPipelineStructure;
  private readonly originalSelector: Selector;
  private readonly branchIds = new Set<string>();

  /* ── Description accumulator references ── */
  private readonly parentDescriptionParts: string[];
  private readonly parentStageDescriptions: Map<string, string>;
  private readonly reservedStepNumber: number;
  /** Collected branch info for description accumulation at end() */
  private readonly branchDescInfo: Array<{ id: string; displayName?: string; description?: string }> = [];

  constructor(
    builder: FlowChartBuilder<TOut, TScope>,
    curNode: StageNode<TOut, TScope>,
    curSpec: SerializedPipelineStructure,
    selector: Selector,
    parentDescriptionParts: string[] = [],
    parentStageDescriptions: Map<string, string> = new Map(),
    reservedStepNumber: number = 0,
  ) {
    this.b = builder;
    this.curNode = curNode;
    this.curSpec = curSpec;
    this.originalSelector = selector;
    this.parentDescriptionParts = parentDescriptionParts;
    this.parentStageDescriptions = parentStageDescriptions;
    this.reservedStepNumber = reservedStepNumber;
  }

  /**
   * Add a simple function branch (no nested flowchart).
   */
  addFunctionBranch(
    id: string,
    name: string,
    fn?: PipelineStageFunction<TOut, TScope>,
    displayName?: string,
    description?: string,
  ): SelectorList<TOut, TScope> {
    if (this.branchIds.has(id)) fail(`duplicate selector branch id '${id}' under '${this.curNode.name}'`);
    this.branchIds.add(id);

    // Create StageNode directly
    const node: StageNode<TOut, TScope> = { name: name ?? id };
    if (id) node.id = id;
    if (displayName) node.displayName = displayName;
    if (description) node.description = description;
    if (fn) {
      node.fn = fn;
      this.b._addToMap(name, fn);
    }

    // Create SerializedPipelineStructure with type='stage' and apply extractor
    let spec: SerializedPipelineStructure = { name: name ?? id, type: 'stage' };
    if (id) spec.id = id;
    if (displayName) spec.displayName = displayName;
    if (description) spec.description = description;
    
    // Apply extractor immediately
    spec = this.b._applyExtractorToNode(spec);

    // Add to parent's children
    this.curNode.children = this.curNode.children || [];
    this.curNode.children.push(node);
    this.curSpec.children = this.curSpec.children || [];
    this.curSpec.children.push(spec);

    // Track branch info for description accumulation at end()
    this.branchDescInfo.push({ id, displayName, description });

    return this;
  }

  /**
   * Mount a prebuilt flowchart as a branch.
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

    // Namespace the subflow's stage names with mount id to prevent collisions
    const prefixedRoot = (this.b as any)._prefixNodeTree(subflow.root, id);

    // Register subflow definition with prefixed root
    if (!this.b._subflowDefs.has(id)) {
      this.b._subflowDefs.set(id, { root: prefixedRoot });
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

    // Merge stage maps with namespace prefix
    this.b._mergeStageMap(subflow.stageMap, id);

    // Merge nested subflows with namespace prefix
    if (subflow.subflows) {
      for (const [key, def] of Object.entries(subflow.subflows)) {
        const prefixedKey = `${id}/${key}`;
        if (!this.b._subflowDefs.has(prefixedKey)) {
          this.b._subflowDefs.set(prefixedKey, {
            root: (this.b as any)._prefixNodeTree(
              def.root as StageNode<TOut, TScope>,
              id,
            ),
          });
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

    // Accumulate description lines for the selector and its branches
    if (this.reservedStepNumber > 0) {
      const selectorLabel = this.curNode.displayName || this.curNode.name;
      const branchIdList = this.branchDescInfo.map((b) => b.id).join(', ');
      const mainLine = `${this.reservedStepNumber}. ${selectorLabel} — Selects from: ${branchIdList}`;
      this.parentDescriptionParts.push(mainLine);

      // Append arrow lines for each branch
      for (const branch of this.branchDescInfo) {
        const branchText = branch.description || branch.displayName;
        if (branchText) {
          this.parentDescriptionParts.push(`   → ${branch.id}: ${branchText}`);
        }
        // Store individual branch descriptions
        if (branch.description) {
          this.parentStageDescriptions.set(branch.id, branch.description);
        }
      }
    }

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
   */
  private _enableNarrative = false;

  /* ── Description accumulator fields ── */

  /** Accumulated description lines, built incrementally as stages are added. */
  private _descriptionParts: string[] = [];

  /** Current step number for description numbering. */
  private _stepCounter = 0;

  /** Map of stage name → individual description for UI tooltips. */
  private _stageDescriptions = new Map<string, string>();

  /** Map of stage name → step number for loopTo step-number lookup. */
  private _stageStepMap = new Map<string, number>();

  /**
   * Increment step counter, format a description line, and push to _descriptionParts.
   *
   * WHY: Centralizes the incremental description accumulation logic so every
   * builder method (start, addFunction, addStreamingFunction, etc.) uses the
   * same formatting and bookkeeping.
   *
   * @param displayName - The display name (falls back to name)
   * @param name - The stage name (used as key in maps)
   * @param description - Optional human-readable description
   */
  private _appendDescriptionLine(displayName: string, name: string, description?: string): void {
    this._stepCounter++;
    this._stageStepMap.set(name, this._stepCounter);
    const label = displayName || name;
    const line = description
      ? `${this._stepCounter}. ${label} — ${description}`
      : `${this._stepCounter}. ${label}`;
    this._descriptionParts.push(line);
    if (description) {
      this._stageDescriptions.set(name, description);
    }
  }

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
   */
  setEnableNarrative(): this {
    this._enableNarrative = true;
    return this;
  }

  /**
   * Create a new FlowChartBuilder.
   * @param buildTimeExtractor Optional extractor to apply to each node as it's created.
   *                           Pass this in the constructor to ensure it's applied to ALL nodes.
   */
  constructor(buildTimeExtractor?: BuildTimeExtractor<any>) {
    if (buildTimeExtractor) {
      this._buildTimeExtractor = buildTimeExtractor;
    }
  }

  /* ─────────────────────────── Linear Chaining API ─────────────────────────── */

  /**
   * Define the root function of the flow.
   */
  start(
    name: string,
    fn?: PipelineStageFunction<TOut, TScope>,
    id?: string,
    displayName?: string,
    description?: string,
  ): this {
    if (this._root) fail('root already defined; create a new builder');

    // Create StageNode directly
    const node: StageNode<TOut, TScope> = { name };
    if (id) node.id = id;
    if (displayName) node.displayName = displayName;
    if (description) node.description = description;
    if (fn) {
      node.fn = fn;
      this._addToMap(name, fn);
    }

    // Create SerializedPipelineStructure with type='stage' and apply extractor
    let spec: SerializedPipelineStructure = { name, type: 'stage' };
    if (id) spec.id = id;
    if (displayName) spec.displayName = displayName;
    if (description) spec.description = description;
    
    // Apply extractor immediately
    spec = this._applyExtractorToNode(spec);

    this._root = node;
    this._rootSpec = spec;
    this._cursor = node;
    this._cursorSpec = spec;

    // Accumulate description line
    this._appendDescriptionLine(displayName || name, name, description);

    return this;
  }

  /**
   * Append a linear "next" function and move to it.
   */
  addFunction(
    name: string,
    fn?: PipelineStageFunction<TOut, TScope>,
    id?: string,
    displayName?: string,
    description?: string,
  ): this {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();

    // Create StageNode directly
    const node: StageNode<TOut, TScope> = { name };
    if (id) node.id = id;
    if (displayName) node.displayName = displayName;
    if (description) node.description = description;
    if (fn) {
      node.fn = fn;
      this._addToMap(name, fn);
    }

    // Create SerializedPipelineStructure with type='stage' and apply extractor
    let spec: SerializedPipelineStructure = { name, type: 'stage' };
    if (id) spec.id = id;
    if (displayName) spec.displayName = displayName;
    if (description) spec.description = description;
    
    // Apply extractor immediately
    spec = this._applyExtractorToNode(spec);

    // Link to current node
    cur.next = node;
    curSpec.next = spec;

    // Move cursor
    this._cursor = node;
    this._cursorSpec = spec;

    // Accumulate description line
    this._appendDescriptionLine(displayName || name, name, description);

    return this;
  }

  /**
   * Add a streaming function.
   */
  addStreamingFunction(
    name: string,
    streamId?: string,
    fn?: PipelineStageFunction<TOut, TScope>,
    id?: string,
    displayName?: string,
    description?: string,
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
    if (description) node.description = description;
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
    if (description) spec.description = description;
    
    // Apply extractor immediately
    spec = this._applyExtractorToNode(spec);

    // Link to current node
    cur.next = node;
    curSpec.next = spec;

    // Move cursor
    this._cursor = node;
    this._cursorSpec = spec;

    // Accumulate description line
    this._appendDescriptionLine(displayName || name, name, description);

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

    // Reserve a step number for the decider — the full description line
    // (including branch names) is deferred to DeciderList.end()
    this._stepCounter++;
    this._stageStepMap.set(cur.name, this._stepCounter);

    return new DeciderList<TOut, TScope>(
      this, cur, curSpec, decider, false,
      this._descriptionParts, this._stageDescriptions, this._stepCounter,
    );
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
   */
  addDeciderFunction(
    name: string,
    fn: PipelineStageFunction<TOut, TScope>,
    id?: string,
    displayName?: string,
    description?: string,
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
    if (description) node.description = description;
    node.fn = fn;

    // Register fn in stageMap so Pipeline can resolve it during execution
    this._addToMap(name, fn);

    // Create SerializedPipelineStructure with hasDecider: true
    // Type will be set to 'decider' in DeciderList.end()
    let spec: SerializedPipelineStructure = { name, type: 'stage', hasDecider: true };
    if (id) spec.id = id;
    if (displayName) spec.displayName = displayName;
    if (description) spec.description = description;

    // Apply build-time extractor to the node
    spec = this._applyExtractorToNode(spec);

    // Link to current node as next
    cur.next = node;
    curSpec.next = spec;

    // Move cursor to the new decider node
    this._cursor = node;
    this._cursorSpec = spec;

    // Reserve a step number for the decider — the full description line
    // (including branch names) is deferred to DeciderList.end()
    this._stepCounter++;
    this._stageStepMap.set(name, this._stepCounter);

    // Return DeciderList with isScopeBased = true and decider = null
    // (no legacy decider function — the fn IS the decider)
    // Pass reserved step number and description accumulator references
    return new DeciderList<TOut, TScope>(
      this, node, spec, null, true,
      this._descriptionParts, this._stageDescriptions, this._stepCounter, description,
    );
  }

  /**
   * Add a selector - returns SelectorList for adding branches.
   */
  addSelector(selector: Selector): SelectorList<TOut, TScope> {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();

    if (cur.nextNodeSelector) fail(`selector already defined at '${cur.name}'`);
    if (cur.nextNodeDecider) fail(`decider and selector are mutually exclusive at '${cur.name}'`);

    // Mark as selector in spec (type will be set to 'decider' in SelectorList.end())
    curSpec.hasSelector = true;

    // Reserve a step number for the selector — the full description line
    // (including branch names) is deferred to SelectorList.end()
    this._stepCounter++;
    this._stageStepMap.set(cur.name, this._stepCounter);

    return new SelectorList<TOut, TScope>(
      this, cur, curSpec, selector,
      this._descriptionParts, this._stageDescriptions, this._stepCounter,
    );
  }


  /* ─────────────────────────── Subflow Mounting API ─────────────────────────── */

  /**
   * Mount a prebuilt flowchart as a child (fork pattern).
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

    // Namespace the subflow's stage names with mount id to prevent
    // collisions when multiple subflows share the same stage names
    // (e.g., two SimpleAgents both having "SeedScope").
    const prefixedRoot = this._prefixNodeTree(subflow.root, id);

    // Register subflow definition with prefixed root
    if (!this._subflowDefs.has(id)) {
      this._subflowDefs.set(id, { root: prefixedRoot });
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

    // Merge stage maps with namespace prefix
    this._mergeStageMap(subflow.stageMap, id);

    // Merge nested subflows with namespace prefix
    if (subflow.subflows) {
      for (const [key, def] of Object.entries(subflow.subflows)) {
        const prefixedKey = `${id}/${key}`;
        if (!this._subflowDefs.has(prefixedKey)) {
          this._subflowDefs.set(prefixedKey, {
            root: this._prefixNodeTree(
              def.root as StageNode<TOut, TScope>,
              id,
            ),
          });
        }
      }
    }

    // Accumulate subflow description line
    this._appendSubflowDescription(id, displayName, subflow);

    return this;
  }

  /**
   * Mount a prebuilt flowchart as next (linear continuation).
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

    // Namespace the subflow's stage names with mount id to prevent
    // collisions when multiple subflows share the same stage names.
    const prefixedRoot = this._prefixNodeTree(subflow.root, id);

    // Register subflow definition with prefixed root
    if (!this._subflowDefs.has(id)) {
      this._subflowDefs.set(id, { root: prefixedRoot });
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

    // Merge stage maps with namespace prefix
    this._mergeStageMap(subflow.stageMap, id);

    // Merge nested subflows with namespace prefix
    if (subflow.subflows) {
      for (const [key, def] of Object.entries(subflow.subflows)) {
        const prefixedKey = `${id}/${key}`;
        if (!this._subflowDefs.has(prefixedKey)) {
          this._subflowDefs.set(prefixedKey, {
            root: this._prefixNodeTree(
              def.root as StageNode<TOut, TScope>,
              id,
            ),
          });
        }
      }
    }

    // Accumulate subflow description line
    this._appendSubflowDescription(id, displayName, subflow);

    return this;
  }

  /**
   * Add parallel children (fork) - simplified, no build callbacks.
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

    // Accumulate parallel description line
    const childNames = children.map((c) => c.displayName || c.name || c.id).join(', ');
    this._stepCounter++;
    this._descriptionParts.push(`${this._stepCounter}. Runs in parallel: ${childNames}`);

    return this;
  }

  /* ─────────────────────────── Loop API ─────────────────────────── */

  /**
   * Set a loop target for the current node.
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

    // Accumulate loop-back description line
    const targetStep = this._stageStepMap.get(stageId);
    if (targetStep !== undefined) {
      this._descriptionParts.push(`→ loops back to step ${targetStep}`);
    } else {
      this._descriptionParts.push(`→ loops back to ${stageId}`);
    }

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
   */
  build(): FlowChart<TOut, TScope> {
    const root = this._root ?? fail('empty tree; call start() first');
    const rootSpec = this._rootSpec ?? fail('empty spec; call start() first');

    // Convert subflow defs map to plain object
    const subflows: Record<string, { root: StageNode<TOut, TScope> }> = {};
    for (const [key, def] of this._subflowDefs) {
      subflows[key] = def;
    }

    // Build the pre-built description string from accumulated parts
    const rootName = this._root?.displayName ?? this._root?.name ?? 'Pipeline';
    const description = this._descriptionParts.length > 0
      ? `Pipeline: ${rootName}\nSteps:\n${this._descriptionParts.join('\n')}`
      : '';

    // Return _rootSpec directly - O(1) instead of O(n)
    // Type computation and extractor application already done incrementally
    return {
      root,
      stageMap: this._stageMap,
      extractor: this._extractor,
      buildTimeStructure: rootSpec,
      ...(Object.keys(subflows).length > 0 ? { subflows } : {}),
      ...(this._enableNarrative ? { enableNarrative: true } : {}),
      description,
      stageDescriptions: new Map(this._stageDescriptions),
    };
  }

  /**
   * Emit pure JSON spec (returns pre-built structure).
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

  /**
   * Merge another flow's stageMap; throw on name collisions.
   *
   * WHY: When mounting subflows, their stage functions need to be accessible
   * from the parent's shared stageMap. An optional `prefix` parameter
   * namespaces all keys (e.g., "classify/SeedScope") to prevent collisions
   * when multiple subflows share the same stage names.
   *
   * @param other - The stageMap to merge in
   * @param prefix - Optional namespace prefix for all keys (e.g., mount id)
   */
  _mergeStageMap(
    other: Map<string, PipelineStageFunction<TOut, TScope>>,
    prefix?: string,
  ) {
    for (const [k, v] of other) {
      const key = prefix ? `${prefix}/${k}` : k;
      if (this._stageMap.has(key)) {
        const existing = this._stageMap.get(key);
        if (existing !== v) fail(`stageMap collision while mounting flowchart at '${key}'`);
      } else {
        this._stageMap.set(key, v);
      }
    }
  }

  /**
   * Deep-clone a StageNode tree, prefixing all `name` (stageMap key) and
   * `subflowId` properties so the tree references the namespaced stageMap.
   *
   * WHY: When two subflows have identically-named stages (e.g., both have
   * "SeedScope"), prefixing avoids stageMap collisions. The cloned tree
   * is stored in _subflowDefs so runtime execution uses the prefixed names.
   *
   * @param node - Root of the tree to clone
   * @param prefix - Namespace prefix (e.g., the mount id "classify")
   * @returns A new tree with all names prefixed
   */
  private _prefixNodeTree(
    node: StageNode<TOut, TScope>,
    prefix: string,
  ): StageNode<TOut, TScope> {
    if (!node) return node;
    const clone: StageNode<TOut, TScope> = { ...node };
    clone.name = `${prefix}/${node.name}`;
    if (clone.subflowId) clone.subflowId = `${prefix}/${clone.subflowId}`;
    if (clone.next) clone.next = this._prefixNodeTree(clone.next, prefix);
    if (clone.children) {
      clone.children = clone.children.map((c) =>
        this._prefixNodeTree(c, prefix),
      );
    }
    return clone;
  }

  /**
   * Append a subflow description line to _descriptionParts.
   *
   * WHY: Both addSubFlowChart and addSubFlowChartNext need the same
   * description accumulation logic, so it's extracted here.
   */
  private _appendSubflowDescription(
    id: string,
    displayName: string,
    subflow: FlowChart<TOut, TScope>,
  ): void {
    this._stepCounter++;
    this._stageStepMap.set(id, this._stepCounter);
    if (subflow.description) {
      this._descriptionParts.push(
        `${this._stepCounter}. [Sub-Execution: ${displayName}] — ${subflow.description}`,
      );
      // Indent sub-steps from the subflow's description if it has multi-line Steps:
      const lines = subflow.description.split('\n');
      const stepsIdx = lines.findIndex((l) => l.startsWith('Steps:'));
      if (stepsIdx >= 0) {
        for (let i = stepsIdx + 1; i < lines.length; i++) {
          if (lines[i].trim()) {
            this._descriptionParts.push(`   ${lines[i]}`);
          }
        }
      }
    } else {
      this._descriptionParts.push(`${this._stepCounter}. [Sub-Execution: ${displayName}]`);
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
  description?: string,
): FlowChartBuilder<TOut, TScope> {
  return new FlowChartBuilder<TOut, TScope>(buildTimeExtractor).start(name, fn, id, displayName, description);
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
