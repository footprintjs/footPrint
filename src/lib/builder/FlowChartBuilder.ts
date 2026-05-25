/**
 * FlowChartBuilder — Fluent API for constructing flowchart execution graphs.
 *
 * Builds StageNode trees and SerializedPipelineStructure (JSON) in tandem.
 * Zero dependencies on old code — only imports from local types.
 *
 * The builder creates two parallel structures:
 * 1. StageNode tree — runtime graph with embedded functions
 * 2. SerializedPipelineStructure — JSON-safe structure for visualization
 *
 * The execute() convenience method is intentionally omitted —
 * it belongs in the runner layer (Phase 5).
 */

import type { ScopeFactory } from '../engine/types.js';
import type { PausableHandler } from '../pause/types.js';
import type { TypedScope } from '../reactive/types.js';
import { type RunnableFlowChart, makeRunnable } from '../runner/RunnableChart.js';
import type { StructureEdgeKind, StructureRecorder } from './structure/StructureRecorder.js';
import { StructureRecorderDispatcher } from './structure/StructureRecorderDispatcher.js';
import { type TypedStageFunction, createTypedScopeFactory } from './typedFlowChart.js';
import type {
  FlowChart,
  FlowChartOptions,
  FlowChartSpec,
  ILogger,
  SerializedPipelineStructure,
  SimplifiedParallelSpec,
  StageFunction,
  StageNode,
  StreamHandlers,
  StreamLifecycleHandler,
  StreamTokenHandler,
  SubflowMountOptions,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

const fail = (msg: string): never => {
  throw new Error(`[FlowChartBuilder] ${msg}`);
};

// ─────────────────────────────────────────────────────────────────────────────
// DeciderList
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fluent helper returned by addDeciderFunction to add branches.
 * `end()` sets `deciderFn = true` — the fn IS the decider.
 */
export class DeciderList<TOut = any, TScope = any> {
  private readonly b: FlowChartBuilder<TOut, TScope>;
  private readonly curNode: StageNode<TOut, TScope>;
  private readonly curSpec: SerializedPipelineStructure;
  private readonly branchIds = new Set<string>();
  private defaultId?: string;

  private readonly parentDescriptionParts: string[];
  private readonly parentStageDescriptions: Map<string, string>;
  private readonly reservedStepNumber: number;
  private readonly deciderDescription?: string;
  private readonly branchDescInfo: Array<{ id: string; description?: string }> = [];

  constructor(
    builder: FlowChartBuilder<TOut, TScope>,
    curNode: StageNode<TOut, TScope>,
    curSpec: SerializedPipelineStructure,
    parentDescriptionParts: string[] = [],
    parentStageDescriptions: Map<string, string> = new Map(),
    reservedStepNumber = 0,
    deciderDescription?: string,
  ) {
    this.b = builder;
    this.curNode = curNode;
    this.curSpec = curSpec;
    this.parentDescriptionParts = parentDescriptionParts;
    this.parentStageDescriptions = parentStageDescriptions;
    this.reservedStepNumber = reservedStepNumber;
    this.deciderDescription = deciderDescription;
  }

  addFunctionBranch(
    id: string,
    name: string,
    fn?: StageFunction<TOut, TScope>,
    description?: string,
  ): DeciderList<TOut, TScope> {
    if (this.branchIds.has(id)) fail(`duplicate decider branch id '${id}' under '${this.curNode.name}'`);
    this.branchIds.add(id);

    const node: StageNode<TOut, TScope> = { name: name ?? id, id, branchId: id };
    if (description) node.description = description;
    if (fn) {
      node.fn = fn;
      this.b._addToMap(id, fn);
    }

    const spec: SerializedPipelineStructure = { name: name ?? id, id, type: 'stage' };
    if (description) spec.description = description;

    this.curNode.children = this.curNode.children || [];
    this.curNode.children.push(node);
    this.curSpec.children = this.curSpec.children || [];
    this.curSpec.children.push(spec);
    // L7.3 — Decider branch: stage + decision-branch edge keyed by id.
    this.b._fireStageAddedFromSubBuilder(spec);
    this.b._fireEdgeAddedFromSubBuilder(this.curSpec.id, spec.id, 'decision-branch', id);

    this.branchDescInfo.push({ id, description });
    return this;
  }

  /**
   * Add a pausable stage as a decider branch.
   *
   * When this branch is chosen, the handler's `execute` runs. If it returns
   * data, the pipeline pauses. On resume, `handler.resume` runs with the
   * human's input. If `execute` returns void, the stage continues normally
   * (conditional pause).
   */
  addPausableFunctionBranch(
    id: string,
    name: string,
    handler: PausableHandler<TScope>,
    description?: string,
  ): DeciderList<TOut, TScope> {
    if (this.branchIds.has(id)) fail(`duplicate decider branch id '${id}' under '${this.curNode.name}'`);
    this.branchIds.add(id);

    const node: StageNode<TOut, TScope> = {
      name: name ?? id,
      id,
      branchId: id,
      fn: handler.execute as StageFunction<TOut, TScope>,
      isPausable: true,
      resumeFn: handler.resume,
    };
    if (description) node.description = description;
    this.b._addToMap(id, handler.execute as StageFunction<TOut, TScope>);

    const spec: SerializedPipelineStructure = { name: name ?? id, id, type: 'stage', isPausable: true };
    if (description) spec.description = description;

    this.curNode.children = this.curNode.children || [];
    this.curNode.children.push(node);
    this.curSpec.children = this.curSpec.children || [];
    this.curSpec.children.push(spec);
    // L7.3 — Pausable decider branch.
    this.b._fireStageAddedFromSubBuilder(spec);
    this.b._fireEdgeAddedFromSubBuilder(this.curSpec.id, spec.id, 'decision-branch', id);

    this.branchDescInfo.push({ id, description });
    return this;
  }

  addSubFlowChartBranch(
    id: string,
    subflow: FlowChart<any, any>,
    mountName?: string,
    options?: SubflowMountOptions,
  ): DeciderList<TOut, TScope> {
    if (this.branchIds.has(id)) fail(`duplicate decider branch id '${id}' under '${this.curNode.name}'`);
    this.branchIds.add(id);

    const subflowName = mountName || id;
    const prefixedRoot = this.b._prefixNodeTree(subflow.root, id);

    if (!this.b._subflowDefs.has(id)) {
      this.b._subflowDefs.set(id, { root: prefixedRoot });
    }

    const node: StageNode<TOut, TScope> = {
      name: subflowName,
      id,
      branchId: id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
    };
    if (options) node.subflowMountOptions = options;

    const spec: SerializedPipelineStructure = {
      name: subflowName,
      type: 'stage',
      id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
      subflowStructure: subflow.buildTimeStructure,
    };

    this.curNode.children = this.curNode.children || [];
    this.curNode.children.push(node);
    this.curSpec.children = this.curSpec.children || [];
    this.curSpec.children.push(spec);
    // L7.3 — Subflow as decider branch: stage + decision edge + mount.
    this.b._fireStageAddedFromSubBuilder(spec);
    this.b._fireEdgeAddedFromSubBuilder(this.curSpec.id, spec.id, 'decision-branch', id);
    this.b._fireSubflowMountedFromSubBuilder(id, subflowName, id, false, subflow.buildTimeStructure);

    this.b._mergeStageMap(subflow.stageMap, id);
    this.b._mergeSubflows(subflow.subflows, id);

    return this;
  }

  addLazySubFlowChartBranch(
    id: string,
    resolver: () => FlowChart<any, any>,
    mountName?: string,
    options?: SubflowMountOptions,
  ): DeciderList<TOut, TScope> {
    if (this.branchIds.has(id)) fail(`duplicate decider branch id '${id}' under '${this.curNode.name}'`);
    this.branchIds.add(id);

    const subflowName = mountName || id;

    // Store resolver on the node — NO eager tree cloning
    const node: StageNode<TOut, TScope> = {
      name: subflowName,
      id,
      branchId: id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
      subflowResolver: resolver as any,
    };
    if (options) node.subflowMountOptions = options;

    // Spec stub — no subflowStructure (lazy). The lazy subflow's
    // internals will be shaped at resolution time.
    const spec: SerializedPipelineStructure = {
      name: subflowName,
      type: 'stage',
      id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
      isLazy: true,
    };

    this.curNode.children = this.curNode.children || [];
    this.curNode.children.push(node);
    this.curSpec.children = this.curSpec.children || [];
    this.curSpec.children.push(spec);
    // L7.3 — Lazy subflow as decider branch.
    this.b._fireStageAddedFromSubBuilder(spec);
    this.b._fireEdgeAddedFromSubBuilder(this.curSpec.id, spec.id, 'decision-branch', id);
    this.b._fireSubflowMountedFromSubBuilder(id, subflowName, id, true);

    return this;
  }

  addBranchList(
    branches: Array<{
      id: string;
      name: string;
      fn?: StageFunction<TOut, TScope>;
    }>,
  ): DeciderList<TOut, TScope> {
    for (const { id, name, fn } of branches) {
      this.addFunctionBranch(id, name, fn);
    }
    return this;
  }

  setDefault(id: string): DeciderList<TOut, TScope> {
    this.defaultId = id;
    return this;
  }

  end(): FlowChartBuilder<TOut, TScope> {
    const children = this.curNode.children;
    if (!children || children.length === 0) {
      throw new Error(`[FlowChartBuilder] decider at '${this.curNode.name}' requires at least one branch`);
    }

    // Validate that every branch with no embedded fn is resolvable from the stageMap
    for (const child of children) {
      if (!child.fn && child.id && !child.isSubflowRoot && !child.subflowResolver) {
        const hasInMap = this.b._stageMapHas(child.id) || this.b._stageMapHas(child.name);
        if (!hasInMap) {
          throw new Error(
            `[FlowChartBuilder] decider branch '${child.id}' under '${this.curNode.name}' has no function — ` +
              `provide a fn argument to addFunctionBranch('${child.id}', ...)`,
          );
        }
      }
    }

    this.curNode.deciderFn = true;

    // Build branchIds BEFORE appending the synthetic default — only user-specified branches
    this.curSpec.branchIds = children
      .map((c) => c.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    this.curSpec.type = 'decider';

    if (this.defaultId) {
      const defaultChild = children.find((c) => c.id === this.defaultId);
      if (defaultChild) {
        children.push({ ...defaultChild, id: 'default', branchId: 'default' });
      }
    }

    if (this.reservedStepNumber > 0) {
      const deciderLabel = this.curNode.name;
      const branchIdList = this.branchDescInfo.map((b) => b.id).join(', ');
      const mainLine = this.deciderDescription
        ? `${this.reservedStepNumber}. ${deciderLabel} — ${this.deciderDescription} (branches: ${branchIdList})`
        : `${this.reservedStepNumber}. ${deciderLabel} — Decides between: ${branchIdList}`;
      this.parentDescriptionParts.push(mainLine);

      if (this.deciderDescription) {
        this.parentStageDescriptions.set(this.curNode.name, this.deciderDescription);
      }

      for (const branch of this.branchDescInfo) {
        const branchText = branch.description;
        if (branchText) {
          this.parentDescriptionParts.push(`   → ${branch.id}: ${branchText}`);
        }
        if (branch.description) {
          this.parentStageDescriptions.set(branch.id, branch.description);
        }
      }
    }

    // L7.3 — fire `onDeciderComplete` so consumers can trust no more
    // branches will arrive for this decider. Branch iteration order =
    // addition order = Set insertion order.
    this.b._fireDeciderCompleteFromSubBuilder(this.curSpec.id, 'decider', [...this.branchIds], this.defaultId);
    return this.b;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SelectorFnList (scope-based selector — mirrors DeciderList)
// ─────────────────────────────────────────────────────────────────────────────

export class SelectorFnList<TOut = any, TScope = any> {
  private readonly b: FlowChartBuilder<TOut, TScope>;
  private readonly curNode: StageNode<TOut, TScope>;
  private readonly curSpec: SerializedPipelineStructure;
  private readonly branchIds = new Set<string>();

  private readonly parentDescriptionParts: string[];
  private readonly parentStageDescriptions: Map<string, string>;
  private readonly reservedStepNumber: number;
  private readonly selectorDescription?: string;
  private readonly branchDescInfo: Array<{ id: string; description?: string }> = [];

  constructor(
    builder: FlowChartBuilder<TOut, TScope>,
    curNode: StageNode<TOut, TScope>,
    curSpec: SerializedPipelineStructure,
    parentDescriptionParts: string[] = [],
    parentStageDescriptions: Map<string, string> = new Map(),
    reservedStepNumber = 0,
    selectorDescription?: string,
  ) {
    this.b = builder;
    this.curNode = curNode;
    this.curSpec = curSpec;
    this.parentDescriptionParts = parentDescriptionParts;
    this.parentStageDescriptions = parentStageDescriptions;
    this.reservedStepNumber = reservedStepNumber;
    this.selectorDescription = selectorDescription;
  }

  addFunctionBranch(
    id: string,
    name: string,
    fn?: StageFunction<TOut, TScope>,
    description?: string,
  ): SelectorFnList<TOut, TScope> {
    if (this.branchIds.has(id)) fail(`duplicate selector branch id '${id}' under '${this.curNode.name}'`);
    this.branchIds.add(id);

    const node: StageNode<TOut, TScope> = { name: name ?? id, id, branchId: id };
    if (description) node.description = description;
    if (fn) {
      node.fn = fn;
      this.b._addToMap(id, fn);
    }

    const spec: SerializedPipelineStructure = { name: name ?? id, id, type: 'stage' };
    if (description) spec.description = description;

    this.curNode.children = this.curNode.children || [];
    this.curNode.children.push(node);
    this.curSpec.children = this.curSpec.children || [];
    this.curSpec.children.push(spec);
    // L7.3 — Selector branch.
    this.b._fireStageAddedFromSubBuilder(spec);
    this.b._fireEdgeAddedFromSubBuilder(this.curSpec.id, spec.id, 'decision-branch', id);

    this.branchDescInfo.push({ id, description });
    return this;
  }

  /**
   * Add a pausable stage as a selector branch.
   *
   * When this branch is selected, the handler's `execute` runs. If it returns
   * data, the pipeline pauses. On resume, `handler.resume` runs with the
   * human's input. If `execute` returns void, the stage continues normally.
   */
  addPausableFunctionBranch(
    id: string,
    name: string,
    handler: PausableHandler<TScope>,
    description?: string,
  ): SelectorFnList<TOut, TScope> {
    if (this.branchIds.has(id)) fail(`duplicate selector branch id '${id}' under '${this.curNode.name}'`);
    this.branchIds.add(id);

    const node: StageNode<TOut, TScope> = {
      name: name ?? id,
      id,
      branchId: id,
      fn: handler.execute as StageFunction<TOut, TScope>,
      isPausable: true,
      resumeFn: handler.resume,
    };
    if (description) node.description = description;
    this.b._addToMap(id, handler.execute as StageFunction<TOut, TScope>);

    const spec: SerializedPipelineStructure = { name: name ?? id, id, type: 'stage', isPausable: true };
    if (description) spec.description = description;

    this.curNode.children = this.curNode.children || [];
    this.curNode.children.push(node);
    this.curSpec.children = this.curSpec.children || [];
    this.curSpec.children.push(spec);
    // L7.3 — Pausable selector branch.
    this.b._fireStageAddedFromSubBuilder(spec);
    this.b._fireEdgeAddedFromSubBuilder(this.curSpec.id, spec.id, 'decision-branch', id);

    this.branchDescInfo.push({ id, description });
    return this;
  }

  addSubFlowChartBranch(
    id: string,
    subflow: FlowChart<any, any>,
    mountName?: string,
    options?: SubflowMountOptions,
  ): SelectorFnList<TOut, TScope> {
    if (this.branchIds.has(id)) fail(`duplicate selector branch id '${id}' under '${this.curNode.name}'`);
    this.branchIds.add(id);

    const subflowName = mountName || id;
    const prefixedRoot = this.b._prefixNodeTree(subflow.root, id);

    if (!this.b._subflowDefs.has(id)) {
      this.b._subflowDefs.set(id, { root: prefixedRoot });
    }

    const node: StageNode<TOut, TScope> = {
      name: subflowName,
      id,
      branchId: id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
    };
    if (options) node.subflowMountOptions = options;

    const spec: SerializedPipelineStructure = {
      name: subflowName,
      type: 'stage',
      id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
      subflowStructure: subflow.buildTimeStructure,
    };

    this.curNode.children = this.curNode.children || [];
    this.curNode.children.push(node);
    this.curSpec.children = this.curSpec.children || [];
    this.curSpec.children.push(spec);
    // L7.3 — Subflow as selector branch.
    this.b._fireStageAddedFromSubBuilder(spec);
    this.b._fireEdgeAddedFromSubBuilder(this.curSpec.id, spec.id, 'decision-branch', id);
    this.b._fireSubflowMountedFromSubBuilder(id, subflowName, id, false, subflow.buildTimeStructure);

    this.b._mergeStageMap(subflow.stageMap, id);
    this.b._mergeSubflows(subflow.subflows, id);

    return this;
  }

  addLazySubFlowChartBranch(
    id: string,
    resolver: () => FlowChart<any, any>,
    mountName?: string,
    options?: SubflowMountOptions,
  ): SelectorFnList<TOut, TScope> {
    if (this.branchIds.has(id)) fail(`duplicate selector branch id '${id}' under '${this.curNode.name}'`);
    this.branchIds.add(id);

    const subflowName = mountName || id;

    const node: StageNode<TOut, TScope> = {
      name: subflowName,
      id,
      branchId: id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
      subflowResolver: resolver as any,
    };
    if (options) node.subflowMountOptions = options;

    const spec: SerializedPipelineStructure = {
      name: subflowName,
      type: 'stage',
      id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
      isLazy: true,
    };

    this.curNode.children = this.curNode.children || [];
    this.curNode.children.push(node);
    this.curSpec.children = this.curSpec.children || [];
    this.curSpec.children.push(spec);
    // L7.3 — Lazy subflow as selector branch.
    this.b._fireStageAddedFromSubBuilder(spec);
    this.b._fireEdgeAddedFromSubBuilder(this.curSpec.id, spec.id, 'decision-branch', id);
    this.b._fireSubflowMountedFromSubBuilder(id, subflowName, id, true);

    return this;
  }

  addBranchList(
    branches: Array<{
      id: string;
      name: string;
      fn?: StageFunction<TOut, TScope>;
    }>,
  ): SelectorFnList<TOut, TScope> {
    for (const { id, name, fn } of branches) {
      this.addFunctionBranch(id, name, fn);
    }
    return this;
  }

  end(): FlowChartBuilder<TOut, TScope> {
    const children = this.curNode.children;
    if (!children || children.length === 0) {
      throw new Error(`[FlowChartBuilder] selector at '${this.curNode.name}' requires at least one branch`);
    }

    // Validate that every branch with no embedded fn is resolvable from the stageMap
    for (const child of children) {
      if (!child.fn && child.id && !child.isSubflowRoot && !child.subflowResolver) {
        const hasInMap = this.b._stageMapHas(child.id) || this.b._stageMapHas(child.name);
        if (!hasInMap) {
          throw new Error(
            `[FlowChartBuilder] selector branch '${child.id}' under '${this.curNode.name}' has no function — ` +
              `provide a fn argument to addFunctionBranch('${child.id}', ...)`,
          );
        }
      }
    }

    this.curNode.selectorFn = true;

    this.curSpec.branchIds = children
      .map((c) => c.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    this.curSpec.type = 'selector'; // was 'decider' — incorrect; selectors are distinct from deciders
    this.curSpec.hasSelector = true;

    if (this.reservedStepNumber > 0) {
      const selectorLabel = this.curNode.name;
      const branchIdList = this.branchDescInfo.map((b) => b.id).join(', ');
      const mainLine = this.selectorDescription
        ? `${this.reservedStepNumber}. ${selectorLabel} — ${this.selectorDescription}`
        : `${this.reservedStepNumber}. ${selectorLabel} — Selects from: ${branchIdList}`;
      this.parentDescriptionParts.push(mainLine);

      if (this.selectorDescription) {
        this.parentStageDescriptions.set(this.curNode.name, this.selectorDescription);
      }

      for (const branch of this.branchDescInfo) {
        const branchText = branch.description;
        if (branchText) this.parentDescriptionParts.push(`   → ${branch.id}: ${branchText}`);
        if (branch.description) this.parentStageDescriptions.set(branch.id, branch.description);
      }
    }

    // L7.3 — fire `onDeciderComplete` with type='selector'. Selectors
    // have no default branch (multi-select semantics differ); pass
    // undefined.
    this.b._fireDeciderCompleteFromSubBuilder(this.curSpec.id, 'selector', [...this.branchIds]);
    return this.b;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FlowChartBuilder
// ─────────────────────────────────────────────────────────────────────────────

export class FlowChartBuilder<TOut = any, TScope = any> {
  private _root?: StageNode<TOut, TScope>;
  private _rootSpec?: SerializedPipelineStructure;
  private _cursor?: StageNode<TOut, TScope>;
  private _cursorSpec?: SerializedPipelineStructure;
  private _stageMap = new Map<string, StageFunction<TOut, TScope>>();
  _subflowDefs = new Map<string, { root: StageNode<TOut, TScope> }>();
  private _streamHandlers: StreamHandlers = {};
  /**
   * L7.3 — Build-time observer fan-out. Owned by the builder so every
   * `addX()` method can fire `StructureRecorder` events at the natural
   * moment of the corresponding mutation. Dispatcher is allocated
   * lazily on first attach to keep the zero-recorder path allocation-
   * free.
   */
  private _structureDispatcher?: StructureRecorderDispatcher;
  /**
   * L7.3 — Sealed-after-build flag (Panel 2 phase invariant). Flips
   * to `true` when `.build()` returns; subsequent `attachStructureRecorder`
   * throws. Prevents the footgun where a consumer attaches a recorder
   * mid-execution and gets partial structure data (missed every event
   * already fired during construction).
   */
  private _sealed = false;
  private _enableNarrative = false;
  private _logger?: ILogger;
  private _descriptionParts: string[] = [];
  private _stepCounter = 0;
  // NOTE: keyed by stage name (for human-readable descriptions), while stageMap
  // and knownStageIds use id (stable identifier). These are intentionally different
  // namespaces — descriptions are presentational, lookups are structural.
  private _stageDescriptions = new Map<string, string>();
  private _stageStepMap = new Map<string, number>();
  private _knownStageIds = new Set<string>();
  private _inputSchema?: unknown;
  private _outputSchema?: unknown;
  private _outputMapper?: (finalScope: Record<string, unknown>) => unknown;
  private _scopeFactory?: ScopeFactory<TScope>;

  // ── L7.3 — StructureRecorder attach + dispatch helpers ──────────────────

  /**
   * Attach a `StructureRecorder` for build-phase observation. Multiple
   * recorders coexist (same id allowed; iteration order = attach
   * order). Throws if called after `.build()` — the chart is sealed at
   * that point and any recorder attached late would miss every event
   * fired during construction.
   *
   * **Seed replay**: when this is called AFTER `start()` has already
   * fired (i.e., after the `flowChart()` factory returns), the
   * just-attached recorder receives a one-time `onStageAdded` for the
   * root stage so it observes the seed. Only the new recorder sees
   * the replay; already-attached recorders are not re-fired.
   *
   * **Mid-chain attach caveat**: a recorder attached AFTER one or more
   * `addX()` calls receives the seed replay but MISSES every
   * intermediate event. Attach BEFORE the first `addX()` for complete
   * capture.
   *
   * Public for now to enable direct attach in tests + early consumers.
   * L7.4 will wire `flowChart(..., { structureRecorders: [...] })` as
   * an additional registration site; this method will remain.
   */
  attachStructureRecorder(recorder: StructureRecorder): this {
    if (this._sealed) {
      throw new Error(
        `[FlowChartBuilder] attachStructureRecorder('${recorder.id}') called after .build() — chart is sealed; ` +
          'the recorder would miss every structure event from construction. Attach BEFORE .build().',
      );
    }
    if (!this._structureDispatcher) {
      this._structureDispatcher = new StructureRecorderDispatcher();
    }
    this._structureDispatcher.attach(recorder);
    // The seed fires inside `start()` — that runs BEFORE the consumer
    // can post-construct attach. Replay the seed event ONLY into the
    // just-attached recorder so other already-attached recorders don't
    // see a duplicate. Errors are routed through the dispatcher's
    // accumulator so the contract stays uniform.
    if (this._rootSpec) {
      try {
        recorder.onStageAdded?.({
          stageId: this._rootSpec.id,
          name: this._rootSpec.name,
          type: this._rootSpec.type ?? 'stage',
          ...(this._rootSpec.isPausable === true && { isPausable: true }),
          spec: this._rootSpec as unknown as FlowChartSpec,
        });
      } catch (err) {
        this._structureDispatcher.recordErrorForReplay(recorder.id, 'onStageAdded', err);
      }
    }
    return this;
  }

  /**
   * Inspect accumulated `StructureBuildError`s. Returns empty array
   * when no recorders attached OR no errors occurred. Returns a
   * defensive copy — caller mutations do not affect subsequent calls.
   *
   * **Call on the BUILDER, not the chart returned by `.build()`.**
   * Capture the builder reference before `.build()` if you need
   * post-build access:
   * ```ts
   * const builder = flowChart(...).attachStructureRecorder(rec);
   * const chart = builder.build();
   * const errors = builder.getStructureBuildErrors();
   * ```
   */
  getStructureBuildErrors(): ReturnType<StructureRecorderDispatcher['getErrors']> {
    return this._structureDispatcher?.getErrors() ?? [];
  }

  // Convenience fire helpers — no-op when no dispatcher attached. Keeps
  // every call site a one-liner without the `if (this._structureDispatcher)`
  // boilerplate everywhere.
  private _fireStageAdded(spec: SerializedPipelineStructure): void {
    if (!this._structureDispatcher) return;
    // Read `isPausable` directly from the spec — single source of truth.
    // The previous `extras` argument was a sub-builder footgun: branch
    // helpers in DeciderList/SelectorFnList went through
    // `_fireStageAddedFromSubBuilder` which dropped the extras, silently
    // losing `isPausable: true` on pausable decider/selector branches.
    const isPausable = spec.isPausable === true;
    this._structureDispatcher.fireStageAdded({
      stageId: spec.id,
      name: spec.name,
      type: spec.type ?? 'stage',
      ...(isPausable && { isPausable: true }),
      spec: spec as unknown as FlowChartSpec,
    });
  }

  private _fireEdgeAdded(from: string, to: string, kind: StructureEdgeKind, label?: string): void {
    if (!this._structureDispatcher) return;
    this._structureDispatcher.fireEdgeAdded({
      from,
      to,
      kind,
      ...(label !== undefined && { label }),
    });
  }

  private _fireLoopEdgeAdded(from: string, to: string): void {
    if (!this._structureDispatcher) return;
    this._structureDispatcher.fireLoopEdgeAdded({ from, to });
  }

  /**
   * Fire the `next` edge(s) from a parent spec to a freshly-added
   * node — with convergence expansion when the parent is a
   * fork / decider / selector with branches.
   *
   * A fork at `parent` is semantically `parent ──fork-branch──► child[i]`
   * for each child, and the chained `.addFunction(X)` continues
   * AFTER the fork converges. The runtime semantics are that each
   * child INDEPENDENTLY feeds `X` (parallel completion → join). The
   * literal "edge from parent to X" would misrepresent this —
   * visualizers and topological algorithms would see one edge where
   * there should be N convergence edges.
   *
   * Fix: when `parentSpec` has branch children (fork or branched
   * decider/selector), fire one `next` edge from EACH child to the
   * target. Otherwise fire the single edge from `parentSpec` itself.
   *
   * Loop-reference children (synthetic spec nodes created by
   * `.loopTo()`) are excluded — they're back-edge markers, not
   * convergence sources.
   *
   * Call ORDER constraint: must be called BEFORE the cursor advances
   * to the new target. The caller passes the PRE-ADVANCE parent spec.
   */
  private _fireNextEdgeFromParent(parentSpec: SerializedPipelineStructure, targetId: string, label?: string): void {
    if (!this._structureDispatcher) return;
    const childSpecs = parentSpec.children;
    const isBranchingParent =
      (parentSpec.type === 'fork' || parentSpec.type === 'decider' || parentSpec.type === 'selector') &&
      Array.isArray(childSpecs) &&
      childSpecs.length > 0;
    if (!isBranchingParent) {
      this._fireEdgeAdded(parentSpec.id, targetId, 'next', label);
      return;
    }
    for (const child of childSpecs!) {
      if (child.isLoopReference) continue;
      this._fireEdgeAdded(child.id, targetId, 'next', label);
    }
  }

  private _fireDeciderComplete(
    decider: string,
    type: 'decider' | 'selector',
    branchIds: string[],
    defaultBranch?: string,
  ): void {
    if (!this._structureDispatcher) return;
    this._structureDispatcher.fireDeciderComplete({
      decider,
      type,
      branchIds,
      ...(defaultBranch !== undefined && { defaultBranch }),
    });
  }

  private _fireSubflowMounted(
    subflowId: string,
    subflowName: string,
    rootStageId: string,
    isLazy?: boolean,
    subflowSpec?: SerializedPipelineStructure,
    subflowPath?: string,
  ): void {
    if (!this._structureDispatcher) return;
    // subflowPath defaults to subflowId when the recorder is attached
    // to the immediate parent (top-level mount); composed paths apply
    // only when this builder is itself a nested subflow being
    // observed by the grandparent's recorder.
    const path = subflowPath ?? subflowId;
    this._structureDispatcher.fireSubflowMounted({
      subflowId,
      subflowName,
      rootStageId,
      ...(isLazy === true && { isLazy }),
      ...(subflowSpec !== undefined && { subflowSpec }),
      subflowPath: path,
    });
  }

  /** Sub-builder access (`.b._fireXxx`) is needed by DeciderList /
   *  SelectorFnList; expose the dispatcher through internal helpers
   *  that go through the same no-op-when-absent guard.
   *
   *  @internal — these methods are exposed because TypeScript `private`
   *  doesn't traverse class boundaries. Consumer code MUST NOT call
   *  them; calling them post-construction lets a hostile caller
   *  fabricate structure events and corrupt downstream visualizations
   *  or audit trails. The `_` prefix is intentional convention. */
  _fireEdgeAddedFromSubBuilder(from: string, to: string, kind: StructureEdgeKind, label?: string): void {
    this._fireEdgeAdded(from, to, kind, label);
  }

  /** @internal — see `_fireEdgeAddedFromSubBuilder`. */
  _fireStageAddedFromSubBuilder(spec: SerializedPipelineStructure): void {
    this._fireStageAdded(spec);
  }

  /** @internal — see `_fireEdgeAddedFromSubBuilder`. */
  _fireDeciderCompleteFromSubBuilder(
    decider: string,
    type: 'decider' | 'selector',
    branchIds: string[],
    defaultBranch?: string,
  ): void {
    this._fireDeciderComplete(decider, type, branchIds, defaultBranch);
  }

  /** @internal — see `_fireEdgeAddedFromSubBuilder`. */
  _fireSubflowMountedFromSubBuilder(
    subflowId: string,
    subflowName: string,
    rootStageId: string,
    isLazy?: boolean,
    subflowSpec?: SerializedPipelineStructure,
    subflowPath?: string,
  ): void {
    this._fireSubflowMounted(subflowId, subflowName, rootStageId, isLazy, subflowSpec, subflowPath);
  }

  // ── Description helpers ──

  private _appendDescriptionLine(name: string, description?: string): void {
    this._stepCounter++;
    this._stageStepMap.set(name, this._stepCounter);
    const line = description ? `${this._stepCounter}. ${name} — ${description}` : `${this._stepCounter}. ${name}`;
    this._descriptionParts.push(line);
    if (description) {
      this._stageDescriptions.set(name, description);
    }
  }

  private _appendSubflowDescription(id: string, name: string, subflow: FlowChart<any, any>): void {
    this._stepCounter++;
    this._stageStepMap.set(id, this._stepCounter);
    if (subflow.description) {
      this._descriptionParts.push(`${this._stepCounter}. [Sub-Execution: ${name}] — ${subflow.description}`);
      const lines = subflow.description.split('\n');
      const stepsIdx = lines.findIndex((l) => l.startsWith('Steps:'));
      if (stepsIdx >= 0) {
        for (let i = stepsIdx + 1; i < lines.length; i++) {
          if (lines[i].trim()) this._descriptionParts.push(`   ${lines[i]}`);
        }
      }
    } else {
      this._descriptionParts.push(`${this._stepCounter}. [Sub-Execution: ${name}]`);
    }
  }

  // ── Configuration ──

  setLogger(logger: ILogger): this {
    this._logger = logger;
    return this;
  }

  /**
   * Declare the API contract — input validation, output shape, and output mapper.
   * Replaces setInputSchema() + setOutputSchema() + setOutputMapper() in a single call.
   *
   * If a contract with input schema is declared, chart.run() validates input automatically.
   * Contract data is used by chart.toOpenAPI() and chart.toMCPTool().
   */
  contract(opts: {
    input?: unknown;
    output?: unknown;
    mapper?: (finalScope: Record<string, unknown>) => unknown;
  }): this {
    if (opts.input) this._inputSchema = opts.input;
    if (opts.output) this._outputSchema = opts.output;
    if (opts.mapper) this._outputMapper = opts.mapper;
    return this;
  }

  // ── Linear Chaining ──

  start(
    name: string,
    fn: StageFunction<TOut, TScope> | PausableHandler<TScope>,
    id: string,
    description?: string,
  ): this {
    if (this._root) fail('root already defined; create a new builder');

    // Detect PausableHandler by duck-typing (has .execute property)
    // eslint-disable-next-line no-restricted-syntax
    const isPausable = typeof fn === 'object' && fn !== null && 'execute' in fn;
    const stageFn = isPausable
      ? ((fn as PausableHandler<TScope>).execute as StageFunction<TOut, TScope>)
      : (fn as StageFunction<TOut, TScope>);

    const node: StageNode<TOut, TScope> = { name, id, fn: stageFn };
    if (isPausable) {
      node.isPausable = true;
      node.resumeFn = (fn as PausableHandler<TScope>).resume;
    }
    if (description) node.description = description;
    this._addToMap(id, stageFn);

    const spec: SerializedPipelineStructure = { name, id, type: 'stage' };
    if (isPausable) spec.isPausable = true;
    if (description) spec.description = description;

    this._root = node;
    this._rootSpec = spec;
    this._cursor = node;
    this._advanceCursorSpec(spec);
    this._knownStageIds.add(id);

    // L7.3 — Seed node fires `onStageAdded` (no edge — no predecessor).
    // `isPausable` is read directly from the spec by `_fireStageAdded`.
    this._fireStageAdded(spec);

    this._appendDescriptionLine(name, description);
    return this;
  }

  addFunction(name: string, fn: StageFunction<TOut, TScope>, id: string, description?: string): this {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();
    // Capture the parent SPEC reference (not just id) BEFORE the
    // cursor advances — we need its `children` + `type` to decide
    // whether the `next` edge is a fork convergence (N edges from
    // each branch child) vs a plain linear chain (1 edge from parent).
    const parentSpec = curSpec;

    const node: StageNode<TOut, TScope> = { name, id, fn };
    if (description) node.description = description;
    this._addToMap(id, fn);

    const spec: SerializedPipelineStructure = { name, id, type: 'stage' };
    if (description) spec.description = description;

    cur.next = node;
    curSpec.next = spec;
    this._cursor = node;
    this._advanceCursorSpec(spec);
    this._knownStageIds.add(id);

    // L7.3 — Linear node: announce the node first, then the edge
    // from the prior cursor. Order matters: endpoints announced
    // before any edge referencing them (StructureRecorder contract).
    this._fireStageAdded(spec);
    this._fireNextEdgeFromParent(parentSpec, id);

    this._appendDescriptionLine(name, description);
    return this;
  }

  addStreamingFunction(
    name: string,
    fn: StageFunction<TOut, TScope>,
    id: string,
    streamId?: string,
    description?: string,
  ): this {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();
    const parentSpec = curSpec;

    const node: StageNode<TOut, TScope> = {
      name,
      id,
      fn,
      isStreaming: true,
      streamId: streamId ?? name,
    };
    if (description) node.description = description;
    this._addToMap(id, fn);

    const spec: SerializedPipelineStructure = {
      name,
      id,
      type: 'streaming',
      isStreaming: true,
      streamId: streamId ?? name,
    };
    if (description) spec.description = description;

    cur.next = node;
    curSpec.next = spec;
    this._cursor = node;
    this._advanceCursorSpec(spec);
    this._knownStageIds.add(id);

    // L7.3 — Streaming stage: same shape as linear addFunction.
    this._fireStageAdded(spec);
    this._fireNextEdgeFromParent(parentSpec, id);

    this._appendDescriptionLine(name, description);
    return this;
  }

  /**
   * Add a pausable stage — can pause execution and resume later with input.
   *
   * The handler has two phases:
   * - `execute`: runs first time. Return `{ pause: true }` to pause.
   * - `resume`: runs when the flowchart is resumed with input.
   *
   * @example
   * ```typescript
   * .addPausableFunction('ApproveOrder', {
   *   execute: async (scope) => {
   *     scope.orderId = '123';
   *     return { pause: true, data: { question: 'Approve?' } };
   *   },
   *   resume: async (scope, input) => {
   *     scope.approved = input.approved;
   *   },
   * }, 'approve-order', 'Manager approval gate')
   * ```
   */
  addPausableFunction(name: string, handler: PausableHandler<TScope>, id: string, description?: string): this {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();
    const parentSpec = curSpec;

    const node: StageNode<TOut, TScope> = {
      name,
      id,
      fn: handler.execute as StageFunction<TOut, TScope>,
      isPausable: true,
      resumeFn: handler.resume,
    };
    if (description) node.description = description;
    this._addToMap(id, handler.execute as StageFunction<TOut, TScope>);

    const spec: SerializedPipelineStructure = {
      name,
      id,
      type: 'stage',
      isPausable: true,
    };
    if (description) spec.description = description;

    cur.next = node;
    curSpec.next = spec;
    this._cursor = node;
    this._advanceCursorSpec(spec);
    this._knownStageIds.add(id);

    // L7.3 — Pausable stage: `_fireStageAdded` reads `isPausable`
    // directly from `spec.isPausable` (set above), so visualisers
    // see it on the event payload without a separate threading arg.
    this._fireStageAdded(spec);
    this._fireNextEdgeFromParent(parentSpec, id);

    this._appendDescriptionLine(name, description);
    return this;
  }

  // ── Detach (builder-native composition) ──
  //
  // Sugar over `addFunction` that generates a stage which calls
  // `scope.$detachAndForget(...)` or `scope.$detachAndJoinLater(...)`
  // at runtime. ZERO engine changes — pure composition over the
  // existing scope-method primitives.
  //
  // For `addDetachAndJoinLater`, the returned handle is stored in
  // shared state via `$setValue` (which bypasses the typed-proxy
  // unwrap that would otherwise strip the handle's class methods).
  // Downstream stages read it via `scope[options.handleKey]` or
  // `scope.$getValue(options.handleKey)` — both preserve methods
  // because the value was stored raw.

  /**
   * Add a stage that fires a child flowchart on the given driver and
   * DISCARDS the handle. Pure fire-and-forget — useful for telemetry
   * exports, audit log shipping, cache warm-up.
   *
   * @param id Stable id for this stage (also the stageMap key).
   * @param child The child flowchart to detach.
   * @param options.driver The driver to schedule on (e.g. `microtaskBatchDriver`).
   * @param options.inputMapper Maps the parent's scope to the child's input.
   *   Defaults to passing `undefined`.
   * @param options.mountName Display name; defaults to `id`.
   * @param options.description Stage description for narrative + tools.
   *
   * @example
   * ```ts
   * import { microtaskBatchDriver } from 'footprintjs/detach';
   *
   * flowChart('process', processFn, 'process')
   *   .addDetachAndForget('telemetry', telemetryChart, {
   *     driver: microtaskBatchDriver,
   *     inputMapper: (scope) => ({ event: 'processed', orderId: scope.orderId }),
   *   })
   *   .addFunction('next', nextFn, 'next')
   *   .build();
   * ```
   */
  addDetachAndForget(
    id: string,
    child: import('./types.js').FlowChart<any, any>,
    options: {
      driver: import('../detach/types.js').DetachDriver;
      inputMapper?: (scope: TScope) => unknown;
      mountName?: string;
      description?: string;
    },
  ): this {
    const name = options.mountName ?? id;
    return this.addFunction(
      name,
      ((scope: any) => {
        const input = options.inputMapper ? options.inputMapper(scope as TScope) : undefined;
        scope.$detachAndForget(options.driver, child, input);
      }) as StageFunction<TOut, TScope>,
      id,
      options.description,
    );
  }

  /**
   * Add a stage that fires a child flowchart on the given driver and
   * delivers the resulting `DetachHandle` to a consumer-supplied
   * `onHandle` callback. The handle CANNOT be stored in shared state
   * — `StageContext.setValue` calls `structuredClone` which drops
   * class prototypes (and therefore the handle's `.wait()` method).
   *
   * The callback pattern is the explicit alternative: keep handles in
   * a closure-local array (or whatever shape suits) and have a
   * downstream stage `await Promise.all(...)` over them.
   *
   * @example
   * ```ts
   * import { microtaskBatchDriver } from 'footprintjs/detach';
   * import type { DetachHandle } from 'footprintjs/detach';
   *
   * const handles: DetachHandle[] = [];
   *
   * const chart = flowChart('seed', seedFn, 'seed')
   *   .addDetachAndJoinLater('eval-a', evalChart, {
   *     driver: microtaskBatchDriver,
   *     inputMapper: (scope) => scope.configA,
   *     onHandle: (h) => handles.push(h),
   *   })
   *   .addDetachAndJoinLater('eval-b', evalChart, {
   *     driver: microtaskBatchDriver,
   *     inputMapper: (scope) => scope.configB,
   *     onHandle: (h) => handles.push(h),
   *   })
   *   .addFunction('join', async (scope) => {
   *     const settled = await Promise.all(handles.map((h) => h.wait()));
   *     scope.results = settled;
   *   }, 'join')
   *   .build();
   * ```
   *
   * Note: putting `handles` in a module-level closure is fine for
   * single-run scripts. For server code that runs the same chart
   * concurrently across requests, allocate a new closure per run
   * (e.g., wrap chart construction in a factory function) so handles
   * from different runs don't bleed into each other.
   */
  addDetachAndJoinLater(
    id: string,
    child: import('./types.js').FlowChart<any, any>,
    options: {
      driver: import('../detach/types.js').DetachDriver;
      onHandle: (handle: import('../detach/types.js').DetachHandle) => void;
      inputMapper?: (scope: TScope) => unknown;
      mountName?: string;
      description?: string;
    },
  ): this {
    const name = options.mountName ?? id;
    return this.addFunction(
      name,
      ((scope: any) => {
        const input = options.inputMapper ? options.inputMapper(scope as TScope) : undefined;
        const handle = scope.$detachAndJoinLater(options.driver, child, input);
        options.onHandle(handle);
      }) as StageFunction<TOut, TScope>,
      id,
      options.description,
    );
  }

  // ── Branching ──

  addDeciderFunction(
    name: string,
    fn: StageFunction<any, TScope>,
    id: string,
    description?: string,
  ): DeciderList<TOut, TScope> {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();
    const parentSpec = curSpec;

    if (cur.deciderFn) fail(`decider already defined at '${cur.name}'`);

    const node: StageNode<TOut, TScope> = { name, id, fn };
    if (description) node.description = description;
    this._addToMap(id, fn);

    const spec: SerializedPipelineStructure = { name, id, type: 'stage', hasDecider: true };
    if (description) spec.description = description;

    cur.next = node;
    curSpec.next = spec;
    this._cursor = node;
    this._advanceCursorSpec(spec);
    this._knownStageIds.add(id);

    // L7.3 — Decider node is reached via a `next` edge from the prior
    // cursor. Branches themselves fire via `addFunctionBranch` etc.
    // `onDeciderComplete` fires from sub-builder `.end()`.
    this._fireStageAdded(spec);
    this._fireNextEdgeFromParent(parentSpec, id);

    this._stepCounter++;
    this._stageStepMap.set(name, this._stepCounter);

    return new DeciderList<TOut, TScope>(
      this,
      node,
      spec,
      this._descriptionParts,
      this._stageDescriptions,
      this._stepCounter,
      description,
    );
  }

  addSelectorFunction(
    name: string,
    fn: StageFunction<any, TScope>,
    id: string,
    description?: string,
  ): SelectorFnList<TOut, TScope> {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();
    const parentSpec = curSpec;

    if (cur.selectorFn) fail(`selector already defined at '${cur.name}'`);
    if (cur.deciderFn) fail(`decider and selector are mutually exclusive at '${cur.name}'`);

    const node: StageNode<TOut, TScope> = { name, id, fn };
    if (description) node.description = description;
    this._addToMap(id, fn);

    const spec: SerializedPipelineStructure = { name, id, type: 'stage', hasSelector: true };
    if (description) spec.description = description;

    cur.next = node;
    curSpec.next = spec;
    this._cursor = node;
    this._advanceCursorSpec(spec);
    this._knownStageIds.add(id);

    // L7.3 — Selector node: same as decider. Branches + complete event
    // come from the SelectorFnList sub-builder.
    this._fireStageAdded(spec);
    this._fireNextEdgeFromParent(parentSpec, id);

    this._stepCounter++;
    this._stageStepMap.set(name, this._stepCounter);

    return new SelectorFnList<TOut, TScope>(
      this,
      node,
      spec,
      this._descriptionParts,
      this._stageDescriptions,
      this._stepCounter,
      description,
    );
  }

  // ── Parallel (Fork) ──

  addListOfFunction(children: SimplifiedParallelSpec<TOut, TScope>[], options?: { failFast?: boolean }): this {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();
    const forkId = cur.id;

    curSpec.type = 'fork';
    if (options?.failFast) cur.failFast = true;

    for (const { id, name, fn } of children) {
      if (!id) fail(`child id required under '${cur.name}'`);
      if (cur.children?.some((c) => c.id === id)) {
        fail(`duplicate child id '${id}' under '${cur.name}'`);
      }

      const node: StageNode<TOut, TScope> = { name: name ?? id, id };
      if (fn) {
        node.fn = fn;
        this._addToMap(id, fn);
      }

      const spec: SerializedPipelineStructure = {
        name: name ?? id,
        id,
        type: 'stage',
        isParallelChild: true,
        parallelGroupId: forkId,
      };

      cur.children = cur.children || [];
      cur.children.push(node);
      curSpec.children = curSpec.children || [];
      curSpec.children.push(spec);
      // L7.3 — fire structure events for the child + the fork edge.
      this._fireStageAdded(spec);
      this._fireEdgeAdded(curSpec.id, spec.id, 'fork-branch');
    }

    const childNames = children.map((c) => c.name || c.id).join(', ');
    this._stepCounter++;
    this._descriptionParts.push(`${this._stepCounter}. Runs in parallel: ${childNames}`);

    return this;
  }

  // ── Subflow Mounting ──

  addSubFlowChart(id: string, subflow: FlowChart<any, any>, mountName?: string, options?: SubflowMountOptions): this {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();

    if (cur.children?.some((c) => c.id === id)) {
      fail(`duplicate child id '${id}' under '${cur.name}'`);
    }

    const subflowName = mountName || id;
    const forkId = cur.id;
    const prefixedRoot = this._prefixNodeTree(subflow.root, id);

    if (!this._subflowDefs.has(id)) {
      this._subflowDefs.set(id, { root: prefixedRoot });
    }

    const node: StageNode<TOut, TScope> = {
      name: subflowName,
      id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
    };
    if (options) node.subflowMountOptions = options;

    const spec: SerializedPipelineStructure = {
      name: subflowName,
      type: 'stage',
      id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
      isParallelChild: true,
      parallelGroupId: forkId,
      subflowStructure: subflow.buildTimeStructure,
    };

    curSpec.type = 'fork';
    cur.children = cur.children || [];
    cur.children.push(node);
    curSpec.children = curSpec.children || [];
    curSpec.children.push(spec);
    this._knownStageIds.add(id);
    // L7.3 — Subflow mount: stage event + fork edge + mount lifecycle
    // event. Mount-only semantics: parent recorders do NOT replay the
    // subflow's own internal structure events.
    this._fireStageAdded(spec);
    this._fireEdgeAdded(curSpec.id, id, 'fork-branch');
    this._fireSubflowMounted(id, subflowName, id, false, subflow.buildTimeStructure);

    this._mergeStageMap(subflow.stageMap, id);
    this._mergeSubflows(subflow.subflows, id);
    this._appendSubflowDescription(id, subflowName, subflow);

    return this;
  }

  addLazySubFlowChart(
    id: string,
    resolver: () => FlowChart<TOut, TScope>,
    mountName?: string,
    options?: SubflowMountOptions,
  ): this {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();

    if (cur.children?.some((c) => c.id === id)) {
      fail(`duplicate child id '${id}' under '${cur.name}'`);
    }

    const subflowName = mountName || id;
    const forkId = cur.id;

    const node: StageNode<TOut, TScope> = {
      name: subflowName,
      id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
      subflowResolver: resolver as any,
    };
    if (options) node.subflowMountOptions = options;

    // Lazy mount stub. The lazy subflow's internals will be shaped at
    // resolution time.
    const spec: SerializedPipelineStructure = {
      name: subflowName,
      type: 'stage',
      id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
      isParallelChild: true,
      parallelGroupId: forkId,
      isLazy: true,
    };

    curSpec.type = 'fork';
    cur.children = cur.children || [];
    cur.children.push(node);
    curSpec.children = curSpec.children || [];
    curSpec.children.push(spec);
    // L7.3 — Lazy subflow parallel mount.
    this._fireStageAdded(spec);
    this._fireEdgeAdded(curSpec.id, id, 'fork-branch');
    this._fireSubflowMounted(id, subflowName, id, true);

    this._stepCounter++;
    this._stageStepMap.set(id, this._stepCounter);
    this._descriptionParts.push(`${this._stepCounter}. [Lazy Sub-Execution: ${subflowName}]`);

    return this;
  }

  addLazySubFlowChartNext(
    id: string,
    resolver: () => FlowChart<TOut, TScope>,
    mountName?: string,
    options?: SubflowMountOptions,
  ): this {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();

    if (cur.next) {
      fail(`cannot add subflow as next when next is already defined at '${cur.name}'`);
    }

    const subflowName = mountName || id;

    const node: StageNode<TOut, TScope> = {
      name: subflowName,
      id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
      subflowResolver: resolver as any,
    };
    if (options) node.subflowMountOptions = options;

    // Lazy mount stub. The lazy subflow's internals will be shaped at
    // resolution time.
    const spec: SerializedPipelineStructure = {
      name: subflowName,
      type: 'stage',
      id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
      isLazy: true,
    };

    const parentSpec = curSpec;
    cur.next = node;
    curSpec.next = spec;
    this._cursor = node;
    this._advanceCursorSpec(spec);
    // L7.3 — Lazy linear-mount subflow.
    this._fireStageAdded(spec);
    this._fireNextEdgeFromParent(parentSpec, id);
    this._fireSubflowMounted(id, subflowName, id, true);

    this._stepCounter++;
    this._stageStepMap.set(id, this._stepCounter);
    this._descriptionParts.push(`${this._stepCounter}. [Lazy Sub-Execution: ${subflowName}]`);

    return this;
  }

  addSubFlowChartNext(
    id: string,
    subflow: FlowChart<any, any>,
    mountName?: string,
    options?: SubflowMountOptions,
  ): this {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();

    if (cur.next) {
      fail(`cannot add subflow as next when next is already defined at '${cur.name}'`);
    }

    const subflowName = mountName || id;
    const prefixedRoot = this._prefixNodeTree(subflow.root, id);

    if (!this._subflowDefs.has(id)) {
      this._subflowDefs.set(id, { root: prefixedRoot });
    }

    const node: StageNode<TOut, TScope> = {
      name: subflowName,
      id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
    };
    if (options) node.subflowMountOptions = options;

    const attachedSpec: SerializedPipelineStructure = {
      name: subflowName,
      type: 'stage',
      id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
      subflowStructure: subflow.buildTimeStructure,
    };

    const parentSpec = curSpec;
    cur.next = node;
    curSpec.next = attachedSpec;
    this._cursor = node;
    this._advanceCursorSpec(attachedSpec);
    this._knownStageIds.add(id);
    // L7.3 — Linear-mount subflow.
    this._fireStageAdded(attachedSpec);
    this._fireNextEdgeFromParent(parentSpec, id);
    this._fireSubflowMounted(id, subflowName, id, false, subflow.buildTimeStructure);

    this._mergeStageMap(subflow.stageMap, id);
    this._mergeSubflows(subflow.subflows, id);
    this._appendSubflowDescription(id, subflowName, subflow);

    return this;
  }

  // ── Loop ──

  loopTo(stageId: string): this {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();

    if (curSpec.loopTarget) fail(`loopTo already defined at '${cur.name}'`);
    if (cur.next) fail(`cannot set loopTo when next is already defined at '${cur.name}'`);

    if (!this._knownStageIds.has(stageId)) {
      fail(`loopTo('${stageId}') target not found — did you pass a stage name instead of id?`);
    }

    cur.next = { name: stageId, id: stageId, isLoopRef: true };
    curSpec.loopTarget = stageId;
    curSpec.next = { name: stageId, id: stageId, type: 'loop', isLoopReference: true };

    const targetStep = this._stageStepMap.get(stageId);
    if (targetStep !== undefined) {
      this._descriptionParts.push(`→ loops back to step ${targetStep}`);
    } else {
      this._descriptionParts.push(`→ loops back to ${stageId}`);
    }

    // L7.3 — Fire the loop back-edge event. Distinct from `onEdgeAdded`
    // because runtime `onLoop` carries `iteration: number` which has no
    // build meaning — separate event keeps payloads honest.
    this._fireLoopEdgeAdded(cur.id, stageId);
    return this;
  }

  // ── Streaming ──

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

  // ── Output ──

  build(): RunnableFlowChart<TOut, TScope> {
    // L7.3 — seal the chart so post-build attaches throw. Prevents
    // recorders attached mid-execution from getting partial data.
    this._sealed = true;

    const root = this._root ?? fail('empty tree; call start() first');
    const rootSpec = this._rootSpec ?? fail('empty spec; call start() first');

    const subflows: Record<string, { root: StageNode<TOut, TScope> }> = {};
    for (const [key, def] of this._subflowDefs) {
      subflows[key] = def;
    }

    const rootName = this._root?.name ?? 'FlowChart';
    const description =
      this._descriptionParts.length > 0 ? `FlowChart: ${rootName}\nSteps:\n${this._descriptionParts.join('\n')}` : '';

    const chart: FlowChart<TOut, TScope> = {
      root,
      stageMap: this._stageMap,
      buildTimeStructure: rootSpec,
      ...(Object.keys(subflows).length > 0 ? { subflows } : {}),
      ...(this._enableNarrative ? { enableNarrative: true } : {}),
      ...(this._logger ? { logger: this._logger } : {}),
      description,
      stageDescriptions: new Map(this._stageDescriptions),
      ...(this._inputSchema ? { inputSchema: this._inputSchema } : {}),
      ...(this._outputSchema ? { outputSchema: this._outputSchema } : {}),
      ...(this._outputMapper ? { outputMapper: this._outputMapper } : {}),
      // Auto-embed TypedScope factory if none was explicitly set.
      // This means ANY way of creating a FlowChartBuilder (flowChart(), new FlowChartBuilder(),
      // or any subclass) automatically gets TypedScope — no manual setScopeFactory needed.
      scopeFactory: this._scopeFactory ?? (createTypedScopeFactory() as unknown as ScopeFactory<TScope>),
    };

    return makeRunnable(chart);
  }

  /** Override the scope factory. Rarely needed — auto-embeds TypedScope by default. */
  setScopeFactory(factory: ScopeFactory<TScope>): this {
    this._scopeFactory = factory;
    return this;
  }

  toSpec<TResult = SerializedPipelineStructure>(): TResult {
    const rootSpec = this._rootSpec ?? fail('empty tree; call start() first');
    return rootSpec as TResult;
  }

  toMermaid(): string {
    const lines: string[] = ['flowchart TD'];
    const idOf = (k: string) => (k || '').replace(/[^a-zA-Z0-9_]/g, '_') || '_';
    const root = this._root ?? fail('empty tree; call start() first');

    const walk = (n: StageNode<TOut, TScope>) => {
      const nid = idOf(n.id);
      lines.push(`${nid}["${n.name}"]`);
      for (const c of n.children || []) {
        const cid = idOf(c.id);
        lines.push(`${nid} --> ${cid}`);
        walk(c);
      }
      if (n.next) {
        const mid = idOf(n.next.id);
        lines.push(`${nid} --> ${mid}`);
        walk(n.next);
      }
    };
    walk(root);
    return lines.join('\n');
  }

  // ── Internals (exposed for helper classes) ──

  private _needCursor(): StageNode<TOut, TScope> {
    return this._cursor ?? fail('cursor undefined; call start() first');
  }

  private _needCursorSpec(): SerializedPipelineStructure {
    return this._cursorSpec ?? fail('cursor undefined; call start() first');
  }

  /**
   * Advance the spec cursor. Retained as a method so call sites stay
   * one-liners and future cursor-related side effects have a hook.
   */
  private _advanceCursorSpec(newSpec: SerializedPipelineStructure | undefined): void {
    this._cursorSpec = newSpec;
  }

  _stageMapHas(key: string): boolean {
    return this._stageMap.has(key);
  }

  _addToMap(id: string, fn: StageFunction<TOut, TScope>) {
    if (this._stageMap.has(id)) {
      const existing = this._stageMap.get(id);
      if (existing !== fn) fail(`stageMap collision for id '${id}'`);
    }
    this._stageMap.set(id, fn);
  }

  _mergeStageMap(other: Map<string, StageFunction<TOut, TScope>>, prefix?: string) {
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

  _prefixNodeTree(node: StageNode<TOut, TScope>, prefix: string): StageNode<TOut, TScope> {
    if (!node) return node;
    const clone: StageNode<TOut, TScope> = { ...node };
    clone.name = `${prefix}/${node.name}`;
    clone.id = `${prefix}/${node.id}`;
    if (clone.subflowId) clone.subflowId = `${prefix}/${clone.subflowId}`;
    if (clone.next) clone.next = this._prefixNodeTree(clone.next, prefix);
    if (clone.children) {
      clone.children = clone.children.map((c) => this._prefixNodeTree(c, prefix));
    }
    return clone;
  }

  _mergeSubflows(subflows: Record<string, { root: StageNode<TOut, TScope> }> | undefined, prefix: string) {
    if (!subflows) return;
    for (const [key, def] of Object.entries(subflows)) {
      const prefixedKey = `${prefix}/${key}`;
      if (!this._subflowDefs.has(prefixedKey)) {
        this._subflowDefs.set(prefixedKey, {
          root: this._prefixNodeTree(def.root as StageNode<TOut, TScope>, prefix),
        });
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory Function
// ─────────────────────────────────────────────────────────────────────────────

// Overload 1: typed state with options object.
export function flowChart<TState extends object>(
  name: string,
  fn: TypedStageFunction<TState> | PausableHandler<TypedScope<TState>>,
  id: string,
  options?: FlowChartOptions,
): FlowChartBuilder<any, TypedScope<TState>>;

// Overload 2: explicit generics with options object.
export function flowChart<TOut = any, TScope = any>(
  name: string,
  fn: StageFunction<TOut, TScope> | PausableHandler<TScope>,
  id: string,
  options?: FlowChartOptions,
): FlowChartBuilder<TOut, TScope>;

// Single implementation — accepts the options bag (or undefined).
export function flowChart<TOut = any, TScope = any>(
  name: string,
  fn: StageFunction<TOut, TScope> | PausableHandler<TScope>,
  id: string,
  options?: FlowChartOptions,
): FlowChartBuilder<TOut, TScope> {
  const builder = new FlowChartBuilder<TOut, TScope>();
  // Attach StructureRecorders BEFORE start() so the seed event fires through
  // the normal dispatcher path (no replay needed). Iteration order matches
  // array order, matching the fluent `.attachStructureRecorder()` chain
  // semantics.
  if (options?.structureRecorders) {
    for (const rec of options.structureRecorders) {
      builder.attachStructureRecorder(rec);
    }
  }
  return builder.start(name, fn as any, id, options?.description);
}

// ─────────────────────────────────────────────────────────────────────────────
// Spec to StageNode Converter
// ─────────────────────────────────────────────────────────────────────────────

export function specToStageNode(spec: FlowChartSpec): StageNode<any, any> {
  const inflate = (s: FlowChartSpec): StageNode<any, any> => ({
    name: s.name,
    id: s.id,
    children: s.children?.length ? s.children.map(inflate) : undefined,
    next: s.next ? inflate(s.next) : undefined,
  });
  return inflate(spec);
}
