"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.specToStageNode = exports.flowChart = exports.FlowChartBuilder = exports.SelectorFnList = exports.DeciderList = void 0;
const RunnableChart_js_1 = require("../runner/RunnableChart.js");
const typedFlowChart_js_1 = require("./typedFlowChart.js");
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
class DeciderList {
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
exports.DeciderList = DeciderList;
// ─────────────────────────────────────────────────────────────────────────────
// SelectorFnList (scope-based selector — mirrors DeciderList)
// ─────────────────────────────────────────────────────────────────────────────
class SelectorFnList {
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
exports.SelectorFnList = SelectorFnList;
// ─────────────────────────────────────────────────────────────────────────────
// FlowChartBuilder
// ─────────────────────────────────────────────────────────────────────────────
class FlowChartBuilder {
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
            scopeFactory: (_e = this._scopeFactory) !== null && _e !== void 0 ? _e : (0, typedFlowChart_js_1.createTypedScopeFactory)(),
        };
        return (0, RunnableChart_js_1.makeRunnable)(chart);
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
exports.FlowChartBuilder = FlowChartBuilder;
function flowChart(name, fn, id, buildTimeExtractor, description) {
    return new FlowChartBuilder(buildTimeExtractor).start(name, fn, id, description);
}
exports.flowChart = flowChart;
// ─────────────────────────────────────────────────────────────────────────────
// Spec to StageNode Converter
// ─────────────────────────────────────────────────────────────────────────────
function specToStageNode(spec) {
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
exports.specToStageNode = specToStageNode;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRmxvd0NoYXJ0QnVpbGRlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9saWIvYnVpbGRlci9GbG93Q2hhcnRCdWlsZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7O0dBWUc7OztBQUtILGlFQUFrRjtBQUNsRiwyREFBdUY7QUFpQnZGLGdGQUFnRjtBQUNoRixtQkFBbUI7QUFDbkIsZ0ZBQWdGO0FBRWhGLE1BQU0sSUFBSSxHQUFHLENBQUMsR0FBVyxFQUFTLEVBQUU7SUFDbEMsTUFBTSxJQUFJLEtBQUssQ0FBQyxzQkFBc0IsR0FBRyxFQUFFLENBQUMsQ0FBQztBQUMvQyxDQUFDLENBQUM7QUFFRixnRkFBZ0Y7QUFDaEYsY0FBYztBQUNkLGdGQUFnRjtBQUVoRjs7O0dBR0c7QUFDSCxNQUFhLFdBQVc7SUFhdEIsWUFDRSxPQUF1QyxFQUN2QyxPQUFnQyxFQUNoQyxPQUFvQyxFQUNwQyx5QkFBbUMsRUFBRSxFQUNyQywwQkFBK0MsSUFBSSxHQUFHLEVBQUUsRUFDeEQsa0JBQWtCLEdBQUcsQ0FBQyxFQUN0QixrQkFBMkI7UUFoQlosY0FBUyxHQUFHLElBQUksR0FBRyxFQUFVLENBQUM7UUFPOUIsbUJBQWMsR0FBZ0QsRUFBRSxDQUFDO1FBV2hGLElBQUksQ0FBQyxDQUFDLEdBQUcsT0FBTyxDQUFDO1FBQ2pCLElBQUksQ0FBQyxPQUFPLEdBQUcsT0FBTyxDQUFDO1FBQ3ZCLElBQUksQ0FBQyxPQUFPLEdBQUcsT0FBTyxDQUFDO1FBQ3ZCLElBQUksQ0FBQyxzQkFBc0IsR0FBRyxzQkFBc0IsQ0FBQztRQUNyRCxJQUFJLENBQUMsdUJBQXVCLEdBQUcsdUJBQXVCLENBQUM7UUFDdkQsSUFBSSxDQUFDLGtCQUFrQixHQUFHLGtCQUFrQixDQUFDO1FBQzdDLElBQUksQ0FBQyxrQkFBa0IsR0FBRyxrQkFBa0IsQ0FBQztJQUMvQyxDQUFDO0lBRUQsaUJBQWlCLENBQ2YsRUFBVSxFQUNWLElBQVks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QUUsTUFBTSxFQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUztZQUNsRSxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUztTQUMzQyxDQUFDLENBQUE7S0FBQSxDQUFDO0lBQ0gsT0FBTyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDdkIsQ0FBQztBQVJELDBDQVFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBGbG93Q2hhcnRCdWlsZGVyIOKAlCBGbHVlbnQgQVBJIGZvciBjb25zdHJ1Y3RpbmcgZmxvd2NoYXJ0IGV4ZWN1dGlvbiBncmFwaHMuXG4gKlxuICogQnVpbGRzIFN0YWdlTm9kZSB0cmVlcyBhbmQgU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlIChKU09OKSBpbiB0YW5kZW0uXG4gKiBaZXJvIGRlcGVuZGVuY2llcyBvbiBvbGQgY29kZSDigJQgb25seSBpbXBvcnRzIGZyb20gbG9jYWwgdHlwZXMuXG4gKlxuICogVGhlIGJ1aWxkZXIgY3JlYXRlcyB0d28gcGFyYWxsZWwgc3RydWN0dXJlczpcbiAqIDEuIFN0YWdlTm9kZSB0cmVlIOKAlCBydW50aW1lIGdyYXBoIHdpdGggZW1iZWRkZWQgZnVuY3Rpb25zXG4gKiAyLiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUg4oCUIEpTT04tc2FmZSBzdHJ1Y3R1cmUgZm9yIHZpc3VhbGl6YXRpb25cbiAqXG4gKiBUaGUgZXhlY3V0ZSgpIGNvbnZlbmllbmNlIG1ldGhvZCBpcyBpbnRlbnRpb25hbGx5IG9taXR0ZWQg4oCUXG4gKiBpdCBiZWxvbmdzIGluIHRoZSBydW5uZXIgbGF5ZXIgKFBoYXNlIDUpLlxuICovXG5cbmltcG9ydCB0eXBlIHsgU2NvcGVGYWN0b3J5IH0gZnJvbSAnLi4vZW5naW5lL3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHsgUGF1c2FibGVIYW5kbGVyIH0gZnJvbSAnLi4vcGF1c2UvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBUeXBlZFNjb3BlIH0gZnJvbSAnLi4vcmVhY3RpdmUvdHlwZXMuanMnO1xuaW1wb3J0IHsgdHlwZSBSdW5uYWJsZUZsb3dDaGFydCwgbWFrZVJ1bm5hYmxlIH0gZnJvbSAnLi4vcnVubmVyL1J1bm5hYmxlQ2hhcnQuanMnO1xuaW1wb3J0IHsgdHlwZSBUeXBlZFN0YWdlRnVuY3Rpb24sIGNyZWF0ZVR5cGVkU2NvcGVGYWN0b3J5IH0gZnJvbSAnLi90eXBlZEZsb3dDaGFydC5qcyc7XG5pbXBvcnQgdHlwZSB7XG4gIEJ1aWxkVGltZUV4dHJhY3RvcixcbiAgRmxvd0NoYXJ0LFxuICBGbG93Q2hhcnRTcGVjLFxuICBJTG9nZ2VyLFxuICBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUsXG4gIFNpbXBsaWZpZWRQYXJhbGxlbFNwZWMsXG4gIFN0YWdlRnVuY3Rpb24sXG4gIFN0YWdlTm9kZSxcbiAgU3RyZWFtSGFuZGxlcnMsXG4gIFN0cmVhbUxpZmVjeWNsZUhhbmRsZXIsXG4gIFN0cmVhbVRva2VuSGFuZGxlcixcbiAgU3ViZmxvd01vdW50T3B0aW9ucyxcbiAgVHJhdmVyc2FsRXh0cmFjdG9yLFxufSBmcm9tICcuL3R5cGVzLmpzJztcblxuLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyBJbnRlcm5hbCBoZWxwZXJzXG4vLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuY29uc3QgZmFpbCA9IChtc2c6IHN0cmluZyk6IG5ldmVyID0+IHtcbiAgdGhyb3cgbmV3IEVycm9yKGBbRmxvd0NoYXJ0QnVpbGRlcl0gJHttc2d9YCk7XG59O1xuXG4vLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vIERlY2lkZXJMaXN0XG4vLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuLyoqXG4gKiBGbHVlbnQgaGVscGVyIHJldHVybmVkIGJ5IGFkZERlY2lkZXJGdW5jdGlvbiB0byBhZGQgYnJhbmNoZXMuXG4gKiBgZW5kKClgIHNldHMgYGRlY2lkZXJGbiA9IHRydWVgIOKAlCB0aGUgZm4gSVMgdGhlIGRlY2lkZXIuXG4gKi9cbmV4cG9ydCBjbGFzcyBEZWNpZGVyTGlzdDxUT3V0ID0gYW55LCBUU2NvcGUgPSBhbnk+IHtcbiAgcHJpdmF0ZSByZWFkb25seSBiOiBGbG93Q2hhcnRCdWlsZGVyPFRPdXQsIFRTY29wZT47XG4gIHByaXZhdGUgcmVhZG9ubHkgY3VyTm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT47XG4gIHByaXZhdGUgcmVhZG9ubHkgY3VyU3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlO1xuICBwcml2YXRlIHJlYWRvbmx5IGJyYW5jaElkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBwcml2YXRlIGRlZmF1bHRJZD86IHN0cmluZztcblxuICBwcml2YXRlIHJlYWRvbmx5IHBhcmVudERlc2NyaXB0aW9uUGFydHM6IHN0cmluZ1tdO1xuICBwcml2YXRlIHJlYWRvbmx5IHBhcmVudFN0YWdlRGVzY3JpcHRpb25zOiBNYXA8c3RyaW5nLCBzdHJpbmc+O1xuICBwcml2YXRlIHJlYWRvbmx5IHJlc2VydmVkU3RlcE51bWJlcjogbnVtYmVyO1xuICBwcml2YXRlIHJlYWRvbmx5IGRlY2lkZXJEZXNjcmlwdGlvbj86IHN0cmluZztcbiAgcHJpdmF0ZSByZWFkb25seSBicmFuY2hEZXNjSW5mbzogQXJyYXk8eyBpZDogc3RyaW5nOyBkZXNjcmlwdGlvbj86IHN0cmluZyB9PiA9IFtdO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIGJ1aWxkZXI6IEZsb3dDaGFydEJ1aWxkZXI8VE91dCwgVFNjb3BlPixcbiAgICBjdXJOb2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPixcbiAgICBjdXJTcGVjOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUsXG4gICAgcGFyZW50RGVzY3JpcHRpb25QYXJ0czogc3RyaW5nW10gPSBbXSxcbiAgICBwYXJlbnRTdGFnZURlc2NyaXB0aW9uczogTWFwPHN0cmluZywgc3RyaW5nPiA9IG5ldyBNYXAoKSxcbiAgICByZXNlcnZlZFN0ZXBOdW1iZXIgPSAwLFxuICAgIGRlY2lkZXJEZXNjcmlwdGlvbj86IHN0cmluZyxcbiAgKSB7XG4gICAgdGhpcy5iID0gYnVpbGRlcjtcbiAgICB0aGlzLmN1ck5vZGUgPSBjdXJOb2RlO1xuICAgIHRoaXMuY3VyU3BlYyA9IGN1clNwZWM7XG4gICAgdGhpcy5wYXJlbnREZXNjcmlwdGlvblBhcnRzID0gcGFyZW50RGVzY3JpcHRpb25QYXJ0cztcbiAgICB0aGlzLnBhcmVudFN0YWdlRGVzY3JpcHRpb25zID0gcGFyZW50U3RhZ2VEZXNjcmlwdGlvbnM7XG4gICAgdGhpcy5yZXNlcnZlZFN0ZXBOdW1iZXIgPSByZXNlcnZlZFN0ZXBOdW1iZXI7XG4gICAgdGhpcy5kZWNpZGVyRGVzY3JpcHRpb24gPSBkZWNpZGVyRGVzY3JpcHRpb247XG4gIH1cblxuICBhZGRGdW5jdGlvbkJyYW5jaChcbiAgICBpZDogc3RyaW5nLFxuICAgIG5hbWU6IHN0cmluZyxcbiAgICBmbj86IFN0YWdlRnVuY3Rpb248VE91dCwgVFNjb3BlPixcbiAgICBkZXNjcmlwdGlvbj86IHN0cmluZyxcbiAgKTogRGVjaWRlckxpc3Q8VE91dCwgVFNjb3BlPiB7XG4gICAgaWYgKHRoaXMuYnJhbmNoSWRzLmhhcyhpZCkpIGZhaWwoYGR1cGxpY2F0ZSBkZWNpZGVyIGJyYW5jaCBpZCAnJHtpZH0nIHVuZGVyICcke3RoaXMuY3VyTm9kZS5uYW1lfSdgKTtcbiAgICB0aGlzLmJyYW5jaElkcy5hZGQoaWQpO1xuXG4gICAgY29uc3Qgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7IG5hbWU6IG5hbWUgPz8gaWQsIGlkLCBicmFuY2hJZDogaWQgfTtcbiAgICBpZiAoZGVzY3JpcHRpb24pIG5vZGUuZGVzY3JpcHRpb24gPSBkZXNjcmlwdGlvbjtcbiAgICBpZiAoZm4pIHtcbiAgICAgIG5vZGUuZm4gPSBmbjtcbiAgICAgIHRoaXMuYi5fYWRkVG9NYXAoaWQsIGZuKTtcbiAgICB9XG5cbiAgICBsZXQgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0geyBuYW1lOiBuYW1lID8/IGlkLCBpZCwgdHlwZTogJ3N0YWdlJyB9O1xuICAgIGlmIChkZXNjcmlwdGlvbikgc3BlYy5kZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uO1xuICAgIHNwZWMgPSB0aGlzLmIuX2FwcGx5RXh0cmFjdG9yVG9Ob2RlKHNwZWMpO1xuXG4gICAgdGhpcy5jdXJOb2RlLmNoaWxkcmVuID0gdGhpcy5jdXJOb2RlLmNoaWxkcmVuIHx8IFtdO1xuICAgIHRoaXMuY3VyTm9kZS5jaGlsZHJlbi5wdXNoKG5vZGUpO1xuICAgIHRoaXMuY3VyU3BlYy5jaGlsZHJlbiA9IHRoaXMuY3VyU3BlYy5jaGlsZHJlbiB8fCBbXTtcbiAgICB0aGlzLmN1clNwZWMuY2hpbGRyZW4ucHVzaChzcGVjKTtcblxuICAgIHRoaXMuYnJhbmNoRGVzY0luZm8ucHVzaCh7IGlkLCBkZXNjcmlwdGlvbiB9KTtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIGFkZFN1YkZsb3dDaGFydEJyYW5jaChcbiAgICBpZDogc3RyaW5nLFxuICAgIHN1YmZsb3c6IEZsb3dDaGFydDxhbnksIGFueT4sXG4gICAgbW91bnROYW1lPzogc3RyaW5nLFxuICAgIG9wdGlvbnM/OiBTdWJmbG93TW91bnRPcHRpb25zLFxuICApOiBEZWNpZGVyTGlzdDxUT3V0LCBUU2NvcGU+IHtcbiAgICBpZiAodGhpcy5icmFuY2hJZHMuaGFzKGlkKSkgZmFpbChgZHVwbGljYXRlIGRlY2lkZXIgYnJhbmNoIGlkICcke2lkfScgdW5kZXIgJyR7dGhpcy5jdXJOb2RlLm5hbWV9J2ApO1xuICAgIHRoaXMuYnJhbmNoSWRzLmFkZChpZCk7XG5cbiAgICBjb25zdCBzdWJmbG93TmFtZSA9IG1vdW50TmFtZSB8fCBpZDtcbiAgICBjb25zdCBwcmVmaXhlZFJvb3QgPSB0aGlzLmIuX3ByZWZpeE5vZGVUcmVlKHN1YmZsb3cucm9vdCwgaWQpO1xuXG4gICAgaWYgKCF0aGlzLmIuX3N1YmZsb3dEZWZzLmhhcyhpZCkpIHtcbiAgICAgIHRoaXMuYi5fc3ViZmxvd0RlZnMuc2V0KGlkLCB7IHJvb3Q6IHByZWZpeGVkUm9vdCB9KTtcbiAgICB9XG5cbiAgICBjb25zdCBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiA9IHtcbiAgICAgIG5hbWU6IHN1YmZsb3dOYW1lLFxuICAgICAgaWQsXG4gICAgICBicmFuY2hJZDogaWQsXG4gICAgICBpc1N1YmZsb3dSb290OiB0cnVlLFxuICAgICAgc3ViZmxvd0lkOiBpZCxcbiAgICAgIHN1YmZsb3dOYW1lLFxuICAgIH07XG4gICAgaWYgKG9wdGlvbnMpIG5vZGUuc3ViZmxvd01vdW50T3B0aW9ucyA9IG9wdGlvbnM7XG5cbiAgICBjb25zdCBzcGVjOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUgPSB7XG4gICAgICBuYW1lOiBzdWJmbG93TmFtZSxcbiAgICAgIHR5cGU6ICdzdGFnZScsXG4gICAgICBpZCxcbiAgICAgIGlzU3ViZmxvd1Jvb3Q6IHRydWUsXG4gICAgICBzdWJmbG93SWQ6IGlkLFxuICAgICAgc3ViZmxvd05hbWUsXG4gICAgICBzdWJmbG93U3RydWN0dXJlOiBzdWJmbG93LmJ1aWxkVGltZVN0cnVjdHVyZSxcbiAgICB9O1xuXG4gICAgdGhpcy5jdXJOb2RlLmNoaWxkcmVuID0gdGhpcy5jdXJOb2RlLmNoaWxkcmVuIHx8IFtdO1xuICAgIHRoaXMuY3VyTm9kZS5jaGlsZHJlbi5wdXNoKG5vZGUpO1xuICAgIHRoaXMuY3VyU3BlYy5jaGlsZHJlbiA9IHRoaXMuY3VyU3BlYy5jaGlsZHJlbiB8fCBbXTtcbiAgICB0aGlzLmN1clNwZWMuY2hpbGRyZW4ucHVzaChzcGVjKTtcblxuICAgIHRoaXMuYi5fbWVyZ2VTdGFnZU1hcChzdWJmbG93LnN0YWdlTWFwLCBpZCk7XG4gICAgdGhpcy5iLl9tZXJnZVN1YmZsb3dzKHN1YmZsb3cuc3ViZmxvd3MsIGlkKTtcblxuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgYWRkTGF6eVN1YkZsb3dDaGFydEJyYW5jaChcbiAgICBpZDogc3RyaW5nLFxuICAgIHJlc29sdmVyOiAoKSA9PiBGbG93Q2hhcnQ8YW55LCBhbnk+LFxuICAgIG1vdW50TmFtZT86IHN0cmluZyxcbiAgICBvcHRpb25zPzogU3ViZmxvd01vdW50T3B0aW9ucyxcbiAgKTogRGVjaWRlckxpc3Q8VE91dCwgVFNjb3BlPiB7XG4gICAgaWYgKHRoaXMuYnJhbmNoSWRzLmhhcyhpZCkpIGZhaWwoYGR1cGxpY2F0ZSBkZWNpZGVyIGJyYW5jaCBpZCAnJHtpZH0nIHVuZGVyICcke3RoaXMuY3VyTm9kZS5uYW1lfSdgKTtcbiAgICB0aGlzLmJyYW5jaElkcy5hZGQoaWQpO1xuXG4gICAgY29uc3Qgc3ViZmxvd05hbWUgPSBtb3VudE5hbWUgfHwgaWQ7XG5cbiAgICAvLyBTdG9yZSByZXNvbHZlciBvbiB0aGUgbm9kZSDigJQgTk8gZWFnZXIgdHJlZSBjbG9uaW5nXG4gICAgY29uc3Qgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7XG4gICAgICBuYW1lOiBzdWJmbG93TmFtZSxcbiAgICAgIGlkLFxuICAgICAgYnJhbmNoSWQ6IGlkLFxuICAgICAgaXNTdWJmbG93Um9vdDogdHJ1ZSxcbiAgICAgIHN1YmZsb3dJZDogaWQsXG4gICAgICBzdWJmbG93TmFtZSxcbiAgICAgIHN1YmZsb3dSZXNvbHZlcjogcmVzb2x2ZXIgYXMgYW55LFxuICAgIH07XG4gICAgaWYgKG9wdGlvbnMpIG5vZGUuc3ViZmxvd01vdW50T3B0aW9ucyA9IG9wdGlvbnM7XG5cbiAgICAvLyBTcGVjIHN0dWIg4oCUIG5vIHN1YmZsb3dTdHJ1Y3R1cmUgKGxhenkpXG4gICAgY29uc3Qgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0ge1xuICAgICAgbmFtZTogc3ViZmxvd05hbWUsXG4gICAgICB0eXBlOiAnc3RhZ2UnLFxuICAgICAgaWQsXG4gICAgICBpc1N1YmZsb3dSb290OiB0cnVlLFxuICAgICAgc3ViZmxvd0lkOiBpZCxcbiAgICAgIHN1YmZsb3dOYW1lLFxuICAgICAgaXNMYXp5OiB0cnVlLFxuICAgIH07XG5cbiAgICB0aGlzLmN1ck5vZGUuY2hpbGRyZW4gPSB0aGlzLmN1ck5vZGUuY2hpbGRyZW4gfHwgW107XG4gICAgdGhpcy5jdXJOb2RlLmNoaWxkcmVuLnB1c2gobm9kZSk7XG4gICAgdGhpcy5jdXJTcGVjLmNoaWxkcmVuID0gdGhpcy5jdXJTcGVjLmNoaWxkcmVuIHx8IFtdO1xuICAgIHRoaXMuY3VyU3BlYy5jaGlsZHJlbi5wdXNoKHNwZWMpO1xuXG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBhZGRCcmFuY2hMaXN0KFxuICAgIGJyYW5jaGVzOiBBcnJheTx7XG4gICAgICBpZDogc3RyaW5nO1xuICAgICAgbmFtZTogc3RyaW5nO1xuICAgICAgZm4/OiBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT47XG4gICAgfT4sXG4gICk6IERlY2lkZXJMaXN0PFRPdXQsIFRTY29wZT4ge1xuICAgIGZvciAoY29uc3QgeyBpZCwgbmFtZSwgZm4gfSBvZiBicmFuY2hlcykge1xuICAgICAgdGhpcy5hZGRGdW5jdGlvbkJyYW5jaChpZCwgbmFtZSwgZm4pO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIHNldERlZmF1bHQoaWQ6IHN0cmluZyk6IERlY2lkZXJMaXN0PFRPdXQsIFRTY29wZT4ge1xuICAgIHRoaXMuZGVmYXVsdElkID0gaWQ7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBlbmQoKTogRmxvd0NoYXJ0QnVpbGRlcjxUT3V0LCBUU2NvcGU+IHtcbiAgICBjb25zdCBjaGlsZHJlbiA9IHRoaXMuY3VyTm9kZS5jaGlsZHJlbjtcbiAgICBpZiAoIWNoaWxkcmVuIHx8IGNoaWxkcmVuLmxlbmd0aCA9PT0gMCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBbRmxvd0NoYXJ0QnVpbGRlcl0gZGVjaWRlciBhdCAnJHt0aGlzLmN1ck5vZGUubmFtZX0nIHJlcXVpcmVzIGF0IGxlYXN0IG9uZSBicmFuY2hgKTtcbiAgICB9XG5cbiAgICAvLyBWYWxpZGF0ZSB0aGF0IGV2ZXJ5IGJyYW5jaCB3aXRoIG5vIGVtYmVkZGVkIGZuIGlzIHJlc29sdmFibGUgZnJvbSB0aGUgc3RhZ2VNYXBcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIGNoaWxkcmVuKSB7XG4gICAgICBpZiAoIWNoaWxkLmZuICYmIGNoaWxkLmlkICYmICFjaGlsZC5pc1N1YmZsb3dSb290ICYmICFjaGlsZC5zdWJmbG93UmVzb2x2ZXIpIHtcbiAgICAgICAgY29uc3QgaGFzSW5NYXAgPSB0aGlzLmIuX3N0YWdlTWFwSGFzKGNoaWxkLmlkKSB8fCB0aGlzLmIuX3N0YWdlTWFwSGFzKGNoaWxkLm5hbWUpO1xuICAgICAgICBpZiAoIWhhc0luTWFwKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgYFtGbG93Q2hhcnRCdWlsZGVyXSBkZWNpZGVyIGJyYW5jaCAnJHtjaGlsZC5pZH0nIHVuZGVyICcke3RoaXMuY3VyTm9kZS5uYW1lfScgaGFzIG5vIGZ1bmN0aW9uIOKAlCBgICtcbiAgICAgICAgICAgICAgYHByb3ZpZGUgYSBmbiBhcmd1bWVudCB0byBhZGRGdW5jdGlvbkJyYW5jaCgnJHtjaGlsZC5pZH0nLCAuLi4pYCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgdGhpcy5jdXJOb2RlLmRlY2lkZXJGbiA9IHRydWU7XG5cbiAgICAvLyBCdWlsZCBicmFuY2hJZHMgQkVGT1JFIGFwcGVuZGluZyB0aGUgc3ludGhldGljIGRlZmF1bHQg4oCUIG9ubHkgdXNlci1zcGVjaWZpZWQgYnJhbmNoZXNcbiAgICB0aGlzLmN1clNwZWMuYnJhbmNoSWRzID0gY2hpbGRyZW5cbiAgICAgIC5tYXAoKGMpID0+IGMuaWQpXG4gICAgICAuZmlsdGVyKChpZCk6IGlkIGlzIHN0cmluZyA9PiB0eXBlb2YgaWQgPT09ICdzdHJpbmcnICYmIGlkLmxlbmd0aCA+IDApO1xuICAgIHRoaXMuY3VyU3BlYy50eXBlID0gJ2RlY2lkZXInO1xuXG4gICAgaWYgKHRoaXMuZGVmYXVsdElkKSB7XG4gICAgICBjb25zdCBkZWZhdWx0Q2hpbGQgPSBjaGlsZHJlbi5maW5kKChjKSA9PiBjLmlkID09PSB0aGlzLmRlZmF1bHRJZCk7XG4gICAgICBpZiAoZGVmYXVsdENoaWxkKSB7XG4gICAgICAgIGNoaWxkcmVuLnB1c2goeyAuLi5kZWZhdWx0Q2hpbGQsIGlkOiAnZGVmYXVsdCcsIGJyYW5jaElkOiAnZGVmYXVsdCcgfSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHRoaXMucmVzZXJ2ZWRTdGVwTnVtYmVyID4gMCkge1xuICAgICAgY29uc3QgZGVjaWRlckxhYmVsID0gdGhpcy5jdXJOb2RlLm5hbWU7XG4gICAgICBjb25zdCBicmFuY2hJZExpc3QgPSB0aGlzLmJyYW5jaERlc2NJbmZvLm1hcCgoYikgPT4gYi5pZCkuam9pbignLCAnKTtcbiAgICAgIGNvbnN0IG1haW5MaW5lID0gdGhpcy5kZWNpZGVyRGVzY3JpcHRpb25cbiAgICAgICAgPyBgJHt0aGlzLnJlc2VydmVkU3RlcE51bWJlcn0uICR7ZGVjaWRlckxhYmVsfSDigJQgJHt0aGlzLmRlY2lkZXJEZXNjcmlwdGlvbn0gKGJyYW5jaGVzOiAke2JyYW5jaElkTGlzdH0pYFxuICAgICAgICA6IGAke3RoaXMucmVzZXJ2ZWRTdGVwTnVtYmVyfS4gJHtkZWNpZGVyTGFiZWx9IOKAlCBEZWNpZGVzIGJldHdlZW46ICR7YnJhbmNoSWRMaXN0fWA7XG4gICAgICB0aGlzLnBhcmVudERlc2NyaXB0aW9uUGFydHMucHVzaChtYWluTGluZSk7XG5cbiAgICAgIGlmICh0aGlzLmRlY2lkZXJEZXNjcmlwdGlvbikge1xuICAgICAgICB0aGlzLnBhcmVudFN0YWdlRGVzY3JpcHRpb25zLnNldCh0aGlzLmN1ck5vZGUubmFtZSwgdGhpcy5kZWNpZGVyRGVzY3JpcHRpb24pO1xuICAgICAgfVxuXG4gICAgICBmb3IgKGNvbnN0IGJyYW5jaCBvZiB0aGlzLmJyYW5jaERlc2NJbmZvKSB7XG4gICAgICAgIGNvbnN0IGJyYW5jaFRleHQgPSBicmFuY2guZGVzY3JpcHRpb247XG4gICAgICAgIGlmIChicmFuY2hUZXh0KSB7XG4gICAgICAgICAgdGhpcy5wYXJlbnREZXNjcmlwdGlvblBhcnRzLnB1c2goYCAgIOKGkiAke2JyYW5jaC5pZH06ICR7YnJhbmNoVGV4dH1gKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoYnJhbmNoLmRlc2NyaXB0aW9uKSB7XG4gICAgICAgICAgdGhpcy5wYXJlbnRTdGFnZURlc2NyaXB0aW9ucy5zZXQoYnJhbmNoLmlkLCBicmFuY2guZGVzY3JpcHRpb24pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIHRoaXMuYjtcbiAgfVxufVxuXG4vLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vIFNlbGVjdG9yRm5MaXN0IChzY29wZS1iYXNlZCBzZWxlY3RvciDigJQgbWlycm9ycyBEZWNpZGVyTGlzdClcbi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5leHBvcnQgY2xhc3MgU2VsZWN0b3JGbkxpc3Q8VE91dCA9IGFueSwgVFNjb3BlID0gYW55PiB7XG4gIHByaXZhdGUgcmVhZG9ubHkgYjogRmxvd0NoYXJ0QnVpbGRlcjxUT3V0LCBUU2NvcGU+O1xuICBwcml2YXRlIHJlYWRvbmx5IGN1ck5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+O1xuICBwcml2YXRlIHJlYWRvbmx5IGN1clNwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZTtcbiAgcHJpdmF0ZSByZWFkb25seSBicmFuY2hJZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICBwcml2YXRlIHJlYWRvbmx5IHBhcmVudERlc2NyaXB0aW9uUGFydHM6IHN0cmluZ1tdO1xuICBwcml2YXRlIHJlYWRvbmx5IHBhcmVudFN0YWdlRGVzY3JpcHRpb25zOiBNYXA8c3RyaW5nLCBzdHJpbmc+O1xuICBwcml2YXRlIHJlYWRvbmx5IHJlc2VydmVkU3RlcE51bWJlcjogbnVtYmVyO1xuICBwcml2YXRlIHJlYWRvbmx5IHNlbGVjdG9yRGVzY3JpcHRpb24/OiBzdHJpbmc7XG4gIHByaXZhdGUgcmVhZG9ubHkgYnJhbmNoRGVzY0luZm86IEFycmF5PHsgaWQ6IHN0cmluZzsgZGVzY3JpcHRpb24/OiBzdHJpbmcgfT4gPSBbXTtcblxuICBjb25zdHJ1Y3RvcihcbiAgICBidWlsZGVyOiBGbG93Q2hhcnRCdWlsZGVyPFRPdXQsIFRTY29wZT4sXG4gICAgY3VyTm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4sXG4gICAgY3VyU3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlLFxuICAgIHBhcmVudERlc2NyaXB0aW9uUGFydHM6IHN0cmluZ1tdID0gW10sXG4gICAgcGFyZW50U3RhZ2VEZXNjcmlwdGlvbnM6IE1hcDxzdHJpbmcsIHN0cmluZz4gPSBuZXcgTWFwKCksXG4gICAgcmVzZXJ2ZWRTdGVwTnVtYmVyID0gMCxcbiAgICBzZWxlY3RvckRlc2NyaXB0aW9uPzogc3RyaW5nLFxuICApIHtcbiAgICB0aGlzLmIgPSBidWlsZGVyO1xuICAgIHRoaXMuY3VyTm9kZSA9IGN1ck5vZGU7XG4gICAgdGhpcy5jdXJTcGVjID0gY3VyU3BlYztcbiAgICB0aGlzLnBhcmVudERlc2NyaXB0aW9uUGFydHMgPSBwYXJlbnREZXNjcmlwdGlvblBhcnRzO1xuICAgIHRoaXMucGFyZW50U3RhZ2VEZXNjcmlwdGlvbnMgPSBwYXJlbnRTdGFnZURlc2NyaXB0aW9ucztcbiAgICB0aGlzLnJlc2VydmVkU3RlcE51bWJlciA9IHJlc2VydmVkU3RlcE51bWJlcjtcbiAgICB0aGlzLnNlbGVjdG9yRGVzY3JpcHRpb24gPSBzZWxlY3RvckRlc2NyaXB0aW9uO1xuICB9XG5cbiAgYWRkRnVuY3Rpb25CcmFuY2goXG4gICAgaWQ6IHN0cmluZyxcbiAgICBuYW1lOiBzdHJpbmcsXG4gICAgZm4/OiBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4sXG4gICAgZGVzY3JpcHRpb24/OiBzdHJpbmcsXG4gICk6IFNlbGVjdG9yRm5MaXN0PFRPdXQsIFRTY29wZT4ge1xuICAgIGlmICh0aGlzLmJyYW5jaElkcy5oYXMoaWQpKSBmYWlsKGBkdXBsaWNhdGUgc2VsZWN0b3IgYnJhbmNoIGlkICcke2lkfScgdW5kZXIgJyR7dGhpcy5jdXJOb2RlLm5hbWV9J2ApO1xuICAgIHRoaXMuYnJhbmNoSWRzLmFkZChpZCk7XG5cbiAgICBjb25zdCBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiA9IHsgbmFtZTogbmFtZSA/PyBpZCwgaWQsIGJyYW5jaElkOiBpZCB9O1xuICAgIGlmIChkZXNjcmlwdGlvbikgbm9kZS5kZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uO1xuICAgIGlmIChmbikge1xuICAgICAgbm9kZS5mbiA9IGZuO1xuICAgICAgdGhpcy5iLl9hZGRUb01hcChpZCwgZm4pO1xuICAgIH1cblxuICAgIGxldCBzcGVjOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUgPSB7IG5hbWU6IG5hbWUgPz8gaWQsIGlkLCB0eXBlOiAnc3RhZ2UnIH07XG4gICAgaWYgKGRlc2NyaXB0aW9uKSBzcGVjLmRlc2NyaXB0aW9uID0gZGVzY3JpcHRpb247XG4gICAgc3BlYyA9IHRoaXMuYi5fYXBwbHlFeHRyYWN0b3JUb05vZGUoc3BlYyk7XG5cbiAgICB0aGlzLmN1ck5vZGUuY2hpbGRyZW4gPSB0aGlzLmN1ck5vZGUuY2hpbGRyZW4gfHwgW107XG4gICAgdGhpcy5jdXJOb2RlLmNoaWxkcmVuLnB1c2gobm9kZSk7XG4gICAgdGhpcy5jdXJTcGVjLmNoaWxkcmVuID0gdGhpcy5jdXJTcGVjLmNoaWxkcmVuIHx8IFtdO1xuICAgIHRoaXMuY3VyU3BlYy5jaGlsZHJlbi5wdXNoKHNwZWMpO1xuXG4gICAgdGhpcy5icmFuY2hEZXNjSW5mby5wdXNoKHsgaWQsIGRlc2NyaXB0aW9uIH0pO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgYWRkU3ViRmxvd0NoYXJ0QnJhbmNoKFxuICAgIGlkOiBzdHJpbmcsXG4gICAgc3ViZmxvdzogRmxvd0NoYXJ0PGFueSwgYW55PixcbiAgICBtb3VudE5hbWU/OiBzdHJpbmcsXG4gICAgb3B0aW9ucz86IFN1YmZsb3dNb3VudE9wdGlvbnMsXG4gICk6IFNlbGVjdG9yRm5MaXN0PFRPdXQsIFRTY29wZT4ge1xuICAgIGlmICh0aGlzLmJyYW5jaElkcy5oYXMoaWQpKSBmYWlsKGBkdXBsaWNhdGUgc2VsZWN0b3IgYnJhbmNoIGlkICcke2lkfScgdW5kZXIgJyR7dGhpcy5jdXJOb2RlLm5hbWV9J2ApO1xuICAgIHRoaXMuYnJhbmNoSWRzLmFkZChpZCk7XG5cbiAgICBjb25zdCBzdWJmbG93TmFtZSA9IG1vdW50TmFtZSB8fCBpZDtcbiAgICBjb25zdCBwcmVmaXhlZFJvb3QgPSB0aGlzLmIuX3ByZWZpeE5vZGVUcmVlKHN1YmZsb3cucm9vdCwgaWQpO1xuXG4gICAgaWYgKCF0aGlzLmIuX3N1YmZsb3dEZWZzLmhhcyhpZCkpIHtcbiAgICAgIHRoaXMuYi5fc3ViZmxvd0RlZnMuc2V0KGlkLCB7IHJvb3Q6IHByZWZpeGVkUm9vdCB9KTtcbiAgICB9XG5cbiAgICBjb25zdCBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiA9IHtcbiAgICAgIG5hbWU6IHN1YmZsb3dOYW1lLFxuICAgICAgaWQsXG4gICAgICBicmFuY2hJZDogaWQsXG4gICAgICBpc1N1YmZsb3dSb290OiB0cnVlLFxuICAgICAgc3ViZmxvd0lkOiBpZCxcbiAgICAgIHN1YmZsb3dOYW1lLFxuICAgIH07XG4gICAgaWYgKG9wdGlvbnMpIG5vZGUuc3ViZmxvd01vdW50T3B0aW9ucyA9IG9wdGlvbnM7XG5cbiAgICBjb25zdCBzcGVjOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUgPSB7XG4gICAgICBuYW1lOiBzdWJmbG93TmFtZSxcbiAgICAgIHR5cGU6ICdzdGFnZScsXG4gICAgICBpZCxcbiAgICAgIGlzU3ViZmxvd1Jvb3Q6IHRydWUsXG4gICAgICBzdWJmbG93SWQ6IGlkLFxuICAgICAgc3ViZmxvd05hbWUsXG4gICAgICBzdWJmbG93U3RydWN0dXJlOiBzdWJmbG93LmJ1aWxkVGltZVN0cnVjdHVyZSxcbiAgICB9O1xuXG4gICAgdGhpcy5jdXJOb2RlLmNoaWxkcmVuID0gdGhpcy5jdXJOb2RlLmNoaWxkcmVuIHx8IFtdO1xuICAgIHRoaXMuY3VyTm9kZS5jaGlsZHJlbi5wdXNoKG5vZGUpO1xuICAgIHRoaXMuY3VyU3BlYy5jaGlsZHJlbiA9IHRoaXMuY3VyU3BlYy5jaGlsZHJlbiB8fCBbXTtcbiAgICB0aGlzLmN1clNwZWMuY2hpbGRyZW4ucHVzaChzcGVjKTtcblxuICAgIHRoaXMuYi5fbWVyZ2VTdGFnZU1hcChzdWJmbG93LnN0YWdlTWFwLCBpZCk7XG4gICAgdGhpcy5iLl9tZXJnZVN1YmZsb3dzKHN1YmZsb3cuc3ViZmxvd3MsIGlkKTtcblxuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgYWRkTGF6eVN1YkZsb3dDaGFydEJyYW5jaChcbiAgICBpZDogc3RyaW5nLFxuICAgIHJlc29sdmVyOiAoKSA9PiBGbG93Q2hhcnQ8YW55LCBhbnk+LFxuICAgIG1vdW50TmFtZT86IHN0cmluZyxcbiAgICBvcHRpb25zPzogU3ViZmxvd01vdW50T3B0aW9ucyxcbiAgKTogU2VsZWN0b3JGbkxpc3Q8VE91dCwgVFNjb3BlPiB7XG4gICAgaWYgKHRoaXMuYnJhbmNoSWRzLmhhcyhpZCkpIGZhaWwoYGR1cGxpY2F0ZSBzZWxlY3RvciBicmFuY2ggaWQgJyR7aWR9JyB1bmRlciAnJHt0aGlzLmN1ck5vZGUubmFtZX0nYCk7XG4gICAgdGhpcy5icmFuY2hJZHMuYWRkKGlkKTtcblxuICAgIGNvbnN0IHN1YmZsb3dOYW1lID0gbW91bnROYW1lIHx8IGlkO1xuXG4gICAgY29uc3Qgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7XG4gICAgICBuYW1lOiBzdWJmbG93TmFtZSxcbiAgICAgIGlkLFxuICAgICAgYnJhbmNoSWQ6IGlkLFxuICAgICAgaXNTdWJmbG93Um9vdDogdHJ1ZSxcbiAgICAgIHN1YmZsb3dJZDogaWQsXG4gICAgICBzdWJmbG93TmFtZSxcbiAgICAgIHN1YmZsb3dSZXNvbHZlcjogcmVzb2x2ZXIgYXMgYW55LFxuICAgIH07XG4gICAgaWYgKG9wdGlvbnMpIG5vZGUuc3ViZmxvd01vdW50T3B0aW9ucyA9IG9wdGlvbnM7XG5cbiAgICBjb25zdCBzcGVjOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUgPSB7XG4gICAgICBuYW1lOiBzdWJmbG93TmFtZSxcbiAgICAgIHR5cGU6ICdzdGFnZScsXG4gICAgICBpZCxcbiAgICAgIGlzU3ViZmxvd1Jvb3Q6IHRydWUsXG4gICAgICBzdWJmbG93SWQ6IGlkLFxuICAgICAgc3ViZmxvd05hbWUsXG4gICAgICBpc0xhenk6IHRydWUsXG4gICAgfTtcblxuICAgIHRoaXMuY3VyTm9kZS5jaGlsZHJlbiA9IHRoaXMuY3VyTm9kZS5jaGlsZHJlbiB8fCBbXTtcbiAgICB0aGlzLmN1ck5vZGUuY2hpbGRyZW4ucHVzaChub2RlKTtcbiAgICB0aGlzLmN1clNwZWMuY2hpbGRyZW4gPSB0aGlzLmN1clNwZWMuY2hpbGRyZW4gfHwgW107XG4gICAgdGhpcy5jdXJTcGVjLmNoaWxkcmVuLnB1c2goc3BlYyk7XG5cbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIGFkZEJyYW5jaExpc3QoXG4gICAgYnJhbmNoZXM6IEFycmF5PHtcbiAgICAgIGlkOiBzdHJpbmc7XG4gICAgICBuYW1lOiBzdHJpbmc7XG4gICAgICBmbj86IFN0YWdlRnVuY3Rpb248VE91dCwgVFNjb3BlPjtcbiAgICB9PixcbiAgKTogU2VsZWN0b3JGbkxpc3Q8VE91dCwgVFNjb3BlPiB7XG4gICAgZm9yIChjb25zdCB7IGlkLCBuYW1lLCBmbiB9IG9mIGJyYW5jaGVzKSB7XG4gICAgICB0aGlzLmFkZEZ1bmN0aW9uQnJhbmNoKGlkLCBuYW1lLCBmbik7XG4gICAgfVxuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgZW5kKCk6IEZsb3dDaGFydEJ1aWxkZXI8VE91dCwgVFNjb3BlPiB7XG4gICAgY29uc3QgY2hpbGRyZW4gPSB0aGlzLmN1ck5vZGUuY2hpbGRyZW47XG4gICAgaWYgKCFjaGlsZHJlbiB8fCBjaGlsZHJlbi5sZW5ndGggPT09IDApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgW0Zsb3dDaGFydEJ1aWxkZXJdIHNlbGVjdG9yIGF0ICcke3RoaXMuY3VyTm9kZS5uYW1lfScgcmVxdWlyZXMgYXQgbGVhc3Qgb25lIGJyYW5jaGApO1xuICAgIH1cblxuICAgIC8vIFZhbGlkYXRlIHRoYXQgZXZlcnkgYnJhbmNoIHdpdGggbm8gZW1iZWRkZWQgZm4gaXMgcmVzb2x2YWJsZSBmcm9tIHRoZSBzdGFnZU1hcFxuICAgIGZvciAoY29uc3QgY2hpbGQgb2YgY2hpbGRyZW4pIHtcbiAgICAgIGlmICghY2hpbGQuZm4gJiYgY2hpbGQuaWQgJiYgIWNoaWxkLmlzU3ViZmxvd1Jvb3QgJiYgIWNoaWxkLnN1YmZsb3dSZXNvbHZlcikge1xuICAgICAgICBjb25zdCBoYXNJbk1hcCA9IHRoaXMuYi5fc3RhZ2VNYXBIYXMoY2hpbGQuaWQpIHx8IHRoaXMuYi5fc3RhZ2VNYXBIYXMoY2hpbGQubmFtZSk7XG4gICAgICAgIGlmICghaGFzSW5NYXApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgW0Zsb3dDaGFydEJ1aWxkZXJdIHNlbGVjdG9yIGJyYW5jaCAnJHtjaGlsZC5pZH0nIHVuZGVyICcke3RoaXMuY3VyTm9kZS5uYW1lfScgaGFzIG5vIGZ1bmN0aW9uIOKAlCBgICtcbiAgICAgICAgICAgICAgYHByb3ZpZGUgYSBmbiBhcmd1bWVudCB0byBhZGRGdW5jdGlvbkJyYW5jaCgnJHtjaGlsZC5pZH0nLCAuLi4pYCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgdGhpcy5jdXJOb2RlLnNlbGVjdG9yRm4gPSB0cnVlO1xuXG4gICAgdGhpcy5jdXJTcGVjLmJyYW5jaElkcyA9IGNoaWxkcmVuXG4gICAgICAubWFwKChjKSA9PiBjLmlkKVxuICAgICAgLmZpbHRlcigoaWQpOiBpZCBpcyBzdHJpbmcgPT4gdHlwZW9mIGlkID09PSAnc3RyaW5nJyAmJiBpZC5sZW5ndGggPiAwKTtcbiAgICB0aGlzLmN1clNwZWMudHlwZSA9ICdzZWxlY3Rvcic7IC8vIHdhcyAnZGVjaWRlcicg4oCUIGluY29ycmVjdDsgc2VsZWN0b3JzIGFyZSBkaXN0aW5jdCBmcm9tIGRlY2lkZXJzXG4gICAgdGhpcy5jdXJTcGVjLmhhc1NlbGVjdG9yID0gdHJ1ZTtcblxuICAgIGlmICh0aGlzLnJlc2VydmVkU3RlcE51bWJlciA+IDApIHtcbiAgICAgIGNvbnN0IHNlbGVjdG9yTGFiZWwgPSB0aGlzLmN1ck5vZGUubmFtZTtcbiAgICAgIGNvbnN0IGJyYW5jaElkTGlzdCA9IHRoaXMuYnJhbmNoRGVzY0luZm8ubWFwKChiKSA9PiBiLmlkKS5qb2luKCcsICcpO1xuICAgICAgY29uc3QgbWFpbkxpbmUgPSB0aGlzLnNlbGVjdG9yRGVzY3JpcHRpb25cbiAgICAgICAgPyBgJHt0aGlzLnJlc2VydmVkU3RlcE51bWJlcn0uICR7c2VsZWN0b3JMYWJlbH0g4oCUICR7dGhpcy5zZWxlY3RvckRlc2NyaXB0aW9ufWBcbiAgICAgICAgOiBgJHt0aGlzLnJlc2VydmVkU3RlcE51bWJlcn0uICR7c2VsZWN0b3JMYWJlbH0g4oCUIFNlbGVjdHMgZnJvbTogJHticmFuY2hJZExpc3R9YDtcbiAgICAgIHRoaXMucGFyZW50RGVzY3JpcHRpb25QYXJ0cy5wdXNoKG1haW5MaW5lKTtcblxuICAgICAgaWYgKHRoaXMuc2VsZWN0b3JEZXNjcmlwdGlvbikge1xuICAgICAgICB0aGlzLnBhcmVudFN0YWdlRGVzY3JpcHRpb25zLnNldCh0aGlzLmN1ck5vZGUubmFtZSwgdGhpcy5zZWxlY3RvckRlc2NyaXB0aW9uKTtcbiAgICAgIH1cblxuICAgICAgZm9yIChjb25zdCBicmFuY2ggb2YgdGhpcy5icmFuY2hEZXNjSW5mbykge1xuICAgICAgICBjb25zdCBicmFuY2hUZXh0ID0gYnJhbmNoLmRlc2NyaXB0aW9uO1xuICAgICAgICBpZiAoYnJhbmNoVGV4dCkgdGhpcy5wYXJlbnREZXNjcmlwdGlvblBhcnRzLnB1c2goYCAgIOKGkiAke2JyYW5jaC5pZH06ICR7YnJhbmNoVGV4dH1gKTtcbiAgICAgICAgaWYgKGJyYW5jaC5kZXNjcmlwdGlvbikgdGhpcy5wYXJlbnRTdGFnZURlc2NyaXB0aW9ucy5zZXQoYnJhbmNoLmlkLCBicmFuY2guZGVzY3JpcHRpb24pO1xuICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiB0aGlzLmI7XG4gIH1cbn1cblxuLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyBGbG93Q2hhcnRCdWlsZGVyXG4vLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuZXhwb3J0IGNsYXNzIEZsb3dDaGFydEJ1aWxkZXI8VE91dCA9IGFueSwgVFNjb3BlID0gYW55PiB7XG4gIHByaXZhdGUgX3Jvb3Q/OiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPjtcbiAgcHJpdmF0ZSBfcm9vdFNwZWM/OiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmU7XG4gIHByaXZhdGUgX2N1cnNvcj86IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+O1xuICBwcml2YXRlIF9jdXJzb3JTcGVjPzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlO1xuICBwcml2YXRlIF9zdGFnZU1hcCA9IG5ldyBNYXA8c3RyaW5nLCBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4+KCk7XG4gIF9zdWJmbG93RGVmcyA9IG5ldyBNYXA8c3RyaW5nLCB7IHJvb3Q6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+IH0+KCk7XG4gIHByaXZhdGUgX3N0cmVhbUhhbmRsZXJzOiBTdHJlYW1IYW5kbGVycyA9IHt9O1xuICBwcml2YXRlIF9leHRyYWN0b3I/OiBUcmF2ZXJzYWxFeHRyYWN0b3I7XG4gIHByaXZhdGUgX2J1aWxkVGltZUV4dHJhY3Rvcj86IEJ1aWxkVGltZUV4dHJhY3Rvcjxhbnk+O1xuICBwcml2YXRlIF9idWlsZFRpbWVFeHRyYWN0b3JFcnJvcnM6IEFycmF5PHsgbWVzc2FnZTogc3RyaW5nOyBlcnJvcjogdW5rbm93biB9PiA9IFtdO1xuICBwcml2YXRlIF9lbmFibGVOYXJyYXRpdmUgPSBmYWxzZTtcbiAgcHJpdmF0ZSBfbG9nZ2VyPzogSUxvZ2dlcjtcbiAgcHJpdmF0ZSBfZGVzY3JpcHRpb25QYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgcHJpdmF0ZSBfc3RlcENvdW50ZXIgPSAwO1xuICAvLyBOT1RFOiBrZXllZCBieSBzdGFnZSBuYW1lIChmb3IgaHVtYW4tcmVhZGFibGUgZGVzY3JpcHRpb25zKSwgd2hpbGUgc3RhZ2VNYXBcbiAgLy8gYW5kIGtub3duU3RhZ2VJZHMgdXNlIGlkIChzdGFibGUgaWRlbnRpZmllcikuIFRoZXNlIGFyZSBpbnRlbnRpb25hbGx5IGRpZmZlcmVudFxuICAvLyBuYW1lc3BhY2VzIOKAlCBkZXNjcmlwdGlvbnMgYXJlIHByZXNlbnRhdGlvbmFsLCBsb29rdXBzIGFyZSBzdHJ1Y3R1cmFsLlxuICBwcml2YXRlIF9zdGFnZURlc2NyaXB0aW9ucyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIHByaXZhdGUgX3N0YWdlU3RlcE1hcCA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIHByaXZhdGUgX2tub3duU3RhZ2VJZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgcHJpdmF0ZSBfaW5wdXRTY2hlbWE/OiB1bmtub3duO1xuICBwcml2YXRlIF9vdXRwdXRTY2hlbWE/OiB1bmtub3duO1xuICBwcml2YXRlIF9vdXRwdXRNYXBwZXI/OiAoZmluYWxTY29wZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHVua25vd247XG4gIHByaXZhdGUgX3Njb3BlRmFjdG9yeT86IFNjb3BlRmFjdG9yeTxUU2NvcGU+O1xuXG4gIGNvbnN0cnVjdG9yKGJ1aWxkVGltZUV4dHJhY3Rvcj86IEJ1aWxkVGltZUV4dHJhY3Rvcjxhbnk+KSB7XG4gICAgaWYgKGJ1aWxkVGltZUV4dHJhY3Rvcikge1xuICAgICAgdGhpcy5fYnVpbGRUaW1lRXh0cmFjdG9yID0gYnVpbGRUaW1lRXh0cmFjdG9yO1xuICAgIH1cbiAgfVxuXG4gIC8vIOKUgOKUgCBEZXNjcmlwdGlvbiBoZWxwZXJzIOKUgOKUgFxuXG4gIHByaXZhdGUgX2FwcGVuZERlc2NyaXB0aW9uTGluZShuYW1lOiBzdHJpbmcsIGRlc2NyaXB0aW9uPzogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5fc3RlcENvdW50ZXIrKztcbiAgICB0aGlzLl9zdGFnZVN0ZXBNYXAuc2V0KG5hbWUsIHRoaXMuX3N0ZXBDb3VudGVyKTtcbiAgICBjb25zdCBsaW5lID0gZGVzY3JpcHRpb24gPyBgJHt0aGlzLl9zdGVwQ291bnRlcn0uICR7bmFtZX0g4oCUICR7ZGVzY3JpcHRpb259YCA6IGAke3RoaXMuX3N0ZXBDb3VudGVyfS4gJHtuYW1lfWA7XG4gICAgdGhpcy5fZGVzY3JpcHRpb25QYXJ0cy5wdXNoKGxpbmUpO1xuICAgIGlmIChkZXNjcmlwdGlvbikge1xuICAgICAgdGhpcy5fc3RhZ2VEZXNjcmlwdGlvbnMuc2V0KG5hbWUsIGRlc2NyaXB0aW9uKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIF9hcHBlbmRTdWJmbG93RGVzY3JpcHRpb24oaWQ6IHN0cmluZywgbmFtZTogc3RyaW5nLCBzdWJmbG93OiBGbG93Q2hhcnQ8YW55LCBhbnk+KTogdm9pZCB7XG4gICAgdGhpcy5fc3RlcENvdW50ZXIrKztcbiAgICB0aGlzLl9zdGFnZVN0ZXBNYXAuc2V0KGlkLCB0aGlzLl9zdGVwQ291bnRlcik7XG4gICAgaWYgKHN1YmZsb3cuZGVzY3JpcHRpb24pIHtcbiAgICAgIHRoaXMuX2Rlc2NyaXB0aW9uUGFydHMucHVzaChgJHt0aGlzLl9zdGVwQ291bnRlcn0uIFtTdWItRXhlY3V0aW9uOiAke25hbWV9XSDigJQgJHtzdWJmbG93LmRlc2NyaXB0aW9ufWApO1xuICAgICAgY29uc3QgbGluZXMgPSBzdWJmbG93LmRlc2NyaXB0aW9uLnNwbGl0KCdcXG4nKTtcbiAgICAgIGNvbnN0IHN0ZXBzSWR4ID0gbGluZXMuZmluZEluZGV4KChsKSA9PiBsLnN0YXJ0c1dpdGgoJ1N0ZXBzOicpKTtcbiAgICAgIGlmIChzdGVwc0lkeCA+PSAwKSB7XG4gICAgICAgIGZvciAobGV0IGkgPSBzdGVwc0lkeCArIDE7IGkgPCBsaW5lcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgIGlmIChsaW5lc1tpXS50cmltKCkpIHRoaXMuX2Rlc2NyaXB0aW9uUGFydHMucHVzaChgICAgJHtsaW5lc1tpXX1gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLl9kZXNjcmlwdGlvblBhcnRzLnB1c2goYCR7dGhpcy5fc3RlcENvdW50ZXJ9LiBbU3ViLUV4ZWN1dGlvbjogJHtuYW1lfV1gKTtcbiAgICB9XG4gIH1cblxuICAvLyDilIDilIAgQ29uZmlndXJhdGlvbiDilIDilIBcblxuICBzZXRMb2dnZXIobG9nZ2VyOiBJTG9nZ2VyKTogdGhpcyB7XG4gICAgdGhpcy5fbG9nZ2VyID0gbG9nZ2VyO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgLyoqXG4gICAqIERlY2xhcmUgdGhlIEFQSSBjb250cmFjdCDigJQgaW5wdXQgdmFsaWRhdGlvbiwgb3V0cHV0IHNoYXBlLCBhbmQgb3V0cHV0IG1hcHBlci5cbiAgICogUmVwbGFjZXMgc2V0SW5wdXRTY2hlbWEoKSArIHNldE91dHB1dFNjaGVtYSgpICsgc2V0T3V0cHV0TWFwcGVyKCkgaW4gYSBzaW5nbGUgY2FsbC5cbiAgICpcbiAgICogSWYgYSBjb250cmFjdCB3aXRoIGlucHV0IHNjaGVtYSBpcyBkZWNsYXJlZCwgY2hhcnQucnVuKCkgdmFsaWRhdGVzIGlucHV0IGF1dG9tYXRpY2FsbHkuXG4gICAqIENvbnRyYWN0IGRhdGEgaXMgdXNlZCBieSBjaGFydC50b09wZW5BUEkoKSBhbmQgY2hhcnQudG9NQ1BUb29sKCkuXG4gICAqL1xuICBjb250cmFjdChvcHRzOiB7XG4gICAgaW5wdXQ/OiB1bmtub3duO1xuICAgIG91dHB1dD86IHVua25vd247XG4gICAgbWFwcGVyPzogKGZpbmFsU2NvcGU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB1bmtub3duO1xuICB9KTogdGhpcyB7XG4gICAgaWYgKG9wdHMuaW5wdXQpIHRoaXMuX2lucHV0U2NoZW1hID0gb3B0cy5pbnB1dDtcbiAgICBpZiAob3B0cy5vdXRwdXQpIHRoaXMuX291dHB1dFNjaGVtYSA9IG9wdHMub3V0cHV0O1xuICAgIGlmIChvcHRzLm1hcHBlcikgdGhpcy5fb3V0cHV0TWFwcGVyID0gb3B0cy5tYXBwZXI7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICAvLyDilIDilIAgTGluZWFyIENoYWluaW5nIOKUgOKUgFxuXG4gIHN0YXJ0KFxuICAgIG5hbWU6IHN0cmluZyxcbiAgICBmbjogU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+IHwgUGF1c2FibGVIYW5kbGVyPFRTY29wZT4sXG4gICAgaWQ6IHN0cmluZyxcbiAgICBkZXNjcmlwdGlvbj86IHN0cmluZyxcbiAgKTogdGhpcyB7XG4gICAgaWYgKHRoaXMuX3Jvb3QpIGZhaWwoJ3Jvb3QgYWxyZWFkeSBkZWZpbmVkOyBjcmVhdGUgYSBuZXcgYnVpbGRlcicpO1xuXG4gICAgLy8gRGV0ZWN0IFBhdXNhYmxlSGFuZGxlciBieSBkdWNrLXR5cGluZyAoaGFzIC5leGVjdXRlIHByb3BlcnR5KVxuICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1yZXN0cmljdGVkLXN5bnRheFxuICAgIGNvbnN0IGlzUGF1c2FibGUgPSB0eXBlb2YgZm4gPT09ICdvYmplY3QnICYmIGZuICE9PSBudWxsICYmICdleGVjdXRlJyBpbiBmbjtcbiAgICBjb25zdCBzdGFnZUZuID0gaXNQYXVzYWJsZVxuICAgICAgPyAoKGZuIGFzIFBhdXNhYmxlSGFuZGxlcjxUU2NvcGU+KS5leGVjdXRlIGFzIFN0YWdlRnVuY3Rpb248VE91dCwgVFNjb3BlPilcbiAgICAgIDogKGZuIGFzIFN0YWdlRnVuY3Rpb248VE91dCwgVFNjb3BlPik7XG5cbiAgICBjb25zdCBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiA9IHsgbmFtZSwgaWQsIGZuOiBzdGFnZUZuIH07XG4gICAgaWYgKGlzUGF1c2FibGUpIHtcbiAgICAgIG5vZGUuaXNQYXVzYWJsZSA9IHRydWU7XG4gICAgICBub2RlLnJlc3VtZUZuID0gKGZuIGFzIFBhdXNhYmxlSGFuZGxlcjxUU2NvcGU+KS5yZXN1bWU7XG4gICAgfVxuICAgIGlmIChkZXNjcmlwdGlvbikgbm9kZS5kZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uO1xuICAgIHRoaXMuX2FkZFRvTWFwKGlkLCBzdGFnZUZuKTtcblxuICAgIGxldCBzcGVjOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUgPSB7IG5hbWUsIGlkLCB0eXBlOiAnc3RhZ2UnIH07XG4gICAgaWYgKGlzUGF1c2FibGUpIHNwZWMuaXNQYXVzYWJsZSA9IHRydWU7XG4gICAgaWYgKGRlc2NyaXB0aW9uKSBzcGVjLmRlc2NyaXB0aW9uID0gZGVzY3JpcHRpb247XG4gICAgc3BlYyA9IHRoaXMuX2FwcGx5RXh0cmFjdG9yVG9Ob2RlKHNwZWMpO1xuXG4gICAgdGhpcy5fcm9vdCA9IG5vZGU7XG4gICAgdGhpcy5fcm9vdFNwZWMgPSBzcGVjO1xuICAgIHRoaXMuX2N1cnNvciA9IG5vZGU7XG4gICAgdGhpcy5fY3Vyc29yU3BlYyA9IHNwZWM7XG4gICAgdGhpcy5fa25vd25TdGFnZUlkcy5hZGQoaWQpO1xuXG4gICAgdGhpcy5fYXBwZW5kRGVzY3JpcHRpb25MaW5lKG5hbWUsIGRlc2NyaXB0aW9uKTtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIGFkZEZ1bmN0aW9uKG5hbWU6IHN0cmluZywgZm46IFN0YWdlRnVuY3Rpb248VE91dCwgVFNjb3BlPiwgaWQ6IHN0cmluZywgZGVzY3JpcHRpb24/OiBzdHJpbmcpOiB0aGlzIHtcbiAgICBjb25zdCBjdXIgPSB0aGlzLl9uZWVkQ3Vyc29yKCk7XG4gICAgY29uc3QgY3VyU3BlYyA9IHRoaXMuX25lZWRDdXJzb3JTcGVjKCk7XG5cbiAgICBjb25zdCBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiA9IHsgbmFtZSwgaWQsIGZuIH07XG4gICAgaWYgKGRlc2NyaXB0aW9uKSBub2RlLmRlc2NyaXB0aW9uID0gZGVzY3JpcHRpb247XG4gICAgdGhpcy5fYWRkVG9NYXAoaWQsIGZuKTtcblxuICAgIGxldCBzcGVjOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUgPSB7IG5hbWUsIGlkLCB0eXBlOiAnc3RhZ2UnIH07XG4gICAgaWYgKGRlc2NyaXB0aW9uKSBzcGVjLmRlc2NyaXB0aW9uID0gZGVzY3JpcHRpb247XG4gICAgc3BlYyA9IHRoaXMuX2FwcGx5RXh0cmFjdG9yVG9Ob2RlKHNwZWMpO1xuXG4gICAgY3VyLm5leHQgPSBub2RlO1xuICAgIGN1clNwZWMubmV4dCA9IHNwZWM7XG4gICAgdGhpcy5fY3Vyc29yID0gbm9kZTtcbiAgICB0aGlzLl9jdXJzb3JTcGVjID0gc3BlYztcbiAgICB0aGlzLl9rbm93blN0YWdlSWRzLmFkZChpZCk7XG5cbiAgICB0aGlzLl9hcHBlbmREZXNjcmlwdGlvbkxpbmUobmFtZSwgZGVzY3JpcHRpb24pO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgYWRkU3RyZWFtaW5nRnVuY3Rpb24oXG4gICAgbmFtZTogc3RyaW5nLFxuICAgIGZuOiBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4sXG4gICAgaWQ6IHN0cmluZyxcbiAgICBzdHJlYW1JZD86IHN0cmluZyxcbiAgICBkZXNjcmlwdGlvbj86IHN0cmluZyxcbiAgKTogdGhpcyB7XG4gICAgY29uc3QgY3VyID0gdGhpcy5fbmVlZEN1cnNvcigpO1xuICAgIGNvbnN0IGN1clNwZWMgPSB0aGlzLl9uZWVkQ3Vyc29yU3BlYygpO1xuXG4gICAgY29uc3Qgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7XG4gICAgICBuYW1lLFxuICAgICAgaWQsXG4gICAgICBmbixcbiAgICAgIGlzU3RyZWFtaW5nOiB0cnVlLFxuICAgICAgc3RyZWFtSWQ6IHN0cmVhbUlkID8/IG5hbWUsXG4gICAgfTtcbiAgICBpZiAoZGVzY3JpcHRpb24pIG5vZGUuZGVzY3JpcHRpb24gPSBkZXNjcmlwdGlvbjtcbiAgICB0aGlzLl9hZGRUb01hcChpZCwgZm4pO1xuXG4gICAgbGV0IHNwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSA9IHtcbiAgICAgIG5hbWUsXG4gICAgICBpZCxcbiAgICAgIHR5cGU6ICdzdHJlYW1pbmcnLFxuICAgICAgaXNTdHJlYW1pbmc6IHRydWUsXG4gICAgICBzdHJlYW1JZDogc3RyZWFtSWQgPz8gbmFtZSxcbiAgICB9O1xuICAgIGlmIChkZXNjcmlwdGlvbikgc3BlYy5kZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uO1xuICAgIHNwZWMgPSB0aGlzLl9hcHBseUV4dHJhY3RvclRvTm9kZShzcGVjKTtcblxuICAgIGN1ci5uZXh0ID0gbm9kZTtcbiAgICBjdXJTcGVjLm5leHQgPSBzcGVjO1xuICAgIHRoaXMuX2N1cnNvciA9IG5vZGU7XG4gICAgdGhpcy5fY3Vyc29yU3BlYyA9IHNwZWM7XG4gICAgdGhpcy5fa25vd25TdGFnZUlkcy5hZGQoaWQpO1xuXG4gICAgdGhpcy5fYXBwZW5kRGVzY3JpcHRpb25MaW5lKG5hbWUsIGRlc2NyaXB0aW9uKTtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIC8qKlxuICAgKiBBZGQgYSBwYXVzYWJsZSBzdGFnZSDigJQgY2FuIHBhdXNlIGV4ZWN1dGlvbiBhbmQgcmVzdW1lIGxhdGVyIHdpdGggaW5wdXQuXG4gICAqXG4gICAqIFRoZSBoYW5kbGVyIGhhcyB0d28gcGhhc2VzOlxuICAgKiAtIGBleGVjdXRlYDogcnVucyBmaXJzdCB0aW1lLiBSZXR1cm4gYHsgcGF1c2U6IHRydWUgfWAgdG8gcGF1c2UuXG4gICAqIC0gYHJlc3VtZWA6IHJ1bnMgd2hlbiB0aGUgZmxvd2NoYXJ0IGlzIHJlc3VtZWQgd2l0aCBpbnB1dC5cbiAgICpcbiAgICogQGV4YW1wbGVcbiAgICogYGBgdHlwZXNjcmlwdFxuICAgKiAuYWRkUGF1c2FibGVGdW5jdGlvbignQXBwcm92ZU9yZGVyJywge1xuICAgKiAgIGV4ZWN1dGU6IGFzeW5jIChzY29wZSkgPT4ge1xuICAgKiAgICAgc2NvcGUub3JkZXJJZCA9ICcxMjMnO1xuICAgKiAgICAgcmV0dXJuIHsgcGF1c2U6IHRydWUsIGRhdGE6IHsgcXVlc3Rpb246ICdBcHByb3ZlPycgfSB9O1xuICAgKiAgIH0sXG4gICAqICAgcmVzdW1lOiBhc3luYyAoc2NvcGUsIGlucHV0KSA9PiB7XG4gICAqICAgICBzY29wZS5hcHByb3ZlZCA9IGlucHV0LmFwcHJvdmVkO1xuICAgKiAgIH0sXG4gICAqIH0sICdhcHByb3ZlLW9yZGVyJywgJ01hbmFnZXIgYXBwcm92YWwgZ2F0ZScpXG4gICAqIGBgYFxuICAgKi9cbiAgYWRkUGF1c2FibGVGdW5jdGlvbihuYW1lOiBzdHJpbmcsIGhhbmRsZXI6IFBhdXNhYmxlSGFuZGxlcjxUU2NvcGU+LCBpZDogc3RyaW5nLCBkZXNjcmlwdGlvbj86IHN0cmluZyk6IHRoaXMge1xuICAgIGNvbnN0IGN1ciA9IHRoaXMuX25lZWRDdXJzb3IoKTtcbiAgICBjb25zdCBjdXJTcGVjID0gdGhpcy5fbmVlZEN1cnNvclNwZWMoKTtcblxuICAgIGNvbnN0IG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+ID0ge1xuICAgICAgbmFtZSxcbiAgICAgIGlkLFxuICAgICAgZm46IGhhbmRsZXIuZXhlY3V0ZSBhcyBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4sXG4gICAgICBpc1BhdXNhYmxlOiB0cnVlLFxuICAgICAgcmVzdW1lRm46IGhhbmRsZXIucmVzdW1lLFxuICAgIH07XG4gICAgaWYgKGRlc2NyaXB0aW9uKSBub2RlLmRlc2NyaXB0aW9uID0gZGVzY3JpcHRpb247XG4gICAgdGhpcy5fYWRkVG9NYXAoaWQsIGhhbmRsZXIuZXhlY3V0ZSBhcyBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4pO1xuXG4gICAgbGV0IHNwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSA9IHtcbiAgICAgIG5hbWUsXG4gICAgICBpZCxcbiAgICAgIHR5cGU6ICdzdGFnZScsXG4gICAgICBpc1BhdXNhYmxlOiB0cnVlLFxuICAgIH07XG4gICAgaWYgKGRlc2NyaXB0aW9uKSBzcGVjLmRlc2NyaXB0aW9uID0gZGVzY3JpcHRpb247XG4gICAgc3BlYyA9IHRoaXMuX2FwcGx5RXh0cmFjdG9yVG9Ob2RlKHNwZWMpO1xuXG4gICAgY3VyLm5leHQgPSBub2RlO1xuICAgIGN1clNwZWMubmV4dCA9IHNwZWM7XG4gICAgdGhpcy5fY3Vyc29yID0gbm9kZTtcbiAgICB0aGlzLl9jdXJzb3JTcGVjID0gc3BlYztcbiAgICB0aGlzLl9rbm93blN0YWdlSWRzLmFkZChpZCk7XG5cbiAgICB0aGlzLl9hcHBlbmREZXNjcmlwdGlvbkxpbmUobmFtZSwgZGVzY3JpcHRpb24pO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgLy8g4pSA4pSAIEJyYW5jaGluZyDilIDilIBcblxuICBhZGREZWNpZGVyRnVuY3Rpb24oXG4gICAgbmFtZTogc3RyaW5nLFxuICAgIGZuOiBTdGFnZUZ1bmN0aW9uPGFueSwgVFNjb3BlPixcbiAgICBpZDogc3RyaW5nLFxuICAgIGRlc2NyaXB0aW9uPzogc3RyaW5nLFxuICApOiBEZWNpZGVyTGlzdDxUT3V0LCBUU2NvcGU+IHtcbiAgICBjb25zdCBjdXIgPSB0aGlzLl9uZWVkQ3Vyc29yKCk7XG4gICAgY29uc3QgY3VyU3BlYyA9IHRoaXMuX25lZWRDdXJzb3JTcGVjKCk7XG5cbiAgICBpZiAoY3VyLmRlY2lkZXJGbikgZmFpbChgZGVjaWRlciBhbHJlYWR5IGRlZmluZWQgYXQgJyR7Y3VyLm5hbWV9J2ApO1xuXG4gICAgY29uc3Qgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7IG5hbWUsIGlkLCBmbiB9O1xuICAgIGlmIChkZXNjcmlwdGlvbikgbm9kZS5kZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uO1xuICAgIHRoaXMuX2FkZFRvTWFwKGlkLCBmbik7XG5cbiAgICBsZXQgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0geyBuYW1lLCBpZCwgdHlwZTogJ3N0YWdlJywgaGFzRGVjaWRlcjogdHJ1ZSB9O1xuICAgIGlmIChkZXNjcmlwdGlvbikgc3BlYy5kZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uO1xuICAgIHNwZWMgPSB0aGlzLl9hcHBseUV4dHJhY3RvclRvTm9kZShzcGVjKTtcblxuICAgIGN1ci5uZXh0ID0gbm9kZTtcbiAgICBjdXJTcGVjLm5leHQgPSBzcGVjO1xuICAgIHRoaXMuX2N1cnNvciA9IG5vZGU7XG4gICAgdGhpcy5fY3Vyc29yU3BlYyA9IHNwZWM7XG4gICAgdGhpcy5fa25vd25TdGFnZUlkcy5hZGQoaWQpO1xuXG4gICAgdGhpcy5fc3RlcENvdW50ZXIrKztcbiAgICB0aGlzLl9zdGFnZVN0ZXBNYXAuc2V0KG5hbWUsIHRoaXMuX3N0ZXBDb3VudGVyKTtcblxuICAgIHJldHVybiBuZXcgRGVjaWRlckxpc3Q8VE91dCwgVFNjb3BlPihcbiAgICAgIHRoaXMsXG4gICAgICBub2RlLFxuICAgICAgc3BlYyxcbiAgICAgIHRoaXMuX2Rlc2NyaXB0aW9uUGFydHMsXG4gICAgICB0aGlzLl9zdGFnZURlc2NyaXB0aW9ucyxcbiAgICAgIHRoaXMuX3N0ZXBDb3VudGVyLFxuICAgICAgZGVzY3JpcHRpb24sXG4gICAgKTtcbiAgfVxuXG4gIGFkZFNlbGVjdG9yRnVuY3Rpb24oXG4gICAgbmFtZTogc3RyaW5nLFxuICAgIGZuOiBTdGFnZUZ1bmN0aW9uPGFueSwgVFNjb3BlPixcbiAgICBpZDogc3RyaW5nLFxuICAgIGRlc2NyaXB0aW9uPzogc3RyaW5nLFxuICApOiBTZWxlY3RvckZuTGlzdDxUT3V0LCBUU2NvcGU+IHtcbiAgICBjb25zdCBjdXIgPSB0aGlzLl9uZWVkQ3Vyc29yKCk7XG4gICAgY29uc3QgY3VyU3BlYyA9IHRoaXMuX25lZWRDdXJzb3JTcGVjKCk7XG5cbiAgICBpZiAoY3VyLnNlbGVjdG9yRm4pIGZhaWwoYHNlbGVjdG9yIGFscmVhZHkgZGVmaW5lZCBhdCAnJHtjdXIubmFtZX0nYCk7XG4gICAgaWYgKGN1ci5kZWNpZGVyRm4pIGZhaWwoYGRlY2lkZXIgYW5kIHNlbGVjdG9yIGFyZSBtdXR1YWxseSBleGNsdXNpdmUgYXQgJyR7Y3VyLm5hbWV9J2ApO1xuXG4gICAgY29uc3Qgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7IG5hbWUsIGlkLCBmbiB9O1xuICAgIGlmIChkZXNjcmlwdGlvbikgbm9kZS5kZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uO1xuICAgIHRoaXMuX2FkZFRvTWFwKGlkLCBmbik7XG5cbiAgICBsZXQgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0geyBuYW1lLCBpZCwgdHlwZTogJ3N0YWdlJywgaGFzU2VsZWN0b3I6IHRydWUgfTtcbiAgICBpZiAoZGVzY3JpcHRpb24pIHNwZWMuZGVzY3JpcHRpb24gPSBkZXNjcmlwdGlvbjtcbiAgICBzcGVjID0gdGhpcy5fYXBwbHlFeHRyYWN0b3JUb05vZGUoc3BlYyk7XG5cbiAgICBjdXIubmV4dCA9IG5vZGU7XG4gICAgY3VyU3BlYy5uZXh0ID0gc3BlYztcbiAgICB0aGlzLl9jdXJzb3IgPSBub2RlO1xuICAgIHRoaXMuX2N1cnNvclNwZWMgPSBzcGVjO1xuICAgIHRoaXMuX2tub3duU3RhZ2VJZHMuYWRkKGlkKTtcblxuICAgIHRoaXMuX3N0ZXBDb3VudGVyKys7XG4gICAgdGhpcy5fc3RhZ2VTdGVwTWFwLnNldChuYW1lLCB0aGlzLl9zdGVwQ291bnRlcik7XG5cbiAgICByZXR1cm4gbmV3IFNlbGVjdG9yRm5MaXN0PFRPdXQsIFRTY29wZT4oXG4gICAgICB0aGlzLFxuICAgICAgbm9kZSxcbiAgICAgIHNwZWMsXG4gICAgICB0aGlzLl9kZXNjcmlwdGlvblBhcnRzLFxuICAgICAgdGhpcy5fc3RhZ2VEZXNjcmlwdGlvbnMsXG4gICAgICB0aGlzLl9zdGVwQ291bnRlcixcbiAgICAgIGRlc2NyaXB0aW9uLFxuICAgICk7XG4gIH1cblxuICAvLyDilIDilIAgUGFyYWxsZWwgKEZvcmspIOKUgOKUgFxuXG4gIGFkZExpc3RPZkZ1bmN0aW9uKGNoaWxkcmVuOiBTaW1wbGlmaWVkUGFyYWxsZWxTcGVjPFRPdXQsIFRTY29wZT5bXSwgb3B0aW9ucz86IHsgZmFpbEZhc3Q/OiBib29sZWFuIH0pOiB0aGlzIHtcbiAgICBjb25zdCBjdXIgPSB0aGlzLl9uZWVkQ3Vyc29yKCk7XG4gICAgY29uc3QgY3VyU3BlYyA9IHRoaXMuX25lZWRDdXJzb3JTcGVjKCk7XG4gICAgY29uc3QgZm9ya0lkID0gY3VyLmlkO1xuXG4gICAgY3VyU3BlYy50eXBlID0gJ2ZvcmsnO1xuICAgIGlmIChvcHRpb25zPy5mYWlsRmFzdCkgY3VyLmZhaWxGYXN0ID0gdHJ1ZTtcblxuICAgIGZvciAoY29uc3QgeyBpZCwgbmFtZSwgZm4gfSBvZiBjaGlsZHJlbikge1xuICAgICAgaWYgKCFpZCkgZmFpbChgY2hpbGQgaWQgcmVxdWlyZWQgdW5kZXIgJyR7Y3VyLm5hbWV9J2ApO1xuICAgICAgaWYgKGN1ci5jaGlsZHJlbj8uc29tZSgoYykgPT4gYy5pZCA9PT0gaWQpKSB7XG4gICAgICAgIGZhaWwoYGR1cGxpY2F0ZSBjaGlsZCBpZCAnJHtpZH0nIHVuZGVyICcke2N1ci5uYW1lfSdgKTtcbiAgICAgIH1cblxuICAgICAgY29uc3Qgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7IG5hbWU6IG5hbWUgPz8gaWQsIGlkIH07XG4gICAgICBpZiAoZm4pIHtcbiAgICAgICAgbm9kZS5mbiA9IGZuO1xuICAgICAgICB0aGlzLl9hZGRUb01hcChpZCwgZm4pO1xuICAgICAgfVxuXG4gICAgICBsZXQgc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0ge1xuICAgICAgICBuYW1lOiBuYW1lID8/IGlkLFxuICAgICAgICBpZCxcbiAgICAgICAgdHlwZTogJ3N0YWdlJyxcbiAgICAgICAgaXNQYXJhbGxlbENoaWxkOiB0cnVlLFxuICAgICAgICBwYXJhbGxlbEdyb3VwSWQ6IGZvcmtJZCxcbiAgICAgIH07XG4gICAgICBzcGVjID0gdGhpcy5fYXBwbHlFeHRyYWN0b3JUb05vZGUoc3BlYyk7XG5cbiAgICAgIGN1ci5jaGlsZHJlbiA9IGN1ci5jaGlsZHJlbiB8fCBbXTtcbiAgICAgIGN1ci5jaGlsZHJlbi5wdXNoKG5vZGUpO1xuICAgICAgY3VyU3BlYy5jaGlsZHJlbiA9IGN1clNwZWMuY2hpbGRyZW4gfHwgW107XG4gICAgICBjdXJTcGVjLmNoaWxkcmVuLnB1c2goc3BlYyk7XG4gICAgfVxuXG4gICAgY29uc3QgY2hpbGROYW1lcyA9IGNoaWxkcmVuLm1hcCgoYykgPT4gYy5uYW1lIHx8IGMuaWQpLmpvaW4oJywgJyk7XG4gICAgdGhpcy5fc3RlcENvdW50ZXIrKztcbiAgICB0aGlzLl9kZXNjcmlwdGlvblBhcnRzLnB1c2goYCR7dGhpcy5fc3RlcENvdW50ZXJ9LiBSdW5zIGluIHBhcmFsbGVsOiAke2NoaWxkTmFtZXN9YCk7XG5cbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIC8vIOKUgOKUgCBTdWJmbG93IE1vdW50aW5nIOKUgOKUgFxuXG4gIGFkZFN1YkZsb3dDaGFydChpZDogc3RyaW5nLCBzdWJmbG93OiBGbG93Q2hhcnQ8YW55LCBhbnk+LCBtb3VudE5hbWU/OiBzdHJpbmcsIG9wdGlvbnM/OiBTdWJmbG93TW91bnRPcHRpb25zKTogdGhpcyB7XG4gICAgY29uc3QgY3VyID0gdGhpcy5fbmVlZEN1cnNvcigpO1xuICAgIGNvbnN0IGN1clNwZWMgPSB0aGlzLl9uZWVkQ3Vyc29yU3BlYygpO1xuXG4gICAgaWYgKGN1ci5jaGlsZHJlbj8uc29tZSgoYykgPT4gYy5pZCA9PT0gaWQpKSB7XG4gICAgICBmYWlsKGBkdXBsaWNhdGUgY2hpbGQgaWQgJyR7aWR9JyB1bmRlciAnJHtjdXIubmFtZX0nYCk7XG4gICAgfVxuXG4gICAgY29uc3Qgc3ViZmxvd05hbWUgPSBtb3VudE5hbWUgfHwgaWQ7XG4gICAgY29uc3QgZm9ya0lkID0gY3VyLmlkO1xuICAgIGNvbnN0IHByZWZpeGVkUm9vdCA9IHRoaXMuX3ByZWZpeE5vZGVUcmVlKHN1YmZsb3cucm9vdCwgaWQpO1xuXG4gICAgaWYgKCF0aGlzLl9zdWJmbG93RGVmcy5oYXMoaWQpKSB7XG4gICAgICB0aGlzLl9zdWJmbG93RGVmcy5zZXQoaWQsIHsgcm9vdDogcHJlZml4ZWRSb290IH0pO1xuICAgIH1cblxuICAgIGNvbnN0IG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+ID0ge1xuICAgICAgbmFtZTogc3ViZmxvd05hbWUsXG4gICAgICBpZCxcbiAgICAgIGlzU3ViZmxvd1Jvb3Q6IHRydWUsXG4gICAgICBzdWJmbG93SWQ6IGlkLFxuICAgICAgc3ViZmxvd05hbWUsXG4gICAgfTtcbiAgICBpZiAob3B0aW9ucykgbm9kZS5zdWJmbG93TW91bnRPcHRpb25zID0gb3B0aW9ucztcblxuICAgIGxldCBzcGVjOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUgPSB7XG4gICAgICBuYW1lOiBzdWJmbG93TmFtZSxcbiAgICAgIHR5cGU6ICdzdGFnZScsXG4gICAgICBpZCxcbiAgICAgIGlzU3ViZmxvd1Jvb3Q6IHRydWUsXG4gICAgICBzdWJmbG93SWQ6IGlkLFxuICAgICAgc3ViZmxvd05hbWUsXG4gICAgICBpc1BhcmFsbGVsQ2hpbGQ6IHRydWUsXG4gICAgICBwYXJhbGxlbEdyb3VwSWQ6IGZvcmtJZCxcbiAgICAgIHN1YmZsb3dTdHJ1Y3R1cmU6IHN1YmZsb3cuYnVpbGRUaW1lU3RydWN0dXJlLFxuICAgIH07XG4gICAgc3BlYyA9IHRoaXMuX2FwcGx5RXh0cmFjdG9yVG9Ob2RlKHNwZWMpO1xuXG4gICAgY3VyU3BlYy50eXBlID0gJ2ZvcmsnO1xuICAgIGN1ci5jaGlsZHJlbiA9IGN1ci5jaGlsZHJlbiB8fCBbXTtcbiAgICBjdXIuY2hpbGRyZW4ucHVzaChub2RlKTtcbiAgICBjdXJTcGVjLmNoaWxkcmVuID0gY3VyU3BlYy5jaGlsZHJlbiB8fCBbXTtcbiAgICBjdXJTcGVjLmNoaWxkcmVuLnB1c2goc3BlYyk7XG4gICAgdGhpcy5fa25vd25TdGFnZUlkcy5hZGQoaWQpO1xuXG4gICAgdGhpcy5fbWVyZ2VTdGFnZU1hcChzdWJmbG93LnN0YWdlTWFwLCBpZCk7XG4gICAgdGhpcy5fbWVyZ2VTdWJmbG93cyhzdWJmbG93LnN1YmZsb3dzLCBpZCk7XG4gICAgdGhpcy5fYXBwZW5kU3ViZmxvd0Rlc2NyaXB0aW9uKGlkLCBzdWJmbG93TmFtZSwgc3ViZmxvdyk7XG5cbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIGFkZExhenlTdWJGbG93Q2hhcnQoXG4gICAgaWQ6IHN0cmluZyxcbiAgICByZXNvbHZlcjogKCkgPT4gRmxvd0NoYXJ0PFRPdXQsIFRTY29wZT4sXG4gICAgbW91bnROYW1lPzogc3RyaW5nLFxuICAgIG9wdGlvbnM/OiBTdWJmbG93TW91bnRPcHRpb25zLFxuICApOiB0aGlzIHtcbiAgICBjb25zdCBjdXIgPSB0aGlzLl9uZWVkQ3Vyc29yKCk7XG4gICAgY29uc3QgY3VyU3BlYyA9IHRoaXMuX25lZWRDdXJzb3JTcGVjKCk7XG5cbiAgICBpZiAoY3VyLmNoaWxkcmVuPy5zb21lKChjKSA9PiBjLmlkID09PSBpZCkpIHtcbiAgICAgIGZhaWwoYGR1cGxpY2F0ZSBjaGlsZCBpZCAnJHtpZH0nIHVuZGVyICcke2N1ci5uYW1lfSdgKTtcbiAgICB9XG5cbiAgICBjb25zdCBzdWJmbG93TmFtZSA9IG1vdW50TmFtZSB8fCBpZDtcbiAgICBjb25zdCBmb3JrSWQgPSBjdXIuaWQ7XG5cbiAgICBjb25zdCBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiA9IHtcbiAgICAgIG5hbWU6IHN1YmZsb3dOYW1lLFxuICAgICAgaWQsXG4gICAgICBpc1N1YmZsb3dSb290OiB0cnVlLFxuICAgICAgc3ViZmxvd0lkOiBpZCxcbiAgICAgIHN1YmZsb3dOYW1lLFxuICAgICAgc3ViZmxvd1Jlc29sdmVyOiByZXNvbHZlciBhcyBhbnksXG4gICAgfTtcbiAgICBpZiAob3B0aW9ucykgbm9kZS5zdWJmbG93TW91bnRPcHRpb25zID0gb3B0aW9ucztcblxuICAgIGNvbnN0IHNwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSA9IHtcbiAgICAgIG5hbWU6IHN1YmZsb3dOYW1lLFxuICAgICAgdHlwZTogJ3N0YWdlJyxcbiAgICAgIGlkLFxuICAgICAgaXNTdWJmbG93Um9vdDogdHJ1ZSxcbiAgICAgIHN1YmZsb3dJZDogaWQsXG4gICAgICBzdWJmbG93TmFtZSxcbiAgICAgIGlzUGFyYWxsZWxDaGlsZDogdHJ1ZSxcbiAgICAgIHBhcmFsbGVsR3JvdXBJZDogZm9ya0lkLFxuICAgICAgaXNMYXp5OiB0cnVlLFxuICAgIH07XG5cbiAgICBjdXJTcGVjLnR5cGUgPSAnZm9yayc7XG4gICAgY3VyLmNoaWxkcmVuID0gY3VyLmNoaWxkcmVuIHx8IFtdO1xuICAgIGN1ci5jaGlsZHJlbi5wdXNoKG5vZGUpO1xuICAgIGN1clNwZWMuY2hpbGRyZW4gPSBjdXJTcGVjLmNoaWxkcmVuIHx8IFtdO1xuICAgIGN1clNwZWMuY2hpbGRyZW4ucHVzaChzcGVjKTtcblxuICAgIHRoaXMuX3N0ZXBDb3VudGVyKys7XG4gICAgdGhpcy5fc3RhZ2VTdGVwTWFwLnNldChpZCwgdGhpcy5fc3RlcENvdW50ZXIpO1xuICAgIHRoaXMuX2Rlc2NyaXB0aW9uUGFydHMucHVzaChgJHt0aGlzLl9zdGVwQ291bnRlcn0uIFtMYXp5IFN1Yi1FeGVjdXRpb246ICR7c3ViZmxvd05hbWV9XWApO1xuXG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBhZGRMYXp5U3ViRmxvd0NoYXJ0TmV4dChcbiAgICBpZDogc3RyaW5nLFxuICAgIHJlc29sdmVyOiAoKSA9PiBGbG93Q2hhcnQ8VE91dCwgVFNjb3BlPixcbiAgICBtb3VudE5hbWU/OiBzdHJpbmcsXG4gICAgb3B0aW9ucz86IFN1YmZsb3dNb3VudE9wdGlvbnMsXG4gICk6IHRoaXMge1xuICAgIGNvbnN0IGN1ciA9IHRoaXMuX25lZWRDdXJzb3IoKTtcbiAgICBjb25zdCBjdXJTcGVjID0gdGhpcy5fbmVlZEN1cnNvclNwZWMoKTtcblxuICAgIGlmIChjdXIubmV4dCkge1xuICAgICAgZmFpbChgY2Fubm90IGFkZCBzdWJmbG93IGFzIG5leHQgd2hlbiBuZXh0IGlzIGFscmVhZHkgZGVmaW5lZCBhdCAnJHtjdXIubmFtZX0nYCk7XG4gICAgfVxuXG4gICAgY29uc3Qgc3ViZmxvd05hbWUgPSBtb3VudE5hbWUgfHwgaWQ7XG5cbiAgICBjb25zdCBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiA9IHtcbiAgICAgIG5hbWU6IHN1YmZsb3dOYW1lLFxuICAgICAgaWQsXG4gICAgICBpc1N1YmZsb3dSb290OiB0cnVlLFxuICAgICAgc3ViZmxvd0lkOiBpZCxcbiAgICAgIHN1YmZsb3dOYW1lLFxuICAgICAgc3ViZmxvd1Jlc29sdmVyOiByZXNvbHZlciBhcyBhbnksXG4gICAgfTtcbiAgICBpZiAob3B0aW9ucykgbm9kZS5zdWJmbG93TW91bnRPcHRpb25zID0gb3B0aW9ucztcblxuICAgIGNvbnN0IHNwZWM6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSA9IHtcbiAgICAgIG5hbWU6IHN1YmZsb3dOYW1lLFxuICAgICAgdHlwZTogJ3N0YWdlJyxcbiAgICAgIGlkLFxuICAgICAgaXNTdWJmbG93Um9vdDogdHJ1ZSxcbiAgICAgIHN1YmZsb3dJZDogaWQsXG4gICAgICBzdWJmbG93TmFtZSxcbiAgICAgIGlzTGF6eTogdHJ1ZSxcbiAgICB9O1xuXG4gICAgY3VyLm5leHQgPSBub2RlO1xuICAgIGN1clNwZWMubmV4dCA9IHNwZWM7XG4gICAgdGhpcy5fY3Vyc29yID0gbm9kZTtcbiAgICB0aGlzLl9jdXJzb3JTcGVjID0gc3BlYztcblxuICAgIHRoaXMuX3N0ZXBDb3VudGVyKys7XG4gICAgdGhpcy5fc3RhZ2VTdGVwTWFwLnNldChpZCwgdGhpcy5fc3RlcENvdW50ZXIpO1xuICAgIHRoaXMuX2Rlc2NyaXB0aW9uUGFydHMucHVzaChgJHt0aGlzLl9zdGVwQ291bnRlcn0uIFtMYXp5IFN1Yi1FeGVjdXRpb246ICR7c3ViZmxvd05hbWV9XWApO1xuXG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBhZGRTdWJGbG93Q2hhcnROZXh0KFxuICAgIGlkOiBzdHJpbmcsXG4gICAgc3ViZmxvdzogRmxvd0NoYXJ0PGFueSwgYW55PixcbiAgICBtb3VudE5hbWU/OiBzdHJpbmcsXG4gICAgb3B0aW9ucz86IFN1YmZsb3dNb3VudE9wdGlvbnMsXG4gICk6IHRoaXMge1xuICAgIGNvbnN0IGN1ciA9IHRoaXMuX25lZWRDdXJzb3IoKTtcbiAgICBjb25zdCBjdXJTcGVjID0gdGhpcy5fbmVlZEN1cnNvclNwZWMoKTtcblxuICAgIGlmIChjdXIubmV4dCkge1xuICAgICAgZmFpbChgY2Fubm90IGFkZCBzdWJmbG93IGFzIG5leHQgd2hlbiBuZXh0IGlzIGFscmVhZHkgZGVmaW5lZCBhdCAnJHtjdXIubmFtZX0nYCk7XG4gICAgfVxuXG4gICAgY29uc3Qgc3ViZmxvd05hbWUgPSBtb3VudE5hbWUgfHwgaWQ7XG4gICAgY29uc3QgcHJlZml4ZWRSb290ID0gdGhpcy5fcHJlZml4Tm9kZVRyZWUoc3ViZmxvdy5yb290LCBpZCk7XG5cbiAgICBpZiAoIXRoaXMuX3N1YmZsb3dEZWZzLmhhcyhpZCkpIHtcbiAgICAgIHRoaXMuX3N1YmZsb3dEZWZzLnNldChpZCwgeyByb290OiBwcmVmaXhlZFJvb3QgfSk7XG4gICAgfVxuXG4gICAgY29uc3Qgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7XG4gICAgICBuYW1lOiBzdWJmbG93TmFtZSxcbiAgICAgIGlkLFxuICAgICAgaXNTdWJmbG93Um9vdDogdHJ1ZSxcbiAgICAgIHN1YmZsb3dJZDogaWQsXG4gICAgICBzdWJmbG93TmFtZSxcbiAgICB9O1xuICAgIGlmIChvcHRpb25zKSBub2RlLnN1YmZsb3dNb3VudE9wdGlvbnMgPSBvcHRpb25zO1xuXG4gICAgbGV0IGF0dGFjaGVkU3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0ge1xuICAgICAgbmFtZTogc3ViZmxvd05hbWUsXG4gICAgICB0eXBlOiAnc3RhZ2UnLFxuICAgICAgaWQsXG4gICAgICBpc1N1YmZsb3dSb290OiB0cnVlLFxuICAgICAgc3ViZmxvd0lkOiBpZCxcbiAgICAgIHN1YmZsb3dOYW1lLFxuICAgICAgc3ViZmxvd1N0cnVjdHVyZTogc3ViZmxvdy5idWlsZFRpbWVTdHJ1Y3R1cmUsXG4gICAgfTtcbiAgICBhdHRhY2hlZFNwZWMgPSB0aGlzLl9hcHBseUV4dHJhY3RvclRvTm9kZShhdHRhY2hlZFNwZWMpO1xuXG4gICAgY3VyLm5leHQgPSBub2RlO1xuICAgIGN1clNwZWMubmV4dCA9IGF0dGFjaGVkU3BlYztcbiAgICB0aGlzLl9jdXJzb3IgPSBub2RlO1xuICAgIHRoaXMuX2N1cnNvclNwZWMgPSBhdHRhY2hlZFNwZWM7XG4gICAgdGhpcy5fa25vd25TdGFnZUlkcy5hZGQoaWQpO1xuXG4gICAgdGhpcy5fbWVyZ2VTdGFnZU1hcChzdWJmbG93LnN0YWdlTWFwLCBpZCk7XG4gICAgdGhpcy5fbWVyZ2VTdWJmbG93cyhzdWJmbG93LnN1YmZsb3dzLCBpZCk7XG4gICAgdGhpcy5fYXBwZW5kU3ViZmxvd0Rlc2NyaXB0aW9uKGlkLCBzdWJmbG93TmFtZSwgc3ViZmxvdyk7XG5cbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIC8vIOKUgOKUgCBMb29wIOKUgOKUgFxuXG4gIGxvb3BUbyhzdGFnZUlkOiBzdHJpbmcpOiB0aGlzIHtcbiAgICBjb25zdCBjdXIgPSB0aGlzLl9uZWVkQ3Vyc29yKCk7XG4gICAgY29uc3QgY3VyU3BlYyA9IHRoaXMuX25lZWRDdXJzb3JTcGVjKCk7XG5cbiAgICBpZiAoY3VyU3BlYy5sb29wVGFyZ2V0KSBmYWlsKGBsb29wVG8gYWxyZWFkeSBkZWZpbmVkIGF0ICcke2N1ci5uYW1lfSdgKTtcbiAgICBpZiAoY3VyLm5leHQpIGZhaWwoYGNhbm5vdCBzZXQgbG9vcFRvIHdoZW4gbmV4dCBpcyBhbHJlYWR5IGRlZmluZWQgYXQgJyR7Y3VyLm5hbWV9J2ApO1xuXG4gICAgaWYgKCF0aGlzLl9rbm93blN0YWdlSWRzLmhhcyhzdGFnZUlkKSkge1xuICAgICAgZmFpbChgbG9vcFRvKCcke3N0YWdlSWR9JykgdGFyZ2V0IG5vdCBmb3VuZCDigJQgZGlkIHlvdSBwYXNzIGEgc3RhZ2UgbmFtZSBpbnN0ZWFkIG9mIGlkP2ApO1xuICAgIH1cblxuICAgIGN1ci5uZXh0ID0geyBuYW1lOiBzdGFnZUlkLCBpZDogc3RhZ2VJZCwgaXNMb29wUmVmOiB0cnVlIH07XG4gICAgY3VyU3BlYy5sb29wVGFyZ2V0ID0gc3RhZ2VJZDtcbiAgICBjdXJTcGVjLm5leHQgPSB7IG5hbWU6IHN0YWdlSWQsIGlkOiBzdGFnZUlkLCB0eXBlOiAnbG9vcCcsIGlzTG9vcFJlZmVyZW5jZTogdHJ1ZSB9O1xuXG4gICAgY29uc3QgdGFyZ2V0U3RlcCA9IHRoaXMuX3N0YWdlU3RlcE1hcC5nZXQoc3RhZ2VJZCk7XG4gICAgaWYgKHRhcmdldFN0ZXAgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhpcy5fZGVzY3JpcHRpb25QYXJ0cy5wdXNoKGDihpIgbG9vcHMgYmFjayB0byBzdGVwICR7dGFyZ2V0U3RlcH1gKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5fZGVzY3JpcHRpb25QYXJ0cy5wdXNoKGDihpIgbG9vcHMgYmFjayB0byAke3N0YWdlSWR9YCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICAvLyDilIDilIAgU3RyZWFtaW5nIOKUgOKUgFxuXG4gIG9uU3RyZWFtKGhhbmRsZXI6IFN0cmVhbVRva2VuSGFuZGxlcik6IHRoaXMge1xuICAgIHRoaXMuX3N0cmVhbUhhbmRsZXJzLm9uVG9rZW4gPSBoYW5kbGVyO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgb25TdHJlYW1TdGFydChoYW5kbGVyOiBTdHJlYW1MaWZlY3ljbGVIYW5kbGVyKTogdGhpcyB7XG4gICAgdGhpcy5fc3RyZWFtSGFuZGxlcnMub25TdGFydCA9IGhhbmRsZXI7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBvblN0cmVhbUVuZChoYW5kbGVyOiBTdHJlYW1MaWZlY3ljbGVIYW5kbGVyKTogdGhpcyB7XG4gICAgdGhpcy5fc3RyZWFtSGFuZGxlcnMub25FbmQgPSBoYW5kbGVyO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgLy8g4pSA4pSAIEV4dHJhY3RvcnMg4pSA4pSAXG5cbiAgYWRkVHJhdmVyc2FsRXh0cmFjdG9yPFRSZXN1bHQgPSB1bmtub3duPihleHRyYWN0b3I6IFRyYXZlcnNhbEV4dHJhY3RvcjxUUmVzdWx0Pik6IHRoaXMge1xuICAgIHRoaXMuX2V4dHJhY3RvciA9IGV4dHJhY3RvcjtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIGFkZEJ1aWxkVGltZUV4dHJhY3RvcjxUUmVzdWx0ID0gRmxvd0NoYXJ0U3BlYz4oZXh0cmFjdG9yOiBCdWlsZFRpbWVFeHRyYWN0b3I8VFJlc3VsdD4pOiB0aGlzIHtcbiAgICB0aGlzLl9idWlsZFRpbWVFeHRyYWN0b3IgPSBleHRyYWN0b3I7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBnZXRCdWlsZFRpbWVFeHRyYWN0b3JFcnJvcnMoKTogQXJyYXk8eyBtZXNzYWdlOiBzdHJpbmc7IGVycm9yOiB1bmtub3duIH0+IHtcbiAgICByZXR1cm4gdGhpcy5fYnVpbGRUaW1lRXh0cmFjdG9yRXJyb3JzO1xuICB9XG5cbiAgLy8g4pSA4pSAIE91dHB1dCDilIDilIBcblxuICBidWlsZCgpOiBSdW5uYWJsZUZsb3dDaGFydDxUT3V0LCBUU2NvcGU+IHtcbiAgICBjb25zdCByb290ID0gdGhpcy5fcm9vdCA/PyBmYWlsKCdlbXB0eSB0cmVlOyBjYWxsIHN0YXJ0KCkgZmlyc3QnKTtcbiAgICBjb25zdCByb290U3BlYyA9IHRoaXMuX3Jvb3RTcGVjID8/IGZhaWwoJ2VtcHR5IHNwZWM7IGNhbGwgc3RhcnQoKSBmaXJzdCcpO1xuXG4gICAgY29uc3Qgc3ViZmxvd3M6IFJlY29yZDxzdHJpbmcsIHsgcm9vdDogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gfT4gPSB7fTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIGRlZl0gb2YgdGhpcy5fc3ViZmxvd0RlZnMpIHtcbiAgICAgIHN1YmZsb3dzW2tleV0gPSBkZWY7XG4gICAgfVxuXG4gICAgY29uc3Qgcm9vdE5hbWUgPSB0aGlzLl9yb290Py5uYW1lID8/ICdGbG93Q2hhcnQnO1xuICAgIGNvbnN0IGRlc2NyaXB0aW9uID1cbiAgICAgIHRoaXMuX2Rlc2NyaXB0aW9uUGFydHMubGVuZ3RoID4gMCA/IGBGbG93Q2hhcnQ6ICR7cm9vdE5hbWV9XFxuU3RlcHM6XFxuJHt0aGlzLl9kZXNjcmlwdGlvblBhcnRzLmpvaW4oJ1xcbicpfWAgOiAnJztcblxuICAgIGNvbnN0IGNoYXJ0OiBGbG93Q2hhcnQ8VE91dCwgVFNjb3BlPiA9IHtcbiAgICAgIHJvb3QsXG4gICAgICBzdGFnZU1hcDogdGhpcy5fc3RhZ2VNYXAsXG4gICAgICBleHRyYWN0b3I6IHRoaXMuX2V4dHJhY3RvcixcbiAgICAgIGJ1aWxkVGltZVN0cnVjdHVyZTogcm9vdFNwZWMsXG4gICAgICAuLi4oT2JqZWN0LmtleXMoc3ViZmxvd3MpLmxlbmd0aCA+IDAgPyB7IHN1YmZsb3dzIH0gOiB7fSksXG4gICAgICAuLi4odGhpcy5fZW5hYmxlTmFycmF0aXZlID8geyBlbmFibGVOYXJyYXRpdmU6IHRydWUgfSA6IHt9KSxcbiAgICAgIC4uLih0aGlzLl9sb2dnZXIgPyB7IGxvZ2dlcjogdGhpcy5fbG9nZ2VyIH0gOiB7fSksXG4gICAgICBkZXNjcmlwdGlvbixcbiAgICAgIHN0YWdlRGVzY3JpcHRpb25zOiBuZXcgTWFwKHRoaXMuX3N0YWdlRGVzY3JpcHRpb25zKSxcbiAgICAgIC4uLih0aGlzLl9pbnB1dFNjaGVtYSA/IHsgaW5wdXRTY2hlbWE6IHRoaXMuX2lucHV0U2NoZW1hIH0gOiB7fSksXG4gICAgICAuLi4odGhpcy5fb3V0cHV0U2NoZW1hID8geyBvdXRwdXRTY2hlbWE6IHRoaXMuX291dHB1dFNjaGVtYSB9IDoge30pLFxuICAgICAgLi4uKHRoaXMuX291dHB1dE1hcHBlciA/IHsgb3V0cHV0TWFwcGVyOiB0aGlzLl9vdXRwdXRNYXBwZXIgfSA6IHt9KSxcbiAgICAgIC8vIEF1dG8tZW1iZWQgVHlwZWRTY29wZSBmYWN0b3J5IGlmIG5vbmUgd2FzIGV4cGxpY2l0bHkgc2V0LlxuICAgICAgLy8gVGhpcyBtZWFucyBBTlkgd2F5IG9mIGNyZWF0aW5nIGEgRmxvd0NoYXJ0QnVpbGRlciAoZmxvd0NoYXJ0KCksIG5ldyBGbG93Q2hhcnRCdWlsZGVyKCksXG4gICAgICAvLyBvciBhbnkgc3ViY2xhc3MpIGF1dG9tYXRpY2FsbHkgZ2V0cyBUeXBlZFNjb3BlIOKAlCBubyBtYW51YWwgc2V0U2NvcGVGYWN0b3J5IG5lZWRlZC5cbiAgICAgIHNjb3BlRmFjdG9yeTogdGhpcy5fc2NvcGVGYWN0b3J5ID8/IChjcmVhdGVUeXBlZFNjb3BlRmFjdG9yeSgpIGFzIHVua25vd24gYXMgU2NvcGVGYWN0b3J5PFRTY29wZT4pLFxuICAgIH07XG5cbiAgICByZXR1cm4gbWFrZVJ1bm5hYmxlKGNoYXJ0KTtcbiAgfVxuXG4gIC8qKiBPdmVycmlkZSB0aGUgc2NvcGUgZmFjdG9yeS4gUmFyZWx5IG5lZWRlZCDigJQgYXV0by1lbWJlZHMgVHlwZWRTY29wZSBieSBkZWZhdWx0LiAqL1xuICBzZXRTY29wZUZhY3RvcnkoZmFjdG9yeTogU2NvcGVGYWN0b3J5PFRTY29wZT4pOiB0aGlzIHtcbiAgICB0aGlzLl9zY29wZUZhY3RvcnkgPSBmYWN0b3J5O1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgdG9TcGVjPFRSZXN1bHQgPSBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmU+KCk6IFRSZXN1bHQge1xuICAgIGNvbnN0IHJvb3RTcGVjID0gdGhpcy5fcm9vdFNwZWMgPz8gZmFpbCgnZW1wdHkgdHJlZTsgY2FsbCBzdGFydCgpIGZpcnN0Jyk7XG4gICAgcmV0dXJuIHJvb3RTcGVjIGFzIFRSZXN1bHQ7XG4gIH1cblxuICB0b01lcm1haWQoKTogc3RyaW5nIHtcbiAgICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbJ2Zsb3djaGFydCBURCddO1xuICAgIGNvbnN0IGlkT2YgPSAoazogc3RyaW5nKSA9PiAoayB8fCAnJykucmVwbGFjZSgvW15hLXpBLVowLTlfXS9nLCAnXycpIHx8ICdfJztcbiAgICBjb25zdCByb290ID0gdGhpcy5fcm9vdCA/PyBmYWlsKCdlbXB0eSB0cmVlOyBjYWxsIHN0YXJ0KCkgZmlyc3QnKTtcblxuICAgIGNvbnN0IHdhbGsgPSAobjogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4pID0+IHtcbiAgICAgIGNvbnN0IG5pZCA9IGlkT2Yobi5pZCk7XG4gICAgICBsaW5lcy5wdXNoKGAke25pZH1bXCIke24ubmFtZX1cIl1gKTtcbiAgICAgIGZvciAoY29uc3QgYyBvZiBuLmNoaWxkcmVuIHx8IFtdKSB7XG4gICAgICAgIGNvbnN0IGNpZCA9IGlkT2YoYy5pZCk7XG4gICAgICAgIGxpbmVzLnB1c2goYCR7bmlkfSAtLT4gJHtjaWR9YCk7XG4gICAgICAgIHdhbGsoYyk7XG4gICAgICB9XG4gICAgICBpZiAobi5uZXh0KSB7XG4gICAgICAgIGNvbnN0IG1pZCA9IGlkT2Yobi5uZXh0LmlkKTtcbiAgICAgICAgbGluZXMucHVzaChgJHtuaWR9IC0tPiAke21pZH1gKTtcbiAgICAgICAgd2FsayhuLm5leHQpO1xuICAgICAgfVxuICAgIH07XG4gICAgd2Fsayhyb290KTtcbiAgICByZXR1cm4gbGluZXMuam9pbignXFxuJyk7XG4gIH1cblxuICAvLyDilIDilIAgSW50ZXJuYWxzIChleHBvc2VkIGZvciBoZWxwZXIgY2xhc3Nlcykg4pSA4pSAXG5cbiAgcHJpdmF0ZSBfbmVlZEN1cnNvcigpOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiB7XG4gICAgcmV0dXJuIHRoaXMuX2N1cnNvciA/PyBmYWlsKCdjdXJzb3IgdW5kZWZpbmVkOyBjYWxsIHN0YXJ0KCkgZmlyc3QnKTtcbiAgfVxuXG4gIHByaXZhdGUgX25lZWRDdXJzb3JTcGVjKCk6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSB7XG4gICAgcmV0dXJuIHRoaXMuX2N1cnNvclNwZWMgPz8gZmFpbCgnY3Vyc29yIHVuZGVmaW5lZDsgY2FsbCBzdGFydCgpIGZpcnN0Jyk7XG4gIH1cblxuICBfYXBwbHlFeHRyYWN0b3JUb05vZGUoc3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlKTogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlIHtcbiAgICBpZiAoIXRoaXMuX2J1aWxkVGltZUV4dHJhY3RvcikgcmV0dXJuIHNwZWM7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiB0aGlzLl9idWlsZFRpbWVFeHRyYWN0b3Ioc3BlYyBhcyBhbnkpIGFzIFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZTtcbiAgICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgICB0aGlzLl9idWlsZFRpbWVFeHRyYWN0b3JFcnJvcnMucHVzaCh7XG4gICAgICAgIG1lc3NhZ2U6IGVycm9yPy5tZXNzYWdlID8/IFN0cmluZyhlcnJvciksXG4gICAgICAgIGVycm9yLFxuICAgICAgfSk7XG4gICAgICByZXR1cm4gc3BlYztcbiAgICB9XG4gIH1cblxuICBfc3RhZ2VNYXBIYXMoa2V5OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5fc3RhZ2VNYXAuaGFzKGtleSk7XG4gIH1cblxuICBfYWRkVG9NYXAoaWQ6IHN0cmluZywgZm46IFN0YWdlRnVuY3Rpb248VE91dCwgVFNjb3BlPikge1xuICAgIGlmICh0aGlzLl9zdGFnZU1hcC5oYXMoaWQpKSB7XG4gICAgICBjb25zdCBleGlzdGluZyA9IHRoaXMuX3N0YWdlTWFwLmdldChpZCk7XG4gICAgICBpZiAoZXhpc3RpbmcgIT09IGZuKSBmYWlsKGBzdGFnZU1hcCBjb2xsaXNpb24gZm9yIGlkICcke2lkfSdgKTtcbiAgICB9XG4gICAgdGhpcy5fc3RhZ2VNYXAuc2V0KGlkLCBmbik7XG4gIH1cblxuICBfbWVyZ2VTdGFnZU1hcChvdGhlcjogTWFwPHN0cmluZywgU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+PiwgcHJlZml4Pzogc3RyaW5nKSB7XG4gICAgZm9yIChjb25zdCBbaywgdl0gb2Ygb3RoZXIpIHtcbiAgICAgIGNvbnN0IGtleSA9IHByZWZpeCA/IGAke3ByZWZpeH0vJHtrfWAgOiBrO1xuICAgICAgaWYgKHRoaXMuX3N0YWdlTWFwLmhhcyhrZXkpKSB7XG4gICAgICAgIGNvbnN0IGV4aXN0aW5nID0gdGhpcy5fc3RhZ2VNYXAuZ2V0KGtleSk7XG4gICAgICAgIGlmIChleGlzdGluZyAhPT0gdikgZmFpbChgc3RhZ2VNYXAgY29sbGlzaW9uIHdoaWxlIG1vdW50aW5nIGZsb3djaGFydCBhdCAnJHtrZXl9J2ApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5fc3RhZ2VNYXAuc2V0KGtleSwgdik7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgX3ByZWZpeE5vZGVUcmVlKG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+LCBwcmVmaXg6IHN0cmluZyk6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+IHtcbiAgICBpZiAoIW5vZGUpIHJldHVybiBub2RlO1xuICAgIGNvbnN0IGNsb25lOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiA9IHsgLi4ubm9kZSB9O1xuICAgIGNsb25lLm5hbWUgPSBgJHtwcmVmaXh9LyR7bm9kZS5uYW1lfWA7XG4gICAgY2xvbmUuaWQgPSBgJHtwcmVmaXh9LyR7bm9kZS5pZH1gO1xuICAgIGlmIChjbG9uZS5zdWJmbG93SWQpIGNsb25lLnN1YmZsb3dJZCA9IGAke3ByZWZpeH0vJHtjbG9uZS5zdWJmbG93SWR9YDtcbiAgICBpZiAoY2xvbmUubmV4dCkgY2xvbmUubmV4dCA9IHRoaXMuX3ByZWZpeE5vZGVUcmVlKGNsb25lLm5leHQsIHByZWZpeCk7XG4gICAgaWYgKGNsb25lLmNoaWxkcmVuKSB7XG4gICAgICBjbG9uZS5jaGlsZHJlbiA9IGNsb25lLmNoaWxkcmVuLm1hcCgoYykgPT4gdGhpcy5fcHJlZml4Tm9kZVRyZWUoYywgcHJlZml4KSk7XG4gICAgfVxuICAgIHJldHVybiBjbG9uZTtcbiAgfVxuXG4gIF9tZXJnZVN1YmZsb3dzKHN1YmZsb3dzOiBSZWNvcmQ8c3RyaW5nLCB7IHJvb3Q6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+IH0+IHwgdW5kZWZpbmVkLCBwcmVmaXg6IHN0cmluZykge1xuICAgIGlmICghc3ViZmxvd3MpIHJldHVybjtcbiAgICBmb3IgKGNvbnN0IFtrZXksIGRlZl0gb2YgT2JqZWN0LmVudHJpZXMoc3ViZmxvd3MpKSB7XG4gICAgICBjb25zdCBwcmVmaXhlZEtleSA9IGAke3ByZWZpeH0vJHtrZXl9YDtcbiAgICAgIGlmICghdGhpcy5fc3ViZmxvd0RlZnMuaGFzKHByZWZpeGVkS2V5KSkge1xuICAgICAgICB0aGlzLl9zdWJmbG93RGVmcy5zZXQocHJlZml4ZWRLZXksIHtcbiAgICAgICAgICByb290OiB0aGlzLl9wcmVmaXhOb2RlVHJlZShkZWYucm9vdCBhcyBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiwgcHJlZml4KSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICB9XG59XG5cbi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy8gRmFjdG9yeSBGdW5jdGlvblxuLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbi8vIE92ZXJsb2FkIDE6IHR5cGVkIHN0YXRlIOKAlCBmbG93Q2hhcnQ8TG9hblN0YXRlPiguLi4pIOKGkiBzY29wZTogVHlwZWRTY29wZTxMb2FuU3RhdGU+XG5leHBvcnQgZnVuY3Rpb24gZmxvd0NoYXJ0PFRTdGF0ZSBleHRlbmRzIG9iamVjdD4oXG4gIG5hbWU6IHN0cmluZyxcbiAgZm46IFR5cGVkU3RhZ2VGdW5jdGlvbjxUU3RhdGU+IHwgUGF1c2FibGVIYW5kbGVyPFR5cGVkU2NvcGU8VFN0YXRlPj4sXG4gIGlkOiBzdHJpbmcsXG4gIGJ1aWxkVGltZUV4dHJhY3Rvcj86IEJ1aWxkVGltZUV4dHJhY3Rvcjxhbnk+LFxuICBkZXNjcmlwdGlvbj86IHN0cmluZyxcbik6IEZsb3dDaGFydEJ1aWxkZXI8YW55LCBUeXBlZFNjb3BlPFRTdGF0ZT4+O1xuXG4vLyBPdmVybG9hZCAyOiBmdWxseSBleHBsaWNpdCBnZW5lcmljcyAoYWR2YW5jZWQgLyBTY29wZUZhY2FkZSB1c2FnZSlcbmV4cG9ydCBmdW5jdGlvbiBmbG93Q2hhcnQ8VE91dCA9IGFueSwgVFNjb3BlID0gYW55PihcbiAgbmFtZTogc3RyaW5nLFxuICBmbjogU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+IHwgUGF1c2FibGVIYW5kbGVyPFRTY29wZT4sXG4gIGlkOiBzdHJpbmcsXG4gIGJ1aWxkVGltZUV4dHJhY3Rvcj86IEJ1aWxkVGltZUV4dHJhY3Rvcjxhbnk+LFxuICBkZXNjcmlwdGlvbj86IHN0cmluZyxcbik6IEZsb3dDaGFydEJ1aWxkZXI8VE91dCwgVFNjb3BlPjtcblxuZXhwb3J0IGZ1bmN0aW9uIGZsb3dDaGFydDxUT3V0ID0gYW55LCBUU2NvcGUgPSBhbnk+KFxuICBuYW1lOiBzdHJpbmcsXG4gIGZuOiBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4gfCBQYXVzYWJsZUhhbmRsZXI8VFNjb3BlPixcbiAgaWQ6IHN0cmluZyxcbiAgYnVpbGRUaW1lRXh0cmFjdG9yPzogQnVpbGRUaW1lRXh0cmFjdG9yPGFueT4sXG4gIGRlc2NyaXB0aW9uPzogc3RyaW5nLFxuKTogRmxvd0NoYXJ0QnVpbGRlcjxUT3V0LCBUU2NvcGU+IHtcbiAgcmV0dXJuIG5ldyBGbG93Q2hhcnRCdWlsZGVyPFRPdXQsIFRTY29wZT4oYnVpbGRUaW1lRXh0cmFjdG9yKS5zdGFydChuYW1lLCBmbiBhcyBhbnksIGlkLCBkZXNjcmlwdGlvbik7XG59XG5cbi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy8gU3BlYyB0byBTdGFnZU5vZGUgQ29udmVydGVyXG4vLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuZXhwb3J0IGZ1bmN0aW9uIHNwZWNUb1N0YWdlTm9kZShzcGVjOiBGbG93Q2hhcnRTcGVjKTogU3RhZ2VOb2RlPGFueSwgYW55PiB7XG4gIGNvbnN0IGluZmxhdGUgPSAoczogRmxvd0NoYXJ0U3BlYyk6IFN0YWdlTm9kZTxhbnksIGFueT4gPT4gKHtcbiAgICBuYW1lOiBzLm5hbWUsXG4gICAgaWQ6IHMuaWQsXG4gICAgY2hpbGRyZW46IHMuY2hpbGRyZW4/Lmxlbmd0aCA/IHMuY2hpbGRyZW4ubWFwKGluZmxhdGUpIDogdW5kZWZpbmVkLFxuICAgIG5leHQ6IHMubmV4dCA/IGluZmxhdGUocy5uZXh0KSA6IHVuZGVmaW5lZCxcbiAgfSk7XG4gIHJldHVybiBpbmZsYXRlKHNwZWMpO1xufVxuIl19