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

import type {
  BuildTimeExtractor,
  FlowChart,
  FlowChartSpec,
  ILogger,
  PipelineStageFunction,
  SerializedPipelineStructure,
  SimplifiedParallelSpec,
  StageNode,
  StreamHandlers,
  StreamLifecycleHandler,
  StreamTokenHandler,
  SubflowMountOptions,
  TraversalExtractor,
} from './types';

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
    fn?: PipelineStageFunction<TOut, TScope>,
    description?: string,
  ): DeciderList<TOut, TScope> {
    if (this.branchIds.has(id)) fail(`duplicate decider branch id '${id}' under '${this.curNode.name}'`);
    this.branchIds.add(id);

    const node: StageNode<TOut, TScope> = { name: name ?? id };
    if (id) node.id = id;
    if (description) node.description = description;
    if (fn) {
      node.fn = fn;
      this.b._addToMap(name, fn);
    }

    let spec: SerializedPipelineStructure = { name: name ?? id, type: 'stage' };
    if (id) spec.id = id;
    if (description) spec.description = description;
    spec = this.b._applyExtractorToNode(spec);

    this.curNode.children = this.curNode.children || [];
    this.curNode.children.push(node);
    this.curSpec.children = this.curSpec.children || [];
    this.curSpec.children.push(spec);

    this.branchDescInfo.push({ id, description });
    return this;
  }

  addSubFlowChartBranch(
    id: string,
    subflow: FlowChart<TOut, TScope>,
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

    this.b._mergeStageMap(subflow.stageMap, id);
    this.b._mergeSubflows(subflow.subflows, id);

    return this;
  }

  addBranchList(
    branches: Array<{
      id: string;
      name: string;
      fn?: PipelineStageFunction<TOut, TScope>;
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

    this.curNode.deciderFn = true;

    if (this.defaultId) {
      const defaultChild = children.find((c) => c.id === this.defaultId);
      if (defaultChild) {
        children.push({ ...defaultChild, id: 'default' });
      }
    }

    this.curSpec.branchIds = children
      .map((c) => c.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    this.curSpec.type = 'decider';

    if (this.reservedStepNumber > 0) {
      const deciderLabel = this.curNode.name;
      const branchIdList = this.branchDescInfo.map((b) => b.id).join(', ');
      const mainLine = this.deciderDescription
        ? `${this.reservedStepNumber}. ${deciderLabel} — ${this.deciderDescription}`
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
    fn?: PipelineStageFunction<TOut, TScope>,
    description?: string,
  ): SelectorFnList<TOut, TScope> {
    if (this.branchIds.has(id)) fail(`duplicate selector branch id '${id}' under '${this.curNode.name}'`);
    this.branchIds.add(id);

    const node: StageNode<TOut, TScope> = { name: name ?? id };
    if (id) node.id = id;
    if (description) node.description = description;
    if (fn) {
      node.fn = fn;
      this.b._addToMap(name, fn);
    }

    let spec: SerializedPipelineStructure = { name: name ?? id, type: 'stage' };
    if (id) spec.id = id;
    if (description) spec.description = description;
    spec = this.b._applyExtractorToNode(spec);

    this.curNode.children = this.curNode.children || [];
    this.curNode.children.push(node);
    this.curSpec.children = this.curSpec.children || [];
    this.curSpec.children.push(spec);

    this.branchDescInfo.push({ id, description });
    return this;
  }

  addSubFlowChartBranch(
    id: string,
    subflow: FlowChart<TOut, TScope>,
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

    this.b._mergeStageMap(subflow.stageMap, id);
    this.b._mergeSubflows(subflow.subflows, id);

    return this;
  }

  addBranchList(
    branches: Array<{
      id: string;
      name: string;
      fn?: PipelineStageFunction<TOut, TScope>;
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

    this.curNode.selectorFn = true;

    this.curSpec.branchIds = children
      .map((c) => c.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    this.curSpec.type = 'decider';
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
  private _stageMap = new Map<string, PipelineStageFunction<TOut, TScope>>();
  _subflowDefs = new Map<string, { root: StageNode<TOut, TScope> }>();
  private _streamHandlers: StreamHandlers = {};
  private _extractor?: TraversalExtractor;
  private _buildTimeExtractor?: BuildTimeExtractor<any>;
  private _buildTimeExtractorErrors: Array<{ message: string; error: unknown }> = [];
  private _enableNarrative = false;
  private _logger?: ILogger;
  private _descriptionParts: string[] = [];
  private _stepCounter = 0;
  private _stageDescriptions = new Map<string, string>();
  private _stageStepMap = new Map<string, number>();
  private _inputSchema?: unknown;
  private _outputSchema?: unknown;
  private _outputMapper?: (finalScope: Record<string, unknown>) => unknown;

  constructor(buildTimeExtractor?: BuildTimeExtractor<any>) {
    if (buildTimeExtractor) {
      this._buildTimeExtractor = buildTimeExtractor;
    }
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

  private _appendSubflowDescription(id: string, name: string, subflow: FlowChart<TOut, TScope>): void {
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

  setEnableNarrative(): this {
    this._enableNarrative = true;
    return this;
  }

  setLogger(logger: ILogger): this {
    this._logger = logger;
    return this;
  }

  /** Declare the input schema (readOnlyContext shape). Accepts Zod schema or JSON Schema. */
  setInputSchema(schema: unknown): this {
    this._inputSchema = schema;
    return this;
  }

  /** Declare the output schema (response shape). Accepts Zod schema or JSON Schema. */
  setOutputSchema(schema: unknown): this {
    this._outputSchema = schema;
    return this;
  }

  /** Set the output mapper that extracts the response from final scope. */
  setOutputMapper(mapper: (finalScope: Record<string, unknown>) => unknown): this {
    this._outputMapper = mapper;
    return this;
  }

  // ── Linear Chaining ──

  start(name: string, fn?: PipelineStageFunction<TOut, TScope>, id?: string, description?: string): this {
    if (this._root) fail('root already defined; create a new builder');

    const node: StageNode<TOut, TScope> = { name };
    if (id) node.id = id;
    if (description) node.description = description;
    if (fn) {
      node.fn = fn;
      this._addToMap(name, fn);
    }

    let spec: SerializedPipelineStructure = { name, type: 'stage' };
    if (id) spec.id = id;
    if (description) spec.description = description;
    spec = this._applyExtractorToNode(spec);

    this._root = node;
    this._rootSpec = spec;
    this._cursor = node;
    this._cursorSpec = spec;

    this._appendDescriptionLine(name, description);
    return this;
  }

  addFunction(name: string, fn?: PipelineStageFunction<TOut, TScope>, id?: string, description?: string): this {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();

    const node: StageNode<TOut, TScope> = { name };
    if (id) node.id = id;
    if (description) node.description = description;
    if (fn) {
      node.fn = fn;
      this._addToMap(name, fn);
    }

    let spec: SerializedPipelineStructure = { name, type: 'stage' };
    if (id) spec.id = id;
    if (description) spec.description = description;
    spec = this._applyExtractorToNode(spec);

    cur.next = node;
    curSpec.next = spec;
    this._cursor = node;
    this._cursorSpec = spec;

    this._appendDescriptionLine(name, description);
    return this;
  }

  addStreamingFunction(
    name: string,
    streamId?: string,
    fn?: PipelineStageFunction<TOut, TScope>,
    id?: string,
    description?: string,
  ): this {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();

    const node: StageNode<TOut, TScope> = {
      name,
      isStreaming: true,
      streamId: streamId ?? name,
    };
    if (id) node.id = id;
    if (description) node.description = description;
    if (fn) {
      node.fn = fn;
      this._addToMap(name, fn);
    }

    let spec: SerializedPipelineStructure = {
      name,
      type: 'streaming',
      isStreaming: true,
      streamId: streamId ?? name,
    };
    if (id) spec.id = id;
    if (description) spec.description = description;
    spec = this._applyExtractorToNode(spec);

    cur.next = node;
    curSpec.next = spec;
    this._cursor = node;
    this._cursorSpec = spec;

    this._appendDescriptionLine(name, description);
    return this;
  }

  // ── Branching ──

  addDeciderFunction(
    name: string,
    fn: PipelineStageFunction<TOut, TScope>,
    id?: string,
    description?: string,
  ): DeciderList<TOut, TScope> {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();

    if (cur.deciderFn) fail(`decider already defined at '${cur.name}'`);

    const node: StageNode<TOut, TScope> = { name };
    if (id) node.id = id;
    if (description) node.description = description;
    node.fn = fn;
    this._addToMap(name, fn);

    let spec: SerializedPipelineStructure = { name, type: 'stage', hasDecider: true };
    if (id) spec.id = id;
    if (description) spec.description = description;
    spec = this._applyExtractorToNode(spec);

    cur.next = node;
    curSpec.next = spec;
    this._cursor = node;
    this._cursorSpec = spec;

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
    fn: PipelineStageFunction<TOut, TScope>,
    id?: string,
    description?: string,
  ): SelectorFnList<TOut, TScope> {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();

    if (cur.selectorFn) fail(`selector already defined at '${cur.name}'`);
    if (cur.deciderFn) fail(`decider and selector are mutually exclusive at '${cur.name}'`);

    const node: StageNode<TOut, TScope> = { name };
    if (id) node.id = id;
    if (description) node.description = description;
    node.fn = fn;
    this._addToMap(name, fn);

    let spec: SerializedPipelineStructure = { name, type: 'stage', hasSelector: true };
    if (id) spec.id = id;
    if (description) spec.description = description;
    spec = this._applyExtractorToNode(spec);

    cur.next = node;
    curSpec.next = spec;
    this._cursor = node;
    this._cursorSpec = spec;

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
    const forkId = cur.id ?? cur.name;

    curSpec.type = 'fork';
    if (options?.failFast) cur.failFast = true;

    for (const { id, name, fn } of children) {
      if (!id) fail(`child id required under '${cur.name}'`);
      if (cur.children?.some((c) => c.id === id)) {
        fail(`duplicate child id '${id}' under '${cur.name}'`);
      }

      const node: StageNode<TOut, TScope> = { name: name ?? id };
      if (id) node.id = id;
      if (fn) {
        node.fn = fn;
        this._addToMap(name, fn);
      }

      let spec: SerializedPipelineStructure = {
        name: name ?? id,
        type: 'stage',
        isParallelChild: true,
        parallelGroupId: forkId,
      };
      if (id) spec.id = id;
      spec = this._applyExtractorToNode(spec);

      cur.children = cur.children || [];
      cur.children.push(node);
      curSpec.children = curSpec.children || [];
      curSpec.children.push(spec);
    }

    const childNames = children.map((c) => c.name || c.id).join(', ');
    this._stepCounter++;
    this._descriptionParts.push(`${this._stepCounter}. Runs in parallel: ${childNames}`);

    return this;
  }

  // ── Subflow Mounting ──

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

    const subflowName = mountName || id;
    const forkId = cur.id ?? cur.name;
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

    let spec: SerializedPipelineStructure = {
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
    spec = this._applyExtractorToNode(spec);

    curSpec.type = 'fork';
    cur.children = cur.children || [];
    cur.children.push(node);
    curSpec.children = curSpec.children || [];
    curSpec.children.push(spec);

    this._mergeStageMap(subflow.stageMap, id);
    this._mergeSubflows(subflow.subflows, id);
    this._appendSubflowDescription(id, subflowName, subflow);

    return this;
  }

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

    let attachedSpec: SerializedPipelineStructure = {
      name: subflowName,
      type: 'stage',
      id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
      subflowStructure: subflow.buildTimeStructure,
    };
    attachedSpec = this._applyExtractorToNode(attachedSpec);

    cur.next = node;
    curSpec.next = attachedSpec;
    this._cursor = node;
    this._cursorSpec = attachedSpec;

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

    cur.next = { name: stageId, id: stageId };
    curSpec.loopTarget = stageId;
    curSpec.next = { name: stageId, id: stageId, type: 'stage' };

    const targetStep = this._stageStepMap.get(stageId);
    if (targetStep !== undefined) {
      this._descriptionParts.push(`→ loops back to step ${targetStep}`);
    } else {
      this._descriptionParts.push(`→ loops back to ${stageId}`);
    }

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

  // ── Extractors ──

  addTraversalExtractor<TResult = unknown>(extractor: TraversalExtractor<TResult>): this {
    this._extractor = extractor;
    return this;
  }

  addBuildTimeExtractor<TResult = FlowChartSpec>(extractor: BuildTimeExtractor<TResult>): this {
    this._buildTimeExtractor = extractor;
    return this;
  }

  getBuildTimeExtractorErrors(): Array<{ message: string; error: unknown }> {
    return this._buildTimeExtractorErrors;
  }

  // ── Output ──

  build(): FlowChart<TOut, TScope> {
    const root = this._root ?? fail('empty tree; call start() first');
    const rootSpec = this._rootSpec ?? fail('empty spec; call start() first');

    const subflows: Record<string, { root: StageNode<TOut, TScope> }> = {};
    for (const [key, def] of this._subflowDefs) {
      subflows[key] = def;
    }

    const rootName = this._root?.name ?? 'FlowChart';
    const description =
      this._descriptionParts.length > 0 ? `FlowChart: ${rootName}\nSteps:\n${this._descriptionParts.join('\n')}` : '';

    return {
      root,
      stageMap: this._stageMap,
      extractor: this._extractor,
      buildTimeStructure: rootSpec,
      ...(Object.keys(subflows).length > 0 ? { subflows } : {}),
      ...(this._enableNarrative ? { enableNarrative: true } : {}),
      ...(this._logger ? { logger: this._logger } : {}),
      description,
      stageDescriptions: new Map(this._stageDescriptions),
      ...(this._inputSchema ? { inputSchema: this._inputSchema } : {}),
      ...(this._outputSchema ? { outputSchema: this._outputSchema } : {}),
      ...(this._outputMapper ? { outputMapper: this._outputMapper } : {}),
    };
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

  // ── Internals (exposed for helper classes) ──

  private _needCursor(): StageNode<TOut, TScope> {
    return this._cursor ?? fail('cursor undefined; call start() first');
  }

  private _needCursorSpec(): SerializedPipelineStructure {
    return this._cursorSpec ?? fail('cursor undefined; call start() first');
  }

  _applyExtractorToNode(spec: SerializedPipelineStructure): SerializedPipelineStructure {
    if (!this._buildTimeExtractor) return spec;
    try {
      return this._buildTimeExtractor(spec as any) as SerializedPipelineStructure;
    } catch (error: any) {
      this._buildTimeExtractorErrors.push({
        message: error?.message ?? String(error),
        error,
      });
      return spec;
    }
  }

  _addToMap(name: string, fn: PipelineStageFunction<TOut, TScope>) {
    if (this._stageMap.has(name)) {
      const existing = this._stageMap.get(name);
      if (existing !== fn) fail(`stageMap collision for '${name}'`);
    }
    this._stageMap.set(name, fn);
  }

  _mergeStageMap(other: Map<string, PipelineStageFunction<TOut, TScope>>, prefix?: string) {
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

export function flowChart<TOut = any, TScope = any>(
  name: string,
  fn?: PipelineStageFunction<TOut, TScope>,
  id?: string,
  buildTimeExtractor?: BuildTimeExtractor<any>,
  description?: string,
): FlowChartBuilder<TOut, TScope> {
  return new FlowChartBuilder<TOut, TScope>(buildTimeExtractor).start(name, fn, id, description);
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
