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
import { makeRunnable } from '../runner/RunnableChart.js';
import { createTypedScopeFactory } from './typedFlowChart.js';
// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────
const fail = (msg) => {
    throw new Error(`[FlowChartBuilder] ${msg}`);
};
// ─────────────────────────────────────────────────────────────────────────────
// DeciderList
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Fluent helper returned by addDeciderFunction to add branches.
 * `end()` sets `deciderFn = true` — the fn IS the decider.
 */
export class DeciderList {
    constructor(builder, curNode, curSpec, parentDescriptionParts = [], parentStageDescriptions = new Map(), reservedStepNumber = 0, deciderDescription) {
        this.branchIds = new Set();
        this.branchDescInfo = [];
        this.b = builder;
        this.curNode = curNode;
        this.curSpec = curSpec;
        this.parentDescriptionParts = parentDescriptionParts;
        this.parentStageDescriptions = parentStageDescriptions;
        this.reservedStepNumber = reservedStepNumber;
        this.deciderDescription = deciderDescription;
    }
    addFunctionBranch(id, name, fn, description) {
        if (this.branchIds.has(id))
            fail(`duplicate decider branch id '${id}' under '${this.curNode.name}'`);
        this.branchIds.add(id);
        const node = { name: name !== null && name !== void 0 ? name : id, id, branchId: id };
        if (description)
            node.description = description;
        if (fn) {
            node.fn = fn;
            this.b._addToMap(id, fn);
        }
        let spec = { name: name !== null && name !== void 0 ? name : id, id, type: 'stage' };
        if (description)
            spec.description = description;
        spec = this.b._applyExtractorToNode(spec);
        this.curNode.children = this.curNode.children || [];
        this.curNode.children.push(node);
        this.curSpec.children = this.curSpec.children || [];
        this.curSpec.children.push(spec);
        this.branchDescInfo.push({ id, description });
        return this;
    }
    addSubFlowChartBranch(id, subflow, mountName, options) {
        if (this.branchIds.has(id))
            fail(`duplicate decider branch id '${id}' under '${this.curNode.name}'`);
        this.branchIds.add(id);
        const subflowName = mountName || id;
        const prefixedRoot = this.b._prefixNodeTree(subflow.root, id);
        if (!this.b._subflowDefs.has(id)) {
            this.b._subflowDefs.set(id, { root: prefixedRoot });
        }
        const node = {
            name: subflowName,
            id,
            branchId: id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
        };
        if (options)
            node.subflowMountOptions = options;
        const spec = {
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
    addLazySubFlowChartBranch(id, resolver, mountName, options) {
        if (this.branchIds.has(id))
            fail(`duplicate decider branch id '${id}' under '${this.curNode.name}'`);
        this.branchIds.add(id);
        const subflowName = mountName || id;
        // Store resolver on the node — NO eager tree cloning
        const node = {
            name: subflowName,
            id,
            branchId: id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
            subflowResolver: resolver,
        };
        if (options)
            node.subflowMountOptions = options;
        // Spec stub — no subflowStructure (lazy)
        const spec = {
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
        return this;
    }
    addBranchList(branches) {
        for (const { id, name, fn } of branches) {
            this.addFunctionBranch(id, name, fn);
        }
        return this;
    }
    setDefault(id) {
        this.defaultId = id;
        return this;
    }
    end() {
        const children = this.curNode.children;
        if (!children || children.length === 0) {
            throw new Error(`[FlowChartBuilder] decider at '${this.curNode.name}' requires at least one branch`);
        }
        // Validate that every branch with no embedded fn is resolvable from the stageMap
        for (const child of children) {
            if (!child.fn && child.id && !child.isSubflowRoot && !child.subflowResolver) {
                const hasInMap = this.b._stageMapHas(child.id) || this.b._stageMapHas(child.name);
                if (!hasInMap) {
                    throw new Error(`[FlowChartBuilder] decider branch '${child.id}' under '${this.curNode.name}' has no function — ` +
                        `provide a fn argument to addFunctionBranch('${child.id}', ...)`);
                }
            }
        }
        this.curNode.deciderFn = true;
        // Build branchIds BEFORE appending the synthetic default — only user-specified branches
        this.curSpec.branchIds = children
            .map((c) => c.id)
            .filter((id) => typeof id === 'string' && id.length > 0);
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
        return this.b;
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// SelectorFnList (scope-based selector — mirrors DeciderList)
// ─────────────────────────────────────────────────────────────────────────────
export class SelectorFnList {
    constructor(builder, curNode, curSpec, parentDescriptionParts = [], parentStageDescriptions = new Map(), reservedStepNumber = 0, selectorDescription) {
        this.branchIds = new Set();
        this.branchDescInfo = [];
        this.b = builder;
        this.curNode = curNode;
        this.curSpec = curSpec;
        this.parentDescriptionParts = parentDescriptionParts;
        this.parentStageDescriptions = parentStageDescriptions;
        this.reservedStepNumber = reservedStepNumber;
        this.selectorDescription = selectorDescription;
    }
    addFunctionBranch(id, name, fn, description) {
        if (this.branchIds.has(id))
            fail(`duplicate selector branch id '${id}' under '${this.curNode.name}'`);
        this.branchIds.add(id);
        const node = { name: name !== null && name !== void 0 ? name : id, id, branchId: id };
        if (description)
            node.description = description;
        if (fn) {
            node.fn = fn;
            this.b._addToMap(id, fn);
        }
        let spec = { name: name !== null && name !== void 0 ? name : id, id, type: 'stage' };
        if (description)
            spec.description = description;
        spec = this.b._applyExtractorToNode(spec);
        this.curNode.children = this.curNode.children || [];
        this.curNode.children.push(node);
        this.curSpec.children = this.curSpec.children || [];
        this.curSpec.children.push(spec);
        this.branchDescInfo.push({ id, description });
        return this;
    }
    addSubFlowChartBranch(id, subflow, mountName, options) {
        if (this.branchIds.has(id))
            fail(`duplicate selector branch id '${id}' under '${this.curNode.name}'`);
        this.branchIds.add(id);
        const subflowName = mountName || id;
        const prefixedRoot = this.b._prefixNodeTree(subflow.root, id);
        if (!this.b._subflowDefs.has(id)) {
            this.b._subflowDefs.set(id, { root: prefixedRoot });
        }
        const node = {
            name: subflowName,
            id,
            branchId: id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
        };
        if (options)
            node.subflowMountOptions = options;
        const spec = {
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
    addLazySubFlowChartBranch(id, resolver, mountName, options) {
        if (this.branchIds.has(id))
            fail(`duplicate selector branch id '${id}' under '${this.curNode.name}'`);
        this.branchIds.add(id);
        const subflowName = mountName || id;
        const node = {
            name: subflowName,
            id,
            branchId: id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
            subflowResolver: resolver,
        };
        if (options)
            node.subflowMountOptions = options;
        const spec = {
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
        return this;
    }
    addBranchList(branches) {
        for (const { id, name, fn } of branches) {
            this.addFunctionBranch(id, name, fn);
        }
        return this;
    }
    end() {
        const children = this.curNode.children;
        if (!children || children.length === 0) {
            throw new Error(`[FlowChartBuilder] selector at '${this.curNode.name}' requires at least one branch`);
        }
        // Validate that every branch with no embedded fn is resolvable from the stageMap
        for (const child of children) {
            if (!child.fn && child.id && !child.isSubflowRoot && !child.subflowResolver) {
                const hasInMap = this.b._stageMapHas(child.id) || this.b._stageMapHas(child.name);
                if (!hasInMap) {
                    throw new Error(`[FlowChartBuilder] selector branch '${child.id}' under '${this.curNode.name}' has no function — ` +
                        `provide a fn argument to addFunctionBranch('${child.id}', ...)`);
                }
            }
        }
        this.curNode.selectorFn = true;
        this.curSpec.branchIds = children
            .map((c) => c.id)
            .filter((id) => typeof id === 'string' && id.length > 0);
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
                if (branchText)
                    this.parentDescriptionParts.push(`   → ${branch.id}: ${branchText}`);
                if (branch.description)
                    this.parentStageDescriptions.set(branch.id, branch.description);
            }
        }
        return this.b;
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// FlowChartBuilder
// ─────────────────────────────────────────────────────────────────────────────
export class FlowChartBuilder {
    constructor(buildTimeExtractor) {
        this._stageMap = new Map();
        this._subflowDefs = new Map();
        this._streamHandlers = {};
        this._buildTimeExtractorErrors = [];
        this._enableNarrative = false;
        this._descriptionParts = [];
        this._stepCounter = 0;
        // NOTE: keyed by stage name (for human-readable descriptions), while stageMap
        // and knownStageIds use id (stable identifier). These are intentionally different
        // namespaces — descriptions are presentational, lookups are structural.
        this._stageDescriptions = new Map();
        this._stageStepMap = new Map();
        this._knownStageIds = new Set();
        if (buildTimeExtractor) {
            this._buildTimeExtractor = buildTimeExtractor;
        }
    }
    // ── Description helpers ──
    _appendDescriptionLine(name, description) {
        this._stepCounter++;
        this._stageStepMap.set(name, this._stepCounter);
        const line = description ? `${this._stepCounter}. ${name} — ${description}` : `${this._stepCounter}. ${name}`;
        this._descriptionParts.push(line);
        if (description) {
            this._stageDescriptions.set(name, description);
        }
    }
    _appendSubflowDescription(id, name, subflow) {
        this._stepCounter++;
        this._stageStepMap.set(id, this._stepCounter);
        if (subflow.description) {
            this._descriptionParts.push(`${this._stepCounter}. [Sub-Execution: ${name}] — ${subflow.description}`);
            const lines = subflow.description.split('\n');
            const stepsIdx = lines.findIndex((l) => l.startsWith('Steps:'));
            if (stepsIdx >= 0) {
                for (let i = stepsIdx + 1; i < lines.length; i++) {
                    if (lines[i].trim())
                        this._descriptionParts.push(`   ${lines[i]}`);
                }
            }
        }
        else {
            this._descriptionParts.push(`${this._stepCounter}. [Sub-Execution: ${name}]`);
        }
    }
    // ── Configuration ──
    setLogger(logger) {
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
    contract(opts) {
        if (opts.input)
            this._inputSchema = opts.input;
        if (opts.output)
            this._outputSchema = opts.output;
        if (opts.mapper)
            this._outputMapper = opts.mapper;
        return this;
    }
    // ── Linear Chaining ──
    start(name, fn, id, description) {
        if (this._root)
            fail('root already defined; create a new builder');
        // Detect PausableHandler by duck-typing (has .execute property)
        // eslint-disable-next-line no-restricted-syntax
        const isPausable = typeof fn === 'object' && fn !== null && 'execute' in fn;
        const stageFn = isPausable
            ? fn.execute
            : fn;
        const node = { name, id, fn: stageFn };
        if (isPausable) {
            node.isPausable = true;
            node.resumeFn = fn.resume;
        }
        if (description)
            node.description = description;
        this._addToMap(id, stageFn);
        let spec = { name, id, type: 'stage' };
        if (isPausable)
            spec.isPausable = true;
        if (description)
            spec.description = description;
        spec = this._applyExtractorToNode(spec);
        this._root = node;
        this._rootSpec = spec;
        this._cursor = node;
        this._cursorSpec = spec;
        this._knownStageIds.add(id);
        this._appendDescriptionLine(name, description);
        return this;
    }
    addFunction(name, fn, id, description) {
        const cur = this._needCursor();
        const curSpec = this._needCursorSpec();
        const node = { name, id, fn };
        if (description)
            node.description = description;
        this._addToMap(id, fn);
        let spec = { name, id, type: 'stage' };
        if (description)
            spec.description = description;
        spec = this._applyExtractorToNode(spec);
        cur.next = node;
        curSpec.next = spec;
        this._cursor = node;
        this._cursorSpec = spec;
        this._knownStageIds.add(id);
        this._appendDescriptionLine(name, description);
        return this;
    }
    addStreamingFunction(name, fn, id, streamId, description) {
        const cur = this._needCursor();
        const curSpec = this._needCursorSpec();
        const node = {
            name,
            id,
            fn,
            isStreaming: true,
            streamId: streamId !== null && streamId !== void 0 ? streamId : name,
        };
        if (description)
            node.description = description;
        this._addToMap(id, fn);
        let spec = {
            name,
            id,
            type: 'streaming',
            isStreaming: true,
            streamId: streamId !== null && streamId !== void 0 ? streamId : name,
        };
        if (description)
            spec.description = description;
        spec = this._applyExtractorToNode(spec);
        cur.next = node;
        curSpec.next = spec;
        this._cursor = node;
        this._cursorSpec = spec;
        this._knownStageIds.add(id);
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
    addPausableFunction(name, handler, id, description) {
        const cur = this._needCursor();
        const curSpec = this._needCursorSpec();
        const node = {
            name,
            id,
            fn: handler.execute,
            isPausable: true,
            resumeFn: handler.resume,
        };
        if (description)
            node.description = description;
        this._addToMap(id, handler.execute);
        let spec = {
            name,
            id,
            type: 'stage',
            isPausable: true,
        };
        if (description)
            spec.description = description;
        spec = this._applyExtractorToNode(spec);
        cur.next = node;
        curSpec.next = spec;
        this._cursor = node;
        this._cursorSpec = spec;
        this._knownStageIds.add(id);
        this._appendDescriptionLine(name, description);
        return this;
    }
    // ── Branching ──
    addDeciderFunction(name, fn, id, description) {
        const cur = this._needCursor();
        const curSpec = this._needCursorSpec();
        if (cur.deciderFn)
            fail(`decider already defined at '${cur.name}'`);
        const node = { name, id, fn };
        if (description)
            node.description = description;
        this._addToMap(id, fn);
        let spec = { name, id, type: 'stage', hasDecider: true };
        if (description)
            spec.description = description;
        spec = this._applyExtractorToNode(spec);
        cur.next = node;
        curSpec.next = spec;
        this._cursor = node;
        this._cursorSpec = spec;
        this._knownStageIds.add(id);
        this._stepCounter++;
        this._stageStepMap.set(name, this._stepCounter);
        return new DeciderList(this, node, spec, this._descriptionParts, this._stageDescriptions, this._stepCounter, description);
    }
    addSelectorFunction(name, fn, id, description) {
        const cur = this._needCursor();
        const curSpec = this._needCursorSpec();
        if (cur.selectorFn)
            fail(`selector already defined at '${cur.name}'`);
        if (cur.deciderFn)
            fail(`decider and selector are mutually exclusive at '${cur.name}'`);
        const node = { name, id, fn };
        if (description)
            node.description = description;
        this._addToMap(id, fn);
        let spec = { name, id, type: 'stage', hasSelector: true };
        if (description)
            spec.description = description;
        spec = this._applyExtractorToNode(spec);
        cur.next = node;
        curSpec.next = spec;
        this._cursor = node;
        this._cursorSpec = spec;
        this._knownStageIds.add(id);
        this._stepCounter++;
        this._stageStepMap.set(name, this._stepCounter);
        return new SelectorFnList(this, node, spec, this._descriptionParts, this._stageDescriptions, this._stepCounter, description);
    }
    // ── Parallel (Fork) ──
    addListOfFunction(children, options) {
        var _a;
        const cur = this._needCursor();
        const curSpec = this._needCursorSpec();
        const forkId = cur.id;
        curSpec.type = 'fork';
        if (options === null || options === void 0 ? void 0 : options.failFast)
            cur.failFast = true;
        for (const { id, name, fn } of children) {
            if (!id)
                fail(`child id required under '${cur.name}'`);
            if ((_a = cur.children) === null || _a === void 0 ? void 0 : _a.some((c) => c.id === id)) {
                fail(`duplicate child id '${id}' under '${cur.name}'`);
            }
            const node = { name: name !== null && name !== void 0 ? name : id, id };
            if (fn) {
                node.fn = fn;
                this._addToMap(id, fn);
            }
            let spec = {
                name: name !== null && name !== void 0 ? name : id,
                id,
                type: 'stage',
                isParallelChild: true,
                parallelGroupId: forkId,
            };
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
    addSubFlowChart(id, subflow, mountName, options) {
        var _a;
        const cur = this._needCursor();
        const curSpec = this._needCursorSpec();
        if ((_a = cur.children) === null || _a === void 0 ? void 0 : _a.some((c) => c.id === id)) {
            fail(`duplicate child id '${id}' under '${cur.name}'`);
        }
        const subflowName = mountName || id;
        const forkId = cur.id;
        const prefixedRoot = this._prefixNodeTree(subflow.root, id);
        if (!this._subflowDefs.has(id)) {
            this._subflowDefs.set(id, { root: prefixedRoot });
        }
        const node = {
            name: subflowName,
            id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
        };
        if (options)
            node.subflowMountOptions = options;
        let spec = {
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
        this._knownStageIds.add(id);
        this._mergeStageMap(subflow.stageMap, id);
        this._mergeSubflows(subflow.subflows, id);
        this._appendSubflowDescription(id, subflowName, subflow);
        return this;
    }
    addLazySubFlowChart(id, resolver, mountName, options) {
        var _a;
        const cur = this._needCursor();
        const curSpec = this._needCursorSpec();
        if ((_a = cur.children) === null || _a === void 0 ? void 0 : _a.some((c) => c.id === id)) {
            fail(`duplicate child id '${id}' under '${cur.name}'`);
        }
        const subflowName = mountName || id;
        const forkId = cur.id;
        const node = {
            name: subflowName,
            id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
            subflowResolver: resolver,
        };
        if (options)
            node.subflowMountOptions = options;
        const spec = {
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
        this._stepCounter++;
        this._stageStepMap.set(id, this._stepCounter);
        this._descriptionParts.push(`${this._stepCounter}. [Lazy Sub-Execution: ${subflowName}]`);
        return this;
    }
    addLazySubFlowChartNext(id, resolver, mountName, options) {
        const cur = this._needCursor();
        const curSpec = this._needCursorSpec();
        if (cur.next) {
            fail(`cannot add subflow as next when next is already defined at '${cur.name}'`);
        }
        const subflowName = mountName || id;
        const node = {
            name: subflowName,
            id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
            subflowResolver: resolver,
        };
        if (options)
            node.subflowMountOptions = options;
        const spec = {
            name: subflowName,
            type: 'stage',
            id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
            isLazy: true,
        };
        cur.next = node;
        curSpec.next = spec;
        this._cursor = node;
        this._cursorSpec = spec;
        this._stepCounter++;
        this._stageStepMap.set(id, this._stepCounter);
        this._descriptionParts.push(`${this._stepCounter}. [Lazy Sub-Execution: ${subflowName}]`);
        return this;
    }
    addSubFlowChartNext(id, subflow, mountName, options) {
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
        const node = {
            name: subflowName,
            id,
            isSubflowRoot: true,
            subflowId: id,
            subflowName,
        };
        if (options)
            node.subflowMountOptions = options;
        let attachedSpec = {
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
        this._knownStageIds.add(id);
        this._mergeStageMap(subflow.stageMap, id);
        this._mergeSubflows(subflow.subflows, id);
        this._appendSubflowDescription(id, subflowName, subflow);
        return this;
    }
    // ── Loop ──
    loopTo(stageId) {
        const cur = this._needCursor();
        const curSpec = this._needCursorSpec();
        if (curSpec.loopTarget)
            fail(`loopTo already defined at '${cur.name}'`);
        if (cur.next)
            fail(`cannot set loopTo when next is already defined at '${cur.name}'`);
        if (!this._knownStageIds.has(stageId)) {
            fail(`loopTo('${stageId}') target not found — did you pass a stage name instead of id?`);
        }
        cur.next = { name: stageId, id: stageId, isLoopRef: true };
        curSpec.loopTarget = stageId;
        curSpec.next = { name: stageId, id: stageId, type: 'loop', isLoopReference: true };
        const targetStep = this._stageStepMap.get(stageId);
        if (targetStep !== undefined) {
            this._descriptionParts.push(`→ loops back to step ${targetStep}`);
        }
        else {
            this._descriptionParts.push(`→ loops back to ${stageId}`);
        }
        return this;
    }
    // ── Streaming ──
    onStream(handler) {
        this._streamHandlers.onToken = handler;
        return this;
    }
    onStreamStart(handler) {
        this._streamHandlers.onStart = handler;
        return this;
    }
    onStreamEnd(handler) {
        this._streamHandlers.onEnd = handler;
        return this;
    }
    // ── Extractors ──
    addTraversalExtractor(extractor) {
        this._extractor = extractor;
        return this;
    }
    addBuildTimeExtractor(extractor) {
        this._buildTimeExtractor = extractor;
        return this;
    }
    getBuildTimeExtractorErrors() {
        return this._buildTimeExtractorErrors;
    }
    // ── Output ──
    build() {
        var _a, _b, _c, _d, _e;
        const root = (_a = this._root) !== null && _a !== void 0 ? _a : fail('empty tree; call start() first');
        const rootSpec = (_b = this._rootSpec) !== null && _b !== void 0 ? _b : fail('empty spec; call start() first');
        const subflows = {};
        for (const [key, def] of this._subflowDefs) {
            subflows[key] = def;
        }
        const rootName = (_d = (_c = this._root) === null || _c === void 0 ? void 0 : _c.name) !== null && _d !== void 0 ? _d : 'FlowChart';
        const description = this._descriptionParts.length > 0 ? `FlowChart: ${rootName}\nSteps:\n${this._descriptionParts.join('\n')}` : '';
        const chart = {
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
            // Auto-embed TypedScope factory if none was explicitly set.
            // This means ANY way of creating a FlowChartBuilder (flowChart(), new FlowChartBuilder(),
            // or any subclass) automatically gets TypedScope — no manual setScopeFactory needed.
            scopeFactory: (_e = this._scopeFactory) !== null && _e !== void 0 ? _e : createTypedScopeFactory(),
        };
        return makeRunnable(chart);
    }
    /** Override the scope factory. Rarely needed — auto-embeds TypedScope by default. */
    setScopeFactory(factory) {
        this._scopeFactory = factory;
        return this;
    }
    toSpec() {
        var _a;
        const rootSpec = (_a = this._rootSpec) !== null && _a !== void 0 ? _a : fail('empty tree; call start() first');
        return rootSpec;
    }
    toMermaid() {
        var _a;
        const lines = ['flowchart TD'];
        const idOf = (k) => (k || '').replace(/[^a-zA-Z0-9_]/g, '_') || '_';
        const root = (_a = this._root) !== null && _a !== void 0 ? _a : fail('empty tree; call start() first');
        const walk = (n) => {
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
    _needCursor() {
        var _a;
        return (_a = this._cursor) !== null && _a !== void 0 ? _a : fail('cursor undefined; call start() first');
    }
    _needCursorSpec() {
        var _a;
        return (_a = this._cursorSpec) !== null && _a !== void 0 ? _a : fail('cursor undefined; call start() first');
    }
    _applyExtractorToNode(spec) {
        var _a;
        if (!this._buildTimeExtractor)
            return spec;
        try {
            return this._buildTimeExtractor(spec);
        }
        catch (error) {
            this._buildTimeExtractorErrors.push({
                message: (_a = error === null || error === void 0 ? void 0 : error.message) !== null && _a !== void 0 ? _a : String(error),
                error,
            });
            return spec;
        }
    }
    _stageMapHas(key) {
        return this._stageMap.has(key);
    }
    _addToMap(id, fn) {
        if (this._stageMap.has(id)) {
            const existing = this._stageMap.get(id);
            if (existing !== fn)
                fail(`stageMap collision for id '${id}'`);
        }
        this._stageMap.set(id, fn);
    }
    _mergeStageMap(other, prefix) {
        for (const [k, v] of other) {
            const key = prefix ? `${prefix}/${k}` : k;
            if (this._stageMap.has(key)) {
                const existing = this._stageMap.get(key);
                if (existing !== v)
                    fail(`stageMap collision while mounting flowchart at '${key}'`);
            }
            else {
                this._stageMap.set(key, v);
            }
        }
    }
    _prefixNodeTree(node, prefix) {
        if (!node)
            return node;
        const clone = { ...node };
        clone.name = `${prefix}/${node.name}`;
        clone.id = `${prefix}/${node.id}`;
        if (clone.subflowId)
            clone.subflowId = `${prefix}/${clone.subflowId}`;
        if (clone.next)
            clone.next = this._prefixNodeTree(clone.next, prefix);
        if (clone.children) {
            clone.children = clone.children.map((c) => this._prefixNodeTree(c, prefix));
        }
        return clone;
    }
    _mergeSubflows(subflows, prefix) {
        if (!subflows)
            return;
        for (const [key, def] of Object.entries(subflows)) {
            const prefixedKey = `${prefix}/${key}`;
            if (!this._subflowDefs.has(prefixedKey)) {
                this._subflowDefs.set(prefixedKey, {
                    root: this._prefixNodeTree(def.root, prefix),
                });
            }
        }
    }
}
export function flowChart(name, fn, id, buildTimeExtractor, description) {
    return new FlowChartBuilder(buildTimeExtractor).start(name, fn, id, description);
}
// ─────────────────────────────────────────────────────────────────────────────
// Spec to StageNode Converter
// ─────────────────────────────────────────────────────────────────────────────
export function specToStageNode(spec) {
    const inflate = (s) => {
        var _a;
        return ({
            name: s.name,
            id: s.id,
            children: ((_a = s.children) === null || _a === void 0 ? void 0 : _a.length) ? s.children.map(inflate) : undefined,
            next: s.next ? inflate(s.next) : undefined,
        });
    };
    return inflate(spec);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRmxvd0NoYXJ0QnVpbGRlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9saWIvYnVpbGRlci9GbG93Q2hhcnRCdWlsZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7R0FZRztBQUtILE9BQU8sRUFBMEIsWUFBWSxFQUFFLE1BQU0sNEJBQTRCLENBQUM7QUFDbEYsT0FBTyxFQUEyQix1QkFBdUIsRUFBRSxNQUFNLHFCQUFxQixDQUFDO0FBaUJ2RixnRkFBZ0Y7QUFDaEYsbUJBQW1CO0FBQ25CLGdGQUFnRjtBQUVoRixNQUFNLElBQUksR0FBRyxDQUFDLEdBQVcsRUFBUyxFQUFFO0lBQ2xDLE1BQU0sSUFBSSxLQUFLLENBQUMsc0JBQXNCLEdBQUcsRUFBRSxDQUFDLENBQUM7QUFDL0MsQ0FBQyxDQUFDO0FBRUYsZ0ZBQWdGO0FBQ2hGLGNBQWM7QUFDZCxnRkFBZ0Y7QUFFaEY7OztHQUdHO0FBQ0gsTUFBTSxPQUFPLFdBQVc7SUFhdEIsWUFDRSxPQUF1QyxFQUN2QyxPQUFnQyxFQUNoQyxPQUFvQyxFQUNwQyx5QkFBbUMsRUFBRSxFQUNyQywwQkFBK0MsSUFBSSxHQUFHLEVBQUUsRUFDeEQsa0JBQWtCLEdBQUcsQ0FBQyxFQUN0QixrQkFBMkI7UUFoQlosY0FBUyxHQUFHLElBQUksR0FBRyxFQUFVLENBQUM7UUFPOUIsbUJBQWMsR0FBZ0QsRUFBRSxDQUFDO1FBV2hGLElBQUksQ0FBQyxDQUFDLEdBQUcsT0FBTyxDQUFDO1FBQ2pCLElBQUksQ0FBQyxPQUFPLEdBQUcsT0FBTyxDQUFDO1FBQ3ZCLElBQUksQ0FBQyxPQUFPLEdBQUcsT0FBTyxDQUFDO1FBQ3ZCLElBQUksQ0FBQyxzQkFBc0IsR0FBRyxzQkFBc0IsQ0FBQztRQUNyRCxJQUFJLENBQUMsdUJBQXVCLEdBQUcsdUJBQXVCLENBQUM7UUFDdkQsSUFBSSxDQUFDLGtCQUFrQixHQUFHLGtCQUFrQixDQUFDO1FBQzdDLElBQUksQ0FB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LE1BQUEsQ0FBQyxDQUFDLFFBQVEsMENBQUUsTUFBTSxFQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUztZQUNsRSxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUztTQUMzQyxDQUFDLENBQUE7S0FBQSxDQUFDO0lBQ0gsT0FBTyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDdkIsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogRmxvd0NoYXJ0QnVpbGRlciDigJQgRmx1ZW50IEFQSSBmb3IgY29uc3RydWN0aW5nIGZsb3djaGFydCBleGVjdXRpb24gZ3JhcGhzLlxuICpcbiAqIEJ1aWxkcyBTdGFnZU5vZGUgdHJlZXMgYW5kIFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSAoSlNPTikgaW4gdGFuZGVtLlxuICogWmVybyBkZXBlbmRlbmNpZXMgb24gb2xkIGNvZGUg4oCUIG9ubHkgaW1wb3J0cyBmcm9tIGxvY2FsIHR5cGVzLlxuICpcbiAqIFRoZSBidWlsZGVyIGNyZWF0ZXMgdHdvIHBhcmFsbGVsIHN0cnVjdHVyZXM6XG4gKiAxLiBTdGFnZU5vZGUgdHJlZSDigJQgcnVudGltZSBncmFwaCB3aXRoIGVtYmVkZGVkIGZ1bmN0aW9uc1xuICogMi4gU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlIOKAlCBKU09OLXNhZmUgc3RydWN0dXJlIGZvciB2aXN1YWxpemF0aW9uXG4gKlxuICogVGhlIGV4ZWN1dGUoKSBjb252ZW5pZW5jZSBtZXRob2QgaXMgaW50ZW50aW9uYWxseSBvbWl0dGVkIOKAlFxuICogaXQgYmVsb25ncyBpbiB0aGUgcnVubmVyIGxheWVyIChQaGFzZSA1KS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFNjb3BlRmFjdG9yeSB9IGZyb20gJy4uL2VuZ2luZS90eXBlcy5qcyc7XG5pbXBvcnQgdHlwZSB7IFBhdXNhYmxlSGFuZGxlciB9IGZyb20gJy4uL3BhdXNlL3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHsgVHlwZWRTY29wZSB9IGZyb20gJy4uL3JlYWN0aXZlL3R5cGVzLmpzJztcbmltcG9ydCB7IHR5cGUgUnVubmFibGVGbG93Q2hhcnQsIG1ha2VSdW5uYWJsZSB9IGZyb20gJy4uL3J1bm5lci9SdW5uYWJsZUNoYXJ0LmpzJztcbmltcG9ydCB7IHR5cGUgVHlwZWRTdGFnZUZ1bmN0aW9uLCBjcmVhdGVUeXBlZFNjb3BlRmFjdG9yeSB9IGZyb20gJy4vdHlwZWRGbG93Q2hhcnQuanMnO1xuaW1wb3J0IHR5cGUge1xuICBCdWlsZFRpbWVFeHRyYWN0b3IsXG4gIEZsb3dDaGFydCxcbiAgRmxvd0NoYXJ0U3BlYyxcbiAgSUxvZ2dlcixcbiAgU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlLFxuICBTaW1wbGlmaWVkUGFyYWxsZWxTcGVjLFxuICBTdGFnZUZ1bmN0aW9uLFxuICBTdGFnZU5vZGUsXG4gIFN0cmVhbUhhbmRsZXJzLFxuICBTdHJlYW1MaWZlY3ljbGVIYW5kbGVyLFxuICBTdHJlYW1Ub2tlbkhhbmRsZXIsXG4gIFN1YmZsb3dNb3VudE9wdGlvbnMsXG4gIFRyYXZlcnNhbEV4dHJhY3Rvcixcbn0gZnJvbSAnLi90eXBlcy5qcyc7XG5cbi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy8gSW50ZXJuYWwgaGVscGVyc1xuLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmNvbnN0IGZhaWwgPSAobXNnOiBzdHJpbmcpOiBuZXZlciA9PiB7XG4gIHRocm93IG5ldyBFcnJvcihgW0Zsb3dDaGFydEJ1aWxkZXJdICR7bXNnfWApO1xufTtcblxuLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyBEZWNpZGVyTGlzdFxuLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbi8qKlxuICogRmx1ZW50IGhlbHBlciByZXR1cm5lZCBieSBhZGREZWNpZGVyRnVuY3Rpb24gdG8gYWRkIGJyYW5jaGVzLlxuICogYGVuZCgpYCBzZXRzIGBkZWNpZGVyRm4gPSB0cnVlYCDigJQgdGhlIGZuIElTIHRoZSBkZWNpZGVyLlxuICovXG5leHBvcnQgY2xhc3MgRGVjaWRlckxpc3Q8VE91dCA9IGFueSwgVFNjb3BlID0gYW55PiB7XG4gIHByaXZhdGUgcmVhZG9ubHkgYjogRmxvd0NoYXJ0QnVpbGRlcjxUT3V0LCBUU2NvcGU+O1xuICBwcml2YXRlIHJlYWRvbmx5IGN1ck5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+O1xuICBwcml2YXRlIHJlYWRvbmx5IGN1clNwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZTtcbiAgcHJpdmF0ZSByZWFkb25seSBicmFuY2hJZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgcHJpdmF0ZSBkZWZhdWx0SWQ/OiBzdHJpbmc7XG5cbiAgcHJpdmF0ZSByZWFkb25seSBwYXJlbnREZXNjcmlwdGlvblBhcnRzOiBzdHJpbmdbXTtcbiAgcHJpdmF0ZSByZWFkb25seSBwYXJlbnRTdGFnZURlc2NyaXB0aW9uczogTWFwPHN0cmluZywgc3RyaW5nPjtcbiAgcHJpdmF0ZSByZWFkb25seSByZXNlcnZlZFN0ZXBOdW1iZXI6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBkZWNpZGVyRGVzY3JpcHRpb24/OiBzdHJpbmc7XG4gIHByaXZhdGUgcmVhZG9ubHkgYnJhbmNoRGVzY0luZm86IEFycmF5PHsgaWQ6IHN0cmluZzsgZGVzY3JpcHRpb24/OiBzdHJpbmcgfT4gPSBbXTtcblxuICBjb25zdHJ1Y3RvcihcbiAgICBidWlsZGVyOiBGbG93Q2hhcnRCdWlsZGVyPFRPdXQsIFRTY29wZT4sXG4gICAgY3VyTm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4sXG4gICAgY3VyU3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlLFxuICAgIHBhcmVudERlc2NyaXB0aW9uUGFydHM6IHN0cmluZ1tdID0gW10sXG4gICAgcGFyZW50U3RhZ2VEZXNjcmlwdGlvbnM6IE1hcDxzdHJpbmcsIHN0cmluZz4gPSBuZXcgTWFwKCksXG4gICAgcmVzZXJ2ZWRTdGVwTnVtYmVyID0gMCxcbiAgICBkZWNpZGVyRGVzY3JpcHRpb24/OiBzdHJpbmcsXG4gICkge1xuICAgIHRoaXMuYiA9IGJ1aWxkZXI7XG4gICAgdGhpcy5jdXJOb2RlID0gY3VyTm9kZTtcbiAgICB0aGlzLmN1clNwZWMgPSBjdXJTcGVjO1xuICAgIHRoaXMucGFyZW50RGVzY3JpcHRpb25QYXJ0cyA9IHBhcmVudERlc2NyaXB0aW9uUGFydHM7XG4gICAgdGhpcy5wYXJlbnRTdGFnZURlc2NyaXB0aW9ucyA9IHBhcmVudFN0YWdlRGVzY3JpcHRpb25zO1xuICAgIHRoaXMucmVzZXJ2ZWRTdGVwTnVtYmVyID0gcmVzZXJ2ZWRTdGVwTnVtYmVyO1xuICAgIHRoaXMuZGVjaWRlckRlc2NyaXB0aW9uID0gZGVjaWRlckRlc2NyaXB0aW9uO1xuICB9XG5cbiAgYWRkRnVuY3Rpb25CcmFuY2goXG4gICAgaWQ6IHN0cmluZyxcbiAgICBuYW1lOiBzdHJpbmcsXG4gICAgZm4/OiBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4sXG4gICAgZGVzY3JpcHRpb24/OiBzdHJpbmcsXG4gICk6IERlY2lkZXJMaXN0PFRPdXQsIFRTY29wZT4ge1xuICAgIGlmICh0aGlzLmJyYW5jaElkcy5oYXMoaWQpKSBmYWlsKGBkdXBsaWNhdGUgZGVjaWRlciBicmFuY2ggaWQgJyR7aWR9JyB1bmRlciAnJHt0aGlzLmN1ck5vZGUubmFtZX0nYCk7XG4gICAgdGhpcy5icmFuY2hJZHMuYWRkKGlkKTtcblxuICAgIGNvbnN0IG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+ID0geyBuYW1lOiBuYW1lID8/IGlkLCBpZCwgYnJhbmNoSWQ6IGlkIH07XG4gICAgaWYgKGRlc2NyaXB0aW9uKSBub2RlLmRlc2NyaXB0aW9uID0gZGVzY3JpcHRpb247XG4gICAgaWYgKGZuKSB7XG4gICAgICBub2RlLmZuID0gZm47XG4gICAgICB0aGlzLmIuX2FkZFRvTWFwKGlkLCBmbik7XG4gICAgfVxuXG4gICAgbGV0IHNwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSA9IHsgbmFtZTogbmFtZSA/PyBpZCwgaWQsIHR5cGU6ICdzdGFnZScgfTtcbiAgICBpZiAoZGVzY3JpcHRpb24pIHNwZWMuZGVzY3JpcHRpb24gPSBkZXNjcmlwdGlvbjtcbiAgICBzcGVjID0gdGhpcy5iLl9hcHBseUV4dHJhY3RvclRvTm9kZShzcGVjKTtcblxuICAgIHRoaXMuY3VyTm9kZS5jaGlsZHJlbiA9IHRoaXMuY3VyTm9kZS5jaGlsZHJlbiB8fCBbXTtcbiAgICB0aGlzLmN1ck5vZGUuY2hpbGRyZW4ucHVzaChub2RlKTtcbiAgICB0aGlzLmN1clNwZWMuY2hpbGRyZW4gPSB0aGlzLmN1clNwZWMuY2hpbGRyZW4gfHwgW107XG4gICAgdGhpcy5jdXJTcGVjLmNoaWxkcmVuLnB1c2goc3BlYyk7XG5cbiAgICB0aGlzLmJyYW5jaERlc2NJbmZvLnB1c2goeyBpZCwgZGVzY3JpcHRpb24gfSk7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBhZGRTdWJGbG93Q2hhcnRCcmFuY2goXG4gICAgaWQ6IHN0cmluZyxcbiAgICBzdWJmbG93OiBGbG93Q2hhcnQ8YW55LCBhbnk+LFxuICAgIG1vdW50TmFtZT86IHN0cmluZyxcbiAgICBvcHRpb25zPzogU3ViZmxvd01vdW50T3B0aW9ucyxcbiAgKTogRGVjaWRlckxpc3Q8VE91dCwgVFNjb3BlPiB7XG4gICAgaWYgKHRoaXMuYnJhbmNoSWRzLmhhcyhpZCkpIGZhaWwoYGR1cGxpY2F0ZSBkZWNpZGVyIGJyYW5jaCBpZCAnJHtpZH0nIHVuZGVyICcke3RoaXMuY3VyTm9kZS5uYW1lfSdgKTtcbiAgICB0aGlzLmJyYW5jaElkcy5hZGQoaWQpO1xuXG4gICAgY29uc3Qgc3ViZmxvd05hbWUgPSBtb3VudE5hbWUgfHwgaWQ7XG4gICAgY29uc3QgcHJlZml4ZWRSb290ID0gdGhpcy5iLl9wcmVmaXhOb2RlVHJlZShzdWJmbG93LnJvb3QsIGlkKTtcblxuICAgIGlmICghdGhpcy5iLl9zdWJmbG93RGVmcy5oYXMoaWQpKSB7XG4gICAgICB0aGlzLmIuX3N1YmZsb3dEZWZzLnNldChpZCwgeyByb290OiBwcmVmaXhlZFJvb3QgfSk7XG4gICAgfVxuXG4gICAgY29uc3Qgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7XG4gICAgICBuYW1lOiBzdWJmbG93TmFtZSxcbiAgICAgIGlkLFxuICAgICAgYnJhbmNoSWQ6IGlkLFxuICAgICAgaXNTdWJmbG93Um9vdDogdHJ1ZSxcbiAgICAgIHN1YmZsb3dJZDogaWQsXG4gICAgICBzdWJmbG93TmFtZSxcbiAgICB9O1xuICAgIGlmIChvcHRpb25zKSBub2RlLnN1YmZsb3dNb3VudE9wdGlvbnMgPSBvcHRpb25zO1xuXG4gICAgY29uc3Qgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0ge1xuICAgICAgbmFtZTogc3ViZmxvd05hbWUsXG4gICAgICB0eXBlOiAnc3RhZ2UnLFxuICAgICAgaWQsXG4gICAgICBpc1N1YmZsb3dSb290OiB0cnVlLFxuICAgICAgc3ViZmxvd0lkOiBpZCxcbiAgICAgIHN1YmZsb3dOYW1lLFxuICAgICAgc3ViZmxvd1N0cnVjdHVyZTogc3ViZmxvdy5idWlsZFRpbWVTdHJ1Y3R1cmUsXG4gICAgfTtcblxuICAgIHRoaXMuY3VyTm9kZS5jaGlsZHJlbiA9IHRoaXMuY3VyTm9kZS5jaGlsZHJlbiB8fCBbXTtcbiAgICB0aGlzLmN1ck5vZGUuY2hpbGRyZW4ucHVzaChub2RlKTtcbiAgICB0aGlzLmN1clNwZWMuY2hpbGRyZW4gPSB0aGlzLmN1clNwZWMuY2hpbGRyZW4gfHwgW107XG4gICAgdGhpcy5jdXJTcGVjLmNoaWxkcmVuLnB1c2goc3BlYyk7XG5cbiAgICB0aGlzLmIuX21lcmdlU3RhZ2VNYXAoc3ViZmxvdy5zdGFnZU1hcCwgaWQpO1xuICAgIHRoaXMuYi5fbWVyZ2VTdWJmbG93cyhzdWJmbG93LnN1YmZsb3dzLCBpZCk7XG5cbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIGFkZExhenlTdWJGbG93Q2hhcnRCcmFuY2goXG4gICAgaWQ6IHN0cmluZyxcbiAgICByZXNvbHZlcjogKCkgPT4gRmxvd0NoYXJ0PGFueSwgYW55PixcbiAgICBtb3VudE5hbWU/OiBzdHJpbmcsXG4gICAgb3B0aW9ucz86IFN1YmZsb3dNb3VudE9wdGlvbnMsXG4gICk6IERlY2lkZXJMaXN0PFRPdXQsIFRTY29wZT4ge1xuICAgIGlmICh0aGlzLmJyYW5jaElkcy5oYXMoaWQpKSBmYWlsKGBkdXBsaWNhdGUgZGVjaWRlciBicmFuY2ggaWQgJyR7aWR9JyB1bmRlciAnJHt0aGlzLmN1ck5vZGUubmFtZX0nYCk7XG4gICAgdGhpcy5icmFuY2hJZHMuYWRkKGlkKTtcblxuICAgIGNvbnN0IHN1YmZsb3dOYW1lID0gbW91bnROYW1lIHx8IGlkO1xuXG4gICAgLy8gU3RvcmUgcmVzb2x2ZXIgb24gdGhlIG5vZGUg4oCUIE5PIGVhZ2VyIHRyZWUgY2xvbmluZ1xuICAgIGNvbnN0IG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+ID0ge1xuICAgICAgbmFtZTogc3ViZmxvd05hbWUsXG4gICAgICBpZCxcbiAgICAgIGJyYW5jaElkOiBpZCxcbiAgICAgIGlzU3ViZmxvd1Jvb3Q6IHRydWUsXG4gICAgICBzdWJmbG93SWQ6IGlkLFxuICAgICAgc3ViZmxvd05hbWUsXG4gICAgICBzdWJmbG93UmVzb2x2ZXI6IHJlc29sdmVyIGFzIGFueSxcbiAgICB9O1xuICAgIGlmIChvcHRpb25zKSBub2RlLnN1YmZsb3dNb3VudE9wdGlvbnMgPSBvcHRpb25zO1xuXG4gICAgLy8gU3BlYyBzdHViIOKAlCBubyBzdWJmbG93U3RydWN0dXJlIChsYXp5KVxuICAgIGNvbnN0IHNwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSA9IHtcbiAgICAgIG5hbWU6IHN1YmZsb3dOYW1lLFxuICAgICAgdHlwZTogJ3N0YWdlJyxcbiAgICAgIGlkLFxuICAgICAgaXNTdWJmbG93Um9vdDogdHJ1ZSxcbiAgICAgIHN1YmZsb3dJZDogaWQsXG4gICAgICBzdWJmbG93TmFtZSxcbiAgICAgIGlzTGF6eTogdHJ1ZSxcbiAgICB9O1xuXG4gICAgdGhpcy5jdXJOb2RlLmNoaWxkcmVuID0gdGhpcy5jdXJOb2RlLmNoaWxkcmVuIHx8IFtdO1xuICAgIHRoaXMuY3VyTm9kZS5jaGlsZHJlbi5wdXNoKG5vZGUpO1xuICAgIHRoaXMuY3VyU3BlYy5jaGlsZHJlbiA9IHRoaXMuY3VyU3BlYy5jaGlsZHJlbiB8fCBbXTtcbiAgICB0aGlzLmN1clNwZWMuY2hpbGRyZW4ucHVzaChzcGVjKTtcblxuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgYWRkQnJhbmNoTGlzdChcbiAgICBicmFuY2hlczogQXJyYXk8e1xuICAgICAgaWQ6IHN0cmluZztcbiAgICAgIG5hbWU6IHN0cmluZztcbiAgICAgIGZuPzogU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+O1xuICAgIH0+LFxuICApOiBEZWNpZGVyTGlzdDxUT3V0LCBUU2NvcGU+IHtcbiAgICBmb3IgKGNvbnN0IHsgaWQsIG5hbWUsIGZuIH0gb2YgYnJhbmNoZXMpIHtcbiAgICAgIHRoaXMuYWRkRnVuY3Rpb25CcmFuY2goaWQsIG5hbWUsIGZuKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBzZXREZWZhdWx0KGlkOiBzdHJpbmcpOiBEZWNpZGVyTGlzdDxUT3V0LCBUU2NvcGU+IHtcbiAgICB0aGlzLmRlZmF1bHRJZCA9IGlkO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgZW5kKCk6IEZsb3dDaGFydEJ1aWxkZXI8VE91dCwgVFNjb3BlPiB7XG4gICAgY29uc3QgY2hpbGRyZW4gPSB0aGlzLmN1ck5vZGUuY2hpbGRyZW47XG4gICAgaWYgKCFjaGlsZHJlbiB8fCBjaGlsZHJlbi5sZW5ndGggPT09IDApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgW0Zsb3dDaGFydEJ1aWxkZXJdIGRlY2lkZXIgYXQgJyR7dGhpcy5jdXJOb2RlLm5hbWV9JyByZXF1aXJlcyBhdCBsZWFzdCBvbmUgYnJhbmNoYCk7XG4gICAgfVxuXG4gICAgLy8gVmFsaWRhdGUgdGhhdCBldmVyeSBicmFuY2ggd2l0aCBubyBlbWJlZGRlZCBmbiBpcyByZXNvbHZhYmxlIGZyb20gdGhlIHN0YWdlTWFwXG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBjaGlsZHJlbikge1xuICAgICAgaWYgKCFjaGlsZC5mbiAmJiBjaGlsZC5pZCAmJiAhY2hpbGQuaXNTdWJmbG93Um9vdCAmJiAhY2hpbGQuc3ViZmxvd1Jlc29sdmVyKSB7XG4gICAgICAgIGNvbnN0IGhhc0luTWFwID0gdGhpcy5iLl9zdGFnZU1hcEhhcyhjaGlsZC5pZCkgfHwgdGhpcy5iLl9zdGFnZU1hcEhhcyhjaGlsZC5uYW1lKTtcbiAgICAgICAgaWYgKCFoYXNJbk1hcCkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIGBbRmxvd0NoYXJ0QnVpbGRlcl0gZGVjaWRlciBicmFuY2ggJyR7Y2hpbGQuaWR9JyB1bmRlciAnJHt0aGlzLmN1ck5vZGUubmFtZX0nIGhhcyBubyBmdW5jdGlvbiDigJQgYCArXG4gICAgICAgICAgICAgIGBwcm92aWRlIGEgZm4gYXJndW1lbnQgdG8gYWRkRnVuY3Rpb25CcmFuY2goJyR7Y2hpbGQuaWR9JywgLi4uKWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIHRoaXMuY3VyTm9kZS5kZWNpZGVyRm4gPSB0cnVlO1xuXG4gICAgLy8gQnVpbGQgYnJhbmNoSWRzIEJFRk9SRSBhcHBlbmRpbmcgdGhlIHN5bnRoZXRpYyBkZWZhdWx0IOKAlCBvbmx5IHVzZXItc3BlY2lmaWVkIGJyYW5jaGVzXG4gICAgdGhpcy5jdXJTcGVjLmJyYW5jaElkcyA9IGNoaWxkcmVuXG4gICAgICAubWFwKChjKSA9PiBjLmlkKVxuICAgICAgLmZpbHRlcigoaWQpOiBpZCBpcyBzdHJpbmcgPT4gdHlwZW9mIGlkID09PSAnc3RyaW5nJyAmJiBpZC5sZW5ndGggPiAwKTtcbiAgICB0aGlzLmN1clNwZWMudHlwZSA9ICdkZWNpZGVyJztcblxuICAgIGlmICh0aGlzLmRlZmF1bHRJZCkge1xuICAgICAgY29uc3QgZGVmYXVsdENoaWxkID0gY2hpbGRyZW4uZmluZCgoYykgPT4gYy5pZCA9PT0gdGhpcy5kZWZhdWx0SWQpO1xuICAgICAgaWYgKGRlZmF1bHRDaGlsZCkge1xuICAgICAgICBjaGlsZHJlbi5wdXNoKHsgLi4uZGVmYXVsdENoaWxkLCBpZDogJ2RlZmF1bHQnLCBicmFuY2hJZDogJ2RlZmF1bHQnIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmICh0aGlzLnJlc2VydmVkU3RlcE51bWJlciA+IDApIHtcbiAgICAgIGNvbnN0IGRlY2lkZXJMYWJlbCA9IHRoaXMuY3VyTm9kZS5uYW1lO1xuICAgICAgY29uc3QgYnJhbmNoSWRMaXN0ID0gdGhpcy5icmFuY2hEZXNjSW5mby5tYXAoKGIpID0+IGIuaWQpLmpvaW4oJywgJyk7XG4gICAgICBjb25zdCBtYWluTGluZSA9IHRoaXMuZGVjaWRlckRlc2NyaXB0aW9uXG4gICAgICAgID8gYCR7dGhpcy5yZXNlcnZlZFN0ZXBOdW1iZXJ9LiAke2RlY2lkZXJMYWJlbH0g4oCUICR7dGhpcy5kZWNpZGVyRGVzY3JpcHRpb259IChicmFuY2hlczogJHticmFuY2hJZExpc3R9KWBcbiAgICAgICAgOiBgJHt0aGlzLnJlc2VydmVkU3RlcE51bWJlcn0uICR7ZGVjaWRlckxhYmVsfSDigJQgRGVjaWRlcyBiZXR3ZWVuOiAke2JyYW5jaElkTGlzdH1gO1xuICAgICAgdGhpcy5wYXJlbnREZXNjcmlwdGlvblBhcnRzLnB1c2gobWFpbkxpbmUpO1xuXG4gICAgICBpZiAodGhpcy5kZWNpZGVyRGVzY3JpcHRpb24pIHtcbiAgICAgICAgdGhpcy5wYXJlbnRTdGFnZURlc2NyaXB0aW9ucy5zZXQodGhpcy5jdXJOb2RlLm5hbWUsIHRoaXMuZGVjaWRlckRlc2NyaXB0aW9uKTtcbiAgICAgIH1cblxuICAgICAgZm9yIChjb25zdCBicmFuY2ggb2YgdGhpcy5icmFuY2hEZXNjSW5mbykge1xuICAgICAgICBjb25zdCBicmFuY2hUZXh0ID0gYnJhbmNoLmRlc2NyaXB0aW9uO1xuICAgICAgICBpZiAoYnJhbmNoVGV4dCkge1xuICAgICAgICAgIHRoaXMucGFyZW50RGVzY3JpcHRpb25QYXJ0cy5wdXNoKGAgICDihpIgJHticmFuY2guaWR9OiAke2JyYW5jaFRleHR9YCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGJyYW5jaC5kZXNjcmlwdGlvbikge1xuICAgICAgICAgIHRoaXMucGFyZW50U3RhZ2VEZXNjcmlwdGlvbnMuc2V0KGJyYW5jaC5pZCwgYnJhbmNoLmRlc2NyaXB0aW9uKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiB0aGlzLmI7XG4gIH1cbn1cblxuLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyBTZWxlY3RvckZuTGlzdCAoc2NvcGUtYmFzZWQgc2VsZWN0b3Ig4oCUIG1pcnJvcnMgRGVjaWRlckxpc3QpXG4vLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuZXhwb3J0IGNsYXNzIFNlbGVjdG9yRm5MaXN0PFRPdXQgPSBhbnksIFRTY29wZSA9IGFueT4ge1xuICBwcml2YXRlIHJlYWRvbmx5IGI6IEZsb3dDaGFydEJ1aWxkZXI8VE91dCwgVFNjb3BlPjtcbiAgcHJpdmF0ZSByZWFkb25seSBjdXJOb2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPjtcbiAgcHJpdmF0ZSByZWFkb25seSBjdXJTcGVjOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmU7XG4gIHByaXZhdGUgcmVhZG9ubHkgYnJhbmNoSWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgcHJpdmF0ZSByZWFkb25seSBwYXJlbnREZXNjcmlwdGlvblBhcnRzOiBzdHJpbmdbXTtcbiAgcHJpdmF0ZSByZWFkb25seSBwYXJlbnRTdGFnZURlc2NyaXB0aW9uczogTWFwPHN0cmluZywgc3RyaW5nPjtcbiAgcHJpdmF0ZSByZWFkb25seSByZXNlcnZlZFN0ZXBOdW1iZXI6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBzZWxlY3RvckRlc2NyaXB0aW9uPzogc3RyaW5nO1xuICBwcml2YXRlIHJlYWRvbmx5IGJyYW5jaERlc2NJbmZvOiBBcnJheTx7IGlkOiBzdHJpbmc7IGRlc2NyaXB0aW9uPzogc3RyaW5nIH0+ID0gW107XG5cbiAgY29uc3RydWN0b3IoXG4gICAgYnVpbGRlcjogRmxvd0NoYXJ0QnVpbGRlcjxUT3V0LCBUU2NvcGU+LFxuICAgIGN1ck5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+LFxuICAgIGN1clNwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSxcbiAgICBwYXJlbnREZXNjcmlwdGlvblBhcnRzOiBzdHJpbmdbXSA9IFtdLFxuICAgIHBhcmVudFN0YWdlRGVzY3JpcHRpb25zOiBNYXA8c3RyaW5nLCBzdHJpbmc+ID0gbmV3IE1hcCgpLFxuICAgIHJlc2VydmVkU3RlcE51bWJlciA9IDAsXG4gICAgc2VsZWN0b3JEZXNjcmlwdGlvbj86IHN0cmluZyxcbiAgKSB7XG4gICAgdGhpcy5iID0gYnVpbGRlcjtcbiAgICB0aGlzLmN1ck5vZGUgPSBjdXJOb2RlO1xuICAgIHRoaXMuY3VyU3BlYyA9IGN1clNwZWM7XG4gICAgdGhpcy5wYXJlbnREZXNjcmlwdGlvblBhcnRzID0gcGFyZW50RGVzY3JpcHRpb25QYXJ0cztcbiAgICB0aGlzLnBhcmVudFN0YWdlRGVzY3JpcHRpb25zID0gcGFyZW50U3RhZ2VEZXNjcmlwdGlvbnM7XG4gICAgdGhpcy5yZXNlcnZlZFN0ZXBOdW1iZXIgPSByZXNlcnZlZFN0ZXBOdW1iZXI7XG4gICAgdGhpcy5zZWxlY3RvckRlc2NyaXB0aW9uID0gc2VsZWN0b3JEZXNjcmlwdGlvbjtcbiAgfVxuXG4gIGFkZEZ1bmN0aW9uQnJhbmNoKFxuICAgIGlkOiBzdHJpbmcsXG4gICAgbmFtZTogc3RyaW5nLFxuICAgIGZuPzogU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+LFxuICAgIGRlc2NyaXB0aW9uPzogc3RyaW5nLFxuICApOiBTZWxlY3RvckZuTGlzdDxUT3V0LCBUU2NvcGU+IHtcbiAgICBpZiAodGhpcy5icmFuY2hJZHMuaGFzKGlkKSkgZmFpbChgZHVwbGljYXRlIHNlbGVjdG9yIGJyYW5jaCBpZCAnJHtpZH0nIHVuZGVyICcke3RoaXMuY3VyTm9kZS5uYW1lfSdgKTtcbiAgICB0aGlzLmJyYW5jaElkcy5hZGQoaWQpO1xuXG4gICAgY29uc3Qgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7IG5hbWU6IG5hbWUgPz8gaWQsIGlkLCBicmFuY2hJZDogaWQgfTtcbiAgICBpZiAoZGVzY3JpcHRpb24pIG5vZGUuZGVzY3JpcHRpb24gPSBkZXNjcmlwdGlvbjtcbiAgICBpZiAoZm4pIHtcbiAgICAgIG5vZGUuZm4gPSBmbjtcbiAgICAgIHRoaXMuYi5fYWRkVG9NYXAoaWQsIGZuKTtcbiAgICB9XG5cbiAgICBsZXQgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0geyBuYW1lOiBuYW1lID8/IGlkLCBpZCwgdHlwZTogJ3N0YWdlJyB9O1xuICAgIGlmIChkZXNjcmlwdGlvbikgc3BlYy5kZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uO1xuICAgIHNwZWMgPSB0aGlzLmIuX2FwcGx5RXh0cmFjdG9yVG9Ob2RlKHNwZWMpO1xuXG4gICAgdGhpcy5jdXJOb2RlLmNoaWxkcmVuID0gdGhpcy5jdXJOb2RlLmNoaWxkcmVuIHx8IFtdO1xuICAgIHRoaXMuY3VyTm9kZS5jaGlsZHJlbi5wdXNoKG5vZGUpO1xuICAgIHRoaXMuY3VyU3BlYy5jaGlsZHJlbiA9IHRoaXMuY3VyU3BlYy5jaGlsZHJlbiB8fCBbXTtcbiAgICB0aGlzLmN1clNwZWMuY2hpbGRyZW4ucHVzaChzcGVjKTtcblxuICAgIHRoaXMuYnJhbmNoRGVzY0luZm8ucHVzaCh7IGlkLCBkZXNjcmlwdGlvbiB9KTtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIGFkZFN1YkZsb3dDaGFydEJyYW5jaChcbiAgICBpZDogc3RyaW5nLFxuICAgIHN1YmZsb3c6IEZsb3dDaGFydDxhbnksIGFueT4sXG4gICAgbW91bnROYW1lPzogc3RyaW5nLFxuICAgIG9wdGlvbnM/OiBTdWJmbG93TW91bnRPcHRpb25zLFxuICApOiBTZWxlY3RvckZuTGlzdDxUT3V0LCBUU2NvcGU+IHtcbiAgICBpZiAodGhpcy5icmFuY2hJZHMuaGFzKGlkKSkgZmFpbChgZHVwbGljYXRlIHNlbGVjdG9yIGJyYW5jaCBpZCAnJHtpZH0nIHVuZGVyICcke3RoaXMuY3VyTm9kZS5uYW1lfSdgKTtcbiAgICB0aGlzLmJyYW5jaElkcy5hZGQoaWQpO1xuXG4gICAgY29uc3Qgc3ViZmxvd05hbWUgPSBtb3VudE5hbWUgfHwgaWQ7XG4gICAgY29uc3QgcHJlZml4ZWRSb290ID0gdGhpcy5iLl9wcmVmaXhOb2RlVHJlZShzdWJmbG93LnJvb3QsIGlkKTtcblxuICAgIGlmICghdGhpcy5iLl9zdWJmbG93RGVmcy5oYXMoaWQpKSB7XG4gICAgICB0aGlzLmIuX3N1YmZsb3dEZWZzLnNldChpZCwgeyByb290OiBwcmVmaXhlZFJvb3QgfSk7XG4gICAgfVxuXG4gICAgY29uc3Qgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7XG4gICAgICBuYW1lOiBzdWJmbG93TmFtZSxcbiAgICAgIGlkLFxuICAgICAgYnJhbmNoSWQ6IGlkLFxuICAgICAgaXNTdWJmbG93Um9vdDogdHJ1ZSxcbiAgICAgIHN1YmZsb3dJZDogaWQsXG4gICAgICBzdWJmbG93TmFtZSxcbiAgICB9O1xuICAgIGlmIChvcHRpb25zKSBub2RlLnN1YmZsb3dNb3VudE9wdGlvbnMgPSBvcHRpb25zO1xuXG4gICAgY29uc3Qgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0ge1xuICAgICAgbmFtZTogc3ViZmxvd05hbWUsXG4gICAgICB0eXBlOiAnc3RhZ2UnLFxuICAgICAgaWQsXG4gICAgICBpc1N1YmZsb3dSb290OiB0cnVlLFxuICAgICAgc3ViZmxvd0lkOiBpZCxcbiAgICAgIHN1YmZsb3dOYW1lLFxuICAgICAgc3ViZmxvd1N0cnVjdHVyZTogc3ViZmxvdy5idWlsZFRpbWVTdHJ1Y3R1cmUsXG4gICAgfTtcblxuICAgIHRoaXMuY3VyTm9kZS5jaGlsZHJlbiA9IHRoaXMuY3VyTm9kZS5jaGlsZHJlbiB8fCBbXTtcbiAgICB0aGlzLmN1ck5vZGUuY2hpbGRyZW4ucHVzaChub2RlKTtcbiAgICB0aGlzLmN1clNwZWMuY2hpbGRyZW4gPSB0aGlzLmN1clNwZWMuY2hpbGRyZW4gfHwgW107XG4gICAgdGhpcy5jdXJTcGVjLmNoaWxkcmVuLnB1c2goc3BlYyk7XG5cbiAgICB0aGlzLmIuX21lcmdlU3RhZ2VNYXAoc3ViZmxvdy5zdGFnZU1hcCwgaWQpO1xuICAgIHRoaXMuYi5fbWVyZ2VTdWJmbG93cyhzdWJmbG93LnN1YmZsb3dzLCBpZCk7XG5cbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIGFkZExhenlTdWJGbG93Q2hhcnRCcmFuY2goXG4gICAgaWQ6IHN0cmluZyxcbiAgICByZXNvbHZlcjogKCkgPT4gRmxvd0NoYXJ0PGFueSwgYW55PixcbiAgICBtb3VudE5hbWU/OiBzdHJpbmcsXG4gICAgb3B0aW9ucz86IFN1YmZsb3dNb3VudE9wdGlvbnMsXG4gICk6IFNlbGVjdG9yRm5MaXN0PFRPdXQsIFRTY29wZT4ge1xuICAgIGlmICh0aGlzLmJyYW5jaElkcy5oYXMoaWQpKSBmYWlsKGBkdXBsaWNhdGUgc2VsZWN0b3IgYnJhbmNoIGlkICcke2lkfScgdW5kZXIgJyR7dGhpcy5jdXJOb2RlLm5hbWV9J2ApO1xuICAgIHRoaXMuYnJhbmNoSWRzLmFkZChpZCk7XG5cbiAgICBjb25zdCBzdWJmbG93TmFtZSA9IG1vdW50TmFtZSB8fCBpZDtcblxuICAgIGNvbnN0IG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+ID0ge1xuICAgICAgbmFtZTogc3ViZmxvd05hbWUsXG4gICAgICBpZCxcbiAgICAgIGJyYW5jaElkOiBpZCxcbiAgICAgIGlzU3ViZmxvd1Jvb3Q6IHRydWUsXG4gICAgICBzdWJmbG93SWQ6IGlkLFxuICAgICAgc3ViZmxvd05hbWUsXG4gICAgICBzdWJmbG93UmVzb2x2ZXI6IHJlc29sdmVyIGFzIGFueSxcbiAgICB9O1xuICAgIGlmIChvcHRpb25zKSBub2RlLnN1YmZsb3dNb3VudE9wdGlvbnMgPSBvcHRpb25zO1xuXG4gICAgY29uc3Qgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0ge1xuICAgICAgbmFtZTogc3ViZmxvd05hbWUsXG4gICAgICB0eXBlOiAnc3RhZ2UnLFxuICAgICAgaWQsXG4gICAgICBpc1N1YmZsb3dSb290OiB0cnVlLFxuICAgICAgc3ViZmxvd0lkOiBpZCxcbiAgICAgIHN1YmZsb3dOYW1lLFxuICAgICAgaXNMYXp5OiB0cnVlLFxuICAgIH07XG5cbiAgICB0aGlzLmN1ck5vZGUuY2hpbGRyZW4gPSB0aGlzLmN1ck5vZGUuY2hpbGRyZW4gfHwgW107XG4gICAgdGhpcy5jdXJOb2RlLmNoaWxkcmVuLnB1c2gobm9kZSk7XG4gICAgdGhpcy5jdXJTcGVjLmNoaWxkcmVuID0gdGhpcy5jdXJTcGVjLmNoaWxkcmVuIHx8IFtdO1xuICAgIHRoaXMuY3VyU3BlYy5jaGlsZHJlbi5wdXNoKHNwZWMpO1xuXG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBhZGRCcmFuY2hMaXN0KFxuICAgIGJyYW5jaGVzOiBBcnJheTx7XG4gICAgICBpZDogc3RyaW5nO1xuICAgICAgbmFtZTogc3RyaW5nO1xuICAgICAgZm4/OiBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT47XG4gICAgfT4sXG4gICk6IFNlbGVjdG9yRm5MaXN0PFRPdXQsIFRTY29wZT4ge1xuICAgIGZvciAoY29uc3QgeyBpZCwgbmFtZSwgZm4gfSBvZiBicmFuY2hlcykge1xuICAgICAgdGhpcy5hZGRGdW5jdGlvbkJyYW5jaChpZCwgbmFtZSwgZm4pO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIGVuZCgpOiBGbG93Q2hhcnRCdWlsZGVyPFRPdXQsIFRTY29wZT4ge1xuICAgIGNvbnN0IGNoaWxkcmVuID0gdGhpcy5jdXJOb2RlLmNoaWxkcmVuO1xuICAgIGlmICghY2hpbGRyZW4gfHwgY2hpbGRyZW4ubGVuZ3RoID09PSAwKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFtGbG93Q2hhcnRCdWlsZGVyXSBzZWxlY3RvciBhdCAnJHt0aGlzLmN1ck5vZGUubmFtZX0nIHJlcXVpcmVzIGF0IGxlYXN0IG9uZSBicmFuY2hgKTtcbiAgICB9XG5cbiAgICAvLyBWYWxpZGF0ZSB0aGF0IGV2ZXJ5IGJyYW5jaCB3aXRoIG5vIGVtYmVkZGVkIGZuIGlzIHJlc29sdmFibGUgZnJvbSB0aGUgc3RhZ2VNYXBcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIGNoaWxkcmVuKSB7XG4gICAgICBpZiAoIWNoaWxkLmZuICYmIGNoaWxkLmlkICYmICFjaGlsZC5pc1N1YmZsb3dSb290ICYmICFjaGlsZC5zdWJmbG93UmVzb2x2ZXIpIHtcbiAgICAgICAgY29uc3QgaGFzSW5NYXAgPSB0aGlzLmIuX3N0YWdlTWFwSGFzKGNoaWxkLmlkKSB8fCB0aGlzLmIuX3N0YWdlTWFwSGFzKGNoaWxkLm5hbWUpO1xuICAgICAgICBpZiAoIWhhc0luTWFwKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgYFtGbG93Q2hhcnRCdWlsZGVyXSBzZWxlY3RvciBicmFuY2ggJyR7Y2hpbGQuaWR9JyB1bmRlciAnJHt0aGlzLmN1ck5vZGUubmFtZX0nIGhhcyBubyBmdW5jdGlvbiDigJQgYCArXG4gICAgICAgICAgICAgIGBwcm92aWRlIGEgZm4gYXJndW1lbnQgdG8gYWRkRnVuY3Rpb25CcmFuY2goJyR7Y2hpbGQuaWR9JywgLi4uKWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIHRoaXMuY3VyTm9kZS5zZWxlY3RvckZuID0gdHJ1ZTtcblxuICAgIHRoaXMuY3VyU3BlYy5icmFuY2hJZHMgPSBjaGlsZHJlblxuICAgICAgLm1hcCgoYykgPT4gYy5pZClcbiAgICAgIC5maWx0ZXIoKGlkKTogaWQgaXMgc3RyaW5nID0+IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgJiYgaWQubGVuZ3RoID4gMCk7XG4gICAgdGhpcy5jdXJTcGVjLnR5cGUgPSAnc2VsZWN0b3InOyAvLyB3YXMgJ2RlY2lkZXInIOKAlCBpbmNvcnJlY3Q7IHNlbGVjdG9ycyBhcmUgZGlzdGluY3QgZnJvbSBkZWNpZGVyc1xuICAgIHRoaXMuY3VyU3BlYy5oYXNTZWxlY3RvciA9IHRydWU7XG5cbiAgICBpZiAodGhpcy5yZXNlcnZlZFN0ZXBOdW1iZXIgPiAwKSB7XG4gICAgICBjb25zdCBzZWxlY3RvckxhYmVsID0gdGhpcy5jdXJOb2RlLm5hbWU7XG4gICAgICBjb25zdCBicmFuY2hJZExpc3QgPSB0aGlzLmJyYW5jaERlc2NJbmZvLm1hcCgoYikgPT4gYi5pZCkuam9pbignLCAnKTtcbiAgICAgIGNvbnN0IG1haW5MaW5lID0gdGhpcy5zZWxlY3RvckRlc2NyaXB0aW9uXG4gICAgICAgID8gYCR7dGhpcy5yZXNlcnZlZFN0ZXBOdW1iZXJ9LiAke3NlbGVjdG9yTGFiZWx9IOKAlCAke3RoaXMuc2VsZWN0b3JEZXNjcmlwdGlvbn1gXG4gICAgICAgIDogYCR7dGhpcy5yZXNlcnZlZFN0ZXBOdW1iZXJ9LiAke3NlbGVjdG9yTGFiZWx9IOKAlCBTZWxlY3RzIGZyb206ICR7YnJhbmNoSWRMaXN0fWA7XG4gICAgICB0aGlzLnBhcmVudERlc2NyaXB0aW9uUGFydHMucHVzaChtYWluTGluZSk7XG5cbiAgICAgIGlmICh0aGlzLnNlbGVjdG9yRGVzY3JpcHRpb24pIHtcbiAgICAgICAgdGhpcy5wYXJlbnRTdGFnZURlc2NyaXB0aW9ucy5zZXQodGhpcy5jdXJOb2RlLm5hbWUsIHRoaXMuc2VsZWN0b3JEZXNjcmlwdGlvbik7XG4gICAgICB9XG5cbiAgICAgIGZvciAoY29uc3QgYnJhbmNoIG9mIHRoaXMuYnJhbmNoRGVzY0luZm8pIHtcbiAgICAgICAgY29uc3QgYnJhbmNoVGV4dCA9IGJyYW5jaC5kZXNjcmlwdGlvbjtcbiAgICAgICAgaWYgKGJyYW5jaFRleHQpIHRoaXMucGFyZW50RGVzY3JpcHRpb25QYXJ0cy5wdXNoKGAgICDihpIgJHticmFuY2guaWR9OiAke2JyYW5jaFRleHR9YCk7XG4gICAgICAgIGlmIChicmFuY2guZGVzY3JpcHRpb24pIHRoaXMucGFyZW50U3RhZ2VEZXNjcmlwdGlvbnMuc2V0KGJyYW5jaC5pZCwgYnJhbmNoLmRlc2NyaXB0aW9uKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcy5iO1xuICB9XG59XG5cbi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy8gRmxvd0NoYXJ0QnVpbGRlclxuLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmV4cG9ydCBjbGFzcyBGbG93Q2hhcnRCdWlsZGVyPFRPdXQgPSBhbnksIFRTY29wZSA9IGFueT4ge1xuICBwcml2YXRlIF9yb290PzogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT47XG4gIHByaXZhdGUgX3Jvb3RTcGVjPzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlO1xuICBwcml2YXRlIF9jdXJzb3I/OiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPjtcbiAgcHJpdmF0ZSBfY3Vyc29yU3BlYz86IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZTtcbiAgcHJpdmF0ZSBfc3RhZ2VNYXAgPSBuZXcgTWFwPHN0cmluZywgU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+PigpO1xuICBfc3ViZmxvd0RlZnMgPSBuZXcgTWFwPHN0cmluZywgeyByb290OiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiB9PigpO1xuICBwcml2YXRlIF9zdHJlYW1IYW5kbGVyczogU3RyZWFtSGFuZGxlcnMgPSB7fTtcbiAgcHJpdmF0ZSBfZXh0cmFjdG9yPzogVHJhdmVyc2FsRXh0cmFjdG9yO1xuICBwcml2YXRlIF9idWlsZFRpbWVFeHRyYWN0b3I/OiBCdWlsZFRpbWVFeHRyYWN0b3I8YW55PjtcbiAgcHJpdmF0ZSBfYnVpbGRUaW1lRXh0cmFjdG9yRXJyb3JzOiBBcnJheTx7IG1lc3NhZ2U6IHN0cmluZzsgZXJyb3I6IHVua25vd24gfT4gPSBbXTtcbiAgcHJpdmF0ZSBfZW5hYmxlTmFycmF0aXZlID0gZmFsc2U7XG4gIHByaXZhdGUgX2xvZ2dlcj86IElMb2dnZXI7XG4gIHByaXZhdGUgX2Rlc2NyaXB0aW9uUGFydHM6IHN0cmluZ1tdID0gW107XG4gIHByaXZhdGUgX3N0ZXBDb3VudGVyID0gMDtcbiAgLy8gTk9URToga2V5ZWQgYnkgc3RhZ2UgbmFtZSAoZm9yIGh1bWFuLXJlYWRhYmxlIGRlc2NyaXB0aW9ucyksIHdoaWxlIHN0YWdlTWFwXG4gIC8vIGFuZCBrbm93blN0YWdlSWRzIHVzZSBpZCAoc3RhYmxlIGlkZW50aWZpZXIpLiBUaGVzZSBhcmUgaW50ZW50aW9uYWxseSBkaWZmZXJlbnRcbiAgLy8gbmFtZXNwYWNlcyDigJQgZGVzY3JpcHRpb25zIGFyZSBwcmVzZW50YXRpb25hbCwgbG9va3VwcyBhcmUgc3RydWN0dXJhbC5cbiAgcHJpdmF0ZSBfc3RhZ2VEZXNjcmlwdGlvbnMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICBwcml2YXRlIF9zdGFnZVN0ZXBNYXAgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICBwcml2YXRlIF9rbm93blN0YWdlSWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIHByaXZhdGUgX2lucHV0U2NoZW1hPzogdW5rbm93bjtcbiAgcHJpdmF0ZSBfb3V0cHV0U2NoZW1hPzogdW5rbm93bjtcbiAgcHJpdmF0ZSBfb3V0cHV0TWFwcGVyPzogKGZpbmFsU2NvcGU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB1bmtub3duO1xuICBwcml2YXRlIF9zY29wZUZhY3Rvcnk/OiBTY29wZUZhY3Rvcnk8VFNjb3BlPjtcblxuICBjb25zdHJ1Y3RvcihidWlsZFRpbWVFeHRyYWN0b3I/OiBCdWlsZFRpbWVFeHRyYWN0b3I8YW55Pikge1xuICAgIGlmIChidWlsZFRpbWVFeHRyYWN0b3IpIHtcbiAgICAgIHRoaXMuX2J1aWxkVGltZUV4dHJhY3RvciA9IGJ1aWxkVGltZUV4dHJhY3RvcjtcbiAgICB9XG4gIH1cblxuICAvLyDilIDilIAgRGVzY3JpcHRpb24gaGVscGVycyDilIDilIBcblxuICBwcml2YXRlIF9hcHBlbmREZXNjcmlwdGlvbkxpbmUobmFtZTogc3RyaW5nLCBkZXNjcmlwdGlvbj86IHN0cmluZyk6IHZvaWQge1xuICAgIHRoaXMuX3N0ZXBDb3VudGVyKys7XG4gICAgdGhpcy5fc3RhZ2VTdGVwTWFwLnNldChuYW1lLCB0aGlzLl9zdGVwQ291bnRlcik7XG4gICAgY29uc3QgbGluZSA9IGRlc2NyaXB0aW9uID8gYCR7dGhpcy5fc3RlcENvdW50ZXJ9LiAke25hbWV9IOKAlCAke2Rlc2NyaXB0aW9ufWAgOiBgJHt0aGlzLl9zdGVwQ291bnRlcn0uICR7bmFtZX1gO1xuICAgIHRoaXMuX2Rlc2NyaXB0aW9uUGFydHMucHVzaChsaW5lKTtcbiAgICBpZiAoZGVzY3JpcHRpb24pIHtcbiAgICAgIHRoaXMuX3N0YWdlRGVzY3JpcHRpb25zLnNldChuYW1lLCBkZXNjcmlwdGlvbik7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBfYXBwZW5kU3ViZmxvd0Rlc2NyaXB0aW9uKGlkOiBzdHJpbmcsIG5hbWU6IHN0cmluZywgc3ViZmxvdzogRmxvd0NoYXJ0PGFueSwgYW55Pik6IHZvaWQge1xuICAgIHRoaXMuX3N0ZXBDb3VudGVyKys7XG4gICAgdGhpcy5fc3RhZ2VTdGVwTWFwLnNldChpZCwgdGhpcy5fc3RlcENvdW50ZXIpO1xuICAgIGlmIChzdWJmbG93LmRlc2NyaXB0aW9uKSB7XG4gICAgICB0aGlzLl9kZXNjcmlwdGlvblBhcnRzLnB1c2goYCR7dGhpcy5fc3RlcENvdW50ZXJ9LiBbU3ViLUV4ZWN1dGlvbjogJHtuYW1lfV0g4oCUICR7c3ViZmxvdy5kZXNjcmlwdGlvbn1gKTtcbiAgICAgIGNvbnN0IGxpbmVzID0gc3ViZmxvdy5kZXNjcmlwdGlvbi5zcGxpdCgnXFxuJyk7XG4gICAgICBjb25zdCBzdGVwc0lkeCA9IGxpbmVzLmZpbmRJbmRleCgobCkgPT4gbC5zdGFydHNXaXRoKCdTdGVwczonKSk7XG4gICAgICBpZiAoc3RlcHNJZHggPj0gMCkge1xuICAgICAgICBmb3IgKGxldCBpID0gc3RlcHNJZHggKyAxOyBpIDwgbGluZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICBpZiAobGluZXNbaV0udHJpbSgpKSB0aGlzLl9kZXNjcmlwdGlvblBhcnRzLnB1c2goYCAgICR7bGluZXNbaV19YCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5fZGVzY3JpcHRpb25QYXJ0cy5wdXNoKGAke3RoaXMuX3N0ZXBDb3VudGVyfS4gW1N1Yi1FeGVjdXRpb246ICR7bmFtZX1dYCk7XG4gICAgfVxuICB9XG5cbiAgLy8g4pSA4pSAIENvbmZpZ3VyYXRpb24g4pSA4pSAXG5cbiAgc2V0TG9nZ2VyKGxvZ2dlcjogSUxvZ2dlcik6IHRoaXMge1xuICAgIHRoaXMuX2xvZ2dlciA9IGxvZ2dlcjtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIC8qKlxuICAgKiBEZWNsYXJlIHRoZSBBUEkgY29udHJhY3Qg4oCUIGlucHV0IHZhbGlkYXRpb24sIG91dHB1dCBzaGFwZSwgYW5kIG91dHB1dCBtYXBwZXIuXG4gICAqIFJlcGxhY2VzIHNldElucHV0U2NoZW1hKCkgKyBzZXRPdXRwdXRTY2hlbWEoKSArIHNldE91dHB1dE1hcHBlcigpIGluIGEgc2luZ2xlIGNhbGwuXG4gICAqXG4gICAqIElmIGEgY29udHJhY3Qgd2l0aCBpbnB1dCBzY2hlbWEgaXMgZGVjbGFyZWQsIGNoYXJ0LnJ1bigpIHZhbGlkYXRlcyBpbnB1dCBhdXRvbWF0aWNhbGx5LlxuICAgKiBDb250cmFjdCBkYXRhIGlzIHVzZWQgYnkgY2hhcnQudG9PcGVuQVBJKCkgYW5kIGNoYXJ0LnRvTUNQVG9vbCgpLlxuICAgKi9cbiAgY29udHJhY3Qob3B0czoge1xuICAgIGlucHV0PzogdW5rbm93bjtcbiAgICBvdXRwdXQ/OiB1bmtub3duO1xuICAgIG1hcHBlcj86IChmaW5hbFNjb3BlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gdW5rbm93bjtcbiAgfSk6IHRoaXMge1xuICAgIGlmIChvcHRzLmlucHV0KSB0aGlzLl9pbnB1dFNjaGVtYSA9IG9wdHMuaW5wdXQ7XG4gICAgaWYgKG9wdHMub3V0cHV0KSB0aGlzLl9vdXRwdXRTY2hlbWEgPSBvcHRzLm91dHB1dDtcbiAgICBpZiAob3B0cy5tYXBwZXIpIHRoaXMuX291dHB1dE1hcHBlciA9IG9wdHMubWFwcGVyO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgLy8g4pSA4pSAIExpbmVhciBDaGFpbmluZyDilIDilIBcblxuICBzdGFydChcbiAgICBuYW1lOiBzdHJpbmcsXG4gICAgZm46IFN0YWdlRnVuY3Rpb248VE91dCwgVFNjb3BlPiB8IFBhdXNhYmxlSGFuZGxlcjxUU2NvcGU+LFxuICAgIGlkOiBzdHJpbmcsXG4gICAgZGVzY3JpcHRpb24/OiBzdHJpbmcsXG4gICk6IHRoaXMge1xuICAgIGlmICh0aGlzLl9yb290KSBmYWlsKCdyb290IGFscmVhZHkgZGVmaW5lZDsgY3JlYXRlIGEgbmV3IGJ1aWxkZXInKTtcblxuICAgIC8vIERldGVjdCBQYXVzYWJsZUhhbmRsZXIgYnkgZHVjay10eXBpbmcgKGhhcyAuZXhlY3V0ZSBwcm9wZXJ0eSlcbiAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tcmVzdHJpY3RlZC1zeW50YXhcbiAgICBjb25zdCBpc1BhdXNhYmxlID0gdHlwZW9mIGZuID09PSAnb2JqZWN0JyAmJiBmbiAhPT0gbnVsbCAmJiAnZXhlY3V0ZScgaW4gZm47XG4gICAgY29uc3Qgc3RhZ2VGbiA9IGlzUGF1c2FibGVcbiAgICAgID8gKChmbiBhcyBQYXVzYWJsZUhhbmRsZXI8VFNjb3BlPikuZXhlY3V0ZSBhcyBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4pXG4gICAgICA6IChmbiBhcyBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4pO1xuXG4gICAgY29uc3Qgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7IG5hbWUsIGlkLCBmbjogc3RhZ2VGbiB9O1xuICAgIGlmIChpc1BhdXNhYmxlKSB7XG4gICAgICBub2RlLmlzUGF1c2FibGUgPSB0cnVlO1xuICAgICAgbm9kZS5yZXN1bWVGbiA9IChmbiBhcyBQYXVzYWJsZUhhbmRsZXI8VFNjb3BlPikucmVzdW1lO1xuICAgIH1cbiAgICBpZiAoZGVzY3JpcHRpb24pIG5vZGUuZGVzY3JpcHRpb24gPSBkZXNjcmlwdGlvbjtcbiAgICB0aGlzLl9hZGRUb01hcChpZCwgc3RhZ2VGbik7XG5cbiAgICBsZXQgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0geyBuYW1lLCBpZCwgdHlwZTogJ3N0YWdlJyB9O1xuICAgIGlmIChpc1BhdXNhYmxlKSBzcGVjLmlzUGF1c2FibGUgPSB0cnVlO1xuICAgIGlmIChkZXNjcmlwdGlvbikgc3BlYy5kZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uO1xuICAgIHNwZWMgPSB0aGlzLl9hcHBseUV4dHJhY3RvclRvTm9kZShzcGVjKTtcblxuICAgIHRoaXMuX3Jvb3QgPSBub2RlO1xuICAgIHRoaXMuX3Jvb3RTcGVjID0gc3BlYztcbiAgICB0aGlzLl9jdXJzb3IgPSBub2RlO1xuICAgIHRoaXMuX2N1cnNvclNwZWMgPSBzcGVjO1xuICAgIHRoaXMuX2tub3duU3RhZ2VJZHMuYWRkKGlkKTtcblxuICAgIHRoaXMuX2FwcGVuZERlc2NyaXB0aW9uTGluZShuYW1lLCBkZXNjcmlwdGlvbik7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBhZGRGdW5jdGlvbihuYW1lOiBzdHJpbmcsIGZuOiBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4sIGlkOiBzdHJpbmcsIGRlc2NyaXB0aW9uPzogc3RyaW5nKTogdGhpcyB7XG4gICAgY29uc3QgY3VyID0gdGhpcy5fbmVlZEN1cnNvcigpO1xuICAgIGNvbnN0IGN1clNwZWMgPSB0aGlzLl9uZWVkQ3Vyc29yU3BlYygpO1xuXG4gICAgY29uc3Qgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7IG5hbWUsIGlkLCBmbiB9O1xuICAgIGlmIChkZXNjcmlwdGlvbikgbm9kZS5kZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uO1xuICAgIHRoaXMuX2FkZFRvTWFwKGlkLCBmbik7XG5cbiAgICBsZXQgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0geyBuYW1lLCBpZCwgdHlwZTogJ3N0YWdlJyB9O1xuICAgIGlmIChkZXNjcmlwdGlvbikgc3BlYy5kZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uO1xuICAgIHNwZWMgPSB0aGlzLl9hcHBseUV4dHJhY3RvclRvTm9kZShzcGVjKTtcblxuICAgIGN1ci5uZXh0ID0gbm9kZTtcbiAgICBjdXJTcGVjLm5leHQgPSBzcGVjO1xuICAgIHRoaXMuX2N1cnNvciA9IG5vZGU7XG4gICAgdGhpcy5fY3Vyc29yU3BlYyA9IHNwZWM7XG4gICAgdGhpcy5fa25vd25TdGFnZUlkcy5hZGQoaWQpO1xuXG4gICAgdGhpcy5fYXBwZW5kRGVzY3JpcHRpb25MaW5lKG5hbWUsIGRlc2NyaXB0aW9uKTtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIGFkZFN0cmVhbWluZ0Z1bmN0aW9uKFxuICAgIG5hbWU6IHN0cmluZyxcbiAgICBmbjogU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+LFxuICAgIGlkOiBzdHJpbmcsXG4gICAgc3RyZWFtSWQ/OiBzdHJpbmcsXG4gICAgZGVzY3JpcHRpb24/OiBzdHJpbmcsXG4gICk6IHRoaXMge1xuICAgIGNvbnN0IGN1ciA9IHRoaXMuX25lZWRDdXJzb3IoKTtcbiAgICBjb25zdCBjdXJTcGVjID0gdGhpcy5fbmVlZEN1cnNvclNwZWMoKTtcblxuICAgIGNvbnN0IG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+ID0ge1xuICAgICAgbmFtZSxcbiAgICAgIGlkLFxuICAgICAgZm4sXG4gICAgICBpc1N0cmVhbWluZzogdHJ1ZSxcbiAgICAgIHN0cmVhbUlkOiBzdHJlYW1JZCA/PyBuYW1lLFxuICAgIH07XG4gICAgaWYgKGRlc2NyaXB0aW9uKSBub2RlLmRlc2NyaXB0aW9uID0gZGVzY3JpcHRpb247XG4gICAgdGhpcy5fYWRkVG9NYXAoaWQsIGZuKTtcblxuICAgIGxldCBzcGVjOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUgPSB7XG4gICAgICBuYW1lLFxuICAgICAgaWQsXG4gICAgICB0eXBlOiAnc3RyZWFtaW5nJyxcbiAgICAgIGlzU3RyZWFtaW5nOiB0cnVlLFxuICAgICAgc3RyZWFtSWQ6IHN0cmVhbUlkID8/IG5hbWUsXG4gICAgfTtcbiAgICBpZiAoZGVzY3JpcHRpb24pIHNwZWMuZGVzY3JpcHRpb24gPSBkZXNjcmlwdGlvbjtcbiAgICBzcGVjID0gdGhpcy5fYXBwbHlFeHRyYWN0b3JUb05vZGUoc3BlYyk7XG5cbiAgICBjdXIubmV4dCA9IG5vZGU7XG4gICAgY3VyU3BlYy5uZXh0ID0gc3BlYztcbiAgICB0aGlzLl9jdXJzb3IgPSBub2RlO1xuICAgIHRoaXMuX2N1cnNvclNwZWMgPSBzcGVjO1xuICAgIHRoaXMuX2tub3duU3RhZ2VJZHMuYWRkKGlkKTtcblxuICAgIHRoaXMuX2FwcGVuZERlc2NyaXB0aW9uTGluZShuYW1lLCBkZXNjcmlwdGlvbik7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICAvKipcbiAgICogQWRkIGEgcGF1c2FibGUgc3RhZ2Ug4oCUIGNhbiBwYXVzZSBleGVjdXRpb24gYW5kIHJlc3VtZSBsYXRlciB3aXRoIGlucHV0LlxuICAgKlxuICAgKiBUaGUgaGFuZGxlciBoYXMgdHdvIHBoYXNlczpcbiAgICogLSBgZXhlY3V0ZWA6IHJ1bnMgZmlyc3QgdGltZS4gUmV0dXJuIGB7IHBhdXNlOiB0cnVlIH1gIHRvIHBhdXNlLlxuICAgKiAtIGByZXN1bWVgOiBydW5zIHdoZW4gdGhlIGZsb3djaGFydCBpcyByZXN1bWVkIHdpdGggaW5wdXQuXG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGBgYHR5cGVzY3JpcHRcbiAgICogLmFkZFBhdXNhYmxlRnVuY3Rpb24oJ0FwcHJvdmVPcmRlcicsIHtcbiAgICogICBleGVjdXRlOiBhc3luYyAoc2NvcGUpID0+IHtcbiAgICogICAgIHNjb3BlLm9yZGVySWQgPSAnMTIzJztcbiAgICogICAgIHJldHVybiB7IHBhdXNlOiB0cnVlLCBkYXRhOiB7IHF1ZXN0aW9uOiAnQXBwcm92ZT8nIH0gfTtcbiAgICogICB9LFxuICAgKiAgIHJlc3VtZTogYXN5bmMgKHNjb3BlLCBpbnB1dCkgPT4ge1xuICAgKiAgICAgc2NvcGUuYXBwcm92ZWQgPSBpbnB1dC5hcHByb3ZlZDtcbiAgICogICB9LFxuICAgKiB9LCAnYXBwcm92ZS1vcmRlcicsICdNYW5hZ2VyIGFwcHJvdmFsIGdhdGUnKVxuICAgKiBgYGBcbiAgICovXG4gIGFkZFBhdXNhYmxlRnVuY3Rpb24obmFtZTogc3RyaW5nLCBoYW5kbGVyOiBQYXVzYWJsZUhhbmRsZXI8VFNjb3BlPiwgaWQ6IHN0cmluZywgZGVzY3JpcHRpb24/OiBzdHJpbmcpOiB0aGlzIHtcbiAgICBjb25zdCBjdXIgPSB0aGlzLl9uZWVkQ3Vyc29yKCk7XG4gICAgY29uc3QgY3VyU3BlYyA9IHRoaXMuX25lZWRDdXJzb3JTcGVjKCk7XG5cbiAgICBjb25zdCBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiA9IHtcbiAgICAgIG5hbWUsXG4gICAgICBpZCxcbiAgICAgIGZuOiBoYW5kbGVyLmV4ZWN1dGUgYXMgU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+LFxuICAgICAgaXNQYXVzYWJsZTogdHJ1ZSxcbiAgICAgIHJlc3VtZUZuOiBoYW5kbGVyLnJlc3VtZSxcbiAgICB9O1xuICAgIGlmIChkZXNjcmlwdGlvbikgbm9kZS5kZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uO1xuICAgIHRoaXMuX2FkZFRvTWFwKGlkLCBoYW5kbGVyLmV4ZWN1dGUgYXMgU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+KTtcblxuICAgIGxldCBzcGVjOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUgPSB7XG4gICAgICBuYW1lLFxuICAgICAgaWQsXG4gICAgICB0eXBlOiAnc3RhZ2UnLFxuICAgICAgaXNQYXVzYWJsZTogdHJ1ZSxcbiAgICB9O1xuICAgIGlmIChkZXNjcmlwdGlvbikgc3BlYy5kZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uO1xuICAgIHNwZWMgPSB0aGlzLl9hcHBseUV4dHJhY3RvclRvTm9kZShzcGVjKTtcblxuICAgIGN1ci5uZXh0ID0gbm9kZTtcbiAgICBjdXJTcGVjLm5leHQgPSBzcGVjO1xuICAgIHRoaXMuX2N1cnNvciA9IG5vZGU7XG4gICAgdGhpcy5fY3Vyc29yU3BlYyA9IHNwZWM7XG4gICAgdGhpcy5fa25vd25TdGFnZUlkcy5hZGQoaWQpO1xuXG4gICAgdGhpcy5fYXBwZW5kRGVzY3JpcHRpb25MaW5lKG5hbWUsIGRlc2NyaXB0aW9uKTtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIC8vIOKUgOKUgCBCcmFuY2hpbmcg4pSA4pSAXG5cbiAgYWRkRGVjaWRlckZ1bmN0aW9uKFxuICAgIG5hbWU6IHN0cmluZyxcbiAgICBmbjogU3RhZ2VGdW5jdGlvbjxhbnksIFRTY29wZT4sXG4gICAgaWQ6IHN0cmluZyxcbiAgICBkZXNjcmlwdGlvbj86IHN0cmluZyxcbiAgKTogRGVjaWRlckxpc3Q8VE91dCwgVFNjb3BlPiB7XG4gICAgY29uc3QgY3VyID0gdGhpcy5fbmVlZEN1cnNvcigpO1xuICAgIGNvbnN0IGN1clNwZWMgPSB0aGlzLl9uZWVkQ3Vyc29yU3BlYygpO1xuXG4gICAgaWYgKGN1ci5kZWNpZGVyRm4pIGZhaWwoYGRlY2lkZXIgYWxyZWFkeSBkZWZpbmVkIGF0ICcke2N1ci5uYW1lfSdgKTtcblxuICAgIGNvbnN0IG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+ID0geyBuYW1lLCBpZCwgZm4gfTtcbiAgICBpZiAoZGVzY3JpcHRpb24pIG5vZGUuZGVzY3JpcHRpb24gPSBkZXNjcmlwdGlvbjtcbiAgICB0aGlzLl9hZGRUb01hcChpZCwgZm4pO1xuXG4gICAgbGV0IHNwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSA9IHsgbmFtZSwgaWQsIHR5cGU6ICdzdGFnZScsIGhhc0RlY2lkZXI6IHRydWUgfTtcbiAgICBpZiAoZGVzY3JpcHRpb24pIHNwZWMuZGVzY3JpcHRpb24gPSBkZXNjcmlwdGlvbjtcbiAgICBzcGVjID0gdGhpcy5fYXBwbHlFeHRyYWN0b3JUb05vZGUoc3BlYyk7XG5cbiAgICBjdXIubmV4dCA9IG5vZGU7XG4gICAgY3VyU3BlYy5uZXh0ID0gc3BlYztcbiAgICB0aGlzLl9jdXJzb3IgPSBub2RlO1xuICAgIHRoaXMuX2N1cnNvclNwZWMgPSBzcGVjO1xuICAgIHRoaXMuX2tub3duU3RhZ2VJZHMuYWRkKGlkKTtcblxuICAgIHRoaXMuX3N0ZXBDb3VudGVyKys7XG4gICAgdGhpcy5fc3RhZ2VTdGVwTWFwLnNldChuYW1lLCB0aGlzLl9zdGVwQ291bnRlcik7XG5cbiAgICByZXR1cm4gbmV3IERlY2lkZXJMaXN0PFRPdXQsIFRTY29wZT4oXG4gICAgICB0aGlzLFxuICAgICAgbm9kZSxcbiAgICAgIHNwZWMsXG4gICAgICB0aGlzLl9kZXNjcmlwdGlvblBhcnRzLFxuICAgICAgdGhpcy5fc3RhZ2VEZXNjcmlwdGlvbnMsXG4gICAgICB0aGlzLl9zdGVwQ291bnRlcixcbiAgICAgIGRlc2NyaXB0aW9uLFxuICAgICk7XG4gIH1cblxuICBhZGRTZWxlY3RvckZ1bmN0aW9uKFxuICAgIG5hbWU6IHN0cmluZyxcbiAgICBmbjogU3RhZ2VGdW5jdGlvbjxhbnksIFRTY29wZT4sXG4gICAgaWQ6IHN0cmluZyxcbiAgICBkZXNjcmlwdGlvbj86IHN0cmluZyxcbiAgKTogU2VsZWN0b3JGbkxpc3Q8VE91dCwgVFNjb3BlPiB7XG4gICAgY29uc3QgY3VyID0gdGhpcy5fbmVlZEN1cnNvcigpO1xuICAgIGNvbnN0IGN1clNwZWMgPSB0aGlzLl9uZWVkQ3Vyc29yU3BlYygpO1xuXG4gICAgaWYgKGN1ci5zZWxlY3RvckZuKSBmYWlsKGBzZWxlY3RvciBhbHJlYWR5IGRlZmluZWQgYXQgJyR7Y3VyLm5hbWV9J2ApO1xuICAgIGlmIChjdXIuZGVjaWRlckZuKSBmYWlsKGBkZWNpZGVyIGFuZCBzZWxlY3RvciBhcmUgbXV0dWFsbHkgZXhjbHVzaXZlIGF0ICcke2N1ci5uYW1lfSdgKTtcblxuICAgIGNvbnN0IG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+ID0geyBuYW1lLCBpZCwgZm4gfTtcbiAgICBpZiAoZGVzY3JpcHRpb24pIG5vZGUuZGVzY3JpcHRpb24gPSBkZXNjcmlwdGlvbjtcbiAgICB0aGlzLl9hZGRUb01hcChpZCwgZm4pO1xuXG4gICAgbGV0IHNwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSA9IHsgbmFtZSwgaWQsIHR5cGU6ICdzdGFnZScsIGhhc1NlbGVjdG9yOiB0cnVlIH07XG4gICAgaWYgKGRlc2NyaXB0aW9uKSBzcGVjLmRlc2NyaXB0aW9uID0gZGVzY3JpcHRpb247XG4gICAgc3BlYyA9IHRoaXMuX2FwcGx5RXh0cmFjdG9yVG9Ob2RlKHNwZWMpO1xuXG4gICAgY3VyLm5leHQgPSBub2RlO1xuICAgIGN1clNwZWMubmV4dCA9IHNwZWM7XG4gICAgdGhpcy5fY3Vyc29yID0gbm9kZTtcbiAgICB0aGlzLl9jdXJzb3JTcGVjID0gc3BlYztcbiAgICB0aGlzLl9rbm93blN0YWdlSWRzLmFkZChpZCk7XG5cbiAgICB0aGlzLl9zdGVwQ291bnRlcisrO1xuICAgIHRoaXMuX3N0YWdlU3RlcE1hcC5zZXQobmFtZSwgdGhpcy5fc3RlcENvdW50ZXIpO1xuXG4gICAgcmV0dXJuIG5ldyBTZWxlY3RvckZuTGlzdDxUT3V0LCBUU2NvcGU+KFxuICAgICAgdGhpcyxcbiAgICAgIG5vZGUsXG4gICAgICBzcGVjLFxuICAgICAgdGhpcy5fZGVzY3JpcHRpb25QYXJ0cyxcbiAgICAgIHRoaXMuX3N0YWdlRGVzY3JpcHRpb25zLFxuICAgICAgdGhpcy5fc3RlcENvdW50ZXIsXG4gICAgICBkZXNjcmlwdGlvbixcbiAgICApO1xuICB9XG5cbiAgLy8g4pSA4pSAIFBhcmFsbGVsIChGb3JrKSDilIDilIBcblxuICBhZGRMaXN0T2ZGdW5jdGlvbihjaGlsZHJlbjogU2ltcGxpZmllZFBhcmFsbGVsU3BlYzxUT3V0LCBUU2NvcGU+W10sIG9wdGlvbnM/OiB7IGZhaWxGYXN0PzogYm9vbGVhbiB9KTogdGhpcyB7XG4gICAgY29uc3QgY3VyID0gdGhpcy5fbmVlZEN1cnNvcigpO1xuICAgIGNvbnN0IGN1clNwZWMgPSB0aGlzLl9uZWVkQ3Vyc29yU3BlYygpO1xuICAgIGNvbnN0IGZvcmtJZCA9IGN1ci5pZDtcblxuICAgIGN1clNwZWMudHlwZSA9ICdmb3JrJztcbiAgICBpZiAob3B0aW9ucz8uZmFpbEZhc3QpIGN1ci5mYWlsRmFzdCA9IHRydWU7XG5cbiAgICBmb3IgKGNvbnN0IHsgaWQsIG5hbWUsIGZuIH0gb2YgY2hpbGRyZW4pIHtcbiAgICAgIGlmICghaWQpIGZhaWwoYGNoaWxkIGlkIHJlcXVpcmVkIHVuZGVyICcke2N1ci5uYW1lfSdgKTtcbiAgICAgIGlmIChjdXIuY2hpbGRyZW4/LnNvbWUoKGMpID0+IGMuaWQgPT09IGlkKSkge1xuICAgICAgICBmYWlsKGBkdXBsaWNhdGUgY2hpbGQgaWQgJyR7aWR9JyB1bmRlciAnJHtjdXIubmFtZX0nYCk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+ID0geyBuYW1lOiBuYW1lID8/IGlkLCBpZCB9O1xuICAgICAgaWYgKGZuKSB7XG4gICAgICAgIG5vZGUuZm4gPSBmbjtcbiAgICAgICAgdGhpcy5fYWRkVG9NYXAoaWQsIGZuKTtcbiAgICAgIH1cblxuICAgICAgbGV0IHNwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSA9IHtcbiAgICAgICAgbmFtZTogbmFtZSA/PyBpZCxcbiAgICAgICAgaWQsXG4gICAgICAgIHR5cGU6ICdzdGFnZScsXG4gICAgICAgIGlzUGFyYWxsZWxDaGlsZDogdHJ1ZSxcbiAgICAgICAgcGFyYWxsZWxHcm91cElkOiBmb3JrSWQsXG4gICAgICB9O1xuICAgICAgc3BlYyA9IHRoaXMuX2FwcGx5RXh0cmFjdG9yVG9Ob2RlKHNwZWMpO1xuXG4gICAgICBjdXIuY2hpbGRyZW4gPSBjdXIuY2hpbGRyZW4gfHwgW107XG4gICAgICBjdXIuY2hpbGRyZW4ucHVzaChub2RlKTtcbiAgICAgIGN1clNwZWMuY2hpbGRyZW4gPSBjdXJTcGVjLmNoaWxkcmVuIHx8IFtdO1xuICAgICAgY3VyU3BlYy5jaGlsZHJlbi5wdXNoKHNwZWMpO1xuICAgIH1cblxuICAgIGNvbnN0IGNoaWxkTmFtZXMgPSBjaGlsZHJlbi5tYXAoKGMpID0+IGMubmFtZSB8fCBjLmlkKS5qb2luKCcsICcpO1xuICAgIHRoaXMuX3N0ZXBDb3VudGVyKys7XG4gICAgdGhpcy5fZGVzY3JpcHRpb25QYXJ0cy5wdXNoKGAke3RoaXMuX3N0ZXBDb3VudGVyfS4gUnVucyBpbiBwYXJhbGxlbDogJHtjaGlsZE5hbWVzfWApO1xuXG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICAvLyDilIDilIAgU3ViZmxvdyBNb3VudGluZyDilIDilIBcblxuICBhZGRTdWJGbG93Q2hhcnQoaWQ6IHN0cmluZywgc3ViZmxvdzogRmxvd0NoYXJ0PGFueSwgYW55PiwgbW91bnROYW1lPzogc3RyaW5nLCBvcHRpb25zPzogU3ViZmxvd01vdW50T3B0aW9ucyk6IHRoaXMge1xuICAgIGNvbnN0IGN1ciA9IHRoaXMuX25lZWRDdXJzb3IoKTtcbiAgICBjb25zdCBjdXJTcGVjID0gdGhpcy5fbmVlZEN1cnNvclNwZWMoKTtcblxuICAgIGlmIChjdXIuY2hpbGRyZW4/LnNvbWUoKGMpID0+IGMuaWQgPT09IGlkKSkge1xuICAgICAgZmFpbChgZHVwbGljYXRlIGNoaWxkIGlkICcke2lkfScgdW5kZXIgJyR7Y3VyLm5hbWV9J2ApO1xuICAgIH1cblxuICAgIGNvbnN0IHN1YmZsb3dOYW1lID0gbW91bnROYW1lIHx8IGlkO1xuICAgIGNvbnN0IGZvcmtJZCA9IGN1ci5pZDtcbiAgICBjb25zdCBwcmVmaXhlZFJvb3QgPSB0aGlzLl9wcmVmaXhOb2RlVHJlZShzdWJmbG93LnJvb3QsIGlkKTtcblxuICAgIGlmICghdGhpcy5fc3ViZmxvd0RlZnMuaGFzKGlkKSkge1xuICAgICAgdGhpcy5fc3ViZmxvd0RlZnMuc2V0KGlkLCB7IHJvb3Q6IHByZWZpeGVkUm9vdCB9KTtcbiAgICB9XG5cbiAgICBjb25zdCBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiA9IHtcbiAgICAgIG5hbWU6IHN1YmZsb3dOYW1lLFxuICAgICAgaWQsXG4gICAgICBpc1N1YmZsb3dSb290OiB0cnVlLFxuICAgICAgc3ViZmxvd0lkOiBpZCxcbiAgICAgIHN1YmZsb3dOYW1lLFxuICAgIH07XG4gICAgaWYgKG9wdGlvbnMpIG5vZGUuc3ViZmxvd01vdW50T3B0aW9ucyA9IG9wdGlvbnM7XG5cbiAgICBsZXQgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0ge1xuICAgICAgbmFtZTogc3ViZmxvd05hbWUsXG4gICAgICB0eXBlOiAnc3RhZ2UnLFxuICAgICAgaWQsXG4gICAgICBpc1N1YmZsb3dSb290OiB0cnVlLFxuICAgICAgc3ViZmxvd0lkOiBpZCxcbiAgICAgIHN1YmZsb3dOYW1lLFxuICAgICAgaXNQYXJhbGxlbENoaWxkOiB0cnVlLFxuICAgICAgcGFyYWxsZWxHcm91cElkOiBmb3JrSWQsXG4gICAgICBzdWJmbG93U3RydWN0dXJlOiBzdWJmbG93LmJ1aWxkVGltZVN0cnVjdHVyZSxcbiAgICB9O1xuICAgIHNwZWMgPSB0aGlzLl9hcHBseUV4dHJhY3RvclRvTm9kZShzcGVjKTtcblxuICAgIGN1clNwZWMudHlwZSA9ICdmb3JrJztcbiAgICBjdXIuY2hpbGRyZW4gPSBjdXIuY2hpbGRyZW4gfHwgW107XG4gICAgY3VyLmNoaWxkcmVuLnB1c2gobm9kZSk7XG4gICAgY3VyU3BlYy5jaGlsZHJlbiA9IGN1clNwZWMuY2hpbGRyZW4gfHwgW107XG4gICAgY3VyU3BlYy5jaGlsZHJlbi5wdXNoKHNwZWMpO1xuICAgIHRoaXMuX2tub3duU3RhZ2VJZHMuYWRkKGlkKTtcblxuICAgIHRoaXMuX21lcmdlU3RhZ2VNYXAoc3ViZmxvdy5zdGFnZU1hcCwgaWQpO1xuICAgIHRoaXMuX21lcmdlU3ViZmxvd3Moc3ViZmxvdy5zdWJmbG93cywgaWQpO1xuICAgIHRoaXMuX2FwcGVuZFN1YmZsb3dEZXNjcmlwdGlvbihpZCwgc3ViZmxvd05hbWUsIHN1YmZsb3cpO1xuXG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBhZGRMYXp5U3ViRmxvd0NoYXJ0KFxuICAgIGlkOiBzdHJpbmcsXG4gICAgcmVzb2x2ZXI6ICgpID0+IEZsb3dDaGFydDxUT3V0LCBUU2NvcGU+LFxuICAgIG1vdW50TmFtZT86IHN0cmluZyxcbiAgICBvcHRpb25zPzogU3ViZmxvd01vdW50T3B0aW9ucyxcbiAgKTogdGhpcyB7XG4gICAgY29uc3QgY3VyID0gdGhpcy5fbmVlZEN1cnNvcigpO1xuICAgIGNvbnN0IGN1clNwZWMgPSB0aGlzLl9uZWVkQ3Vyc29yU3BlYygpO1xuXG4gICAgaWYgKGN1ci5jaGlsZHJlbj8uc29tZSgoYykgPT4gYy5pZCA9PT0gaWQpKSB7XG4gICAgICBmYWlsKGBkdXBsaWNhdGUgY2hpbGQgaWQgJyR7aWR9JyB1bmRlciAnJHtjdXIubmFtZX0nYCk7XG4gICAgfVxuXG4gICAgY29uc3Qgc3ViZmxvd05hbWUgPSBtb3VudE5hbWUgfHwgaWQ7XG4gICAgY29uc3QgZm9ya0lkID0gY3VyLmlkO1xuXG4gICAgY29uc3Qgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7XG4gICAgICBuYW1lOiBzdWJmbG93TmFtZSxcbiAgICAgIGlkLFxuICAgICAgaXNTdWJmbG93Um9vdDogdHJ1ZSxcbiAgICAgIHN1YmZsb3dJZDogaWQsXG4gICAgICBzdWJmbG93TmFtZSxcbiAgICAgIHN1YmZsb3dSZXNvbHZlcjogcmVzb2x2ZXIgYXMgYW55LFxuICAgIH07XG4gICAgaWYgKG9wdGlvbnMpIG5vZGUuc3ViZmxvd01vdW50T3B0aW9ucyA9IG9wdGlvbnM7XG5cbiAgICBjb25zdCBzcGVjOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUgPSB7XG4gICAgICBuYW1lOiBzdWJmbG93TmFtZSxcbiAgICAgIHR5cGU6ICdzdGFnZScsXG4gICAgICBpZCxcbiAgICAgIGlzU3ViZmxvd1Jvb3Q6IHRydWUsXG4gICAgICBzdWJmbG93SWQ6IGlkLFxuICAgICAgc3ViZmxvd05hbWUsXG4gICAgICBpc1BhcmFsbGVsQ2hpbGQ6IHRydWUsXG4gICAgICBwYXJhbGxlbEdyb3VwSWQ6IGZvcmtJZCxcbiAgICAgIGlzTGF6eTogdHJ1ZSxcbiAgICB9O1xuXG4gICAgY3VyU3BlYy50eXBlID0gJ2ZvcmsnO1xuICAgIGN1ci5jaGlsZHJlbiA9IGN1ci5jaGlsZHJlbiB8fCBbXTtcbiAgICBjdXIuY2hpbGRyZW4ucHVzaChub2RlKTtcbiAgICBjdXJTcGVjLmNoaWxkcmVuID0gY3VyU3BlYy5jaGlsZHJlbiB8fCBbXTtcbiAgICBjdXJTcGVjLmNoaWxkcmVuLnB1c2goc3BlYyk7XG5cbiAgICB0aGlzLl9zdGVwQ291bnRlcisrO1xuICAgIHRoaXMuX3N0YWdlU3RlcE1hcC5zZXQoaWQsIHRoaXMuX3N0ZXBDb3VudGVyKTtcbiAgICB0aGlzLl9kZXNjcmlwdGlvblBhcnRzLnB1c2goYCR7dGhpcy5fc3RlcENvdW50ZXJ9LiBbTGF6eSBTdWItRXhlY3V0aW9uOiAke3N1YmZsb3dOYW1lfV1gKTtcblxuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgYWRkTGF6eVN1YkZsb3dDaGFydE5leHQoXG4gICAgaWQ6IHN0cmluZyxcbiAgICByZXNvbHZlcjogKCkgPT4gRmxvd0NoYXJ0PFRPdXQsIFRTY29wZT4sXG4gICAgbW91bnROYW1lPzogc3RyaW5nLFxuICAgIG9wdGlvbnM/OiBTdWJmbG93TW91bnRPcHRpb25zLFxuICApOiB0aGlzIHtcbiAgICBjb25zdCBjdXIgPSB0aGlzLl9uZWVkQ3Vyc29yKCk7XG4gICAgY29uc3QgY3VyU3BlYyA9IHRoaXMuX25lZWRDdXJzb3JTcGVjKCk7XG5cbiAgICBpZiAoY3VyLm5leHQpIHtcbiAgICAgIGZhaWwoYGNhbm5vdCBhZGQgc3ViZmxvdyBhcyBuZXh0IHdoZW4gbmV4dCBpcyBhbHJlYWR5IGRlZmluZWQgYXQgJyR7Y3VyLm5hbWV9J2ApO1xuICAgIH1cblxuICAgIGNvbnN0IHN1YmZsb3dOYW1lID0gbW91bnROYW1lIHx8IGlkO1xuXG4gICAgY29uc3Qgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7XG4gICAgICBuYW1lOiBzdWJmbG93TmFtZSxcbiAgICAgIGlkLFxuICAgICAgaXNTdWJmbG93Um9vdDogdHJ1ZSxcbiAgICAgIHN1YmZsb3dJZDogaWQsXG4gICAgICBzdWJmbG93TmFtZSxcbiAgICAgIHN1YmZsb3dSZXNvbHZlcjogcmVzb2x2ZXIgYXMgYW55LFxuICAgIH07XG4gICAgaWYgKG9wdGlvbnMpIG5vZGUuc3ViZmxvd01vdW50T3B0aW9ucyA9IG9wdGlvbnM7XG5cbiAgICBjb25zdCBzcGVjOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUgPSB7XG4gICAgICBuYW1lOiBzdWJmbG93TmFtZSxcbiAgICAgIHR5cGU6ICdzdGFnZScsXG4gICAgICBpZCxcbiAgICAgIGlzU3ViZmxvd1Jvb3Q6IHRydWUsXG4gICAgICBzdWJmbG93SWQ6IGlkLFxuICAgICAgc3ViZmxvd05hbWUsXG4gICAgICBpc0xhenk6IHRydWUsXG4gICAgfTtcblxuICAgIGN1ci5uZXh0ID0gbm9kZTtcbiAgICBjdXJTcGVjLm5leHQgPSBzcGVjO1xuICAgIHRoaXMuX2N1cnNvciA9IG5vZGU7XG4gICAgdGhpcy5fY3Vyc29yU3BlYyA9IHNwZWM7XG5cbiAgICB0aGlzLl9zdGVwQ291bnRlcisrO1xuICAgIHRoaXMuX3N0YWdlU3RlcE1hcC5zZXQoaWQsIHRoaXMuX3N0ZXBDb3VudGVyKTtcbiAgICB0aGlzLl9kZXNjcmlwdGlvblBhcnRzLnB1c2goYCR7dGhpcy5fc3RlcENvdW50ZXJ9LiBbTGF6eSBTdWItRXhlY3V0aW9uOiAke3N1YmZsb3dOYW1lfV1gKTtcblxuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgYWRkU3ViRmxvd0NoYXJ0TmV4dChcbiAgICBpZDogc3RyaW5nLFxuICAgIHN1YmZsb3c6IEZsb3dDaGFydDxhbnksIGFueT4sXG4gICAgbW91bnROYW1lPzogc3RyaW5nLFxuICAgIG9wdGlvbnM/OiBTdWJmbG93TW91bnRPcHRpb25zLFxuICApOiB0aGlzIHtcbiAgICBjb25zdCBjdXIgPSB0aGlzLl9uZWVkQ3Vyc29yKCk7XG4gICAgY29uc3QgY3VyU3BlYyA9IHRoaXMuX25lZWRDdXJzb3JTcGVjKCk7XG5cbiAgICBpZiAoY3VyLm5leHQpIHtcbiAgICAgIGZhaWwoYGNhbm5vdCBhZGQgc3ViZmxvdyBhcyBuZXh0IHdoZW4gbmV4dCBpcyBhbHJlYWR5IGRlZmluZWQgYXQgJyR7Y3VyLm5hbWV9J2ApO1xuICAgIH1cblxuICAgIGNvbnN0IHN1YmZsb3dOYW1lID0gbW91bnROYW1lIHx8IGlkO1xuICAgIGNvbnN0IHByZWZpeGVkUm9vdCA9IHRoaXMuX3ByZWZpeE5vZGVUcmVlKHN1YmZsb3cucm9vdCwgaWQpO1xuXG4gICAgaWYgKCF0aGlzLl9zdWJmbG93RGVmcy5oYXMoaWQpKSB7XG4gICAgICB0aGlzLl9zdWJmbG93RGVmcy5zZXQoaWQsIHsgcm9vdDogcHJlZml4ZWRSb290IH0pO1xuICAgIH1cblxuICAgIGNvbnN0IG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+ID0ge1xuICAgICAgbmFtZTogc3ViZmxvd05hbWUsXG4gICAgICBpZCxcbiAgICAgIGlzU3ViZmxvd1Jvb3Q6IHRydWUsXG4gICAgICBzdWJmbG93SWQ6IGlkLFxuICAgICAgc3ViZmxvd05hbWUsXG4gICAgfTtcbiAgICBpZiAob3B0aW9ucykgbm9kZS5zdWJmbG93TW91bnRPcHRpb25zID0gb3B0aW9ucztcblxuICAgIGxldCBhdHRhY2hlZFNwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSA9IHtcbiAgICAgIG5hbWU6IHN1YmZsb3dOYW1lLFxuICAgICAgdHlwZTogJ3N0YWdlJyxcbiAgICAgIGlkLFxuICAgICAgaXNTdWJmbG93Um9vdDogdHJ1ZSxcbiAgICAgIHN1YmZsb3dJZDogaWQsXG4gICAgICBzdWJmbG93TmFtZSxcbiAgICAgIHN1YmZsb3dTdHJ1Y3R1cmU6IHN1YmZsb3cuYnVpbGRUaW1lU3RydWN0dXJlLFxuICAgIH07XG4gICAgYXR0YWNoZWRTcGVjID0gdGhpcy5fYXBwbHlFeHRyYWN0b3JUb05vZGUoYXR0YWNoZWRTcGVjKTtcblxuICAgIGN1ci5uZXh0ID0gbm9kZTtcbiAgICBjdXJTcGVjLm5leHQgPSBhdHRhY2hlZFNwZWM7XG4gICAgdGhpcy5fY3Vyc29yID0gbm9kZTtcbiAgICB0aGlzLl9jdXJzb3JTcGVjID0gYXR0YWNoZWRTcGVjO1xuICAgIHRoaXMuX2tub3duU3RhZ2VJZHMuYWRkKGlkKTtcblxuICAgIHRoaXMuX21lcmdlU3RhZ2VNYXAoc3ViZmxvdy5zdGFnZU1hcCwgaWQpO1xuICAgIHRoaXMuX21lcmdlU3ViZmxvd3Moc3ViZmxvdy5zdWJmbG93cywgaWQpO1xuICAgIHRoaXMuX2FwcGVuZFN1YmZsb3dEZXNjcmlwdGlvbihpZCwgc3ViZmxvd05hbWUsIHN1YmZsb3cpO1xuXG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICAvLyDilIDilIAgTG9vcCDilIDilIBcblxuICBsb29wVG8oc3RhZ2VJZDogc3RyaW5nKTogdGhpcyB7XG4gICAgY29uc3QgY3VyID0gdGhpcy5fbmVlZEN1cnNvcigpO1xuICAgIGNvbnN0IGN1clNwZWMgPSB0aGlzLl9uZWVkQ3Vyc29yU3BlYygpO1xuXG4gICAgaWYgKGN1clNwZWMubG9vcFRhcmdldCkgZmFpbChgbG9vcFRvIGFscmVhZHkgZGVmaW5lZCBhdCAnJHtjdXIubmFtZX0nYCk7XG4gICAgaWYgKGN1ci5uZXh0KSBmYWlsKGBjYW5ub3Qgc2V0IGxvb3BUbyB3aGVuIG5leHQgaXMgYWxyZWFkeSBkZWZpbmVkIGF0ICcke2N1ci5uYW1lfSdgKTtcblxuICAgIGlmICghdGhpcy5fa25vd25TdGFnZUlkcy5oYXMoc3RhZ2VJZCkpIHtcbiAgICAgIGZhaWwoYGxvb3BUbygnJHtzdGFnZUlkfScpIHRhcmdldCBub3QgZm91bmQg4oCUIGRpZCB5b3UgcGFzcyBhIHN0YWdlIG5hbWUgaW5zdGVhZCBvZiBpZD9gKTtcbiAgICB9XG5cbiAgICBjdXIubmV4dCA9IHsgbmFtZTogc3RhZ2VJZCwgaWQ6IHN0YWdlSWQsIGlzTG9vcFJlZjogdHJ1ZSB9O1xuICAgIGN1clNwZWMubG9vcFRhcmdldCA9IHN0YWdlSWQ7XG4gICAgY3VyU3BlYy5uZXh0ID0geyBuYW1lOiBzdGFnZUlkLCBpZDogc3RhZ2VJZCwgdHlwZTogJ2xvb3AnLCBpc0xvb3BSZWZlcmVuY2U6IHRydWUgfTtcblxuICAgIGNvbnN0IHRhcmdldFN0ZXAgPSB0aGlzLl9zdGFnZVN0ZXBNYXAuZ2V0KHN0YWdlSWQpO1xuICAgIGlmICh0YXJnZXRTdGVwICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRoaXMuX2Rlc2NyaXB0aW9uUGFydHMucHVzaChg4oaSIGxvb3BzIGJhY2sgdG8gc3RlcCAke3RhcmdldFN0ZXB9YCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuX2Rlc2NyaXB0aW9uUGFydHMucHVzaChg4oaSIGxvb3BzIGJhY2sgdG8gJHtzdGFnZUlkfWApO1xuICAgIH1cblxuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgLy8g4pSA4pSAIFN0cmVhbWluZyDilIDilIBcblxuICBvblN0cmVhbShoYW5kbGVyOiBTdHJlYW1Ub2tlbkhhbmRsZXIpOiB0aGlzIHtcbiAgICB0aGlzLl9zdHJlYW1IYW5kbGVycy5vblRva2VuID0gaGFuZGxlcjtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIG9uU3RyZWFtU3RhcnQoaGFuZGxlcjogU3RyZWFtTGlmZWN5Y2xlSGFuZGxlcik6IHRoaXMge1xuICAgIHRoaXMuX3N0cmVhbUhhbmRsZXJzLm9uU3RhcnQgPSBoYW5kbGVyO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgb25TdHJlYW1FbmQoaGFuZGxlcjogU3RyZWFtTGlmZWN5Y2xlSGFuZGxlcik6IHRoaXMge1xuICAgIHRoaXMuX3N0cmVhbUhhbmRsZXJzLm9uRW5kID0gaGFuZGxlcjtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIC8vIOKUgOKUgCBFeHRyYWN0b3JzIOKUgOKUgFxuXG4gIGFkZFRyYXZlcnNhbEV4dHJhY3RvcjxUUmVzdWx0ID0gdW5rbm93bj4oZXh0cmFjdG9yOiBUcmF2ZXJzYWxFeHRyYWN0b3I8VFJlc3VsdD4pOiB0aGlzIHtcbiAgICB0aGlzLl9leHRyYWN0b3IgPSBleHRyYWN0b3I7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBhZGRCdWlsZFRpbWVFeHRyYWN0b3I8VFJlc3VsdCA9IEZsb3dDaGFydFNwZWM+KGV4dHJhY3RvcjogQnVpbGRUaW1lRXh0cmFjdG9yPFRSZXN1bHQ+KTogdGhpcyB7XG4gICAgdGhpcy5fYnVpbGRUaW1lRXh0cmFjdG9yID0gZXh0cmFjdG9yO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgZ2V0QnVpbGRUaW1lRXh0cmFjdG9yRXJyb3JzKCk6IEFycmF5PHsgbWVzc2FnZTogc3RyaW5nOyBlcnJvcjogdW5rbm93biB9PiB7XG4gICAgcmV0dXJuIHRoaXMuX2J1aWxkVGltZUV4dHJhY3RvckVycm9ycztcbiAgfVxuXG4gIC8vIOKUgOKUgCBPdXRwdXQg4pSA4pSAXG5cbiAgYnVpbGQoKTogUnVubmFibGVGbG93Q2hhcnQ8VE91dCwgVFNjb3BlPiB7XG4gICAgY29uc3Qgcm9vdCA9IHRoaXMuX3Jvb3QgPz8gZmFpbCgnZW1wdHkgdHJlZTsgY2FsbCBzdGFydCgpIGZpcnN0Jyk7XG4gICAgY29uc3Qgcm9vdFNwZWMgPSB0aGlzLl9yb290U3BlYyA/PyBmYWlsKCdlbXB0eSBzcGVjOyBjYWxsIHN0YXJ0KCkgZmlyc3QnKTtcblxuICAgIGNvbnN0IHN1YmZsb3dzOiBSZWNvcmQ8c3RyaW5nLCB7IHJvb3Q6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+IH0+ID0ge307XG4gICAgZm9yIChjb25zdCBba2V5LCBkZWZdIG9mIHRoaXMuX3N1YmZsb3dEZWZzKSB7XG4gICAgICBzdWJmbG93c1trZXldID0gZGVmO1xuICAgIH1cblxuICAgIGNvbnN0IHJvb3ROYW1lID0gdGhpcy5fcm9vdD8ubmFtZSA/PyAnRmxvd0NoYXJ0JztcbiAgICBjb25zdCBkZXNjcmlwdGlvbiA9XG4gICAgICB0aGlzLl9kZXNjcmlwdGlvblBhcnRzLmxlbmd0aCA+IDAgPyBgRmxvd0NoYXJ0OiAke3Jvb3ROYW1lfVxcblN0ZXBzOlxcbiR7dGhpcy5fZGVzY3JpcHRpb25QYXJ0cy5qb2luKCdcXG4nKX1gIDogJyc7XG5cbiAgICBjb25zdCBjaGFydDogRmxvd0NoYXJ0PFRPdXQsIFRTY29wZT4gPSB7XG4gICAgICByb290LFxuICAgICAgc3RhZ2VNYXA6IHRoaXMuX3N0YWdlTWFwLFxuICAgICAgZXh0cmFjdG9yOiB0aGlzLl9leHRyYWN0b3IsXG4gICAgICBidWlsZFRpbWVTdHJ1Y3R1cmU6IHJvb3RTcGVjLFxuICAgICAgLi4uKE9iamVjdC5rZXlzKHN1YmZsb3dzKS5sZW5ndGggPiAwID8geyBzdWJmbG93cyB9IDoge30pLFxuICAgICAgLi4uKHRoaXMuX2VuYWJsZU5hcnJhdGl2ZSA/IHsgZW5hYmxlTmFycmF0aXZlOiB0cnVlIH0gOiB7fSksXG4gICAgICAuLi4odGhpcy5fbG9nZ2VyID8geyBsb2dnZXI6IHRoaXMuX2xvZ2dlciB9IDoge30pLFxuICAgICAgZGVzY3JpcHRpb24sXG4gICAgICBzdGFnZURlc2NyaXB0aW9uczogbmV3IE1hcCh0aGlzLl9zdGFnZURlc2NyaXB0aW9ucyksXG4gICAgICAuLi4odGhpcy5faW5wdXRTY2hlbWEgPyB7IGlucHV0U2NoZW1hOiB0aGlzLl9pbnB1dFNjaGVtYSB9IDoge30pLFxuICAgICAgLi4uKHRoaXMuX291dHB1dFNjaGVtYSA/IHsgb3V0cHV0U2NoZW1hOiB0aGlzLl9vdXRwdXRTY2hlbWEgfSA6IHt9KSxcbiAgICAgIC4uLih0aGlzLl9vdXRwdXRNYXBwZXIgPyB7IG91dHB1dE1hcHBlcjogdGhpcy5fb3V0cHV0TWFwcGVyIH0gOiB7fSksXG4gICAgICAvLyBBdXRvLWVtYmVkIFR5cGVkU2NvcGUgZmFjdG9yeSBpZiBub25lIHdhcyBleHBsaWNpdGx5IHNldC5cbiAgICAgIC8vIFRoaXMgbWVhbnMgQU5ZIHdheSBvZiBjcmVhdGluZyBhIEZsb3dDaGFydEJ1aWxkZXIgKGZsb3dDaGFydCgpLCBuZXcgRmxvd0NoYXJ0QnVpbGRlcigpLFxuICAgICAgLy8gb3IgYW55IHN1YmNsYXNzKSBhdXRvbWF0aWNhbGx5IGdldHMgVHlwZWRTY29wZSDigJQgbm8gbWFudWFsIHNldFNjb3BlRmFjdG9yeSBuZWVkZWQuXG4gICAgICBzY29wZUZhY3Rvcnk6IHRoaXMuX3Njb3BlRmFjdG9yeSA/PyAoY3JlYXRlVHlwZWRTY29wZUZhY3RvcnkoKSBhcyB1bmtub3duIGFzIFNjb3BlRmFjdG9yeTxUU2NvcGU+KSxcbiAgICB9O1xuXG4gICAgcmV0dXJuIG1ha2VSdW5uYWJsZShjaGFydCk7XG4gIH1cblxuICAvKiogT3ZlcnJpZGUgdGhlIHNjb3BlIGZhY3RvcnkuIFJhcmVseSBuZWVkZWQg4oCUIGF1dG8tZW1iZWRzIFR5cGVkU2NvcGUgYnkgZGVmYXVsdC4gKi9cbiAgc2V0U2NvcGVGYWN0b3J5KGZhY3Rvcnk6IFNjb3BlRmFjdG9yeTxUU2NvcGU+KTogdGhpcyB7XG4gICAgdGhpcy5fc2NvcGVGYWN0b3J5ID0gZmFjdG9yeTtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIHRvU3BlYzxUUmVzdWx0ID0gU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlPigpOiBUUmVzdWx0IHtcbiAgICBjb25zdCByb290U3BlYyA9IHRoaXMuX3Jvb3RTcGVjID8/IGZhaWwoJ2VtcHR5IHRyZWU7IGNhbGwgc3RhcnQoKSBmaXJzdCcpO1xuICAgIHJldHVybiByb290U3BlYyBhcyBUUmVzdWx0O1xuICB9XG5cbiAgdG9NZXJtYWlkKCk6IHN0cmluZyB7XG4gICAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gWydmbG93Y2hhcnQgVEQnXTtcbiAgICBjb25zdCBpZE9mID0gKGs6IHN0cmluZykgPT4gKGsgfHwgJycpLnJlcGxhY2UoL1teYS16QS1aMC05X10vZywgJ18nKSB8fCAnXyc7XG4gICAgY29uc3Qgcm9vdCA9IHRoaXMuX3Jvb3QgPz8gZmFpbCgnZW1wdHkgdHJlZTsgY2FsbCBzdGFydCgpIGZpcnN0Jyk7XG5cbiAgICBjb25zdCB3YWxrID0gKG46IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+KSA9PiB7XG4gICAgICBjb25zdCBuaWQgPSBpZE9mKG4uaWQpO1xuICAgICAgbGluZXMucHVzaChgJHtuaWR9W1wiJHtuLm5hbWV9XCJdYCk7XG4gICAgICBmb3IgKGNvbnN0IGMgb2Ygbi5jaGlsZHJlbiB8fCBbXSkge1xuICAgICAgICBjb25zdCBjaWQgPSBpZE9mKGMuaWQpO1xuICAgICAgICBsaW5lcy5wdXNoKGAke25pZH0gLS0+ICR7Y2lkfWApO1xuICAgICAgICB3YWxrKGMpO1xuICAgICAgfVxuICAgICAgaWYgKG4ubmV4dCkge1xuICAgICAgICBjb25zdCBtaWQgPSBpZE9mKG4ubmV4dC5pZCk7XG4gICAgICAgIGxpbmVzLnB1c2goYCR7bmlkfSAtLT4gJHttaWR9YCk7XG4gICAgICAgIHdhbGsobi5uZXh0KTtcbiAgICAgIH1cbiAgICB9O1xuICAgIHdhbGsocm9vdCk7XG4gICAgcmV0dXJuIGxpbmVzLmpvaW4oJ1xcbicpO1xuICB9XG5cbiAgLy8g4pSA4pSAIEludGVybmFscyAoZXhwb3NlZCBmb3IgaGVscGVyIGNsYXNzZXMpIOKUgOKUgFxuXG4gIHByaXZhdGUgX25lZWRDdXJzb3IoKTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4ge1xuICAgIHJldHVybiB0aGlzLl9jdXJzb3IgPz8gZmFpbCgnY3Vyc29yIHVuZGVmaW5lZDsgY2FsbCBzdGFydCgpIGZpcnN0Jyk7XG4gIH1cblxuICBwcml2YXRlIF9uZWVkQ3Vyc29yU3BlYygpOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUge1xuICAgIHJldHVybiB0aGlzLl9jdXJzb3JTcGVjID8/IGZhaWwoJ2N1cnNvciB1bmRlZmluZWQ7IGNhbGwgc3RhcnQoKSBmaXJzdCcpO1xuICB9XG5cbiAgX2FwcGx5RXh0cmFjdG9yVG9Ob2RlKHNwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSk6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSB7XG4gICAgaWYgKCF0aGlzLl9idWlsZFRpbWVFeHRyYWN0b3IpIHJldHVybiBzcGVjO1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gdGhpcy5fYnVpbGRUaW1lRXh0cmFjdG9yKHNwZWMgYXMgYW55KSBhcyBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmU7XG4gICAgfSBjYXRjaCAoZXJyb3I6IGFueSkge1xuICAgICAgdGhpcy5fYnVpbGRUaW1lRXh0cmFjdG9yRXJyb3JzLnB1c2goe1xuICAgICAgICBtZXNzYWdlOiBlcnJvcj8ubWVzc2FnZSA/PyBTdHJpbmcoZXJyb3IpLFxuICAgICAgICBlcnJvcixcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIHNwZWM7XG4gICAgfVxuICB9XG5cbiAgX3N0YWdlTWFwSGFzKGtleTogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMuX3N0YWdlTWFwLmhhcyhrZXkpO1xuICB9XG5cbiAgX2FkZFRvTWFwKGlkOiBzdHJpbmcsIGZuOiBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4pIHtcbiAgICBpZiAodGhpcy5fc3RhZ2VNYXAuaGFzKGlkKSkge1xuICAgICAgY29uc3QgZXhpc3RpbmcgPSB0aGlzLl9zdGFnZU1hcC5nZXQoaWQpO1xuICAgICAgaWYgKGV4aXN0aW5nICE9PSBmbikgZmFpbChgc3RhZ2VNYXAgY29sbGlzaW9uIGZvciBpZCAnJHtpZH0nYCk7XG4gICAgfVxuICAgIHRoaXMuX3N0YWdlTWFwLnNldChpZCwgZm4pO1xuICB9XG5cbiAgX21lcmdlU3RhZ2VNYXAob3RoZXI6IE1hcDxzdHJpbmcsIFN0YWdlRnVuY3Rpb248VE91dCwgVFNjb3BlPj4sIHByZWZpeD86IHN0cmluZykge1xuICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIG90aGVyKSB7XG4gICAgICBjb25zdCBrZXkgPSBwcmVmaXggPyBgJHtwcmVmaXh9LyR7a31gIDogaztcbiAgICAgIGlmICh0aGlzLl9zdGFnZU1hcC5oYXMoa2V5KSkge1xuICAgICAgICBjb25zdCBleGlzdGluZyA9IHRoaXMuX3N0YWdlTWFwLmdldChrZXkpO1xuICAgICAgICBpZiAoZXhpc3RpbmcgIT09IHYpIGZhaWwoYHN0YWdlTWFwIGNvbGxpc2lvbiB3aGlsZSBtb3VudGluZyBmbG93Y2hhcnQgYXQgJyR7a2V5fSdgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuX3N0YWdlTWFwLnNldChrZXksIHYpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIF9wcmVmaXhOb2RlVHJlZShub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiwgcHJlZml4OiBzdHJpbmcpOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiB7XG4gICAgaWYgKCFub2RlKSByZXR1cm4gbm9kZTtcbiAgICBjb25zdCBjbG9uZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7IC4uLm5vZGUgfTtcbiAgICBjbG9uZS5uYW1lID0gYCR7cHJlZml4fS8ke25vZGUubmFtZX1gO1xuICAgIGNsb25lLmlkID0gYCR7cHJlZml4fS8ke25vZGUuaWR9YDtcbiAgICBpZiAoY2xvbmUuc3ViZmxvd0lkKSBjbG9uZS5zdWJmbG93SWQgPSBgJHtwcmVmaXh9LyR7Y2xvbmUuc3ViZmxvd0lkfWA7XG4gICAgaWYgKGNsb25lLm5leHQpIGNsb25lLm5leHQgPSB0aGlzLl9wcmVmaXhOb2RlVHJlZShjbG9uZS5uZXh0LCBwcmVmaXgpO1xuICAgIGlmIChjbG9uZS5jaGlsZHJlbikge1xuICAgICAgY2xvbmUuY2hpbGRyZW4gPSBjbG9uZS5jaGlsZHJlbi5tYXAoKGMpID0+IHRoaXMuX3ByZWZpeE5vZGVUcmVlKGMsIHByZWZpeCkpO1xuICAgIH1cbiAgICByZXR1cm4gY2xvbmU7XG4gIH1cblxuICBfbWVyZ2VTdWJmbG93cyhzdWJmbG93czogUmVjb3JkPHN0cmluZywgeyByb290OiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiB9PiB8IHVuZGVmaW5lZCwgcHJlZml4OiBzdHJpbmcpIHtcbiAgICBpZiAoIXN1YmZsb3dzKSByZXR1cm47XG4gICAgZm9yIChjb25zdCBba2V5LCBkZWZdIG9mIE9iamVjdC5lbnRyaWVzKHN1YmZsb3dzKSkge1xuICAgICAgY29uc3QgcHJlZml4ZWRLZXkgPSBgJHtwcmVmaXh9LyR7a2V5fWA7XG4gICAgICBpZiAoIXRoaXMuX3N1YmZsb3dEZWZzLmhhcyhwcmVmaXhlZEtleSkpIHtcbiAgICAgICAgdGhpcy5fc3ViZmxvd0RlZnMuc2V0KHByZWZpeGVkS2V5LCB7XG4gICAgICAgICAgcm9vdDogdGhpcy5fcHJlZml4Tm9kZVRyZWUoZGVmLnJvb3QgYXMgU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4sIHByZWZpeCksXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxufVxuXG4vLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vIEZhY3RvcnkgRnVuY3Rpb25cbi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4vLyBPdmVybG9hZCAxOiB0eXBlZCBzdGF0ZSDigJQgZmxvd0NoYXJ0PExvYW5TdGF0ZT4oLi4uKSDihpIgc2NvcGU6IFR5cGVkU2NvcGU8TG9hblN0YXRlPlxuZXhwb3J0IGZ1bmN0aW9uIGZsb3dDaGFydDxUU3RhdGUgZXh0ZW5kcyBvYmplY3Q+KFxuICBuYW1lOiBzdHJpbmcsXG4gIGZuOiBUeXBlZFN0YWdlRnVuY3Rpb248VFN0YXRlPiB8IFBhdXNhYmxlSGFuZGxlcjxUeXBlZFNjb3BlPFRTdGF0ZT4+LFxuICBpZDogc3RyaW5nLFxuICBidWlsZFRpbWVFeHRyYWN0b3I/OiBCdWlsZFRpbWVFeHRyYWN0b3I8YW55PixcbiAgZGVzY3JpcHRpb24/OiBzdHJpbmcsXG4pOiBGbG93Q2hhcnRCdWlsZGVyPGFueSwgVHlwZWRTY29wZTxUU3RhdGU+PjtcblxuLy8gT3ZlcmxvYWQgMjogZnVsbHkgZXhwbGljaXQgZ2VuZXJpY3MgKGFkdmFuY2VkIC8gU2NvcGVGYWNhZGUgdXNhZ2UpXG5leHBvcnQgZnVuY3Rpb24gZmxvd0NoYXJ0PFRPdXQgPSBhbnksIFRTY29wZSA9IGFueT4oXG4gIG5hbWU6IHN0cmluZyxcbiAgZm46IFN0YWdlRnVuY3Rpb248VE91dCwgVFNjb3BlPiB8IFBhdXNhYmxlSGFuZGxlcjxUU2NvcGU+LFxuICBpZDogc3RyaW5nLFxuICBidWlsZFRpbWVFeHRyYWN0b3I/OiBCdWlsZFRpbWVFeHRyYWN0b3I8YW55PixcbiAgZGVzY3JpcHRpb24/OiBzdHJpbmcsXG4pOiBGbG93Q2hhcnRCdWlsZGVyPFRPdXQsIFRTY29wZT47XG5cbmV4cG9ydCBmdW5jdGlvbiBmbG93Q2hhcnQ8VE91dCA9IGFueSwgVFNjb3BlID0gYW55PihcbiAgbmFtZTogc3RyaW5nLFxuICBmbjogU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+IHwgUGF1c2FibGVIYW5kbGVyPFRTY29wZT4sXG4gIGlkOiBzdHJpbmcsXG4gIGJ1aWxkVGltZUV4dHJhY3Rvcj86IEJ1aWxkVGltZUV4dHJhY3Rvcjxhbnk+LFxuICBkZXNjcmlwdGlvbj86IHN0cmluZyxcbik6IEZsb3dDaGFydEJ1aWxkZXI8VE91dCwgVFNjb3BlPiB7XG4gIHJldHVybiBuZXcgRmxvd0NoYXJ0QnVpbGRlcjxUT3V0LCBUU2NvcGU+KGJ1aWxkVGltZUV4dHJhY3Rvcikuc3RhcnQobmFtZSwgZm4gYXMgYW55LCBpZCwgZGVzY3JpcHRpb24pO1xufVxuXG4vLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vIFNwZWMgdG8gU3RhZ2VOb2RlIENvbnZlcnRlclxuLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmV4cG9ydCBmdW5jdGlvbiBzcGVjVG9TdGFnZU5vZGUoc3BlYzogRmxvd0NoYXJ0U3BlYyk6IFN0YWdlTm9kZTxhbnksIGFueT4ge1xuICBjb25zdCBpbmZsYXRlID0gKHM6IEZsb3dDaGFydFNwZWMpOiBTdGFnZU5vZGU8YW55LCBhbnk+ID0+ICh7XG4gICAgbmFtZTogcy5uYW1lLFxuICAgIGlkOiBzLmlkLFxuICAgIGNoaWxkcmVuOiBzLmNoaWxkcmVuPy5sZW5ndGggPyBzLmNoaWxkcmVuLm1hcChpbmZsYXRlKSA6IHVuZGVmaW5lZCxcbiAgICBuZXh0OiBzLm5leHQgPyBpbmZsYXRlKHMubmV4dCkgOiB1bmRlZmluZWQsXG4gIH0pO1xuICByZXR1cm4gaW5mbGF0ZShzcGVjKTtcbn1cbiJdfQ==