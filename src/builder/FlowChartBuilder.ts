/**
 * FlowChartBuilder.ts
 *
 * A developer-friendly **FootPrint** builder to produce flow charts
 * your runtime engine (Pipeline) can execute.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR
 *   • FE / build-time:
 *       - Construct flows via a code-first DSL
 *       - Optionally embed stage functions (for local execution/dev)
 *       - Emit a **pure JSON spec** via `toSpec()` to send to BE
 *
 *   • BE / run-time:
 *       - Receive either `{root, stageMap}` (from build()) or a pure spec (`toSpec()`)
 *       - Convert spec via `specToStageNode(spec)` and run with `Pipeline`
 *
 * ENGINE ALIGNMENT (unified order in your Pipeline):
 *   • Linear:      stage → next
 *   • Fork-only:   (stage?) → children (parallel) → return bundle
 *   • Fork+next:   stage → children (parallel) → next
 *   • Decider:     stage → decider(out) → chosen child
 *
 * VALIDATIONS:
 *   • Duplicate child ids under a parent → throw
 *   • Decider must have at least one branch → throw
 *   • StageMap name collisions when mounting flowcharts → throw
 */

import type { Selector, StageNode } from '../core/pipeline/Pipeline';
import { FlowChartExecutor } from '../core/pipeline/FlowChartExecutor';
import type { PipelineStageFunction, StreamHandlers, StreamTokenHandler, StreamLifecycleHandler, TraversalExtractor } from '../core/pipeline/types';
import type { ScopeFactory } from '../scope/core/types';
import type { ScopeProtectionMode } from '../scope/protection/types';

// Re-export stream types for consumers
export type { StreamHandlers, StreamTokenHandler, StreamLifecycleHandler };

// Re-export Selector type for consumers
export type { Selector };

/**
 * **Pure JSON** Flow Chart spec for FE → BE transport (no functions/closures).
 * This mirrors the shape of your StageNode without `fn` / `nextNodeDecider`.
 * (You may add extra metadata flags as you like.)
 */
export interface FlowChartSpec {
  name: string;
  id?: string;
  /** Human-readable display name for UI */
  displayName?: string;
  children?: FlowChartSpec[];
  next?: FlowChartSpec;
  /** Whether this node has a decider (transport hint; not required for execution) */
  hasDecider?: boolean;
  /** Whether this node has a selector (transport hint; not required for execution) */
  hasSelector?: boolean;
  /** Optional list of branch ids (transport hint; useful for BE validation/UX) */
  branchIds?: string[];
  /** Loop target stage ID for looping back */
  loopTarget?: string;
  /** Whether this is a streaming stage */
  isStreaming?: boolean;
  /** Stream identifier for streaming stages */
  streamId?: string;
  /** Whether this node is a child of a parallel fork */
  isParallelChild?: boolean;
  /** ID of the parent fork node (for parallel children) */
  parallelGroupId?: string;
  /** True if this is the root node of a mounted subflow */
  isSubflowRoot?: boolean;
  /** Mount id of the subflow (e.g., "llm-core") */
  subflowId?: string;
  /** Display name of the subflow (e.g., "LLM Core") */
  subflowName?: string;
}

/* ============================================================================
 * Types exposed for consumers (FE + BE)
 * ========================================================================== */

/**
 * A stage function (relaxed generics for builder ergonomics).
 * In `build()` we produce a Map<string, PipelineStageFunction<TOut,TScope>>
 */
export type StageFn = PipelineStageFunction<any, any>;

/**
 * Spec for a parallel child entry in `addListOfFunction`.
 * Provides an id, a stage name, an optional embedded function,
 * and an optional flowchart (via `build` closure).
 */
export type ParallelSpec<TOut = any, TScope = any> = {
  /** Required: child id (used by deciders and bundle keys). Must be unique under the parent. */
  id: string;
  /** Stage name (stageMap key if `fn` omitted). */
  name: string;
  /** Optional human-readable display name for UI. */
  displayName?: string;
  /** Optional embedded stage function. */
  fn?: PipelineStageFunction<TOut, TScope>;
  /** Optional flowchart under this child. Runs recursively (linear/fork/decider). */
  build?: (b: FlowChartBuilder<TOut, TScope>) => void;
};

/**
 * A branch body for deciders (function + optional flowchart, or a pure flowchart).
 */
export type BranchBody<TOut = any, TScope = any> =
  | { name?: string; fn?: PipelineStageFunction<TOut, TScope>; build?: (b: FlowChartBuilder<TOut, TScope>) => void }
  | ((b: FlowChartBuilder<TOut, TScope>) => void);

/**
 * Branch spec for deciders: map child id → branch body.
 */
export type BranchSpec<TOut = any, TScope = any> = Record<string, BranchBody<TOut, TScope>>;

/**
 * A reference node that points to a subflow definition.
 * Used instead of deep-copying the entire subflow tree.
 * 
 * When serialized to JSON, SubflowRef nodes use `$ref` syntax:
 * ```json
 * { "$ref": "llm-core", "mountId": "llm-1", "displayName": "LLM Core" }
 * ```
 */
export interface SubflowRef {
  /** Key pointing to the subflow definition in the `subflows` dictionary */
  $ref: string;
  /** Unique identifier for this mount instance */
  mountId: string;
  /** Human-readable display name for UI */
  displayName?: string;
}

/**
 * Compiled flowchart ready for execution.
 * Output of FlowChartBuilder.build().
 * 
 * Can be passed to FlowChartExecutor for execution, or mounted
 * as a subflow under another flowchart via addSubFlowChart methods.
 */
export type FlowChart<TOut = any, TScope = any> = {
  /** Root node of the flowchart tree */
  root: StageNode<TOut, TScope>;
  /** Map of stage names to their functions */
  stageMap: Map<string, PipelineStageFunction<TOut, TScope>>;
  /** Optional traversal extractor for data extraction */
  extractor?: TraversalExtractor;
  /** Memoized subflow definitions (key → subflow root). Sent once, referenced multiple times. */
  subflows?: Record<string, { root: StageNode<TOut, TScope> }>;
};

/**
 * @deprecated Use FlowChart instead. This alias exists for backward compatibility.
 */
export type BuiltFlow<TOut = any, TScope = any> = FlowChart<TOut, TScope>;

/**
 * Options for the `execute` sugar (build + run).
 */
export type ExecOptions = {
  defaults?: unknown;
  initial?: unknown;
  readOnly?: unknown;
  throttlingErrorChecker?: (e: unknown) => boolean;
  /** Scope protection mode - defaults to 'error' in library, but can be set to 'off' for backward compatibility */
  scopeProtectionMode?: ScopeProtectionMode;
};

/* ============================================================================
 * Internal machinery
 * ========================================================================== */

const fail = (msg: string): never => {
  throw new Error(`[FlowChartBuilder] ${msg}`);
};

/** Internal builder node. */
class _N<TOut, TScope> {
  name!: string;
  id?: string;
  displayName?: string;
  fn?: PipelineStageFunction<TOut, TScope>;
  decider?: (out?: TOut) => string | Promise<string>;
  selector?: Selector;
  children: _N<TOut, TScope>[] = [];
  next?: _N<TOut, TScope>;
  parent?: _N<TOut, TScope>;
  loopTarget?: string;
  isStreaming?: boolean;
  streamId?: string;
  /** True if this is the root node of a mounted subflow */
  isSubflowRoot?: boolean;
  /** Mount id of the subflow (e.g., "llm-core") */
  subflowId?: string;
  /** Display name of the subflow (e.g., "LLM Core") */
  subflowName?: string;
}

/* ============================================================================
 * Decider list (returned by addDecider)
 * ========================================================================== */

/**
 * A small fluent helper returned by `addDecider` to add branches cleanly,
 * then `.end()` to return to the parent chain.
 */
export class DeciderList<TOut = any, TScope = any> {
  private readonly b: FlowChartBuilder<TOut, TScope>;
  private readonly cur: _N<TOut, TScope>;
  private readonly originalDecider: (out?: TOut) => string | Promise<string>;
  private readonly branchIds = new Set<string>();
  private defaultId?: string;

  constructor(
    builder: FlowChartBuilder<TOut, TScope>,
    node: _N<TOut, TScope>,
    decider: (out?: TOut) => string | Promise<string>,
  ) {
    this.b = builder;
    this.cur = node;
    this.originalDecider = decider;
  }

  /**
   * Add a branch that **starts with a function** (optionally with a flowchart).
   * @param id     Child id (required; must be unique under this decider).
   * @param name   Stage name (stageMap key if `fn` omitted).
   * @param fn     Optional embedded stage function for the branch root.
   * @param build  Optional flowchart under this branch.
   * @param displayName Optional human-readable display name for UI.
   */
  addFunctionBranch(
    id: string,
    name: string,
    fn?: PipelineStageFunction<TOut, TScope>,
    build?: (b: FlowChartBuilder<TOut, TScope>) => void,
    displayName?: string,
  ): DeciderList<TOut, TScope> {
    if (this.branchIds.has(id)) fail(`duplicate decider branch id '${id}' under '${this.cur.name}'`);
    this.branchIds.add(id);

    const n = new _N<TOut, TScope>();
    n.id = id;
    n.name = name ?? id;
    if (displayName) n.displayName = displayName;
    if (fn) {
      n.fn = fn;
      this.b._addToMap(n.name, fn);
    }
    n.parent = this.cur;
    this.cur.children.push(n);

    if (build) build(this.b._spawnAt(n));
    return this;
  }

  /**
   * Mount an already-built flowchart as a branch.
   * Creates a reference node pointing to the memoized subflow definition.
   * Useful for composing large graphs from smaller ones owned by other teams.
   */
  addSubFlowChartBranch(id: string, subflow: FlowChart<TOut, TScope>, mountName?: string): DeciderList<TOut, TScope> {
    if (this.branchIds.has(id)) fail(`duplicate decider branch id '${id}' under '${this.cur.name}'`);
    this.branchIds.add(id);
    
    const displayName = mountName || id;
    
    // Register subflow definition using the mount id as key
    // This ensures resolveSubflowReference can find it using node.subflowId
    if (!this.b._subflowDefs.has(id)) {
      this.b._subflowDefs.set(id, { root: subflow.root });
    }
    
    // Create reference node (no deep copy!)
    const n = new _N<TOut, TScope>();
    n.name = displayName;
    n.id = id;
    n.isSubflowRoot = true;
    n.subflowId = id;
    n.subflowName = displayName;
    n.parent = this.cur;
    
    this.cur.children.push(n);
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
   * Add multiple branches in one call (good for dynamic lists).
   */
  addBranchList(
    branches: Array<{
      id: string;
      name: string;
      fn?: PipelineStageFunction<TOut, TScope>;
      build?: (b: FlowChartBuilder<TOut, TScope>) => void;
    }>,
  ): DeciderList<TOut, TScope> {
    for (const { id, name, fn, build } of branches) {
      this.addFunctionBranch(id, name, fn, build);
    }
    return this;
  }

  /**
   * Set a default branch id. If the decider returns an unknown/empty id,
   * we route to this id instead of letting the engine throw.
   */
  setDefault(id: string): DeciderList<TOut, TScope> {
    this.defaultId = id;
    return this;
  }

  /**
   * Finalize the decider:
   *  • Guard the user decider with a default branch (if provided)
   *  • Validate at least one branch exists
   *  • Return to the parent builder chain
   */
  end(): FlowChartBuilder<TOut, TScope> {
    if (this.cur.children.length === 0) fail(`decider at '${this.cur.name}' requires at least one branch`);

    const validIds = new Set(this.cur.children.map((c) => c.id));
    const fallbackId = this.defaultId;

    this.cur.decider = async (out?: TOut) => {
      const raw = this.originalDecider(out);
      const id = raw instanceof Promise ? await raw : raw;
      if (id && validIds.has(id)) return id;
      if (fallbackId && validIds.has(fallbackId)) return fallbackId;
      return id; // let the engine throw (unknown id) if no default is set
    };

    return this.b;
  }
}

/* ============================================================================
 * Selector list (returned by addSelector)
 * ========================================================================== */

/**
 * A fluent helper returned by `addSelector` to add branches cleanly,
 * then `.end()` to return to the parent chain.
 *
 * Unlike DeciderList (single-choice), SelectorList supports multi-choice
 * branching where the selector can return one or more child IDs.
 */
export class SelectorList<TOut = any, TScope = any> {
  private readonly b: FlowChartBuilder<TOut, TScope>;
  private readonly cur: _N<TOut, TScope>;
  private readonly originalSelector: Selector;
  private readonly branchIds = new Set<string>();

  constructor(
    builder: FlowChartBuilder<TOut, TScope>,
    node: _N<TOut, TScope>,
    selector: Selector,
  ) {
    this.b = builder;
    this.cur = node;
    this.originalSelector = selector;
  }

  /**
   * Add a branch that **starts with a function** (optionally with a flowchart).
   * @param id     Child id (required; must be unique under this selector).
   * @param name   Stage name (stageMap key if `fn` omitted).
   * @param fn     Optional embedded stage function for the branch root.
   * @param build  Optional flowchart under this branch.
   */
  addFunctionBranch(
    id: string,
    name: string,
    fn?: PipelineStageFunction<TOut, TScope>,
    build?: (b: FlowChartBuilder<TOut, TScope>) => void,
  ): SelectorList<TOut, TScope> {
    if (this.branchIds.has(id)) fail(`duplicate selector branch id '${id}' under '${this.cur.name}'`);
    this.branchIds.add(id);

    const n = new _N<TOut, TScope>();
    n.id = id;
    n.name = name ?? id;
    if (fn) {
      n.fn = fn;
      this.b._addToMap(n.name, fn);
    }
    n.parent = this.cur;
    this.cur.children.push(n);

    if (build) build(this.b._spawnAt(n));
    return this;
  }

  /**
   * Mount an already-built flowchart as a branch.
   * Creates a reference node pointing to the memoized subflow definition.
   * Useful for composing large graphs from smaller ones owned by other teams.
   */
  addSubFlowChartBranch(id: string, subflow: FlowChart<TOut, TScope>, mountName?: string): SelectorList<TOut, TScope> {
    if (this.branchIds.has(id)) fail(`duplicate selector branch id '${id}' under '${this.cur.name}'`);
    this.branchIds.add(id);
    
    const displayName = mountName || id;
    
    // Register subflow definition using the mount id as key
    // This ensures resolveSubflowReference can find it using node.subflowId
    if (!this.b._subflowDefs.has(id)) {
      this.b._subflowDefs.set(id, { root: subflow.root });
    }
    
    // Create reference node (no deep copy!)
    const n = new _N<TOut, TScope>();
    n.name = displayName;
    n.id = id;
    n.isSubflowRoot = true;
    n.subflowId = id;
    n.subflowName = displayName;
    n.parent = this.cur;
    
    this.cur.children.push(n);
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
   * Add multiple branches in one call (good for dynamic lists).
   */
  addBranchList(
    branches: Array<{
      id: string;
      name: string;
      fn?: PipelineStageFunction<TOut, TScope>;
      build?: (b: FlowChartBuilder<TOut, TScope>) => void;
    }>,
  ): SelectorList<TOut, TScope> {
    for (const { id, name, fn, build } of branches) {
      this.addFunctionBranch(id, name, fn, build);
    }
    return this;
  }

  /**
   * Finalize the selector:
   *  • Validate at least one branch exists
   *  • Assign the selector function to the node
   *  • Return to the parent builder chain
   */
  end(): FlowChartBuilder<TOut, TScope> {
    if (this.cur.children.length === 0) fail(`selector at '${this.cur.name}' requires at least one branch`);

    // Store the selector directly (no wrapping needed unlike decider)
    this.cur.selector = this.originalSelector;

    return this.b;
  }
}

/* ============================================================================
 * FlowChartBuilder (main)
 * ========================================================================== */

export class FlowChartBuilder<TOut = any, TScope = any> {
  private _root?: _N<TOut, TScope>;
  private _cursor?: _N<TOut, TScope>;
  private _stageMap = new Map<string, PipelineStageFunction<TOut, TScope>>();

  /**
   * Memoized subflow definitions.
   * Key is the subflow's root name, value is the subflow definition.
   * Used to avoid deep-copying subflows - instead we create reference nodes.
   * 
   * @internal Exposed for DeciderList and SelectorList access within this file.
   */
  _subflowDefs = new Map<string, { root: StageNode<TOut, TScope> }>();

  /**
   * Stream handlers for streaming stages.
   * Contains callbacks for token emission and lifecycle events (start/end).
   */
  private _streamHandlers: StreamHandlers = {};

  /**
   * Optional traversal extractor function.
   * Called after each stage completes to extract data for frontend consumption.
   */
  private _extractor?: TraversalExtractor;

  /* ─────────────────────────── Authoring API ─────────────────────────── */

  /** Define the root function of the flow. */
  start(functionName: string, fn?: PipelineStageFunction<TOut, TScope>, id?: string, displayName?: string): this {
    if (this._root) fail('root already defined; create a new builder');
    const n = new _N<TOut, TScope>();
    n.name = functionName;
    if (id) n.id = id;
    if (displayName) n.displayName = displayName;
    if (fn) {
      n.fn = fn;
      this._addToMap(n.name, fn);
    }
    this._root = n;
    this._cursor = n;
    return this;
  }

  /** Append a linear “next” function and move to it. */
  addFunction(functionName: string, fn?: PipelineStageFunction<TOut, TScope>, id?: string, displayName?: string): this {
    const cur = this._needCursor();
    const n = new _N<TOut, TScope>();
    n.name = functionName;
    if (id) n.id = id;
    if (displayName) n.displayName = displayName;
    n.parent = cur.parent ?? undefined;
    if (fn) {
      n.fn = fn;
      this._addToMap(n.name, fn);
    }
    cur.next = n;
    this._cursor = n;
    return this;
  }

  /**
   * Add parallel children (fork). Cursor remains at the parent.
   * If a child has a `build` callback, it defines a full flowchart under that child.
   * 
   * For runtime continuation (no start() required):
   * Auto-creates a virtual cursor if none exists, enabling dynamic stages to use
   * the same API for defining fork children without calling start() first.
   */
  addListOfFunction(children: ParallelSpec<TOut, TScope>[]): this {
    const cur = this._getOrCreateCursor();
    for (const { id, name, displayName, fn, build } of children) {
      if (!id) fail(`child id required under '${cur.name}'`);
      if (cur.children.some((c) => c.id === id)) fail(`duplicate child id '${id}' under '${cur.name}'`);
      const n = new _N<TOut, TScope>();
      n.id = id;
      n.name = name ?? id;
      if (displayName) n.displayName = displayName;
      if (fn) {
        n.fn = fn;
        this._addToMap(n.name, fn);
      }
      n.parent = cur;
      cur.children.push(n);
      if (build) build(this._spawnAt(n));
    }
    return this;
  }

  /**
   * Add a decider at the current node. Returns a DeciderList to populate
   * with branches, then call `.end()` to return to the parent chain.
   */
  addDecider(decider: (out?: TOut) => string | Promise<string>): DeciderList<TOut, TScope> {
    const cur = this._needCursor();
    if (cur.decider) fail(`decider already defined at '${cur.name}'`);
    if (cur.selector) fail(`decider and selector are mutually exclusive at '${cur.name}'`);
    return new DeciderList<TOut, TScope>(this, cur, decider);
  }

  /**
   * Add a selector at the current node. Returns a SelectorList to populate
   * with branches, then call `.end()` to return to the parent chain.
   *
   * Unlike decider (single-choice), selector supports multi-choice branching
   * where the selector function can return one or more child IDs for parallel execution.
   */
  addSelector(selector: Selector): SelectorList<TOut, TScope> {
    const cur = this._needCursor();
    if (cur.selector) fail(`selector already defined at '${cur.name}'`);
    if (cur.decider) fail(`decider and selector are mutually exclusive at '${cur.name}'`);
    return new SelectorList<TOut, TScope>(this, cur, selector);
  }

  /**
   * Add a **child** by mounting a prebuilt flowchart under the current node (fork).
   * This is the non-decider analog to `addSubFlowChartBranch` and is intended for
   * stitching multiple chatbot subflows (e.g., FAQ, Smalltalk, RAG) as parallel children.
   *
   * Example:
   *   const faq = new FlowChartBuilder().start('FAQ').addFunction('FAQ_Answer').build();
   *   const rag = new FlowChartBuilder().start('RAG').addFunction('RAG_Answer').build();
   *
   *   new FlowChartBuilder()
   *     .start('entry')
   *     .addSubFlowChart('faq', faq, 'FAQ')  // child id 'faq' hosts the FAQ flowchart
   *     .addSubFlowChart('rag', rag, 'RAG')  // child id 'rag' hosts the RAG flowchart
   *     .addFunction('aggregate')
   *
   * @param id        child id (required; unique under current parent)
   * @param subflow   prebuilt flow (from .build())
   * @param mountName optional override for the child’s stage name at the mount point
   */
  addSubFlowChart(id: string, subflow: FlowChart<TOut, TScope>, mountName?: string): this {
    const cur = this._needCursor();
    if (cur.children.some((c) => c.id === id)) {
      fail(`duplicate child id '${id}' under '${cur.name}'`);
    }
    
    const displayName = mountName || id;
    
    // Register subflow definition using the mount id as key
    // This ensures resolveSubflowReference can find it using node.subflowId
    if (!this._subflowDefs.has(id)) {
      this._subflowDefs.set(id, { root: subflow.root });
    }
    
    // Create reference node (no deep copy!)
    const n = new _N<TOut, TScope>();
    n.name = displayName;
    n.id = id;
    n.isSubflowRoot = true;
    n.subflowId = id;
    n.subflowName = displayName;
    n.parent = cur;
    
    cur.children.push(n);
    
    // Merge stage maps (detect collisions)
    this._mergeStageMap(subflow.stageMap);
    
    // Merge nested subflows from the mounted flowchart
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
   * Add a prebuilt flowchart as the **next** node (linear continuation).
   * Unlike `addSubFlowChart` (which adds as a child/fork), this method:
   * - Sets the subflow as `cur.next` (linear continuation)
   * - Allows subsequent `addFunction` calls to continue after the subflow
   *
   * Creates a reference node pointing to the memoized subflow definition.
   * The subflow is stored once in `_subflowDefs` and referenced via the root name.
   *
   * Use this inside `build` callbacks of `addFunctionBranch` when you want
   * the subflow to execute in sequence, not as a parallel fork.
   *
   * Example:
   *   builder
   *     .addDecider(decider)
   *       .addFunctionBranch('resolved', 'contextAggregator', fn, (b) => {
   *         // Subflow executes AFTER contextAggregator, then prepareResponse after subflow
   *         b.addSubFlowChartNext('llm-core', llmCoreFlow, 'LLM Core')
   *           .addFunction('prepareResponse', prepareResponseFn);
   *       })
   *     .end();
   *
   * @param id        subflow id (required; used for subflowId metadata)
   * @param subflow   prebuilt flow (from .build())
   * @param mountName optional override for the subflow's root stage name
   */
  addSubFlowChartNext(id: string, subflow: FlowChart<TOut, TScope>, mountName?: string): this {
    const cur = this._needCursor();
    if (cur.next) {
      fail(`cannot add subflow as next when next is already defined at '${cur.name}'`);
    }
    
    const displayName = mountName || id;
    
    // Register subflow definition using the mount id as key
    // This ensures resolveSubflowReference can find it using node.subflowId
    if (!this._subflowDefs.has(id)) {
      this._subflowDefs.set(id, { root: subflow.root });
    }
    
    // Create reference node (no deep copy!)
    const n = new _N<TOut, TScope>();
    n.name = displayName;
    n.id = id;
    n.isSubflowRoot = true;
    n.subflowId = id;
    n.subflowName = displayName;
    n.parent = cur.parent ?? undefined;
    
    // Set as next (linear continuation)
    cur.next = n;
    
    // Move cursor to the subflow reference node so subsequent addFunction calls
    // chain from the subflow, not from the original node
    this._cursor = n;
    
    // Merge stage maps (detect collisions)
    this._mergeStageMap(subflow.stageMap);
    
    // Merge nested subflows from the mounted flowchart
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
   * Find the last node in a chain (follows `next` pointers to the end).
   * Used by `addSubFlowChartNext` to move cursor to end of subflow.
   */
  private _findLastNode(n: _N<TOut, TScope>): _N<TOut, TScope> {
    let current = n;
    while (current.next) {
      current = current.next;
    }
    return current;
  }

  /** Explicitly move into a specific child by id (closures are preferred). */
  into(childId: string): this {
    const cur = this._needCursor();
    const c = cur.children.find((x) => x.id === childId);
    if (!c) fail(`child '${childId}' not found under '${cur.name}'`);
    this._cursor = c;
    return this;
  }

  /**
   * Set a loop target for the current node.
   * After this node completes (including any children), execution will loop back
   * to the stage with the specified ID.
   *
   * This enables patterns like LLM tool loops:
   *   builder
   *     .start('prepareHistory', fn, 'prepareHistory')
   *     .addFunction('askLLM', askLLMFn)
   *     .addFunction('toolBranch', toolBranchFn, 'toolBranch')
   *     .loopTo('prepareHistory')  // After toolBranch, loop back
   *     .addFunction('prepareResponse', prepareResponseFn);
   *
   * For runtime continuation (no start() required):
   * Auto-creates a virtual cursor if none exists, enabling dynamic stages to use
   * the same API for defining loop targets without calling start() first.
   *
   * @param stageId - The ID of the stage to loop back to (must exist in the tree)
   */
  loopTo(stageId: string): this {
    // Auto-create virtual cursor for runtime continuation (no start() required)
    const cur = this._getOrCreateCursor();
    if (cur.loopTarget) fail(`loopTo already defined at '${cur.name}'`);
    if (cur.next) fail(`cannot set loopTo when next is already defined at '${cur.name}'`);
    cur.loopTarget = stageId;
    return this;
  }

  /* ─────────────────────────── Streaming API ─────────────────────────── */

  /**
   * Adds a streaming function to the flow.
   * Creates a stage node with `isStreaming: true` and the specified streamId.
   *
   * @param name - The name of the stage
   * @param streamId - Optional unique identifier for the stream. Defaults to the stage name if not provided.
   * @param fn - Optional stage function. If not provided, must be registered in stageMap.
   * @param id - Optional node id for the stage
   * @param displayName - Optional human-readable display name for UI
   * @returns this for fluent chaining
   */
  addStreamingFunction(name: string, streamId?: string, fn?: PipelineStageFunction<TOut, TScope>, id?: string, displayName?: string): this {
    const cur = this._needCursor();
    const n = new _N<TOut, TScope>();
    n.name = name;
    n.isStreaming = true;
    n.streamId = streamId ?? name; // Default streamId to stage name if not provided
    if (id) n.id = id;
    if (displayName) n.displayName = displayName;
    n.parent = cur.parent ?? undefined;
    if (fn) {
      n.fn = fn;
      this._addToMap(n.name, fn);
    }
    cur.next = n;
    this._cursor = n;
    return this;
  }

  /**
   * Registers a handler for stream token events.
   * Called when a streaming stage emits a token.
   *
   * @param handler - Callback function receiving (streamId, token)
   * @returns this for fluent chaining
   */
  onStream(handler: StreamTokenHandler): this {
    this._streamHandlers.onToken = handler;
    return this;
  }

  /**
   * Registers a handler for stream start events.
   * Called when a streaming stage begins execution.
   *
   * @param handler - Callback function receiving (streamId)
   * @returns this for fluent chaining
   */
  onStreamStart(handler: StreamLifecycleHandler): this {
    this._streamHandlers.onStart = handler;
    return this;
  }

  /**
   * Registers a handler for stream end events.
   * Called when a streaming stage completes, with accumulated text.
   *
   * @param handler - Callback function receiving (streamId, fullText)
   * @returns this for fluent chaining
   */
  onStreamEnd(handler: StreamLifecycleHandler): this {
    this._streamHandlers.onEnd = handler;
    return this;
  }

  /* ─────────────────────────── Traversal Extractor API ─────────────────────────── */

  /**
   * Register a traversal extractor function.
   * The extractor is called after each stage completes (after commitPatch).
   * 
   * The extractor receives a StageSnapshot containing:
   * - node: The StageNode being executed (name, id, displayName, etc.)
   * - context: The StageContext (provides getScope, getDebugInfo, getErrorInfo)
   * 
   * The extractor should return whatever data the application needs.
   * Return undefined/null to skip adding an entry for this stage.
   * 
   * Only one extractor per flow is supported. Calling this multiple times
   * replaces the previous extractor (last one wins).
   * 
   * @param extractor - Function to extract data from each stage
   * @returns this for fluent chaining
   * 
   * @example
   * ```typescript
   * builder
   *   .start('entry', entryFn)
   *   .addFunction('askLLM', askLLMFn)
   *   .addTraversalExtractor((snapshot) => {
   *     const { node, context } = snapshot;
   *     const scope = context.getScope();
   *     const debugInfo = context.getDebugInfo();
   *     
   *     // Extract domain-specific data
   *     return {
   *       stageName: node.name,
   *       llmResponse: scope?.llmResponse,
   *       toolCalls: debugInfo?.toolCalls,
   *     };
   *   })
   *   .build();
   * ```
   */
  addTraversalExtractor<TResult = unknown>(
    extractor: TraversalExtractor<TResult>
  ): this {
    this._extractor = extractor;
    return this;
  }

  /** Move back to the parent node. */
  end(): this {
    const cur = this._needCursor();
    if (!cur.parent) fail("'end()' at root is invalid");
    this._cursor = cur.parent;
    return this;
  }

  /** Reset the cursor back to root. */
  resetToRoot(): this {
    if (!this._root) fail('no root defined; call start() first');
    this._cursor = this._root;
    return this;
  }

  /* ─────────────────────────── Output & helpers ───────────────────────── */

  /**
   * Compile to engine input:
   *   • `root`  — StageNode tree (with embedded `fn`/decider closures kept)
   *   • `stageMap` — Map of stage names → embedded functions (for engine lookup by name)
   *   • `extractor` — Optional traversal extractor function
   *   • `subflows` — Memoized subflow definitions (key → subflow root)
   *
   * NOTE: This is not pure JSON (contains functions). Use `toSpec()` for transport.
   */
  build(): { 
    root: StageNode<TOut, TScope>; 
    stageMap: Map<string, PipelineStageFunction<TOut, TScope>>;
    extractor?: TraversalExtractor;
    subflows?: Record<string, { root: StageNode<TOut, TScope> }>;
  } {
    const root = this._root ?? fail('empty tree; call start() first');

    const toStageNode = (n: _N<TOut, TScope>): StageNode<TOut, TScope> => {
      const out: StageNode<TOut, TScope> = { name: n.name, id: n.id, fn: n.fn as any };
      
      // Add display name
      if (n.displayName) out.displayName = n.displayName;
      
      // Add streaming properties
      if (n.isStreaming) out.isStreaming = true;
      if (n.streamId) out.streamId = n.streamId;
      
      // Add subflow metadata
      if (n.isSubflowRoot) out.isSubflowRoot = true;
      if (n.subflowId) out.subflowId = n.subflowId;
      if (n.subflowName) out.subflowName = n.subflowName;
      
      if (n.children.length > 0) {
        out.children = n.children.map(toStageNode);
        if (n.decider) out.nextNodeDecider = n.decider as any;
        if (n.selector) out.nextNodeSelector = n.selector as any;
      } else if (n.decider) {
        fail(`node '${n.name}' is a decider but has no children`);
      } else if (n.selector) {
        fail(`node '${n.name}' is a selector but has no children`);
      }
      
      // Handle loopTarget - create a reference node with just id/name
      if (n.loopTarget) {
        out.next = { name: n.loopTarget, id: n.loopTarget };
      } else if (n.next) {
        out.next = toStageNode(n.next);
      }
      return out;
    };

    // Convert subflow defs map to plain object
    const subflows: Record<string, { root: StageNode<TOut, TScope> }> = {};
    for (const [key, def] of this._subflowDefs) {
      subflows[key] = def;
    }

    return { 
      root: toStageNode(root), 
      stageMap: this._stageMap,
      extractor: this._extractor,
      // Only include subflows if there are any
      ...(Object.keys(subflows).length > 0 ? { subflows } : {}),
    };
  }

  /**
   * Emit a **pure JSON** flow spec for FE → BE transport (no functions/closures).
   * We only include fields that are present (omit falsy/noise like hasDecider:false, next:undefined).
   */
  toSpec(): FlowChartSpec {
    const root = this._root ?? fail('empty tree; call start() first');

    const inflate = (n: _N<TOut, TScope>, parentForkId?: string): FlowChartSpec => {
      const spec: FlowChartSpec = { name: n.name };

      if (n.id) spec.id = n.id;
      if (n.displayName) spec.displayName = n.displayName;
      
      // Add streaming properties
      if (n.isStreaming) spec.isStreaming = true;
      if (n.streamId) spec.streamId = n.streamId;
      
      // Add subflow metadata
      if (n.isSubflowRoot) spec.isSubflowRoot = true;
      if (n.subflowId) spec.subflowId = n.subflowId;
      if (n.subflowName) spec.subflowName = n.subflowName;
      
      // Add parallel child metadata
      if (parentForkId) {
        spec.isParallelChild = true;
        spec.parallelGroupId = parentForkId;
      }

      if (n.children.length) {
        // Determine if this is a fork (parallel children without decider/selector)
        const isFork = !n.decider && !n.selector;
        const forkId = isFork ? (n.id ?? n.name) : undefined;
        
        spec.children = n.children.map(c => inflate(c, forkId));

        // Only annotate decider metadata when there IS a decider on this node
        if (n.decider) {
          spec.hasDecider = true;
          // branch ids are precisely the child ids
          spec.branchIds = n.children
            .map((c) => c.id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
        }

        // Only annotate selector metadata when there IS a selector on this node
        if (n.selector) {
          spec.hasSelector = true;
          // branch ids are precisely the child ids
          spec.branchIds = n.children
            .map((c) => c.id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
        }
      }

      // Handle loopTarget - include as metadata for serialization
      if (n.loopTarget) {
        spec.loopTarget = n.loopTarget;
        // Also create a reference next node for consistency
        spec.next = { name: n.loopTarget, id: n.loopTarget };
      } else if (n.next) {
        spec.next = inflate(n.next); // next nodes are not parallel children
      }

      return spec;
    };

    return inflate(root);
  }

  /**
   * Convenience: build & execute with a given ScopeFactory.
   * (You can ignore this on FE if you only need pure JSON via `toSpec()`.)
   * 
   * Uses FlowChartExecutor internally for execution.
   */
  async execute(scopeFactory: ScopeFactory<TScope>, opts?: ExecOptions): Promise<any> {
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
   * Mermaid diagram generator (TD). Helpful for docs and PRs.
   */
  toMermaid(): string {
    const lines: string[] = ['flowchart TD'];
    const idOf = (k: string) => (k || '').replace(/[^a-zA-Z0-9_]/g, '_') || '_';
    const root = this._root ?? fail('empty tree; call start() first');

    const walk = (n: _N<TOut, TScope>) => {
      const nid = idOf(n.id ?? n.name);
      lines.push(`${nid}["${n.name}"]`);
      for (const c of n.children) {
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

  /* ─────────────────────────── Internals & validation ───────────────────────── */

  private _needCursor() {
    return this._cursor ?? fail('cursor undefined; call start() first');
  }

  /**
   * Get existing cursor or create a virtual one for runtime continuation.
   * This enables methods like addListOfFunction() and loopTo() to work
   * without requiring start() to be called first.
   */
  private _getOrCreateCursor(): _N<TOut, TScope> {
    if (!this._cursor) {
      const n = new _N<TOut, TScope>();
      n.name = '__continuation__';
      this._cursor = n;
    }
    return this._cursor;
  }

  /** Spawn a builder view pinned to a specific node (shares root & stageMap). */
  _spawnAt(n: _N<TOut, TScope>): FlowChartBuilder<TOut, TScope> {
    const b = new FlowChartBuilder<TOut, TScope>();
    (b as any)._root = this._root;
    (b as any)._cursor = n;
    (b as any)._stageMap = this._stageMap;
    return b;
  }

  /** Add a function to the shared stageMap; fail on conflicting names. */
  _addToMap(name: string, fn: PipelineStageFunction<TOut, TScope>) {
    if (this._stageMap.has(name)) {
      const existing = this._stageMap.get(name);
      if (existing !== fn) fail(`stageMap collision for '${name}'`);
    }
    this._stageMap.set(name, fn);
  }

  /** Merge another flow’s stageMap; throw on name collisions. */
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

  /**
   * Generate a fallback key for a subflow based on its root node.
   * 
   * NOTE: This is primarily used for backward compatibility. The preferred
   * approach is to use the mount `id` parameter directly as the key when
   * storing subflows, which ensures consistency with resolveSubflowReference.
   * 
   * @deprecated Prefer using the mount id directly as the key
   */
  _getSubflowKey(subflow: FlowChart<TOut, TScope>): string {
    // Prefer subflowId (set during mounting) for consistency with lookup
    return subflow.root.subflowId || subflow.root.name;
  }

  /* ─────────────────────────── Runtime Continuation API ───────────────────────── */

  /**
   * Compile the current state to a StageNode for runtime continuation.
   * Unlike `build()`, this:
   * - Does NOT require start() to be called first
   * - Works with existing methods (addListOfFunction, loopTo, etc.) for runtime use
   * - Returns `undefined` if no continuations are defined
   * - Is used by dynamic stages to return their continuation
   *
   * Example usage in a dynamic stage:
   * ```typescript
   * async function toolBranchStage(scope, breakPipeline, streamCb, builder) {
   *   const toolCalls = scope.getValue([], 'toolCalls');
   *   if (!toolCalls?.length) return { toolCalls: [] }; // Plain object → normal flow
   *
   *   // Use existing API - no start() needed for runtime continuation
   *   builder
   *     .addListOfFunction(toolCalls.map(tc => ({ id: tc.id, name: tc.name, fn: tc.fn })))
   *     .loopTo('prepareHistory');
   *
   *   return builder.compile(); // Returns StageNode → Pipeline executes it
   * }
   * ```
   */
  compile(): StageNode<TOut, TScope> | undefined {
    const cur = this._cursor;
    if (!cur) return undefined;

    // Check if there are any continuations defined
    const hasChildren = cur.children.length > 0;
    const hasNext = cur.next !== undefined;
    const hasLoopTarget = cur.loopTarget !== undefined;

    if (!hasChildren && !hasNext && !hasLoopTarget) {
      return undefined;
    }

    // Build a StageNode from the current cursor's continuations
    const out: StageNode<TOut, TScope> = { name: cur.name || '__continuation__' };

    if (hasChildren) {
      out.children = cur.children.map((c) => this._nodeToStageNode(c));
      if (cur.decider) out.nextNodeDecider = cur.decider as any;
      if (cur.selector) out.nextNodeSelector = cur.selector as any;
    }

    if (hasLoopTarget) {
      out.next = { name: cur.loopTarget!, id: cur.loopTarget };
    } else if (hasNext) {
      out.next = this._nodeToStageNode(cur.next!);
    }

    return out;
  }

  /** Convert internal node to StageNode (helper for compile) */
  private _nodeToStageNode(n: _N<TOut, TScope>): StageNode<TOut, TScope> {
    const out: StageNode<TOut, TScope> = { name: n.name, id: n.id, fn: n.fn as any };
    
    // Add streaming properties
    if (n.isStreaming) out.isStreaming = true;
    if (n.streamId) out.streamId = n.streamId;
    
    // Add subflow metadata
    if (n.isSubflowRoot) out.isSubflowRoot = true;
    if (n.subflowId) out.subflowId = n.subflowId;
    if (n.subflowName) out.subflowName = n.subflowName;
    
    if (n.children.length > 0) {
      out.children = n.children.map((c) => this._nodeToStageNode(c));
      if (n.decider) out.nextNodeDecider = n.decider as any;
      if (n.selector) out.nextNodeSelector = n.selector as any;
    }

    if (n.loopTarget) {
      out.next = { name: n.loopTarget, id: n.loopTarget };
    } else if (n.next) {
      out.next = this._nodeToStageNode(n.next);
    }

    return out;
  }
}

/* ============================================================================
 * Factory Function - D3-style flowchart creation
 * ========================================================================== */

/**
 * D3-style factory function for creating flowcharts.
 * Combines FlowChartBuilder instantiation with start() for cleaner chaining.
 * 
 * This is the recommended way to create flowcharts - it provides a more
 * ergonomic API without requiring the `new` keyword.
 * 
 * @param name - The name of the root stage (stageMap key if fn omitted)
 * @param fn - Optional embedded stage function for the root
 * @param id - Optional stable id for the root node
 * @param displayName - Optional human-readable display name for UI
 * @returns A FlowChartBuilder instance with root already set
 * 
 * @example
 * // Simple flowchart
 * const chart = flowChart('entry', entryFn)
 *   .addFunction('process', processFn)
 *   .addFunction('output', outputFn)
 *   .build();
 * 
 * @example
 * // With decider branching
 * const chart = flowChart('entry', entryFn)
 *   .addDecider((out) => out.type)
 *     .addFunctionBranch('typeA', 'handleA', handleAFn)
 *     .addFunctionBranch('typeB', 'handleB', handleBFn)
 *     .end()
 *   .build();
 * 
 * @example
 * // Equivalent to:
 * const chart = new FlowChartBuilder()
 *   .start('entry', entryFn)
 *   .addFunction('process', processFn)
 *   .build();
 */
export function flowChart<TOut = any, TScope = any>(
  name: string,
  fn?: PipelineStageFunction<TOut, TScope>,
  id?: string,
  displayName?: string,
): FlowChartBuilder<TOut, TScope> {
  return new FlowChartBuilder<TOut, TScope>().start(name, fn, id, displayName);
}

/* ============================================================================
 * BE helper: convert a pure FlowChartSpec back to a StageNode (no fns)
 * ========================================================================== */

/**
 * Convert a **pure JSON** spec (from `toSpec()`) back into a StageNode tree.
 * NOTE:
 *  - The returned StageNode contains **no functions** (fn/decider) — resolution
 *    will occur by name using the stageMap you supply to TreePipeline at BE.
 *  - We keep `hasDecider`/`branchIds` only as informational flags; they can
 *    help you validate or annotate the spec on BE but are not required.
 */
export function specToStageNode(spec: FlowChartSpec): StageNode<any, any> {
  const inflate = (s: FlowChartSpec): StageNode<any, any> => ({
    name: s.name,
    id: s.id,
    children: s.children?.length ? s.children.map(inflate) : undefined,
    next: s.next ? inflate(s.next) : undefined,
    // nextNodeDecider is intentionally omitted in the spec → runtime uses your BE decider
  });
  return inflate(spec);
}
