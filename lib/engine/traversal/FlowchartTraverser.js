"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.FlowchartTraverser = void 0;
const types_js_1 = require("../../pause/types.js");
const StageNode_js_1 = require("../graph/StageNode.js");
const ChildrenExecutor_js_1 = require("../handlers/ChildrenExecutor.js");
const ContinuationResolver_js_1 = require("../handlers/ContinuationResolver.js");
const DeciderHandler_js_1 = require("../handlers/DeciderHandler.js");
const ExtractorRunner_js_1 = require("../handlers/ExtractorRunner.js");
const NodeResolver_js_1 = require("../handlers/NodeResolver.js");
const RuntimeStructureManager_js_1 = require("../handlers/RuntimeStructureManager.js");
const SelectorHandler_js_1 = require("../handlers/SelectorHandler.js");
const StageRunner_js_1 = require("../handlers/StageRunner.js");
const SubflowExecutor_js_1 = require("../handlers/SubflowExecutor.js");
const FlowRecorderDispatcher_js_1 = require("../narrative/FlowRecorderDispatcher.js");
const NarrativeFlowRecorder_js_1 = require("../narrative/NarrativeFlowRecorder.js");
const NullControlFlowNarrativeGenerator_js_1 = require("../narrative/NullControlFlowNarrativeGenerator.js");
class FlowchartTraverser {
    constructor(opts) {
        var _a, _b;
        // Execution state
        this.subflowResults = new Map();
        /**
         * Per-traverser set of lazy subflow IDs that have been resolved by THIS run.
         * Used instead of writing `node.subflowResolver = undefined` back to the shared
         * StageNode graph — avoids a race where a concurrent traverser clears the shared
         * resolver before another traverser has finished using it.
         */
        this.resolvedLazySubflows = new Set();
        /**
         * Recursion depth counter for executeNode.
         * Each recursive executeNode call increments this; decrements on exit (try/finally).
         * Prevents call-stack overflow on infinite loops or excessively deep stage chains.
         */
        this._executeDepth = 0;
        const maxDepth = (_a = opts.maxDepth) !== null && _a !== void 0 ? _a : FlowchartTraverser.MAX_EXECUTE_DEPTH;
        if (maxDepth < 1)
            throw new Error('FlowchartTraverser: maxDepth must be >= 1');
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
        this.structureManager = new RuntimeStructureManager_js_1.RuntimeStructureManager();
        this.structureManager.init(opts.buildTimeStructure);
        // Extractor runner
        this.extractorRunner = new ExtractorRunner_js_1.ExtractorRunner(opts.extractor, (_b = opts.enrichSnapshots) !== null && _b !== void 0 ? _b : false, this.executionRuntime, this.logger);
        // Narrative generator
        // Priority: explicit narrativeGenerator > flowRecorders > default NarrativeFlowRecorder > null.
        // Subflow traversers receive the parent's narrativeGenerator so all events flow to one place.
        if (opts.narrativeGenerator) {
            this.narrativeGenerator = opts.narrativeGenerator;
        }
        else if (opts.narrativeEnabled) {
            const dispatcher = new FlowRecorderDispatcher_js_1.FlowRecorderDispatcher();
            this.flowRecorderDispatcher = dispatcher;
            // If custom FlowRecorders are provided, use them; otherwise attach default NarrativeFlowRecorder
            if (opts.flowRecorders && opts.flowRecorders.length > 0) {
                for (const recorder of opts.flowRecorders) {
                    dispatcher.attach(recorder);
                }
            }
            else {
                dispatcher.attach(new NarrativeFlowRecorder_js_1.NarrativeFlowRecorder());
            }
            this.narrativeGenerator = dispatcher;
        }
        else {
            this.narrativeGenerator = new NullControlFlowNarrativeGenerator_js_1.NullControlFlowNarrativeGenerator();
        }
        // Build shared deps bag
        const deps = this.createDeps(opts);
        // Build O(1) node ID map from the root graph (avoids repeated DFS on every loopTo())
        const nodeIdMap = this.buildNodeIdMap(opts.root);
        // Initialize handler modules
        this.nodeResolver = new NodeResolver_js_1.NodeResolver(deps, nodeIdMap);
        this.childrenExecutor = new ChildrenExecutor_js_1.ChildrenExecutor(deps, this.executeNode.bind(this));
        this.stageRunner = new StageRunner_js_1.StageRunner(deps);
        this.continuationResolver = new ContinuationResolver_js_1.ContinuationResolver(deps, this.nodeResolver, (nodeId, count) => this.structureManager.updateIterationCount(nodeId, count));
        this.deciderHandler = new DeciderHandler_js_1.DeciderHandler(deps);
        this.selectorHandler = new SelectorHandler_js_1.SelectorHandler(deps, this.childrenExecutor);
        this.subflowExecutor = new SubflowExecutor_js_1.SubflowExecutor(deps, this.createSubflowTraverserFactory(opts));
    }
    /**
     * Create a factory that produces FlowchartTraverser instances for subflow execution.
     * Captures parent config in closure — SubflowExecutor provides subflow-specific overrides.
     * Each subflow gets a full traverser with all 7 phases (deciders, selectors, loops, etc.).
     */
    createSubflowTraverserFactory(parentOpts) {
        // Capture references to mutable state — factory reads the CURRENT state when called,
        // not the state at factory creation time. This is correct because lazy subflow resolution
        // may add entries to stageMap/subflows before a nested subflow is encountered.
        const parentStageMap = this.stageMap;
        const parentSubflows = this.subflows;
        const narrativeGenerator = this.narrativeGenerator;
        return (subflowOpts) => {
            const traverser = new FlowchartTraverser({
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
    createDeps(opts) {
        var _a;
        return {
            stageMap: this.stageMap,
            root: this.root,
            executionRuntime: this.executionRuntime,
            scopeFactory: opts.scopeFactory,
            subflows: this.subflows,
            throttlingErrorChecker: opts.throttlingErrorChecker,
            streamHandlers: opts.streamHandlers,
            scopeProtectionMode: (_a = opts.scopeProtectionMode) !== null && _a !== void 0 ? _a : 'error',
            readOnlyContext: opts.readOnlyContext,
            executionEnv: opts.executionEnv,
            narrativeGenerator: this.narrativeGenerator,
            logger: this.logger,
            signal: opts.signal,
        };
    }
    // ─────────────────────── Public API ───────────────────────
    async execute(branchPath) {
        const context = this.executionRuntime.rootStageContext;
        return await this.executeNode(this.root, context, { shouldBreak: false }, branchPath !== null && branchPath !== void 0 ? branchPath : '');
    }
    getRuntimeStructure() {
        return this.structureManager.getStructure();
    }
    getSnapshot() {
        return this.executionRuntime.getSnapshot();
    }
    getRuntime() {
        return this.executionRuntime;
    }
    setRootObject(path, key, value) {
        this.executionRuntime.setRootObject(path, key, value);
    }
    getBranchIds() {
        return this.executionRuntime.getPipelines();
    }
    getRuntimeRoot() {
        return this.root;
    }
    getSubflowResults() {
        return this.subflowResults;
    }
    getExtractedResults() {
        return this.extractorRunner.getExtractedResults();
    }
    getExtractorErrors() {
        return this.extractorRunner.getExtractorErrors();
    }
    getNarrative() {
        return this.narrativeGenerator.getSentences();
    }
    /** Returns the FlowRecorderDispatcher, or undefined if narrative is disabled. */
    getFlowRecorderDispatcher() {
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
    buildNodeIdMap(root) {
        const map = new Map();
        const visit = (node, depth) => {
            if (depth > FlowchartTraverser.MAX_EXECUTE_DEPTH)
                return;
            if (map.has(node.id))
                return; // already visited (avoids infinite loops on cyclic refs)
            map.set(node.id, node);
            if (node.children) {
                for (const child of node.children)
                    visit(child, depth + 1);
            }
            if (node.next)
                visit(node.next, depth + 1);
        };
        visit(root, 0);
        return map;
    }
    getStageFn(node) {
        if (typeof node.fn === 'function')
            return node.fn;
        // Primary: look up by id (stable identifier, keyed by FlowChartBuilder)
        const byId = this.stageMap.get(node.id);
        if (byId !== undefined)
            return byId;
        // Fallback: look up by name (supports hand-crafted stageMaps in tests and advanced use)
        return this.stageMap.get(node.name);
    }
    async executeStage(node, stageFunc, context, breakFn) {
        return this.stageRunner.run(node, stageFunc, context, breakFn);
    }
    /**
     * Pre-order DFS traversal — the core algorithm.
     * Each call processes one node through all 7 phases.
     */
    async executeNode(node, context, breakFlag, branchPath) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t;
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
                throw new Error(`FlowchartTraverser: maximum traversal depth exceeded (${this._maxDepth}). ` +
                    'Check for infinite loops or missing break conditions in your flowchart. ' +
                    `Last stage: '${node.name}'. ` +
                    'For loopTo() pipelines, consider adding a break condition or using RunOptions.maxDepth to raise the limit.');
            }
            // Attach builder metadata to context for snapshot enrichment
            if (node.description)
                context.description = node.description;
            if (node.isSubflowRoot && node.subflowId)
                context.subflowId = node.subflowId;
            // Build traversal context for recorder events — created once per stage, shared by all events
            const traversalContext = {
                stageId: (_a = node.id) !== null && _a !== void 0 ? _a : context.stageId,
                stageName: node.name,
                parentStageId: (_b = context.parent) === null || _b === void 0 ? void 0 : _b.stageId,
                subflowId: (_c = context.subflowId) !== null && _c !== void 0 ? _c : this.parentSubflowId,
                subflowPath: branchPath || undefined,
                depth: this.computeContextDepth(context),
            };
            // ─── Phase 0a: LAZY RESOLVE — deferred subflow resolution ───
            // Guard uses the per-traverser resolvedLazySubflows set (not the shared node) so
            // concurrent traversers do not race on node.subflowResolver or clear it for each other.
            if (node.isSubflowRoot && node.subflowResolver && !this.resolvedLazySubflows.has(node.subflowId)) {
                const resolved = node.subflowResolver();
                const prefixedRoot = this.prefixNodeTree(resolved.root, node.subflowId);
                // Register the resolved subflow (same path as eager registration)
                this.subflows[node.subflowId] = { root: prefixedRoot };
                // Merge stageMap entries
                for (const [key, fn] of resolved.stageMap) {
                    const prefixedKey = `${node.subflowId}/${key}`;
                    if (!this.stageMap.has(prefixedKey)) {
                        this.stageMap.set(prefixedKey, fn);
                    }
                }
                // Merge nested subflows
                if (resolved.subflows) {
                    for (const [key, def] of Object.entries(resolved.subflows)) {
                        const prefixedKey = `${node.subflowId}/${key}`;
                        if (!this.subflows[prefixedKey]) {
                            this.subflows[prefixedKey] = def;
                        }
                    }
                }
                // Update runtime structure with the now-resolved spec
                this.structureManager.updateDynamicSubflow(node.id, node.subflowId, node.subflowName, resolved.buildTimeStructure);
                // Mark as resolved for THIS traverser — per-traverser set prevents re-entry
                // without mutating the shared StageNode graph (which would race concurrent traversers).
                this.resolvedLazySubflows.add(node.subflowId);
            }
            // ─── Phase 0: CLASSIFY — subflow detection ───
            if (node.isSubflowRoot && node.subflowId) {
                const resolvedNode = this.nodeResolver.resolveSubflowReference(node);
                const previousSubflowId = this.extractorRunner.currentSubflowId;
                this.extractorRunner.currentSubflowId = node.subflowId;
                let subflowOutput;
                try {
                    subflowOutput = await this.subflowExecutor.executeSubflow(resolvedNode, context, breakFlag, branchPath, this.subflowResults, traversalContext);
                }
                finally {
                    this.extractorRunner.currentSubflowId = previousSubflowId;
                }
                const isReferenceBasedSubflow = resolvedNode !== node;
                const hasChildren = Boolean(node.children && node.children.length > 0);
                const shouldExecuteContinuation = isReferenceBasedSubflow || hasChildren;
                if (node.next && shouldExecuteContinuation) {
                    const nextCtx = context.createNext(branchPath, node.next.name, node.next.id);
                    return await this.executeNode(node.next, nextCtx, breakFlag, branchPath);
                }
                return subflowOutput;
            }
            const stageFunc = this.getStageFn(node);
            const hasStageFunction = Boolean(stageFunc);
            const isScopeBasedDecider = Boolean(node.deciderFn);
            const isScopeBasedSelector = Boolean(node.selectorFn);
            const isDeciderNode = isScopeBasedDecider;
            const hasChildren = Boolean((_d = node.children) === null || _d === void 0 ? void 0 : _d.length);
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
                if (isDeciderNode)
                    context.setAsDecider();
                else if (hasChildren)
                    context.setAsFork();
            }
            const breakFn = () => (breakFlag.shouldBreak = true);
            // ─── Phase 2a: SELECTOR — scope-based multi-choice ───
            if (isScopeBasedSelector) {
                const previousForkId = this.extractorRunner.currentForkId;
                this.extractorRunner.currentForkId = node.id;
                try {
                    const selectorResult = await this.selectorHandler.handleScopeBased(node, stageFunc, context, breakFlag, branchPath, this.executeStage.bind(this), this.executeNode.bind(this), this.extractorRunner.callExtractor.bind(this.extractorRunner), this.extractorRunner.getStagePath.bind(this.extractorRunner), traversalContext);
                    if (hasNext) {
                        const nextCtx = context.createNext(branchPath, node.next.name, node.next.id);
                        return await this.executeNode(node.next, nextCtx, breakFlag, branchPath);
                    }
                    return selectorResult;
                }
                finally {
                    this.extractorRunner.currentForkId = previousForkId;
                }
            }
            // ─── Phase 2b: DECIDER — scope-based single-choice conditional branch ───
            if (isDeciderNode) {
                const deciderResult = await this.deciderHandler.handleScopeBased(node, stageFunc, context, breakFlag, branchPath, this.executeStage.bind(this), this.executeNode.bind(this), this.extractorRunner.callExtractor.bind(this.extractorRunner), this.extractorRunner.getStagePath.bind(this.extractorRunner), traversalContext);
                // After branch execution, follow decider's own next (e.g., loopTo target)
                if (hasNext && !breakFlag.shouldBreak) {
                    const nextNode = originalNext;
                    // Use the isLoopRef flag set by loopTo() — do not rely on stageMap absence,
                    // since id-keyed stageMaps would otherwise cause loop targets to be executed directly.
                    const isLoopRef = nextNode.isLoopRef === true ||
                        (!this.getStageFn(nextNode) &&
                            !((_e = nextNode.children) === null || _e === void 0 ? void 0 : _e.length) &&
                            !nextNode.deciderFn &&
                            !nextNode.selectorFn &&
                            !nextNode.isSubflowRoot);
                    if (isLoopRef) {
                        return this.continuationResolver.resolve(nextNode, node, context, breakFlag, branchPath, this.executeNode.bind(this));
                    }
                    this.narrativeGenerator.onNext(node.name, nextNode.name, nextNode.description, traversalContext);
                    const nextCtx = context.createNext(branchPath, nextNode.name, nextNode.id);
                    return await this.executeNode(nextNode, nextCtx, breakFlag, branchPath);
                }
                return deciderResult;
            }
            // ─── Abort check — cooperative cancellation ───
            if ((_f = this.signal) === null || _f === void 0 ? void 0 : _f.aborted) {
                const reason = this.signal.reason instanceof Error ? this.signal.reason : new Error((_g = this.signal.reason) !== null && _g !== void 0 ? _g : 'Aborted');
                throw reason;
            }
            // ─── Phase 3: EXECUTE — run stage function ───
            let stageOutput;
            let dynamicNext;
            if (stageFunc) {
                try {
                    stageOutput = await this.executeStage(node, stageFunc, context, breakFn);
                }
                catch (error) {
                    // PauseSignal is expected control flow, not an error — fire narrative, commit, re-throw.
                    if ((0, types_js_1.isPauseSignal)(error)) {
                        context.commit();
                        this.narrativeGenerator.onPause(node.name, node.id, error.pauseData, error.subflowPath, traversalContext);
                        throw error;
                    }
                    context.commit();
                    this.extractorRunner.callExtractor(node, context, this.extractorRunner.getStagePath(node, branchPath, context.stageName), undefined, { type: 'stageExecutionError', message: error.toString() });
                    this.narrativeGenerator.onError(node.name, error.toString(), error, traversalContext);
                    this.logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error });
                    context.addError('stageExecutionError', error.toString());
                    throw error;
                }
                context.commit();
                this.extractorRunner.callExtractor(node, context, this.extractorRunner.getStagePath(node, branchPath, context.stageName), stageOutput);
                this.narrativeGenerator.onStageExecuted(node.name, node.description, traversalContext);
                if (breakFlag.shouldBreak) {
                    this.narrativeGenerator.onBreak(node.name, traversalContext);
                    this.logger.info(`Execution stopped in pipeline (${branchPath}) after ${node.name} due to break condition.`);
                    return stageOutput;
                }
                // ─── Phase 4: DYNAMIC — StageNode return detection ───
                if (stageOutput && typeof stageOutput === 'object' && (0, StageNode_js_1.isStageNodeReturn)(stageOutput)) {
                    const dynamicNode = stageOutput;
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
                            node.description = (_h = dynamicNode.description) !== null && _h !== void 0 ? _h : node.description;
                            this.structureManager.updateDynamicSubflow(node.id, dynamicNode.subflowId, dynamicNode.subflowName, dynamicNode.subflowDef.buildTimeStructure);
                            // Fall through to Phase 5 (continuation) — no subflow execution needed
                        }
                        else {
                            // Full dynamic subflow: register + execute
                            this.autoRegisterSubflowDef(dynamicNode.subflowId, dynamicNode.subflowDef, node.id);
                            node.isSubflowRoot = true;
                            node.subflowId = dynamicNode.subflowId;
                            node.subflowName = dynamicNode.subflowName;
                            node.subflowMountOptions = dynamicNode.subflowMountOptions;
                            this.structureManager.updateDynamicSubflow(node.id, dynamicNode.subflowId, dynamicNode.subflowName, (_j = dynamicNode.subflowDef) === null || _j === void 0 ? void 0 : _j.buildTimeStructure);
                            return await this.executeNode(node, context, breakFlag, branchPath);
                        }
                    }
                    // Check children for subflowDef
                    if (dynamicNode.children) {
                        for (const child of dynamicNode.children) {
                            if (child.isSubflowRoot && child.subflowDef && child.subflowId) {
                                this.autoRegisterSubflowDef(child.subflowId, child.subflowDef, child.id);
                                this.structureManager.updateDynamicSubflow(child.id, child.subflowId, child.subflowName, (_k = child.subflowDef) === null || _k === void 0 ? void 0 : _k.buildTimeStructure);
                            }
                        }
                    }
                    // Dynamic children (fork pattern)
                    if (dynamicNode.children && dynamicNode.children.length > 0) {
                        node.children = dynamicNode.children;
                        context.addLog('dynamicChildCount', dynamicNode.children.length);
                        context.addLog('dynamicChildIds', dynamicNode.children.map((c) => c.id));
                        this.structureManager.updateDynamicChildren(node.id, dynamicNode.children, Boolean(dynamicNode.nextNodeSelector), Boolean(dynamicNode.deciderFn));
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
            const hasChildrenAfterStage = Boolean((_l = node.children) === null || _l === void 0 ? void 0 : _l.length);
            if (hasChildrenAfterStage) {
                context.addLog('totalChildren', (_m = node.children) === null || _m === void 0 ? void 0 : _m.length);
                context.addLog('orderOfExecution', 'ChildrenAfterStage');
                let nodeChildrenResults;
                if (node.nextNodeSelector) {
                    const previousForkId = this.extractorRunner.currentForkId;
                    this.extractorRunner.currentForkId = node.id;
                    try {
                        nodeChildrenResults = await this.childrenExecutor.executeSelectedChildren(node.nextNodeSelector, node.children, stageOutput, context, branchPath, traversalContext);
                    }
                    finally {
                        this.extractorRunner.currentForkId = previousForkId;
                    }
                }
                else {
                    const childCount = (_p = (_o = node.children) === null || _o === void 0 ? void 0 : _o.length) !== null && _p !== void 0 ? _p : 0;
                    const childNames = (_q = node.children) === null || _q === void 0 ? void 0 : _q.map((c) => c.name).join(', ');
                    context.addFlowDebugMessage('children', `Executing all ${childCount} children in parallel: ${childNames}`, {
                        count: childCount,
                        targetStage: (_r = node.children) === null || _r === void 0 ? void 0 : _r.map((c) => c.name),
                    });
                    const previousForkId = this.extractorRunner.currentForkId;
                    this.extractorRunner.currentForkId = node.id;
                    try {
                        nodeChildrenResults = await this.childrenExecutor.executeNodeChildren(node, context, undefined, branchPath, traversalContext);
                    }
                    finally {
                        this.extractorRunner.currentForkId = previousForkId;
                    }
                }
                // Fork-only: return bundle
                if (!hasNext && !dynamicNext) {
                    return nodeChildrenResults;
                }
                // Capture dynamic children as synthetic subflow result for UI
                const isDynamic = (_t = (_s = context.debug) === null || _s === void 0 ? void 0 : _s.logContext) === null || _t === void 0 ? void 0 : _t.isDynamic;
                if (isDynamic && node.children && node.children.length > 0) {
                    this.captureDynamicChildrenResult(node, context);
                }
            }
            // ─── Phase 6: CONTINUE — dynamic next / linear next ───
            if (dynamicNext) {
                return this.continuationResolver.resolve(dynamicNext, node, context, breakFlag, branchPath, this.executeNode.bind(this));
            }
            if (hasNext) {
                const nextNode = originalNext;
                // Detect loop reference nodes created by loopTo() — marked with isLoopRef flag.
                // Route through ContinuationResolver for proper ID resolution, iteration
                // tracking, and narrative generation.
                const isLoopReference = nextNode.isLoopRef;
                if (isLoopReference) {
                    return this.continuationResolver.resolve(nextNode, node, context, breakFlag, branchPath, this.executeNode.bind(this), traversalContext);
                }
                this.narrativeGenerator.onNext(node.name, nextNode.name, nextNode.description, traversalContext);
                context.addFlowDebugMessage('next', `Moving to ${nextNode.name} stage`, {
                    targetStage: nextNode.name,
                });
                const nextCtx = context.createNext(branchPath, nextNode.name, nextNode.id);
                return await this.executeNode(nextNode, nextCtx, breakFlag, branchPath);
            }
            // ─── Phase 7: LEAF — no continuation ───
            return stageOutput;
        }
        finally {
            this._executeDepth--;
        }
    }
    // ─────────────────────── Private Helpers ───────────────────────
    captureDynamicChildrenResult(node, context) {
        const parentStageId = context.getStageId();
        const childStructure = {
            id: `${node.id}-children`,
            name: 'Dynamic Children',
            type: 'fork',
            children: node.children.map((c) => ({
                id: c.id,
                name: c.name,
                type: 'stage',
            })),
        };
        const childStages = {};
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
                stageContexts: childStages,
                history: [],
            },
            parentStageId,
            pipelineStructure: childStructure,
        });
    }
    computeContextDepth(context) {
        let depth = 0;
        let current = context.parent;
        while (current) {
            depth++;
            current = current.parent;
        }
        return depth;
    }
    prefixNodeTree(node, prefix) {
        if (!node)
            return node;
        const clone = { ...node };
        clone.name = `${prefix}/${node.name}`;
        clone.id = `${prefix}/${clone.id}`;
        if (clone.subflowId)
            clone.subflowId = `${prefix}/${clone.subflowId}`;
        if (clone.next)
            clone.next = this.prefixNodeTree(clone.next, prefix);
        if (clone.children) {
            clone.children = clone.children.map((c) => this.prefixNodeTree(c, prefix));
        }
        return clone;
    }
    autoRegisterSubflowDef(subflowId, subflowDef, mountNodeId) {
        var _a, _b, _c, _d, _e;
        // this.subflows is always initialized in the constructor; the null guard below is unreachable.
        const subflowsDict = this.subflows;
        // First-write-wins
        const isNewRegistration = !subflowsDict[subflowId];
        if (isNewRegistration && subflowDef.root) {
            subflowsDict[subflowId] = {
                root: subflowDef.root,
                ...(subflowDef.buildTimeStructure ? { buildTimeStructure: subflowDef.buildTimeStructure } : {}),
            };
        }
        // Merge stageMap entries (parent entries preserved)
        if (subflowDef.stageMap) {
            for (const [key, fn] of Array.from(subflowDef.stageMap.entries())) {
                if (!this.stageMap.has(key)) {
                    this.stageMap.set(key, fn);
                }
            }
        }
        // Merge nested subflows
        if (subflowDef.subflows) {
            for (const [key, def] of Object.entries(subflowDef.subflows)) {
                if (!subflowsDict[key]) {
                    subflowsDict[key] = def;
                }
            }
        }
        if (mountNodeId) {
            this.structureManager.updateDynamicSubflow(mountNodeId, subflowId, ((_a = subflowDef.root) === null || _a === void 0 ? void 0 : _a.subflowName) || ((_b = subflowDef.root) === null || _b === void 0 ? void 0 : _b.name), subflowDef.buildTimeStructure);
        }
        // Notify FlowRecorders only on first registration (matches first-write-wins)
        if (isNewRegistration) {
            const subflowName = ((_c = subflowDef.root) === null || _c === void 0 ? void 0 : _c.subflowName) || ((_d = subflowDef.root) === null || _d === void 0 ? void 0 : _d.name) || subflowId;
            this.narrativeGenerator.onSubflowRegistered(subflowId, subflowName, (_e = subflowDef.root) === null || _e === void 0 ? void 0 : _e.description, subflowDef.buildTimeStructure);
        }
    }
}
exports.FlowchartTraverser = FlowchartTraverser;
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
FlowchartTraverser.MAX_EXECUTE_DEPTH = 500;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRmxvd2NoYXJ0VHJhdmVyc2VyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9lbmdpbmUvdHJhdmVyc2FsL0Zsb3djaGFydFRyYXZlcnNlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0FtQkc7OztBQUdILG1EQUFxRDtBQUVyRCx3REFBMEQ7QUFDMUQseUVBQW1FO0FBQ25FLGlGQUEyRTtBQUMzRSxxRUFBK0Q7QUFDL0QsdUVBQWlFO0FBQ2pFLGlFQUEyRDtBQUMzRCx1RkFBaUY7QUFDakYsdUVBQWlFO0FBQ2pFLCtEQUF5RDtBQUN6RCx1RUFBaUU7QUFDakUsc0ZBQWdGO0FBQ2hGLG9GQUE4RTtBQUM5RSw0R0FBc0c7QUF5RHRHLE1BQWEsa0JBQWtCO0lBaUU3QixZQUFZLElBQW9DOztRQTNDaEQsa0JBQWtCO1FBQ1YsbUJBQWMsR0FBK0IsSUFBSSxHQUFHLEVBQUUsQ0FBQztRQUUvRDs7Ozs7V0FLRztRQUNjLHlCQUFvQixHQUFHLElBQUksR0FBRyxFQUFVLENBQUM7UUFFMUQ7Ozs7V0FJRztRQUNLLGtCQUFhLEdBQUcsQ0FBQyxDQUFDO1FBNEJ4QixNQUFNLFFBQVEsR0FBRyxNQUFBLElBQUksQ0FBQyxRQUFRLG1DQUFJLGtCQUFrQixDQUFDLGlCQUFpQixDQUFDO1FBQ3ZFLElBQUksUUFBUSxHQUFHLENBQUM7WUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLDJDQUEyQyxDQUFDLENBQUM7UUFDL0UsSUFBSSxDQUFDLFNBQVMsR0FBRyxRQUFRLENBQUM7UUFDMUIsSUFBSSxDQUFDLElBQUksR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDO1FBQ3RCLHVFQUF1RTtRQUN2RSwwRUFBMEU7UUFDMUUsc0VBQXNFO1FBQ3RFLDBFQUEwRTtRQUMxRSxxQ0FBcUM7UUFDckMsSUFBSSxDQUFDLFFBQVEsR0FBRyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDdkMsSUFBSSxDQUFDLGdCQUFnQixHQUFHLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQztRQUM5QyxJQUFJLENBQUMsUUFBUSxHQUFHLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLEVBQUUsR0FBRyxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztRQUMxRCxJQUFJLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQyxNQUFNLENBQUM7UUFDMUIsSUFBSSxDQUFDLE1BQU0sR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDO1FBQzFCLElBQUksQ0FBQyxlQUFlLEdBQUcsSUFBSSxDQUFDLGVBQWUsQ0FBQztRQUU1Qyx1REFBdUQ7UUFDdkQsSUFBSSxDQUFDLGdCQUFnQixHQUFHLElBQUksb0RBQXVCLEVBQUUsQ0FBQztRQUN0RCxJQUFJLENBQUMsZ0JBQWdCLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDO1FBRXBELG1CQUFtQjtRQUNuQixJQUFJLENBQUMsZUFBZSxHQUFHLElBQUksb0NBQWUsQ0FDeEMsSUFBSSxDQUFDLFNBQVMsRUFDZCxNQUFBLElBQUksQ0FBQyxlQUFlLG1DQUFJLEtBQUssRUFDN0IsSUFBSSxDQUFDLGdCQUFnQixFQUNyQixJQUFJLENBQUMsTUFBTSxDQUNaLENBQUM7UUFFRixzQkFBc0I7UUFDdEIsZ0dBQWdHO1FBQ2hHLDhGQUE4RjtRQUM5RixJQUFJLElBQUksQ0FBQyxrQkFBa0IsRUFBRSxDQUFDO1lBQzVCLElBQUksQ0FBQyxrQkFBa0IsR0FBRyxJQUFJLENBQUMsa0JBQWtCLENBQUM7UUFDcEQsQ0FBQzthQUFNLElBQUksSUFBSSxDQUFDLGdCQUFnQixFQUFFLENBQUM7WUFDakMsTUFBTSxVQUFVLEdBQUcsSUFBSSxrREFBc0IsRUFBRSxDQUFDO1lBQ2hELElBQUksQ0FBQyxzQkFBc0IsR0FBRyxVQUFVLENBQUM7WUFFekMsaUdBQWlHO1lBQ2pHLElBQUksSUFBSSxDQUFDLGFBQWEsSUFBSSxJQUFJLENBQUMsYUFBYSxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQztnQkFDeEQsS0FBSyxNQUFNLFFBQVEsSUFBSSxJQUFJLENBQUMsYUFBYSxFQUFFLENBQUM7b0JBQzFDLFVBQVUsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLENBQUM7Z0JBQzlCLENBQUM7WUFDSCxDQUFDO2lCQUFNLENBQUM7Z0JBQ04sVUFBVSxDQUFDLE1BQU0sQ0FBQyxJQUFJLGdEQUFxQixFQUFFLENBQUMsQ0FBQztZQUNqRCxDQUFDO1lBRUQsSUFBSSxDQUFDLGtCQUFrQixHQUFHLFVBQVUsQ0FBQztRQUN2QyxDQUFDO2FBQU0sQ0FBQztZQUNOLElBQUksQ0FBQyxrQkFBa0IsR0FBRyxJQUFJLHdFQUFpQyxFQUFFLENBQUM7UUFDcEUsQ0FBQztRQUVELHdCQUF3QjtRQUN4QixNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBRW5DLHFGQUFxRjtRQUNyRixNQUFNLFNBQVMsR0FBRyxJQUFJLENBQUMsY0FBYyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUVqRCw2QkFBNkI7UUFDN0IsSUFBSSxDQUFDLFlBQVksR0FBRyxJQUFJLDhCQUFZLENBQUMsSUFBSSxFQUFFLFNBQVMsQ0FBQyxDQUFDO1FBQ3RELElBQUksQ0FBQyxnQkFBZ0IsR0FBRyxJQUFJLHNDQUFnQixDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO1FBQ2hGLElBQUksQ0FBQyxXQUFXLEdBQUcsSUFBSSw0QkFBVyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3pDLElBQUksQ0FBQyxvQkFBb0IsR0FBRyxJQUFJLDhDQUFvQixDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsWUFBWSxFQUFFLENBQUMsTUFBTSxFQUFFLEtBQUssRUFBRSxFQUFFLENBQzlGLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxvQkFBb0IsQ0FBQyxNQUFNLEVBQUUsS0FBSyxDQUFDLENBQzFELENBQUM7UUFDRixJQUFJLENBQUMsY0FBYyxHQUFHLElBQUksa0NBQWMsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUMvQyxJQUFJLENBQUMsZUFBZSxHQUFHLElBQUksb0NBQWUsQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLGdCQUFnQixDQUFDLENBQUM7UUFDeEUsSUFBSSxDQUFDLGVBQWUsR0FBRyxJQUFJLG9DQUFlLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyw2QkFBNkIsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO0lBQzdGLENBQUM7SUFFRDs7OztPQUlHO0lBQ0ssNkJBQTZCLENBQ25DLFVBQTBDO1FBRTFDLHFGQUFxRjtRQUNyRiwwRkFBMEY7UUFDMUYsK0VBQStFO1FBQy9FLE1BQU0sY0FBYyxHQUFHLElBQUksQ0FBQyxRQUFRLENBQUM7UUFDckMsTUFBTSxjQUFjLEdBQUcsSUFBSSxDQUFDLFFBQVEsQ0FBQztRQUNyQyxNQUFNLGtCQUFrQixHQUFHLElBQUksQ0FBQyxrQkFBa0IsQ0FBQztRQUVuRCxPQUFPLENBQUMsV0FBVyxFQUFFLEVBQUU7WUFDckIsTUFBTSxTQUFTLEdBQUcsSUFBSSxrQkFBa0IsQ0FBZTtnQkFDckQsSUFBSSxFQUFFLFdBQVcsQ0FBQyxJQUFJO2dCQUN0QixRQUFRLEVBQUUsY0FBYyxFQUFFLGtDQUFrQztnQkFDNUQsWUFBWSxFQUFFLFVBQVUsQ0FBQyxZQUFZO2dCQUNyQyxnQkFBZ0IsRUFBRSxXQUFXLENBQUMsZ0JBQWdCO2dCQUM5QyxlQUFlLEVBQUUsV0FBVyxDQUFDLGVBQWU7Z0JBQzVDLFlBQVksRUFBRSxVQUFVLENBQUMsWUFBWTtnQkFDckMsc0JBQXNCLEVBQUUsVUFBVSxDQUFDLHNCQUFzQjtnQkFDekQsY0FBYyxFQUFFLFVBQVUsQ0FBQyxjQUFjO2dCQUN6QyxTQUFTLEVBQUUsVUFBVSxDQUFDLFNBQVM7Z0JBQy9CLG1CQUFtQixFQUFFLFVBQVUsQ0FBQyxtQkFBbUI7Z0JBQ25ELFFBQVEsRUFBRSxjQUFjLEVBQUUsa0NBQWtDO2dCQUM1RCxlQUFlLEVBQUUsVUFBVSxDQUFDLGVBQWU7Z0JBQzNDLGtCQUFrQixFQUFFLGdEQUFnRDtnQkFDcEUsTUFBTSxFQUFFLFVBQVUsQ0FBQyxNQUFNO2dCQUN6QixNQUFNLEVBQUUsVUFBVSxDQUFDLE1BQU07Z0JBQ3pCLFFBQVEsRUFBRSxJQUFJLENBQUMsU0FBUztnQkFDeEIsZUFBZSxFQUFFLFdBQVcsQ0FBQyxTQUFTO2FBQ3ZDLENBQUMsQ0FBQztZQUVILE9BQU87Z0JBQ0wsT0FBTyxFQUFFLEdBQUcsRUFBRSxDQUFDLFNBQVMsQ0FBQyxPQUFPLEVBQUU7Z0JBQ2xDLGlCQUFpQixFQUFFLEdBQUcsRUFBRSxDQUFDLFNBQVMsQ0FBQyxpQkFBaUIsRUFBRTthQUN2RCxDQUFDO1FBQ0osQ0FBQyxDQUFDO0lBQ0osQ0FBQztJQUVPLFVBQVUsQ0FBQyxJQUFvQzs7UUFDckQsT0FBTztZQUNMLFFBQVEsRUFBRSxJQUFJLENBQUMsUUFBUTtZQUN2QixJQUFJLEVBQUUsSUFBSSxDQUFDLElBQUk7WUFDZixnQkFBZ0IsRUFBRSxJQUFJLENBQUMsZ0JBQWdCO1lBQ3ZDLFlBQVksRUFBRSxJQUFJLENBQUMsWUFBWTtZQUMvQixRQUFRLEVBQUUsSUFBSSxDQUFDLFFBQVE7WUFDdkIsc0JBQXNCLEVBQUUsSUFBSSxDQUFDLHNCQUFzQjtZQUNuRCxjQUFjLEVBQUUsSUFBSSxDQUFDLGNBQWM7WUFDbkMsbUJBQW1CLEVBQUUsTUFBQSxJQUFJLENBQUMsbUJBQW1CLG1DQUFJLE9BQU87WUFDeEQsZUFBZSxFQUFFLElBQUksQ0FBQyxlQUFlO1lBQ3JDLFlBQVksRUFBRSxJQUFJLENBQUMsWUFBWTtZQUMvQixrQkFBa0IsRUFBRSxJQUFJLENBQUMsa0JBQWtCO1lBQzNDLE1BQU0sRUFBRSxJQUFJLENBQUMsTUFBTTtZQUNuQixNQUFNLEVBQUUsSUFBSSxDQUFDLE1BQU07U0FDcEIsQ0FBQztJQUNKLENBQUM7SUFFRCw2REFBNkQ7SUFFN0QsS0FBSyxDQUFDLE9BQU8sQ0FBQyxVQUFtQjtRQUMvQixNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsZ0JBQWdCLENBQUMsZ0JBQWdCLENBQUM7UUFDdkQsT0FBTyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxPQUFPLEVBQUUsRUFBRSxXQUFXLEVBQUUsS0FBSyxFQUFFLEVBQUUsVUFBVSxhQUFWLFVBQVUsY0FBVixVQUFVLEdBQUksRUFBRSxDQUFDLENBQUM7SUFDOUYsQ0FBQztJQUVELG1CQUFtQjtRQUNqQixPQUFPLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxZQUFZLEVBQUUsQ0FBQztJQUM5QyxDQUFDO0lBRUQsV0FBVztRQUNULE9BQU8sSUFBSSxDQUFDLGdCQUFnQixDQUFDLFdBQVcsRUFBRSxDQUFDO0lBQzdDLENBQUM7SUFFRCxVQUFVO1FBQ1IsT0FBTyxJQUFJLENBQUMsZ0JBQWdCLENBQUM7SUFDL0IsQ0FBQztJQUVELGFBQWEsQ0FBQyxJQUFjLEVBQUUsR0FBVyxFQUFFLEtBQWM7UUFDdkQsSUFBSSxDQUFDLGdCQUFnQixDQUFDLGFBQWEsQ0FBQyxJQUFJLEVBQUUsR0FBRyxFQUFFLEtBQUssQ0FBQyxDQUFDO0lBQ3hELENBQUM7SUFFRCxZQUFZO1FBQ1YsT0FBTyxJQUFJLENBQUMsZ0JBQWdCLENBQUMsWUFBWSxFQUFFLENBQUM7SUFDOUMsQ0FBQztJQUVELGNBQWM7UUFDWixPQUFPLElBQUksQ0FBQyxJQUFJLENBQUM7SUFDbkIsQ0FBQztJQUVELGlCQUFpQjtRQUNmLE9BQU8sSUFBSSxDQUFDLGNBQWMsQ0FBQztJQUM3QixDQUFDO0lBRUQsbUJBQW1CO1FBQ2pCLE9BQU8sSUFBSSxDQUFDLGVBQWUsQ0FBQyxtQkFBbUIsRUFBMEIsQ0FBQztJQUM1RSxDQUFDO0lBRUQsa0JBQWtCO1FBQ2hCLE9BQU8sSUFBSSxDQUFDLGVBQWUsQ0FBQyxrQkFBa0IsRUFBRSxDQUFDO0lBQ25ELENBQUM7SUFFRCxZQUFZO1FBQ1YsT0FBTyxJQUFJLENBQUMsa0JBQWtCLENBQUMsWUFBWSxFQUFFLENBQUM7SUFDaEQsQ0FBQztJQUVELGlGQUFpRjtJQUNqRix5QkFBeUI7UUFDdkIsT0FBTyxJQUFJLENBQUMsc0JBQXNCLENBQUM7SUFDckMsQ0FBQztJQUVELGlFQUFpRTtJQUVqRTs7Ozs7O09BTUc7SUFDSyxjQUFjLENBQUMsSUFBNkI7UUFDbEQsTUFBTSxHQUFHLEdBQUcsSUFBSSxHQUFHLEVBQW1DLENBQUM7UUFDdkQsTUFBTSxLQUFLLEdBQUcsQ0FBQyxJQUE2QixFQUFFLEtBQWEsRUFBUSxFQUFFO1lBQ25FLElBQUksS0FBSyxHQUFHLGtCQUFrQixDQUFDLGlCQUFpQjtnQkFBRSxPQUFPO1lBQ3pELElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO2dCQUFFLE9BQU8sQ0FBQyx5REFBeUQ7WUFDdkYsR0FBRyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxFQUFFLElBQUksQ0FBQyxDQUFDO1lBQ3ZCLElBQUksSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO2dCQUNsQixLQUFLLE1BQU0sS0FBSyxJQUFJLElBQUksQ0FBQyxRQUFRO29CQUFFLEtBQUssQ0FBQyxLQUFLLEVBQUUsS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDO1lBQzdELENBQUM7WUFDRCxJQUFJLElBQUksQ0FBQyxJQUFJO2dCQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQztRQUM3QyxDQUFDLENBQUM7UUFDRixLQUFLLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBQ2YsT0FBTyxHQUFHLENBQUM7SUFDYixDQUFDO0lBRU8sVUFBVSxDQUFDLElBQTZCO1FBQzlDLElBQUksT0FBTyxJQUFJLENBQUMsRUFBRSxLQUFLLFVBQVU7WUFBRSxPQUFPLElBQUksQ0FBQyxFQUFpQyxDQUFDO1FBQ2pGLHdFQUF3RTtRQUN4RSxNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDeEMsSUFBSSxJQUFJLEtBQUssU0FBUztZQUFFLE9BQU8sSUFBSSxDQUFDO1FBQ3BDLHdGQUF3RjtRQUN4RixPQUFPLElBQUksQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUN0QyxDQUFDO0lBRU8sS0FBSyxDQUFDLFlBQVksQ0FDeEIsSUFBNkIsRUFDN0IsU0FBc0MsRUFDdEMsT0FBcUIsRUFDckIsT0FBbUI7UUFFbkIsT0FBTyxJQUFJLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsU0FBUyxFQUFFLE9BQU8sRUFBRSxPQUFPLENBQUMsQ0FBQztJQUNqRSxDQUFDO0lBRUQ7OztPQUdHO0lBQ0ssS0FBSyxDQUFDLFdBQVcsQ0FDdkIsSUFBNkIsRUFDN0IsT0FBcUIsRUFDckIsU0FBbUMsRUFDbkMsVUFBbUI7O1FBRW5CLGdDQUFnQztRQUNoQyxzRUFBc0U7UUFDdEUsMEVBQTBFO1FBQzFFLHdFQUF3RTtRQUN4RSx3RUFBd0U7UUFDeEUsZ0ZBQWdGO1FBQ2hGLDRFQUE0RTtRQUM1RSxtQ0FBbUM7UUFDbkMsSUFBSSxDQUFDO1lBQ0gsSUFBSSxFQUFFLElBQUksQ0FBQyxhQUFhLEdBQUcsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDO2dCQUMxQyxNQUFNLElBQUksS0FBSyxDQUNiLHlEQUF5RCxJQUFJLENBQUMsU0FBUyxLQUFLO29CQUMxRSwwRUFBMEU7b0JBQzFFLGdCQUFnQixJQUFJLENBQUMsSUFBSSxLQUFLO29CQUM5Qiw0R0FBNEcsQ0FDL0csQ0FBQztZQUNKLENBQUM7WUFFRCw2REFBNkQ7WUFDN0QsSUFBSSxJQUFJLENBQUMsV0FBVztnQkFBRSxPQUFPLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQyxXQUFXLENBQUM7WUFDN0QsSUFBSSxJQUFJLENBQUMsYUFBYSxJQUFJLElBQUksQ0FBQyxTQUFTO2dCQUFFLE9BQU8sQ0FBQyxTQUFTLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQztZQUU3RSw2RkFBNkY7WUFDN0YsTUFBTSxnQkFBZ0IsR0FBcUI7Z0JBQ3pDLE9BQU8sRUFBRSxNQUFBLElBQUksQ0FBQyxFQUFFLG1DQUFJLE9BQU8sQ0FBQyxPQUFPO2dCQUNuQyxTQUFTLEVBQUUsSUFBSSxDQUFDLElBQUk7Z0JBQ3BCLGFBQWEsRUFBRSxNQUFBLE9BQU8sQ0FBQyxNQUFNLDBDQUFFLE9BQU87Z0JBQ3RDLFNBQVMsRUFBRSxNQUFBLE9BQU8sQ0FBQyxTQUFTLG1DQUFJLElBQUksQ0FBQyxlQUFlO2dCQUNwRCxXQUFXLEVBQUUsVUFBVSxJQUFJLFNBQVM7Z0JBQ3BDLEtBQUssRUFBRSxJQUFJLENBQUMsbUJBQW1CLENBQUMsT0FBTyxDQUFDO2FBQ3pDLENBQUM7WUFFRiwrREFBK0Q7WUFDL0QsaUZBQWlGO1lBQ2pGLHdGQUF3RjtZQUN4RixJQUFJLElBQUksQ0FBQyxhQUFhLElBQUksSUFBSSxDQUFDLGVBQWUsSUFBSSxDQUFDLElBQUksQ0FBQyxvQkFBb0IsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFNBQVUsQ0FBQyxFQUFFLENBQUM7Z0JBQ2xHLE1BQU0sUUFBUSxHQUFHLElBQUksQ0FBQyxlQUFlLEVBQUUsQ0FBQztnQkFDeEMsTUFBTSxZQUFZLEdBQUcsSUFBSSxDQUFDLGNBQWMsQ0FBQyxRQUFRLENBQUMsSUFBK0IsRUFBRSxJQUFJLENBQUMsU0FBVSxDQUFDLENBQUM7Z0JBRXBHLGtFQUFrRTtnQkFDbEUsSUFBSSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsU0FBVSxDQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUUsWUFBWSxFQUFFLENBQUM7Z0JBRXhELHlCQUF5QjtnQkFDekIsS0FBSyxNQUFNLENBQUMsR0FBRyxFQUFFLEVBQUUsQ0FBQyxJQUFJLFFBQVEsQ0FBQyxRQUFRLEVBQUUsQ0FBQztvQkFDMUMsTUFBTSxXQUFXLEdBQUcsR0FBRyxJQUFJLENBQUMsU0FBUyxJQUFJLEdBQUcsRUFBRSxDQUFDO29CQUMvQyxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsV0FBVyxDQUFDLEVBQUUsQ0FBQzt3QkFDcEMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsV0FBVyxFQUFFLEVBQWlDLENBQUMsQ0FBQztvQkFDcEUsQ0FBQztnQkFDSCxDQUFDO2dCQUVELHdCQUF3QjtnQkFDeEIsSUFBSSxRQUFRLENBQUMsUUFBUSxFQUFFLENBQUM7b0JBQ3RCLEtBQUssTUFBTSxDQUFDLEdBQUcsRUFBRSxHQUFHLENBQUMsSUFBSSxNQUFNLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDO3dCQUMzRCxNQUFNLFdBQVcsR0FBRyxHQUFHLElBQUksQ0FBQyxTQUFTLElBQUksR0FBRyxFQUFFLENBQUM7d0JBQy9DLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLFdBQVcsQ0FBQyxFQUFFLENBQUM7NEJBQ2hDLElBQUksQ0FBQyxRQUFRLENBQUMsV0FBVyxDQUFDLEdBQUcsR0FBd0MsQ0FBQzt3QkFDeEUsQ0FBQztvQkFDSCxDQUFDO2dCQUNILENBQUM7Z0JBRUQsc0RBQXNEO2dCQUN0RCxJQUFJLENBQUMsZ0JBQWdCLENBQUMsb0JBQW9CLENBQ3hDLElBQUksQ0FBQyxFQUFFLEVBQ1AsSUFBSSxDQUFDLFNBQVUsRUFDZixJQUFJLENBQUMsV0FBVyxFQUNoQixRQUFRLENBQUMsa0JBQWtCLENBQzVCLENBQUM7Z0JBRUYsNEVBQTRFO2dCQUM1RSx3RkFBd0Y7Z0JBQ3hGLElBQUksQ0FBQyxvQkFBb0IsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFNBQVUsQ0FBQyxDQUFDO1lBQ2pELENBQUM7WUFFRCxnREFBZ0Q7WUFDaEQsSUFBSSxJQUFJLENBQUMsYUFBYSxJQUFJLElBQUksQ0FBQyxTQUFTLEVBQUUsQ0FBQztnQkFDekMsTUFBTSxZQUFZLEdBQUcsSUFBSSxDQUFDLFlBQVksQ0FBQyx1QkFBdUIsQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFDckUsTUFBTSxpQkFBaUIsR0FBRyxJQUFJLENBQUMsZUFBZSxDQUFDLGdCQUFnQixDQUFDO2dCQUNoRSxJQUFJLENBQUMsZUFBZSxDQUFDLGdCQUFnQixHQUFHLElBQUksQ0FBQyxTQUFTLENBQUM7Z0JBRXZELElBQUksYUFBa0IsQ0FBQztnQkFDdkIsSUFBSSxDQUFDO29CQUNILGFBQWEsR0FBRyxNQUFNLElBQUksQ0FBQyxlQUFlLENBQUMsY0FBYyxDQUN2RCxZQUFZLEVBQ1osT0FBTyxFQUNQLFNBQVMsRUFDVCxVQUFVLEVBQ1YsSUFBSSxDQUFDLGNBQWMsRUFDbkIsZ0JBQWdCLENBQ2pCLENBQUM7Z0JBQ0osQ0FBQzt3QkFBUyxDQUFDO29CQUNULElBQUksQ0FBQyxlQUFlLENBQUMsZ0JBQWdCLEdBQUcsaUJBQWlCLENBQUM7Z0JBQzVELENBQUM7Z0JBRUQsTUFBTSx1QkFBdUIsR0FBRyxZQUFZLEtBQUssSUFBSSxDQUFDO2dCQUN0RCxNQUFNLFdBQVcsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLFFBQVEsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQztnQkFDdkUsTUFBTSx5QkFBeUIsR0FBRyx1QkFBdUIsSUFBSSxXQUFXLENBQUM7Z0JBRXpFLElBQUksSUFBSSxDQUFDLElBQUksSUFBSSx5QkFBeUIsRUFBRSxDQUFDO29CQUMzQyxNQUFNLE9BQU8sR0FBRyxPQUFPLENBQUMsVUFBVSxDQUFDLFVBQW9CLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztvQkFDdkYsT0FBTyxNQUFNLElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFVBQVUsQ0FBQyxDQUFDO2dCQUMzRSxDQUFDO2dCQUVELE9BQU8sYUFBYSxDQUFDO1lBQ3ZCLENBQUM7WUFFRCxNQUFNLFNBQVMsR0FBRyxJQUFJLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ3hDLE1BQU0sZ0JBQWdCLEdBQUcsT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFDO1lBQzVDLE1BQU0sbUJBQW1CLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQztZQUNwRCxNQUFNLG9CQUFvQixHQUFHLE9BQU8sQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLENBQUM7WUFDdEQsTUFBTSxhQUFhLEdBQUcsbUJBQW1CLENBQUM7WUFDMUMsTUFBTSxXQUFXLEdBQUcsT0FBTyxDQUFDLE1BQUEsSUFBSSxDQUFDLFFBQVEsMENBQUUsTUFBTSxDQUFDLENBQUM7WUFDbkQsTUFBTSxPQUFPLEdBQUcsT0FBTyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUNuQyxNQUFNLFlBQVksR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDO1lBRS9CLDhDQUE4QztZQUM5QyxJQUFJLENBQUMsZ0JBQWdCLElBQUksQ0FBQyxhQUFhLElBQUksQ0FBQyxvQkFBb0IsSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDO2dCQUNqRixNQUFNLFlBQVksR0FBRyxTQUFTLElBQUksQ0FBQyxJQUFJLHlFQUF5RSxDQUFDO2dCQUNqSCxJQUFJLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxzQkFBc0IsVUFBVSxZQUFZLElBQUksQ0FBQyxJQUFJLElBQUksRUFBRSxFQUFFLEtBQUssRUFBRSxZQUFZLEVBQUUsQ0FBQyxDQUFDO2dCQUN0RyxNQUFNLElBQUksS0FBSyxDQUFDLFlBQVksQ0FBQyxDQUFDO1lBQ2hDLENBQUM7WUFDRCxJQUFJLGFBQWEsSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDO2dCQUNsQyxNQUFNLFlBQVksR0FBRyxnREFBZ0QsQ0FBQztnQkFDdEUsSUFBSSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsc0JBQXNCLFVBQVUsWUFBWSxJQUFJLENBQUMsSUFBSSxJQUFJLEVBQUUsRUFBRSxLQUFLLEVBQUUsWUFBWSxFQUFFLENBQUMsQ0FBQztnQkFDdEcsTUFBTSxJQUFJLEtBQUssQ0FBQyxZQUFZLENBQUMsQ0FBQztZQUNoQyxDQUFDO1lBQ0QsSUFBSSxvQkFBb0IsSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDO2dCQUN6QyxNQUFNLFlBQVksR0FBRyxpREFBaUQsQ0FBQztnQkFDdkUsSUFBSSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsc0JBQXNCLFVBQVUsWUFBWSxJQUFJLENBQUMsSUFBSSxJQUFJLEVBQUUsRUFBRSxLQUFLLEVBQUUsWUFBWSxFQUFFLENBQUMsQ0FBQztnQkFDdEcsTUFBTSxJQUFJLEtBQUssQ0FBQyxZQUFZLENBQUMsQ0FBQztZQUNoQyxDQUFDO1lBRUQsZ0NBQWdDO1lBQ2hDLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDO2dCQUN0QixJQUFJLGFBQWE7b0JBQUUsT0FBTyxDQUFDLFlBQVksRUFBRSxDQUFDO3FCQUNyQyxJQUFJLFdBQVc7b0JBQUUsT0FBTyxDQUFDLFNBQVMsRUFBRSxDQUFDO1lBQzVDLENBQUM7WUFFRCxNQUFNLE9BQU8sR0FBRyxHQUFHLEVBQUUsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxXQUFXLEdBQUcsSUFBSSxDQUFDLENBQUM7WUFFckQsd0RBQXdEO1lBQ3hELElBQUksb0JBQW9CLEVBQUUsQ0FBQztnQkFDekIsTUFBTSxjQUFjLEdBQUcsSUFBSSxDQUFDLGVBQWUsQ0FBQyxhQUFhLENBQUM7Z0JBQzFELElBQUksQ0FBQyxlQUFlLENBQUMsYUFBYSxHQUFHLElBQUksQ0FBQyxFQUFFLENBQUM7Z0JBRTdDLElBQUksQ0FBQztvQkFDSCxNQUFNLGNBQWMsR0FBRyxNQUFNLElBQUksQ0FBQyxlQUFlLENBQUMsZ0JBQWdCLENBQ2hFLElBQUksRUFDSixTQUFVLEVBQ1YsT0FBTyxFQUNQLFNBQVMsRUFDVCxVQUFVLEVBQ1YsSUFBSSxDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQzVCLElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUMzQixJQUFJLENBQUMsZUFBZSxDQUFDLGFBQWEsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxFQUM3RCxJQUFJLENBQUMsZUFBZSxDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxFQUM1RCxnQkFBZ0IsQ0FDakIsQ0FBQztvQkFFRixJQUFJLE9BQU8sRUFBRSxDQUFDO3dCQUNaLE1BQU0sT0FBTyxHQUFHLE9BQU8sQ0FBQyxVQUFVLENBQUMsVUFBb0IsRUFBRSxJQUFJLENBQUMsSUFBSyxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsSUFBSyxDQUFDLEVBQUUsQ0FBQyxDQUFDO3dCQUN6RixPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsSUFBSyxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsVUFBVSxDQUFDLENBQUM7b0JBQzVFLENBQUM7b0JBQ0QsT0FBTyxjQUFjLENBQUM7Z0JBQ3hCLENBQUM7d0JBQVMsQ0FBQztvQkFDVCxJQUFJLENBQUMsZUFBZSxDQUFDLGFBQWEsR0FBRyxjQUFjLENBQUM7Z0JBQ3RELENBQUM7WUFDSCxDQUFDO1lBRUQsMkVBQTJFO1lBQzNFLElBQUksYUFBYSxFQUFFLENBQUM7Z0JBQ2xCLE1BQU0sYUFBYSxHQUFHLE1BQU0sSUFBSSxDQUFDLGNBQWMsQ0FBQyxnQkFBZ0IsQ0FDOUQsSUFBSSxFQUNKLFNBQVUsRUFDVixPQUFPLEVBQ1AsU0FBUyxFQUNULFVBQVUsRUFDVixJQUFJLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFDNUIsSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQzNCLElBQUksQ0FBQyxlQUFlLENBQUMsYUFBYSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLEVBQzdELElBQUksQ0FBQyxlQUFlLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLEVBQzVELGdCQUFnQixDQUNqQixDQUFDO2dCQUVGLDBFQUEwRTtnQkFDMUUsSUFBSSxPQUFPLElBQUksQ0FBQyxTQUFTLENBQUMsV0FBVyxFQUFFLENBQUM7b0JBQ3RDLE1BQU0sUUFBUSxHQUFHLFlBQWEsQ0FBQztvQkFDL0IsNEVBQTRFO29CQUM1RSx1RkFBdUY7b0JBQ3ZGLE1BQU0sU0FBUyxHQUNiLFFBQVEsQ0FBQyxTQUFTLEtBQUssSUFBSTt3QkFDM0IsQ0FBQyxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsUUFBUSxDQUFDOzRCQUN6QixDQUFDLENBQUEsTUFBQSxRQUFRLENBQUMsUUFBUSwwQ0FBRSxNQUFNLENBQUE7NEJBQzFCLENBQUMsUUFBUSxDQUFDLFNBQVM7NEJBQ25CLENBQUMsUUFBUSxDQUFDLFVBQVU7NEJBQ3BCLENBQUMsUUFBUSxDQUFDLGFBQWEsQ0FBQyxDQUFDO29CQUU3QixJQUFJLFNBQVMsRUFBRSxDQUFDO3dCQUNkLE9BQU8sSUFBSSxDQUFDLG9CQUFvQixDQUFDLE9BQU8sQ0FDdEMsUUFBUSxFQUNSLElBQUksRUFDSixPQUFPLEVBQ1AsU0FBUyxFQUNULFVBQVUsRUFDVixJQUFJLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FDNUIsQ0FBQztvQkFDSixDQUFDO29CQUVELElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxRQUFRLENBQUMsSUFBSSxFQUFFLFFBQVEsQ0FBQyxXQUFXLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztvQkFDakcsTUFBTSxPQUFPLEdBQUcsT0FBTyxDQUFDLFVBQVUsQ0FBQyxVQUFvQixFQUFFLFFBQVEsQ0FBQyxJQUFJLEVBQUUsUUFBUSxDQUFDLEVBQUUsQ0FBQyxDQUFDO29CQUNyRixPQUFPLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxRQUFRLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxVQUFVLENBQUMsQ0FBQztnQkFDMUUsQ0FBQztnQkFFRCxPQUFPLGFBQWEsQ0FBQztZQUN2QixDQUFDO1lBRUQsaURBQWlEO1lBQ2pELElBQUksTUFBQSxJQUFJLENBQUMsTUFBTSwwQ0FBRSxPQUFPLEVBQUUsQ0FBQztnQkFDekIsTUFBTSxNQUFNLEdBQ1YsSUFBSSxDQUFDLE1BQU0sQ0FBQyxNQUFNLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsSUFBSSxLQUFLLENBQUMsTUFBQSxJQUFJLENBQUMsTUFBTSxDQUFDLE1BQU0sbUNBQUksU0FBUyxDQUFDLENBQUM7Z0JBQ3hHLE1BQU0sTUFBTSxDQUFDO1lBQ2YsQ0FBQztZQUVELGdEQUFnRDtZQUNoRCxJQUFJLFdBQTZCLENBQUM7WUFDbEMsSUFBSSxXQUFnRCxDQUFDO1lBRXJELElBQUksU0FBUyxFQUFFLENBQUM7Z0JBQ2QsSUFBSSxDQUFDO29CQUNILFdBQVcsR0FBRyxNQUFNLElBQUksQ0FBQyxZQUFZLENBQUMsSUFBSSxFQUFFLFNBQVMsRUFBRSxPQUFPLEVBQUUsT0FBTyxDQUFDLENBQUM7Z0JBQzNFLENBQUM7Z0JBQUMsT0FBTyxLQUFVLEVBQUUsQ0FBQztvQkFDcEIseUZBQXlGO29CQUN6RixJQUFJLElBQUEsd0JBQWEsRUFBQyxLQUFLLENBQUMsRUFBRSxDQUFDO3dCQUN6QixPQUFPLENBQUMsTUFBTSxFQUFFLENBQUM7d0JBQ2pCLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsRUFBRSxFQUFFLEtBQUssQ0FBQyxTQUFTLEVBQUUsS0FBSyxDQUFDLFdBQVcsRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDO3dCQUMxRyxNQUFNLEtBQUssQ0FBQztvQkFDZCxDQUFDO29CQUNELE9BQU8sQ0FBQyxNQUFNLEVBQUUsQ0FBQztvQkFDakIsSUFBSSxDQUFDLGVBQWUsQ0FBQyxhQUFhLENBQ2hDLElBQUksRUFDSixPQUFPLEVBQ1AsSUFBSSxDQUFDLGVBQWUsQ0FBQyxZQUFZLENBQUMsSUFBSSxFQUFFLFVBQVUsRUFBRSxPQUFPLENBQUMsU0FBUyxDQUFDLEVBQ3RFLFNBQVMsRUFDVCxFQUFFLElBQUksRUFBRSxxQkFBcUIsRUFBRSxPQUFPLEVBQUUsS0FBSyxDQUFDLFFBQVEsRUFBRSxFQUFFLENBQzNELENBQUM7b0JBQ0YsSUFBSSxDQUFDLGtCQUFrQixDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxLQUFLLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztvQkFDdEYsSUFBSSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsc0JBQXNCLFVBQVUsWUFBWSxJQUFJLENBQUMsSUFBSSxJQUFJLEVBQUUsRUFBRSxLQUFLLEVBQUUsQ0FBQyxDQUFDO29CQUN4RixPQUFPLENBQUMsUUFBUSxDQUFDLHFCQUFxQixFQUFFLEtBQUssQ0FBQyxRQUFRLEVBQUUsQ0FBQyxDQUFDO29CQUMxRCxNQUFNLEtBQUssQ0FBQztnQkFDZCxDQUFDO2dCQUNELE9BQU8sQ0FBQyxNQUFNLEVBQUUsQ0FBQztnQkFDakIsSUFBSSxDQUFDLGVBQWUsQ0FBQyxhQUFhLENBQ2hDLElBQUksRUFDSixPQUFPLEVBQ1AsSUFBSSxDQUFDLGVBQWUsQ0FBQyxZQUFZLENBQUMsSUFBSSxFQUFFLFVBQVUsRUFBRSxPQUFPLENBQUMsU0FBUyxDQUFDLEVBQ3RFLFdBQVcsQ0FDWixDQUFDO2dCQUNGLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxlQUFlLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsV0FBVyxFQUFFLGdCQUFnQixDQUFDLENBQUM7Z0JBRXZGLElBQUksU0FBUyxDQUFDLFdBQVcsRUFBRSxDQUFDO29CQUMxQixJQUFJLENBQUMsa0JBQWtCLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztvQkFDN0QsSUFBSSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsa0NBQWtDLFVBQVUsV0FBVyxJQUFJLENBQUMsSUFBSSwwQkFBMEIsQ0FBQyxDQUFDO29CQUM3RyxPQUFPLFdBQVcsQ0FBQztnQkFDckIsQ0FBQztnQkFFRCx3REFBd0Q7Z0JBQ3hELElBQUksV0FBVyxJQUFJLE9BQU8sV0FBVyxLQUFLLFFBQVEsSUFBSSxJQUFBLGdDQUFpQixFQUFDLFdBQVcsQ0FBQyxFQUFFLENBQUM7b0JBQ3JGLE1BQU0sV0FBVyxHQUFHLFdBQXNDLENBQUM7b0JBQzNELE9BQU8sQ0FBQyxNQUFNLENBQUMsV0FBVyxFQUFFLElBQUksQ0FBQyxDQUFDO29CQUNsQyxPQUFPLENBQUMsTUFBTSxDQUFDLGdCQUFnQixFQUFFLGlCQUFpQixDQUFDLENBQUM7b0JBRXBELG9DQUFvQztvQkFDcEMsSUFBSSxXQUFXLENBQUMsYUFBYSxJQUFJLFdBQVcsQ0FBQyxVQUFVLElBQUksV0FBVyxDQUFDLFNBQVMsRUFBRSxDQUFDO3dCQUNqRixPQUFPLENBQUMsTUFBTSxDQUFDLGdCQUFnQixFQUFFLGdCQUFnQixDQUFDLENBQUM7d0JBQ25ELE9BQU8sQ0FBQyxNQUFNLENBQUMsa0JBQWtCLEVBQUUsV0FBVyxDQUFDLFNBQVMsQ0FBQyxDQUFDO3dCQUUxRCwwRUFBMEU7d0JBQzFFLHVFQUF1RTt3QkFDdkUsNkRBQTZEO3dCQUM3RCxJQUFJLENBQUMsV0FBVyxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsQ0FBQzs0QkFDakMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxnQkFBZ0IsRUFBRSxtQkFBbUIsQ0FBQyxDQUFDOzRCQUN0RCxJQUFJLENBQUMsYUFBYSxHQUFHLElBQUksQ0FBQzs0QkFDMUIsSUFBSSxDQUFDLFNBQVMsR0FBRyxXQUFXLENBQUMsU0FBUyxDQUFDOzRCQUN2QyxJQUFJLENBQUMsV0FBVyxHQUFHLFdBQVcsQ0FBQyxXQUFXLENBQUM7NEJBQzNDLElBQUksQ0FBQyxXQUFXLEdBQUcsTUFBQSxXQUFXLENBQUMsV0FBVyxtQ0FBSSxJQUFJLENBQUMsV0FBVyxDQUFDOzRCQUUvRCxJQUFJLENBQUMsZ0JBQWdCLENBQUMsb0JBQW9CLENBQ3hDLElBQUksQ0FBQyxFQUFFLEVBQ1AsV0FBVyxDQUFDLFNBQVUsRUFDdEIsV0FBVyxDQUFDLFdBQVcsRUFDdkIsV0FBVyxDQUFDLFVBQVUsQ0FBQyxrQkFBa0IsQ0FDMUMsQ0FBQzs0QkFFRix1RUFBdUU7d0JBQ3pFLENBQUM7NkJBQU0sQ0FBQzs0QkFDTiwyQ0FBMkM7NEJBQzNDLElBQUksQ0FBQyxzQkFBc0IsQ0FBQyxXQUFXLENBQUMsU0FBUyxFQUFFLFdBQVcsQ0FBQyxVQUFVLEVBQUUsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDOzRCQUVwRixJQUFJLENBQUMsYUFBYSxHQUFHLElBQUksQ0FBQzs0QkFDMUIsSUFBSSxDQUFDLFNBQVMsR0FBRyxXQUFXLENBQUMsU0FBUyxDQUFDOzRCQUN2QyxJQUFJLENBQUMsV0FBVyxHQUFHLFdBQVcsQ0FBQyxXQUFXLENBQUM7NEJBQzNDLElBQUksQ0FBQyxtQkFBbUIsR0FBRyxXQUFXLENBQUMsbUJBQW1CLENBQUM7NEJBRTNELElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxvQkFBb0IsQ0FDeEMsSUFBSSxDQUFDLEVBQUUsRUFDUCxXQUFXLENBQUMsU0FBVSxFQUN0QixXQUFXLENBQUMsV0FBVyxFQUN2QixNQUFBLFdBQVcsQ0FBQyxVQUFVLDBDQUFFLGtCQUFrQixDQUMzQyxDQUFDOzRCQUVGLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLElBQUksRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFVBQVUsQ0FBQyxDQUFDO3dCQUN0RSxDQUFDO29CQUNILENBQUM7b0JBRUQsZ0NBQWdDO29CQUNoQyxJQUFJLFdBQVcsQ0FBQyxRQUFRLEVBQUUsQ0FBQzt3QkFDekIsS0FBSyxNQUFNLEtBQUssSUFBSSxXQUFXLENBQUMsUUFBUSxFQUFFLENBQUM7NEJBQ3pDLElBQUksS0FBSyxDQUFDLGFBQWEsSUFBSSxLQUFLLENBQUMsVUFBVSxJQUFJLEtBQUssQ0FBQyxTQUFTLEVBQUUsQ0FBQztnQ0FDL0QsSUFBSSxDQUFDLHNCQUFzQixDQUFDLEtBQUssQ0FBQyxTQUFTLEVBQUUsS0FBSyxDQUFDLFVBQVUsRUFBRSxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUM7Z0NBQ3pFLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxvQkFBb0IsQ0FDeEMsS0FBSyxDQUFDLEVBQUUsRUFDUixLQUFLLENBQUMsU0FBVSxFQUNoQixLQUFLLENBQUMsV0FBVyxFQUNqQixNQUFBLEtBQUssQ0FBQyxVQUFVLDBDQUFFLGtCQUFrQixDQUNyQyxDQUFDOzRCQUNKLENBQUM7d0JBQ0gsQ0FBQztvQkFDSCxDQUFDO29CQUVELGtDQUFrQztvQkFDbEMsSUFBSSxXQUFXLENBQUMsUUFBUSxJQUFJLFdBQVcsQ0FBQyxRQUFRLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO3dCQUM1RCxJQUFJLENBQUMsUUFBUSxHQUFHLFdBQVcsQ0FBQyxRQUFRLENBQUM7d0JBQ3JDLE9BQU8sQ0FBQyxNQUFNLENBQUMsbUJBQW1CLEVBQUUsV0FBVyxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQzt3QkFDakUsT0FBTyxDQUFDLE1BQU0sQ0FDWixpQkFBaUIsRUFDakIsV0FBVyxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FDdEMsQ0FBQzt3QkFFRixJQUFJLENBQUMsZ0JBQWdCLENBQUMscUJBQXFCLENBQ3pDLElBQUksQ0FBQyxFQUFFLEVBQ1AsV0FBVyxDQUFDLFFBQVEsRUFDcEIsT0FBTyxDQUFDLFdBQVcsQ0FBQyxnQkFBZ0IsQ0FBQyxFQUNyQyxPQUFPLENBQUMsV0FBVyxDQUFDLFNBQVMsQ0FBQyxDQUMvQixDQUFDO3dCQUVGLElBQUksT0FBTyxXQUFXLENBQUMsZ0JBQWdCLEtBQUssVUFBVSxFQUFFLENBQUM7NEJBQ3ZELElBQUksQ0FBQyxnQkFBZ0IsR0FBRyxXQUFXLENBQUMsZ0JBQWdCLENBQUM7NEJBQ3JELE9BQU8sQ0FBQyxNQUFNLENBQUMsYUFBYSxFQUFFLElBQUksQ0FBQyxDQUFDO3dCQUN0QyxDQUFDO29CQUNILENBQUM7b0JBRUQscUNBQXFDO29CQUNyQyxJQUFJLFdBQVcsQ0FBQyxJQUFJLEVBQUUsQ0FBQzt3QkFDckIsV0FBVyxHQUFHLFdBQVcsQ0FBQyxJQUFJLENBQUM7d0JBQy9CLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxpQkFBaUIsQ0FBQyxJQUFJLENBQUMsRUFBRSxFQUFFLFdBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQzt3QkFDbkUsSUFBSSxDQUFDLElBQUksR0FBRyxXQUFXLENBQUMsSUFBSSxDQUFDO3dCQUM3QixPQUFPLENBQUMsTUFBTSxDQUFDLGdCQUFnQixFQUFFLElBQUksQ0FBQyxDQUFDO29CQUN6QyxDQUFDO29CQUVELFdBQVcsR0FBRyxTQUFTLENBQUM7Z0JBQzFCLENBQUM7Z0JBRUQsaUVBQWlFO2dCQUNqRSxJQUFJLFdBQVcsRUFBRSxDQUFDO29CQUNoQixJQUFJLENBQUMsSUFBSSxHQUFHLFlBQVksQ0FBQztnQkFDM0IsQ0FBQztZQUNILENBQUM7WUFFRCw0Q0FBNEM7WUFDNUMsTUFBTSxxQkFBcUIsR0FBRyxPQUFPLENBQUMsTUFBQSxJQUFJLENBQUMsUUFBUSwwQ0FBRSxNQUFNLENBQUMsQ0FBQztZQUU3RCxJQUFJLHFCQUFxQixFQUFFLENBQUM7Z0JBQzFCLE9BQU8sQ0FBQyxNQUFNLENBQUMsZUFBZSxFQUFFLE1BQUEsSUFBSSxDQUFDLFFBQVEsMENBQUUsTUFBTSxDQUFDLENBQUM7Z0JBQ3ZELE9BQU8sQ0FBQyxNQUFNLENBQUMsa0JBQWtCLEVBQUUsb0JBQW9CLENBQUMsQ0FBQztnQkFFekQsSUFBSSxtQkFBbUQsQ0FBQztnQkFFeEQsSUFBSSxJQUFJLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQztvQkFDMUIsTUFBTSxjQUFjLEdBQUcsSUFBSSxDQUFDLGVBQWUsQ0FBQyxhQUFhLENBQUM7b0JBQzFELElBQUksQ0FBQyxlQUFlLENBQUMsYUFBYSxHQUFHLElBQUksQ0FBQyxFQUFFLENBQUM7b0JBQzdDLElBQUksQ0FBQzt3QkFDSCxtQkFBbUIsR0FBRyxNQUFNLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyx1QkFBdUIsQ0FDdkUsSUFBSSxDQUFDLGdCQUFnQixFQUNyQixJQUFJLENBQUMsUUFBUyxFQUNkLFdBQVcsRUFDWCxPQUFPLEVBQ1AsVUFBb0IsRUFDcEIsZ0JBQWdCLENBQ2pCLENBQUM7b0JBQ0osQ0FBQzs0QkFBUyxDQUFDO3dCQUNULElBQUksQ0FBQyxlQUFlLENBQUMsYUFBYSxHQUFHLGNBQWMsQ0FBQztvQkFDdEQsQ0FBQztnQkFDSCxDQUFDO3FCQUFNLENBQUM7b0JBQ04sTUFBTSxVQUFVLEdBQUcsTUFBQSxNQUFBLElBQUksQ0FBQyxRQUFRLDBDQUFFLE1BQU0sbUNBQUksQ0FBQyxDQUFDO29CQUM5QyxNQUFNLFVBQVUsR0FBRyxNQUFBLElBQUksQ0FBQyxRQUFRLDBDQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7b0JBQ2hFLE9BQU8sQ0FBQyxtQkFBbUIsQ0FBQyxVQUFVLEVBQUUsaUJBQWlCLFVBQVUsMEJBQTBCLFVBQVUsRUFBRSxFQUFFO3dCQUN6RyxLQUFLLEVBQUUsVUFBVTt3QkFDakIsV0FBVyxFQUFFLE1BQUEsSUFBSSxDQUFDLFFBQVEsMENBQUUsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO3FCQUMvQyxDQUFDLENBQUM7b0JBRUgsTUFBTSxjQUFjLEdBQUcsSUFBSSxDQUFDLGVBQWUsQ0FBQyxhQUFhLENBQUM7b0JBQzFELElBQUksQ0FBQyxlQUFlLENBQUMsYUFBYSxHQUFHLElBQUksQ0FBQyxFQUFFLENBQUM7b0JBQzdDLElBQUksQ0FBQzt3QkFDSCxtQkFBbUIsR0FBRyxNQUFNLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxtQkFBbUIsQ0FDbkUsSUFBSSxFQUNKLE9BQU8sRUFDUCxTQUFTLEVBQ1QsVUFBVSxFQUNWLGdCQUFnQixDQUNqQixDQUFDO29CQUNKLENBQUM7NEJBQVMsQ0FBQzt3QkFDVCxJQUFJLENBQUMsZUFBZSxDQUFDLGFBQWEsR0FBRyxjQUFjLENBQUM7b0JBQ3RELENBQUM7Z0JBQ0gsQ0FBQztnQkFFRCwyQkFBMkI7Z0JBQzNCLElBQUksQ0FBQyxPQUFPLElBQUksQ0FBQyxXQUFXLEVBQUUsQ0FBQztvQkFDN0IsT0FBTyxtQkFBb0IsQ0FBQztnQkFDOUIsQ0FBQztnQkFFRCw4REFBOEQ7Z0JBQzlELE1BQU0sU0FBUyxHQUFHLE1BQUEsTUFBQSxPQUFPLENBQUMsS0FBSywwQ0FBRSxVQUFVLDBDQUFFLFNBQVMsQ0FBQztnQkFDdkQsSUFBSSxTQUFTLElBQUksSUFBSSxDQUFDLFFBQVEsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQztvQkFDM0QsSUFBSSxDQUFDLDRCQUE0QixDQUFDLElBQUksRUFBRSxPQUFPLENBQUMsQ0FBQztnQkFDbkQsQ0FBQztZQUNILENBQUM7WUFFRCx5REFBeUQ7WUFDekQsSUFBSSxXQUFXLEVBQUUsQ0FBQztnQkFDaEIsT0FBTyxJQUFJLENBQUMsb0JBQW9CLENBQUMsT0FBTyxDQUN0QyxXQUFXLEVBQ1gsSUFBSSxFQUNKLE9BQU8sRUFDUCxTQUFTLEVBQ1QsVUFBVSxFQUNWLElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUM1QixDQUFDO1lBQ0osQ0FBQztZQUVELElBQUksT0FBTyxFQUFFLENBQUM7Z0JBQ1osTUFBTSxRQUFRLEdBQUcsWUFBYSxDQUFDO2dCQUUvQixnRkFBZ0Y7Z0JBQ2hGLHlFQUF5RTtnQkFDekUsc0NBQXNDO2dCQUN0QyxNQUFNLGVBQWUsR0FBRyxRQUFRLENBQUMsU0FBUyxDQUFDO2dCQUUzQyxJQUFJLGVBQWUsRUFBRSxDQUFDO29CQUNwQixPQUFPLElBQUksQ0FBQyxvQkFBb0IsQ0FBQyxPQUFPLENBQ3RDLFFBQVEsRUFDUixJQUFJLEVBQ0osT0FBTyxFQUNQLFNBQVMsRUFDVCxVQUFVLEVBQ1YsSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQzNCLGdCQUFnQixDQUNqQixDQUFDO2dCQUNKLENBQUM7Z0JBRUQsSUFBSSxDQUFDLGtCQUFrQixDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLFFBQVEsQ0FBQyxJQUFJLEVBQUUsUUFBUSxDQUFDLFdBQVcsRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDO2dCQUNqRyxPQUFPLENBQUMsbUJBQW1CLENBQUMsTUFBTSxFQUFFLGFBQWEsUUFBUSxDQUFDLElBQUksUUFBUSxFQUFFO29CQUN0RSxXQUFXLEVBQUUsUUFBUSxDQUFDLElBQUk7aUJBQzNCLENBQUMsQ0FBQztnQkFDSCxNQUFNLE9BQU8sR0FBRyxPQUFPLENBQUMsVUFBVSxDQUFDLFVBQW9CLEVBQUUsUUFBUSxDQUFDLElBQUksRUFBRSxRQUFRLENBQUMsRUFBRSxDQUFDLENBQUM7Z0JBQ3JGLE9BQU8sTUFBTSxJQUFJLENBQUMsV0FBVyxDQUFDLFFBQVEsRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFVBQVUsQ0FBQyxDQUFDO1lBQzFFLENBQUM7WUFFRCwwQ0FBMEM7WUFDMUMsT0FBTyxXQUFXLENBQUM7UUFDckIsQ0FBQztnQkFBUyxDQUFDO1lBQ1QsSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDO1FBQ3ZCLENBQUM7SUFDSCxDQUFDO0lBRUQsa0VBQWtFO0lBRTFELDRCQUE0QixDQUFDLElBQTZCLEVBQUUsT0FBcUI7UUFDdkYsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLFVBQVUsRUFBRSxDQUFDO1FBRTNDLE1BQU0sY0FBYyxHQUFRO1lBQzFCLEVBQUUsRUFBRSxHQUFHLElBQUksQ0FBQyxFQUFFLFdBQVc7WUFDekIsSUFBSSxFQUFFLGtCQUFrQjtZQUN4QixJQUFJLEVBQUUsTUFBTTtZQUNaLFFBQVEsRUFBRSxJQUFJLENBQUMsUUFBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQztnQkFDbkMsRUFBRSxFQUFFLENBQUMsQ0FBQyxFQUFFO2dCQUNSLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSTtnQkFDWixJQUFJLEVBQUUsT0FBTzthQUNkLENBQUMsQ0FBQztTQUNKLENBQUM7UUFFRixNQUFNLFdBQVcsR0FBNEIsRUFBRSxDQUFDO1FBQ2hELElBQUksT0FBTyxDQUFDLFFBQVEsRUFBRSxDQUFDO1lBQ3JCLEtBQUssTUFBTSxRQUFRLElBQUksT0FBTyxDQUFDLFFBQVEsRUFBRSxDQUFDO2dCQUN4QyxNQUFNLFFBQVEsR0FBRyxRQUFRLENBQUMsV0FBVyxFQUFFLENBQUM7Z0JBQ3hDLFdBQVcsQ0FBQyxRQUFRLENBQUMsSUFBSSxJQUFJLFFBQVEsQ0FBQyxFQUFFLENBQUMsR0FBRztvQkFDMUMsSUFBSSxFQUFFLFFBQVEsQ0FBQyxJQUFJO29CQUNuQixNQUFNLEVBQUUsUUFBUSxDQUFDLElBQUk7b0JBQ3JCLE1BQU0sRUFBRSxRQUFRLENBQUMsTUFBTTtvQkFDdkIsT0FBTyxFQUFFLFFBQVEsQ0FBQyxPQUFPO29CQUN6QixNQUFNLEVBQUUsUUFBUSxDQUFDLE1BQU0sSUFBSSxNQUFNLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLFNBQVM7aUJBQ3pGLENBQUM7WUFDSixDQUFDO1FBQ0gsQ0FBQztRQUVELElBQUksQ0FBQyxjQUFjLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLEVBQUU7WUFDL0IsU0FBUyxFQUFFLElBQUksQ0FBQyxFQUFFO1lBQ2xCLFdBQVcsRUFBRSxJQUFJLENBQUMsSUFBSTtZQUN0QixXQUFXLEVBQUU7Z0JBQ1gsYUFBYSxFQUFFLEVBQUU7Z0JBQ2pCLGFBQWEsRUFBRSxXQUFpRDtnQkFDaEUsT0FBTyxFQUFFLEVBQUU7YUFDWjtZQUNELGFBQWE7WUFDYixpQkFBaUIsRUFBRSxjQUFjO1NBQ2xDLENBQUMsQ0FBQztJQUNMLENBQUM7SUFFTyxtQkFBbUIsQ0FBQyxPQUFxQjtRQUMvQyxJQUFJLEtBQUssR0FBRyxDQUFDLENBQUM7UUFDZCxJQUFJLE9BQU8sR0FBRyxPQUFPLENBQUMsTUFBTSxDQUFDO1FBQzdCLE9BQU8sT0FBTyxFQUFFLENBQUM7WUFDZixLQUFLLEVBQUUsQ0FBQztZQUNSLE9BQU8sR0FBRyxPQUFPLENBQUMsTUFBTSxDQUFDO1FBQzNCLENBQUM7UUFDRCxPQUFPLEtBQUssQ0FBQztJQUNmLENBQUM7SUFFTyxjQUFjLENBQUMsSUFBNkIsRUFBRSxNQUFjO1FBQ2xFLElBQUksQ0FBQyxJQUFJO1lBQUUsT0FBTyxJQUFJLENBQUM7UUFDdkIsTUFBTSxLQUFLLEdBQTRCLEVBQUUsR0FBRyxJQUFJLEVBQUUsQ0FBQztRQUNuRCxLQUFLLENBQUMsSUFBSSxHQUFHLEdBQUcsTUFBTSxJQUFJLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUN0QyxLQUFLLENBQUMsRUFBRSxHQUFHLEdBQUcsTUFBTSxJQUFJLEtBQUssQ0FBQyxFQUFFLEVBQUUsQ0FBQztRQUNuQyxJQUFJLEtBQUssQ0FBQyxTQUFTO1lBQUUsS0FBSyxDQUFDLFNBQVMsR0FBRyxHQUFHLE1BQU0sSUFBSSxLQUFLLENBQUMsU0FBUyxFQUFFLENBQUM7UUFDdEUsSUFBSSxLQUFLLENBQUMsSUFBSTtZQUFFLEtBQUssQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDLGNBQWMsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQyxDQUFDO1FBQ3JFLElBQUksS0FBSyxDQUFDLFFBQVEsRUFBRSxDQUFDO1lBQ25CLEtBQUssQ0FBQyxRQUFRLEdBQUcsS0FBSyxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLElBQUksQ0FBQyxjQUFjLENBQUMsQ0FBQyxFQUFFLE1BQU0sQ0FBQyxDQUFDLENBQUM7UUFDN0UsQ0FBQztRQUNELE9BQU8sS0FBSyxDQUFDO0lBQ2YsQ0FBQztJQUVPLHNCQUFzQixDQUM1QixTQUFpQixFQUNqQixVQUFnRCxFQUNoRCxXQUFvQjs7UUFFcEIsK0ZBQStGO1FBQy9GLE1BQU0sWUFBWSxHQUFHLElBQUksQ0FBQyxRQUFRLENBQUM7UUFFbkMsbUJBQW1CO1FBQ25CLE1BQU0saUJBQWlCLEdBQUcsQ0FBQyxZQUFZLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDbkQsSUFBSSxpQkFBaUIsSUFBSSxVQUFVLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDekMsWUFBWSxDQUFDLFNBQVMsQ0FBQyxHQUFHO2dCQUN4QixJQUFJLEVBQUUsVUFBVSxDQUFDLElBQStCO2dCQUNoRCxHQUFHLENBQUMsVUFBVSxDQUFDLGtCQUFrQixDQUFDLENBQUMsQ0FBQyxFQUFFLGtCQUFrQixFQUFFLFVBQVUsQ0FBQyxrQkFBa0IsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7YUFDekYsQ0FBQztRQUNYLENBQUM7UUFFRCxvREFBb0Q7UUFDcEQsSUFBSSxVQUFVLENBQUMsUUFBUSxFQUFFLENBQUM7WUFDeEIsS0FBSyxNQUFNLENBQUMsR0FBRyxFQUFFLEVBQUUsQ0FBQyxJQUFJLEtBQUssQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLFFBQVEsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxFQUFFLENBQUM7Z0JBQ2xFLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO29CQUM1QixJQUFJLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsRUFBaUMsQ0FBQyxDQUFDO2dCQUM1RCxDQUFDO1lBQ0gsQ0FBQztRQUNILENBQUM7UUFFRCx3QkFBd0I7UUFDeEIsSUFBSSxVQUFVLENBQUMsUUFBUSxFQUFFLENBQUM7WUFDeEIsS0FBSyxNQUFNLENBQUMsR0FBRyxFQUFFLEdBQUcsQ0FBQyxJQUFJLE1BQU0sQ0FBQyxPQUFPLENBQUMsVUFBVSxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUM7Z0JBQzdELElBQUksQ0FBQyxZQUFZLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztvQkFDdkIsWUFBWSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEdBQXdDLENBQUM7Z0JBQy9ELENBQUM7WUFDSCxDQUFDO1FBQ0gsQ0FBQztRQUVELElBQUksV0FBVyxFQUFFLENBQUM7WUFDaEIsSUFBSSxDQUFDLGdCQUFnQixDQUFDLG9CQUFvQixDQUN4QyxXQUFXLEVBQ1gsU0FBUyxFQUNULENBQUEsTUFBQSxVQUFVLENBQUMsSUFBSSwwQ0FBRSxXQUFXLE1BQUksTUFBQSxVQUFVLENBQUMsSUFBSSwwQ0FBRSxJQUFJLENBQUEsRUFDckQsVUFBVSxDQUFDLGtCQUFrQixDQUM5QixDQUFDO1FBQ0osQ0FBQztRQUVELDZFQUE2RTtRQUM3RSxJQUFJLGlCQUFpQixFQUFFLENBQUM7WUFDdEIsTUFBTSxXQUFXLEdBQUcsQ0FBQSxNQUFBLFVBQVUsQ0FBQyxJQUFJLDBDQUFFLFdBQVcsTUFBSSxNQUFBLFVBQVUsQ0FBQyxJQUFJLDBDQUFFLElBQUksQ0FBQSxJQUFJLFNBQVMsQ0FBQztZQUN2RixJQUFJLENBQUMsa0JBQWtCLENBQUMsbUJBQW1CLENBQ3pDLFNBQVMsRUFDVCxXQUFXLEVBQ1gsTUFBQSxVQUFVLENBQUMsSUFBSSwwQ0FBRSxXQUFXLEVBQzVCLFVBQVUsQ0FBQyxrQkFBa0IsQ0FDOUIsQ0FBQztRQUNKLENBQUM7SUFDSCxDQUFDOztBQTczQkgsZ0RBODNCQztBQWoxQkM7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBaUJHO0FBQ2Esb0NBQWlCLEdBQUcsR0FBRyxBQUFOLENBQU8iLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEZsb3djaGFydFRyYXZlcnNlciDigJQgUHJlLW9yZGVyIERGUyB0cmF2ZXJzYWwgb2YgU3RhZ2VOb2RlIGdyYXBoLlxuICpcbiAqIFVuaWZpZWQgdHJhdmVyc2FsIGFsZ29yaXRobSBmb3IgYWxsIG5vZGUgc2hhcGVzOlxuICogICBjb25zdCBwcmUgPSBhd2FpdCBwcmVwKCk7XG4gKiAgIGNvbnN0IFt4LCB5XSA9IGF3YWl0IFByb21pc2UuYWxsKFtmeChwcmUpLCBmeShwcmUpXSk7XG4gKiAgIHJldHVybiBhd2FpdCBuZXh0KHgsIHkpO1xuICpcbiAqIEZvciBlYWNoIG5vZGUsIGV4ZWN1dGVOb2RlIGZvbGxvd3MgNyBwaGFzZXM6XG4gKiAgIDAuIENMQVNTSUZZICDigJQgc3ViZmxvdyBkZXRlY3Rpb24sIGVhcmx5IGRlbGVnYXRpb25cbiAqICAgMS4gVkFMSURBVEUgIOKAlCBub2RlIGludmFyaWFudHMsIHJvbGUgbWFya2Vyc1xuICogICAyLiBFWEVDVVRFICAg4oCUIHJ1biBzdGFnZSBmbiwgY29tbWl0LCBicmVhayBjaGVja1xuICogICAzLiBEWU5BTUlDICAg4oCUIFN0YWdlTm9kZSByZXR1cm4gZGV0ZWN0aW9uLCBzdWJmbG93IGF1dG8tcmVnaXN0cmF0aW9uLCBzdHJ1Y3R1cmUgdXBkYXRlc1xuICogICA0LiBDSElMRFJFTiAg4oCUIGZvcmsvc2VsZWN0b3IvZGVjaWRlciBkaXNwYXRjaFxuICogICA1LiBDT05USU5VRSAg4oCUIGR5bmFtaWMgbmV4dCAvIGxpbmVhciBuZXh0IHJlc29sdXRpb25cbiAqICAgNi4gTEVBRiAgICAgIOKAlCBubyBjb250aW51YXRpb24sIHJldHVybiBvdXRwdXRcbiAqXG4gKiBCcmVhayBzZW1hbnRpY3M6IElmIGEgc3RhZ2UgY2FsbHMgYnJlYWtGbigpLCBjb21taXQgYW5kIFNUT1AuXG4gKiBQYXRjaCBtb2RlbDogU3RhZ2Ugd3JpdGVzIGludG8gbG9jYWwgcGF0Y2g7IGNvbW1pdFBhdGNoKCkgYWZ0ZXIgcmV0dXJuIG9yIHRocm93LlxuICovXG5cbmltcG9ydCB0eXBlIHsgU3RhZ2VDb250ZXh0IH0gZnJvbSAnLi4vLi4vbWVtb3J5L1N0YWdlQ29udGV4dC5qcyc7XG5pbXBvcnQgeyBpc1BhdXNlU2lnbmFsIH0gZnJvbSAnLi4vLi4vcGF1c2UvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBTY29wZVByb3RlY3Rpb25Nb2RlIH0gZnJvbSAnLi4vLi4vc2NvcGUvcHJvdGVjdGlvbi90eXBlcy5qcyc7XG5pbXBvcnQgeyBpc1N0YWdlTm9kZVJldHVybiB9IGZyb20gJy4uL2dyYXBoL1N0YWdlTm9kZS5qcyc7XG5pbXBvcnQgeyBDaGlsZHJlbkV4ZWN1dG9yIH0gZnJvbSAnLi4vaGFuZGxlcnMvQ2hpbGRyZW5FeGVjdXRvci5qcyc7XG5pbXBvcnQgeyBDb250aW51YXRpb25SZXNvbHZlciB9IGZyb20gJy4uL2hhbmRsZXJzL0NvbnRpbnVhdGlvblJlc29sdmVyLmpzJztcbmltcG9ydCB7IERlY2lkZXJIYW5kbGVyIH0gZnJvbSAnLi4vaGFuZGxlcnMvRGVjaWRlckhhbmRsZXIuanMnO1xuaW1wb3J0IHsgRXh0cmFjdG9yUnVubmVyIH0gZnJvbSAnLi4vaGFuZGxlcnMvRXh0cmFjdG9yUnVubmVyLmpzJztcbmltcG9ydCB7IE5vZGVSZXNvbHZlciB9IGZyb20gJy4uL2hhbmRsZXJzL05vZGVSZXNvbHZlci5qcyc7XG5pbXBvcnQgeyBSdW50aW1lU3RydWN0dXJlTWFuYWdlciB9IGZyb20gJy4uL2hhbmRsZXJzL1J1bnRpbWVTdHJ1Y3R1cmVNYW5hZ2VyLmpzJztcbmltcG9ydCB7IFNlbGVjdG9ySGFuZGxlciB9IGZyb20gJy4uL2hhbmRsZXJzL1NlbGVjdG9ySGFuZGxlci5qcyc7XG5pbXBvcnQgeyBTdGFnZVJ1bm5lciB9IGZyb20gJy4uL2hhbmRsZXJzL1N0YWdlUnVubmVyLmpzJztcbmltcG9ydCB7IFN1YmZsb3dFeGVjdXRvciB9IGZyb20gJy4uL2hhbmRsZXJzL1N1YmZsb3dFeGVjdXRvci5qcyc7XG5pbXBvcnQgeyBGbG93UmVjb3JkZXJEaXNwYXRjaGVyIH0gZnJvbSAnLi4vbmFycmF0aXZlL0Zsb3dSZWNvcmRlckRpc3BhdGNoZXIuanMnO1xuaW1wb3J0IHsgTmFycmF0aXZlRmxvd1JlY29yZGVyIH0gZnJvbSAnLi4vbmFycmF0aXZlL05hcnJhdGl2ZUZsb3dSZWNvcmRlci5qcyc7XG5pbXBvcnQgeyBOdWxsQ29udHJvbEZsb3dOYXJyYXRpdmVHZW5lcmF0b3IgfSBmcm9tICcuLi9uYXJyYXRpdmUvTnVsbENvbnRyb2xGbG93TmFycmF0aXZlR2VuZXJhdG9yLmpzJztcbmltcG9ydCB0eXBlIHsgRmxvd1JlY29yZGVyLCBJQ29udHJvbEZsb3dOYXJyYXRpdmUsIFRyYXZlcnNhbENvbnRleHQgfSBmcm9tICcuLi9uYXJyYXRpdmUvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUge1xuICBFeHRyYWN0b3JFcnJvcixcbiAgSGFuZGxlckRlcHMsXG4gIElFeGVjdXRpb25SdW50aW1lLFxuICBJTG9nZ2VyLFxuICBOb2RlUmVzdWx0VHlwZSxcbiAgU2NvcGVGYWN0b3J5LFxuICBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUsXG4gIFN0YWdlRnVuY3Rpb24sXG4gIFN0YWdlTm9kZSxcbiAgU3RyZWFtSGFuZGxlcnMsXG4gIFN1YmZsb3dSZXN1bHQsXG4gIFN1YmZsb3dUcmF2ZXJzZXJGYWN0b3J5LFxuICBUcmF2ZXJzYWxFeHRyYWN0b3IsXG4gIFRyYXZlcnNhbFJlc3VsdCxcbn0gZnJvbSAnLi4vdHlwZXMuanMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIFRyYXZlcnNlck9wdGlvbnM8VE91dCA9IGFueSwgVFNjb3BlID0gYW55PiB7XG4gIHJvb3Q6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+O1xuICBzdGFnZU1hcDogTWFwPHN0cmluZywgU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+PjtcbiAgc2NvcGVGYWN0b3J5OiBTY29wZUZhY3Rvcnk8VFNjb3BlPjtcbiAgZXhlY3V0aW9uUnVudGltZTogSUV4ZWN1dGlvblJ1bnRpbWU7XG4gIHJlYWRPbmx5Q29udGV4dD86IHVua25vd247XG4gIC8qKiBFeGVjdXRpb24gZW52aXJvbm1lbnQg4oCUIHByb3BhZ2F0ZXMgdG8gc3ViZmxvd3MgYXV0b21hdGljYWxseS4gKi9cbiAgZXhlY3V0aW9uRW52PzogaW1wb3J0KCcuLi8uLi9lbmdpbmUvdHlwZXMnKS5FeGVjdXRpb25FbnY7XG4gIHRocm90dGxpbmdFcnJvckNoZWNrZXI/OiAoZXJyb3I6IHVua25vd24pID0+IGJvb2xlYW47XG4gIHN0cmVhbUhhbmRsZXJzPzogU3RyZWFtSGFuZGxlcnM7XG4gIGV4dHJhY3Rvcj86IFRyYXZlcnNhbEV4dHJhY3RvcjtcbiAgc2NvcGVQcm90ZWN0aW9uTW9kZT86IFNjb3BlUHJvdGVjdGlvbk1vZGU7XG4gIHN1YmZsb3dzPzogUmVjb3JkPHN0cmluZywgeyByb290OiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiB9PjtcbiAgZW5yaWNoU25hcHNob3RzPzogYm9vbGVhbjtcbiAgbmFycmF0aXZlRW5hYmxlZD86IGJvb2xlYW47XG4gIGJ1aWxkVGltZVN0cnVjdHVyZT86IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZTtcbiAgbG9nZ2VyOiBJTG9nZ2VyO1xuICBzaWduYWw/OiBBYm9ydFNpZ25hbDtcbiAgLyoqIFByZS1jb25maWd1cmVkIEZsb3dSZWNvcmRlcnMgdG8gYXR0YWNoIHdoZW4gbmFycmF0aXZlIGlzIGVuYWJsZWQuICovXG4gIGZsb3dSZWNvcmRlcnM/OiBGbG93UmVjb3JkZXJbXTtcbiAgLyoqXG4gICAqIFByZS1jb25maWd1cmVkIG5hcnJhdGl2ZSBnZW5lcmF0b3IuIElmIHByb3ZpZGVkLCB0YWtlcyBwcmVjZWRlbmNlIG92ZXJcbiAgICogZmxvd1JlY29yZGVycyBhbmQgbmFycmF0aXZlRW5hYmxlZC4gVXNlZCBieSB0aGUgc3ViZmxvdyB0cmF2ZXJzZXIgZmFjdG9yeVxuICAgKiB0byBzaGFyZSB0aGUgcGFyZW50J3MgbmFycmF0aXZlIGdlbmVyYXRvciB3aXRoIHN1YmZsb3cgdHJhdmVyc2Vycy5cbiAgICovXG4gIG5hcnJhdGl2ZUdlbmVyYXRvcj86IElDb250cm9sRmxvd05hcnJhdGl2ZTtcbiAgLyoqXG4gICAqIE1heGltdW0gcmVjdXJzaXZlIGV4ZWN1dGVOb2RlIGRlcHRoLiBEZWZhdWx0cyB0byBGbG93Y2hhcnRUcmF2ZXJzZXIuTUFYX0VYRUNVVEVfREVQVEggKDUwMCkuXG4gICAqIE92ZXJyaWRlIGluIHRlc3RzIG9yIHVudXN1YWxseSBkZWVwIHBpcGVsaW5lcy5cbiAgICovXG4gIG1heERlcHRoPzogbnVtYmVyO1xuICAvKipcbiAgICogV2hlbiB0aGlzIHRyYXZlcnNlciBydW5zIGluc2lkZSBhIHN1YmZsb3csIHNldCB0aGlzIHRvIHRoZSBzdWJmbG93J3MgSUQuXG4gICAqIFByb3BhZ2F0ZWQgdG8gVHJhdmVyc2FsQ29udGV4dCBzbyBuYXJyYXRpdmUgZW50cmllcyBjYXJyeSB0aGUgY29ycmVjdCBzdWJmbG93SWQuXG4gICAqL1xuICBwYXJlbnRTdWJmbG93SWQ/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBGbG93Y2hhcnRUcmF2ZXJzZXI8VE91dCA9IGFueSwgVFNjb3BlID0gYW55PiB7XG4gIHByaXZhdGUgcmVhZG9ubHkgcm9vdDogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT47XG4gIHByaXZhdGUgc3RhZ2VNYXA6IE1hcDxzdHJpbmcsIFN0YWdlRnVuY3Rpb248VE91dCwgVFNjb3BlPj47XG4gIHByaXZhdGUgcmVhZG9ubHkgZXhlY3V0aW9uUnVudGltZTogSUV4ZWN1dGlvblJ1bnRpbWU7XG4gIHByaXZhdGUgc3ViZmxvd3M6IFJlY29yZDxzdHJpbmcsIHsgcm9vdDogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gfT47XG4gIHByaXZhdGUgcmVhZG9ubHkgbG9nZ2VyOiBJTG9nZ2VyO1xuICBwcml2YXRlIHJlYWRvbmx5IHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICBwcml2YXRlIHJlYWRvbmx5IHBhcmVudFN1YmZsb3dJZD86IHN0cmluZztcblxuICAvLyBIYW5kbGVyIG1vZHVsZXNcbiAgcHJpdmF0ZSByZWFkb25seSBub2RlUmVzb2x2ZXI6IE5vZGVSZXNvbHZlcjxUT3V0LCBUU2NvcGU+O1xuICBwcml2YXRlIHJlYWRvbmx5IGNoaWxkcmVuRXhlY3V0b3I6IENoaWxkcmVuRXhlY3V0b3I8VE91dCwgVFNjb3BlPjtcbiAgcHJpdmF0ZSByZWFkb25seSBzdWJmbG93RXhlY3V0b3I6IFN1YmZsb3dFeGVjdXRvcjxUT3V0LCBUU2NvcGU+O1xuICBwcml2YXRlIHJlYWRvbmx5IHN0YWdlUnVubmVyOiBTdGFnZVJ1bm5lcjxUT3V0LCBUU2NvcGU+O1xuICBwcml2YXRlIHJlYWRvbmx5IGNvbnRpbnVhdGlvblJlc29sdmVyOiBDb250aW51YXRpb25SZXNvbHZlcjxUT3V0LCBUU2NvcGU+O1xuICBwcml2YXRlIHJlYWRvbmx5IGRlY2lkZXJIYW5kbGVyOiBEZWNpZGVySGFuZGxlcjxUT3V0LCBUU2NvcGU+O1xuICBwcml2YXRlIHJlYWRvbmx5IHNlbGVjdG9ySGFuZGxlcjogU2VsZWN0b3JIYW5kbGVyPFRPdXQsIFRTY29wZT47XG4gIHByaXZhdGUgcmVhZG9ubHkgc3RydWN0dXJlTWFuYWdlcjogUnVudGltZVN0cnVjdHVyZU1hbmFnZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkgZXh0cmFjdG9yUnVubmVyOiBFeHRyYWN0b3JSdW5uZXI8VE91dCwgVFNjb3BlPjtcbiAgcHJpdmF0ZSByZWFkb25seSBuYXJyYXRpdmVHZW5lcmF0b3I6IElDb250cm9sRmxvd05hcnJhdGl2ZTtcbiAgcHJpdmF0ZSByZWFkb25seSBmbG93UmVjb3JkZXJEaXNwYXRjaGVyOiBGbG93UmVjb3JkZXJEaXNwYXRjaGVyIHwgdW5kZWZpbmVkO1xuXG4gIC8vIEV4ZWN1dGlvbiBzdGF0ZVxuICBwcml2YXRlIHN1YmZsb3dSZXN1bHRzOiBNYXA8c3RyaW5nLCBTdWJmbG93UmVzdWx0PiA9IG5ldyBNYXAoKTtcblxuICAvKipcbiAgICogUGVyLXRyYXZlcnNlciBzZXQgb2YgbGF6eSBzdWJmbG93IElEcyB0aGF0IGhhdmUgYmVlbiByZXNvbHZlZCBieSBUSElTIHJ1bi5cbiAgICogVXNlZCBpbnN0ZWFkIG9mIHdyaXRpbmcgYG5vZGUuc3ViZmxvd1Jlc29sdmVyID0gdW5kZWZpbmVkYCBiYWNrIHRvIHRoZSBzaGFyZWRcbiAgICogU3RhZ2VOb2RlIGdyYXBoIOKAlCBhdm9pZHMgYSByYWNlIHdoZXJlIGEgY29uY3VycmVudCB0cmF2ZXJzZXIgY2xlYXJzIHRoZSBzaGFyZWRcbiAgICogcmVzb2x2ZXIgYmVmb3JlIGFub3RoZXIgdHJhdmVyc2VyIGhhcyBmaW5pc2hlZCB1c2luZyBpdC5cbiAgICovXG4gIHByaXZhdGUgcmVhZG9ubHkgcmVzb2x2ZWRMYXp5U3ViZmxvd3MgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICAvKipcbiAgICogUmVjdXJzaW9uIGRlcHRoIGNvdW50ZXIgZm9yIGV4ZWN1dGVOb2RlLlxuICAgKiBFYWNoIHJlY3Vyc2l2ZSBleGVjdXRlTm9kZSBjYWxsIGluY3JlbWVudHMgdGhpczsgZGVjcmVtZW50cyBvbiBleGl0ICh0cnkvZmluYWxseSkuXG4gICAqIFByZXZlbnRzIGNhbGwtc3RhY2sgb3ZlcmZsb3cgb24gaW5maW5pdGUgbG9vcHMgb3IgZXhjZXNzaXZlbHkgZGVlcCBzdGFnZSBjaGFpbnMuXG4gICAqL1xuICBwcml2YXRlIF9leGVjdXRlRGVwdGggPSAwO1xuXG4gIC8qKlxuICAgKiBQZXItaW5zdGFuY2UgbWF4aW11bSBkZXB0aCAoc2V0IGZyb20gVHJhdmVyc2VyT3B0aW9ucy5tYXhEZXB0aCBvciB0aGUgY2xhc3MgZGVmYXVsdCkuXG4gICAqL1xuICBwcml2YXRlIHJlYWRvbmx5IF9tYXhEZXB0aDogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBEZWZhdWx0IG1heGltdW0gcmVjdXJzaXZlIGV4ZWN1dGVOb2RlIGRlcHRoIGJlZm9yZSBhbiBlcnJvciBpcyB0aHJvd24uXG4gICAqIDUwMCBjb21mb3J0YWJseSBjb3ZlcnMgYW55IHJlYWxpc3RpYyBwaXBlbGluZSBkZXB0aCAoaW5jbHVkaW5nIGRlZXBseSBuZXN0ZWRcbiAgICogc3ViZmxvd3MpIHdoaWxlIHByZXZlbnRpbmcgY2FsbC1zdGFjayBvdmVyZmxvdyAofjEwIDAwMCBmcmFtZXMgaW4gVjgpLlxuICAgKlxuICAgKiAqKk5vdGUgb24gY291bnRpbmc6KiogdGhlIGNvdW50ZXIgaW5jcmVtZW50cyBvbmNlIHBlciBgZXhlY3V0ZU5vZGVgIGNhbGwsIG5vdCBvbmNlIHBlclxuICAgKiBsb2dpY2FsIHVzZXIgc3RhZ2UuIFN1YmZsb3cgcm9vdCBlbnRyeSBhbmQgc3ViZmxvdyBjb250aW51YXRpb24gYWZ0ZXIgcmV0dXJuIGVhY2ggY29zdFxuICAgKiBvbmUgdGljay4gRm9yIHBpcGVsaW5lcyB3aXRoIG1hbnkgbmVzdGVkIHN1YmZsb3dzLCBidWRnZXQgcm91Z2hseSAyIMOXIChhdmcgc3RhZ2VzIHBlclxuICAgKiBzdWJmbG93KSBvZiBoZWFkcm9vbSB3aGVuIGNvbXB1dGluZyBhIGN1c3RvbSBgbWF4RGVwdGhgIHZpYSBgUnVuT3B0aW9ucy5tYXhEZXB0aGAuXG4gICAqXG4gICAqICoqTm90ZSBvbiBsb29wczoqKiBmb3IgYGxvb3BUbygpYCBwaXBlbGluZXMsIHRoaXMgZGVwdGggZ3VhcmQgYW5kIGBDb250aW51YXRpb25SZXNvbHZlcmAnc1xuICAgKiBpdGVyYXRpb24gbGltaXQgYXJlIGluZGVwZW5kZW50IOKAlCB0aGUgbG93ZXIgb25lIGZpcmVzIGZpcnN0LiBUaGUgZGVmYXVsdCBkZXB0aCBndWFyZCAoNTAwKVxuICAgKiBmaXJlcyBiZWZvcmUgdGhlIGRlZmF1bHQgaXRlcmF0aW9uIGxpbWl0ICgxMDAwKSBmb3IgbG9vcC1oZWF2eSBwaXBlbGluZXMuXG4gICAqXG4gICAqIEByZW1hcmtzIE5vdCBzYWZlIGZvciBjb25jdXJyZW50IGAuZXhlY3V0ZSgpYCBjYWxscyBvbiB0aGUgc2FtZSBpbnN0YW5jZSDigJQgY29uY3VycmVudFxuICAgKiBleGVjdXRpb25zIHJhY2Ugb24gYF9leGVjdXRlRGVwdGhgLiBVc2UgYSBzZXBhcmF0ZSBgRmxvd2NoYXJ0VHJhdmVyc2VyYCBwZXIgY29uY3VycmVudFxuICAgKiBleGVjdXRpb24uIGBGbG93Q2hhcnRFeGVjdXRvci5ydW4oKWAgYWx3YXlzIGNyZWF0ZXMgYSBmcmVzaCB0cmF2ZXJzZXIgcGVyIGNhbGwuXG4gICAqL1xuICBzdGF0aWMgcmVhZG9ubHkgTUFYX0VYRUNVVEVfREVQVEggPSA1MDA7XG5cbiAgY29uc3RydWN0b3Iob3B0czogVHJhdmVyc2VyT3B0aW9uczxUT3V0LCBUU2NvcGU+KSB7XG4gICAgY29uc3QgbWF4RGVwdGggPSBvcHRzLm1heERlcHRoID8/IEZsb3djaGFydFRyYXZlcnNlci5NQVhfRVhFQ1VURV9ERVBUSDtcbiAgICBpZiAobWF4RGVwdGggPCAxKSB0aHJvdyBuZXcgRXJyb3IoJ0Zsb3djaGFydFRyYXZlcnNlcjogbWF4RGVwdGggbXVzdCBiZSA+PSAxJyk7XG4gICAgdGhpcy5fbWF4RGVwdGggPSBtYXhEZXB0aDtcbiAgICB0aGlzLnJvb3QgPSBvcHRzLnJvb3Q7XG4gICAgLy8gU2hhbGxvdy1jb3B5IHN0YWdlTWFwIGFuZCBzdWJmbG93cyBzbyB0aGF0IGxhenktcmVzb2x1dGlvbiBtdXRhdGlvbnNcbiAgICAvLyAocHJlZml4ZWQgZW50cmllcyBhZGRlZCBkdXJpbmcgZXhlY3V0aW9uKSBzdGF5IHNjb3BlZCB0byBUSElTIHRyYXZlcnNlclxuICAgIC8vIGFuZCBkbyBub3QgZXNjYXBlIHRvIHRoZSBzaGFyZWQgRmxvd0NoYXJ0IG9iamVjdC4gV2l0aG91dCB0aGUgY29weSxcbiAgICAvLyBjb25jdXJyZW50IEZsb3dDaGFydEV4ZWN1dG9yIHJ1bnMgc2hhcmluZyB0aGUgc2FtZSBGbG93Q2hhcnQgd291bGQgcmFjZVxuICAgIC8vIG9uIHRoZXNlIHR3byBtdXRhYmxlIGRpY3Rpb25hcmllcy5cbiAgICB0aGlzLnN0YWdlTWFwID0gbmV3IE1hcChvcHRzLnN0YWdlTWFwKTtcbiAgICB0aGlzLmV4ZWN1dGlvblJ1bnRpbWUgPSBvcHRzLmV4ZWN1dGlvblJ1bnRpbWU7XG4gICAgdGhpcy5zdWJmbG93cyA9IG9wdHMuc3ViZmxvd3MgPyB7IC4uLm9wdHMuc3ViZmxvd3MgfSA6IHt9O1xuICAgIHRoaXMubG9nZ2VyID0gb3B0cy5sb2dnZXI7XG4gICAgdGhpcy5zaWduYWwgPSBvcHRzLnNpZ25hbDtcbiAgICB0aGlzLnBhcmVudFN1YmZsb3dJZCA9IG9wdHMucGFyZW50U3ViZmxvd0lkO1xuXG4gICAgLy8gU3RydWN0dXJlIG1hbmFnZXIgKGRlZXAtY2xvbmVzIGJ1aWxkLXRpbWUgc3RydWN0dXJlKVxuICAgIHRoaXMuc3RydWN0dXJlTWFuYWdlciA9IG5ldyBSdW50aW1lU3RydWN0dXJlTWFuYWdlcigpO1xuICAgIHRoaXMuc3RydWN0dXJlTWFuYWdlci5pbml0KG9wdHMuYnVpbGRUaW1lU3RydWN0dXJlKTtcblxuICAgIC8vIEV4dHJhY3RvciBydW5uZXJcbiAgICB0aGlzLmV4dHJhY3RvclJ1bm5lciA9IG5ldyBFeHRyYWN0b3JSdW5uZXIoXG4gICAgICBvcHRzLmV4dHJhY3RvcixcbiAgICAgIG9wdHMuZW5yaWNoU25hcHNob3RzID8/IGZhbHNlLFxuICAgICAgdGhpcy5leGVjdXRpb25SdW50aW1lLFxuICAgICAgdGhpcy5sb2dnZXIsXG4gICAgKTtcblxuICAgIC8vIE5hcnJhdGl2ZSBnZW5lcmF0b3JcbiAgICAvLyBQcmlvcml0eTogZXhwbGljaXQgbmFycmF0aXZlR2VuZXJhdG9yID4gZmxvd1JlY29yZGVycyA+IGRlZmF1bHQgTmFycmF0aXZlRmxvd1JlY29yZGVyID4gbnVsbC5cbiAgICAvLyBTdWJmbG93IHRyYXZlcnNlcnMgcmVjZWl2ZSB0aGUgcGFyZW50J3MgbmFycmF0aXZlR2VuZXJhdG9yIHNvIGFsbCBldmVudHMgZmxvdyB0byBvbmUgcGxhY2UuXG4gICAgaWYgKG9wdHMubmFycmF0aXZlR2VuZXJhdG9yKSB7XG4gICAgICB0aGlzLm5hcnJhdGl2ZUdlbmVyYXRvciA9IG9wdHMubmFycmF0aXZlR2VuZXJhdG9yO1xuICAgIH0gZWxzZSBpZiAob3B0cy5uYXJyYXRpdmVFbmFibGVkKSB7XG4gICAgICBjb25zdCBkaXNwYXRjaGVyID0gbmV3IEZsb3dSZWNvcmRlckRpc3BhdGNoZXIoKTtcbiAgICAgIHRoaXMuZmxvd1JlY29yZGVyRGlzcGF0Y2hlciA9IGRpc3BhdGNoZXI7XG5cbiAgICAgIC8vIElmIGN1c3RvbSBGbG93UmVjb3JkZXJzIGFyZSBwcm92aWRlZCwgdXNlIHRoZW07IG90aGVyd2lzZSBhdHRhY2ggZGVmYXVsdCBOYXJyYXRpdmVGbG93UmVjb3JkZXJcbiAgICAgIGlmIChvcHRzLmZsb3dSZWNvcmRlcnMgJiYgb3B0cy5mbG93UmVjb3JkZXJzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgZm9yIChjb25zdCByZWNvcmRlciBvZiBvcHRzLmZsb3dSZWNvcmRlcnMpIHtcbiAgICAgICAgICBkaXNwYXRjaGVyLmF0dGFjaChyZWNvcmRlcik7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGRpc3BhdGNoZXIuYXR0YWNoKG5ldyBOYXJyYXRpdmVGbG93UmVjb3JkZXIoKSk7XG4gICAgICB9XG5cbiAgICAgIHRoaXMubmFycmF0aXZlR2VuZXJhdG9yID0gZGlzcGF0Y2hlcjtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5uYXJyYXRpdmVHZW5lcmF0b3IgPSBuZXcgTnVsbENvbnRyb2xGbG93TmFycmF0aXZlR2VuZXJhdG9yKCk7XG4gICAgfVxuXG4gICAgLy8gQnVpbGQgc2hhcmVkIGRlcHMgYmFnXG4gICAgY29uc3QgZGVwcyA9IHRoaXMuY3JlYXRlRGVwcyhvcHRzKTtcblxuICAgIC8vIEJ1aWxkIE8oMSkgbm9kZSBJRCBtYXAgZnJvbSB0aGUgcm9vdCBncmFwaCAoYXZvaWRzIHJlcGVhdGVkIERGUyBvbiBldmVyeSBsb29wVG8oKSlcbiAgICBjb25zdCBub2RlSWRNYXAgPSB0aGlzLmJ1aWxkTm9kZUlkTWFwKG9wdHMucm9vdCk7XG5cbiAgICAvLyBJbml0aWFsaXplIGhhbmRsZXIgbW9kdWxlc1xuICAgIHRoaXMubm9kZVJlc29sdmVyID0gbmV3IE5vZGVSZXNvbHZlcihkZXBzLCBub2RlSWRNYXApO1xuICAgIHRoaXMuY2hpbGRyZW5FeGVjdXRvciA9IG5ldyBDaGlsZHJlbkV4ZWN1dG9yKGRlcHMsIHRoaXMuZXhlY3V0ZU5vZGUuYmluZCh0aGlzKSk7XG4gICAgdGhpcy5zdGFnZVJ1bm5lciA9IG5ldyBTdGFnZVJ1bm5lcihkZXBzKTtcbiAgICB0aGlzLmNvbnRpbnVhdGlvblJlc29sdmVyID0gbmV3IENvbnRpbnVhdGlvblJlc29sdmVyKGRlcHMsIHRoaXMubm9kZVJlc29sdmVyLCAobm9kZUlkLCBjb3VudCkgPT5cbiAgICAgIHRoaXMuc3RydWN0dXJlTWFuYWdlci51cGRhdGVJdGVyYXRpb25Db3VudChub2RlSWQsIGNvdW50KSxcbiAgICApO1xuICAgIHRoaXMuZGVjaWRlckhhbmRsZXIgPSBuZXcgRGVjaWRlckhhbmRsZXIoZGVwcyk7XG4gICAgdGhpcy5zZWxlY3RvckhhbmRsZXIgPSBuZXcgU2VsZWN0b3JIYW5kbGVyKGRlcHMsIHRoaXMuY2hpbGRyZW5FeGVjdXRvcik7XG4gICAgdGhpcy5zdWJmbG93RXhlY3V0b3IgPSBuZXcgU3ViZmxvd0V4ZWN1dG9yKGRlcHMsIHRoaXMuY3JlYXRlU3ViZmxvd1RyYXZlcnNlckZhY3Rvcnkob3B0cykpO1xuICB9XG5cbiAgLyoqXG4gICAqIENyZWF0ZSBhIGZhY3RvcnkgdGhhdCBwcm9kdWNlcyBGbG93Y2hhcnRUcmF2ZXJzZXIgaW5zdGFuY2VzIGZvciBzdWJmbG93IGV4ZWN1dGlvbi5cbiAgICogQ2FwdHVyZXMgcGFyZW50IGNvbmZpZyBpbiBjbG9zdXJlIOKAlCBTdWJmbG93RXhlY3V0b3IgcHJvdmlkZXMgc3ViZmxvdy1zcGVjaWZpYyBvdmVycmlkZXMuXG4gICAqIEVhY2ggc3ViZmxvdyBnZXRzIGEgZnVsbCB0cmF2ZXJzZXIgd2l0aCBhbGwgNyBwaGFzZXMgKGRlY2lkZXJzLCBzZWxlY3RvcnMsIGxvb3BzLCBldGMuKS5cbiAgICovXG4gIHByaXZhdGUgY3JlYXRlU3ViZmxvd1RyYXZlcnNlckZhY3RvcnkoXG4gICAgcGFyZW50T3B0czogVHJhdmVyc2VyT3B0aW9uczxUT3V0LCBUU2NvcGU+LFxuICApOiBTdWJmbG93VHJhdmVyc2VyRmFjdG9yeTxUT3V0LCBUU2NvcGU+IHtcbiAgICAvLyBDYXB0dXJlIHJlZmVyZW5jZXMgdG8gbXV0YWJsZSBzdGF0ZSDigJQgZmFjdG9yeSByZWFkcyB0aGUgQ1VSUkVOVCBzdGF0ZSB3aGVuIGNhbGxlZCxcbiAgICAvLyBub3QgdGhlIHN0YXRlIGF0IGZhY3RvcnkgY3JlYXRpb24gdGltZS4gVGhpcyBpcyBjb3JyZWN0IGJlY2F1c2UgbGF6eSBzdWJmbG93IHJlc29sdXRpb25cbiAgICAvLyBtYXkgYWRkIGVudHJpZXMgdG8gc3RhZ2VNYXAvc3ViZmxvd3MgYmVmb3JlIGEgbmVzdGVkIHN1YmZsb3cgaXMgZW5jb3VudGVyZWQuXG4gICAgY29uc3QgcGFyZW50U3RhZ2VNYXAgPSB0aGlzLnN0YWdlTWFwO1xuICAgIGNvbnN0IHBhcmVudFN1YmZsb3dzID0gdGhpcy5zdWJmbG93cztcbiAgICBjb25zdCBuYXJyYXRpdmVHZW5lcmF0b3IgPSB0aGlzLm5hcnJhdGl2ZUdlbmVyYXRvcjtcblxuICAgIHJldHVybiAoc3ViZmxvd09wdHMpID0+IHtcbiAgICAgIGNvbnN0IHRyYXZlcnNlciA9IG5ldyBGbG93Y2hhcnRUcmF2ZXJzZXI8VE91dCwgVFNjb3BlPih7XG4gICAgICAgIHJvb3Q6IHN1YmZsb3dPcHRzLnJvb3QsXG4gICAgICAgIHN0YWdlTWFwOiBwYXJlbnRTdGFnZU1hcCwgLy8gQ29uc3RydWN0b3Igc2hhbGxvdy1jb3BpZXMgdGhpc1xuICAgICAgICBzY29wZUZhY3Rvcnk6IHBhcmVudE9wdHMuc2NvcGVGYWN0b3J5LFxuICAgICAgICBleGVjdXRpb25SdW50aW1lOiBzdWJmbG93T3B0cy5leGVjdXRpb25SdW50aW1lLFxuICAgICAgICByZWFkT25seUNvbnRleHQ6IHN1YmZsb3dPcHRzLnJlYWRPbmx5Q29udGV4dCxcbiAgICAgICAgZXhlY3V0aW9uRW52OiBwYXJlbnRPcHRzLmV4ZWN1dGlvbkVudixcbiAgICAgICAgdGhyb3R0bGluZ0Vycm9yQ2hlY2tlcjogcGFyZW50T3B0cy50aHJvdHRsaW5nRXJyb3JDaGVja2VyLFxuICAgICAgICBzdHJlYW1IYW5kbGVyczogcGFyZW50T3B0cy5zdHJlYW1IYW5kbGVycyxcbiAgICAgICAgZXh0cmFjdG9yOiBwYXJlbnRPcHRzLmV4dHJhY3RvcixcbiAgICAgICAgc2NvcGVQcm90ZWN0aW9uTW9kZTogcGFyZW50T3B0cy5zY29wZVByb3RlY3Rpb25Nb2RlLFxuICAgICAgICBzdWJmbG93czogcGFyZW50U3ViZmxvd3MsIC8vIENvbnN0cnVjdG9yIHNoYWxsb3ctY29waWVzIHRoaXNcbiAgICAgICAgZW5yaWNoU25hcHNob3RzOiBwYXJlbnRPcHRzLmVucmljaFNuYXBzaG90cyxcbiAgICAgICAgbmFycmF0aXZlR2VuZXJhdG9yLCAvLyBTaGFyZSBwYXJlbnQncyDigJQgYWxsIGV2ZW50cyBmbG93IHRvIG9uZSBwbGFjZVxuICAgICAgICBsb2dnZXI6IHBhcmVudE9wdHMubG9nZ2VyLFxuICAgICAgICBzaWduYWw6IHBhcmVudE9wdHMuc2lnbmFsLFxuICAgICAgICBtYXhEZXB0aDogdGhpcy5fbWF4RGVwdGgsXG4gICAgICAgIHBhcmVudFN1YmZsb3dJZDogc3ViZmxvd09wdHMuc3ViZmxvd0lkLFxuICAgICAgfSk7XG5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIGV4ZWN1dGU6ICgpID0+IHRyYXZlcnNlci5leGVjdXRlKCksXG4gICAgICAgIGdldFN1YmZsb3dSZXN1bHRzOiAoKSA9PiB0cmF2ZXJzZXIuZ2V0U3ViZmxvd1Jlc3VsdHMoKSxcbiAgICAgIH07XG4gICAgfTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlRGVwcyhvcHRzOiBUcmF2ZXJzZXJPcHRpb25zPFRPdXQsIFRTY29wZT4pOiBIYW5kbGVyRGVwczxUT3V0LCBUU2NvcGU+IHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhZ2VNYXA6IHRoaXMuc3RhZ2VNYXAsXG4gICAgICByb290OiB0aGlzLnJvb3QsXG4gICAgICBleGVjdXRpb25SdW50aW1lOiB0aGlzLmV4ZWN1dGlvblJ1bnRpbWUsXG4gICAgICBzY29wZUZhY3Rvcnk6IG9wdHMuc2NvcGVGYWN0b3J5LFxuICAgICAgc3ViZmxvd3M6IHRoaXMuc3ViZmxvd3MsXG4gICAgICB0aHJvdHRsaW5nRXJyb3JDaGVja2VyOiBvcHRzLnRocm90dGxpbmdFcnJvckNoZWNrZXIsXG4gICAgICBzdHJlYW1IYW5kbGVyczogb3B0cy5zdHJlYW1IYW5kbGVycyxcbiAgICAgIHNjb3BlUHJvdGVjdGlvbk1vZGU6IG9wdHMuc2NvcGVQcm90ZWN0aW9uTW9kZSA/PyAnZXJyb3InLFxuICAgICAgcmVhZE9ubHlDb250ZXh0OiBvcHRzLnJlYWRPbmx5Q29udGV4dCxcbiAgICAgIGV4ZWN1dGlvbkVudjogb3B0cy5leGVjdXRpb25FbnYsXG4gICAgICBuYXJyYXRpdmVHZW5lcmF0b3I6IHRoaXMubmFycmF0aXZlR2VuZXJhdG9yLFxuICAgICAgbG9nZ2VyOiB0aGlzLmxvZ2dlcixcbiAgICAgIHNpZ25hbDogb3B0cy5zaWduYWwsXG4gICAgfTtcbiAgfVxuXG4gIC8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCBQdWJsaWMgQVBJIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIGFzeW5jIGV4ZWN1dGUoYnJhbmNoUGF0aD86IHN0cmluZyk6IFByb21pc2U8VHJhdmVyc2FsUmVzdWx0PiB7XG4gICAgY29uc3QgY29udGV4dCA9IHRoaXMuZXhlY3V0aW9uUnVudGltZS5yb290U3RhZ2VDb250ZXh0O1xuICAgIHJldHVybiBhd2FpdCB0aGlzLmV4ZWN1dGVOb2RlKHRoaXMucm9vdCwgY29udGV4dCwgeyBzaG91bGRCcmVhazogZmFsc2UgfSwgYnJhbmNoUGF0aCA/PyAnJyk7XG4gIH1cblxuICBnZXRSdW50aW1lU3RydWN0dXJlKCk6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMuc3RydWN0dXJlTWFuYWdlci5nZXRTdHJ1Y3R1cmUoKTtcbiAgfVxuXG4gIGdldFNuYXBzaG90KCkge1xuICAgIHJldHVybiB0aGlzLmV4ZWN1dGlvblJ1bnRpbWUuZ2V0U25hcHNob3QoKTtcbiAgfVxuXG4gIGdldFJ1bnRpbWUoKSB7XG4gICAgcmV0dXJuIHRoaXMuZXhlY3V0aW9uUnVudGltZTtcbiAgfVxuXG4gIHNldFJvb3RPYmplY3QocGF0aDogc3RyaW5nW10sIGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93bikge1xuICAgIHRoaXMuZXhlY3V0aW9uUnVudGltZS5zZXRSb290T2JqZWN0KHBhdGgsIGtleSwgdmFsdWUpO1xuICB9XG5cbiAgZ2V0QnJhbmNoSWRzKCkge1xuICAgIHJldHVybiB0aGlzLmV4ZWN1dGlvblJ1bnRpbWUuZ2V0UGlwZWxpbmVzKCk7XG4gIH1cblxuICBnZXRSdW50aW1lUm9vdCgpOiBTdGFnZU5vZGUge1xuICAgIHJldHVybiB0aGlzLnJvb3Q7XG4gIH1cblxuICBnZXRTdWJmbG93UmVzdWx0cygpOiBNYXA8c3RyaW5nLCBTdWJmbG93UmVzdWx0PiB7XG4gICAgcmV0dXJuIHRoaXMuc3ViZmxvd1Jlc3VsdHM7XG4gIH1cblxuICBnZXRFeHRyYWN0ZWRSZXN1bHRzPFRSZXN1bHQgPSB1bmtub3duPigpOiBNYXA8c3RyaW5nLCBUUmVzdWx0PiB7XG4gICAgcmV0dXJuIHRoaXMuZXh0cmFjdG9yUnVubmVyLmdldEV4dHJhY3RlZFJlc3VsdHMoKSBhcyBNYXA8c3RyaW5nLCBUUmVzdWx0PjtcbiAgfVxuXG4gIGdldEV4dHJhY3RvckVycm9ycygpOiBFeHRyYWN0b3JFcnJvcltdIHtcbiAgICByZXR1cm4gdGhpcy5leHRyYWN0b3JSdW5uZXIuZ2V0RXh0cmFjdG9yRXJyb3JzKCk7XG4gIH1cblxuICBnZXROYXJyYXRpdmUoKTogc3RyaW5nW10ge1xuICAgIHJldHVybiB0aGlzLm5hcnJhdGl2ZUdlbmVyYXRvci5nZXRTZW50ZW5jZXMoKTtcbiAgfVxuXG4gIC8qKiBSZXR1cm5zIHRoZSBGbG93UmVjb3JkZXJEaXNwYXRjaGVyLCBvciB1bmRlZmluZWQgaWYgbmFycmF0aXZlIGlzIGRpc2FibGVkLiAqL1xuICBnZXRGbG93UmVjb3JkZXJEaXNwYXRjaGVyKCk6IEZsb3dSZWNvcmRlckRpc3BhdGNoZXIgfCB1bmRlZmluZWQge1xuICAgIHJldHVybiB0aGlzLmZsb3dSZWNvcmRlckRpc3BhdGNoZXI7XG4gIH1cblxuICAvLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgQ29yZSBUcmF2ZXJzYWwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIEJ1aWxkIGFuIE8oMSkgSUTihpJub2RlIG1hcCBmcm9tIHRoZSByb290IGdyYXBoLlxuICAgKiBVc2VkIGJ5IE5vZGVSZXNvbHZlciB0byBhdm9pZCByZXBlYXRlZCBERlMgb24gZXZlcnkgbG9vcFRvKCkgY2FsbC5cbiAgICogRGVwdGgtZ3VhcmRlZCBhdCBNQVhfRVhFQ1VURV9ERVBUSCB0byBwcmV2ZW50IGluZmluaXRlIHJlY3Vyc2lvbiBvbiBjeWNsaWMgZ3JhcGhzLlxuICAgKiBEeW5hbWljIHN1YmZsb3dzIGFuZCBsYXp5LXJlc29sdmVkIG5vZGVzIGFyZSBhZGRlZCB0byBzdGFnZU1hcCBhdCBydW50aW1lIGJ1dCBub3QgdG8gdGhpcyBtYXAg4oCUXG4gICAqIHRob3NlIHVzZSB0aGUgREZTIGZhbGxiYWNrIGluIE5vZGVSZXNvbHZlci5cbiAgICovXG4gIHByaXZhdGUgYnVpbGROb2RlSWRNYXAocm9vdDogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4pOiBNYXA8c3RyaW5nLCBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPj4ge1xuICAgIGNvbnN0IG1hcCA9IG5ldyBNYXA8c3RyaW5nLCBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPj4oKTtcbiAgICBjb25zdCB2aXNpdCA9IChub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiwgZGVwdGg6IG51bWJlcik6IHZvaWQgPT4ge1xuICAgICAgaWYgKGRlcHRoID4gRmxvd2NoYXJ0VHJhdmVyc2VyLk1BWF9FWEVDVVRFX0RFUFRIKSByZXR1cm47XG4gICAgICBpZiAobWFwLmhhcyhub2RlLmlkKSkgcmV0dXJuOyAvLyBhbHJlYWR5IHZpc2l0ZWQgKGF2b2lkcyBpbmZpbml0ZSBsb29wcyBvbiBjeWNsaWMgcmVmcylcbiAgICAgIG1hcC5zZXQobm9kZS5pZCwgbm9kZSk7XG4gICAgICBpZiAobm9kZS5jaGlsZHJlbikge1xuICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIG5vZGUuY2hpbGRyZW4pIHZpc2l0KGNoaWxkLCBkZXB0aCArIDEpO1xuICAgICAgfVxuICAgICAgaWYgKG5vZGUubmV4dCkgdmlzaXQobm9kZS5uZXh0LCBkZXB0aCArIDEpO1xuICAgIH07XG4gICAgdmlzaXQocm9vdCwgMCk7XG4gICAgcmV0dXJuIG1hcDtcbiAgfVxuXG4gIHByaXZhdGUgZ2V0U3RhZ2VGbihub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPik6IFN0YWdlRnVuY3Rpb248VE91dCwgVFNjb3BlPiB8IHVuZGVmaW5lZCB7XG4gICAgaWYgKHR5cGVvZiBub2RlLmZuID09PSAnZnVuY3Rpb24nKSByZXR1cm4gbm9kZS5mbiBhcyBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT47XG4gICAgLy8gUHJpbWFyeTogbG9vayB1cCBieSBpZCAoc3RhYmxlIGlkZW50aWZpZXIsIGtleWVkIGJ5IEZsb3dDaGFydEJ1aWxkZXIpXG4gICAgY29uc3QgYnlJZCA9IHRoaXMuc3RhZ2VNYXAuZ2V0KG5vZGUuaWQpO1xuICAgIGlmIChieUlkICE9PSB1bmRlZmluZWQpIHJldHVybiBieUlkO1xuICAgIC8vIEZhbGxiYWNrOiBsb29rIHVwIGJ5IG5hbWUgKHN1cHBvcnRzIGhhbmQtY3JhZnRlZCBzdGFnZU1hcHMgaW4gdGVzdHMgYW5kIGFkdmFuY2VkIHVzZSlcbiAgICByZXR1cm4gdGhpcy5zdGFnZU1hcC5nZXQobm9kZS5uYW1lKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgZXhlY3V0ZVN0YWdlKFxuICAgIG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+LFxuICAgIHN0YWdlRnVuYzogU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+LFxuICAgIGNvbnRleHQ6IFN0YWdlQ29udGV4dCxcbiAgICBicmVha0ZuOiAoKSA9PiB2b2lkLFxuICApIHtcbiAgICByZXR1cm4gdGhpcy5zdGFnZVJ1bm5lci5ydW4obm9kZSwgc3RhZ2VGdW5jLCBjb250ZXh0LCBicmVha0ZuKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBQcmUtb3JkZXIgREZTIHRyYXZlcnNhbCDigJQgdGhlIGNvcmUgYWxnb3JpdGhtLlxuICAgKiBFYWNoIGNhbGwgcHJvY2Vzc2VzIG9uZSBub2RlIHRocm91Z2ggYWxsIDcgcGhhc2VzLlxuICAgKi9cbiAgcHJpdmF0ZSBhc3luYyBleGVjdXRlTm9kZShcbiAgICBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPixcbiAgICBjb250ZXh0OiBTdGFnZUNvbnRleHQsXG4gICAgYnJlYWtGbGFnOiB7IHNob3VsZEJyZWFrOiBib29sZWFuIH0sXG4gICAgYnJhbmNoUGF0aD86IHN0cmluZyxcbiAgKTogUHJvbWlzZTxhbnk+IHtcbiAgICAvLyDilIDilIDilIAgUmVjdXJzaW9uIGRlcHRoIGd1YXJkIOKUgOKUgOKUgFxuICAgIC8vIEVhY2ggYGF3YWl0IGV4ZWN1dGVOb2RlKC4uLilgIGtlZXBzIHRoZSBjYWxsaW5nIGZyYW1lIG9uIHRoZSBzdGFjay5cbiAgICAvLyBXaXRob3V0IGEgY2FwLCBhbiBpbmZpbml0ZSBsb29wIG9yIGFuIGV4Y2Vzc2l2ZWx5IGRlZXAgc3RhZ2UgY2hhaW4gd2lsbFxuICAgIC8vIGV2ZW50dWFsbHkgb3ZlcmZsb3cgdGhlIFY4IGNhbGwgc3RhY2sgKH4xMCAwMDAgZnJhbWVzKSB3aXRoIGEgY3J5cHRpY1xuICAgIC8vIFwiTWF4aW11bSBjYWxsIHN0YWNrIHNpemUgZXhjZWVkZWRcIiBlcnJvci4gIFdlIGZhaWwgZWFybHkgd2l0aCBhIGNsZWFyXG4gICAgLy8gbWVzc2FnZSBzbyB1c2VycyBjYW4gZGlhZ25vc2UgdGhlIGNhdXNlIChpbmZpbml0ZSBsb29wLCBtaXNzaW5nIGJyZWFrLCBldGMuKS5cbiAgICAvLyBUaGUgaW5jcmVtZW50IGlzIGluc2lkZSBgdHJ5YCBzbyBgZmluYWxseWAgYWx3YXlzIGRlY3JlbWVudHMg4oCUIG5vIGZyYWdpbGVcbiAgICAvLyBnYXAgYmV0d2VlbiBjaGVjayBhbmQgdHJ5IGVudHJ5LlxuICAgIHRyeSB7XG4gICAgICBpZiAoKyt0aGlzLl9leGVjdXRlRGVwdGggPiB0aGlzLl9tYXhEZXB0aCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYEZsb3djaGFydFRyYXZlcnNlcjogbWF4aW11bSB0cmF2ZXJzYWwgZGVwdGggZXhjZWVkZWQgKCR7dGhpcy5fbWF4RGVwdGh9KS4gYCArXG4gICAgICAgICAgICAnQ2hlY2sgZm9yIGluZmluaXRlIGxvb3BzIG9yIG1pc3NpbmcgYnJlYWsgY29uZGl0aW9ucyBpbiB5b3VyIGZsb3djaGFydC4gJyArXG4gICAgICAgICAgICBgTGFzdCBzdGFnZTogJyR7bm9kZS5uYW1lfScuIGAgK1xuICAgICAgICAgICAgJ0ZvciBsb29wVG8oKSBwaXBlbGluZXMsIGNvbnNpZGVyIGFkZGluZyBhIGJyZWFrIGNvbmRpdGlvbiBvciB1c2luZyBSdW5PcHRpb25zLm1heERlcHRoIHRvIHJhaXNlIHRoZSBsaW1pdC4nLFxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICAvLyBBdHRhY2ggYnVpbGRlciBtZXRhZGF0YSB0byBjb250ZXh0IGZvciBzbmFwc2hvdCBlbnJpY2htZW50XG4gICAgICBpZiAobm9kZS5kZXNjcmlwdGlvbikgY29udGV4dC5kZXNjcmlwdGlvbiA9IG5vZGUuZGVzY3JpcHRpb247XG4gICAgICBpZiAobm9kZS5pc1N1YmZsb3dSb290ICYmIG5vZGUuc3ViZmxvd0lkKSBjb250ZXh0LnN1YmZsb3dJZCA9IG5vZGUuc3ViZmxvd0lkO1xuXG4gICAgICAvLyBCdWlsZCB0cmF2ZXJzYWwgY29udGV4dCBmb3IgcmVjb3JkZXIgZXZlbnRzIOKAlCBjcmVhdGVkIG9uY2UgcGVyIHN0YWdlLCBzaGFyZWQgYnkgYWxsIGV2ZW50c1xuICAgICAgY29uc3QgdHJhdmVyc2FsQ29udGV4dDogVHJhdmVyc2FsQ29udGV4dCA9IHtcbiAgICAgICAgc3RhZ2VJZDogbm9kZS5pZCA/PyBjb250ZXh0LnN0YWdlSWQsXG4gICAgICAgIHN0YWdlTmFtZTogbm9kZS5uYW1lLFxuICAgICAgICBwYXJlbnRTdGFnZUlkOiBjb250ZXh0LnBhcmVudD8uc3RhZ2VJZCxcbiAgICAgICAgc3ViZmxvd0lkOiBjb250ZXh0LnN1YmZsb3dJZCA/PyB0aGlzLnBhcmVudFN1YmZsb3dJZCxcbiAgICAgICAgc3ViZmxvd1BhdGg6IGJyYW5jaFBhdGggfHwgdW5kZWZpbmVkLFxuICAgICAgICBkZXB0aDogdGhpcy5jb21wdXRlQ29udGV4dERlcHRoKGNvbnRleHQpLFxuICAgICAgfTtcblxuICAgICAgLy8g4pSA4pSA4pSAIFBoYXNlIDBhOiBMQVpZIFJFU09MVkUg4oCUIGRlZmVycmVkIHN1YmZsb3cgcmVzb2x1dGlvbiDilIDilIDilIBcbiAgICAgIC8vIEd1YXJkIHVzZXMgdGhlIHBlci10cmF2ZXJzZXIgcmVzb2x2ZWRMYXp5U3ViZmxvd3Mgc2V0IChub3QgdGhlIHNoYXJlZCBub2RlKSBzb1xuICAgICAgLy8gY29uY3VycmVudCB0cmF2ZXJzZXJzIGRvIG5vdCByYWNlIG9uIG5vZGUuc3ViZmxvd1Jlc29sdmVyIG9yIGNsZWFyIGl0IGZvciBlYWNoIG90aGVyLlxuICAgICAgaWYgKG5vZGUuaXNTdWJmbG93Um9vdCAmJiBub2RlLnN1YmZsb3dSZXNvbHZlciAmJiAhdGhpcy5yZXNvbHZlZExhenlTdWJmbG93cy5oYXMobm9kZS5zdWJmbG93SWQhKSkge1xuICAgICAgICBjb25zdCByZXNvbHZlZCA9IG5vZGUuc3ViZmxvd1Jlc29sdmVyKCk7XG4gICAgICAgIGNvbnN0IHByZWZpeGVkUm9vdCA9IHRoaXMucHJlZml4Tm9kZVRyZWUocmVzb2x2ZWQucm9vdCBhcyBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiwgbm9kZS5zdWJmbG93SWQhKTtcblxuICAgICAgICAvLyBSZWdpc3RlciB0aGUgcmVzb2x2ZWQgc3ViZmxvdyAoc2FtZSBwYXRoIGFzIGVhZ2VyIHJlZ2lzdHJhdGlvbilcbiAgICAgICAgdGhpcy5zdWJmbG93c1tub2RlLnN1YmZsb3dJZCFdID0geyByb290OiBwcmVmaXhlZFJvb3QgfTtcblxuICAgICAgICAvLyBNZXJnZSBzdGFnZU1hcCBlbnRyaWVzXG4gICAgICAgIGZvciAoY29uc3QgW2tleSwgZm5dIG9mIHJlc29sdmVkLnN0YWdlTWFwKSB7XG4gICAgICAgICAgY29uc3QgcHJlZml4ZWRLZXkgPSBgJHtub2RlLnN1YmZsb3dJZH0vJHtrZXl9YDtcbiAgICAgICAgICBpZiAoIXRoaXMuc3RhZ2VNYXAuaGFzKHByZWZpeGVkS2V5KSkge1xuICAgICAgICAgICAgdGhpcy5zdGFnZU1hcC5zZXQocHJlZml4ZWRLZXksIGZuIGFzIFN0YWdlRnVuY3Rpb248VE91dCwgVFNjb3BlPik7XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gTWVyZ2UgbmVzdGVkIHN1YmZsb3dzXG4gICAgICAgIGlmIChyZXNvbHZlZC5zdWJmbG93cykge1xuICAgICAgICAgIGZvciAoY29uc3QgW2tleSwgZGVmXSBvZiBPYmplY3QuZW50cmllcyhyZXNvbHZlZC5zdWJmbG93cykpIHtcbiAgICAgICAgICAgIGNvbnN0IHByZWZpeGVkS2V5ID0gYCR7bm9kZS5zdWJmbG93SWR9LyR7a2V5fWA7XG4gICAgICAgICAgICBpZiAoIXRoaXMuc3ViZmxvd3NbcHJlZml4ZWRLZXldKSB7XG4gICAgICAgICAgICAgIHRoaXMuc3ViZmxvd3NbcHJlZml4ZWRLZXldID0gZGVmIGFzIHsgcm9vdDogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBVcGRhdGUgcnVudGltZSBzdHJ1Y3R1cmUgd2l0aCB0aGUgbm93LXJlc29sdmVkIHNwZWNcbiAgICAgICAgdGhpcy5zdHJ1Y3R1cmVNYW5hZ2VyLnVwZGF0ZUR5bmFtaWNTdWJmbG93KFxuICAgICAgICAgIG5vZGUuaWQsXG4gICAgICAgICAgbm9kZS5zdWJmbG93SWQhLFxuICAgICAgICAgIG5vZGUuc3ViZmxvd05hbWUsXG4gICAgICAgICAgcmVzb2x2ZWQuYnVpbGRUaW1lU3RydWN0dXJlLFxuICAgICAgICApO1xuXG4gICAgICAgIC8vIE1hcmsgYXMgcmVzb2x2ZWQgZm9yIFRISVMgdHJhdmVyc2VyIOKAlCBwZXItdHJhdmVyc2VyIHNldCBwcmV2ZW50cyByZS1lbnRyeVxuICAgICAgICAvLyB3aXRob3V0IG11dGF0aW5nIHRoZSBzaGFyZWQgU3RhZ2VOb2RlIGdyYXBoICh3aGljaCB3b3VsZCByYWNlIGNvbmN1cnJlbnQgdHJhdmVyc2VycykuXG4gICAgICAgIHRoaXMucmVzb2x2ZWRMYXp5U3ViZmxvd3MuYWRkKG5vZGUuc3ViZmxvd0lkISk7XG4gICAgICB9XG5cbiAgICAgIC8vIOKUgOKUgOKUgCBQaGFzZSAwOiBDTEFTU0lGWSDigJQgc3ViZmxvdyBkZXRlY3Rpb24g4pSA4pSA4pSAXG4gICAgICBpZiAobm9kZS5pc1N1YmZsb3dSb290ICYmIG5vZGUuc3ViZmxvd0lkKSB7XG4gICAgICAgIGNvbnN0IHJlc29sdmVkTm9kZSA9IHRoaXMubm9kZVJlc29sdmVyLnJlc29sdmVTdWJmbG93UmVmZXJlbmNlKG5vZGUpO1xuICAgICAgICBjb25zdCBwcmV2aW91c1N1YmZsb3dJZCA9IHRoaXMuZXh0cmFjdG9yUnVubmVyLmN1cnJlbnRTdWJmbG93SWQ7XG4gICAgICAgIHRoaXMuZXh0cmFjdG9yUnVubmVyLmN1cnJlbnRTdWJmbG93SWQgPSBub2RlLnN1YmZsb3dJZDtcblxuICAgICAgICBsZXQgc3ViZmxvd091dHB1dDogYW55O1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHN1YmZsb3dPdXRwdXQgPSBhd2FpdCB0aGlzLnN1YmZsb3dFeGVjdXRvci5leGVjdXRlU3ViZmxvdyhcbiAgICAgICAgICAgIHJlc29sdmVkTm9kZSxcbiAgICAgICAgICAgIGNvbnRleHQsXG4gICAgICAgICAgICBicmVha0ZsYWcsXG4gICAgICAgICAgICBicmFuY2hQYXRoLFxuICAgICAgICAgICAgdGhpcy5zdWJmbG93UmVzdWx0cyxcbiAgICAgICAgICAgIHRyYXZlcnNhbENvbnRleHQsXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICB0aGlzLmV4dHJhY3RvclJ1bm5lci5jdXJyZW50U3ViZmxvd0lkID0gcHJldmlvdXNTdWJmbG93SWQ7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBpc1JlZmVyZW5jZUJhc2VkU3ViZmxvdyA9IHJlc29sdmVkTm9kZSAhPT0gbm9kZTtcbiAgICAgICAgY29uc3QgaGFzQ2hpbGRyZW4gPSBCb29sZWFuKG5vZGUuY2hpbGRyZW4gJiYgbm9kZS5jaGlsZHJlbi5sZW5ndGggPiAwKTtcbiAgICAgICAgY29uc3Qgc2hvdWxkRXhlY3V0ZUNvbnRpbnVhdGlvbiA9IGlzUmVmZXJlbmNlQmFzZWRTdWJmbG93IHx8IGhhc0NoaWxkcmVuO1xuXG4gICAgICAgIGlmIChub2RlLm5leHQgJiYgc2hvdWxkRXhlY3V0ZUNvbnRpbnVhdGlvbikge1xuICAgICAgICAgIGNvbnN0IG5leHRDdHggPSBjb250ZXh0LmNyZWF0ZU5leHQoYnJhbmNoUGF0aCBhcyBzdHJpbmcsIG5vZGUubmV4dC5uYW1lLCBub2RlLm5leHQuaWQpO1xuICAgICAgICAgIHJldHVybiBhd2FpdCB0aGlzLmV4ZWN1dGVOb2RlKG5vZGUubmV4dCwgbmV4dEN0eCwgYnJlYWtGbGFnLCBicmFuY2hQYXRoKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBzdWJmbG93T3V0cHV0O1xuICAgICAgfVxuXG4gICAgICBjb25zdCBzdGFnZUZ1bmMgPSB0aGlzLmdldFN0YWdlRm4obm9kZSk7XG4gICAgICBjb25zdCBoYXNTdGFnZUZ1bmN0aW9uID0gQm9vbGVhbihzdGFnZUZ1bmMpO1xuICAgICAgY29uc3QgaXNTY29wZUJhc2VkRGVjaWRlciA9IEJvb2xlYW4obm9kZS5kZWNpZGVyRm4pO1xuICAgICAgY29uc3QgaXNTY29wZUJhc2VkU2VsZWN0b3IgPSBCb29sZWFuKG5vZGUuc2VsZWN0b3JGbik7XG4gICAgICBjb25zdCBpc0RlY2lkZXJOb2RlID0gaXNTY29wZUJhc2VkRGVjaWRlcjtcbiAgICAgIGNvbnN0IGhhc0NoaWxkcmVuID0gQm9vbGVhbihub2RlLmNoaWxkcmVuPy5sZW5ndGgpO1xuICAgICAgY29uc3QgaGFzTmV4dCA9IEJvb2xlYW4obm9kZS5uZXh0KTtcbiAgICAgIGNvbnN0IG9yaWdpbmFsTmV4dCA9IG5vZGUubmV4dDtcblxuICAgICAgLy8g4pSA4pSA4pSAIFBoYXNlIDE6IFZBTElEQVRFIOKAlCBub2RlIGludmFyaWFudHMg4pSA4pSA4pSAXG4gICAgICBpZiAoIWhhc1N0YWdlRnVuY3Rpb24gJiYgIWlzRGVjaWRlck5vZGUgJiYgIWlzU2NvcGVCYXNlZFNlbGVjdG9yICYmICFoYXNDaGlsZHJlbikge1xuICAgICAgICBjb25zdCBlcnJvck1lc3NhZ2UgPSBgTm9kZSAnJHtub2RlLm5hbWV9JyBtdXN0IGRlZmluZTogZW1iZWRkZWQgZm4gT1IgYSBzdGFnZU1hcCBlbnRyeSBPUiBoYXZlIGNoaWxkcmVuL2RlY2lkZXJgO1xuICAgICAgICB0aGlzLmxvZ2dlci5lcnJvcihgRXJyb3IgaW4gcGlwZWxpbmUgKCR7YnJhbmNoUGF0aH0pIHN0YWdlIFske25vZGUubmFtZX1dOmAsIHsgZXJyb3I6IGVycm9yTWVzc2FnZSB9KTtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGVycm9yTWVzc2FnZSk7XG4gICAgICB9XG4gICAgICBpZiAoaXNEZWNpZGVyTm9kZSAmJiAhaGFzQ2hpbGRyZW4pIHtcbiAgICAgICAgY29uc3QgZXJyb3JNZXNzYWdlID0gJ0RlY2lkZXIgbm9kZSBuZWVkcyB0byBoYXZlIGNoaWxkcmVuIHRvIGV4ZWN1dGUnO1xuICAgICAgICB0aGlzLmxvZ2dlci5lcnJvcihgRXJyb3IgaW4gcGlwZWxpbmUgKCR7YnJhbmNoUGF0aH0pIHN0YWdlIFske25vZGUubmFtZX1dOmAsIHsgZXJyb3I6IGVycm9yTWVzc2FnZSB9KTtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGVycm9yTWVzc2FnZSk7XG4gICAgICB9XG4gICAgICBpZiAoaXNTY29wZUJhc2VkU2VsZWN0b3IgJiYgIWhhc0NoaWxkcmVuKSB7XG4gICAgICAgIGNvbnN0IGVycm9yTWVzc2FnZSA9ICdTZWxlY3RvciBub2RlIG5lZWRzIHRvIGhhdmUgY2hpbGRyZW4gdG8gZXhlY3V0ZSc7XG4gICAgICAgIHRoaXMubG9nZ2VyLmVycm9yKGBFcnJvciBpbiBwaXBlbGluZSAoJHticmFuY2hQYXRofSkgc3RhZ2UgWyR7bm9kZS5uYW1lfV06YCwgeyBlcnJvcjogZXJyb3JNZXNzYWdlIH0pO1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoZXJyb3JNZXNzYWdlKTtcbiAgICAgIH1cblxuICAgICAgLy8gUm9sZSBtYXJrZXJzIGZvciBkZWJ1ZyBwYW5lbHNcbiAgICAgIGlmICghaGFzU3RhZ2VGdW5jdGlvbikge1xuICAgICAgICBpZiAoaXNEZWNpZGVyTm9kZSkgY29udGV4dC5zZXRBc0RlY2lkZXIoKTtcbiAgICAgICAgZWxzZSBpZiAoaGFzQ2hpbGRyZW4pIGNvbnRleHQuc2V0QXNGb3JrKCk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGJyZWFrRm4gPSAoKSA9PiAoYnJlYWtGbGFnLnNob3VsZEJyZWFrID0gdHJ1ZSk7XG5cbiAgICAgIC8vIOKUgOKUgOKUgCBQaGFzZSAyYTogU0VMRUNUT1Ig4oCUIHNjb3BlLWJhc2VkIG11bHRpLWNob2ljZSDilIDilIDilIBcbiAgICAgIGlmIChpc1Njb3BlQmFzZWRTZWxlY3Rvcikge1xuICAgICAgICBjb25zdCBwcmV2aW91c0ZvcmtJZCA9IHRoaXMuZXh0cmFjdG9yUnVubmVyLmN1cnJlbnRGb3JrSWQ7XG4gICAgICAgIHRoaXMuZXh0cmFjdG9yUnVubmVyLmN1cnJlbnRGb3JrSWQgPSBub2RlLmlkO1xuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3Qgc2VsZWN0b3JSZXN1bHQgPSBhd2FpdCB0aGlzLnNlbGVjdG9ySGFuZGxlci5oYW5kbGVTY29wZUJhc2VkKFxuICAgICAgICAgICAgbm9kZSxcbiAgICAgICAgICAgIHN0YWdlRnVuYyEsXG4gICAgICAgICAgICBjb250ZXh0LFxuICAgICAgICAgICAgYnJlYWtGbGFnLFxuICAgICAgICAgICAgYnJhbmNoUGF0aCxcbiAgICAgICAgICAgIHRoaXMuZXhlY3V0ZVN0YWdlLmJpbmQodGhpcyksXG4gICAgICAgICAgICB0aGlzLmV4ZWN1dGVOb2RlLmJpbmQodGhpcyksXG4gICAgICAgICAgICB0aGlzLmV4dHJhY3RvclJ1bm5lci5jYWxsRXh0cmFjdG9yLmJpbmQodGhpcy5leHRyYWN0b3JSdW5uZXIpLFxuICAgICAgICAgICAgdGhpcy5leHRyYWN0b3JSdW5uZXIuZ2V0U3RhZ2VQYXRoLmJpbmQodGhpcy5leHRyYWN0b3JSdW5uZXIpLFxuICAgICAgICAgICAgdHJhdmVyc2FsQ29udGV4dCxcbiAgICAgICAgICApO1xuXG4gICAgICAgICAgaWYgKGhhc05leHQpIHtcbiAgICAgICAgICAgIGNvbnN0IG5leHRDdHggPSBjb250ZXh0LmNyZWF0ZU5leHQoYnJhbmNoUGF0aCBhcyBzdHJpbmcsIG5vZGUubmV4dCEubmFtZSwgbm9kZS5uZXh0IS5pZCk7XG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgdGhpcy5leGVjdXRlTm9kZShub2RlLm5leHQhLCBuZXh0Q3R4LCBicmVha0ZsYWcsIGJyYW5jaFBhdGgpO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gc2VsZWN0b3JSZXN1bHQ7XG4gICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgdGhpcy5leHRyYWN0b3JSdW5uZXIuY3VycmVudEZvcmtJZCA9IHByZXZpb3VzRm9ya0lkO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIOKUgOKUgOKUgCBQaGFzZSAyYjogREVDSURFUiDigJQgc2NvcGUtYmFzZWQgc2luZ2xlLWNob2ljZSBjb25kaXRpb25hbCBicmFuY2gg4pSA4pSA4pSAXG4gICAgICBpZiAoaXNEZWNpZGVyTm9kZSkge1xuICAgICAgICBjb25zdCBkZWNpZGVyUmVzdWx0ID0gYXdhaXQgdGhpcy5kZWNpZGVySGFuZGxlci5oYW5kbGVTY29wZUJhc2VkKFxuICAgICAgICAgIG5vZGUsXG4gICAgICAgICAgc3RhZ2VGdW5jISxcbiAgICAgICAgICBjb250ZXh0LFxuICAgICAgICAgIGJyZWFrRmxhZyxcbiAgICAgICAgICBicmFuY2hQYXRoLFxuICAgICAgICAgIHRoaXMuZXhlY3V0ZVN0YWdlLmJpbmQodGhpcyksXG4gICAgICAgICAgdGhpcy5leGVjdXRlTm9kZS5iaW5kKHRoaXMpLFxuICAgICAgICAgIHRoaXMuZXh0cmFjdG9yUnVubmVyLmNhbGxFeHRyYWN0b3IuYmluZCh0aGlzLmV4dHJhY3RvclJ1bm5lciksXG4gICAgICAgICAgdGhpcy5leHRyYWN0b3JSdW5uZXIuZ2V0U3RhZ2VQYXRoLmJpbmQodGhpcy5leHRyYWN0b3JSdW5uZXIpLFxuICAgICAgICAgIHRyYXZlcnNhbENvbnRleHQsXG4gICAgICAgICk7XG5cbiAgICAgICAgLy8gQWZ0ZXIgYnJhbmNoIGV4ZWN1dGlvbiwgZm9sbG93IGRlY2lkZXIncyBvd24gbmV4dCAoZS5nLiwgbG9vcFRvIHRhcmdldClcbiAgICAgICAgaWYgKGhhc05leHQgJiYgIWJyZWFrRmxhZy5zaG91bGRCcmVhaykge1xuICAgICAgICAgIGNvbnN0IG5leHROb2RlID0gb3JpZ2luYWxOZXh0ITtcbiAgICAgICAgICAvLyBVc2UgdGhlIGlzTG9vcFJlZiBmbGFnIHNldCBieSBsb29wVG8oKSDigJQgZG8gbm90IHJlbHkgb24gc3RhZ2VNYXAgYWJzZW5jZSxcbiAgICAgICAgICAvLyBzaW5jZSBpZC1rZXllZCBzdGFnZU1hcHMgd291bGQgb3RoZXJ3aXNlIGNhdXNlIGxvb3AgdGFyZ2V0cyB0byBiZSBleGVjdXRlZCBkaXJlY3RseS5cbiAgICAgICAgICBjb25zdCBpc0xvb3BSZWYgPVxuICAgICAgICAgICAgbmV4dE5vZGUuaXNMb29wUmVmID09PSB0cnVlIHx8XG4gICAgICAgICAgICAoIXRoaXMuZ2V0U3RhZ2VGbihuZXh0Tm9kZSkgJiZcbiAgICAgICAgICAgICAgIW5leHROb2RlLmNoaWxkcmVuPy5sZW5ndGggJiZcbiAgICAgICAgICAgICAgIW5leHROb2RlLmRlY2lkZXJGbiAmJlxuICAgICAgICAgICAgICAhbmV4dE5vZGUuc2VsZWN0b3JGbiAmJlxuICAgICAgICAgICAgICAhbmV4dE5vZGUuaXNTdWJmbG93Um9vdCk7XG5cbiAgICAgICAgICBpZiAoaXNMb29wUmVmKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5jb250aW51YXRpb25SZXNvbHZlci5yZXNvbHZlKFxuICAgICAgICAgICAgICBuZXh0Tm9kZSxcbiAgICAgICAgICAgICAgbm9kZSxcbiAgICAgICAgICAgICAgY29udGV4dCxcbiAgICAgICAgICAgICAgYnJlYWtGbGFnLFxuICAgICAgICAgICAgICBicmFuY2hQYXRoLFxuICAgICAgICAgICAgICB0aGlzLmV4ZWN1dGVOb2RlLmJpbmQodGhpcyksXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIHRoaXMubmFycmF0aXZlR2VuZXJhdG9yLm9uTmV4dChub2RlLm5hbWUsIG5leHROb2RlLm5hbWUsIG5leHROb2RlLmRlc2NyaXB0aW9uLCB0cmF2ZXJzYWxDb250ZXh0KTtcbiAgICAgICAgICBjb25zdCBuZXh0Q3R4ID0gY29udGV4dC5jcmVhdGVOZXh0KGJyYW5jaFBhdGggYXMgc3RyaW5nLCBuZXh0Tm9kZS5uYW1lLCBuZXh0Tm9kZS5pZCk7XG4gICAgICAgICAgcmV0dXJuIGF3YWl0IHRoaXMuZXhlY3V0ZU5vZGUobmV4dE5vZGUsIG5leHRDdHgsIGJyZWFrRmxhZywgYnJhbmNoUGF0aCk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gZGVjaWRlclJlc3VsdDtcbiAgICAgIH1cblxuICAgICAgLy8g4pSA4pSA4pSAIEFib3J0IGNoZWNrIOKAlCBjb29wZXJhdGl2ZSBjYW5jZWxsYXRpb24g4pSA4pSA4pSAXG4gICAgICBpZiAodGhpcy5zaWduYWw/LmFib3J0ZWQpIHtcbiAgICAgICAgY29uc3QgcmVhc29uID1cbiAgICAgICAgICB0aGlzLnNpZ25hbC5yZWFzb24gaW5zdGFuY2VvZiBFcnJvciA/IHRoaXMuc2lnbmFsLnJlYXNvbiA6IG5ldyBFcnJvcih0aGlzLnNpZ25hbC5yZWFzb24gPz8gJ0Fib3J0ZWQnKTtcbiAgICAgICAgdGhyb3cgcmVhc29uO1xuICAgICAgfVxuXG4gICAgICAvLyDilIDilIDilIAgUGhhc2UgMzogRVhFQ1VURSDigJQgcnVuIHN0YWdlIGZ1bmN0aW9uIOKUgOKUgOKUgFxuICAgICAgbGV0IHN0YWdlT3V0cHV0OiBUT3V0IHwgdW5kZWZpbmVkO1xuICAgICAgbGV0IGR5bmFtaWNOZXh0OiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiB8IHVuZGVmaW5lZDtcblxuICAgICAgaWYgKHN0YWdlRnVuYykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHN0YWdlT3V0cHV0ID0gYXdhaXQgdGhpcy5leGVjdXRlU3RhZ2Uobm9kZSwgc3RhZ2VGdW5jLCBjb250ZXh0LCBicmVha0ZuKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3I6IGFueSkge1xuICAgICAgICAgIC8vIFBhdXNlU2lnbmFsIGlzIGV4cGVjdGVkIGNvbnRyb2wgZmxvdywgbm90IGFuIGVycm9yIOKAlCBmaXJlIG5hcnJhdGl2ZSwgY29tbWl0LCByZS10aHJvdy5cbiAgICAgICAgICBpZiAoaXNQYXVzZVNpZ25hbChlcnJvcikpIHtcbiAgICAgICAgICAgIGNvbnRleHQuY29tbWl0KCk7XG4gICAgICAgICAgICB0aGlzLm5hcnJhdGl2ZUdlbmVyYXRvci5vblBhdXNlKG5vZGUubmFtZSwgbm9kZS5pZCwgZXJyb3IucGF1c2VEYXRhLCBlcnJvci5zdWJmbG93UGF0aCwgdHJhdmVyc2FsQ29udGV4dCk7XG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29udGV4dC5jb21taXQoKTtcbiAgICAgICAgICB0aGlzLmV4dHJhY3RvclJ1bm5lci5jYWxsRXh0cmFjdG9yKFxuICAgICAgICAgICAgbm9kZSxcbiAgICAgICAgICAgIGNvbnRleHQsXG4gICAgICAgICAgICB0aGlzLmV4dHJhY3RvclJ1bm5lci5nZXRTdGFnZVBhdGgobm9kZSwgYnJhbmNoUGF0aCwgY29udGV4dC5zdGFnZU5hbWUpLFxuICAgICAgICAgICAgdW5kZWZpbmVkLFxuICAgICAgICAgICAgeyB0eXBlOiAnc3RhZ2VFeGVjdXRpb25FcnJvcicsIG1lc3NhZ2U6IGVycm9yLnRvU3RyaW5nKCkgfSxcbiAgICAgICAgICApO1xuICAgICAgICAgIHRoaXMubmFycmF0aXZlR2VuZXJhdG9yLm9uRXJyb3Iobm9kZS5uYW1lLCBlcnJvci50b1N0cmluZygpLCBlcnJvciwgdHJhdmVyc2FsQ29udGV4dCk7XG4gICAgICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoYEVycm9yIGluIHBpcGVsaW5lICgke2JyYW5jaFBhdGh9KSBzdGFnZSBbJHtub2RlLm5hbWV9XTpgLCB7IGVycm9yIH0pO1xuICAgICAgICAgIGNvbnRleHQuYWRkRXJyb3IoJ3N0YWdlRXhlY3V0aW9uRXJyb3InLCBlcnJvci50b1N0cmluZygpKTtcbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgICAgICBjb250ZXh0LmNvbW1pdCgpO1xuICAgICAgICB0aGlzLmV4dHJhY3RvclJ1bm5lci5jYWxsRXh0cmFjdG9yKFxuICAgICAgICAgIG5vZGUsXG4gICAgICAgICAgY29udGV4dCxcbiAgICAgICAgICB0aGlzLmV4dHJhY3RvclJ1bm5lci5nZXRTdGFnZVBhdGgobm9kZSwgYnJhbmNoUGF0aCwgY29udGV4dC5zdGFnZU5hbWUpLFxuICAgICAgICAgIHN0YWdlT3V0cHV0LFxuICAgICAgICApO1xuICAgICAgICB0aGlzLm5hcnJhdGl2ZUdlbmVyYXRvci5vblN0YWdlRXhlY3V0ZWQobm9kZS5uYW1lLCBub2RlLmRlc2NyaXB0aW9uLCB0cmF2ZXJzYWxDb250ZXh0KTtcblxuICAgICAgICBpZiAoYnJlYWtGbGFnLnNob3VsZEJyZWFrKSB7XG4gICAgICAgICAgdGhpcy5uYXJyYXRpdmVHZW5lcmF0b3Iub25CcmVhayhub2RlLm5hbWUsIHRyYXZlcnNhbENvbnRleHQpO1xuICAgICAgICAgIHRoaXMubG9nZ2VyLmluZm8oYEV4ZWN1dGlvbiBzdG9wcGVkIGluIHBpcGVsaW5lICgke2JyYW5jaFBhdGh9KSBhZnRlciAke25vZGUubmFtZX0gZHVlIHRvIGJyZWFrIGNvbmRpdGlvbi5gKTtcbiAgICAgICAgICByZXR1cm4gc3RhZ2VPdXRwdXQ7XG4gICAgICAgIH1cblxuICAgICAgICAvLyDilIDilIDilIAgUGhhc2UgNDogRFlOQU1JQyDigJQgU3RhZ2VOb2RlIHJldHVybiBkZXRlY3Rpb24g4pSA4pSA4pSAXG4gICAgICAgIGlmIChzdGFnZU91dHB1dCAmJiB0eXBlb2Ygc3RhZ2VPdXRwdXQgPT09ICdvYmplY3QnICYmIGlzU3RhZ2VOb2RlUmV0dXJuKHN0YWdlT3V0cHV0KSkge1xuICAgICAgICAgIGNvbnN0IGR5bmFtaWNOb2RlID0gc3RhZ2VPdXRwdXQgYXMgU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT47XG4gICAgICAgICAgY29udGV4dC5hZGRMb2coJ2lzRHluYW1pYycsIHRydWUpO1xuICAgICAgICAgIGNvbnRleHQuYWRkTG9nKCdkeW5hbWljUGF0dGVybicsICdTdGFnZU5vZGVSZXR1cm4nKTtcblxuICAgICAgICAgIC8vIER5bmFtaWMgc3ViZmxvdyBhdXRvLXJlZ2lzdHJhdGlvblxuICAgICAgICAgIGlmIChkeW5hbWljTm9kZS5pc1N1YmZsb3dSb290ICYmIGR5bmFtaWNOb2RlLnN1YmZsb3dEZWYgJiYgZHluYW1pY05vZGUuc3ViZmxvd0lkKSB7XG4gICAgICAgICAgICBjb250ZXh0LmFkZExvZygnZHluYW1pY1BhdHRlcm4nLCAnZHluYW1pY1N1YmZsb3cnKTtcbiAgICAgICAgICAgIGNvbnRleHQuYWRkTG9nKCdkeW5hbWljU3ViZmxvd0lkJywgZHluYW1pY05vZGUuc3ViZmxvd0lkKTtcblxuICAgICAgICAgICAgLy8gU3RydWN0dXJhbC1vbmx5IHN1YmZsb3c6IGhhcyBidWlsZFRpbWVTdHJ1Y3R1cmUgYnV0IG5vIGV4ZWN1dGFibGUgcm9vdC5cbiAgICAgICAgICAgIC8vIFVzZWQgZm9yIHByZS1leGVjdXRlZCBzdWJmbG93cyAoZS5nLiwgaW5uZXIgZmxvd3MgdGhhdCBhbHJlYWR5IHJhbikuXG4gICAgICAgICAgICAvLyBBbm5vdGF0ZXMgdGhlIG5vZGUgZm9yIHZpc3VhbGl6YXRpb24gd2l0aG91dCByZS1leGVjdXRpbmcuXG4gICAgICAgICAgICBpZiAoIWR5bmFtaWNOb2RlLnN1YmZsb3dEZWYucm9vdCkge1xuICAgICAgICAgICAgICBjb250ZXh0LmFkZExvZygnZHluYW1pY1BhdHRlcm4nLCAnc3RydWN0dXJhbFN1YmZsb3cnKTtcbiAgICAgICAgICAgICAgbm9kZS5pc1N1YmZsb3dSb290ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgbm9kZS5zdWJmbG93SWQgPSBkeW5hbWljTm9kZS5zdWJmbG93SWQ7XG4gICAgICAgICAgICAgIG5vZGUuc3ViZmxvd05hbWUgPSBkeW5hbWljTm9kZS5zdWJmbG93TmFtZTtcbiAgICAgICAgICAgICAgbm9kZS5kZXNjcmlwdGlvbiA9IGR5bmFtaWNOb2RlLmRlc2NyaXB0aW9uID8/IG5vZGUuZGVzY3JpcHRpb247XG5cbiAgICAgICAgICAgICAgdGhpcy5zdHJ1Y3R1cmVNYW5hZ2VyLnVwZGF0ZUR5bmFtaWNTdWJmbG93KFxuICAgICAgICAgICAgICAgIG5vZGUuaWQsXG4gICAgICAgICAgICAgICAgZHluYW1pY05vZGUuc3ViZmxvd0lkISxcbiAgICAgICAgICAgICAgICBkeW5hbWljTm9kZS5zdWJmbG93TmFtZSxcbiAgICAgICAgICAgICAgICBkeW5hbWljTm9kZS5zdWJmbG93RGVmLmJ1aWxkVGltZVN0cnVjdHVyZSxcbiAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAvLyBGYWxsIHRocm91Z2ggdG8gUGhhc2UgNSAoY29udGludWF0aW9uKSDigJQgbm8gc3ViZmxvdyBleGVjdXRpb24gbmVlZGVkXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAvLyBGdWxsIGR5bmFtaWMgc3ViZmxvdzogcmVnaXN0ZXIgKyBleGVjdXRlXG4gICAgICAgICAgICAgIHRoaXMuYXV0b1JlZ2lzdGVyU3ViZmxvd0RlZihkeW5hbWljTm9kZS5zdWJmbG93SWQsIGR5bmFtaWNOb2RlLnN1YmZsb3dEZWYsIG5vZGUuaWQpO1xuXG4gICAgICAgICAgICAgIG5vZGUuaXNTdWJmbG93Um9vdCA9IHRydWU7XG4gICAgICAgICAgICAgIG5vZGUuc3ViZmxvd0lkID0gZHluYW1pY05vZGUuc3ViZmxvd0lkO1xuICAgICAgICAgICAgICBub2RlLnN1YmZsb3dOYW1lID0gZHluYW1pY05vZGUuc3ViZmxvd05hbWU7XG4gICAgICAgICAgICAgIG5vZGUuc3ViZmxvd01vdW50T3B0aW9ucyA9IGR5bmFtaWNOb2RlLnN1YmZsb3dNb3VudE9wdGlvbnM7XG5cbiAgICAgICAgICAgICAgdGhpcy5zdHJ1Y3R1cmVNYW5hZ2VyLnVwZGF0ZUR5bmFtaWNTdWJmbG93KFxuICAgICAgICAgICAgICAgIG5vZGUuaWQsXG4gICAgICAgICAgICAgICAgZHluYW1pY05vZGUuc3ViZmxvd0lkISxcbiAgICAgICAgICAgICAgICBkeW5hbWljTm9kZS5zdWJmbG93TmFtZSxcbiAgICAgICAgICAgICAgICBkeW5hbWljTm9kZS5zdWJmbG93RGVmPy5idWlsZFRpbWVTdHJ1Y3R1cmUsXG4gICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IHRoaXMuZXhlY3V0ZU5vZGUobm9kZSwgY29udGV4dCwgYnJlYWtGbGFnLCBicmFuY2hQYXRoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBDaGVjayBjaGlsZHJlbiBmb3Igc3ViZmxvd0RlZlxuICAgICAgICAgIGlmIChkeW5hbWljTm9kZS5jaGlsZHJlbikge1xuICAgICAgICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBkeW5hbWljTm9kZS5jaGlsZHJlbikge1xuICAgICAgICAgICAgICBpZiAoY2hpbGQuaXNTdWJmbG93Um9vdCAmJiBjaGlsZC5zdWJmbG93RGVmICYmIGNoaWxkLnN1YmZsb3dJZCkge1xuICAgICAgICAgICAgICAgIHRoaXMuYXV0b1JlZ2lzdGVyU3ViZmxvd0RlZihjaGlsZC5zdWJmbG93SWQsIGNoaWxkLnN1YmZsb3dEZWYsIGNoaWxkLmlkKTtcbiAgICAgICAgICAgICAgICB0aGlzLnN0cnVjdHVyZU1hbmFnZXIudXBkYXRlRHluYW1pY1N1YmZsb3coXG4gICAgICAgICAgICAgICAgICBjaGlsZC5pZCxcbiAgICAgICAgICAgICAgICAgIGNoaWxkLnN1YmZsb3dJZCEsXG4gICAgICAgICAgICAgICAgICBjaGlsZC5zdWJmbG93TmFtZSxcbiAgICAgICAgICAgICAgICAgIGNoaWxkLnN1YmZsb3dEZWY/LmJ1aWxkVGltZVN0cnVjdHVyZSxcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gRHluYW1pYyBjaGlsZHJlbiAoZm9yayBwYXR0ZXJuKVxuICAgICAgICAgIGlmIChkeW5hbWljTm9kZS5jaGlsZHJlbiAmJiBkeW5hbWljTm9kZS5jaGlsZHJlbi5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBub2RlLmNoaWxkcmVuID0gZHluYW1pY05vZGUuY2hpbGRyZW47XG4gICAgICAgICAgICBjb250ZXh0LmFkZExvZygnZHluYW1pY0NoaWxkQ291bnQnLCBkeW5hbWljTm9kZS5jaGlsZHJlbi5sZW5ndGgpO1xuICAgICAgICAgICAgY29udGV4dC5hZGRMb2coXG4gICAgICAgICAgICAgICdkeW5hbWljQ2hpbGRJZHMnLFxuICAgICAgICAgICAgICBkeW5hbWljTm9kZS5jaGlsZHJlbi5tYXAoKGMpID0+IGMuaWQpLFxuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgdGhpcy5zdHJ1Y3R1cmVNYW5hZ2VyLnVwZGF0ZUR5bmFtaWNDaGlsZHJlbihcbiAgICAgICAgICAgICAgbm9kZS5pZCxcbiAgICAgICAgICAgICAgZHluYW1pY05vZGUuY2hpbGRyZW4sXG4gICAgICAgICAgICAgIEJvb2xlYW4oZHluYW1pY05vZGUubmV4dE5vZGVTZWxlY3RvciksXG4gICAgICAgICAgICAgIEJvb2xlYW4oZHluYW1pY05vZGUuZGVjaWRlckZuKSxcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmICh0eXBlb2YgZHluYW1pY05vZGUubmV4dE5vZGVTZWxlY3RvciA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICBub2RlLm5leHROb2RlU2VsZWN0b3IgPSBkeW5hbWljTm9kZS5uZXh0Tm9kZVNlbGVjdG9yO1xuICAgICAgICAgICAgICBjb250ZXh0LmFkZExvZygnaGFzU2VsZWN0b3InLCB0cnVlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBEeW5hbWljIG5leHQgKGxpbmVhciBjb250aW51YXRpb24pXG4gICAgICAgICAgaWYgKGR5bmFtaWNOb2RlLm5leHQpIHtcbiAgICAgICAgICAgIGR5bmFtaWNOZXh0ID0gZHluYW1pY05vZGUubmV4dDtcbiAgICAgICAgICAgIHRoaXMuc3RydWN0dXJlTWFuYWdlci51cGRhdGVEeW5hbWljTmV4dChub2RlLmlkLCBkeW5hbWljTm9kZS5uZXh0KTtcbiAgICAgICAgICAgIG5vZGUubmV4dCA9IGR5bmFtaWNOb2RlLm5leHQ7XG4gICAgICAgICAgICBjb250ZXh0LmFkZExvZygnaGFzRHluYW1pY05leHQnLCB0cnVlKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBzdGFnZU91dHB1dCA9IHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFJlc3RvcmUgb3JpZ2luYWwgbmV4dCB0byBhdm9pZCBzdGFsZSByZWZlcmVuY2Ugb24gbG9vcCByZXZpc2l0XG4gICAgICAgIGlmIChkeW5hbWljTmV4dCkge1xuICAgICAgICAgIG5vZGUubmV4dCA9IG9yaWdpbmFsTmV4dDtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyDilIDilIDilIAgUGhhc2UgNTogQ0hJTERSRU4g4oCUIGZvcmsgZGlzcGF0Y2gg4pSA4pSA4pSAXG4gICAgICBjb25zdCBoYXNDaGlsZHJlbkFmdGVyU3RhZ2UgPSBCb29sZWFuKG5vZGUuY2hpbGRyZW4/Lmxlbmd0aCk7XG5cbiAgICAgIGlmIChoYXNDaGlsZHJlbkFmdGVyU3RhZ2UpIHtcbiAgICAgICAgY29udGV4dC5hZGRMb2coJ3RvdGFsQ2hpbGRyZW4nLCBub2RlLmNoaWxkcmVuPy5sZW5ndGgpO1xuICAgICAgICBjb250ZXh0LmFkZExvZygnb3JkZXJPZkV4ZWN1dGlvbicsICdDaGlsZHJlbkFmdGVyU3RhZ2UnKTtcblxuICAgICAgICBsZXQgbm9kZUNoaWxkcmVuUmVzdWx0czogUmVjb3JkPHN0cmluZywgTm9kZVJlc3VsdFR5cGU+O1xuXG4gICAgICAgIGlmIChub2RlLm5leHROb2RlU2VsZWN0b3IpIHtcbiAgICAgICAgICBjb25zdCBwcmV2aW91c0ZvcmtJZCA9IHRoaXMuZXh0cmFjdG9yUnVubmVyLmN1cnJlbnRGb3JrSWQ7XG4gICAgICAgICAgdGhpcy5leHRyYWN0b3JSdW5uZXIuY3VycmVudEZvcmtJZCA9IG5vZGUuaWQ7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIG5vZGVDaGlsZHJlblJlc3VsdHMgPSBhd2FpdCB0aGlzLmNoaWxkcmVuRXhlY3V0b3IuZXhlY3V0ZVNlbGVjdGVkQ2hpbGRyZW4oXG4gICAgICAgICAgICAgIG5vZGUubmV4dE5vZGVTZWxlY3RvcixcbiAgICAgICAgICAgICAgbm9kZS5jaGlsZHJlbiEsXG4gICAgICAgICAgICAgIHN0YWdlT3V0cHV0LFxuICAgICAgICAgICAgICBjb250ZXh0LFxuICAgICAgICAgICAgICBicmFuY2hQYXRoIGFzIHN0cmluZyxcbiAgICAgICAgICAgICAgdHJhdmVyc2FsQ29udGV4dCxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgIHRoaXMuZXh0cmFjdG9yUnVubmVyLmN1cnJlbnRGb3JrSWQgPSBwcmV2aW91c0ZvcmtJZDtcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY29uc3QgY2hpbGRDb3VudCA9IG5vZGUuY2hpbGRyZW4/Lmxlbmd0aCA/PyAwO1xuICAgICAgICAgIGNvbnN0IGNoaWxkTmFtZXMgPSBub2RlLmNoaWxkcmVuPy5tYXAoKGMpID0+IGMubmFtZSkuam9pbignLCAnKTtcbiAgICAgICAgICBjb250ZXh0LmFkZEZsb3dEZWJ1Z01lc3NhZ2UoJ2NoaWxkcmVuJywgYEV4ZWN1dGluZyBhbGwgJHtjaGlsZENvdW50fSBjaGlsZHJlbiBpbiBwYXJhbGxlbDogJHtjaGlsZE5hbWVzfWAsIHtcbiAgICAgICAgICAgIGNvdW50OiBjaGlsZENvdW50LFxuICAgICAgICAgICAgdGFyZ2V0U3RhZ2U6IG5vZGUuY2hpbGRyZW4/Lm1hcCgoYykgPT4gYy5uYW1lKSxcbiAgICAgICAgICB9KTtcblxuICAgICAgICAgIGNvbnN0IHByZXZpb3VzRm9ya0lkID0gdGhpcy5leHRyYWN0b3JSdW5uZXIuY3VycmVudEZvcmtJZDtcbiAgICAgICAgICB0aGlzLmV4dHJhY3RvclJ1bm5lci5jdXJyZW50Rm9ya0lkID0gbm9kZS5pZDtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgbm9kZUNoaWxkcmVuUmVzdWx0cyA9IGF3YWl0IHRoaXMuY2hpbGRyZW5FeGVjdXRvci5leGVjdXRlTm9kZUNoaWxkcmVuKFxuICAgICAgICAgICAgICBub2RlLFxuICAgICAgICAgICAgICBjb250ZXh0LFxuICAgICAgICAgICAgICB1bmRlZmluZWQsXG4gICAgICAgICAgICAgIGJyYW5jaFBhdGgsXG4gICAgICAgICAgICAgIHRyYXZlcnNhbENvbnRleHQsXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICB0aGlzLmV4dHJhY3RvclJ1bm5lci5jdXJyZW50Rm9ya0lkID0gcHJldmlvdXNGb3JrSWQ7XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gRm9yay1vbmx5OiByZXR1cm4gYnVuZGxlXG4gICAgICAgIGlmICghaGFzTmV4dCAmJiAhZHluYW1pY05leHQpIHtcbiAgICAgICAgICByZXR1cm4gbm9kZUNoaWxkcmVuUmVzdWx0cyE7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBDYXB0dXJlIGR5bmFtaWMgY2hpbGRyZW4gYXMgc3ludGhldGljIHN1YmZsb3cgcmVzdWx0IGZvciBVSVxuICAgICAgICBjb25zdCBpc0R5bmFtaWMgPSBjb250ZXh0LmRlYnVnPy5sb2dDb250ZXh0Py5pc0R5bmFtaWM7XG4gICAgICAgIGlmIChpc0R5bmFtaWMgJiYgbm9kZS5jaGlsZHJlbiAmJiBub2RlLmNoaWxkcmVuLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICB0aGlzLmNhcHR1cmVEeW5hbWljQ2hpbGRyZW5SZXN1bHQobm9kZSwgY29udGV4dCk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8g4pSA4pSA4pSAIFBoYXNlIDY6IENPTlRJTlVFIOKAlCBkeW5hbWljIG5leHQgLyBsaW5lYXIgbmV4dCDilIDilIDilIBcbiAgICAgIGlmIChkeW5hbWljTmV4dCkge1xuICAgICAgICByZXR1cm4gdGhpcy5jb250aW51YXRpb25SZXNvbHZlci5yZXNvbHZlKFxuICAgICAgICAgIGR5bmFtaWNOZXh0LFxuICAgICAgICAgIG5vZGUsXG4gICAgICAgICAgY29udGV4dCxcbiAgICAgICAgICBicmVha0ZsYWcsXG4gICAgICAgICAgYnJhbmNoUGF0aCxcbiAgICAgICAgICB0aGlzLmV4ZWN1dGVOb2RlLmJpbmQodGhpcyksXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIGlmIChoYXNOZXh0KSB7XG4gICAgICAgIGNvbnN0IG5leHROb2RlID0gb3JpZ2luYWxOZXh0ITtcblxuICAgICAgICAvLyBEZXRlY3QgbG9vcCByZWZlcmVuY2Ugbm9kZXMgY3JlYXRlZCBieSBsb29wVG8oKSDigJQgbWFya2VkIHdpdGggaXNMb29wUmVmIGZsYWcuXG4gICAgICAgIC8vIFJvdXRlIHRocm91Z2ggQ29udGludWF0aW9uUmVzb2x2ZXIgZm9yIHByb3BlciBJRCByZXNvbHV0aW9uLCBpdGVyYXRpb25cbiAgICAgICAgLy8gdHJhY2tpbmcsIGFuZCBuYXJyYXRpdmUgZ2VuZXJhdGlvbi5cbiAgICAgICAgY29uc3QgaXNMb29wUmVmZXJlbmNlID0gbmV4dE5vZGUuaXNMb29wUmVmO1xuXG4gICAgICAgIGlmIChpc0xvb3BSZWZlcmVuY2UpIHtcbiAgICAgICAgICByZXR1cm4gdGhpcy5jb250aW51YXRpb25SZXNvbHZlci5yZXNvbHZlKFxuICAgICAgICAgICAgbmV4dE5vZGUsXG4gICAgICAgICAgICBub2RlLFxuICAgICAgICAgICAgY29udGV4dCxcbiAgICAgICAgICAgIGJyZWFrRmxhZyxcbiAgICAgICAgICAgIGJyYW5jaFBhdGgsXG4gICAgICAgICAgICB0aGlzLmV4ZWN1dGVOb2RlLmJpbmQodGhpcyksXG4gICAgICAgICAgICB0cmF2ZXJzYWxDb250ZXh0LFxuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLm5hcnJhdGl2ZUdlbmVyYXRvci5vbk5leHQobm9kZS5uYW1lLCBuZXh0Tm9kZS5uYW1lLCBuZXh0Tm9kZS5kZXNjcmlwdGlvbiwgdHJhdmVyc2FsQ29udGV4dCk7XG4gICAgICAgIGNvbnRleHQuYWRkRmxvd0RlYnVnTWVzc2FnZSgnbmV4dCcsIGBNb3ZpbmcgdG8gJHtuZXh0Tm9kZS5uYW1lfSBzdGFnZWAsIHtcbiAgICAgICAgICB0YXJnZXRTdGFnZTogbmV4dE5vZGUubmFtZSxcbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnN0IG5leHRDdHggPSBjb250ZXh0LmNyZWF0ZU5leHQoYnJhbmNoUGF0aCBhcyBzdHJpbmcsIG5leHROb2RlLm5hbWUsIG5leHROb2RlLmlkKTtcbiAgICAgICAgcmV0dXJuIGF3YWl0IHRoaXMuZXhlY3V0ZU5vZGUobmV4dE5vZGUsIG5leHRDdHgsIGJyZWFrRmxhZywgYnJhbmNoUGF0aCk7XG4gICAgICB9XG5cbiAgICAgIC8vIOKUgOKUgOKUgCBQaGFzZSA3OiBMRUFGIOKAlCBubyBjb250aW51YXRpb24g4pSA4pSA4pSAXG4gICAgICByZXR1cm4gc3RhZ2VPdXRwdXQ7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHRoaXMuX2V4ZWN1dGVEZXB0aC0tO1xuICAgIH1cbiAgfVxuXG4gIC8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCBQcml2YXRlIEhlbHBlcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgcHJpdmF0ZSBjYXB0dXJlRHluYW1pY0NoaWxkcmVuUmVzdWx0KG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+LCBjb250ZXh0OiBTdGFnZUNvbnRleHQpOiB2b2lkIHtcbiAgICBjb25zdCBwYXJlbnRTdGFnZUlkID0gY29udGV4dC5nZXRTdGFnZUlkKCk7XG5cbiAgICBjb25zdCBjaGlsZFN0cnVjdHVyZTogYW55ID0ge1xuICAgICAgaWQ6IGAke25vZGUuaWR9LWNoaWxkcmVuYCxcbiAgICAgIG5hbWU6ICdEeW5hbWljIENoaWxkcmVuJyxcbiAgICAgIHR5cGU6ICdmb3JrJyxcbiAgICAgIGNoaWxkcmVuOiBub2RlLmNoaWxkcmVuIS5tYXAoKGMpID0+ICh7XG4gICAgICAgIGlkOiBjLmlkLFxuICAgICAgICBuYW1lOiBjLm5hbWUsXG4gICAgICAgIHR5cGU6ICdzdGFnZScsXG4gICAgICB9KSksXG4gICAgfTtcblxuICAgIGNvbnN0IGNoaWxkU3RhZ2VzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICAgIGlmIChjb250ZXh0LmNoaWxkcmVuKSB7XG4gICAgICBmb3IgKGNvbnN0IGNoaWxkQ3R4IG9mIGNvbnRleHQuY2hpbGRyZW4pIHtcbiAgICAgICAgY29uc3Qgc25hcHNob3QgPSBjaGlsZEN0eC5nZXRTbmFwc2hvdCgpO1xuICAgICAgICBjaGlsZFN0YWdlc1tzbmFwc2hvdC5uYW1lIHx8IHNuYXBzaG90LmlkXSA9IHtcbiAgICAgICAgICBuYW1lOiBzbmFwc2hvdC5uYW1lLFxuICAgICAgICAgIG91dHB1dDogc25hcHNob3QubG9ncyxcbiAgICAgICAgICBlcnJvcnM6IHNuYXBzaG90LmVycm9ycyxcbiAgICAgICAgICBtZXRyaWNzOiBzbmFwc2hvdC5tZXRyaWNzLFxuICAgICAgICAgIHN0YXR1czogc25hcHNob3QuZXJyb3JzICYmIE9iamVjdC5rZXlzKHNuYXBzaG90LmVycm9ycykubGVuZ3RoID4gMCA/ICdlcnJvcicgOiAnc3VjY2VzcycsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfVxuXG4gICAgdGhpcy5zdWJmbG93UmVzdWx0cy5zZXQobm9kZS5pZCwge1xuICAgICAgc3ViZmxvd0lkOiBub2RlLmlkLFxuICAgICAgc3ViZmxvd05hbWU6IG5vZGUubmFtZSxcbiAgICAgIHRyZWVDb250ZXh0OiB7XG4gICAgICAgIGdsb2JhbENvbnRleHQ6IHt9LFxuICAgICAgICBzdGFnZUNvbnRleHRzOiBjaGlsZFN0YWdlcyBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgICAgICBoaXN0b3J5OiBbXSxcbiAgICAgIH0sXG4gICAgICBwYXJlbnRTdGFnZUlkLFxuICAgICAgcGlwZWxpbmVTdHJ1Y3R1cmU6IGNoaWxkU3RydWN0dXJlLFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBjb21wdXRlQ29udGV4dERlcHRoKGNvbnRleHQ6IFN0YWdlQ29udGV4dCk6IG51bWJlciB7XG4gICAgbGV0IGRlcHRoID0gMDtcbiAgICBsZXQgY3VycmVudCA9IGNvbnRleHQucGFyZW50O1xuICAgIHdoaWxlIChjdXJyZW50KSB7XG4gICAgICBkZXB0aCsrO1xuICAgICAgY3VycmVudCA9IGN1cnJlbnQucGFyZW50O1xuICAgIH1cbiAgICByZXR1cm4gZGVwdGg7XG4gIH1cblxuICBwcml2YXRlIHByZWZpeE5vZGVUcmVlKG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+LCBwcmVmaXg6IHN0cmluZyk6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+IHtcbiAgICBpZiAoIW5vZGUpIHJldHVybiBub2RlO1xuICAgIGNvbnN0IGNsb25lOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiA9IHsgLi4ubm9kZSB9O1xuICAgIGNsb25lLm5hbWUgPSBgJHtwcmVmaXh9LyR7bm9kZS5uYW1lfWA7XG4gICAgY2xvbmUuaWQgPSBgJHtwcmVmaXh9LyR7Y2xvbmUuaWR9YDtcbiAgICBpZiAoY2xvbmUuc3ViZmxvd0lkKSBjbG9uZS5zdWJmbG93SWQgPSBgJHtwcmVmaXh9LyR7Y2xvbmUuc3ViZmxvd0lkfWA7XG4gICAgaWYgKGNsb25lLm5leHQpIGNsb25lLm5leHQgPSB0aGlzLnByZWZpeE5vZGVUcmVlKGNsb25lLm5leHQsIHByZWZpeCk7XG4gICAgaWYgKGNsb25lLmNoaWxkcmVuKSB7XG4gICAgICBjbG9uZS5jaGlsZHJlbiA9IGNsb25lLmNoaWxkcmVuLm1hcCgoYykgPT4gdGhpcy5wcmVmaXhOb2RlVHJlZShjLCBwcmVmaXgpKTtcbiAgICB9XG4gICAgcmV0dXJuIGNsb25lO1xuICB9XG5cbiAgcHJpdmF0ZSBhdXRvUmVnaXN0ZXJTdWJmbG93RGVmKFxuICAgIHN1YmZsb3dJZDogc3RyaW5nLFxuICAgIHN1YmZsb3dEZWY6IE5vbk51bGxhYmxlPFN0YWdlTm9kZVsnc3ViZmxvd0RlZiddPixcbiAgICBtb3VudE5vZGVJZD86IHN0cmluZyxcbiAgKTogdm9pZCB7XG4gICAgLy8gdGhpcy5zdWJmbG93cyBpcyBhbHdheXMgaW5pdGlhbGl6ZWQgaW4gdGhlIGNvbnN0cnVjdG9yOyB0aGUgbnVsbCBndWFyZCBiZWxvdyBpcyB1bnJlYWNoYWJsZS5cbiAgICBjb25zdCBzdWJmbG93c0RpY3QgPSB0aGlzLnN1YmZsb3dzO1xuXG4gICAgLy8gRmlyc3Qtd3JpdGUtd2luc1xuICAgIGNvbnN0IGlzTmV3UmVnaXN0cmF0aW9uID0gIXN1YmZsb3dzRGljdFtzdWJmbG93SWRdO1xuICAgIGlmIChpc05ld1JlZ2lzdHJhdGlvbiAmJiBzdWJmbG93RGVmLnJvb3QpIHtcbiAgICAgIHN1YmZsb3dzRGljdFtzdWJmbG93SWRdID0ge1xuICAgICAgICByb290OiBzdWJmbG93RGVmLnJvb3QgYXMgU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4sXG4gICAgICAgIC4uLihzdWJmbG93RGVmLmJ1aWxkVGltZVN0cnVjdHVyZSA/IHsgYnVpbGRUaW1lU3RydWN0dXJlOiBzdWJmbG93RGVmLmJ1aWxkVGltZVN0cnVjdHVyZSB9IDoge30pLFxuICAgICAgfSBhcyBhbnk7XG4gICAgfVxuXG4gICAgLy8gTWVyZ2Ugc3RhZ2VNYXAgZW50cmllcyAocGFyZW50IGVudHJpZXMgcHJlc2VydmVkKVxuICAgIGlmIChzdWJmbG93RGVmLnN0YWdlTWFwKSB7XG4gICAgICBmb3IgKGNvbnN0IFtrZXksIGZuXSBvZiBBcnJheS5mcm9tKHN1YmZsb3dEZWYuc3RhZ2VNYXAuZW50cmllcygpKSkge1xuICAgICAgICBpZiAoIXRoaXMuc3RhZ2VNYXAuaGFzKGtleSkpIHtcbiAgICAgICAgICB0aGlzLnN0YWdlTWFwLnNldChrZXksIGZuIGFzIFN0YWdlRnVuY3Rpb248VE91dCwgVFNjb3BlPik7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBNZXJnZSBuZXN0ZWQgc3ViZmxvd3NcbiAgICBpZiAoc3ViZmxvd0RlZi5zdWJmbG93cykge1xuICAgICAgZm9yIChjb25zdCBba2V5LCBkZWZdIG9mIE9iamVjdC5lbnRyaWVzKHN1YmZsb3dEZWYuc3ViZmxvd3MpKSB7XG4gICAgICAgIGlmICghc3ViZmxvd3NEaWN0W2tleV0pIHtcbiAgICAgICAgICBzdWJmbG93c0RpY3Rba2V5XSA9IGRlZiBhcyB7IHJvb3Q6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+IH07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAobW91bnROb2RlSWQpIHtcbiAgICAgIHRoaXMuc3RydWN0dXJlTWFuYWdlci51cGRhdGVEeW5hbWljU3ViZmxvdyhcbiAgICAgICAgbW91bnROb2RlSWQsXG4gICAgICAgIHN1YmZsb3dJZCxcbiAgICAgICAgc3ViZmxvd0RlZi5yb290Py5zdWJmbG93TmFtZSB8fCBzdWJmbG93RGVmLnJvb3Q/Lm5hbWUsXG4gICAgICAgIHN1YmZsb3dEZWYuYnVpbGRUaW1lU3RydWN0dXJlLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBOb3RpZnkgRmxvd1JlY29yZGVycyBvbmx5IG9uIGZpcnN0IHJlZ2lzdHJhdGlvbiAobWF0Y2hlcyBmaXJzdC13cml0ZS13aW5zKVxuICAgIGlmIChpc05ld1JlZ2lzdHJhdGlvbikge1xuICAgICAgY29uc3Qgc3ViZmxvd05hbWUgPSBzdWJmbG93RGVmLnJvb3Q/LnN1YmZsb3dOYW1lIHx8IHN1YmZsb3dEZWYucm9vdD8ubmFtZSB8fCBzdWJmbG93SWQ7XG4gICAgICB0aGlzLm5hcnJhdGl2ZUdlbmVyYXRvci5vblN1YmZsb3dSZWdpc3RlcmVkKFxuICAgICAgICBzdWJmbG93SWQsXG4gICAgICAgIHN1YmZsb3dOYW1lLFxuICAgICAgICBzdWJmbG93RGVmLnJvb3Q/LmRlc2NyaXB0aW9uLFxuICAgICAgICBzdWJmbG93RGVmLmJ1aWxkVGltZVN0cnVjdHVyZSxcbiAgICAgICk7XG4gICAgfVxuICB9XG59XG4iXX0=