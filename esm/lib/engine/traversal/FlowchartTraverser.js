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
import { isPauseSignal } from '../../pause/types.js';
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
export class FlowchartTraverser {
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
        this.structureManager = new RuntimeStructureManager();
        this.structureManager.init(opts.buildTimeStructure);
        // Extractor runner
        this.extractorRunner = new ExtractorRunner(opts.extractor, (_b = opts.enrichSnapshots) !== null && _b !== void 0 ? _b : false, this.executionRuntime, this.logger);
        // Narrative generator
        // Priority: explicit narrativeGenerator > flowRecorders > default NarrativeFlowRecorder > null.
        // Subflow traversers receive the parent's narrativeGenerator so all events flow to one place.
        if (opts.narrativeGenerator) {
            this.narrativeGenerator = opts.narrativeGenerator;
        }
        else if (opts.narrativeEnabled) {
            const dispatcher = new FlowRecorderDispatcher();
            this.flowRecorderDispatcher = dispatcher;
            // If custom FlowRecorders are provided, use them; otherwise attach default NarrativeFlowRecorder
            if (opts.flowRecorders && opts.flowRecorders.length > 0) {
                for (const recorder of opts.flowRecorders) {
                    dispatcher.attach(recorder);
                }
            }
            else {
                dispatcher.attach(new NarrativeFlowRecorder());
            }
            this.narrativeGenerator = dispatcher;
        }
        else {
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
        this.continuationResolver = new ContinuationResolver(deps, this.nodeResolver, (nodeId, count) => this.structureManager.updateIterationCount(nodeId, count));
        this.deciderHandler = new DeciderHandler(deps);
        this.selectorHandler = new SelectorHandler(deps, this.childrenExecutor);
        this.subflowExecutor = new SubflowExecutor(deps, this.createSubflowTraverserFactory(opts));
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
                    if (isPauseSignal(error)) {
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
                if (stageOutput && typeof stageOutput === 'object' && isStageNodeReturn(stageOutput)) {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRmxvd2NoYXJ0VHJhdmVyc2VyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9lbmdpbmUvdHJhdmVyc2FsL0Zsb3djaGFydFRyYXZlcnNlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQW1CRztBQUdILE9BQU8sRUFBRSxhQUFhLEVBQUUsTUFBTSxzQkFBc0IsQ0FBQztBQUVyRCxPQUFPLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSx1QkFBdUIsQ0FBQztBQUMxRCxPQUFPLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxpQ0FBaUMsQ0FBQztBQUNuRSxPQUFPLEVBQUUsb0JBQW9CLEVBQUUsTUFBTSxxQ0FBcUMsQ0FBQztBQUMzRSxPQUFPLEVBQUUsY0FBYyxFQUFFLE1BQU0sK0JBQStCLENBQUM7QUFDL0QsT0FBTyxFQUFFLGVBQWUsRUFBRSxNQUFNLGdDQUFnQyxDQUFDO0FBQ2pFLE9BQU8sRUFBRSxZQUFZLEVBQUUsTUFBTSw2QkFBNkIsQ0FBQztBQUMzRCxPQUFPLEVBQUUsdUJBQXVCLEVBQUUsTUFBTSx3Q0FBd0MsQ0FBQztBQUNqRixPQUFPLEVBQUUsZUFBZSxFQUFFLE1BQU0sZ0NBQWdDLENBQUM7QUFDakUsT0FBTyxFQUFFLFdBQVcsRUFBRSxNQUFNLDRCQUE0QixDQUFDO0FBQ3pELE9BQU8sRUFBRSxlQUFlLEVBQUUsTUFBTSxnQ0FBZ0MsQ0FBQztBQUNqRSxPQUFPLEVBQUUsc0JBQXNCLEVBQUUsTUFBTSx3Q0FBd0MsQ0FBQztBQUNoRixPQUFPLEVBQUUscUJBQXFCLEVBQUUsTUFBTSx1Q0FBdUMsQ0FBQztBQUM5RSxPQUFPLEVBQUUsaUNBQWlDLEVBQUUsTUFBTSxtREFBbUQsQ0FBQztBQXlEdEcsTUFBTSxPQUFPLGtCQUFrQjtJQWlFN0IsWUFBWSxJQUFvQzs7UUEzQ2hELGtCQUFrQjtRQUNWLG1CQUFjLEdBQStCLElBQUksR0FBRyxFQUFFLENBQUM7UUFF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QUVELHdCQUF3QjtRQUN4QixJQUFJLFVBQVUsQ0FBQyxRQUFRLEVBQUUsQ0FBQztZQUN4QixLQUFLLE1BQU0sQ0FBQyxHQUFHLEVBQUUsR0FBRyxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQztnQkFDN0QsSUFBSSxDQUFDLFlBQVksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO29CQUN2QixZQUFZLENBQUMsR0FBRyxDQUFDLEdBQUcsR0FBd0MsQ0FBQztnQkFDL0QsQ0FBQztZQUNILENBQUM7UUFDSCxDQUFDO1FBRUQsSUFBSSxXQUFXLEVBQUUsQ0FBQztZQUNoQixJQUFJLENBQUMsZ0JBQWdCLENBQUMsb0JBQW9CLENBQ3hDLFdBQVcsRUFDWCxTQUFTLEVBQ1QsQ0FBQSxNQUFBLFVBQVUsQ0FBQyxJQUFJLDBDQUFFLFdBQVcsTUFBSSxNQUFBLFVBQVUsQ0FBQyxJQUFJLDBDQUFFLElBQUksQ0FBQSxFQUNyRCxVQUFVLENBQUMsa0JBQWtCLENBQzlCLENBQUM7UUFDSixDQUFDO1FBRUQsNkVBQTZFO1FBQzdFLElBQUksaUJBQWlCLEVBQUUsQ0FBQztZQUN0QixNQUFNLFdBQVcsR0FBRyxDQUFBLE1BQUEsVUFBVSxDQUFDLElBQUksMENBQUUsV0FBVyxNQUFJLE1BQUEsVUFBVSxDQUFDLElBQUksMENBQUUsSUFBSSxDQUFBLElBQUksU0FBUyxDQUFDO1lBQ3ZGLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxtQkFBbUIsQ0FDekMsU0FBUyxFQUNULFdBQVcsRUFDWCxNQUFBLFVBQVUsQ0FBQyxJQUFJLDBDQUFFLFdBQVcsRUFDNUIsVUFBVSxDQUFDLGtCQUFrQixDQUM5QixDQUFDO1FBQ0osQ0FBQztJQUNILENBQUM7O0FBaDFCRDs7Ozs7Ozs7Ozs7Ozs7Ozs7R0FpQkc7QUFDYSxvQ0FBaUIsR0FBRyxHQUFHLEFBQU4sQ0FBTyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogRmxvd2NoYXJ0VHJhdmVyc2VyIOKAlCBQcmUtb3JkZXIgREZTIHRyYXZlcnNhbCBvZiBTdGFnZU5vZGUgZ3JhcGguXG4gKlxuICogVW5pZmllZCB0cmF2ZXJzYWwgYWxnb3JpdGhtIGZvciBhbGwgbm9kZSBzaGFwZXM6XG4gKiAgIGNvbnN0IHByZSA9IGF3YWl0IHByZXAoKTtcbiAqICAgY29uc3QgW3gsIHldID0gYXdhaXQgUHJvbWlzZS5hbGwoW2Z4KHByZSksIGZ5KHByZSldKTtcbiAqICAgcmV0dXJuIGF3YWl0IG5leHQoeCwgeSk7XG4gKlxuICogRm9yIGVhY2ggbm9kZSwgZXhlY3V0ZU5vZGUgZm9sbG93cyA3IHBoYXNlczpcbiAqICAgMC4gQ0xBU1NJRlkgIOKAlCBzdWJmbG93IGRldGVjdGlvbiwgZWFybHkgZGVsZWdhdGlvblxuICogICAxLiBWQUxJREFURSAg4oCUIG5vZGUgaW52YXJpYW50cywgcm9sZSBtYXJrZXJzXG4gKiAgIDIuIEVYRUNVVEUgICDigJQgcnVuIHN0YWdlIGZuLCBjb21taXQsIGJyZWFrIGNoZWNrXG4gKiAgIDMuIERZTkFNSUMgICDigJQgU3RhZ2VOb2RlIHJldHVybiBkZXRlY3Rpb24sIHN1YmZsb3cgYXV0by1yZWdpc3RyYXRpb24sIHN0cnVjdHVyZSB1cGRhdGVzXG4gKiAgIDQuIENISUxEUkVOICDigJQgZm9yay9zZWxlY3Rvci9kZWNpZGVyIGRpc3BhdGNoXG4gKiAgIDUuIENPTlRJTlVFICDigJQgZHluYW1pYyBuZXh0IC8gbGluZWFyIG5leHQgcmVzb2x1dGlvblxuICogICA2LiBMRUFGICAgICAg4oCUIG5vIGNvbnRpbnVhdGlvbiwgcmV0dXJuIG91dHB1dFxuICpcbiAqIEJyZWFrIHNlbWFudGljczogSWYgYSBzdGFnZSBjYWxscyBicmVha0ZuKCksIGNvbW1pdCBhbmQgU1RPUC5cbiAqIFBhdGNoIG1vZGVsOiBTdGFnZSB3cml0ZXMgaW50byBsb2NhbCBwYXRjaDsgY29tbWl0UGF0Y2goKSBhZnRlciByZXR1cm4gb3IgdGhyb3cuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBTdGFnZUNvbnRleHQgfSBmcm9tICcuLi8uLi9tZW1vcnkvU3RhZ2VDb250ZXh0LmpzJztcbmltcG9ydCB7IGlzUGF1c2VTaWduYWwgfSBmcm9tICcuLi8uLi9wYXVzZS90eXBlcy5qcyc7XG5pbXBvcnQgdHlwZSB7IFNjb3BlUHJvdGVjdGlvbk1vZGUgfSBmcm9tICcuLi8uLi9zY29wZS9wcm90ZWN0aW9uL3R5cGVzLmpzJztcbmltcG9ydCB7IGlzU3RhZ2VOb2RlUmV0dXJuIH0gZnJvbSAnLi4vZ3JhcGgvU3RhZ2VOb2RlLmpzJztcbmltcG9ydCB7IENoaWxkcmVuRXhlY3V0b3IgfSBmcm9tICcuLi9oYW5kbGVycy9DaGlsZHJlbkV4ZWN1dG9yLmpzJztcbmltcG9ydCB7IENvbnRpbnVhdGlvblJlc29sdmVyIH0gZnJvbSAnLi4vaGFuZGxlcnMvQ29udGludWF0aW9uUmVzb2x2ZXIuanMnO1xuaW1wb3J0IHsgRGVjaWRlckhhbmRsZXIgfSBmcm9tICcuLi9oYW5kbGVycy9EZWNpZGVySGFuZGxlci5qcyc7XG5pbXBvcnQgeyBFeHRyYWN0b3JSdW5uZXIgfSBmcm9tICcuLi9oYW5kbGVycy9FeHRyYWN0b3JSdW5uZXIuanMnO1xuaW1wb3J0IHsgTm9kZVJlc29sdmVyIH0gZnJvbSAnLi4vaGFuZGxlcnMvTm9kZVJlc29sdmVyLmpzJztcbmltcG9ydCB7IFJ1bnRpbWVTdHJ1Y3R1cmVNYW5hZ2VyIH0gZnJvbSAnLi4vaGFuZGxlcnMvUnVudGltZVN0cnVjdHVyZU1hbmFnZXIuanMnO1xuaW1wb3J0IHsgU2VsZWN0b3JIYW5kbGVyIH0gZnJvbSAnLi4vaGFuZGxlcnMvU2VsZWN0b3JIYW5kbGVyLmpzJztcbmltcG9ydCB7IFN0YWdlUnVubmVyIH0gZnJvbSAnLi4vaGFuZGxlcnMvU3RhZ2VSdW5uZXIuanMnO1xuaW1wb3J0IHsgU3ViZmxvd0V4ZWN1dG9yIH0gZnJvbSAnLi4vaGFuZGxlcnMvU3ViZmxvd0V4ZWN1dG9yLmpzJztcbmltcG9ydCB7IEZsb3dSZWNvcmRlckRpc3BhdGNoZXIgfSBmcm9tICcuLi9uYXJyYXRpdmUvRmxvd1JlY29yZGVyRGlzcGF0Y2hlci5qcyc7XG5pbXBvcnQgeyBOYXJyYXRpdmVGbG93UmVjb3JkZXIgfSBmcm9tICcuLi9uYXJyYXRpdmUvTmFycmF0aXZlRmxvd1JlY29yZGVyLmpzJztcbmltcG9ydCB7IE51bGxDb250cm9sRmxvd05hcnJhdGl2ZUdlbmVyYXRvciB9IGZyb20gJy4uL25hcnJhdGl2ZS9OdWxsQ29udHJvbEZsb3dOYXJyYXRpdmVHZW5lcmF0b3IuanMnO1xuaW1wb3J0IHR5cGUgeyBGbG93UmVjb3JkZXIsIElDb250cm9sRmxvd05hcnJhdGl2ZSwgVHJhdmVyc2FsQ29udGV4dCB9IGZyb20gJy4uL25hcnJhdGl2ZS90eXBlcy5qcyc7XG5pbXBvcnQgdHlwZSB7XG4gIEV4dHJhY3RvckVycm9yLFxuICBIYW5kbGVyRGVwcyxcbiAgSUV4ZWN1dGlvblJ1bnRpbWUsXG4gIElMb2dnZXIsXG4gIE5vZGVSZXN1bHRUeXBlLFxuICBTY29wZUZhY3RvcnksXG4gIFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSxcbiAgU3RhZ2VGdW5jdGlvbixcbiAgU3RhZ2VOb2RlLFxuICBTdHJlYW1IYW5kbGVycyxcbiAgU3ViZmxvd1Jlc3VsdCxcbiAgU3ViZmxvd1RyYXZlcnNlckZhY3RvcnksXG4gIFRyYXZlcnNhbEV4dHJhY3RvcixcbiAgVHJhdmVyc2FsUmVzdWx0LFxufSBmcm9tICcuLi90eXBlcy5qcyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgVHJhdmVyc2VyT3B0aW9uczxUT3V0ID0gYW55LCBUU2NvcGUgPSBhbnk+IHtcbiAgcm9vdDogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT47XG4gIHN0YWdlTWFwOiBNYXA8c3RyaW5nLCBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4+O1xuICBzY29wZUZhY3Rvcnk6IFNjb3BlRmFjdG9yeTxUU2NvcGU+O1xuICBleGVjdXRpb25SdW50aW1lOiBJRXhlY3V0aW9uUnVudGltZTtcbiAgcmVhZE9ubHlDb250ZXh0PzogdW5rbm93bjtcbiAgLyoqIEV4ZWN1dGlvbiBlbnZpcm9ubWVudCDigJQgcHJvcGFnYXRlcyB0byBzdWJmbG93cyBhdXRvbWF0aWNhbGx5LiAqL1xuICBleGVjdXRpb25FbnY/OiBpbXBvcnQoJy4uLy4uL2VuZ2luZS90eXBlcycpLkV4ZWN1dGlvbkVudjtcbiAgdGhyb3R0bGluZ0Vycm9yQ2hlY2tlcj86IChlcnJvcjogdW5rbm93bikgPT4gYm9vbGVhbjtcbiAgc3RyZWFtSGFuZGxlcnM/OiBTdHJlYW1IYW5kbGVycztcbiAgZXh0cmFjdG9yPzogVHJhdmVyc2FsRXh0cmFjdG9yO1xuICBzY29wZVByb3RlY3Rpb25Nb2RlPzogU2NvcGVQcm90ZWN0aW9uTW9kZTtcbiAgc3ViZmxvd3M/OiBSZWNvcmQ8c3RyaW5nLCB7IHJvb3Q6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+IH0+O1xuICBlbnJpY2hTbmFwc2hvdHM/OiBib29sZWFuO1xuICBuYXJyYXRpdmVFbmFibGVkPzogYm9vbGVhbjtcbiAgYnVpbGRUaW1lU3RydWN0dXJlPzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlO1xuICBsb2dnZXI6IElMb2dnZXI7XG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICAvKiogUHJlLWNvbmZpZ3VyZWQgRmxvd1JlY29yZGVycyB0byBhdHRhY2ggd2hlbiBuYXJyYXRpdmUgaXMgZW5hYmxlZC4gKi9cbiAgZmxvd1JlY29yZGVycz86IEZsb3dSZWNvcmRlcltdO1xuICAvKipcbiAgICogUHJlLWNvbmZpZ3VyZWQgbmFycmF0aXZlIGdlbmVyYXRvci4gSWYgcHJvdmlkZWQsIHRha2VzIHByZWNlZGVuY2Ugb3ZlclxuICAgKiBmbG93UmVjb3JkZXJzIGFuZCBuYXJyYXRpdmVFbmFibGVkLiBVc2VkIGJ5IHRoZSBzdWJmbG93IHRyYXZlcnNlciBmYWN0b3J5XG4gICAqIHRvIHNoYXJlIHRoZSBwYXJlbnQncyBuYXJyYXRpdmUgZ2VuZXJhdG9yIHdpdGggc3ViZmxvdyB0cmF2ZXJzZXJzLlxuICAgKi9cbiAgbmFycmF0aXZlR2VuZXJhdG9yPzogSUNvbnRyb2xGbG93TmFycmF0aXZlO1xuICAvKipcbiAgICogTWF4aW11bSByZWN1cnNpdmUgZXhlY3V0ZU5vZGUgZGVwdGguIERlZmF1bHRzIHRvIEZsb3djaGFydFRyYXZlcnNlci5NQVhfRVhFQ1VURV9ERVBUSCAoNTAwKS5cbiAgICogT3ZlcnJpZGUgaW4gdGVzdHMgb3IgdW51c3VhbGx5IGRlZXAgcGlwZWxpbmVzLlxuICAgKi9cbiAgbWF4RGVwdGg/OiBudW1iZXI7XG4gIC8qKlxuICAgKiBXaGVuIHRoaXMgdHJhdmVyc2VyIHJ1bnMgaW5zaWRlIGEgc3ViZmxvdywgc2V0IHRoaXMgdG8gdGhlIHN1YmZsb3cncyBJRC5cbiAgICogUHJvcGFnYXRlZCB0byBUcmF2ZXJzYWxDb250ZXh0IHNvIG5hcnJhdGl2ZSBlbnRyaWVzIGNhcnJ5IHRoZSBjb3JyZWN0IHN1YmZsb3dJZC5cbiAgICovXG4gIHBhcmVudFN1YmZsb3dJZD86IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEZsb3djaGFydFRyYXZlcnNlcjxUT3V0ID0gYW55LCBUU2NvcGUgPSBhbnk+IHtcbiAgcHJpdmF0ZSByZWFkb25seSByb290OiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPjtcbiAgcHJpdmF0ZSBzdGFnZU1hcDogTWFwPHN0cmluZywgU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+PjtcbiAgcHJpdmF0ZSByZWFkb25seSBleGVjdXRpb25SdW50aW1lOiBJRXhlY3V0aW9uUnVudGltZTtcbiAgcHJpdmF0ZSBzdWJmbG93czogUmVjb3JkPHN0cmluZywgeyByb290OiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiB9PjtcbiAgcHJpdmF0ZSByZWFkb25seSBsb2dnZXI6IElMb2dnZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkgc2lnbmFsPzogQWJvcnRTaWduYWw7XG4gIHByaXZhdGUgcmVhZG9ubHkgcGFyZW50U3ViZmxvd0lkPzogc3RyaW5nO1xuXG4gIC8vIEhhbmRsZXIgbW9kdWxlc1xuICBwcml2YXRlIHJlYWRvbmx5IG5vZGVSZXNvbHZlcjogTm9kZVJlc29sdmVyPFRPdXQsIFRTY29wZT47XG4gIHByaXZhdGUgcmVhZG9ubHkgY2hpbGRyZW5FeGVjdXRvcjogQ2hpbGRyZW5FeGVjdXRvcjxUT3V0LCBUU2NvcGU+O1xuICBwcml2YXRlIHJlYWRvbmx5IHN1YmZsb3dFeGVjdXRvcjogU3ViZmxvd0V4ZWN1dG9yPFRPdXQsIFRTY29wZT47XG4gIHByaXZhdGUgcmVhZG9ubHkgc3RhZ2VSdW5uZXI6IFN0YWdlUnVubmVyPFRPdXQsIFRTY29wZT47XG4gIHByaXZhdGUgcmVhZG9ubHkgY29udGludWF0aW9uUmVzb2x2ZXI6IENvbnRpbnVhdGlvblJlc29sdmVyPFRPdXQsIFRTY29wZT47XG4gIHByaXZhdGUgcmVhZG9ubHkgZGVjaWRlckhhbmRsZXI6IERlY2lkZXJIYW5kbGVyPFRPdXQsIFRTY29wZT47XG4gIHByaXZhdGUgcmVhZG9ubHkgc2VsZWN0b3JIYW5kbGVyOiBTZWxlY3RvckhhbmRsZXI8VE91dCwgVFNjb3BlPjtcbiAgcHJpdmF0ZSByZWFkb25seSBzdHJ1Y3R1cmVNYW5hZ2VyOiBSdW50aW1lU3RydWN0dXJlTWFuYWdlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBleHRyYWN0b3JSdW5uZXI6IEV4dHJhY3RvclJ1bm5lcjxUT3V0LCBUU2NvcGU+O1xuICBwcml2YXRlIHJlYWRvbmx5IG5hcnJhdGl2ZUdlbmVyYXRvcjogSUNvbnRyb2xGbG93TmFycmF0aXZlO1xuICBwcml2YXRlIHJlYWRvbmx5IGZsb3dSZWNvcmRlckRpc3BhdGNoZXI6IEZsb3dSZWNvcmRlckRpc3BhdGNoZXIgfCB1bmRlZmluZWQ7XG5cbiAgLy8gRXhlY3V0aW9uIHN0YXRlXG4gIHByaXZhdGUgc3ViZmxvd1Jlc3VsdHM6IE1hcDxzdHJpbmcsIFN1YmZsb3dSZXN1bHQ+ID0gbmV3IE1hcCgpO1xuXG4gIC8qKlxuICAgKiBQZXItdHJhdmVyc2VyIHNldCBvZiBsYXp5IHN1YmZsb3cgSURzIHRoYXQgaGF2ZSBiZWVuIHJlc29sdmVkIGJ5IFRISVMgcnVuLlxuICAgKiBVc2VkIGluc3RlYWQgb2Ygd3JpdGluZyBgbm9kZS5zdWJmbG93UmVzb2x2ZXIgPSB1bmRlZmluZWRgIGJhY2sgdG8gdGhlIHNoYXJlZFxuICAgKiBTdGFnZU5vZGUgZ3JhcGgg4oCUIGF2b2lkcyBhIHJhY2Ugd2hlcmUgYSBjb25jdXJyZW50IHRyYXZlcnNlciBjbGVhcnMgdGhlIHNoYXJlZFxuICAgKiByZXNvbHZlciBiZWZvcmUgYW5vdGhlciB0cmF2ZXJzZXIgaGFzIGZpbmlzaGVkIHVzaW5nIGl0LlxuICAgKi9cbiAgcHJpdmF0ZSByZWFkb25seSByZXNvbHZlZExhenlTdWJmbG93cyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIC8qKlxuICAgKiBSZWN1cnNpb24gZGVwdGggY291bnRlciBmb3IgZXhlY3V0ZU5vZGUuXG4gICAqIEVhY2ggcmVjdXJzaXZlIGV4ZWN1dGVOb2RlIGNhbGwgaW5jcmVtZW50cyB0aGlzOyBkZWNyZW1lbnRzIG9uIGV4aXQgKHRyeS9maW5hbGx5KS5cbiAgICogUHJldmVudHMgY2FsbC1zdGFjayBvdmVyZmxvdyBvbiBpbmZpbml0ZSBsb29wcyBvciBleGNlc3NpdmVseSBkZWVwIHN0YWdlIGNoYWlucy5cbiAgICovXG4gIHByaXZhdGUgX2V4ZWN1dGVEZXB0aCA9IDA7XG5cbiAgLyoqXG4gICAqIFBlci1pbnN0YW5jZSBtYXhpbXVtIGRlcHRoIChzZXQgZnJvbSBUcmF2ZXJzZXJPcHRpb25zLm1heERlcHRoIG9yIHRoZSBjbGFzcyBkZWZhdWx0KS5cbiAgICovXG4gIHByaXZhdGUgcmVhZG9ubHkgX21heERlcHRoOiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIERlZmF1bHQgbWF4aW11bSByZWN1cnNpdmUgZXhlY3V0ZU5vZGUgZGVwdGggYmVmb3JlIGFuIGVycm9yIGlzIHRocm93bi5cbiAgICogNTAwIGNvbWZvcnRhYmx5IGNvdmVycyBhbnkgcmVhbGlzdGljIHBpcGVsaW5lIGRlcHRoIChpbmNsdWRpbmcgZGVlcGx5IG5lc3RlZFxuICAgKiBzdWJmbG93cykgd2hpbGUgcHJldmVudGluZyBjYWxsLXN0YWNrIG92ZXJmbG93ICh+MTAgMDAwIGZyYW1lcyBpbiBWOCkuXG4gICAqXG4gICAqICoqTm90ZSBvbiBjb3VudGluZzoqKiB0aGUgY291bnRlciBpbmNyZW1lbnRzIG9uY2UgcGVyIGBleGVjdXRlTm9kZWAgY2FsbCwgbm90IG9uY2UgcGVyXG4gICAqIGxvZ2ljYWwgdXNlciBzdGFnZS4gU3ViZmxvdyByb290IGVudHJ5IGFuZCBzdWJmbG93IGNvbnRpbnVhdGlvbiBhZnRlciByZXR1cm4gZWFjaCBjb3N0XG4gICAqIG9uZSB0aWNrLiBGb3IgcGlwZWxpbmVzIHdpdGggbWFueSBuZXN0ZWQgc3ViZmxvd3MsIGJ1ZGdldCByb3VnaGx5IDIgw5cgKGF2ZyBzdGFnZXMgcGVyXG4gICAqIHN1YmZsb3cpIG9mIGhlYWRyb29tIHdoZW4gY29tcHV0aW5nIGEgY3VzdG9tIGBtYXhEZXB0aGAgdmlhIGBSdW5PcHRpb25zLm1heERlcHRoYC5cbiAgICpcbiAgICogKipOb3RlIG9uIGxvb3BzOioqIGZvciBgbG9vcFRvKClgIHBpcGVsaW5lcywgdGhpcyBkZXB0aCBndWFyZCBhbmQgYENvbnRpbnVhdGlvblJlc29sdmVyYCdzXG4gICAqIGl0ZXJhdGlvbiBsaW1pdCBhcmUgaW5kZXBlbmRlbnQg4oCUIHRoZSBsb3dlciBvbmUgZmlyZXMgZmlyc3QuIFRoZSBkZWZhdWx0IGRlcHRoIGd1YXJkICg1MDApXG4gICAqIGZpcmVzIGJlZm9yZSB0aGUgZGVmYXVsdCBpdGVyYXRpb24gbGltaXQgKDEwMDApIGZvciBsb29wLWhlYXZ5IHBpcGVsaW5lcy5cbiAgICpcbiAgICogQHJlbWFya3MgTm90IHNhZmUgZm9yIGNvbmN1cnJlbnQgYC5leGVjdXRlKClgIGNhbGxzIG9uIHRoZSBzYW1lIGluc3RhbmNlIOKAlCBjb25jdXJyZW50XG4gICAqIGV4ZWN1dGlvbnMgcmFjZSBvbiBgX2V4ZWN1dGVEZXB0aGAuIFVzZSBhIHNlcGFyYXRlIGBGbG93Y2hhcnRUcmF2ZXJzZXJgIHBlciBjb25jdXJyZW50XG4gICAqIGV4ZWN1dGlvbi4gYEZsb3dDaGFydEV4ZWN1dG9yLnJ1bigpYCBhbHdheXMgY3JlYXRlcyBhIGZyZXNoIHRyYXZlcnNlciBwZXIgY2FsbC5cbiAgICovXG4gIHN0YXRpYyByZWFkb25seSBNQVhfRVhFQ1VURV9ERVBUSCA9IDUwMDtcblxuICBjb25zdHJ1Y3RvcihvcHRzOiBUcmF2ZXJzZXJPcHRpb25zPFRPdXQsIFRTY29wZT4pIHtcbiAgICBjb25zdCBtYXhEZXB0aCA9IG9wdHMubWF4RGVwdGggPz8gRmxvd2NoYXJ0VHJhdmVyc2VyLk1BWF9FWEVDVVRFX0RFUFRIO1xuICAgIGlmIChtYXhEZXB0aCA8IDEpIHRocm93IG5ldyBFcnJvcignRmxvd2NoYXJ0VHJhdmVyc2VyOiBtYXhEZXB0aCBtdXN0IGJlID49IDEnKTtcbiAgICB0aGlzLl9tYXhEZXB0aCA9IG1heERlcHRoO1xuICAgIHRoaXMucm9vdCA9IG9wdHMucm9vdDtcbiAgICAvLyBTaGFsbG93LWNvcHkgc3RhZ2VNYXAgYW5kIHN1YmZsb3dzIHNvIHRoYXQgbGF6eS1yZXNvbHV0aW9uIG11dGF0aW9uc1xuICAgIC8vIChwcmVmaXhlZCBlbnRyaWVzIGFkZGVkIGR1cmluZyBleGVjdXRpb24pIHN0YXkgc2NvcGVkIHRvIFRISVMgdHJhdmVyc2VyXG4gICAgLy8gYW5kIGRvIG5vdCBlc2NhcGUgdG8gdGhlIHNoYXJlZCBGbG93Q2hhcnQgb2JqZWN0LiBXaXRob3V0IHRoZSBjb3B5LFxuICAgIC8vIGNvbmN1cnJlbnQgRmxvd0NoYXJ0RXhlY3V0b3IgcnVucyBzaGFyaW5nIHRoZSBzYW1lIEZsb3dDaGFydCB3b3VsZCByYWNlXG4gICAgLy8gb24gdGhlc2UgdHdvIG11dGFibGUgZGljdGlvbmFyaWVzLlxuICAgIHRoaXMuc3RhZ2VNYXAgPSBuZXcgTWFwKG9wdHMuc3RhZ2VNYXApO1xuICAgIHRoaXMuZXhlY3V0aW9uUnVudGltZSA9IG9wdHMuZXhlY3V0aW9uUnVudGltZTtcbiAgICB0aGlzLnN1YmZsb3dzID0gb3B0cy5zdWJmbG93cyA/IHsgLi4ub3B0cy5zdWJmbG93cyB9IDoge307XG4gICAgdGhpcy5sb2dnZXIgPSBvcHRzLmxvZ2dlcjtcbiAgICB0aGlzLnNpZ25hbCA9IG9wdHMuc2lnbmFsO1xuICAgIHRoaXMucGFyZW50U3ViZmxvd0lkID0gb3B0cy5wYXJlbnRTdWJmbG93SWQ7XG5cbiAgICAvLyBTdHJ1Y3R1cmUgbWFuYWdlciAoZGVlcC1jbG9uZXMgYnVpbGQtdGltZSBzdHJ1Y3R1cmUpXG4gICAgdGhpcy5zdHJ1Y3R1cmVNYW5hZ2VyID0gbmV3IFJ1bnRpbWVTdHJ1Y3R1cmVNYW5hZ2VyKCk7XG4gICAgdGhpcy5zdHJ1Y3R1cmVNYW5hZ2VyLmluaXQob3B0cy5idWlsZFRpbWVTdHJ1Y3R1cmUpO1xuXG4gICAgLy8gRXh0cmFjdG9yIHJ1bm5lclxuICAgIHRoaXMuZXh0cmFjdG9yUnVubmVyID0gbmV3IEV4dHJhY3RvclJ1bm5lcihcbiAgICAgIG9wdHMuZXh0cmFjdG9yLFxuICAgICAgb3B0cy5lbnJpY2hTbmFwc2hvdHMgPz8gZmFsc2UsXG4gICAgICB0aGlzLmV4ZWN1dGlvblJ1bnRpbWUsXG4gICAgICB0aGlzLmxvZ2dlcixcbiAgICApO1xuXG4gICAgLy8gTmFycmF0aXZlIGdlbmVyYXRvclxuICAgIC8vIFByaW9yaXR5OiBleHBsaWNpdCBuYXJyYXRpdmVHZW5lcmF0b3IgPiBmbG93UmVjb3JkZXJzID4gZGVmYXVsdCBOYXJyYXRpdmVGbG93UmVjb3JkZXIgPiBudWxsLlxuICAgIC8vIFN1YmZsb3cgdHJhdmVyc2VycyByZWNlaXZlIHRoZSBwYXJlbnQncyBuYXJyYXRpdmVHZW5lcmF0b3Igc28gYWxsIGV2ZW50cyBmbG93IHRvIG9uZSBwbGFjZS5cbiAgICBpZiAob3B0cy5uYXJyYXRpdmVHZW5lcmF0b3IpIHtcbiAgICAgIHRoaXMubmFycmF0aXZlR2VuZXJhdG9yID0gb3B0cy5uYXJyYXRpdmVHZW5lcmF0b3I7XG4gICAgfSBlbHNlIGlmIChvcHRzLm5hcnJhdGl2ZUVuYWJsZWQpIHtcbiAgICAgIGNvbnN0IGRpc3BhdGNoZXIgPSBuZXcgRmxvd1JlY29yZGVyRGlzcGF0Y2hlcigpO1xuICAgICAgdGhpcy5mbG93UmVjb3JkZXJEaXNwYXRjaGVyID0gZGlzcGF0Y2hlcjtcblxuICAgICAgLy8gSWYgY3VzdG9tIEZsb3dSZWNvcmRlcnMgYXJlIHByb3ZpZGVkLCB1c2UgdGhlbTsgb3RoZXJ3aXNlIGF0dGFjaCBkZWZhdWx0IE5hcnJhdGl2ZUZsb3dSZWNvcmRlclxuICAgICAgaWYgKG9wdHMuZmxvd1JlY29yZGVycyAmJiBvcHRzLmZsb3dSZWNvcmRlcnMubGVuZ3RoID4gMCkge1xuICAgICAgICBmb3IgKGNvbnN0IHJlY29yZGVyIG9mIG9wdHMuZmxvd1JlY29yZGVycykge1xuICAgICAgICAgIGRpc3BhdGNoZXIuYXR0YWNoKHJlY29yZGVyKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgZGlzcGF0Y2hlci5hdHRhY2gobmV3IE5hcnJhdGl2ZUZsb3dSZWNvcmRlcigpKTtcbiAgICAgIH1cblxuICAgICAgdGhpcy5uYXJyYXRpdmVHZW5lcmF0b3IgPSBkaXNwYXRjaGVyO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLm5hcnJhdGl2ZUdlbmVyYXRvciA9IG5ldyBOdWxsQ29udHJvbEZsb3dOYXJyYXRpdmVHZW5lcmF0b3IoKTtcbiAgICB9XG5cbiAgICAvLyBCdWlsZCBzaGFyZWQgZGVwcyBiYWdcbiAgICBjb25zdCBkZXBzID0gdGhpcy5jcmVhdGVEZXBzKG9wdHMpO1xuXG4gICAgLy8gQnVpbGQgTygxKSBub2RlIElEIG1hcCBmcm9tIHRoZSByb290IGdyYXBoIChhdm9pZHMgcmVwZWF0ZWQgREZTIG9uIGV2ZXJ5IGxvb3BUbygpKVxuICAgIGNvbnN0IG5vZGVJZE1hcCA9IHRoaXMuYnVpbGROb2RlSWRNYXAob3B0cy5yb290KTtcblxuICAgIC8vIEluaXRpYWxpemUgaGFuZGxlciBtb2R1bGVzXG4gICAgdGhpcy5ub2RlUmVzb2x2ZXIgPSBuZXcgTm9kZVJlc29sdmVyKGRlcHMsIG5vZGVJZE1hcCk7XG4gICAgdGhpcy5jaGlsZHJlbkV4ZWN1dG9yID0gbmV3IENoaWxkcmVuRXhlY3V0b3IoZGVwcywgdGhpcy5leGVjdXRlTm9kZS5iaW5kKHRoaXMpKTtcbiAgICB0aGlzLnN0YWdlUnVubmVyID0gbmV3IFN0YWdlUnVubmVyKGRlcHMpO1xuICAgIHRoaXMuY29udGludWF0aW9uUmVzb2x2ZXIgPSBuZXcgQ29udGludWF0aW9uUmVzb2x2ZXIoZGVwcywgdGhpcy5ub2RlUmVzb2x2ZXIsIChub2RlSWQsIGNvdW50KSA9PlxuICAgICAgdGhpcy5zdHJ1Y3R1cmVNYW5hZ2VyLnVwZGF0ZUl0ZXJhdGlvbkNvdW50KG5vZGVJZCwgY291bnQpLFxuICAgICk7XG4gICAgdGhpcy5kZWNpZGVySGFuZGxlciA9IG5ldyBEZWNpZGVySGFuZGxlcihkZXBzKTtcbiAgICB0aGlzLnNlbGVjdG9ySGFuZGxlciA9IG5ldyBTZWxlY3RvckhhbmRsZXIoZGVwcywgdGhpcy5jaGlsZHJlbkV4ZWN1dG9yKTtcbiAgICB0aGlzLnN1YmZsb3dFeGVjdXRvciA9IG5ldyBTdWJmbG93RXhlY3V0b3IoZGVwcywgdGhpcy5jcmVhdGVTdWJmbG93VHJhdmVyc2VyRmFjdG9yeShvcHRzKSk7XG4gIH1cblxuICAvKipcbiAgICogQ3JlYXRlIGEgZmFjdG9yeSB0aGF0IHByb2R1Y2VzIEZsb3djaGFydFRyYXZlcnNlciBpbnN0YW5jZXMgZm9yIHN1YmZsb3cgZXhlY3V0aW9uLlxuICAgKiBDYXB0dXJlcyBwYXJlbnQgY29uZmlnIGluIGNsb3N1cmUg4oCUIFN1YmZsb3dFeGVjdXRvciBwcm92aWRlcyBzdWJmbG93LXNwZWNpZmljIG92ZXJyaWRlcy5cbiAgICogRWFjaCBzdWJmbG93IGdldHMgYSBmdWxsIHRyYXZlcnNlciB3aXRoIGFsbCA3IHBoYXNlcyAoZGVjaWRlcnMsIHNlbGVjdG9ycywgbG9vcHMsIGV0Yy4pLlxuICAgKi9cbiAgcHJpdmF0ZSBjcmVhdGVTdWJmbG93VHJhdmVyc2VyRmFjdG9yeShcbiAgICBwYXJlbnRPcHRzOiBUcmF2ZXJzZXJPcHRpb25zPFRPdXQsIFRTY29wZT4sXG4gICk6IFN1YmZsb3dUcmF2ZXJzZXJGYWN0b3J5PFRPdXQsIFRTY29wZT4ge1xuICAgIC8vIENhcHR1cmUgcmVmZXJlbmNlcyB0byBtdXRhYmxlIHN0YXRlIOKAlCBmYWN0b3J5IHJlYWRzIHRoZSBDVVJSRU5UIHN0YXRlIHdoZW4gY2FsbGVkLFxuICAgIC8vIG5vdCB0aGUgc3RhdGUgYXQgZmFjdG9yeSBjcmVhdGlvbiB0aW1lLiBUaGlzIGlzIGNvcnJlY3QgYmVjYXVzZSBsYXp5IHN1YmZsb3cgcmVzb2x1dGlvblxuICAgIC8vIG1heSBhZGQgZW50cmllcyB0byBzdGFnZU1hcC9zdWJmbG93cyBiZWZvcmUgYSBuZXN0ZWQgc3ViZmxvdyBpcyBlbmNvdW50ZXJlZC5cbiAgICBjb25zdCBwYXJlbnRTdGFnZU1hcCA9IHRoaXMuc3RhZ2VNYXA7XG4gICAgY29uc3QgcGFyZW50U3ViZmxvd3MgPSB0aGlzLnN1YmZsb3dzO1xuICAgIGNvbnN0IG5hcnJhdGl2ZUdlbmVyYXRvciA9IHRoaXMubmFycmF0aXZlR2VuZXJhdG9yO1xuXG4gICAgcmV0dXJuIChzdWJmbG93T3B0cykgPT4ge1xuICAgICAgY29uc3QgdHJhdmVyc2VyID0gbmV3IEZsb3djaGFydFRyYXZlcnNlcjxUT3V0LCBUU2NvcGU+KHtcbiAgICAgICAgcm9vdDogc3ViZmxvd09wdHMucm9vdCxcbiAgICAgICAgc3RhZ2VNYXA6IHBhcmVudFN0YWdlTWFwLCAvLyBDb25zdHJ1Y3RvciBzaGFsbG93LWNvcGllcyB0aGlzXG4gICAgICAgIHNjb3BlRmFjdG9yeTogcGFyZW50T3B0cy5zY29wZUZhY3RvcnksXG4gICAgICAgIGV4ZWN1dGlvblJ1bnRpbWU6IHN1YmZsb3dPcHRzLmV4ZWN1dGlvblJ1bnRpbWUsXG4gICAgICAgIHJlYWRPbmx5Q29udGV4dDogc3ViZmxvd09wdHMucmVhZE9ubHlDb250ZXh0LFxuICAgICAgICBleGVjdXRpb25FbnY6IHBhcmVudE9wdHMuZXhlY3V0aW9uRW52LFxuICAgICAgICB0aHJvdHRsaW5nRXJyb3JDaGVja2VyOiBwYXJlbnRPcHRzLnRocm90dGxpbmdFcnJvckNoZWNrZXIsXG4gICAgICAgIHN0cmVhbUhhbmRsZXJzOiBwYXJlbnRPcHRzLnN0cmVhbUhhbmRsZXJzLFxuICAgICAgICBleHRyYWN0b3I6IHBhcmVudE9wdHMuZXh0cmFjdG9yLFxuICAgICAgICBzY29wZVByb3RlY3Rpb25Nb2RlOiBwYXJlbnRPcHRzLnNjb3BlUHJvdGVjdGlvbk1vZGUsXG4gICAgICAgIHN1YmZsb3dzOiBwYXJlbnRTdWJmbG93cywgLy8gQ29uc3RydWN0b3Igc2hhbGxvdy1jb3BpZXMgdGhpc1xuICAgICAgICBlbnJpY2hTbmFwc2hvdHM6IHBhcmVudE9wdHMuZW5yaWNoU25hcHNob3RzLFxuICAgICAgICBuYXJyYXRpdmVHZW5lcmF0b3IsIC8vIFNoYXJlIHBhcmVudCdzIOKAlCBhbGwgZXZlbnRzIGZsb3cgdG8gb25lIHBsYWNlXG4gICAgICAgIGxvZ2dlcjogcGFyZW50T3B0cy5sb2dnZXIsXG4gICAgICAgIHNpZ25hbDogcGFyZW50T3B0cy5zaWduYWwsXG4gICAgICAgIG1heERlcHRoOiB0aGlzLl9tYXhEZXB0aCxcbiAgICAgICAgcGFyZW50U3ViZmxvd0lkOiBzdWJmbG93T3B0cy5zdWJmbG93SWQsXG4gICAgICB9KTtcblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgZXhlY3V0ZTogKCkgPT4gdHJhdmVyc2VyLmV4ZWN1dGUoKSxcbiAgICAgICAgZ2V0U3ViZmxvd1Jlc3VsdHM6ICgpID0+IHRyYXZlcnNlci5nZXRTdWJmbG93UmVzdWx0cygpLFxuICAgICAgfTtcbiAgICB9O1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVEZXBzKG9wdHM6IFRyYXZlcnNlck9wdGlvbnM8VE91dCwgVFNjb3BlPik6IEhhbmRsZXJEZXBzPFRPdXQsIFRTY29wZT4ge1xuICAgIHJldHVybiB7XG4gICAgICBzdGFnZU1hcDogdGhpcy5zdGFnZU1hcCxcbiAgICAgIHJvb3Q6IHRoaXMucm9vdCxcbiAgICAgIGV4ZWN1dGlvblJ1bnRpbWU6IHRoaXMuZXhlY3V0aW9uUnVudGltZSxcbiAgICAgIHNjb3BlRmFjdG9yeTogb3B0cy5zY29wZUZhY3RvcnksXG4gICAgICBzdWJmbG93czogdGhpcy5zdWJmbG93cyxcbiAgICAgIHRocm90dGxpbmdFcnJvckNoZWNrZXI6IG9wdHMudGhyb3R0bGluZ0Vycm9yQ2hlY2tlcixcbiAgICAgIHN0cmVhbUhhbmRsZXJzOiBvcHRzLnN0cmVhbUhhbmRsZXJzLFxuICAgICAgc2NvcGVQcm90ZWN0aW9uTW9kZTogb3B0cy5zY29wZVByb3RlY3Rpb25Nb2RlID8/ICdlcnJvcicsXG4gICAgICByZWFkT25seUNvbnRleHQ6IG9wdHMucmVhZE9ubHlDb250ZXh0LFxuICAgICAgZXhlY3V0aW9uRW52OiBvcHRzLmV4ZWN1dGlvbkVudixcbiAgICAgIG5hcnJhdGl2ZUdlbmVyYXRvcjogdGhpcy5uYXJyYXRpdmVHZW5lcmF0b3IsXG4gICAgICBsb2dnZXI6IHRoaXMubG9nZ2VyLFxuICAgICAgc2lnbmFsOiBvcHRzLnNpZ25hbCxcbiAgICB9O1xuICB9XG5cbiAgLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAIFB1YmxpYyBBUEkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgYXN5bmMgZXhlY3V0ZShicmFuY2hQYXRoPzogc3RyaW5nKTogUHJvbWlzZTxUcmF2ZXJzYWxSZXN1bHQ+IHtcbiAgICBjb25zdCBjb250ZXh0ID0gdGhpcy5leGVjdXRpb25SdW50aW1lLnJvb3RTdGFnZUNvbnRleHQ7XG4gICAgcmV0dXJuIGF3YWl0IHRoaXMuZXhlY3V0ZU5vZGUodGhpcy5yb290LCBjb250ZXh0LCB7IHNob3VsZEJyZWFrOiBmYWxzZSB9LCBicmFuY2hQYXRoID8/ICcnKTtcbiAgfVxuXG4gIGdldFJ1bnRpbWVTdHJ1Y3R1cmUoKTogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlIHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy5zdHJ1Y3R1cmVNYW5hZ2VyLmdldFN0cnVjdHVyZSgpO1xuICB9XG5cbiAgZ2V0U25hcHNob3QoKSB7XG4gICAgcmV0dXJuIHRoaXMuZXhlY3V0aW9uUnVudGltZS5nZXRTbmFwc2hvdCgpO1xuICB9XG5cbiAgZ2V0UnVudGltZSgpIHtcbiAgICByZXR1cm4gdGhpcy5leGVjdXRpb25SdW50aW1lO1xuICB9XG5cbiAgc2V0Um9vdE9iamVjdChwYXRoOiBzdHJpbmdbXSwga2V5OiBzdHJpbmcsIHZhbHVlOiB1bmtub3duKSB7XG4gICAgdGhpcy5leGVjdXRpb25SdW50aW1lLnNldFJvb3RPYmplY3QocGF0aCwga2V5LCB2YWx1ZSk7XG4gIH1cblxuICBnZXRCcmFuY2hJZHMoKSB7XG4gICAgcmV0dXJuIHRoaXMuZXhlY3V0aW9uUnVudGltZS5nZXRQaXBlbGluZXMoKTtcbiAgfVxuXG4gIGdldFJ1bnRpbWVSb290KCk6IFN0YWdlTm9kZSB7XG4gICAgcmV0dXJuIHRoaXMucm9vdDtcbiAgfVxuXG4gIGdldFN1YmZsb3dSZXN1bHRzKCk6IE1hcDxzdHJpbmcsIFN1YmZsb3dSZXN1bHQ+IHtcbiAgICByZXR1cm4gdGhpcy5zdWJmbG93UmVzdWx0cztcbiAgfVxuXG4gIGdldEV4dHJhY3RlZFJlc3VsdHM8VFJlc3VsdCA9IHVua25vd24+KCk6IE1hcDxzdHJpbmcsIFRSZXN1bHQ+IHtcbiAgICByZXR1cm4gdGhpcy5leHRyYWN0b3JSdW5uZXIuZ2V0RXh0cmFjdGVkUmVzdWx0cygpIGFzIE1hcDxzdHJpbmcsIFRSZXN1bHQ+O1xuICB9XG5cbiAgZ2V0RXh0cmFjdG9yRXJyb3JzKCk6IEV4dHJhY3RvckVycm9yW10ge1xuICAgIHJldHVybiB0aGlzLmV4dHJhY3RvclJ1bm5lci5nZXRFeHRyYWN0b3JFcnJvcnMoKTtcbiAgfVxuXG4gIGdldE5hcnJhdGl2ZSgpOiBzdHJpbmdbXSB7XG4gICAgcmV0dXJuIHRoaXMubmFycmF0aXZlR2VuZXJhdG9yLmdldFNlbnRlbmNlcygpO1xuICB9XG5cbiAgLyoqIFJldHVybnMgdGhlIEZsb3dSZWNvcmRlckRpc3BhdGNoZXIsIG9yIHVuZGVmaW5lZCBpZiBuYXJyYXRpdmUgaXMgZGlzYWJsZWQuICovXG4gIGdldEZsb3dSZWNvcmRlckRpc3BhdGNoZXIoKTogRmxvd1JlY29yZGVyRGlzcGF0Y2hlciB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMuZmxvd1JlY29yZGVyRGlzcGF0Y2hlcjtcbiAgfVxuXG4gIC8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCBDb3JlIFRyYXZlcnNhbCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKipcbiAgICogQnVpbGQgYW4gTygxKSBJROKGkm5vZGUgbWFwIGZyb20gdGhlIHJvb3QgZ3JhcGguXG4gICAqIFVzZWQgYnkgTm9kZVJlc29sdmVyIHRvIGF2b2lkIHJlcGVhdGVkIERGUyBvbiBldmVyeSBsb29wVG8oKSBjYWxsLlxuICAgKiBEZXB0aC1ndWFyZGVkIGF0IE1BWF9FWEVDVVRFX0RFUFRIIHRvIHByZXZlbnQgaW5maW5pdGUgcmVjdXJzaW9uIG9uIGN5Y2xpYyBncmFwaHMuXG4gICAqIER5bmFtaWMgc3ViZmxvd3MgYW5kIGxhenktcmVzb2x2ZWQgbm9kZXMgYXJlIGFkZGVkIHRvIHN0YWdlTWFwIGF0IHJ1bnRpbWUgYnV0IG5vdCB0byB0aGlzIG1hcCDigJRcbiAgICogdGhvc2UgdXNlIHRoZSBERlMgZmFsbGJhY2sgaW4gTm9kZVJlc29sdmVyLlxuICAgKi9cbiAgcHJpdmF0ZSBidWlsZE5vZGVJZE1hcChyb290OiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPik6IE1hcDxzdHJpbmcsIFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+PiB7XG4gICAgY29uc3QgbWFwID0gbmV3IE1hcDxzdHJpbmcsIFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+PigpO1xuICAgIGNvbnN0IHZpc2l0ID0gKG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+LCBkZXB0aDogbnVtYmVyKTogdm9pZCA9PiB7XG4gICAgICBpZiAoZGVwdGggPiBGbG93Y2hhcnRUcmF2ZXJzZXIuTUFYX0VYRUNVVEVfREVQVEgpIHJldHVybjtcbiAgICAgIGlmIChtYXAuaGFzKG5vZGUuaWQpKSByZXR1cm47IC8vIGFscmVhZHkgdmlzaXRlZCAoYXZvaWRzIGluZmluaXRlIGxvb3BzIG9uIGN5Y2xpYyByZWZzKVxuICAgICAgbWFwLnNldChub2RlLmlkLCBub2RlKTtcbiAgICAgIGlmIChub2RlLmNoaWxkcmVuKSB7XG4gICAgICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5jaGlsZHJlbikgdmlzaXQoY2hpbGQsIGRlcHRoICsgMSk7XG4gICAgICB9XG4gICAgICBpZiAobm9kZS5uZXh0KSB2aXNpdChub2RlLm5leHQsIGRlcHRoICsgMSk7XG4gICAgfTtcbiAgICB2aXNpdChyb290LCAwKTtcbiAgICByZXR1cm4gbWFwO1xuICB9XG5cbiAgcHJpdmF0ZSBnZXRTdGFnZUZuKG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+KTogU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+IHwgdW5kZWZpbmVkIHtcbiAgICBpZiAodHlwZW9mIG5vZGUuZm4gPT09ICdmdW5jdGlvbicpIHJldHVybiBub2RlLmZuIGFzIFN0YWdlRnVuY3Rpb248VE91dCwgVFNjb3BlPjtcbiAgICAvLyBQcmltYXJ5OiBsb29rIHVwIGJ5IGlkIChzdGFibGUgaWRlbnRpZmllciwga2V5ZWQgYnkgRmxvd0NoYXJ0QnVpbGRlcilcbiAgICBjb25zdCBieUlkID0gdGhpcy5zdGFnZU1hcC5nZXQobm9kZS5pZCk7XG4gICAgaWYgKGJ5SWQgIT09IHVuZGVmaW5lZCkgcmV0dXJuIGJ5SWQ7XG4gICAgLy8gRmFsbGJhY2s6IGxvb2sgdXAgYnkgbmFtZSAoc3VwcG9ydHMgaGFuZC1jcmFmdGVkIHN0YWdlTWFwcyBpbiB0ZXN0cyBhbmQgYWR2YW5jZWQgdXNlKVxuICAgIHJldHVybiB0aGlzLnN0YWdlTWFwLmdldChub2RlLm5hbWUpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBleGVjdXRlU3RhZ2UoXG4gICAgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4sXG4gICAgc3RhZ2VGdW5jOiBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4sXG4gICAgY29udGV4dDogU3RhZ2VDb250ZXh0LFxuICAgIGJyZWFrRm46ICgpID0+IHZvaWQsXG4gICkge1xuICAgIHJldHVybiB0aGlzLnN0YWdlUnVubmVyLnJ1bihub2RlLCBzdGFnZUZ1bmMsIGNvbnRleHQsIGJyZWFrRm4pO1xuICB9XG5cbiAgLyoqXG4gICAqIFByZS1vcmRlciBERlMgdHJhdmVyc2FsIOKAlCB0aGUgY29yZSBhbGdvcml0aG0uXG4gICAqIEVhY2ggY2FsbCBwcm9jZXNzZXMgb25lIG5vZGUgdGhyb3VnaCBhbGwgNyBwaGFzZXMuXG4gICAqL1xuICBwcml2YXRlIGFzeW5jIGV4ZWN1dGVOb2RlKFxuICAgIG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+LFxuICAgIGNvbnRleHQ6IFN0YWdlQ29udGV4dCxcbiAgICBicmVha0ZsYWc6IHsgc2hvdWxkQnJlYWs6IGJvb2xlYW4gfSxcbiAgICBicmFuY2hQYXRoPzogc3RyaW5nLFxuICApOiBQcm9taXNlPGFueT4ge1xuICAgIC8vIOKUgOKUgOKUgCBSZWN1cnNpb24gZGVwdGggZ3VhcmQg4pSA4pSA4pSAXG4gICAgLy8gRWFjaCBgYXdhaXQgZXhlY3V0ZU5vZGUoLi4uKWAga2VlcHMgdGhlIGNhbGxpbmcgZnJhbWUgb24gdGhlIHN0YWNrLlxuICAgIC8vIFdpdGhvdXQgYSBjYXAsIGFuIGluZmluaXRlIGxvb3Agb3IgYW4gZXhjZXNzaXZlbHkgZGVlcCBzdGFnZSBjaGFpbiB3aWxsXG4gICAgLy8gZXZlbnR1YWxseSBvdmVyZmxvdyB0aGUgVjggY2FsbCBzdGFjayAofjEwIDAwMCBmcmFtZXMpIHdpdGggYSBjcnlwdGljXG4gICAgLy8gXCJNYXhpbXVtIGNhbGwgc3RhY2sgc2l6ZSBleGNlZWRlZFwiIGVycm9yLiAgV2UgZmFpbCBlYXJseSB3aXRoIGEgY2xlYXJcbiAgICAvLyBtZXNzYWdlIHNvIHVzZXJzIGNhbiBkaWFnbm9zZSB0aGUgY2F1c2UgKGluZmluaXRlIGxvb3AsIG1pc3NpbmcgYnJlYWssIGV0Yy4pLlxuICAgIC8vIFRoZSBpbmNyZW1lbnQgaXMgaW5zaWRlIGB0cnlgIHNvIGBmaW5hbGx5YCBhbHdheXMgZGVjcmVtZW50cyDigJQgbm8gZnJhZ2lsZVxuICAgIC8vIGdhcCBiZXR3ZWVuIGNoZWNrIGFuZCB0cnkgZW50cnkuXG4gICAgdHJ5IHtcbiAgICAgIGlmICgrK3RoaXMuX2V4ZWN1dGVEZXB0aCA+IHRoaXMuX21heERlcHRoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgRmxvd2NoYXJ0VHJhdmVyc2VyOiBtYXhpbXVtIHRyYXZlcnNhbCBkZXB0aCBleGNlZWRlZCAoJHt0aGlzLl9tYXhEZXB0aH0pLiBgICtcbiAgICAgICAgICAgICdDaGVjayBmb3IgaW5maW5pdGUgbG9vcHMgb3IgbWlzc2luZyBicmVhayBjb25kaXRpb25zIGluIHlvdXIgZmxvd2NoYXJ0LiAnICtcbiAgICAgICAgICAgIGBMYXN0IHN0YWdlOiAnJHtub2RlLm5hbWV9Jy4gYCArXG4gICAgICAgICAgICAnRm9yIGxvb3BUbygpIHBpcGVsaW5lcywgY29uc2lkZXIgYWRkaW5nIGEgYnJlYWsgY29uZGl0aW9uIG9yIHVzaW5nIFJ1bk9wdGlvbnMubWF4RGVwdGggdG8gcmFpc2UgdGhlIGxpbWl0LicsXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIC8vIEF0dGFjaCBidWlsZGVyIG1ldGFkYXRhIHRvIGNvbnRleHQgZm9yIHNuYXBzaG90IGVucmljaG1lbnRcbiAgICAgIGlmIChub2RlLmRlc2NyaXB0aW9uKSBjb250ZXh0LmRlc2NyaXB0aW9uID0gbm9kZS5kZXNjcmlwdGlvbjtcbiAgICAgIGlmIChub2RlLmlzU3ViZmxvd1Jvb3QgJiYgbm9kZS5zdWJmbG93SWQpIGNvbnRleHQuc3ViZmxvd0lkID0gbm9kZS5zdWJmbG93SWQ7XG5cbiAgICAgIC8vIEJ1aWxkIHRyYXZlcnNhbCBjb250ZXh0IGZvciByZWNvcmRlciBldmVudHMg4oCUIGNyZWF0ZWQgb25jZSBwZXIgc3RhZ2UsIHNoYXJlZCBieSBhbGwgZXZlbnRzXG4gICAgICBjb25zdCB0cmF2ZXJzYWxDb250ZXh0OiBUcmF2ZXJzYWxDb250ZXh0ID0ge1xuICAgICAgICBzdGFnZUlkOiBub2RlLmlkID8/IGNvbnRleHQuc3RhZ2VJZCxcbiAgICAgICAgc3RhZ2VOYW1lOiBub2RlLm5hbWUsXG4gICAgICAgIHBhcmVudFN0YWdlSWQ6IGNvbnRleHQucGFyZW50Py5zdGFnZUlkLFxuICAgICAgICBzdWJmbG93SWQ6IGNvbnRleHQuc3ViZmxvd0lkID8/IHRoaXMucGFyZW50U3ViZmxvd0lkLFxuICAgICAgICBzdWJmbG93UGF0aDogYnJhbmNoUGF0aCB8fCB1bmRlZmluZWQsXG4gICAgICAgIGRlcHRoOiB0aGlzLmNvbXB1dGVDb250ZXh0RGVwdGgoY29udGV4dCksXG4gICAgICB9O1xuXG4gICAgICAvLyDilIDilIDilIAgUGhhc2UgMGE6IExBWlkgUkVTT0xWRSDigJQgZGVmZXJyZWQgc3ViZmxvdyByZXNvbHV0aW9uIOKUgOKUgOKUgFxuICAgICAgLy8gR3VhcmQgdXNlcyB0aGUgcGVyLXRyYXZlcnNlciByZXNvbHZlZExhenlTdWJmbG93cyBzZXQgKG5vdCB0aGUgc2hhcmVkIG5vZGUpIHNvXG4gICAgICAvLyBjb25jdXJyZW50IHRyYXZlcnNlcnMgZG8gbm90IHJhY2Ugb24gbm9kZS5zdWJmbG93UmVzb2x2ZXIgb3IgY2xlYXIgaXQgZm9yIGVhY2ggb3RoZXIuXG4gICAgICBpZiAobm9kZS5pc1N1YmZsb3dSb290ICYmIG5vZGUuc3ViZmxvd1Jlc29sdmVyICYmICF0aGlzLnJlc29sdmVkTGF6eVN1YmZsb3dzLmhhcyhub2RlLnN1YmZsb3dJZCEpKSB7XG4gICAgICAgIGNvbnN0IHJlc29sdmVkID0gbm9kZS5zdWJmbG93UmVzb2x2ZXIoKTtcbiAgICAgICAgY29uc3QgcHJlZml4ZWRSb290ID0gdGhpcy5wcmVmaXhOb2RlVHJlZShyZXNvbHZlZC5yb290IGFzIFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+LCBub2RlLnN1YmZsb3dJZCEpO1xuXG4gICAgICAgIC8vIFJlZ2lzdGVyIHRoZSByZXNvbHZlZCBzdWJmbG93IChzYW1lIHBhdGggYXMgZWFnZXIgcmVnaXN0cmF0aW9uKVxuICAgICAgICB0aGlzLnN1YmZsb3dzW25vZGUuc3ViZmxvd0lkIV0gPSB7IHJvb3Q6IHByZWZpeGVkUm9vdCB9O1xuXG4gICAgICAgIC8vIE1lcmdlIHN0YWdlTWFwIGVudHJpZXNcbiAgICAgICAgZm9yIChjb25zdCBba2V5LCBmbl0gb2YgcmVzb2x2ZWQuc3RhZ2VNYXApIHtcbiAgICAgICAgICBjb25zdCBwcmVmaXhlZEtleSA9IGAke25vZGUuc3ViZmxvd0lkfS8ke2tleX1gO1xuICAgICAgICAgIGlmICghdGhpcy5zdGFnZU1hcC5oYXMocHJlZml4ZWRLZXkpKSB7XG4gICAgICAgICAgICB0aGlzLnN0YWdlTWFwLnNldChwcmVmaXhlZEtleSwgZm4gYXMgU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+KTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBNZXJnZSBuZXN0ZWQgc3ViZmxvd3NcbiAgICAgICAgaWYgKHJlc29sdmVkLnN1YmZsb3dzKSB7XG4gICAgICAgICAgZm9yIChjb25zdCBba2V5LCBkZWZdIG9mIE9iamVjdC5lbnRyaWVzKHJlc29sdmVkLnN1YmZsb3dzKSkge1xuICAgICAgICAgICAgY29uc3QgcHJlZml4ZWRLZXkgPSBgJHtub2RlLnN1YmZsb3dJZH0vJHtrZXl9YDtcbiAgICAgICAgICAgIGlmICghdGhpcy5zdWJmbG93c1twcmVmaXhlZEtleV0pIHtcbiAgICAgICAgICAgICAgdGhpcy5zdWJmbG93c1twcmVmaXhlZEtleV0gPSBkZWYgYXMgeyByb290OiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFVwZGF0ZSBydW50aW1lIHN0cnVjdHVyZSB3aXRoIHRoZSBub3ctcmVzb2x2ZWQgc3BlY1xuICAgICAgICB0aGlzLnN0cnVjdHVyZU1hbmFnZXIudXBkYXRlRHluYW1pY1N1YmZsb3coXG4gICAgICAgICAgbm9kZS5pZCxcbiAgICAgICAgICBub2RlLnN1YmZsb3dJZCEsXG4gICAgICAgICAgbm9kZS5zdWJmbG93TmFtZSxcbiAgICAgICAgICByZXNvbHZlZC5idWlsZFRpbWVTdHJ1Y3R1cmUsXG4gICAgICAgICk7XG5cbiAgICAgICAgLy8gTWFyayBhcyByZXNvbHZlZCBmb3IgVEhJUyB0cmF2ZXJzZXIg4oCUIHBlci10cmF2ZXJzZXIgc2V0IHByZXZlbnRzIHJlLWVudHJ5XG4gICAgICAgIC8vIHdpdGhvdXQgbXV0YXRpbmcgdGhlIHNoYXJlZCBTdGFnZU5vZGUgZ3JhcGggKHdoaWNoIHdvdWxkIHJhY2UgY29uY3VycmVudCB0cmF2ZXJzZXJzKS5cbiAgICAgICAgdGhpcy5yZXNvbHZlZExhenlTdWJmbG93cy5hZGQobm9kZS5zdWJmbG93SWQhKTtcbiAgICAgIH1cblxuICAgICAgLy8g4pSA4pSA4pSAIFBoYXNlIDA6IENMQVNTSUZZIOKAlCBzdWJmbG93IGRldGVjdGlvbiDilIDilIDilIBcbiAgICAgIGlmIChub2RlLmlzU3ViZmxvd1Jvb3QgJiYgbm9kZS5zdWJmbG93SWQpIHtcbiAgICAgICAgY29uc3QgcmVzb2x2ZWROb2RlID0gdGhpcy5ub2RlUmVzb2x2ZXIucmVzb2x2ZVN1YmZsb3dSZWZlcmVuY2Uobm9kZSk7XG4gICAgICAgIGNvbnN0IHByZXZpb3VzU3ViZmxvd0lkID0gdGhpcy5leHRyYWN0b3JSdW5uZXIuY3VycmVudFN1YmZsb3dJZDtcbiAgICAgICAgdGhpcy5leHRyYWN0b3JSdW5uZXIuY3VycmVudFN1YmZsb3dJZCA9IG5vZGUuc3ViZmxvd0lkO1xuXG4gICAgICAgIGxldCBzdWJmbG93T3V0cHV0OiBhbnk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgc3ViZmxvd091dHB1dCA9IGF3YWl0IHRoaXMuc3ViZmxvd0V4ZWN1dG9yLmV4ZWN1dGVTdWJmbG93KFxuICAgICAgICAgICAgcmVzb2x2ZWROb2RlLFxuICAgICAgICAgICAgY29udGV4dCxcbiAgICAgICAgICAgIGJyZWFrRmxhZyxcbiAgICAgICAgICAgIGJyYW5jaFBhdGgsXG4gICAgICAgICAgICB0aGlzLnN1YmZsb3dSZXN1bHRzLFxuICAgICAgICAgICAgdHJhdmVyc2FsQ29udGV4dCxcbiAgICAgICAgICApO1xuICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgIHRoaXMuZXh0cmFjdG9yUnVubmVyLmN1cnJlbnRTdWJmbG93SWQgPSBwcmV2aW91c1N1YmZsb3dJZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGlzUmVmZXJlbmNlQmFzZWRTdWJmbG93ID0gcmVzb2x2ZWROb2RlICE9PSBub2RlO1xuICAgICAgICBjb25zdCBoYXNDaGlsZHJlbiA9IEJvb2xlYW4obm9kZS5jaGlsZHJlbiAmJiBub2RlLmNoaWxkcmVuLmxlbmd0aCA+IDApO1xuICAgICAgICBjb25zdCBzaG91bGRFeGVjdXRlQ29udGludWF0aW9uID0gaXNSZWZlcmVuY2VCYXNlZFN1YmZsb3cgfHwgaGFzQ2hpbGRyZW47XG5cbiAgICAgICAgaWYgKG5vZGUubmV4dCAmJiBzaG91bGRFeGVjdXRlQ29udGludWF0aW9uKSB7XG4gICAgICAgICAgY29uc3QgbmV4dEN0eCA9IGNvbnRleHQuY3JlYXRlTmV4dChicmFuY2hQYXRoIGFzIHN0cmluZywgbm9kZS5uZXh0Lm5hbWUsIG5vZGUubmV4dC5pZCk7XG4gICAgICAgICAgcmV0dXJuIGF3YWl0IHRoaXMuZXhlY3V0ZU5vZGUobm9kZS5uZXh0LCBuZXh0Q3R4LCBicmVha0ZsYWcsIGJyYW5jaFBhdGgpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHN1YmZsb3dPdXRwdXQ7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHN0YWdlRnVuYyA9IHRoaXMuZ2V0U3RhZ2VGbihub2RlKTtcbiAgICAgIGNvbnN0IGhhc1N0YWdlRnVuY3Rpb24gPSBCb29sZWFuKHN0YWdlRnVuYyk7XG4gICAgICBjb25zdCBpc1Njb3BlQmFzZWREZWNpZGVyID0gQm9vbGVhbihub2RlLmRlY2lkZXJGbik7XG4gICAgICBjb25zdCBpc1Njb3BlQmFzZWRTZWxlY3RvciA9IEJvb2xlYW4obm9kZS5zZWxlY3RvckZuKTtcbiAgICAgIGNvbnN0IGlzRGVjaWRlck5vZGUgPSBpc1Njb3BlQmFzZWREZWNpZGVyO1xuICAgICAgY29uc3QgaGFzQ2hpbGRyZW4gPSBCb29sZWFuKG5vZGUuY2hpbGRyZW4/Lmxlbmd0aCk7XG4gICAgICBjb25zdCBoYXNOZXh0ID0gQm9vbGVhbihub2RlLm5leHQpO1xuICAgICAgY29uc3Qgb3JpZ2luYWxOZXh0ID0gbm9kZS5uZXh0O1xuXG4gICAgICAvLyDilIDilIDilIAgUGhhc2UgMTogVkFMSURBVEUg4oCUIG5vZGUgaW52YXJpYW50cyDilIDilIDilIBcbiAgICAgIGlmICghaGFzU3RhZ2VGdW5jdGlvbiAmJiAhaXNEZWNpZGVyTm9kZSAmJiAhaXNTY29wZUJhc2VkU2VsZWN0b3IgJiYgIWhhc0NoaWxkcmVuKSB7XG4gICAgICAgIGNvbnN0IGVycm9yTWVzc2FnZSA9IGBOb2RlICcke25vZGUubmFtZX0nIG11c3QgZGVmaW5lOiBlbWJlZGRlZCBmbiBPUiBhIHN0YWdlTWFwIGVudHJ5IE9SIGhhdmUgY2hpbGRyZW4vZGVjaWRlcmA7XG4gICAgICAgIHRoaXMubG9nZ2VyLmVycm9yKGBFcnJvciBpbiBwaXBlbGluZSAoJHticmFuY2hQYXRofSkgc3RhZ2UgWyR7bm9kZS5uYW1lfV06YCwgeyBlcnJvcjogZXJyb3JNZXNzYWdlIH0pO1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoZXJyb3JNZXNzYWdlKTtcbiAgICAgIH1cbiAgICAgIGlmIChpc0RlY2lkZXJOb2RlICYmICFoYXNDaGlsZHJlbikge1xuICAgICAgICBjb25zdCBlcnJvck1lc3NhZ2UgPSAnRGVjaWRlciBub2RlIG5lZWRzIHRvIGhhdmUgY2hpbGRyZW4gdG8gZXhlY3V0ZSc7XG4gICAgICAgIHRoaXMubG9nZ2VyLmVycm9yKGBFcnJvciBpbiBwaXBlbGluZSAoJHticmFuY2hQYXRofSkgc3RhZ2UgWyR7bm9kZS5uYW1lfV06YCwgeyBlcnJvcjogZXJyb3JNZXNzYWdlIH0pO1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoZXJyb3JNZXNzYWdlKTtcbiAgICAgIH1cbiAgICAgIGlmIChpc1Njb3BlQmFzZWRTZWxlY3RvciAmJiAhaGFzQ2hpbGRyZW4pIHtcbiAgICAgICAgY29uc3QgZXJyb3JNZXNzYWdlID0gJ1NlbGVjdG9yIG5vZGUgbmVlZHMgdG8gaGF2ZSBjaGlsZHJlbiB0byBleGVjdXRlJztcbiAgICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoYEVycm9yIGluIHBpcGVsaW5lICgke2JyYW5jaFBhdGh9KSBzdGFnZSBbJHtub2RlLm5hbWV9XTpgLCB7IGVycm9yOiBlcnJvck1lc3NhZ2UgfSk7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihlcnJvck1lc3NhZ2UpO1xuICAgICAgfVxuXG4gICAgICAvLyBSb2xlIG1hcmtlcnMgZm9yIGRlYnVnIHBhbmVsc1xuICAgICAgaWYgKCFoYXNTdGFnZUZ1bmN0aW9uKSB7XG4gICAgICAgIGlmIChpc0RlY2lkZXJOb2RlKSBjb250ZXh0LnNldEFzRGVjaWRlcigpO1xuICAgICAgICBlbHNlIGlmIChoYXNDaGlsZHJlbikgY29udGV4dC5zZXRBc0ZvcmsoKTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgYnJlYWtGbiA9ICgpID0+IChicmVha0ZsYWcuc2hvdWxkQnJlYWsgPSB0cnVlKTtcblxuICAgICAgLy8g4pSA4pSA4pSAIFBoYXNlIDJhOiBTRUxFQ1RPUiDigJQgc2NvcGUtYmFzZWQgbXVsdGktY2hvaWNlIOKUgOKUgOKUgFxuICAgICAgaWYgKGlzU2NvcGVCYXNlZFNlbGVjdG9yKSB7XG4gICAgICAgIGNvbnN0IHByZXZpb3VzRm9ya0lkID0gdGhpcy5leHRyYWN0b3JSdW5uZXIuY3VycmVudEZvcmtJZDtcbiAgICAgICAgdGhpcy5leHRyYWN0b3JSdW5uZXIuY3VycmVudEZvcmtJZCA9IG5vZGUuaWQ7XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBzZWxlY3RvclJlc3VsdCA9IGF3YWl0IHRoaXMuc2VsZWN0b3JIYW5kbGVyLmhhbmRsZVNjb3BlQmFzZWQoXG4gICAgICAgICAgICBub2RlLFxuICAgICAgICAgICAgc3RhZ2VGdW5jISxcbiAgICAgICAgICAgIGNvbnRleHQsXG4gICAgICAgICAgICBicmVha0ZsYWcsXG4gICAgICAgICAgICBicmFuY2hQYXRoLFxuICAgICAgICAgICAgdGhpcy5leGVjdXRlU3RhZ2UuYmluZCh0aGlzKSxcbiAgICAgICAgICAgIHRoaXMuZXhlY3V0ZU5vZGUuYmluZCh0aGlzKSxcbiAgICAgICAgICAgIHRoaXMuZXh0cmFjdG9yUnVubmVyLmNhbGxFeHRyYWN0b3IuYmluZCh0aGlzLmV4dHJhY3RvclJ1bm5lciksXG4gICAgICAgICAgICB0aGlzLmV4dHJhY3RvclJ1bm5lci5nZXRTdGFnZVBhdGguYmluZCh0aGlzLmV4dHJhY3RvclJ1bm5lciksXG4gICAgICAgICAgICB0cmF2ZXJzYWxDb250ZXh0LFxuICAgICAgICAgICk7XG5cbiAgICAgICAgICBpZiAoaGFzTmV4dCkge1xuICAgICAgICAgICAgY29uc3QgbmV4dEN0eCA9IGNvbnRleHQuY3JlYXRlTmV4dChicmFuY2hQYXRoIGFzIHN0cmluZywgbm9kZS5uZXh0IS5uYW1lLCBub2RlLm5leHQhLmlkKTtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCB0aGlzLmV4ZWN1dGVOb2RlKG5vZGUubmV4dCEsIG5leHRDdHgsIGJyZWFrRmxhZywgYnJhbmNoUGF0aCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiBzZWxlY3RvclJlc3VsdDtcbiAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICB0aGlzLmV4dHJhY3RvclJ1bm5lci5jdXJyZW50Rm9ya0lkID0gcHJldmlvdXNGb3JrSWQ7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8g4pSA4pSA4pSAIFBoYXNlIDJiOiBERUNJREVSIOKAlCBzY29wZS1iYXNlZCBzaW5nbGUtY2hvaWNlIGNvbmRpdGlvbmFsIGJyYW5jaCDilIDilIDilIBcbiAgICAgIGlmIChpc0RlY2lkZXJOb2RlKSB7XG4gICAgICAgIGNvbnN0IGRlY2lkZXJSZXN1bHQgPSBhd2FpdCB0aGlzLmRlY2lkZXJIYW5kbGVyLmhhbmRsZVNjb3BlQmFzZWQoXG4gICAgICAgICAgbm9kZSxcbiAgICAgICAgICBzdGFnZUZ1bmMhLFxuICAgICAgICAgIGNvbnRleHQsXG4gICAgICAgICAgYnJlYWtGbGFnLFxuICAgICAgICAgIGJyYW5jaFBhdGgsXG4gICAgICAgICAgdGhpcy5leGVjdXRlU3RhZ2UuYmluZCh0aGlzKSxcbiAgICAgICAgICB0aGlzLmV4ZWN1dGVOb2RlLmJpbmQodGhpcyksXG4gICAgICAgICAgdGhpcy5leHRyYWN0b3JSdW5uZXIuY2FsbEV4dHJhY3Rvci5iaW5kKHRoaXMuZXh0cmFjdG9yUnVubmVyKSxcbiAgICAgICAgICB0aGlzLmV4dHJhY3RvclJ1bm5lci5nZXRTdGFnZVBhdGguYmluZCh0aGlzLmV4dHJhY3RvclJ1bm5lciksXG4gICAgICAgICAgdHJhdmVyc2FsQ29udGV4dCxcbiAgICAgICAgKTtcblxuICAgICAgICAvLyBBZnRlciBicmFuY2ggZXhlY3V0aW9uLCBmb2xsb3cgZGVjaWRlcidzIG93biBuZXh0IChlLmcuLCBsb29wVG8gdGFyZ2V0KVxuICAgICAgICBpZiAoaGFzTmV4dCAmJiAhYnJlYWtGbGFnLnNob3VsZEJyZWFrKSB7XG4gICAgICAgICAgY29uc3QgbmV4dE5vZGUgPSBvcmlnaW5hbE5leHQhO1xuICAgICAgICAgIC8vIFVzZSB0aGUgaXNMb29wUmVmIGZsYWcgc2V0IGJ5IGxvb3BUbygpIOKAlCBkbyBub3QgcmVseSBvbiBzdGFnZU1hcCBhYnNlbmNlLFxuICAgICAgICAgIC8vIHNpbmNlIGlkLWtleWVkIHN0YWdlTWFwcyB3b3VsZCBvdGhlcndpc2UgY2F1c2UgbG9vcCB0YXJnZXRzIHRvIGJlIGV4ZWN1dGVkIGRpcmVjdGx5LlxuICAgICAgICAgIGNvbnN0IGlzTG9vcFJlZiA9XG4gICAgICAgICAgICBuZXh0Tm9kZS5pc0xvb3BSZWYgPT09IHRydWUgfHxcbiAgICAgICAgICAgICghdGhpcy5nZXRTdGFnZUZuKG5leHROb2RlKSAmJlxuICAgICAgICAgICAgICAhbmV4dE5vZGUuY2hpbGRyZW4/Lmxlbmd0aCAmJlxuICAgICAgICAgICAgICAhbmV4dE5vZGUuZGVjaWRlckZuICYmXG4gICAgICAgICAgICAgICFuZXh0Tm9kZS5zZWxlY3RvckZuICYmXG4gICAgICAgICAgICAgICFuZXh0Tm9kZS5pc1N1YmZsb3dSb290KTtcblxuICAgICAgICAgIGlmIChpc0xvb3BSZWYpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmNvbnRpbnVhdGlvblJlc29sdmVyLnJlc29sdmUoXG4gICAgICAgICAgICAgIG5leHROb2RlLFxuICAgICAgICAgICAgICBub2RlLFxuICAgICAgICAgICAgICBjb250ZXh0LFxuICAgICAgICAgICAgICBicmVha0ZsYWcsXG4gICAgICAgICAgICAgIGJyYW5jaFBhdGgsXG4gICAgICAgICAgICAgIHRoaXMuZXhlY3V0ZU5vZGUuYmluZCh0aGlzKSxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgdGhpcy5uYXJyYXRpdmVHZW5lcmF0b3Iub25OZXh0KG5vZGUubmFtZSwgbmV4dE5vZGUubmFtZSwgbmV4dE5vZGUuZGVzY3JpcHRpb24sIHRyYXZlcnNhbENvbnRleHQpO1xuICAgICAgICAgIGNvbnN0IG5leHRDdHggPSBjb250ZXh0LmNyZWF0ZU5leHQoYnJhbmNoUGF0aCBhcyBzdHJpbmcsIG5leHROb2RlLm5hbWUsIG5leHROb2RlLmlkKTtcbiAgICAgICAgICByZXR1cm4gYXdhaXQgdGhpcy5leGVjdXRlTm9kZShuZXh0Tm9kZSwgbmV4dEN0eCwgYnJlYWtGbGFnLCBicmFuY2hQYXRoKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBkZWNpZGVyUmVzdWx0O1xuICAgICAgfVxuXG4gICAgICAvLyDilIDilIDilIAgQWJvcnQgY2hlY2sg4oCUIGNvb3BlcmF0aXZlIGNhbmNlbGxhdGlvbiDilIDilIDilIBcbiAgICAgIGlmICh0aGlzLnNpZ25hbD8uYWJvcnRlZCkge1xuICAgICAgICBjb25zdCByZWFzb24gPVxuICAgICAgICAgIHRoaXMuc2lnbmFsLnJlYXNvbiBpbnN0YW5jZW9mIEVycm9yID8gdGhpcy5zaWduYWwucmVhc29uIDogbmV3IEVycm9yKHRoaXMuc2lnbmFsLnJlYXNvbiA/PyAnQWJvcnRlZCcpO1xuICAgICAgICB0aHJvdyByZWFzb247XG4gICAgICB9XG5cbiAgICAgIC8vIOKUgOKUgOKUgCBQaGFzZSAzOiBFWEVDVVRFIOKAlCBydW4gc3RhZ2UgZnVuY3Rpb24g4pSA4pSA4pSAXG4gICAgICBsZXQgc3RhZ2VPdXRwdXQ6IFRPdXQgfCB1bmRlZmluZWQ7XG4gICAgICBsZXQgZHluYW1pY05leHQ6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+IHwgdW5kZWZpbmVkO1xuXG4gICAgICBpZiAoc3RhZ2VGdW5jKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgc3RhZ2VPdXRwdXQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVTdGFnZShub2RlLCBzdGFnZUZ1bmMsIGNvbnRleHQsIGJyZWFrRm4pO1xuICAgICAgICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgICAgICAgLy8gUGF1c2VTaWduYWwgaXMgZXhwZWN0ZWQgY29udHJvbCBmbG93LCBub3QgYW4gZXJyb3Ig4oCUIGZpcmUgbmFycmF0aXZlLCBjb21taXQsIHJlLXRocm93LlxuICAgICAgICAgIGlmIChpc1BhdXNlU2lnbmFsKGVycm9yKSkge1xuICAgICAgICAgICAgY29udGV4dC5jb21taXQoKTtcbiAgICAgICAgICAgIHRoaXMubmFycmF0aXZlR2VuZXJhdG9yLm9uUGF1c2Uobm9kZS5uYW1lLCBub2RlLmlkLCBlcnJvci5wYXVzZURhdGEsIGVycm9yLnN1YmZsb3dQYXRoLCB0cmF2ZXJzYWxDb250ZXh0KTtcbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb250ZXh0LmNvbW1pdCgpO1xuICAgICAgICAgIHRoaXMuZXh0cmFjdG9yUnVubmVyLmNhbGxFeHRyYWN0b3IoXG4gICAgICAgICAgICBub2RlLFxuICAgICAgICAgICAgY29udGV4dCxcbiAgICAgICAgICAgIHRoaXMuZXh0cmFjdG9yUnVubmVyLmdldFN0YWdlUGF0aChub2RlLCBicmFuY2hQYXRoLCBjb250ZXh0LnN0YWdlTmFtZSksXG4gICAgICAgICAgICB1bmRlZmluZWQsXG4gICAgICAgICAgICB7IHR5cGU6ICdzdGFnZUV4ZWN1dGlvbkVycm9yJywgbWVzc2FnZTogZXJyb3IudG9TdHJpbmcoKSB9LFxuICAgICAgICAgICk7XG4gICAgICAgICAgdGhpcy5uYXJyYXRpdmVHZW5lcmF0b3Iub25FcnJvcihub2RlLm5hbWUsIGVycm9yLnRvU3RyaW5nKCksIGVycm9yLCB0cmF2ZXJzYWxDb250ZXh0KTtcbiAgICAgICAgICB0aGlzLmxvZ2dlci5lcnJvcihgRXJyb3IgaW4gcGlwZWxpbmUgKCR7YnJhbmNoUGF0aH0pIHN0YWdlIFske25vZGUubmFtZX1dOmAsIHsgZXJyb3IgfSk7XG4gICAgICAgICAgY29udGV4dC5hZGRFcnJvcignc3RhZ2VFeGVjdXRpb25FcnJvcicsIGVycm9yLnRvU3RyaW5nKCkpO1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgICAgIGNvbnRleHQuY29tbWl0KCk7XG4gICAgICAgIHRoaXMuZXh0cmFjdG9yUnVubmVyLmNhbGxFeHRyYWN0b3IoXG4gICAgICAgICAgbm9kZSxcbiAgICAgICAgICBjb250ZXh0LFxuICAgICAgICAgIHRoaXMuZXh0cmFjdG9yUnVubmVyLmdldFN0YWdlUGF0aChub2RlLCBicmFuY2hQYXRoLCBjb250ZXh0LnN0YWdlTmFtZSksXG4gICAgICAgICAgc3RhZ2VPdXRwdXQsXG4gICAgICAgICk7XG4gICAgICAgIHRoaXMubmFycmF0aXZlR2VuZXJhdG9yLm9uU3RhZ2VFeGVjdXRlZChub2RlLm5hbWUsIG5vZGUuZGVzY3JpcHRpb24sIHRyYXZlcnNhbENvbnRleHQpO1xuXG4gICAgICAgIGlmIChicmVha0ZsYWcuc2hvdWxkQnJlYWspIHtcbiAgICAgICAgICB0aGlzLm5hcnJhdGl2ZUdlbmVyYXRvci5vbkJyZWFrKG5vZGUubmFtZSwgdHJhdmVyc2FsQ29udGV4dCk7XG4gICAgICAgICAgdGhpcy5sb2dnZXIuaW5mbyhgRXhlY3V0aW9uIHN0b3BwZWQgaW4gcGlwZWxpbmUgKCR7YnJhbmNoUGF0aH0pIGFmdGVyICR7bm9kZS5uYW1lfSBkdWUgdG8gYnJlYWsgY29uZGl0aW9uLmApO1xuICAgICAgICAgIHJldHVybiBzdGFnZU91dHB1dDtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIOKUgOKUgOKUgCBQaGFzZSA0OiBEWU5BTUlDIOKAlCBTdGFnZU5vZGUgcmV0dXJuIGRldGVjdGlvbiDilIDilIDilIBcbiAgICAgICAgaWYgKHN0YWdlT3V0cHV0ICYmIHR5cGVvZiBzdGFnZU91dHB1dCA9PT0gJ29iamVjdCcgJiYgaXNTdGFnZU5vZGVSZXR1cm4oc3RhZ2VPdXRwdXQpKSB7XG4gICAgICAgICAgY29uc3QgZHluYW1pY05vZGUgPSBzdGFnZU91dHB1dCBhcyBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPjtcbiAgICAgICAgICBjb250ZXh0LmFkZExvZygnaXNEeW5hbWljJywgdHJ1ZSk7XG4gICAgICAgICAgY29udGV4dC5hZGRMb2coJ2R5bmFtaWNQYXR0ZXJuJywgJ1N0YWdlTm9kZVJldHVybicpO1xuXG4gICAgICAgICAgLy8gRHluYW1pYyBzdWJmbG93IGF1dG8tcmVnaXN0cmF0aW9uXG4gICAgICAgICAgaWYgKGR5bmFtaWNOb2RlLmlzU3ViZmxvd1Jvb3QgJiYgZHluYW1pY05vZGUuc3ViZmxvd0RlZiAmJiBkeW5hbWljTm9kZS5zdWJmbG93SWQpIHtcbiAgICAgICAgICAgIGNvbnRleHQuYWRkTG9nKCdkeW5hbWljUGF0dGVybicsICdkeW5hbWljU3ViZmxvdycpO1xuICAgICAgICAgICAgY29udGV4dC5hZGRMb2coJ2R5bmFtaWNTdWJmbG93SWQnLCBkeW5hbWljTm9kZS5zdWJmbG93SWQpO1xuXG4gICAgICAgICAgICAvLyBTdHJ1Y3R1cmFsLW9ubHkgc3ViZmxvdzogaGFzIGJ1aWxkVGltZVN0cnVjdHVyZSBidXQgbm8gZXhlY3V0YWJsZSByb290LlxuICAgICAgICAgICAgLy8gVXNlZCBmb3IgcHJlLWV4ZWN1dGVkIHN1YmZsb3dzIChlLmcuLCBpbm5lciBmbG93cyB0aGF0IGFscmVhZHkgcmFuKS5cbiAgICAgICAgICAgIC8vIEFubm90YXRlcyB0aGUgbm9kZSBmb3IgdmlzdWFsaXphdGlvbiB3aXRob3V0IHJlLWV4ZWN1dGluZy5cbiAgICAgICAgICAgIGlmICghZHluYW1pY05vZGUuc3ViZmxvd0RlZi5yb290KSB7XG4gICAgICAgICAgICAgIGNvbnRleHQuYWRkTG9nKCdkeW5hbWljUGF0dGVybicsICdzdHJ1Y3R1cmFsU3ViZmxvdycpO1xuICAgICAgICAgICAgICBub2RlLmlzU3ViZmxvd1Jvb3QgPSB0cnVlO1xuICAgICAgICAgICAgICBub2RlLnN1YmZsb3dJZCA9IGR5bmFtaWNOb2RlLnN1YmZsb3dJZDtcbiAgICAgICAgICAgICAgbm9kZS5zdWJmbG93TmFtZSA9IGR5bmFtaWNOb2RlLnN1YmZsb3dOYW1lO1xuICAgICAgICAgICAgICBub2RlLmRlc2NyaXB0aW9uID0gZHluYW1pY05vZGUuZGVzY3JpcHRpb24gPz8gbm9kZS5kZXNjcmlwdGlvbjtcblxuICAgICAgICAgICAgICB0aGlzLnN0cnVjdHVyZU1hbmFnZXIudXBkYXRlRHluYW1pY1N1YmZsb3coXG4gICAgICAgICAgICAgICAgbm9kZS5pZCxcbiAgICAgICAgICAgICAgICBkeW5hbWljTm9kZS5zdWJmbG93SWQhLFxuICAgICAgICAgICAgICAgIGR5bmFtaWNOb2RlLnN1YmZsb3dOYW1lLFxuICAgICAgICAgICAgICAgIGR5bmFtaWNOb2RlLnN1YmZsb3dEZWYuYnVpbGRUaW1lU3RydWN0dXJlLFxuICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgIC8vIEZhbGwgdGhyb3VnaCB0byBQaGFzZSA1IChjb250aW51YXRpb24pIOKAlCBubyBzdWJmbG93IGV4ZWN1dGlvbiBuZWVkZWRcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIC8vIEZ1bGwgZHluYW1pYyBzdWJmbG93OiByZWdpc3RlciArIGV4ZWN1dGVcbiAgICAgICAgICAgICAgdGhpcy5hdXRvUmVnaXN0ZXJTdWJmbG93RGVmKGR5bmFtaWNOb2RlLnN1YmZsb3dJZCwgZHluYW1pY05vZGUuc3ViZmxvd0RlZiwgbm9kZS5pZCk7XG5cbiAgICAgICAgICAgICAgbm9kZS5pc1N1YmZsb3dSb290ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgbm9kZS5zdWJmbG93SWQgPSBkeW5hbWljTm9kZS5zdWJmbG93SWQ7XG4gICAgICAgICAgICAgIG5vZGUuc3ViZmxvd05hbWUgPSBkeW5hbWljTm9kZS5zdWJmbG93TmFtZTtcbiAgICAgICAgICAgICAgbm9kZS5zdWJmbG93TW91bnRPcHRpb25zID0gZHluYW1pY05vZGUuc3ViZmxvd01vdW50T3B0aW9ucztcblxuICAgICAgICAgICAgICB0aGlzLnN0cnVjdHVyZU1hbmFnZXIudXBkYXRlRHluYW1pY1N1YmZsb3coXG4gICAgICAgICAgICAgICAgbm9kZS5pZCxcbiAgICAgICAgICAgICAgICBkeW5hbWljTm9kZS5zdWJmbG93SWQhLFxuICAgICAgICAgICAgICAgIGR5bmFtaWNOb2RlLnN1YmZsb3dOYW1lLFxuICAgICAgICAgICAgICAgIGR5bmFtaWNOb2RlLnN1YmZsb3dEZWY/LmJ1aWxkVGltZVN0cnVjdHVyZSxcbiAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgdGhpcy5leGVjdXRlTm9kZShub2RlLCBjb250ZXh0LCBicmVha0ZsYWcsIGJyYW5jaFBhdGgpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIENoZWNrIGNoaWxkcmVuIGZvciBzdWJmbG93RGVmXG4gICAgICAgICAgaWYgKGR5bmFtaWNOb2RlLmNoaWxkcmVuKSB7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIGR5bmFtaWNOb2RlLmNoaWxkcmVuKSB7XG4gICAgICAgICAgICAgIGlmIChjaGlsZC5pc1N1YmZsb3dSb290ICYmIGNoaWxkLnN1YmZsb3dEZWYgJiYgY2hpbGQuc3ViZmxvd0lkKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5hdXRvUmVnaXN0ZXJTdWJmbG93RGVmKGNoaWxkLnN1YmZsb3dJZCwgY2hpbGQuc3ViZmxvd0RlZiwgY2hpbGQuaWQpO1xuICAgICAgICAgICAgICAgIHRoaXMuc3RydWN0dXJlTWFuYWdlci51cGRhdGVEeW5hbWljU3ViZmxvdyhcbiAgICAgICAgICAgICAgICAgIGNoaWxkLmlkLFxuICAgICAgICAgICAgICAgICAgY2hpbGQuc3ViZmxvd0lkISxcbiAgICAgICAgICAgICAgICAgIGNoaWxkLnN1YmZsb3dOYW1lLFxuICAgICAgICAgICAgICAgICAgY2hpbGQuc3ViZmxvd0RlZj8uYnVpbGRUaW1lU3RydWN0dXJlLFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBEeW5hbWljIGNoaWxkcmVuIChmb3JrIHBhdHRlcm4pXG4gICAgICAgICAgaWYgKGR5bmFtaWNOb2RlLmNoaWxkcmVuICYmIGR5bmFtaWNOb2RlLmNoaWxkcmVuLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIG5vZGUuY2hpbGRyZW4gPSBkeW5hbWljTm9kZS5jaGlsZHJlbjtcbiAgICAgICAgICAgIGNvbnRleHQuYWRkTG9nKCdkeW5hbWljQ2hpbGRDb3VudCcsIGR5bmFtaWNOb2RlLmNoaWxkcmVuLmxlbmd0aCk7XG4gICAgICAgICAgICBjb250ZXh0LmFkZExvZyhcbiAgICAgICAgICAgICAgJ2R5bmFtaWNDaGlsZElkcycsXG4gICAgICAgICAgICAgIGR5bmFtaWNOb2RlLmNoaWxkcmVuLm1hcCgoYykgPT4gYy5pZCksXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICB0aGlzLnN0cnVjdHVyZU1hbmFnZXIudXBkYXRlRHluYW1pY0NoaWxkcmVuKFxuICAgICAgICAgICAgICBub2RlLmlkLFxuICAgICAgICAgICAgICBkeW5hbWljTm9kZS5jaGlsZHJlbixcbiAgICAgICAgICAgICAgQm9vbGVhbihkeW5hbWljTm9kZS5uZXh0Tm9kZVNlbGVjdG9yKSxcbiAgICAgICAgICAgICAgQm9vbGVhbihkeW5hbWljTm9kZS5kZWNpZGVyRm4pLFxuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgaWYgKHR5cGVvZiBkeW5hbWljTm9kZS5uZXh0Tm9kZVNlbGVjdG9yID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICAgIG5vZGUubmV4dE5vZGVTZWxlY3RvciA9IGR5bmFtaWNOb2RlLm5leHROb2RlU2VsZWN0b3I7XG4gICAgICAgICAgICAgIGNvbnRleHQuYWRkTG9nKCdoYXNTZWxlY3RvcicsIHRydWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIER5bmFtaWMgbmV4dCAobGluZWFyIGNvbnRpbnVhdGlvbilcbiAgICAgICAgICBpZiAoZHluYW1pY05vZGUubmV4dCkge1xuICAgICAgICAgICAgZHluYW1pY05leHQgPSBkeW5hbWljTm9kZS5uZXh0O1xuICAgICAgICAgICAgdGhpcy5zdHJ1Y3R1cmVNYW5hZ2VyLnVwZGF0ZUR5bmFtaWNOZXh0KG5vZGUuaWQsIGR5bmFtaWNOb2RlLm5leHQpO1xuICAgICAgICAgICAgbm9kZS5uZXh0ID0gZHluYW1pY05vZGUubmV4dDtcbiAgICAgICAgICAgIGNvbnRleHQuYWRkTG9nKCdoYXNEeW5hbWljTmV4dCcsIHRydWUpO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIHN0YWdlT3V0cHV0ID0gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gUmVzdG9yZSBvcmlnaW5hbCBuZXh0IHRvIGF2b2lkIHN0YWxlIHJlZmVyZW5jZSBvbiBsb29wIHJldmlzaXRcbiAgICAgICAgaWYgKGR5bmFtaWNOZXh0KSB7XG4gICAgICAgICAgbm9kZS5uZXh0ID0gb3JpZ2luYWxOZXh0O1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIOKUgOKUgOKUgCBQaGFzZSA1OiBDSElMRFJFTiDigJQgZm9yayBkaXNwYXRjaCDilIDilIDilIBcbiAgICAgIGNvbnN0IGhhc0NoaWxkcmVuQWZ0ZXJTdGFnZSA9IEJvb2xlYW4obm9kZS5jaGlsZHJlbj8ubGVuZ3RoKTtcblxuICAgICAgaWYgKGhhc0NoaWxkcmVuQWZ0ZXJTdGFnZSkge1xuICAgICAgICBjb250ZXh0LmFkZExvZygndG90YWxDaGlsZHJlbicsIG5vZGUuY2hpbGRyZW4/Lmxlbmd0aCk7XG4gICAgICAgIGNvbnRleHQuYWRkTG9nKCdvcmRlck9mRXhlY3V0aW9uJywgJ0NoaWxkcmVuQWZ0ZXJTdGFnZScpO1xuXG4gICAgICAgIGxldCBub2RlQ2hpbGRyZW5SZXN1bHRzOiBSZWNvcmQ8c3RyaW5nLCBOb2RlUmVzdWx0VHlwZT47XG5cbiAgICAgICAgaWYgKG5vZGUubmV4dE5vZGVTZWxlY3Rvcikge1xuICAgICAgICAgIGNvbnN0IHByZXZpb3VzRm9ya0lkID0gdGhpcy5leHRyYWN0b3JSdW5uZXIuY3VycmVudEZvcmtJZDtcbiAgICAgICAgICB0aGlzLmV4dHJhY3RvclJ1bm5lci5jdXJyZW50Rm9ya0lkID0gbm9kZS5pZDtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgbm9kZUNoaWxkcmVuUmVzdWx0cyA9IGF3YWl0IHRoaXMuY2hpbGRyZW5FeGVjdXRvci5leGVjdXRlU2VsZWN0ZWRDaGlsZHJlbihcbiAgICAgICAgICAgICAgbm9kZS5uZXh0Tm9kZVNlbGVjdG9yLFxuICAgICAgICAgICAgICBub2RlLmNoaWxkcmVuISxcbiAgICAgICAgICAgICAgc3RhZ2VPdXRwdXQsXG4gICAgICAgICAgICAgIGNvbnRleHQsXG4gICAgICAgICAgICAgIGJyYW5jaFBhdGggYXMgc3RyaW5nLFxuICAgICAgICAgICAgICB0cmF2ZXJzYWxDb250ZXh0LFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgdGhpcy5leHRyYWN0b3JSdW5uZXIuY3VycmVudEZvcmtJZCA9IHByZXZpb3VzRm9ya0lkO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBjb25zdCBjaGlsZENvdW50ID0gbm9kZS5jaGlsZHJlbj8ubGVuZ3RoID8/IDA7XG4gICAgICAgICAgY29uc3QgY2hpbGROYW1lcyA9IG5vZGUuY2hpbGRyZW4/Lm1hcCgoYykgPT4gYy5uYW1lKS5qb2luKCcsICcpO1xuICAgICAgICAgIGNvbnRleHQuYWRkRmxvd0RlYnVnTWVzc2FnZSgnY2hpbGRyZW4nLCBgRXhlY3V0aW5nIGFsbCAke2NoaWxkQ291bnR9IGNoaWxkcmVuIGluIHBhcmFsbGVsOiAke2NoaWxkTmFtZXN9YCwge1xuICAgICAgICAgICAgY291bnQ6IGNoaWxkQ291bnQsXG4gICAgICAgICAgICB0YXJnZXRTdGFnZTogbm9kZS5jaGlsZHJlbj8ubWFwKChjKSA9PiBjLm5hbWUpLFxuICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgY29uc3QgcHJldmlvdXNGb3JrSWQgPSB0aGlzLmV4dHJhY3RvclJ1bm5lci5jdXJyZW50Rm9ya0lkO1xuICAgICAgICAgIHRoaXMuZXh0cmFjdG9yUnVubmVyLmN1cnJlbnRGb3JrSWQgPSBub2RlLmlkO1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBub2RlQ2hpbGRyZW5SZXN1bHRzID0gYXdhaXQgdGhpcy5jaGlsZHJlbkV4ZWN1dG9yLmV4ZWN1dGVOb2RlQ2hpbGRyZW4oXG4gICAgICAgICAgICAgIG5vZGUsXG4gICAgICAgICAgICAgIGNvbnRleHQsXG4gICAgICAgICAgICAgIHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgYnJhbmNoUGF0aCxcbiAgICAgICAgICAgICAgdHJhdmVyc2FsQ29udGV4dCxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgIHRoaXMuZXh0cmFjdG9yUnVubmVyLmN1cnJlbnRGb3JrSWQgPSBwcmV2aW91c0ZvcmtJZDtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBGb3JrLW9ubHk6IHJldHVybiBidW5kbGVcbiAgICAgICAgaWYgKCFoYXNOZXh0ICYmICFkeW5hbWljTmV4dCkge1xuICAgICAgICAgIHJldHVybiBub2RlQ2hpbGRyZW5SZXN1bHRzITtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENhcHR1cmUgZHluYW1pYyBjaGlsZHJlbiBhcyBzeW50aGV0aWMgc3ViZmxvdyByZXN1bHQgZm9yIFVJXG4gICAgICAgIGNvbnN0IGlzRHluYW1pYyA9IGNvbnRleHQuZGVidWc/LmxvZ0NvbnRleHQ/LmlzRHluYW1pYztcbiAgICAgICAgaWYgKGlzRHluYW1pYyAmJiBub2RlLmNoaWxkcmVuICYmIG5vZGUuY2hpbGRyZW4ubGVuZ3RoID4gMCkge1xuICAgICAgICAgIHRoaXMuY2FwdHVyZUR5bmFtaWNDaGlsZHJlblJlc3VsdChub2RlLCBjb250ZXh0KTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyDilIDilIDilIAgUGhhc2UgNjogQ09OVElOVUUg4oCUIGR5bmFtaWMgbmV4dCAvIGxpbmVhciBuZXh0IOKUgOKUgOKUgFxuICAgICAgaWYgKGR5bmFtaWNOZXh0KSB7XG4gICAgICAgIHJldHVybiB0aGlzLmNvbnRpbnVhdGlvblJlc29sdmVyLnJlc29sdmUoXG4gICAgICAgICAgZHluYW1pY05leHQsXG4gICAgICAgICAgbm9kZSxcbiAgICAgICAgICBjb250ZXh0LFxuICAgICAgICAgIGJyZWFrRmxhZyxcbiAgICAgICAgICBicmFuY2hQYXRoLFxuICAgICAgICAgIHRoaXMuZXhlY3V0ZU5vZGUuYmluZCh0aGlzKSxcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgaWYgKGhhc05leHQpIHtcbiAgICAgICAgY29uc3QgbmV4dE5vZGUgPSBvcmlnaW5hbE5leHQhO1xuXG4gICAgICAgIC8vIERldGVjdCBsb29wIHJlZmVyZW5jZSBub2RlcyBjcmVhdGVkIGJ5IGxvb3BUbygpIOKAlCBtYXJrZWQgd2l0aCBpc0xvb3BSZWYgZmxhZy5cbiAgICAgICAgLy8gUm91dGUgdGhyb3VnaCBDb250aW51YXRpb25SZXNvbHZlciBmb3IgcHJvcGVyIElEIHJlc29sdXRpb24sIGl0ZXJhdGlvblxuICAgICAgICAvLyB0cmFja2luZywgYW5kIG5hcnJhdGl2ZSBnZW5lcmF0aW9uLlxuICAgICAgICBjb25zdCBpc0xvb3BSZWZlcmVuY2UgPSBuZXh0Tm9kZS5pc0xvb3BSZWY7XG5cbiAgICAgICAgaWYgKGlzTG9vcFJlZmVyZW5jZSkge1xuICAgICAgICAgIHJldHVybiB0aGlzLmNvbnRpbnVhdGlvblJlc29sdmVyLnJlc29sdmUoXG4gICAgICAgICAgICBuZXh0Tm9kZSxcbiAgICAgICAgICAgIG5vZGUsXG4gICAgICAgICAgICBjb250ZXh0LFxuICAgICAgICAgICAgYnJlYWtGbGFnLFxuICAgICAgICAgICAgYnJhbmNoUGF0aCxcbiAgICAgICAgICAgIHRoaXMuZXhlY3V0ZU5vZGUuYmluZCh0aGlzKSxcbiAgICAgICAgICAgIHRyYXZlcnNhbENvbnRleHQsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMubmFycmF0aXZlR2VuZXJhdG9yLm9uTmV4dChub2RlLm5hbWUsIG5leHROb2RlLm5hbWUsIG5leHROb2RlLmRlc2NyaXB0aW9uLCB0cmF2ZXJzYWxDb250ZXh0KTtcbiAgICAgICAgY29udGV4dC5hZGRGbG93RGVidWdNZXNzYWdlKCduZXh0JywgYE1vdmluZyB0byAke25leHROb2RlLm5hbWV9IHN0YWdlYCwge1xuICAgICAgICAgIHRhcmdldFN0YWdlOiBuZXh0Tm9kZS5uYW1lLFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgbmV4dEN0eCA9IGNvbnRleHQuY3JlYXRlTmV4dChicmFuY2hQYXRoIGFzIHN0cmluZywgbmV4dE5vZGUubmFtZSwgbmV4dE5vZGUuaWQpO1xuICAgICAgICByZXR1cm4gYXdhaXQgdGhpcy5leGVjdXRlTm9kZShuZXh0Tm9kZSwgbmV4dEN0eCwgYnJlYWtGbGFnLCBicmFuY2hQYXRoKTtcbiAgICAgIH1cblxuICAgICAgLy8g4pSA4pSA4pSAIFBoYXNlIDc6IExFQUYg4oCUIG5vIGNvbnRpbnVhdGlvbiDilIDilIDilIBcbiAgICAgIHJldHVybiBzdGFnZU91dHB1dDtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgdGhpcy5fZXhlY3V0ZURlcHRoLS07XG4gICAgfVxuICB9XG5cbiAgLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAIFByaXZhdGUgSGVscGVycyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBwcml2YXRlIGNhcHR1cmVEeW5hbWljQ2hpbGRyZW5SZXN1bHQobm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4sIGNvbnRleHQ6IFN0YWdlQ29udGV4dCk6IHZvaWQge1xuICAgIGNvbnN0IHBhcmVudFN0YWdlSWQgPSBjb250ZXh0LmdldFN0YWdlSWQoKTtcblxuICAgIGNvbnN0IGNoaWxkU3RydWN0dXJlOiBhbnkgPSB7XG4gICAgICBpZDogYCR7bm9kZS5pZH0tY2hpbGRyZW5gLFxuICAgICAgbmFtZTogJ0R5bmFtaWMgQ2hpbGRyZW4nLFxuICAgICAgdHlwZTogJ2ZvcmsnLFxuICAgICAgY2hpbGRyZW46IG5vZGUuY2hpbGRyZW4hLm1hcCgoYykgPT4gKHtcbiAgICAgICAgaWQ6IGMuaWQsXG4gICAgICAgIG5hbWU6IGMubmFtZSxcbiAgICAgICAgdHlwZTogJ3N0YWdlJyxcbiAgICAgIH0pKSxcbiAgICB9O1xuXG4gICAgY29uc3QgY2hpbGRTdGFnZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gICAgaWYgKGNvbnRleHQuY2hpbGRyZW4pIHtcbiAgICAgIGZvciAoY29uc3QgY2hpbGRDdHggb2YgY29udGV4dC5jaGlsZHJlbikge1xuICAgICAgICBjb25zdCBzbmFwc2hvdCA9IGNoaWxkQ3R4LmdldFNuYXBzaG90KCk7XG4gICAgICAgIGNoaWxkU3RhZ2VzW3NuYXBzaG90Lm5hbWUgfHwgc25hcHNob3QuaWRdID0ge1xuICAgICAgICAgIG5hbWU6IHNuYXBzaG90Lm5hbWUsXG4gICAgICAgICAgb3V0cHV0OiBzbmFwc2hvdC5sb2dzLFxuICAgICAgICAgIGVycm9yczogc25hcHNob3QuZXJyb3JzLFxuICAgICAgICAgIG1ldHJpY3M6IHNuYXBzaG90Lm1ldHJpY3MsXG4gICAgICAgICAgc3RhdHVzOiBzbmFwc2hvdC5lcnJvcnMgJiYgT2JqZWN0LmtleXMoc25hcHNob3QuZXJyb3JzKS5sZW5ndGggPiAwID8gJ2Vycm9yJyA6ICdzdWNjZXNzJyxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICB0aGlzLnN1YmZsb3dSZXN1bHRzLnNldChub2RlLmlkLCB7XG4gICAgICBzdWJmbG93SWQ6IG5vZGUuaWQsXG4gICAgICBzdWJmbG93TmFtZTogbm9kZS5uYW1lLFxuICAgICAgdHJlZUNvbnRleHQ6IHtcbiAgICAgICAgZ2xvYmFsQ29udGV4dDoge30sXG4gICAgICAgIHN0YWdlQ29udGV4dHM6IGNoaWxkU3RhZ2VzIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICAgICAgIGhpc3Rvcnk6IFtdLFxuICAgICAgfSxcbiAgICAgIHBhcmVudFN0YWdlSWQsXG4gICAgICBwaXBlbGluZVN0cnVjdHVyZTogY2hpbGRTdHJ1Y3R1cmUsXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGNvbXB1dGVDb250ZXh0RGVwdGgoY29udGV4dDogU3RhZ2VDb250ZXh0KTogbnVtYmVyIHtcbiAgICBsZXQgZGVwdGggPSAwO1xuICAgIGxldCBjdXJyZW50ID0gY29udGV4dC5wYXJlbnQ7XG4gICAgd2hpbGUgKGN1cnJlbnQpIHtcbiAgICAgIGRlcHRoKys7XG4gICAgICBjdXJyZW50ID0gY3VycmVudC5wYXJlbnQ7XG4gICAgfVxuICAgIHJldHVybiBkZXB0aDtcbiAgfVxuXG4gIHByaXZhdGUgcHJlZml4Tm9kZVRyZWUobm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4sIHByZWZpeDogc3RyaW5nKTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4ge1xuICAgIGlmICghbm9kZSkgcmV0dXJuIG5vZGU7XG4gICAgY29uc3QgY2xvbmU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+ID0geyAuLi5ub2RlIH07XG4gICAgY2xvbmUubmFtZSA9IGAke3ByZWZpeH0vJHtub2RlLm5hbWV9YDtcbiAgICBjbG9uZS5pZCA9IGAke3ByZWZpeH0vJHtjbG9uZS5pZH1gO1xuICAgIGlmIChjbG9uZS5zdWJmbG93SWQpIGNsb25lLnN1YmZsb3dJZCA9IGAke3ByZWZpeH0vJHtjbG9uZS5zdWJmbG93SWR9YDtcbiAgICBpZiAoY2xvbmUubmV4dCkgY2xvbmUubmV4dCA9IHRoaXMucHJlZml4Tm9kZVRyZWUoY2xvbmUubmV4dCwgcHJlZml4KTtcbiAgICBpZiAoY2xvbmUuY2hpbGRyZW4pIHtcbiAgICAgIGNsb25lLmNoaWxkcmVuID0gY2xvbmUuY2hpbGRyZW4ubWFwKChjKSA9PiB0aGlzLnByZWZpeE5vZGVUcmVlKGMsIHByZWZpeCkpO1xuICAgIH1cbiAgICByZXR1cm4gY2xvbmU7XG4gIH1cblxuICBwcml2YXRlIGF1dG9SZWdpc3RlclN1YmZsb3dEZWYoXG4gICAgc3ViZmxvd0lkOiBzdHJpbmcsXG4gICAgc3ViZmxvd0RlZjogTm9uTnVsbGFibGU8U3RhZ2VOb2RlWydzdWJmbG93RGVmJ10+LFxuICAgIG1vdW50Tm9kZUlkPzogc3RyaW5nLFxuICApOiB2b2lkIHtcbiAgICAvLyB0aGlzLnN1YmZsb3dzIGlzIGFsd2F5cyBpbml0aWFsaXplZCBpbiB0aGUgY29uc3RydWN0b3I7IHRoZSBudWxsIGd1YXJkIGJlbG93IGlzIHVucmVhY2hhYmxlLlxuICAgIGNvbnN0IHN1YmZsb3dzRGljdCA9IHRoaXMuc3ViZmxvd3M7XG5cbiAgICAvLyBGaXJzdC13cml0ZS13aW5zXG4gICAgY29uc3QgaXNOZXdSZWdpc3RyYXRpb24gPSAhc3ViZmxvd3NEaWN0W3N1YmZsb3dJZF07XG4gICAgaWYgKGlzTmV3UmVnaXN0cmF0aW9uICYmIHN1YmZsb3dEZWYucm9vdCkge1xuICAgICAgc3ViZmxvd3NEaWN0W3N1YmZsb3dJZF0gPSB7XG4gICAgICAgIHJvb3Q6IHN1YmZsb3dEZWYucm9vdCBhcyBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPixcbiAgICAgICAgLi4uKHN1YmZsb3dEZWYuYnVpbGRUaW1lU3RydWN0dXJlID8geyBidWlsZFRpbWVTdHJ1Y3R1cmU6IHN1YmZsb3dEZWYuYnVpbGRUaW1lU3RydWN0dXJlIH0gOiB7fSksXG4gICAgICB9IGFzIGFueTtcbiAgICB9XG5cbiAgICAvLyBNZXJnZSBzdGFnZU1hcCBlbnRyaWVzIChwYXJlbnQgZW50cmllcyBwcmVzZXJ2ZWQpXG4gICAgaWYgKHN1YmZsb3dEZWYuc3RhZ2VNYXApIHtcbiAgICAgIGZvciAoY29uc3QgW2tleSwgZm5dIG9mIEFycmF5LmZyb20oc3ViZmxvd0RlZi5zdGFnZU1hcC5lbnRyaWVzKCkpKSB7XG4gICAgICAgIGlmICghdGhpcy5zdGFnZU1hcC5oYXMoa2V5KSkge1xuICAgICAgICAgIHRoaXMuc3RhZ2VNYXAuc2V0KGtleSwgZm4gYXMgU3RhZ2VGdW5jdGlvbjxUT3V0LCBUU2NvcGU+KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIC8vIE1lcmdlIG5lc3RlZCBzdWJmbG93c1xuICAgIGlmIChzdWJmbG93RGVmLnN1YmZsb3dzKSB7XG4gICAgICBmb3IgKGNvbnN0IFtrZXksIGRlZl0gb2YgT2JqZWN0LmVudHJpZXMoc3ViZmxvd0RlZi5zdWJmbG93cykpIHtcbiAgICAgICAgaWYgKCFzdWJmbG93c0RpY3Rba2V5XSkge1xuICAgICAgICAgIHN1YmZsb3dzRGljdFtrZXldID0gZGVmIGFzIHsgcm9vdDogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gfTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChtb3VudE5vZGVJZCkge1xuICAgICAgdGhpcy5zdHJ1Y3R1cmVNYW5hZ2VyLnVwZGF0ZUR5bmFtaWNTdWJmbG93KFxuICAgICAgICBtb3VudE5vZGVJZCxcbiAgICAgICAgc3ViZmxvd0lkLFxuICAgICAgICBzdWJmbG93RGVmLnJvb3Q/LnN1YmZsb3dOYW1lIHx8IHN1YmZsb3dEZWYucm9vdD8ubmFtZSxcbiAgICAgICAgc3ViZmxvd0RlZi5idWlsZFRpbWVTdHJ1Y3R1cmUsXG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIE5vdGlmeSBGbG93UmVjb3JkZXJzIG9ubHkgb24gZmlyc3QgcmVnaXN0cmF0aW9uIChtYXRjaGVzIGZpcnN0LXdyaXRlLXdpbnMpXG4gICAgaWYgKGlzTmV3UmVnaXN0cmF0aW9uKSB7XG4gICAgICBjb25zdCBzdWJmbG93TmFtZSA9IHN1YmZsb3dEZWYucm9vdD8uc3ViZmxvd05hbWUgfHwgc3ViZmxvd0RlZi5yb290Py5uYW1lIHx8IHN1YmZsb3dJZDtcbiAgICAgIHRoaXMubmFycmF0aXZlR2VuZXJhdG9yLm9uU3ViZmxvd1JlZ2lzdGVyZWQoXG4gICAgICAgIHN1YmZsb3dJZCxcbiAgICAgICAgc3ViZmxvd05hbWUsXG4gICAgICAgIHN1YmZsb3dEZWYucm9vdD8uZGVzY3JpcHRpb24sXG4gICAgICAgIHN1YmZsb3dEZWYuYnVpbGRUaW1lU3RydWN0dXJlLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbn1cbiJdfQ==