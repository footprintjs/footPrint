"use strict";
/**
 * FlowChartExecutor — Public API for executing a compiled FlowChart.
 *
 * Wraps FlowchartTraverser. Build a chart with flowChart() and pass the result here:
 *
 *   const chart = flowChart('entry', entryFn).addFunction('process', processFn).build();
 *
 *   // No-options form (uses auto-detected TypedScope factory from the chart):
 *   const executor = new FlowChartExecutor(chart);
 *
 *   // Options-object form (preferred when you need to customize behavior):
 *   const executor = new FlowChartExecutor(chart, { scopeFactory: myFactory, enrichSnapshots: true });
 *
 *   // 2-param form (accepts a ScopeFactory directly, for backward compatibility):
 *   const executor = new FlowChartExecutor(chart, myFactory);
 *
 *   const result = await executor.run({ input: data, env: { traceId: 'req-123' } });
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FlowChartExecutor = void 0;
const CombinedNarrativeRecorder_js_1 = require("../engine/narrative/CombinedNarrativeRecorder.js");
const NarrativeFlowRecorder_js_1 = require("../engine/narrative/NarrativeFlowRecorder.js");
const ManifestFlowRecorder_js_1 = require("../engine/narrative/recorders/ManifestFlowRecorder.js");
const FlowchartTraverser_js_1 = require("../engine/traversal/FlowchartTraverser.js");
const types_js_1 = require("../engine/types.js");
const types_js_2 = require("../pause/types.js");
const ScopeFacade_js_1 = require("../scope/ScopeFacade.js");
const ExecutionRuntime_js_1 = require("./ExecutionRuntime.js");
const validateInput_js_1 = require("./validateInput.js");
/** Default scope factory — creates a plain ScopeFacade for each stage. */
const defaultScopeFactory = (ctx, stageName, readOnly, env) => new ScopeFacade_js_1.ScopeFacade(ctx, stageName, readOnly, env);
class FlowChartExecutor {
    /**
     * Create a FlowChartExecutor.
     *
     * **Options object form** (preferred):
     * ```typescript
     * new FlowChartExecutor(chart, { scopeFactory, enrichSnapshots: true })
     * ```
     *
     * **2-param form** (also supported):
     * ```typescript
     * new FlowChartExecutor(chart, scopeFactory)
     * ```
     *
     * @param flowChart - The compiled FlowChart returned by `flowChart(...).build()`
     * @param factoryOrOptions - A `ScopeFactory<TScope>` OR a `FlowChartExecutorOptions<TScope>` options object.
     */
    constructor(flowChart, factoryOrOptions) {
        var _a;
        this.narrativeEnabled = false;
        this.flowRecorders = [];
        this.scopeRecorders = [];
        this.sharedRedactedKeys = new Set();
        this.sharedRedactedFieldsByKey = new Map();
        // Detect options-object form vs factory form
        let scopeFactory;
        let defaultValuesForContext;
        let initialContext;
        let readOnlyContext;
        let throttlingErrorChecker;
        let streamHandlers;
        let scopeProtectionMode;
        let enrichSnapshots;
        if (typeof factoryOrOptions === 'function') {
            // 2-param form: new FlowChartExecutor(chart, scopeFactory)
            scopeFactory = factoryOrOptions;
        }
        else if (factoryOrOptions !== undefined) {
            // Options object form: new FlowChartExecutor(chart, { scopeFactory, enrichSnapshots, ... })
            const opts = factoryOrOptions;
            scopeFactory = opts.scopeFactory;
            defaultValuesForContext = opts.defaultValuesForContext;
            initialContext = opts.initialContext;
            readOnlyContext = opts.readOnlyContext;
            throttlingErrorChecker = opts.throttlingErrorChecker;
            streamHandlers = opts.streamHandlers;
            scopeProtectionMode = opts.scopeProtectionMode;
            enrichSnapshots = opts.enrichSnapshots;
        }
        this.flowChartArgs = {
            flowChart,
            scopeFactory: (_a = scopeFactory !== null && scopeFactory !== void 0 ? scopeFactory : flowChart.scopeFactory) !== null && _a !== void 0 ? _a : defaultScopeFactory,
            defaultValuesForContext,
            initialContext,
            readOnlyContext,
            throttlingErrorChecker,
            streamHandlers,
            scopeProtectionMode,
            enrichSnapshots,
        };
        this.traverser = this.createTraverser();
    }
    createTraverser(signal, readOnlyContextOverride, env, maxDepth, overrides) {
        var _a, _b, _c, _d, _e;
        const args = this.flowChartArgs;
        const fc = args.flowChart;
        const narrativeFlag = this.narrativeEnabled || ((_a = fc.enableNarrative) !== null && _a !== void 0 ? _a : false);
        // ── Composed scope factory ─────────────────────────────────────────
        // Collect all scope modifiers (recorders, redaction) into a single list,
        // then create ONE factory that applies them in a loop. Replaces the
        // previous 4-deep closure nesting with a flat, debuggable composition.
        if (overrides === null || overrides === void 0 ? void 0 : overrides.preserveRecorders) {
            // Resume mode: keep existing combinedRecorder so narrative accumulates
        }
        else if (narrativeFlag) {
            this.combinedRecorder = new CombinedNarrativeRecorder_js_1.CombinedNarrativeRecorder(this.narrativeOptions);
        }
        else {
            this.combinedRecorder = undefined;
        }
        this.sharedRedactedKeys = new Set();
        this.sharedRedactedFieldsByKey = new Map();
        const modifiers = [];
        // 1. Narrative recorder (if enabled)
        if (this.combinedRecorder) {
            const recorder = this.combinedRecorder;
            modifiers.push((scope) => {
                if (typeof scope.attachRecorder === 'function')
                    scope.attachRecorder(recorder);
            });
        }
        // 2. User-provided scope recorders
        if (this.scopeRecorders.length > 0) {
            const recorders = this.scopeRecorders;
            modifiers.push((scope) => {
                if (typeof scope.attachRecorder === 'function') {
                    for (const r of recorders)
                        scope.attachRecorder(r);
                }
            });
        }
        // 3. Redaction policy (conditional — only when policy is set)
        if (this.redactionPolicy) {
            const policy = this.redactionPolicy;
            modifiers.push((scope) => {
                if (typeof scope.useRedactionPolicy === 'function') {
                    scope.useRedactionPolicy(policy);
                }
            });
            // Pre-populate executor-level field redaction map from policy
            // so getRedactionReport() includes field-level redactions.
            if (policy.fields) {
                for (const [key, fields] of Object.entries(policy.fields)) {
                    this.sharedRedactedFieldsByKey.set(key, new Set(fields));
                }
            }
        }
        // Compose: base factory + modifiers in a single pass.
        // Shared redacted keys are ALWAYS wired up (unconditional — ensures cross-stage
        // propagation even without a policy, because stages can call setValue(key, val, true)
        // for per-call redaction). Optional modifiers (recorders, policy) are in the list.
        const baseFactory = args.scopeFactory;
        const sharedRedactedKeys = this.sharedRedactedKeys;
        const scopeFactory = ((ctx, stageName, readOnly, envArg) => {
            const scope = baseFactory(ctx, stageName, readOnly, envArg);
            // Always wire shared redaction state
            if (typeof scope.useSharedRedactedKeys === 'function') {
                scope.useSharedRedactedKeys(sharedRedactedKeys);
            }
            // Apply optional modifiers
            for (const mod of modifiers)
                mod(scope);
            return scope;
        });
        const effectiveRoot = (_b = overrides === null || overrides === void 0 ? void 0 : overrides.root) !== null && _b !== void 0 ? _b : fc.root;
        const effectiveInitialContext = (_c = overrides === null || overrides === void 0 ? void 0 : overrides.initialContext) !== null && _c !== void 0 ? _c : args.initialContext;
        let runtime;
        if (overrides === null || overrides === void 0 ? void 0 : overrides.existingRuntime) {
            // Resume mode: reuse existing runtime so execution tree continues from pause point.
            // Preserve the original root for getSnapshot() (full tree), then advance
            // rootStageContext to a continuation from the leaf (for traversal).
            runtime = overrides.existingRuntime;
            runtime.preserveSnapshotRoot();
            let leaf = runtime.rootStageContext;
            while (leaf.next)
                leaf = leaf.next;
            runtime.rootStageContext = leaf.createNext('', effectiveRoot.name, effectiveRoot.id);
        }
        else {
            runtime = new ExecutionRuntime_js_1.ExecutionRuntime(effectiveRoot.name, effectiveRoot.id, args.defaultValuesForContext, effectiveInitialContext);
        }
        return new FlowchartTraverser_js_1.FlowchartTraverser({
            root: effectiveRoot,
            stageMap: fc.stageMap,
            scopeFactory,
            executionRuntime: runtime,
            readOnlyContext: readOnlyContextOverride !== null && readOnlyContextOverride !== void 0 ? readOnlyContextOverride : args.readOnlyContext,
            throttlingErrorChecker: args.throttlingErrorChecker,
            streamHandlers: args.streamHandlers,
            extractor: fc.extractor,
            scopeProtectionMode: args.scopeProtectionMode,
            subflows: fc.subflows,
            enrichSnapshots: (_d = args.enrichSnapshots) !== null && _d !== void 0 ? _d : fc.enrichSnapshots,
            narrativeEnabled: narrativeFlag,
            buildTimeStructure: fc.buildTimeStructure,
            logger: (_e = fc.logger) !== null && _e !== void 0 ? _e : types_js_1.defaultLogger,
            signal,
            executionEnv: env,
            flowRecorders: this.buildFlowRecordersList(),
            ...(maxDepth !== undefined && { maxDepth }),
        });
    }
    enableNarrative(options) {
        this.narrativeEnabled = true;
        if (options)
            this.narrativeOptions = options;
    }
    /**
     * Set a declarative redaction policy that applies to all stages.
     * Must be called before run().
     */
    setRedactionPolicy(policy) {
        this.redactionPolicy = policy;
    }
    /**
     * Returns a compliance-friendly report of all redaction activity from the
     * most recent run. Never includes actual values.
     */
    getRedactionReport() {
        var _a, _b;
        const fieldRedactions = {};
        for (const [key, fields] of this.sharedRedactedFieldsByKey) {
            fieldRedactions[key] = [...fields];
        }
        return {
            redactedKeys: [...this.sharedRedactedKeys],
            fieldRedactions,
            patterns: ((_b = (_a = this.redactionPolicy) === null || _a === void 0 ? void 0 : _a.patterns) !== null && _b !== void 0 ? _b : []).map((p) => p.source),
        };
    }
    // ─── Pause/Resume ───
    /**
     * Returns the checkpoint from the most recent paused execution, or `undefined`
     * if the last run completed without pausing.
     *
     * The checkpoint is JSON-serializable — store it in Redis, Postgres, localStorage, etc.
     *
     * @example
     * ```typescript
     * const result = await executor.run({ input });
     * if (executor.isPaused()) {
     *   const checkpoint = executor.getCheckpoint()!;
     *   await redis.set(`session:${id}`, JSON.stringify(checkpoint));
     * }
     * ```
     */
    getCheckpoint() {
        return this.lastCheckpoint;
    }
    /** Returns `true` if the most recent run() was paused (checkpoint available). */
    isPaused() {
        return this.lastCheckpoint !== undefined;
    }
    /**
     * Resume a paused flowchart from a checkpoint.
     *
     * Restores the scope state, calls the paused stage's `resumeFn` with the
     * provided input, then continues traversal from the next stage.
     *
     * The checkpoint can come from `getCheckpoint()` on a previous run, or from
     * a serialized checkpoint stored in Redis/Postgres/localStorage.
     *
     * **Narrative/recorder state is reset on resume.** To keep a unified narrative
     * across pause/resume cycles, collect it before calling resume.
     *
     * @example
     * ```typescript
     * // After a pause...
     * const checkpoint = executor.getCheckpoint()!;
     * await redis.set(`session:${id}`, JSON.stringify(checkpoint));
     *
     * // Later (possibly different server, same chart)
     * const checkpoint = JSON.parse(await redis.get(`session:${id}`));
     * const executor = new FlowChartExecutor(chart);
     * const result = await executor.resume(checkpoint, { approved: true });
     * ```
     */
    async resume(checkpoint, resumeInput, options) {
        var _a, _b;
        this.lastCheckpoint = undefined;
        // ── Validate checkpoint structure (may come from untrusted external storage) ──
        if (!checkpoint ||
            typeof checkpoint !== 'object' ||
            typeof checkpoint.sharedState !== 'object' ||
            checkpoint.sharedState === null ||
            Array.isArray(checkpoint.sharedState)) {
            throw new Error('Invalid checkpoint: sharedState must be a plain object.');
        }
        if (typeof checkpoint.pausedStageId !== 'string' || checkpoint.pausedStageId === '') {
            throw new Error('Invalid checkpoint: pausedStageId must be a non-empty string.');
        }
        if (!Array.isArray(checkpoint.subflowPath) ||
            !checkpoint.subflowPath.every((s) => typeof s === 'string')) {
            throw new Error('Invalid checkpoint: subflowPath must be an array of strings.');
        }
        // Find the paused node in the graph
        const pausedNode = this.findNodeInGraph(checkpoint.pausedStageId, checkpoint.subflowPath);
        if (!pausedNode) {
            throw new Error(`Cannot resume: stage '${checkpoint.pausedStageId}' not found in flowchart. ` +
                'The chart may have changed since the checkpoint was created.');
        }
        if (!pausedNode.resumeFn) {
            throw new Error(`Cannot resume: stage '${pausedNode.name}' (${pausedNode.id}) has no resumeFn. ` +
                'Only stages created with addPausableFunction() can be resumed.');
        }
        // Build a synthetic resume node: calls resumeFn with resumeInput, then continues to original next.
        // resumeFn signature is (scope, input) per PausableHandler — wrap to match StageFunction(scope, breakFn).
        const resumeFn = pausedNode.resumeFn;
        const resumeStageFn = (scope) => {
            return resumeFn(scope, resumeInput);
        };
        const resumeNode = {
            name: pausedNode.name,
            id: pausedNode.id,
            description: pausedNode.description,
            fn: resumeStageFn,
            next: pausedNode.next,
        };
        // Don't clear recorders — resume continues from previous state.
        // Narrative, metrics, debug entries accumulate across pause/resume.
        // Reuse the existing runtime so the execution tree continues from the pause point.
        // preserveRecorders keeps the CombinedNarrativeRecorder so narrative accumulates.
        const existingRuntime = this.traverser.getRuntime();
        this.traverser = this.createTraverser(options === null || options === void 0 ? void 0 : options.signal, undefined, options === null || options === void 0 ? void 0 : options.env, options === null || options === void 0 ? void 0 : options.maxDepth, {
            root: resumeNode,
            initialContext: checkpoint.sharedState,
            preserveRecorders: true,
            existingRuntime,
        });
        // Fire onResume event on all recorders (flow + scope)
        const hasInput = resumeInput !== undefined;
        const flowResumeEvent = {
            stageName: pausedNode.name,
            stageId: pausedNode.id,
            hasInput,
        };
        if (this.combinedRecorder)
            this.combinedRecorder.onResume(flowResumeEvent);
        for (const r of this.flowRecorders)
            (_a = r.onResume) === null || _a === void 0 ? void 0 : _a.call(r, flowResumeEvent);
        const scopeResumeEvent = {
            stageName: pausedNode.name,
            stageId: pausedNode.id,
            hasInput,
            pipelineId: '',
            timestamp: Date.now(),
        };
        for (const r of this.scopeRecorders)
            (_b = r.onResume) === null || _b === void 0 ? void 0 : _b.call(r, scopeResumeEvent);
        try {
            return await this.traverser.execute();
        }
        catch (error) {
            if ((0, types_js_2.isPauseSignal)(error)) {
                const snapshot = this.traverser.getSnapshot();
                const sfResults = this.traverser.getSubflowResults();
                this.lastCheckpoint = {
                    sharedState: snapshot.sharedState,
                    executionTree: snapshot.executionTree,
                    pausedStageId: error.stageId,
                    subflowPath: error.subflowPath,
                    pauseData: error.pauseData,
                    ...(sfResults.size > 0 && { subflowResults: Object.fromEntries(sfResults) }),
                    pausedAt: Date.now(),
                };
                return { paused: true, checkpoint: this.lastCheckpoint };
            }
            throw error;
        }
    }
    /**
     * Find a StageNode in the compiled graph by ID.
     * Handles subflow paths by drilling into registered subflows.
     */
    findNodeInGraph(stageId, subflowPath) {
        var _a;
        const fc = this.flowChartArgs.flowChart;
        if (subflowPath.length === 0) {
            // Top-level: DFS from root
            return this.dfsFind(fc.root, stageId);
        }
        // Subflow: drill into the subflow chain, then search from the last subflow's root
        let subflowRoot;
        for (const sfId of subflowPath) {
            const subflow = (_a = fc.subflows) === null || _a === void 0 ? void 0 : _a[sfId];
            if (!subflow)
                return undefined;
            subflowRoot = subflow.root;
        }
        if (!subflowRoot)
            return undefined;
        return this.dfsFind(subflowRoot, stageId);
    }
    /** DFS search for a node by ID in the StageNode graph. Cycle-safe via visited set. */
    dfsFind(node, targetId, visited = new Set()) {
        // Skip loop back-edge references (they share the target's ID but have no fn/resumeFn)
        if (node.isLoopRef)
            return undefined;
        if (visited.has(node.id))
            return undefined;
        visited.add(node.id);
        if (node.id === targetId)
            return node;
        if (node.children) {
            for (const child of node.children) {
                const found = this.dfsFind(child, targetId, visited);
                if (found)
                    return found;
            }
        }
        if (node.next)
            return this.dfsFind(node.next, targetId, visited);
        return undefined;
    }
    // ─── Recorder Management ───
    /**
     * Attach a scope Recorder to observe data operations (reads, writes, commits).
     * Automatically attached to every ScopeFacade created during traversal.
     * Must be called before run().
     *
     * **Idempotent by ID:** If a recorder with the same `id` is already attached,
     * it is replaced (not duplicated). This prevents double-counting when both
     * a framework and the user attach the same recorder type.
     *
     * Built-in recorders use auto-increment IDs (`metrics-1`, `debug-1`, ...) by
     * default, so multiple instances with different configs coexist. To override
     * a framework-attached recorder, pass the same well-known ID.
     *
     * @example
     * ```typescript
     * // Multiple recorders with different configs — each gets a unique ID
     * executor.attachRecorder(new MetricRecorder());
     * executor.attachRecorder(new DebugRecorder({ verbosity: 'minimal' }));
     *
     * // Override a framework-attached recorder by passing its well-known ID
     * executor.attachRecorder(new MetricRecorder('metrics'));
     *
     * // Attaching twice with same ID replaces (no double-counting)
     * executor.attachRecorder(new MetricRecorder('my-metrics'));
     * executor.attachRecorder(new MetricRecorder('my-metrics')); // replaces previous
     * ```
     */
    attachRecorder(recorder) {
        // Replace existing recorder with same ID (idempotent — prevents double-counting)
        this.scopeRecorders = this.scopeRecorders.filter((r) => r.id !== recorder.id);
        this.scopeRecorders.push(recorder);
    }
    /** Detach all scope Recorders with the given ID. */
    detachRecorder(id) {
        this.scopeRecorders = this.scopeRecorders.filter((r) => r.id !== id);
    }
    /** Returns a defensive copy of attached scope Recorders. */
    getRecorders() {
        return [...this.scopeRecorders];
    }
    // ─── FlowRecorder Management ───
    /**
     * Attach a FlowRecorder to observe control flow events.
     * Automatically enables narrative if not already enabled.
     * Must be called before run() — recorders are passed to the traverser at creation time.
     *
     * **Idempotent by ID:** replaces existing recorder with same `id`.
     */
    attachFlowRecorder(recorder) {
        // Replace existing recorder with same ID (idempotent — prevents double-counting)
        this.flowRecorders = this.flowRecorders.filter((r) => r.id !== recorder.id);
        this.flowRecorders.push(recorder);
        this.narrativeEnabled = true;
    }
    /** Detach all FlowRecorders with the given ID. */
    detachFlowRecorder(id) {
        this.flowRecorders = this.flowRecorders.filter((r) => r.id !== id);
    }
    /** Returns a defensive copy of attached FlowRecorders. */
    getFlowRecorders() {
        return [...this.flowRecorders];
    }
    /**
     * Returns the execution narrative.
     *
     * When using ScopeFacade-based scopes, returns a combined narrative that
     * interleaves flow events (stages, decisions, forks) with data operations
     * (reads, writes, updates). For plain scopes without attachRecorder support,
     * returns flow-only narrative sentences.
     */
    getNarrative() {
        // Combined recorder builds the narrative inline during traversal — just read it
        if (this.combinedRecorder) {
            return this.combinedRecorder.getNarrative();
        }
        return this.traverser.getNarrative();
    }
    /**
     * Returns structured narrative entries for programmatic consumption.
     * Each entry has a type (stage, step, condition, fork, etc.), text, and depth.
     */
    getNarrativeEntries() {
        if (this.combinedRecorder) {
            return this.combinedRecorder.getEntries();
        }
        const flowSentences = this.traverser.getNarrative();
        return flowSentences.map((text) => ({ type: 'stage', text, depth: 0 }));
    }
    /**
     * Returns the combined FlowRecorders list. When narrative is enabled, includes:
     * - CombinedNarrativeRecorder (builds merged flow+data narrative inline)
     * - NarrativeFlowRecorder (keeps flow-only sentences for getFlowNarrative())
     * Plus any user-attached recorders.
     */
    buildFlowRecordersList() {
        const recorders = [];
        if (this.combinedRecorder) {
            recorders.push(this.combinedRecorder);
            // Keep the default NarrativeFlowRecorder so getFlowNarrative() still works
            recorders.push(new NarrativeFlowRecorder_js_1.NarrativeFlowRecorder());
        }
        recorders.push(...this.flowRecorders);
        return recorders.length > 0 ? recorders : undefined;
    }
    /**
     * Returns flow-only narrative sentences (without data operations).
     * Use this when you only want control flow descriptions.
     *
     * Sentences come from `NarrativeFlowRecorder` (a dedicated flow-only recorder automatically
     * attached when narrative is enabled). It emits both `onStageExecuted` sentences (one per
     * stage) AND `onNext` transition sentences (one per stage-to-stage transition), so for a
     * chart with N stages you will typically get more entries here than from `getNarrative()`.
     */
    getFlowNarrative() {
        return this.traverser.getNarrative();
    }
    async run(options) {
        var _a, _b;
        let signal = options === null || options === void 0 ? void 0 : options.signal;
        let timeoutId;
        // Create an internal AbortController for timeoutMs
        if ((options === null || options === void 0 ? void 0 : options.timeoutMs) && !signal) {
            const controller = new AbortController();
            signal = controller.signal;
            timeoutId = setTimeout(() => controller.abort(new Error(`Execution timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
        }
        // Validate input against inputSchema if both are present
        let validatedInput = options === null || options === void 0 ? void 0 : options.input;
        if (validatedInput && this.flowChartArgs.flowChart.inputSchema) {
            validatedInput = (0, validateInput_js_1.validateInput)(this.flowChartArgs.flowChart.inputSchema, validatedInput);
        }
        // User-attached recorders (flowRecorders + scopeRecorders) are cleared via clear() to prevent
        // cross-run accumulation. The combinedRecorder is NOT cleared here — createTraverser() always
        // creates a fresh CombinedNarrativeRecorder instance on each run, so stale state is never an issue.
        for (const r of this.flowRecorders) {
            (_a = r.clear) === null || _a === void 0 ? void 0 : _a.call(r);
        }
        for (const r of this.scopeRecorders) {
            (_b = r.clear) === null || _b === void 0 ? void 0 : _b.call(r);
        }
        this.lastCheckpoint = undefined;
        this.traverser = this.createTraverser(signal, validatedInput, options === null || options === void 0 ? void 0 : options.env, options === null || options === void 0 ? void 0 : options.maxDepth);
        try {
            return await this.traverser.execute();
        }
        catch (error) {
            if ((0, types_js_2.isPauseSignal)(error)) {
                // Build checkpoint from current execution state
                const snapshot = this.traverser.getSnapshot();
                const sfResults = this.traverser.getSubflowResults();
                this.lastCheckpoint = {
                    sharedState: snapshot.sharedState,
                    executionTree: snapshot.executionTree,
                    pausedStageId: error.stageId,
                    subflowPath: error.subflowPath,
                    pauseData: error.pauseData,
                    ...(sfResults.size > 0 && { subflowResults: Object.fromEntries(sfResults) }),
                    pausedAt: Date.now(),
                };
                // Return a PauseResult-shaped value so callers can check without try/catch
                return { paused: true, checkpoint: this.lastCheckpoint };
            }
            throw error;
        }
        finally {
            if (timeoutId !== undefined)
                clearTimeout(timeoutId);
        }
    }
    // ─── Introspection ───
    getSnapshot() {
        const snapshot = this.traverser.getSnapshot();
        const sfResults = this.traverser.getSubflowResults();
        if (sfResults.size > 0) {
            snapshot.subflowResults = Object.fromEntries(sfResults);
        }
        // Collect snapshot data from recorders that implement toSnapshot()
        const recorderSnapshots = [];
        for (const r of this.scopeRecorders) {
            if (r.toSnapshot) {
                const { name, data } = r.toSnapshot();
                recorderSnapshots.push({ id: r.id, name, data });
            }
        }
        for (const r of this.flowRecorders) {
            if (r.toSnapshot) {
                const { name, data } = r.toSnapshot();
                recorderSnapshots.push({ id: r.id, name, data });
            }
        }
        if (recorderSnapshots.length > 0) {
            snapshot.recorders = recorderSnapshots;
        }
        return snapshot;
    }
    /** @internal */
    getRuntime() {
        return this.traverser.getRuntime();
    }
    /** @internal */
    setRootObject(path, key, value) {
        this.traverser.setRootObject(path, key, value);
    }
    /** @internal */
    getBranchIds() {
        return this.traverser.getBranchIds();
    }
    /** @internal */
    getRuntimeRoot() {
        return this.traverser.getRuntimeRoot();
    }
    /** @internal */
    getRuntimeStructure() {
        return this.traverser.getRuntimeStructure();
    }
    /** @internal */
    getSubflowResults() {
        return this.traverser.getSubflowResults();
    }
    /** @internal */
    getExtractedResults() {
        return this.traverser.getExtractedResults();
    }
    /** @internal */
    getExtractorErrors() {
        return this.traverser.getExtractorErrors();
    }
    /**
     * Returns the subflow manifest from an attached ManifestFlowRecorder.
     * Returns empty array if no ManifestFlowRecorder is attached.
     */
    getSubflowManifest() {
        var _a;
        const recorder = this.flowRecorders.find((r) => r instanceof ManifestFlowRecorder_js_1.ManifestFlowRecorder);
        return (_a = recorder === null || recorder === void 0 ? void 0 : recorder.getManifest()) !== null && _a !== void 0 ? _a : [];
    }
    /**
     * Returns the full spec for a dynamically-registered subflow.
     * Requires an attached ManifestFlowRecorder that observed the registration.
     */
    getSubflowSpec(subflowId) {
        const recorder = this.flowRecorders.find((r) => r instanceof ManifestFlowRecorder_js_1.ManifestFlowRecorder);
        return recorder === null || recorder === void 0 ? void 0 : recorder.getSpec(subflowId);
    }
}
exports.FlowChartExecutor = FlowChartExecutor;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRmxvd0NoYXJ0RXhlY3V0b3IuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvbGliL3J1bm5lci9GbG93Q2hhcnRFeGVjdXRvci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBaUJHOzs7QUFHSCxtR0FBNkY7QUFDN0YsMkZBQXFGO0FBR3JGLG1HQUE2RjtBQUU3RixxRkFBK0U7QUFDL0UsaURBYTRCO0FBRTVCLGdEQUFrRDtBQUVsRCw0REFBc0Q7QUFFdEQsK0RBQXNHO0FBQ3RHLHlEQUFtRDtBQUVuRCwwRUFBMEU7QUFDMUUsTUFBTSxtQkFBbUIsR0FBaUIsQ0FBQyxHQUFHLEVBQUUsU0FBUyxFQUFFLFFBQVEsRUFBRSxHQUFHLEVBQUUsRUFBRSxDQUMxRSxJQUFJLDRCQUFXLENBQUMsR0FBRyxFQUFFLFNBQVMsRUFBRSxRQUFRLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFpRWpELE1BQWEsaUJBQWlCO0lBMkI1Qjs7Ozs7Ozs7Ozs7Ozs7O09BZUc7SUFDSCxZQUNFLFNBQWtDLEVBQ2xDLGdCQUEwRTs7UUEzQ3BFLHFCQUFnQixHQUFHLEtBQUssQ0FBQztRQUd6QixrQkFBYSxHQUFtQixFQUFFLENBQUM7UUFDbkMsbUJBQWMsR0FBZSxFQUFFLENBQUM7UUFFaEMsdUJBQWtCLEdBQUcsSUFBSSxHQUFHLEVBQVUsQ0FBQztRQUN2Qyw4QkFBeUIsR0FBRyxJQUFJLEdBQUcsRUFBdUIsQ0FBQztRQXNDakUsNkNBQTZDO1FBQzdDLElBQUksWUFBOEMsQ0FBQztRQUNuRCxJQUFJLHVCQUFnQyxDQUFDO1FBQ3JDLElBQUksY0FBdUIsQ0FBQztRQUM1QixJQUFJLGVBQXdCLENBQUM7UUFDN0IsSUFBSSxzQkFBaUUsQ0FBQztRQUN0RSxJQUFJLGNBQTBDLENBQUM7UUFDL0MsSUFBSSxtQkFBb0QsQ0FBQztRQUN6RCxJQUFJLGVBQW9DLENBQUM7UUFFekMsSUFBSSxPQUFPLGdCQUFnQixLQUFLLFVB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YUFBUixRQUFRLHVCQUFSLFFBQVEsQ0FBRSxXQUFXLEVBQUUsbUNBQUksRUFBRSxDQUFDO0lBQ3ZDLENBQUM7SUFFRDs7O09BR0c7SUFDSCxjQUFjLENBQUMsU0FBaUI7UUFDOUIsTUFBTSxRQUFRLEdBQUcsSUFBSSxDQUFDLGFBQWEsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsWUFBWSw4Q0FBb0IsQ0FFcEUsQ0FBQztRQUNkLE9BQU8sUUFBUSxhQUFSLFFBQVEsdUJBQVIsUUFBUSxDQUFFLE9BQU8sQ0FBQyxTQUFTLENBQUMsQ0FBQztJQUN0QyxDQUFDO0NBQ0Y7QUF4dEJELDhDQXd0QkMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEZsb3dDaGFydEV4ZWN1dG9yIOKAlCBQdWJsaWMgQVBJIGZvciBleGVjdXRpbmcgYSBjb21waWxlZCBGbG93Q2hhcnQuXG4gKlxuICogV3JhcHMgRmxvd2NoYXJ0VHJhdmVyc2VyLiBCdWlsZCBhIGNoYXJ0IHdpdGggZmxvd0NoYXJ0KCkgYW5kIHBhc3MgdGhlIHJlc3VsdCBoZXJlOlxuICpcbiAqICAgY29uc3QgY2hhcnQgPSBmbG93Q2hhcnQoJ2VudHJ5JywgZW50cnlGbikuYWRkRnVuY3Rpb24oJ3Byb2Nlc3MnLCBwcm9jZXNzRm4pLmJ1aWxkKCk7XG4gKlxuICogICAvLyBOby1vcHRpb25zIGZvcm0gKHVzZXMgYXV0by1kZXRlY3RlZCBUeXBlZFNjb3BlIGZhY3RvcnkgZnJvbSB0aGUgY2hhcnQpOlxuICogICBjb25zdCBleGVjdXRvciA9IG5ldyBGbG93Q2hhcnRFeGVjdXRvcihjaGFydCk7XG4gKlxuICogICAvLyBPcHRpb25zLW9iamVjdCBmb3JtIChwcmVmZXJyZWQgd2hlbiB5b3UgbmVlZCB0byBjdXN0b21pemUgYmVoYXZpb3IpOlxuICogICBjb25zdCBleGVjdXRvciA9IG5ldyBGbG93Q2hhcnRFeGVjdXRvcihjaGFydCwgeyBzY29wZUZhY3Rvcnk6IG15RmFjdG9yeSwgZW5yaWNoU25hcHNob3RzOiB0cnVlIH0pO1xuICpcbiAqICAgLy8gMi1wYXJhbSBmb3JtIChhY2NlcHRzIGEgU2NvcGVGYWN0b3J5IGRpcmVjdGx5LCBmb3IgYmFja3dhcmQgY29tcGF0aWJpbGl0eSk6XG4gKiAgIGNvbnN0IGV4ZWN1dG9yID0gbmV3IEZsb3dDaGFydEV4ZWN1dG9yKGNoYXJ0LCBteUZhY3RvcnkpO1xuICpcbiAqICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZXhlY3V0b3IucnVuKHsgaW5wdXQ6IGRhdGEsIGVudjogeyB0cmFjZUlkOiAncmVxLTEyMycgfSB9KTtcbiAqL1xuXG5pbXBvcnQgdHlwZSB7IENvbWJpbmVkTmFycmF0aXZlUmVjb3JkZXJPcHRpb25zIH0gZnJvbSAnLi4vZW5naW5lL25hcnJhdGl2ZS9Db21iaW5lZE5hcnJhdGl2ZVJlY29yZGVyLmpzJztcbmltcG9ydCB7IENvbWJpbmVkTmFycmF0aXZlUmVjb3JkZXIgfSBmcm9tICcuLi9lbmdpbmUvbmFycmF0aXZlL0NvbWJpbmVkTmFycmF0aXZlUmVjb3JkZXIuanMnO1xuaW1wb3J0IHsgTmFycmF0aXZlRmxvd1JlY29yZGVyIH0gZnJvbSAnLi4vZW5naW5lL25hcnJhdGl2ZS9OYXJyYXRpdmVGbG93UmVjb3JkZXIuanMnO1xuaW1wb3J0IHR5cGUgeyBDb21iaW5lZE5hcnJhdGl2ZUVudHJ5IH0gZnJvbSAnLi4vZW5naW5lL25hcnJhdGl2ZS9uYXJyYXRpdmVUeXBlcy5qcyc7XG5pbXBvcnQgdHlwZSB7IE1hbmlmZXN0RW50cnkgfSBmcm9tICcuLi9lbmdpbmUvbmFycmF0aXZlL3JlY29yZGVycy9NYW5pZmVzdEZsb3dSZWNvcmRlci5qcyc7XG5pbXBvcnQgeyBNYW5pZmVzdEZsb3dSZWNvcmRlciB9IGZyb20gJy4uL2VuZ2luZS9uYXJyYXRpdmUvcmVjb3JkZXJzL01hbmlmZXN0Rmxvd1JlY29yZGVyLmpzJztcbmltcG9ydCB0eXBlIHsgRmxvd1JlY29yZGVyIH0gZnJvbSAnLi4vZW5naW5lL25hcnJhdGl2ZS90eXBlcy5qcyc7XG5pbXBvcnQgeyBGbG93Y2hhcnRUcmF2ZXJzZXIgfSBmcm9tICcuLi9lbmdpbmUvdHJhdmVyc2FsL0Zsb3djaGFydFRyYXZlcnNlci5qcyc7XG5pbXBvcnQge1xuICB0eXBlIEV4ZWN1dG9yUmVzdWx0LFxuICB0eXBlIEV4dHJhY3RvckVycm9yLFxuICB0eXBlIEZsb3dDaGFydCxcbiAgdHlwZSBQYXVzZWRSZXN1bHQsXG4gIHR5cGUgUnVuT3B0aW9ucyxcbiAgdHlwZSBTY29wZUZhY3RvcnksXG4gIHR5cGUgU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlLFxuICB0eXBlIFN0YWdlTm9kZSxcbiAgdHlwZSBTdHJlYW1IYW5kbGVycyxcbiAgdHlwZSBTdWJmbG93UmVzdWx0LFxuICB0eXBlIFRyYXZlcnNhbFJlc3VsdCxcbiAgZGVmYXVsdExvZ2dlcixcbn0gZnJvbSAnLi4vZW5naW5lL3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHsgRmxvd2NoYXJ0Q2hlY2twb2ludCB9IGZyb20gJy4uL3BhdXNlL3R5cGVzLmpzJztcbmltcG9ydCB7IGlzUGF1c2VTaWduYWwgfSBmcm9tICcuLi9wYXVzZS90eXBlcy5qcyc7XG5pbXBvcnQgdHlwZSB7IFNjb3BlUHJvdGVjdGlvbk1vZGUgfSBmcm9tICcuLi9zY29wZS9wcm90ZWN0aW9uL3R5cGVzLmpzJztcbmltcG9ydCB7IFNjb3BlRmFjYWRlIH0gZnJvbSAnLi4vc2NvcGUvU2NvcGVGYWNhZGUuanMnO1xuaW1wb3J0IHR5cGUgeyBSZWNvcmRlciwgUmVkYWN0aW9uUG9saWN5LCBSZWRhY3Rpb25SZXBvcnQgfSBmcm9tICcuLi9zY29wZS90eXBlcy5qcyc7XG5pbXBvcnQgeyB0eXBlIFJlY29yZGVyU25hcHNob3QsIHR5cGUgUnVudGltZVNuYXBzaG90LCBFeGVjdXRpb25SdW50aW1lIH0gZnJvbSAnLi9FeGVjdXRpb25SdW50aW1lLmpzJztcbmltcG9ydCB7IHZhbGlkYXRlSW5wdXQgfSBmcm9tICcuL3ZhbGlkYXRlSW5wdXQuanMnO1xuXG4vKiogRGVmYXVsdCBzY29wZSBmYWN0b3J5IOKAlCBjcmVhdGVzIGEgcGxhaW4gU2NvcGVGYWNhZGUgZm9yIGVhY2ggc3RhZ2UuICovXG5jb25zdCBkZWZhdWx0U2NvcGVGYWN0b3J5OiBTY29wZUZhY3RvcnkgPSAoY3R4LCBzdGFnZU5hbWUsIHJlYWRPbmx5LCBlbnYpID0+XG4gIG5ldyBTY29wZUZhY2FkZShjdHgsIHN0YWdlTmFtZSwgcmVhZE9ubHksIGVudik7XG5cbi8qKlxuICogT3B0aW9ucyBvYmplY3QgZm9yIGBGbG93Q2hhcnRFeGVjdXRvcmAg4oCUIHByZWZlcnJlZCBvdmVyIHBvc2l0aW9uYWwgcGFyYW1zLlxuICpcbiAqIGBgYHR5cGVzY3JpcHRcbiAqIGNvbnN0IGV4ID0gbmV3IEZsb3dDaGFydEV4ZWN1dG9yKGNoYXJ0LCB7XG4gKiAgIHNjb3BlRmFjdG9yeTogbXlGYWN0b3J5LFxuICogICBlbnJpY2hTbmFwc2hvdHM6IHRydWUsXG4gKiB9KTtcbiAqIGBgYFxuICpcbiAqICoqU3luYyBub3RlIGZvciBtYWludGFpbmVyczoqKiBFdmVyeSBmaWVsZCBhZGRlZCBoZXJlIG11c3QgYWxzbyBhcHBlYXIgaW4gdGhlXG4gKiBgZmxvd0NoYXJ0QXJnc2AgcHJpdmF0ZSBmaWVsZCB0eXBlIGFuZCBpbiB0aGUgY29uc3RydWN0b3IncyBvcHRpb25zLXJlc29sdXRpb25cbiAqIGJsb2NrICh0aGUgYGVsc2UgaWZgIGJyYW5jaCB0aGF0IHJlYWRzIGZyb20gYG9wdHNgKS4gTWlzc2luZyBhbnkgb25lIG9mIHRoZVxuICogdGhyZWUgY2F1c2VzIHNpbGVudCBvbWlzc2lvbiDigJQgdGhlIG9wdGlvbiBpcyBhY2NlcHRlZCBidXQgbmV2ZXIgYXBwbGllZC5cbiAqXG4gKiAqKlRTY29wZSBpbmZlcmVuY2Ugbm90ZToqKiBXaGVuIHVzaW5nIHRoZSBvcHRpb25zLW9iamVjdCBmb3JtIHdpdGggYSBjdXN0b20gc2NvcGUsXG4gKiBUeXBlU2NyaXB0IGNhbm5vdCBpbmZlciBgVFNjb3BlYCB0aHJvdWdoIHRoZSBvcHRpb25zIG9iamVjdC4gUGFzcyB0aGUgdHlwZVxuICogZXhwbGljaXRseTogYG5ldyBGbG93Q2hhcnRFeGVjdXRvcjxUT3V0LCBNeVNjb3BlPihjaGFydCwgeyBzY29wZUZhY3RvcnkgfSlgLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEZsb3dDaGFydEV4ZWN1dG9yT3B0aW9uczxUU2NvcGUgPSBhbnk+IHtcbiAgLy8g4pSA4pSAIENvbW1vbiBvcHRpb25zIChtb3N0IGNhbGxlcnMgbmVlZCBvbmx5IHRoZXNlKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKiogQ3VzdG9tIHNjb3BlIGZhY3RvcnkuIERlZmF1bHRzIHRvIFR5cGVkU2NvcGUgb3IgU2NvcGVGYWNhZGUgYXV0by1kZXRlY3Rpb24uICovXG4gIHNjb3BlRmFjdG9yeT86IFNjb3BlRmFjdG9yeTxUU2NvcGU+O1xuICAvKipcbiAgICogQXR0YWNoIGEgcGVyLXN0YWdlIHNjb3BlIHNuYXBzaG90IHRvIGVhY2ggZXh0cmFjdG9yIHJlc3VsdC4gV2hlbiBgdHJ1ZWAsIHRoZVxuICAgKiBleHRyYWN0aW9uIGNhbGxiYWNrIHJlY2VpdmVzIHRoZSBmdWxsIHNoYXJlZCBzdGF0ZSBhdCB0aGUgcG9pbnQgdGhhdCBzdGFnZVxuICAgKiBjb21taXR0ZWQg4oCUIHVzZWZ1bCBmb3IgZGVidWdnaW5nIG11bHRpLXN0YWdlIHN0YXRlIHRyYW5zaXRpb25zLiBEZWZhdWx0cyB0b1xuICAgKiBgZmFsc2VgIChubyBzY29wZSBzbmFwc2hvdCBhdHRhY2hlZCkuIENhbiBhbHNvIGJlIHNldCBvbiB0aGUgY2hhcnQgdmlhXG4gICAqIGBmbG93Q2hhcnQoLi4uKS5lbnJpY2hTbmFwc2hvdHModHJ1ZSlgLlxuICAgKi9cbiAgZW5yaWNoU25hcHNob3RzPzogYm9vbGVhbjtcblxuICAvLyDilIDilIAgQ29udGV4dCBvcHRpb25zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKlxuICAgKiBEZWZhdWx0IHZhbHVlcyBwcmUtcG9wdWxhdGVkIGludG8gdGhlIHNoYXJlZCBjb250ZXh0IGJlZm9yZSAqKmVhY2gqKiBzdGFnZVxuICAgKiAocmUtYXBwbGllZCBldmVyeSBzdGFnZSwgYWN0aW5nIGFzIGJhc2VsaW5lIGRlZmF1bHRzKS5cbiAgICovXG4gIGRlZmF1bHRWYWx1ZXNGb3JDb250ZXh0PzogdW5rbm93bjtcbiAgLyoqXG4gICAqIEluaXRpYWwgY29udGV4dCB2YWx1ZXMgbWVyZ2VkIGludG8gdGhlIHNoYXJlZCBjb250ZXh0ICoqb25jZSoqIGF0IHN0YXJ0dXBcbiAgICogKGFwcGxpZWQgYmVmb3JlIHRoZSBmaXJzdCBzdGFnZSwgbm90IHJlcGVhdGVkIG9uIHN1YnNlcXVlbnQgc3RhZ2VzKS5cbiAgICogRGlzdGluY3QgZnJvbSBgZGVmYXVsdFZhbHVlc0ZvckNvbnRleHRgLCB3aGljaCBpcyByZS1hcHBsaWVkIGV2ZXJ5IHN0YWdlLlxuICAgKi9cbiAgaW5pdGlhbENvbnRleHQ/OiB1bmtub3duO1xuICAvKiogUmVhZC1vbmx5IGlucHV0IGFjY2Vzc2libGUgdmlhIGBzY29wZS5nZXRBcmdzKClgIOKAlCBuZXZlciB0cmFja2VkIG9yIHdyaXR0ZW4uICovXG4gIHJlYWRPbmx5Q29udGV4dD86IHVua25vd247XG5cbiAgLy8g4pSA4pSAIEFkdmFuY2VkIC8gZXNjYXBlLWhhdGNoIG9wdGlvbnMgKG1vc3QgY2FsbGVycyBkbyBub3QgbmVlZCB0aGVzZSkg4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIEN1c3RvbSBlcnJvciBjbGFzc2lmaWVyIGZvciB0aHJvdHRsaW5nIGRldGVjdGlvbi4gUmV0dXJuIGB0cnVlYCBpZiB0aGVcbiAgICogZXJyb3IgcmVwcmVzZW50cyBhIHJhdGUtbGltaXQgb3IgYmFja3ByZXNzdXJlIGNvbmRpdGlvbiAodGhlIGV4ZWN1dG9yIHdpbGxcbiAgICogdHJlYXQgaXQgZGlmZmVyZW50bHkgZnJvbSBoYXJkIGZhaWx1cmVzKS4gRGVmYXVsdHMgdG8gbm8gdGhyb3R0bGluZyBjbGFzc2lmaWNhdGlvbi5cbiAgICovXG4gIHRocm90dGxpbmdFcnJvckNoZWNrZXI/OiAoZXJyb3I6IHVua25vd24pID0+IGJvb2xlYW47XG4gIC8qKiBIYW5kbGVycyBmb3Igc3RyZWFtaW5nIHN0YWdlIGxpZmVjeWNsZSBldmVudHMgKHNlZSBgYWRkU3RyZWFtaW5nRnVuY3Rpb25gKS4gKi9cbiAgc3RyZWFtSGFuZGxlcnM/OiBTdHJlYW1IYW5kbGVycztcbiAgLyoqIFNjb3BlIHByb3RlY3Rpb24gbW9kZSBmb3IgVHlwZWRTY29wZSBkaXJlY3QtYXNzaWdubWVudCBkZXRlY3Rpb24uICovXG4gIHNjb3BlUHJvdGVjdGlvbk1vZGU/OiBTY29wZVByb3RlY3Rpb25Nb2RlO1xufVxuXG5leHBvcnQgY2xhc3MgRmxvd0NoYXJ0RXhlY3V0b3I8VE91dCA9IGFueSwgVFNjb3BlID0gYW55PiB7XG4gIHByaXZhdGUgdHJhdmVyc2VyOiBGbG93Y2hhcnRUcmF2ZXJzZXI8VE91dCwgVFNjb3BlPjtcbiAgcHJpdmF0ZSBuYXJyYXRpdmVFbmFibGVkID0gZmFsc2U7XG4gIHByaXZhdGUgbmFycmF0aXZlT3B0aW9ucz86IENvbWJpbmVkTmFycmF0aXZlUmVjb3JkZXJPcHRpb25zO1xuICBwcml2YXRlIGNvbWJpbmVkUmVjb3JkZXI6IENvbWJpbmVkTmFycmF0aXZlUmVjb3JkZXIgfCB1bmRlZmluZWQ7XG4gIHByaXZhdGUgZmxvd1JlY29yZGVyczogRmxvd1JlY29yZGVyW10gPSBbXTtcbiAgcHJpdmF0ZSBzY29wZVJlY29yZGVyczogUmVjb3JkZXJbXSA9IFtdO1xuICBwcml2YXRlIHJlZGFjdGlvblBvbGljeTogUmVkYWN0aW9uUG9saWN5IHwgdW5kZWZpbmVkO1xuICBwcml2YXRlIHNoYXJlZFJlZGFjdGVkS2V5cyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBwcml2YXRlIHNoYXJlZFJlZGFjdGVkRmllbGRzQnlLZXkgPSBuZXcgTWFwPHN0cmluZywgU2V0PHN0cmluZz4+KCk7XG4gIHByaXZhdGUgbGFzdENoZWNrcG9pbnQ6IEZsb3djaGFydENoZWNrcG9pbnQgfCB1bmRlZmluZWQ7XG5cbiAgLy8gU1lOQyBSRVFVSVJFRDogZXZlcnkgb3B0aW9uYWwgZmllbGQgaGVyZSBtdXN0IG1pcnJvciBGbG93Q2hhcnRFeGVjdXRvck9wdGlvbnNcbiAgLy8gQU5EIGJlIGFzc2lnbmVkIGluIHRoZSBjb25zdHJ1Y3RvcidzIG9wdGlvbnMtcmVzb2x1dGlvbiBibG9jayAodGhlIGBlbHNlIGlmYCBicmFuY2gpLlxuICAvLyBBZGRpbmcgYSBmaWVsZCB0byBvbmx5IG9uZSBvZiB0aGUgdGhyZWUgcGxhY2VzIGNhdXNlcyBzaWxlbnQgb21pc3Npb24uXG4gIHByaXZhdGUgcmVhZG9ubHkgZmxvd0NoYXJ0QXJnczoge1xuICAgIGZsb3dDaGFydDogRmxvd0NoYXJ0PFRPdXQsIFRTY29wZT47XG4gICAgc2NvcGVGYWN0b3J5OiBTY29wZUZhY3Rvcnk8VFNjb3BlPjtcbiAgICBkZWZhdWx0VmFsdWVzRm9yQ29udGV4dD86IHVua25vd247XG4gICAgaW5pdGlhbENvbnRleHQ/OiB1bmtub3duO1xuICAgIHJlYWRPbmx5Q29udGV4dD86IHVua25vd247XG4gICAgdGhyb3R0bGluZ0Vycm9yQ2hlY2tlcj86IChlcnJvcjogdW5rbm93bikgPT4gYm9vbGVhbjtcbiAgICBzdHJlYW1IYW5kbGVycz86IFN0cmVhbUhhbmRsZXJzO1xuICAgIHNjb3BlUHJvdGVjdGlvbk1vZGU/OiBTY29wZVByb3RlY3Rpb25Nb2RlO1xuICAgIGVucmljaFNuYXBzaG90cz86IGJvb2xlYW47XG4gIH07XG5cbiAgLyoqXG4gICAqIENyZWF0ZSBhIEZsb3dDaGFydEV4ZWN1dG9yLlxuICAgKlxuICAgKiAqKk9wdGlvbnMgb2JqZWN0IGZvcm0qKiAocHJlZmVycmVkKTpcbiAgICogYGBgdHlwZXNjcmlwdFxuICAgKiBuZXcgRmxvd0NoYXJ0RXhlY3V0b3IoY2hhcnQsIHsgc2NvcGVGYWN0b3J5LCBlbnJpY2hTbmFwc2hvdHM6IHRydWUgfSlcbiAgICogYGBgXG4gICAqXG4gICAqICoqMi1wYXJhbSBmb3JtKiogKGFsc28gc3VwcG9ydGVkKTpcbiAgICogYGBgdHlwZXNjcmlwdFxuICAgKiBuZXcgRmxvd0NoYXJ0RXhlY3V0b3IoY2hhcnQsIHNjb3BlRmFjdG9yeSlcbiAgICogYGBgXG4gICAqXG4gICAqIEBwYXJhbSBmbG93Q2hhcnQgLSBUaGUgY29tcGlsZWQgRmxvd0NoYXJ0IHJldHVybmVkIGJ5IGBmbG93Q2hhcnQoLi4uKS5idWlsZCgpYFxuICAgKiBAcGFyYW0gZmFjdG9yeU9yT3B0aW9ucyAtIEEgYFNjb3BlRmFjdG9yeTxUU2NvcGU+YCBPUiBhIGBGbG93Q2hhcnRFeGVjdXRvck9wdGlvbnM8VFNjb3BlPmAgb3B0aW9ucyBvYmplY3QuXG4gICAqL1xuICBjb25zdHJ1Y3RvcihcbiAgICBmbG93Q2hhcnQ6IEZsb3dDaGFydDxUT3V0LCBUU2NvcGU+LFxuICAgIGZhY3RvcnlPck9wdGlvbnM/OiBTY29wZUZhY3Rvcnk8VFNjb3BlPiB8IEZsb3dDaGFydEV4ZWN1dG9yT3B0aW9uczxUU2NvcGU+LFxuICApIHtcbiAgICAvLyBEZXRlY3Qgb3B0aW9ucy1vYmplY3QgZm9ybSB2cyBmYWN0b3J5IGZvcm1cbiAgICBsZXQgc2NvcGVGYWN0b3J5OiBTY29wZUZhY3Rvcnk8VFNjb3BlPiB8IHVuZGVmaW5lZDtcbiAgICBsZXQgZGVmYXVsdFZhbHVlc0ZvckNvbnRleHQ6IHVua25vd247XG4gICAgbGV0IGluaXRpYWxDb250ZXh0OiB1bmtub3duO1xuICAgIGxldCByZWFkT25seUNvbnRleHQ6IHVua25vd247XG4gICAgbGV0IHRocm90dGxpbmdFcnJvckNoZWNrZXI6ICgoZXJyb3I6IHVua25vd24pID0+IGJvb2xlYW4pIHwgdW5kZWZpbmVkO1xuICAgIGxldCBzdHJlYW1IYW5kbGVyczogU3RyZWFtSGFuZGxlcnMgfCB1bmRlZmluZWQ7XG4gICAgbGV0IHNjb3BlUHJvdGVjdGlvbk1vZGU6IFNjb3BlUHJvdGVjdGlvbk1vZGUgfCB1bmRlZmluZWQ7XG4gICAgbGV0IGVucmljaFNuYXBzaG90czogYm9vbGVhbiB8IHVuZGVmaW5lZDtcblxuICAgIGlmICh0eXBlb2YgZmFjdG9yeU9yT3B0aW9ucyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgLy8gMi1wYXJhbSBmb3JtOiBuZXcgRmxvd0NoYXJ0RXhlY3V0b3IoY2hhcnQsIHNjb3BlRmFjdG9yeSlcbiAgICAgIHNjb3BlRmFjdG9yeSA9IGZhY3RvcnlPck9wdGlvbnM7XG4gICAgfSBlbHNlIGlmIChmYWN0b3J5T3JPcHRpb25zICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIC8vIE9wdGlvbnMgb2JqZWN0IGZvcm06IG5ldyBGbG93Q2hhcnRFeGVjdXRvcihjaGFydCwgeyBzY29wZUZhY3RvcnksIGVucmljaFNuYXBzaG90cywgLi4uIH0pXG4gICAgICBjb25zdCBvcHRzID0gZmFjdG9yeU9yT3B0aW9ucztcbiAgICAgIHNjb3BlRmFjdG9yeSA9IG9wdHMuc2NvcGVGYWN0b3J5O1xuICAgICAgZGVmYXVsdFZhbHVlc0ZvckNvbnRleHQgPSBvcHRzLmRlZmF1bHRWYWx1ZXNGb3JDb250ZXh0O1xuICAgICAgaW5pdGlhbENvbnRleHQgPSBvcHRzLmluaXRpYWxDb250ZXh0O1xuICAgICAgcmVhZE9ubHlDb250ZXh0ID0gb3B0cy5yZWFkT25seUNvbnRleHQ7XG4gICAgICB0aHJvdHRsaW5nRXJyb3JDaGVja2VyID0gb3B0cy50aHJvdHRsaW5nRXJyb3JDaGVja2VyO1xuICAgICAgc3RyZWFtSGFuZGxlcnMgPSBvcHRzLnN0cmVhbUhhbmRsZXJzO1xuICAgICAgc2NvcGVQcm90ZWN0aW9uTW9kZSA9IG9wdHMuc2NvcGVQcm90ZWN0aW9uTW9kZTtcbiAgICAgIGVucmljaFNuYXBzaG90cyA9IG9wdHMuZW5yaWNoU25hcHNob3RzO1xuICAgIH1cbiAgICB0aGlzLmZsb3dDaGFydEFyZ3MgPSB7XG4gICAgICBmbG93Q2hhcnQsXG4gICAgICBzY29wZUZhY3Rvcnk6IHNjb3BlRmFjdG9yeSA/PyBmbG93Q2hhcnQuc2NvcGVGYWN0b3J5ID8/IChkZWZhdWx0U2NvcGVGYWN0b3J5IGFzIFNjb3BlRmFjdG9yeTxUU2NvcGU+KSxcbiAgICAgIGRlZmF1bHRWYWx1ZXNGb3JDb250ZXh0LFxuICAgICAgaW5pdGlhbENvbnRleHQsXG4gICAgICByZWFkT25seUNvbnRleHQsXG4gICAgICB0aHJvdHRsaW5nRXJyb3JDaGVja2VyLFxuICAgICAgc3RyZWFtSGFuZGxlcnMsXG4gICAgICBzY29wZVByb3RlY3Rpb25Nb2RlLFxuICAgICAgZW5yaWNoU25hcHNob3RzLFxuICAgIH07XG4gICAgdGhpcy50cmF2ZXJzZXIgPSB0aGlzLmNyZWF0ZVRyYXZlcnNlcigpO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVUcmF2ZXJzZXIoXG4gICAgc2lnbmFsPzogQWJvcnRTaWduYWwsXG4gICAgcmVhZE9ubHlDb250ZXh0T3ZlcnJpZGU/OiB1bmtub3duLFxuICAgIGVudj86IGltcG9ydCgnLi4vZW5naW5lL3R5cGVzJykuRXhlY3V0aW9uRW52LFxuICAgIG1heERlcHRoPzogbnVtYmVyLFxuICAgIG92ZXJyaWRlcz86IHtcbiAgICAgIHJvb3Q/OiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPjtcbiAgICAgIGluaXRpYWxDb250ZXh0PzogdW5rbm93bjtcbiAgICAgIHByZXNlcnZlUmVjb3JkZXJzPzogYm9vbGVhbjtcbiAgICAgIGV4aXN0aW5nUnVudGltZT86IEluc3RhbmNlVHlwZTx0eXBlb2YgRXhlY3V0aW9uUnVudGltZT47XG4gICAgfSxcbiAgKTogRmxvd2NoYXJ0VHJhdmVyc2VyPFRPdXQsIFRTY29wZT4ge1xuICAgIGNvbnN0IGFyZ3MgPSB0aGlzLmZsb3dDaGFydEFyZ3M7XG4gICAgY29uc3QgZmMgPSBhcmdzLmZsb3dDaGFydDtcbiAgICBjb25zdCBuYXJyYXRpdmVGbGFnID0gdGhpcy5uYXJyYXRpdmVFbmFibGVkIHx8IChmYy5lbmFibGVOYXJyYXRpdmUgPz8gZmFsc2UpO1xuXG4gICAgLy8g4pSA4pSAIENvbXBvc2VkIHNjb3BlIGZhY3Rvcnkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gICAgLy8gQ29sbGVjdCBhbGwgc2NvcGUgbW9kaWZpZXJzIChyZWNvcmRlcnMsIHJlZGFjdGlvbikgaW50byBhIHNpbmdsZSBsaXN0LFxuICAgIC8vIHRoZW4gY3JlYXRlIE9ORSBmYWN0b3J5IHRoYXQgYXBwbGllcyB0aGVtIGluIGEgbG9vcC4gUmVwbGFjZXMgdGhlXG4gICAgLy8gcHJldmlvdXMgNC1kZWVwIGNsb3N1cmUgbmVzdGluZyB3aXRoIGEgZmxhdCwgZGVidWdnYWJsZSBjb21wb3NpdGlvbi5cblxuICAgIGlmIChvdmVycmlkZXM/LnByZXNlcnZlUmVjb3JkZXJzKSB7XG4gICAgICAvLyBSZXN1bWUgbW9kZToga2VlcCBleGlzdGluZyBjb21iaW5lZFJlY29yZGVyIHNvIG5hcnJhdGl2ZSBhY2N1bXVsYXRlc1xuICAgIH0gZWxzZSBpZiAobmFycmF0aXZlRmxhZykge1xuICAgICAgdGhpcy5jb21iaW5lZFJlY29yZGVyID0gbmV3IENvbWJpbmVkTmFycmF0aXZlUmVjb3JkZXIodGhpcy5uYXJyYXRpdmVPcHRpb25zKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5jb21iaW5lZFJlY29yZGVyID0gdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIHRoaXMuc2hhcmVkUmVkYWN0ZWRLZXlzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgdGhpcy5zaGFyZWRSZWRhY3RlZEZpZWxkc0J5S2V5ID0gbmV3IE1hcDxzdHJpbmcsIFNldDxzdHJpbmc+PigpO1xuXG4gICAgLy8gQnVpbGQgbW9kaWZpZXIgbGlzdCDigJQgZWFjaCBtb2RpZmllciByZWNlaXZlcyB0aGUgc2NvcGUgYWZ0ZXIgY3JlYXRpb25cbiAgICB0eXBlIFNjb3BlTW9kaWZpZXIgPSAoc2NvcGU6IGFueSkgPT4gdm9pZDtcbiAgICBjb25zdCBtb2RpZmllcnM6IFNjb3BlTW9kaWZpZXJbXSA9IFtdO1xuXG4gICAgLy8gMS4gTmFycmF0aXZlIHJlY29yZGVyIChpZiBlbmFibGVkKVxuICAgIGlmICh0aGlzLmNvbWJpbmVkUmVjb3JkZXIpIHtcbiAgICAgIGNvbnN0IHJlY29yZGVyID0gdGhpcy5jb21iaW5lZFJlY29yZGVyO1xuICAgICAgbW9kaWZpZXJzLnB1c2goKHNjb3BlKSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2Ygc2NvcGUuYXR0YWNoUmVjb3JkZXIgPT09ICdmdW5jdGlvbicpIHNjb3BlLmF0dGFjaFJlY29yZGVyKHJlY29yZGVyKTtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIDIuIFVzZXItcHJvdmlkZWQgc2NvcGUgcmVjb3JkZXJzXG4gICAgaWYgKHRoaXMuc2NvcGVSZWNvcmRlcnMubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgcmVjb3JkZXJzID0gdGhpcy5zY29wZVJlY29yZGVycztcbiAgICAgIG1vZGlmaWVycy5wdXNoKChzY29wZSkgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIHNjb3BlLmF0dGFjaFJlY29yZGVyID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgZm9yIChjb25zdCByIG9mIHJlY29yZGVycykgc2NvcGUuYXR0YWNoUmVjb3JkZXIocik7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIDMuIFJlZGFjdGlvbiBwb2xpY3kgKGNvbmRpdGlvbmFsIOKAlCBvbmx5IHdoZW4gcG9saWN5IGlzIHNldClcbiAgICBpZiAodGhpcy5yZWRhY3Rpb25Qb2xpY3kpIHtcbiAgICAgIGNvbnN0IHBvbGljeSA9IHRoaXMucmVkYWN0aW9uUG9saWN5O1xuICAgICAgbW9kaWZpZXJzLnB1c2goKHNjb3BlKSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2Ygc2NvcGUudXNlUmVkYWN0aW9uUG9saWN5ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgc2NvcGUudXNlUmVkYWN0aW9uUG9saWN5KHBvbGljeSk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgLy8gUHJlLXBvcHVsYXRlIGV4ZWN1dG9yLWxldmVsIGZpZWxkIHJlZGFjdGlvbiBtYXAgZnJvbSBwb2xpY3lcbiAgICAgIC8vIHNvIGdldFJlZGFjdGlvblJlcG9ydCgpIGluY2x1ZGVzIGZpZWxkLWxldmVsIHJlZGFjdGlvbnMuXG4gICAgICBpZiAocG9saWN5LmZpZWxkcykge1xuICAgICAgICBmb3IgKGNvbnN0IFtrZXksIGZpZWxkc10gb2YgT2JqZWN0LmVudHJpZXMocG9saWN5LmZpZWxkcykpIHtcbiAgICAgICAgICB0aGlzLnNoYXJlZFJlZGFjdGVkRmllbGRzQnlLZXkuc2V0KGtleSwgbmV3IFNldChmaWVsZHMpKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIC8vIENvbXBvc2U6IGJhc2UgZmFjdG9yeSArIG1vZGlmaWVycyBpbiBhIHNpbmdsZSBwYXNzLlxuICAgIC8vIFNoYXJlZCByZWRhY3RlZCBrZXlzIGFyZSBBTFdBWVMgd2lyZWQgdXAgKHVuY29uZGl0aW9uYWwg4oCUIGVuc3VyZXMgY3Jvc3Mtc3RhZ2VcbiAgICAvLyBwcm9wYWdhdGlvbiBldmVuIHdpdGhvdXQgYSBwb2xpY3ksIGJlY2F1c2Ugc3RhZ2VzIGNhbiBjYWxsIHNldFZhbHVlKGtleSwgdmFsLCB0cnVlKVxuICAgIC8vIGZvciBwZXItY2FsbCByZWRhY3Rpb24pLiBPcHRpb25hbCBtb2RpZmllcnMgKHJlY29yZGVycywgcG9saWN5KSBhcmUgaW4gdGhlIGxpc3QuXG4gICAgY29uc3QgYmFzZUZhY3RvcnkgPSBhcmdzLnNjb3BlRmFjdG9yeTtcbiAgICBjb25zdCBzaGFyZWRSZWRhY3RlZEtleXMgPSB0aGlzLnNoYXJlZFJlZGFjdGVkS2V5cztcbiAgICBjb25zdCBzY29wZUZhY3RvcnkgPSAoKGN0eDogYW55LCBzdGFnZU5hbWU6IHN0cmluZywgcmVhZE9ubHk/OiB1bmtub3duLCBlbnZBcmc/OiBhbnkpID0+IHtcbiAgICAgIGNvbnN0IHNjb3BlID0gYmFzZUZhY3RvcnkoY3R4LCBzdGFnZU5hbWUsIHJlYWRPbmx5LCBlbnZBcmcpO1xuICAgICAgLy8gQWx3YXlzIHdpcmUgc2hhcmVkIHJlZGFjdGlvbiBzdGF0ZVxuICAgICAgaWYgKHR5cGVvZiAoc2NvcGUgYXMgYW55KS51c2VTaGFyZWRSZWRhY3RlZEtleXMgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgKHNjb3BlIGFzIGFueSkudXNlU2hhcmVkUmVkYWN0ZWRLZXlzKHNoYXJlZFJlZGFjdGVkS2V5cyk7XG4gICAgICB9XG4gICAgICAvLyBBcHBseSBvcHRpb25hbCBtb2RpZmllcnNcbiAgICAgIGZvciAoY29uc3QgbW9kIG9mIG1vZGlmaWVycykgbW9kKHNjb3BlKTtcbiAgICAgIHJldHVybiBzY29wZTtcbiAgICB9KSBhcyBTY29wZUZhY3Rvcnk8VFNjb3BlPjtcblxuICAgIGNvbnN0IGVmZmVjdGl2ZVJvb3QgPSBvdmVycmlkZXM/LnJvb3QgPz8gZmMucm9vdDtcbiAgICBjb25zdCBlZmZlY3RpdmVJbml0aWFsQ29udGV4dCA9IG92ZXJyaWRlcz8uaW5pdGlhbENvbnRleHQgPz8gYXJncy5pbml0aWFsQ29udGV4dDtcblxuICAgIGxldCBydW50aW1lOiBFeGVjdXRpb25SdW50aW1lO1xuICAgIGlmIChvdmVycmlkZXM/LmV4aXN0aW5nUnVudGltZSkge1xuICAgICAgLy8gUmVzdW1lIG1vZGU6IHJldXNlIGV4aXN0aW5nIHJ1bnRpbWUgc28gZXhlY3V0aW9uIHRyZWUgY29udGludWVzIGZyb20gcGF1c2UgcG9pbnQuXG4gICAgICAvLyBQcmVzZXJ2ZSB0aGUgb3JpZ2luYWwgcm9vdCBmb3IgZ2V0U25hcHNob3QoKSAoZnVsbCB0cmVlKSwgdGhlbiBhZHZhbmNlXG4gICAgICAvLyByb290U3RhZ2VDb250ZXh0IHRvIGEgY29udGludWF0aW9uIGZyb20gdGhlIGxlYWYgKGZvciB0cmF2ZXJzYWwpLlxuICAgICAgcnVudGltZSA9IG92ZXJyaWRlcy5leGlzdGluZ1J1bnRpbWU7XG4gICAgICBydW50aW1lLnByZXNlcnZlU25hcHNob3RSb290KCk7XG4gICAgICBsZXQgbGVhZiA9IHJ1bnRpbWUucm9vdFN0YWdlQ29udGV4dDtcbiAgICAgIHdoaWxlIChsZWFmLm5leHQpIGxlYWYgPSBsZWFmLm5leHQ7XG4gICAgICBydW50aW1lLnJvb3RTdGFnZUNvbnRleHQgPSBsZWFmLmNyZWF0ZU5leHQoJycsIGVmZmVjdGl2ZVJvb3QubmFtZSwgZWZmZWN0aXZlUm9vdC5pZCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJ1bnRpbWUgPSBuZXcgRXhlY3V0aW9uUnVudGltZShcbiAgICAgICAgZWZmZWN0aXZlUm9vdC5uYW1lLFxuICAgICAgICBlZmZlY3RpdmVSb290LmlkLFxuICAgICAgICBhcmdzLmRlZmF1bHRWYWx1ZXNGb3JDb250ZXh0LFxuICAgICAgICBlZmZlY3RpdmVJbml0aWFsQ29udGV4dCxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgcmV0dXJuIG5ldyBGbG93Y2hhcnRUcmF2ZXJzZXI8VE91dCwgVFNjb3BlPih7XG4gICAgICByb290OiBlZmZlY3RpdmVSb290LFxuICAgICAgc3RhZ2VNYXA6IGZjLnN0YWdlTWFwLFxuICAgICAgc2NvcGVGYWN0b3J5LFxuICAgICAgZXhlY3V0aW9uUnVudGltZTogcnVudGltZSxcbiAgICAgIHJlYWRPbmx5Q29udGV4dDogcmVhZE9ubHlDb250ZXh0T3ZlcnJpZGUgPz8gYXJncy5yZWFkT25seUNvbnRleHQsXG4gICAgICB0aHJvdHRsaW5nRXJyb3JDaGVja2VyOiBhcmdzLnRocm90dGxpbmdFcnJvckNoZWNrZXIsXG4gICAgICBzdHJlYW1IYW5kbGVyczogYXJncy5zdHJlYW1IYW5kbGVycyxcbiAgICAgIGV4dHJhY3RvcjogZmMuZXh0cmFjdG9yLFxuICAgICAgc2NvcGVQcm90ZWN0aW9uTW9kZTogYXJncy5zY29wZVByb3RlY3Rpb25Nb2RlLFxuICAgICAgc3ViZmxvd3M6IGZjLnN1YmZsb3dzLFxuICAgICAgZW5yaWNoU25hcHNob3RzOiBhcmdzLmVucmljaFNuYXBzaG90cyA/PyBmYy5lbnJpY2hTbmFwc2hvdHMsXG4gICAgICBuYXJyYXRpdmVFbmFibGVkOiBuYXJyYXRpdmVGbGFnLFxuICAgICAgYnVpbGRUaW1lU3RydWN0dXJlOiBmYy5idWlsZFRpbWVTdHJ1Y3R1cmUsXG4gICAgICBsb2dnZXI6IGZjLmxvZ2dlciA/PyBkZWZhdWx0TG9nZ2VyLFxuICAgICAgc2lnbmFsLFxuICAgICAgZXhlY3V0aW9uRW52OiBlbnYsXG4gICAgICBmbG93UmVjb3JkZXJzOiB0aGlzLmJ1aWxkRmxvd1JlY29yZGVyc0xpc3QoKSxcbiAgICAgIC4uLihtYXhEZXB0aCAhPT0gdW5kZWZpbmVkICYmIHsgbWF4RGVwdGggfSksXG4gICAgfSk7XG4gIH1cblxuICBlbmFibGVOYXJyYXRpdmUob3B0aW9ucz86IENvbWJpbmVkTmFycmF0aXZlUmVjb3JkZXJPcHRpb25zKTogdm9pZCB7XG4gICAgdGhpcy5uYXJyYXRpdmVFbmFibGVkID0gdHJ1ZTtcbiAgICBpZiAob3B0aW9ucykgdGhpcy5uYXJyYXRpdmVPcHRpb25zID0gb3B0aW9ucztcbiAgfVxuXG4gIC8qKlxuICAgKiBTZXQgYSBkZWNsYXJhdGl2ZSByZWRhY3Rpb24gcG9saWN5IHRoYXQgYXBwbGllcyB0byBhbGwgc3RhZ2VzLlxuICAgKiBNdXN0IGJlIGNhbGxlZCBiZWZvcmUgcnVuKCkuXG4gICAqL1xuICBzZXRSZWRhY3Rpb25Qb2xpY3kocG9saWN5OiBSZWRhY3Rpb25Qb2xpY3kpOiB2b2lkIHtcbiAgICB0aGlzLnJlZGFjdGlvblBvbGljeSA9IHBvbGljeTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXR1cm5zIGEgY29tcGxpYW5jZS1mcmllbmRseSByZXBvcnQgb2YgYWxsIHJlZGFjdGlvbiBhY3Rpdml0eSBmcm9tIHRoZVxuICAgKiBtb3N0IHJlY2VudCBydW4uIE5ldmVyIGluY2x1ZGVzIGFjdHVhbCB2YWx1ZXMuXG4gICAqL1xuICBnZXRSZWRhY3Rpb25SZXBvcnQoKTogUmVkYWN0aW9uUmVwb3J0IHtcbiAgICBjb25zdCBmaWVsZFJlZGFjdGlvbnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZ1tdPiA9IHt9O1xuICAgIGZvciAoY29uc3QgW2tleSwgZmllbGRzXSBvZiB0aGlzLnNoYXJlZFJlZGFjdGVkRmllbGRzQnlLZXkpIHtcbiAgICAgIGZpZWxkUmVkYWN0aW9uc1trZXldID0gWy4uLmZpZWxkc107XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICByZWRhY3RlZEtleXM6IFsuLi50aGlzLnNoYXJlZFJlZGFjdGVkS2V5c10sXG4gICAgICBmaWVsZFJlZGFjdGlvbnMsXG4gICAgICBwYXR0ZXJuczogKHRoaXMucmVkYWN0aW9uUG9saWN5Py5wYXR0ZXJucyA/PyBbXSkubWFwKChwKSA9PiBwLnNvdXJjZSksXG4gICAgfTtcbiAgfVxuXG4gIC8vIOKUgOKUgOKUgCBQYXVzZS9SZXN1bWUg4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIFJldHVybnMgdGhlIGNoZWNrcG9pbnQgZnJvbSB0aGUgbW9zdCByZWNlbnQgcGF1c2VkIGV4ZWN1dGlvbiwgb3IgYHVuZGVmaW5lZGBcbiAgICogaWYgdGhlIGxhc3QgcnVuIGNvbXBsZXRlZCB3aXRob3V0IHBhdXNpbmcuXG4gICAqXG4gICAqIFRoZSBjaGVja3BvaW50IGlzIEpTT04tc2VyaWFsaXphYmxlIOKAlCBzdG9yZSBpdCBpbiBSZWRpcywgUG9zdGdyZXMsIGxvY2FsU3RvcmFnZSwgZXRjLlxuICAgKlxuICAgKiBAZXhhbXBsZVxuICAgKiBgYGB0eXBlc2NyaXB0XG4gICAqIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGV4ZWN1dG9yLnJ1bih7IGlucHV0IH0pO1xuICAgKiBpZiAoZXhlY3V0b3IuaXNQYXVzZWQoKSkge1xuICAgKiAgIGNvbnN0IGNoZWNrcG9pbnQgPSBleGVjdXRvci5nZXRDaGVja3BvaW50KCkhO1xuICAgKiAgIGF3YWl0IHJlZGlzLnNldChgc2Vzc2lvbjoke2lkfWAsIEpTT04uc3RyaW5naWZ5KGNoZWNrcG9pbnQpKTtcbiAgICogfVxuICAgKiBgYGBcbiAgICovXG4gIGdldENoZWNrcG9pbnQoKTogRmxvd2NoYXJ0Q2hlY2twb2ludCB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMubGFzdENoZWNrcG9pbnQ7XG4gIH1cblxuICAvKiogUmV0dXJucyBgdHJ1ZWAgaWYgdGhlIG1vc3QgcmVjZW50IHJ1bigpIHdhcyBwYXVzZWQgKGNoZWNrcG9pbnQgYXZhaWxhYmxlKS4gKi9cbiAgaXNQYXVzZWQoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMubGFzdENoZWNrcG9pbnQgIT09IHVuZGVmaW5lZDtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXN1bWUgYSBwYXVzZWQgZmxvd2NoYXJ0IGZyb20gYSBjaGVja3BvaW50LlxuICAgKlxuICAgKiBSZXN0b3JlcyB0aGUgc2NvcGUgc3RhdGUsIGNhbGxzIHRoZSBwYXVzZWQgc3RhZ2UncyBgcmVzdW1lRm5gIHdpdGggdGhlXG4gICAqIHByb3ZpZGVkIGlucHV0LCB0aGVuIGNvbnRpbnVlcyB0cmF2ZXJzYWwgZnJvbSB0aGUgbmV4dCBzdGFnZS5cbiAgICpcbiAgICogVGhlIGNoZWNrcG9pbnQgY2FuIGNvbWUgZnJvbSBgZ2V0Q2hlY2twb2ludCgpYCBvbiBhIHByZXZpb3VzIHJ1biwgb3IgZnJvbVxuICAgKiBhIHNlcmlhbGl6ZWQgY2hlY2twb2ludCBzdG9yZWQgaW4gUmVkaXMvUG9zdGdyZXMvbG9jYWxTdG9yYWdlLlxuICAgKlxuICAgKiAqKk5hcnJhdGl2ZS9yZWNvcmRlciBzdGF0ZSBpcyByZXNldCBvbiByZXN1bWUuKiogVG8ga2VlcCBhIHVuaWZpZWQgbmFycmF0aXZlXG4gICAqIGFjcm9zcyBwYXVzZS9yZXN1bWUgY3ljbGVzLCBjb2xsZWN0IGl0IGJlZm9yZSBjYWxsaW5nIHJlc3VtZS5cbiAgICpcbiAgICogQGV4YW1wbGVcbiAgICogYGBgdHlwZXNjcmlwdFxuICAgKiAvLyBBZnRlciBhIHBhdXNlLi4uXG4gICAqIGNvbnN0IGNoZWNrcG9pbnQgPSBleGVjdXRvci5nZXRDaGVja3BvaW50KCkhO1xuICAgKiBhd2FpdCByZWRpcy5zZXQoYHNlc3Npb246JHtpZH1gLCBKU09OLnN0cmluZ2lmeShjaGVja3BvaW50KSk7XG4gICAqXG4gICAqIC8vIExhdGVyIChwb3NzaWJseSBkaWZmZXJlbnQgc2VydmVyLCBzYW1lIGNoYXJ0KVxuICAgKiBjb25zdCBjaGVja3BvaW50ID0gSlNPTi5wYXJzZShhd2FpdCByZWRpcy5nZXQoYHNlc3Npb246JHtpZH1gKSk7XG4gICAqIGNvbnN0IGV4ZWN1dG9yID0gbmV3IEZsb3dDaGFydEV4ZWN1dG9yKGNoYXJ0KTtcbiAgICogY29uc3QgcmVzdWx0ID0gYXdhaXQgZXhlY3V0b3IucmVzdW1lKGNoZWNrcG9pbnQsIHsgYXBwcm92ZWQ6IHRydWUgfSk7XG4gICAqIGBgYFxuICAgKi9cbiAgYXN5bmMgcmVzdW1lKFxuICAgIGNoZWNrcG9pbnQ6IEZsb3djaGFydENoZWNrcG9pbnQsXG4gICAgcmVzdW1lSW5wdXQ/OiB1bmtub3duLFxuICAgIG9wdGlvbnM/OiBQaWNrPFJ1bk9wdGlvbnMsICdzaWduYWwnIHwgJ2VudicgfCAnbWF4RGVwdGgnPixcbiAgKTogUHJvbWlzZTxFeGVjdXRvclJlc3VsdD4ge1xuICAgIHRoaXMubGFzdENoZWNrcG9pbnQgPSB1bmRlZmluZWQ7XG5cbiAgICAvLyDilIDilIAgVmFsaWRhdGUgY2hlY2twb2ludCBzdHJ1Y3R1cmUgKG1heSBjb21lIGZyb20gdW50cnVzdGVkIGV4dGVybmFsIHN0b3JhZ2UpIOKUgOKUgFxuICAgIGlmIChcbiAgICAgICFjaGVja3BvaW50IHx8XG4gICAgICB0eXBlb2YgY2hlY2twb2ludCAhPT0gJ29iamVjdCcgfHxcbiAgICAgIHR5cGVvZiBjaGVja3BvaW50LnNoYXJlZFN0YXRlICE9PSAnb2JqZWN0JyB8fFxuICAgICAgY2hlY2twb2ludC5zaGFyZWRTdGF0ZSA9PT0gbnVsbCB8fFxuICAgICAgQXJyYXkuaXNBcnJheShjaGVja3BvaW50LnNoYXJlZFN0YXRlKVxuICAgICkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIGNoZWNrcG9pbnQ6IHNoYXJlZFN0YXRlIG11c3QgYmUgYSBwbGFpbiBvYmplY3QuJyk7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgY2hlY2twb2ludC5wYXVzZWRTdGFnZUlkICE9PSAnc3RyaW5nJyB8fCBjaGVja3BvaW50LnBhdXNlZFN0YWdlSWQgPT09ICcnKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgY2hlY2twb2ludDogcGF1c2VkU3RhZ2VJZCBtdXN0IGJlIGEgbm9uLWVtcHR5IHN0cmluZy4nKTtcbiAgICB9XG4gICAgaWYgKFxuICAgICAgIUFycmF5LmlzQXJyYXkoY2hlY2twb2ludC5zdWJmbG93UGF0aCkgfHxcbiAgICAgICFjaGVja3BvaW50LnN1YmZsb3dQYXRoLmV2ZXJ5KChzOiB1bmtub3duKSA9PiB0eXBlb2YgcyA9PT0gJ3N0cmluZycpXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgY2hlY2twb2ludDogc3ViZmxvd1BhdGggbXVzdCBiZSBhbiBhcnJheSBvZiBzdHJpbmdzLicpO1xuICAgIH1cblxuICAgIC8vIEZpbmQgdGhlIHBhdXNlZCBub2RlIGluIHRoZSBncmFwaFxuICAgIGNvbnN0IHBhdXNlZE5vZGUgPSB0aGlzLmZpbmROb2RlSW5HcmFwaChjaGVja3BvaW50LnBhdXNlZFN0YWdlSWQsIGNoZWNrcG9pbnQuc3ViZmxvd1BhdGgpO1xuICAgIGlmICghcGF1c2VkTm9kZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQ2Fubm90IHJlc3VtZTogc3RhZ2UgJyR7Y2hlY2twb2ludC5wYXVzZWRTdGFnZUlkfScgbm90IGZvdW5kIGluIGZsb3djaGFydC4gYCArXG4gICAgICAgICAgJ1RoZSBjaGFydCBtYXkgaGF2ZSBjaGFuZ2VkIHNpbmNlIHRoZSBjaGVja3BvaW50IHdhcyBjcmVhdGVkLicsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAoIXBhdXNlZE5vZGUucmVzdW1lRm4pIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYENhbm5vdCByZXN1bWU6IHN0YWdlICcke3BhdXNlZE5vZGUubmFtZX0nICgke3BhdXNlZE5vZGUuaWR9KSBoYXMgbm8gcmVzdW1lRm4uIGAgK1xuICAgICAgICAgICdPbmx5IHN0YWdlcyBjcmVhdGVkIHdpdGggYWRkUGF1c2FibGVGdW5jdGlvbigpIGNhbiBiZSByZXN1bWVkLicsXG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIEJ1aWxkIGEgc3ludGhldGljIHJlc3VtZSBub2RlOiBjYWxscyByZXN1bWVGbiB3aXRoIHJlc3VtZUlucHV0LCB0aGVuIGNvbnRpbnVlcyB0byBvcmlnaW5hbCBuZXh0LlxuICAgIC8vIHJlc3VtZUZuIHNpZ25hdHVyZSBpcyAoc2NvcGUsIGlucHV0KSBwZXIgUGF1c2FibGVIYW5kbGVyIOKAlCB3cmFwIHRvIG1hdGNoIFN0YWdlRnVuY3Rpb24oc2NvcGUsIGJyZWFrRm4pLlxuICAgIGNvbnN0IHJlc3VtZUZuID0gcGF1c2VkTm9kZS5yZXN1bWVGbjtcbiAgICBjb25zdCByZXN1bWVTdGFnZUZuID0gKHNjb3BlOiBUU2NvcGUpID0+IHtcbiAgICAgIHJldHVybiByZXN1bWVGbihzY29wZSwgcmVzdW1lSW5wdXQpO1xuICAgIH07XG5cbiAgICBjb25zdCByZXN1bWVOb2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiA9IHtcbiAgICAgIG5hbWU6IHBhdXNlZE5vZGUubmFtZSxcbiAgICAgIGlkOiBwYXVzZWROb2RlLmlkLFxuICAgICAgZGVzY3JpcHRpb246IHBhdXNlZE5vZGUuZGVzY3JpcHRpb24sXG4gICAgICBmbjogcmVzdW1lU3RhZ2VGbixcbiAgICAgIG5leHQ6IHBhdXNlZE5vZGUubmV4dCxcbiAgICB9O1xuXG4gICAgLy8gRG9uJ3QgY2xlYXIgcmVjb3JkZXJzIOKAlCByZXN1bWUgY29udGludWVzIGZyb20gcHJldmlvdXMgc3RhdGUuXG4gICAgLy8gTmFycmF0aXZlLCBtZXRyaWNzLCBkZWJ1ZyBlbnRyaWVzIGFjY3VtdWxhdGUgYWNyb3NzIHBhdXNlL3Jlc3VtZS5cblxuICAgIC8vIFJldXNlIHRoZSBleGlzdGluZyBydW50aW1lIHNvIHRoZSBleGVjdXRpb24gdHJlZSBjb250aW51ZXMgZnJvbSB0aGUgcGF1c2UgcG9pbnQuXG4gICAgLy8gcHJlc2VydmVSZWNvcmRlcnMga2VlcHMgdGhlIENvbWJpbmVkTmFycmF0aXZlUmVjb3JkZXIgc28gbmFycmF0aXZlIGFjY3VtdWxhdGVzLlxuICAgIGNvbnN0IGV4aXN0aW5nUnVudGltZSA9IHRoaXMudHJhdmVyc2VyLmdldFJ1bnRpbWUoKSBhcyBJbnN0YW5jZVR5cGU8dHlwZW9mIEV4ZWN1dGlvblJ1bnRpbWU+O1xuICAgIHRoaXMudHJhdmVyc2VyID0gdGhpcy5jcmVhdGVUcmF2ZXJzZXIob3B0aW9ucz8uc2lnbmFsLCB1bmRlZmluZWQsIG9wdGlvbnM/LmVudiwgb3B0aW9ucz8ubWF4RGVwdGgsIHtcbiAgICAgIHJvb3Q6IHJlc3VtZU5vZGUsXG4gICAgICBpbml0aWFsQ29udGV4dDogY2hlY2twb2ludC5zaGFyZWRTdGF0ZSxcbiAgICAgIHByZXNlcnZlUmVjb3JkZXJzOiB0cnVlLFxuICAgICAgZXhpc3RpbmdSdW50aW1lLFxuICAgIH0pO1xuXG4gICAgLy8gRmlyZSBvblJlc3VtZSBldmVudCBvbiBhbGwgcmVjb3JkZXJzIChmbG93ICsgc2NvcGUpXG4gICAgY29uc3QgaGFzSW5wdXQgPSByZXN1bWVJbnB1dCAhPT0gdW5kZWZpbmVkO1xuICAgIGNvbnN0IGZsb3dSZXN1bWVFdmVudCA9IHtcbiAgICAgIHN0YWdlTmFtZTogcGF1c2VkTm9kZS5uYW1lLFxuICAgICAgc3RhZ2VJZDogcGF1c2VkTm9kZS5pZCxcbiAgICAgIGhhc0lucHV0LFxuICAgIH07XG4gICAgaWYgKHRoaXMuY29tYmluZWRSZWNvcmRlcikgdGhpcy5jb21iaW5lZFJlY29yZGVyLm9uUmVzdW1lKGZsb3dSZXN1bWVFdmVudCk7XG4gICAgZm9yIChjb25zdCByIG9mIHRoaXMuZmxvd1JlY29yZGVycykgci5vblJlc3VtZT8uKGZsb3dSZXN1bWVFdmVudCk7XG5cbiAgICBjb25zdCBzY29wZVJlc3VtZUV2ZW50ID0ge1xuICAgICAgc3RhZ2VOYW1lOiBwYXVzZWROb2RlLm5hbWUsXG4gICAgICBzdGFnZUlkOiBwYXVzZWROb2RlLmlkLFxuICAgICAgaGFzSW5wdXQsXG4gICAgICBwaXBlbGluZUlkOiAnJyxcbiAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICB9O1xuICAgIGZvciAoY29uc3QgciBvZiB0aGlzLnNjb3BlUmVjb3JkZXJzKSByLm9uUmVzdW1lPy4oc2NvcGVSZXN1bWVFdmVudCk7XG5cbiAgICB0cnkge1xuICAgICAgcmV0dXJuIGF3YWl0IHRoaXMudHJhdmVyc2VyLmV4ZWN1dGUoKTtcbiAgICB9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuICAgICAgaWYgKGlzUGF1c2VTaWduYWwoZXJyb3IpKSB7XG4gICAgICAgIGNvbnN0IHNuYXBzaG90ID0gdGhpcy50cmF2ZXJzZXIuZ2V0U25hcHNob3QoKTtcbiAgICAgICAgY29uc3Qgc2ZSZXN1bHRzID0gdGhpcy50cmF2ZXJzZXIuZ2V0U3ViZmxvd1Jlc3VsdHMoKTtcbiAgICAgICAgdGhpcy5sYXN0Q2hlY2twb2ludCA9IHtcbiAgICAgICAgICBzaGFyZWRTdGF0ZTogc25hcHNob3Quc2hhcmVkU3RhdGUsXG4gICAgICAgICAgZXhlY3V0aW9uVHJlZTogc25hcHNob3QuZXhlY3V0aW9uVHJlZSxcbiAgICAgICAgICBwYXVzZWRTdGFnZUlkOiBlcnJvci5zdGFnZUlkLFxuICAgICAgICAgIHN1YmZsb3dQYXRoOiBlcnJvci5zdWJmbG93UGF0aCxcbiAgICAgICAgICBwYXVzZURhdGE6IGVycm9yLnBhdXNlRGF0YSxcbiAgICAgICAgICAuLi4oc2ZSZXN1bHRzLnNpemUgPiAwICYmIHsgc3ViZmxvd1Jlc3VsdHM6IE9iamVjdC5mcm9tRW50cmllcyhzZlJlc3VsdHMpIH0pLFxuICAgICAgICAgIHBhdXNlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgICB9O1xuICAgICAgICByZXR1cm4geyBwYXVzZWQ6IHRydWUsIGNoZWNrcG9pbnQ6IHRoaXMubGFzdENoZWNrcG9pbnQgfSBzYXRpc2ZpZXMgUGF1c2VkUmVzdWx0O1xuICAgICAgfVxuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEZpbmQgYSBTdGFnZU5vZGUgaW4gdGhlIGNvbXBpbGVkIGdyYXBoIGJ5IElELlxuICAgKiBIYW5kbGVzIHN1YmZsb3cgcGF0aHMgYnkgZHJpbGxpbmcgaW50byByZWdpc3RlcmVkIHN1YmZsb3dzLlxuICAgKi9cbiAgcHJpdmF0ZSBmaW5kTm9kZUluR3JhcGgoc3RhZ2VJZDogc3RyaW5nLCBzdWJmbG93UGF0aDogcmVhZG9ubHkgc3RyaW5nW10pOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiB8IHVuZGVmaW5lZCB7XG4gICAgY29uc3QgZmMgPSB0aGlzLmZsb3dDaGFydEFyZ3MuZmxvd0NoYXJ0O1xuXG4gICAgaWYgKHN1YmZsb3dQYXRoLmxlbmd0aCA9PT0gMCkge1xuICAgICAgLy8gVG9wLWxldmVsOiBERlMgZnJvbSByb290XG4gICAgICByZXR1cm4gdGhpcy5kZnNGaW5kKGZjLnJvb3QsIHN0YWdlSWQpO1xuICAgIH1cblxuICAgIC8vIFN1YmZsb3c6IGRyaWxsIGludG8gdGhlIHN1YmZsb3cgY2hhaW4sIHRoZW4gc2VhcmNoIGZyb20gdGhlIGxhc3Qgc3ViZmxvdydzIHJvb3RcbiAgICBsZXQgc3ViZmxvd1Jvb3Q6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+IHwgdW5kZWZpbmVkO1xuICAgIGZvciAoY29uc3Qgc2ZJZCBvZiBzdWJmbG93UGF0aCkge1xuICAgICAgY29uc3Qgc3ViZmxvdyA9IGZjLnN1YmZsb3dzPy5bc2ZJZF07XG4gICAgICBpZiAoIXN1YmZsb3cpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICBzdWJmbG93Um9vdCA9IHN1YmZsb3cucm9vdDtcbiAgICB9XG4gICAgaWYgKCFzdWJmbG93Um9vdCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICByZXR1cm4gdGhpcy5kZnNGaW5kKHN1YmZsb3dSb290LCBzdGFnZUlkKTtcbiAgfVxuXG4gIC8qKiBERlMgc2VhcmNoIGZvciBhIG5vZGUgYnkgSUQgaW4gdGhlIFN0YWdlTm9kZSBncmFwaC4gQ3ljbGUtc2FmZSB2aWEgdmlzaXRlZCBzZXQuICovXG4gIHByaXZhdGUgZGZzRmluZChcbiAgICBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPixcbiAgICB0YXJnZXRJZDogc3RyaW5nLFxuICAgIHZpc2l0ZWQgPSBuZXcgU2V0PHN0cmluZz4oKSxcbiAgKTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gfCB1bmRlZmluZWQge1xuICAgIC8vIFNraXAgbG9vcCBiYWNrLWVkZ2UgcmVmZXJlbmNlcyAodGhleSBzaGFyZSB0aGUgdGFyZ2V0J3MgSUQgYnV0IGhhdmUgbm8gZm4vcmVzdW1lRm4pXG4gICAgaWYgKG5vZGUuaXNMb29wUmVmKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIGlmICh2aXNpdGVkLmhhcyhub2RlLmlkKSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB2aXNpdGVkLmFkZChub2RlLmlkKTtcbiAgICBpZiAobm9kZS5pZCA9PT0gdGFyZ2V0SWQpIHJldHVybiBub2RlO1xuICAgIGlmIChub2RlLmNoaWxkcmVuKSB7XG4gICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIG5vZGUuY2hpbGRyZW4pIHtcbiAgICAgICAgY29uc3QgZm91bmQgPSB0aGlzLmRmc0ZpbmQoY2hpbGQsIHRhcmdldElkLCB2aXNpdGVkKTtcbiAgICAgICAgaWYgKGZvdW5kKSByZXR1cm4gZm91bmQ7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChub2RlLm5leHQpIHJldHVybiB0aGlzLmRmc0ZpbmQobm9kZS5uZXh0LCB0YXJnZXRJZCwgdmlzaXRlZCk7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuXG4gIC8vIOKUgOKUgOKUgCBSZWNvcmRlciBNYW5hZ2VtZW50IOKUgOKUgOKUgFxuXG4gIC8qKlxuICAgKiBBdHRhY2ggYSBzY29wZSBSZWNvcmRlciB0byBvYnNlcnZlIGRhdGEgb3BlcmF0aW9ucyAocmVhZHMsIHdyaXRlcywgY29tbWl0cykuXG4gICAqIEF1dG9tYXRpY2FsbHkgYXR0YWNoZWQgdG8gZXZlcnkgU2NvcGVGYWNhZGUgY3JlYXRlZCBkdXJpbmcgdHJhdmVyc2FsLlxuICAgKiBNdXN0IGJlIGNhbGxlZCBiZWZvcmUgcnVuKCkuXG4gICAqXG4gICAqICoqSWRlbXBvdGVudCBieSBJRDoqKiBJZiBhIHJlY29yZGVyIHdpdGggdGhlIHNhbWUgYGlkYCBpcyBhbHJlYWR5IGF0dGFjaGVkLFxuICAgKiBpdCBpcyByZXBsYWNlZCAobm90IGR1cGxpY2F0ZWQpLiBUaGlzIHByZXZlbnRzIGRvdWJsZS1jb3VudGluZyB3aGVuIGJvdGhcbiAgICogYSBmcmFtZXdvcmsgYW5kIHRoZSB1c2VyIGF0dGFjaCB0aGUgc2FtZSByZWNvcmRlciB0eXBlLlxuICAgKlxuICAgKiBCdWlsdC1pbiByZWNvcmRlcnMgdXNlIGF1dG8taW5jcmVtZW50IElEcyAoYG1ldHJpY3MtMWAsIGBkZWJ1Zy0xYCwgLi4uKSBieVxuICAgKiBkZWZhdWx0LCBzbyBtdWx0aXBsZSBpbnN0YW5jZXMgd2l0aCBkaWZmZXJlbnQgY29uZmlncyBjb2V4aXN0LiBUbyBvdmVycmlkZVxuICAgKiBhIGZyYW1ld29yay1hdHRhY2hlZCByZWNvcmRlciwgcGFzcyB0aGUgc2FtZSB3ZWxsLWtub3duIElELlxuICAgKlxuICAgKiBAZXhhbXBsZVxuICAgKiBgYGB0eXBlc2NyaXB0XG4gICAqIC8vIE11bHRpcGxlIHJlY29yZGVycyB3aXRoIGRpZmZlcmVudCBjb25maWdzIOKAlCBlYWNoIGdldHMgYSB1bmlxdWUgSURcbiAgICogZXhlY3V0b3IuYXR0YWNoUmVjb3JkZXIobmV3IE1ldHJpY1JlY29yZGVyKCkpO1xuICAgKiBleGVjdXRvci5hdHRhY2hSZWNvcmRlcihuZXcgRGVidWdSZWNvcmRlcih7IHZlcmJvc2l0eTogJ21pbmltYWwnIH0pKTtcbiAgICpcbiAgICogLy8gT3ZlcnJpZGUgYSBmcmFtZXdvcmstYXR0YWNoZWQgcmVjb3JkZXIgYnkgcGFzc2luZyBpdHMgd2VsbC1rbm93biBJRFxuICAgKiBleGVjdXRvci5hdHRhY2hSZWNvcmRlcihuZXcgTWV0cmljUmVjb3JkZXIoJ21ldHJpY3MnKSk7XG4gICAqXG4gICAqIC8vIEF0dGFjaGluZyB0d2ljZSB3aXRoIHNhbWUgSUQgcmVwbGFjZXMgKG5vIGRvdWJsZS1jb3VudGluZylcbiAgICogZXhlY3V0b3IuYXR0YWNoUmVjb3JkZXIobmV3IE1ldHJpY1JlY29yZGVyKCdteS1tZXRyaWNzJykpO1xuICAgKiBleGVjdXRvci5hdHRhY2hSZWNvcmRlcihuZXcgTWV0cmljUmVjb3JkZXIoJ215LW1ldHJpY3MnKSk7IC8vIHJlcGxhY2VzIHByZXZpb3VzXG4gICAqIGBgYFxuICAgKi9cbiAgYXR0YWNoUmVjb3JkZXIocmVjb3JkZXI6IFJlY29yZGVyKTogdm9pZCB7XG4gICAgLy8gUmVwbGFjZSBleGlzdGluZyByZWNvcmRlciB3aXRoIHNhbWUgSUQgKGlkZW1wb3RlbnQg4oCUIHByZXZlbnRzIGRvdWJsZS1jb3VudGluZylcbiAgICB0aGlzLnNjb3BlUmVjb3JkZXJzID0gdGhpcy5zY29wZVJlY29yZGVycy5maWx0ZXIoKHIpID0+IHIuaWQgIT09IHJlY29yZGVyLmlkKTtcbiAgICB0aGlzLnNjb3BlUmVjb3JkZXJzLnB1c2gocmVjb3JkZXIpO1xuICB9XG5cbiAgLyoqIERldGFjaCBhbGwgc2NvcGUgUmVjb3JkZXJzIHdpdGggdGhlIGdpdmVuIElELiAqL1xuICBkZXRhY2hSZWNvcmRlcihpZDogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5zY29wZVJlY29yZGVycyA9IHRoaXMuc2NvcGVSZWNvcmRlcnMuZmlsdGVyKChyKSA9PiByLmlkICE9PSBpZCk7XG4gIH1cblxuICAvKiogUmV0dXJucyBhIGRlZmVuc2l2ZSBjb3B5IG9mIGF0dGFjaGVkIHNjb3BlIFJlY29yZGVycy4gKi9cbiAgZ2V0UmVjb3JkZXJzKCk6IFJlY29yZGVyW10ge1xuICAgIHJldHVybiBbLi4udGhpcy5zY29wZVJlY29yZGVyc107XG4gIH1cblxuICAvLyDilIDilIDilIAgRmxvd1JlY29yZGVyIE1hbmFnZW1lbnQg4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIEF0dGFjaCBhIEZsb3dSZWNvcmRlciB0byBvYnNlcnZlIGNvbnRyb2wgZmxvdyBldmVudHMuXG4gICAqIEF1dG9tYXRpY2FsbHkgZW5hYmxlcyBuYXJyYXRpdmUgaWYgbm90IGFscmVhZHkgZW5hYmxlZC5cbiAgICogTXVzdCBiZSBjYWxsZWQgYmVmb3JlIHJ1bigpIOKAlCByZWNvcmRlcnMgYXJlIHBhc3NlZCB0byB0aGUgdHJhdmVyc2VyIGF0IGNyZWF0aW9uIHRpbWUuXG4gICAqXG4gICAqICoqSWRlbXBvdGVudCBieSBJRDoqKiByZXBsYWNlcyBleGlzdGluZyByZWNvcmRlciB3aXRoIHNhbWUgYGlkYC5cbiAgICovXG4gIGF0dGFjaEZsb3dSZWNvcmRlcihyZWNvcmRlcjogRmxvd1JlY29yZGVyKTogdm9pZCB7XG4gICAgLy8gUmVwbGFjZSBleGlzdGluZyByZWNvcmRlciB3aXRoIHNhbWUgSUQgKGlkZW1wb3RlbnQg4oCUIHByZXZlbnRzIGRvdWJsZS1jb3VudGluZylcbiAgICB0aGlzLmZsb3dSZWNvcmRlcnMgPSB0aGlzLmZsb3dSZWNvcmRlcnMuZmlsdGVyKChyKSA9PiByLmlkICE9PSByZWNvcmRlci5pZCk7XG4gICAgdGhpcy5mbG93UmVjb3JkZXJzLnB1c2gocmVjb3JkZXIpO1xuICAgIHRoaXMubmFycmF0aXZlRW5hYmxlZCA9IHRydWU7XG4gIH1cblxuICAvKiogRGV0YWNoIGFsbCBGbG93UmVjb3JkZXJzIHdpdGggdGhlIGdpdmVuIElELiAqL1xuICBkZXRhY2hGbG93UmVjb3JkZXIoaWQ6IHN0cmluZyk6IHZvaWQge1xuICAgIHRoaXMuZmxvd1JlY29yZGVycyA9IHRoaXMuZmxvd1JlY29yZGVycy5maWx0ZXIoKHIpID0+IHIuaWQgIT09IGlkKTtcbiAgfVxuXG4gIC8qKiBSZXR1cm5zIGEgZGVmZW5zaXZlIGNvcHkgb2YgYXR0YWNoZWQgRmxvd1JlY29yZGVycy4gKi9cbiAgZ2V0Rmxvd1JlY29yZGVycygpOiBGbG93UmVjb3JkZXJbXSB7XG4gICAgcmV0dXJuIFsuLi50aGlzLmZsb3dSZWNvcmRlcnNdO1xuICB9XG5cbiAgLyoqXG4gICAqIFJldHVybnMgdGhlIGV4ZWN1dGlvbiBuYXJyYXRpdmUuXG4gICAqXG4gICAqIFdoZW4gdXNpbmcgU2NvcGVGYWNhZGUtYmFzZWQgc2NvcGVzLCByZXR1cm5zIGEgY29tYmluZWQgbmFycmF0aXZlIHRoYXRcbiAgICogaW50ZXJsZWF2ZXMgZmxvdyBldmVudHMgKHN0YWdlcywgZGVjaXNpb25zLCBmb3Jrcykgd2l0aCBkYXRhIG9wZXJhdGlvbnNcbiAgICogKHJlYWRzLCB3cml0ZXMsIHVwZGF0ZXMpLiBGb3IgcGxhaW4gc2NvcGVzIHdpdGhvdXQgYXR0YWNoUmVjb3JkZXIgc3VwcG9ydCxcbiAgICogcmV0dXJucyBmbG93LW9ubHkgbmFycmF0aXZlIHNlbnRlbmNlcy5cbiAgICovXG4gIGdldE5hcnJhdGl2ZSgpOiBzdHJpbmdbXSB7XG4gICAgLy8gQ29tYmluZWQgcmVjb3JkZXIgYnVpbGRzIHRoZSBuYXJyYXRpdmUgaW5saW5lIGR1cmluZyB0cmF2ZXJzYWwg4oCUIGp1c3QgcmVhZCBpdFxuICAgIGlmICh0aGlzLmNvbWJpbmVkUmVjb3JkZXIpIHtcbiAgICAgIHJldHVybiB0aGlzLmNvbWJpbmVkUmVjb3JkZXIuZ2V0TmFycmF0aXZlKCk7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLnRyYXZlcnNlci5nZXROYXJyYXRpdmUoKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXR1cm5zIHN0cnVjdHVyZWQgbmFycmF0aXZlIGVudHJpZXMgZm9yIHByb2dyYW1tYXRpYyBjb25zdW1wdGlvbi5cbiAgICogRWFjaCBlbnRyeSBoYXMgYSB0eXBlIChzdGFnZSwgc3RlcCwgY29uZGl0aW9uLCBmb3JrLCBldGMuKSwgdGV4dCwgYW5kIGRlcHRoLlxuICAgKi9cbiAgZ2V0TmFycmF0aXZlRW50cmllcygpOiBDb21iaW5lZE5hcnJhdGl2ZUVudHJ5W10ge1xuICAgIGlmICh0aGlzLmNvbWJpbmVkUmVjb3JkZXIpIHtcbiAgICAgIHJldHVybiB0aGlzLmNvbWJpbmVkUmVjb3JkZXIuZ2V0RW50cmllcygpO1xuICAgIH1cbiAgICBjb25zdCBmbG93U2VudGVuY2VzID0gdGhpcy50cmF2ZXJzZXIuZ2V0TmFycmF0aXZlKCk7XG4gICAgcmV0dXJuIGZsb3dTZW50ZW5jZXMubWFwKCh0ZXh0KSA9PiAoeyB0eXBlOiAnc3RhZ2UnIGFzIGNvbnN0LCB0ZXh0LCBkZXB0aDogMCB9KSk7XG4gIH1cblxuICAvKipcbiAgICogUmV0dXJucyB0aGUgY29tYmluZWQgRmxvd1JlY29yZGVycyBsaXN0LiBXaGVuIG5hcnJhdGl2ZSBpcyBlbmFibGVkLCBpbmNsdWRlczpcbiAgICogLSBDb21iaW5lZE5hcnJhdGl2ZVJlY29yZGVyIChidWlsZHMgbWVyZ2VkIGZsb3crZGF0YSBuYXJyYXRpdmUgaW5saW5lKVxuICAgKiAtIE5hcnJhdGl2ZUZsb3dSZWNvcmRlciAoa2VlcHMgZmxvdy1vbmx5IHNlbnRlbmNlcyBmb3IgZ2V0Rmxvd05hcnJhdGl2ZSgpKVxuICAgKiBQbHVzIGFueSB1c2VyLWF0dGFjaGVkIHJlY29yZGVycy5cbiAgICovXG4gIHByaXZhdGUgYnVpbGRGbG93UmVjb3JkZXJzTGlzdCgpOiBGbG93UmVjb3JkZXJbXSB8IHVuZGVmaW5lZCB7XG4gICAgY29uc3QgcmVjb3JkZXJzOiBGbG93UmVjb3JkZXJbXSA9IFtdO1xuICAgIGlmICh0aGlzLmNvbWJpbmVkUmVjb3JkZXIpIHtcbiAgICAgIHJlY29yZGVycy5wdXNoKHRoaXMuY29tYmluZWRSZWNvcmRlcik7XG4gICAgICAvLyBLZWVwIHRoZSBkZWZhdWx0IE5hcnJhdGl2ZUZsb3dSZWNvcmRlciBzbyBnZXRGbG93TmFycmF0aXZlKCkgc3RpbGwgd29ya3NcbiAgICAgIHJlY29yZGVycy5wdXNoKG5ldyBOYXJyYXRpdmVGbG93UmVjb3JkZXIoKSk7XG4gICAgfVxuICAgIHJlY29yZGVycy5wdXNoKC4uLnRoaXMuZmxvd1JlY29yZGVycyk7XG4gICAgcmV0dXJuIHJlY29yZGVycy5sZW5ndGggPiAwID8gcmVjb3JkZXJzIDogdW5kZWZpbmVkO1xuICB9XG5cbiAgLyoqXG4gICAqIFJldHVybnMgZmxvdy1vbmx5IG5hcnJhdGl2ZSBzZW50ZW5jZXMgKHdpdGhvdXQgZGF0YSBvcGVyYXRpb25zKS5cbiAgICogVXNlIHRoaXMgd2hlbiB5b3Ugb25seSB3YW50IGNvbnRyb2wgZmxvdyBkZXNjcmlwdGlvbnMuXG4gICAqXG4gICAqIFNlbnRlbmNlcyBjb21lIGZyb20gYE5hcnJhdGl2ZUZsb3dSZWNvcmRlcmAgKGEgZGVkaWNhdGVkIGZsb3ctb25seSByZWNvcmRlciBhdXRvbWF0aWNhbGx5XG4gICAqIGF0dGFjaGVkIHdoZW4gbmFycmF0aXZlIGlzIGVuYWJsZWQpLiBJdCBlbWl0cyBib3RoIGBvblN0YWdlRXhlY3V0ZWRgIHNlbnRlbmNlcyAob25lIHBlclxuICAgKiBzdGFnZSkgQU5EIGBvbk5leHRgIHRyYW5zaXRpb24gc2VudGVuY2VzIChvbmUgcGVyIHN0YWdlLXRvLXN0YWdlIHRyYW5zaXRpb24pLCBzbyBmb3IgYVxuICAgKiBjaGFydCB3aXRoIE4gc3RhZ2VzIHlvdSB3aWxsIHR5cGljYWxseSBnZXQgbW9yZSBlbnRyaWVzIGhlcmUgdGhhbiBmcm9tIGBnZXROYXJyYXRpdmUoKWAuXG4gICAqL1xuICBnZXRGbG93TmFycmF0aXZlKCk6IHN0cmluZ1tdIHtcbiAgICByZXR1cm4gdGhpcy50cmF2ZXJzZXIuZ2V0TmFycmF0aXZlKCk7XG4gIH1cblxuICBhc3luYyBydW4ob3B0aW9ucz86IFJ1bk9wdGlvbnMpOiBQcm9taXNlPEV4ZWN1dG9yUmVzdWx0PiB7XG4gICAgbGV0IHNpZ25hbCA9IG9wdGlvbnM/LnNpZ25hbDtcbiAgICBsZXQgdGltZW91dElkOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IHVuZGVmaW5lZDtcblxuICAgIC8vIENyZWF0ZSBhbiBpbnRlcm5hbCBBYm9ydENvbnRyb2xsZXIgZm9yIHRpbWVvdXRNc1xuICAgIGlmIChvcHRpb25zPy50aW1lb3V0TXMgJiYgIXNpZ25hbCkge1xuICAgICAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICAgIHNpZ25hbCA9IGNvbnRyb2xsZXIuc2lnbmFsO1xuICAgICAgdGltZW91dElkID0gc2V0VGltZW91dChcbiAgICAgICAgKCkgPT4gY29udHJvbGxlci5hYm9ydChuZXcgRXJyb3IoYEV4ZWN1dGlvbiB0aW1lZCBvdXQgYWZ0ZXIgJHtvcHRpb25zLnRpbWVvdXRNc31tc2ApKSxcbiAgICAgICAgb3B0aW9ucy50aW1lb3V0TXMsXG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIFZhbGlkYXRlIGlucHV0IGFnYWluc3QgaW5wdXRTY2hlbWEgaWYgYm90aCBhcmUgcHJlc2VudFxuICAgIGxldCB2YWxpZGF0ZWRJbnB1dCA9IG9wdGlvbnM/LmlucHV0O1xuICAgIGlmICh2YWxpZGF0ZWRJbnB1dCAmJiB0aGlzLmZsb3dDaGFydEFyZ3MuZmxvd0NoYXJ0LmlucHV0U2NoZW1hKSB7XG4gICAgICB2YWxpZGF0ZWRJbnB1dCA9IHZhbGlkYXRlSW5wdXQodGhpcy5mbG93Q2hhcnRBcmdzLmZsb3dDaGFydC5pbnB1dFNjaGVtYSwgdmFsaWRhdGVkSW5wdXQpO1xuICAgIH1cblxuICAgIC8vIFVzZXItYXR0YWNoZWQgcmVjb3JkZXJzIChmbG93UmVjb3JkZXJzICsgc2NvcGVSZWNvcmRlcnMpIGFyZSBjbGVhcmVkIHZpYSBjbGVhcigpIHRvIHByZXZlbnRcbiAgICAvLyBjcm9zcy1ydW4gYWNjdW11bGF0aW9uLiBUaGUgY29tYmluZWRSZWNvcmRlciBpcyBOT1QgY2xlYXJlZCBoZXJlIOKAlCBjcmVhdGVUcmF2ZXJzZXIoKSBhbHdheXNcbiAgICAvLyBjcmVhdGVzIGEgZnJlc2ggQ29tYmluZWROYXJyYXRpdmVSZWNvcmRlciBpbnN0YW5jZSBvbiBlYWNoIHJ1biwgc28gc3RhbGUgc3RhdGUgaXMgbmV2ZXIgYW4gaXNzdWUuXG4gICAgZm9yIChjb25zdCByIG9mIHRoaXMuZmxvd1JlY29yZGVycykge1xuICAgICAgci5jbGVhcj8uKCk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgciBvZiB0aGlzLnNjb3BlUmVjb3JkZXJzKSB7XG4gICAgICByLmNsZWFyPy4oKTtcbiAgICB9XG5cbiAgICB0aGlzLmxhc3RDaGVja3BvaW50ID0gdW5kZWZpbmVkO1xuICAgIHRoaXMudHJhdmVyc2VyID0gdGhpcy5jcmVhdGVUcmF2ZXJzZXIoc2lnbmFsLCB2YWxpZGF0ZWRJbnB1dCwgb3B0aW9ucz8uZW52LCBvcHRpb25zPy5tYXhEZXB0aCk7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiBhd2FpdCB0aGlzLnRyYXZlcnNlci5leGVjdXRlKCk7XG4gICAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICAgIGlmIChpc1BhdXNlU2lnbmFsKGVycm9yKSkge1xuICAgICAgICAvLyBCdWlsZCBjaGVja3BvaW50IGZyb20gY3VycmVudCBleGVjdXRpb24gc3RhdGVcbiAgICAgICAgY29uc3Qgc25hcHNob3QgPSB0aGlzLnRyYXZlcnNlci5nZXRTbmFwc2hvdCgpO1xuICAgICAgICBjb25zdCBzZlJlc3VsdHMgPSB0aGlzLnRyYXZlcnNlci5nZXRTdWJmbG93UmVzdWx0cygpO1xuICAgICAgICB0aGlzLmxhc3RDaGVja3BvaW50ID0ge1xuICAgICAgICAgIHNoYXJlZFN0YXRlOiBzbmFwc2hvdC5zaGFyZWRTdGF0ZSxcbiAgICAgICAgICBleGVjdXRpb25UcmVlOiBzbmFwc2hvdC5leGVjdXRpb25UcmVlLFxuICAgICAgICAgIHBhdXNlZFN0YWdlSWQ6IGVycm9yLnN0YWdlSWQsXG4gICAgICAgICAgc3ViZmxvd1BhdGg6IGVycm9yLnN1YmZsb3dQYXRoLFxuICAgICAgICAgIHBhdXNlRGF0YTogZXJyb3IucGF1c2VEYXRhLFxuICAgICAgICAgIC4uLihzZlJlc3VsdHMuc2l6ZSA+IDAgJiYgeyBzdWJmbG93UmVzdWx0czogT2JqZWN0LmZyb21FbnRyaWVzKHNmUmVzdWx0cykgfSksXG4gICAgICAgICAgcGF1c2VkQXQ6IERhdGUubm93KCksXG4gICAgICAgIH07XG4gICAgICAgIC8vIFJldHVybiBhIFBhdXNlUmVzdWx0LXNoYXBlZCB2YWx1ZSBzbyBjYWxsZXJzIGNhbiBjaGVjayB3aXRob3V0IHRyeS9jYXRjaFxuICAgICAgICByZXR1cm4geyBwYXVzZWQ6IHRydWUsIGNoZWNrcG9pbnQ6IHRoaXMubGFzdENoZWNrcG9pbnQgfSBzYXRpc2ZpZXMgUGF1c2VkUmVzdWx0O1xuICAgICAgfVxuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGlmICh0aW1lb3V0SWQgIT09IHVuZGVmaW5lZCkgY2xlYXJUaW1lb3V0KHRpbWVvdXRJZCk7XG4gICAgfVxuICB9XG5cbiAgLy8g4pSA4pSA4pSAIEludHJvc3BlY3Rpb24g4pSA4pSA4pSAXG5cbiAgZ2V0U25hcHNob3QoKTogUnVudGltZVNuYXBzaG90IHtcbiAgICBjb25zdCBzbmFwc2hvdCA9IHRoaXMudHJhdmVyc2VyLmdldFNuYXBzaG90KCkgYXMgUnVudGltZVNuYXBzaG90O1xuICAgIGNvbnN0IHNmUmVzdWx0cyA9IHRoaXMudHJhdmVyc2VyLmdldFN1YmZsb3dSZXN1bHRzKCk7XG4gICAgaWYgKHNmUmVzdWx0cy5zaXplID4gMCkge1xuICAgICAgc25hcHNob3Quc3ViZmxvd1Jlc3VsdHMgPSBPYmplY3QuZnJvbUVudHJpZXMoc2ZSZXN1bHRzKTtcbiAgICB9XG5cbiAgICAvLyBDb2xsZWN0IHNuYXBzaG90IGRhdGEgZnJvbSByZWNvcmRlcnMgdGhhdCBpbXBsZW1lbnQgdG9TbmFwc2hvdCgpXG4gICAgY29uc3QgcmVjb3JkZXJTbmFwc2hvdHM6IFJlY29yZGVyU25hcHNob3RbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgciBvZiB0aGlzLnNjb3BlUmVjb3JkZXJzKSB7XG4gICAgICBpZiAoci50b1NuYXBzaG90KSB7XG4gICAgICAgIGNvbnN0IHsgbmFtZSwgZGF0YSB9ID0gci50b1NuYXBzaG90KCk7XG4gICAgICAgIHJlY29yZGVyU25hcHNob3RzLnB1c2goeyBpZDogci5pZCwgbmFtZSwgZGF0YSB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgZm9yIChjb25zdCByIG9mIHRoaXMuZmxvd1JlY29yZGVycykge1xuICAgICAgaWYgKHIudG9TbmFwc2hvdCkge1xuICAgICAgICBjb25zdCB7IG5hbWUsIGRhdGEgfSA9IHIudG9TbmFwc2hvdCgpO1xuICAgICAgICByZWNvcmRlclNuYXBzaG90cy5wdXNoKHsgaWQ6IHIuaWQsIG5hbWUsIGRhdGEgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChyZWNvcmRlclNuYXBzaG90cy5sZW5ndGggPiAwKSB7XG4gICAgICBzbmFwc2hvdC5yZWNvcmRlcnMgPSByZWNvcmRlclNuYXBzaG90cztcbiAgICB9XG5cbiAgICByZXR1cm4gc25hcHNob3Q7XG4gIH1cblxuICAvKiogQGludGVybmFsICovXG4gIGdldFJ1bnRpbWUoKSB7XG4gICAgcmV0dXJuIHRoaXMudHJhdmVyc2VyLmdldFJ1bnRpbWUoKTtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgc2V0Um9vdE9iamVjdChwYXRoOiBzdHJpbmdbXSwga2V5OiBzdHJpbmcsIHZhbHVlOiB1bmtub3duKTogdm9pZCB7XG4gICAgdGhpcy50cmF2ZXJzZXIuc2V0Um9vdE9iamVjdChwYXRoLCBrZXksIHZhbHVlKTtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgZ2V0QnJhbmNoSWRzKCkge1xuICAgIHJldHVybiB0aGlzLnRyYXZlcnNlci5nZXRCcmFuY2hJZHMoKTtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgZ2V0UnVudGltZVJvb3QoKTogU3RhZ2VOb2RlIHtcbiAgICByZXR1cm4gdGhpcy50cmF2ZXJzZXIuZ2V0UnVudGltZVJvb3QoKTtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgZ2V0UnVudGltZVN0cnVjdHVyZSgpOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUgfCB1bmRlZmluZWQge1xuICAgIHJldHVybiB0aGlzLnRyYXZlcnNlci5nZXRSdW50aW1lU3RydWN0dXJlKCk7XG4gIH1cblxuICAvKiogQGludGVybmFsICovXG4gIGdldFN1YmZsb3dSZXN1bHRzKCk6IE1hcDxzdHJpbmcsIFN1YmZsb3dSZXN1bHQ+IHtcbiAgICByZXR1cm4gdGhpcy50cmF2ZXJzZXIuZ2V0U3ViZmxvd1Jlc3VsdHMoKTtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgZ2V0RXh0cmFjdGVkUmVzdWx0czxUUmVzdWx0ID0gdW5rbm93bj4oKTogTWFwPHN0cmluZywgVFJlc3VsdD4ge1xuICAgIHJldHVybiB0aGlzLnRyYXZlcnNlci5nZXRFeHRyYWN0ZWRSZXN1bHRzPFRSZXN1bHQ+KCk7XG4gIH1cblxuICAvKiogQGludGVybmFsICovXG4gIGdldEV4dHJhY3RvckVycm9ycygpOiBFeHRyYWN0b3JFcnJvcltdIHtcbiAgICByZXR1cm4gdGhpcy50cmF2ZXJzZXIuZ2V0RXh0cmFjdG9yRXJyb3JzKCk7XG4gIH1cblxuICAvKipcbiAgICogUmV0dXJucyB0aGUgc3ViZmxvdyBtYW5pZmVzdCBmcm9tIGFuIGF0dGFjaGVkIE1hbmlmZXN0Rmxvd1JlY29yZGVyLlxuICAgKiBSZXR1cm5zIGVtcHR5IGFycmF5IGlmIG5vIE1hbmlmZXN0Rmxvd1JlY29yZGVyIGlzIGF0dGFjaGVkLlxuICAgKi9cbiAgZ2V0U3ViZmxvd01hbmlmZXN0KCk6IE1hbmlmZXN0RW50cnlbXSB7XG4gICAgY29uc3QgcmVjb3JkZXIgPSB0aGlzLmZsb3dSZWNvcmRlcnMuZmluZCgocikgPT4gciBpbnN0YW5jZW9mIE1hbmlmZXN0Rmxvd1JlY29yZGVyKSBhc1xuICAgICAgfCBNYW5pZmVzdEZsb3dSZWNvcmRlclxuICAgICAgfCB1bmRlZmluZWQ7XG4gICAgcmV0dXJuIHJlY29yZGVyPy5nZXRNYW5pZmVzdCgpID8/IFtdO1xuICB9XG5cbiAgLyoqXG4gICAqIFJldHVybnMgdGhlIGZ1bGwgc3BlYyBmb3IgYSBkeW5hbWljYWxseS1yZWdpc3RlcmVkIHN1YmZsb3cuXG4gICAqIFJlcXVpcmVzIGFuIGF0dGFjaGVkIE1hbmlmZXN0Rmxvd1JlY29yZGVyIHRoYXQgb2JzZXJ2ZWQgdGhlIHJlZ2lzdHJhdGlvbi5cbiAgICovXG4gIGdldFN1YmZsb3dTcGVjKHN1YmZsb3dJZDogc3RyaW5nKTogdW5rbm93biB8IHVuZGVmaW5lZCB7XG4gICAgY29uc3QgcmVjb3JkZXIgPSB0aGlzLmZsb3dSZWNvcmRlcnMuZmluZCgocikgPT4gciBpbnN0YW5jZW9mIE1hbmlmZXN0Rmxvd1JlY29yZGVyKSBhc1xuICAgICAgfCBNYW5pZmVzdEZsb3dSZWNvcmRlclxuICAgICAgfCB1bmRlZmluZWQ7XG4gICAgcmV0dXJuIHJlY29yZGVyPy5nZXRTcGVjKHN1YmZsb3dJZCk7XG4gIH1cbn1cbiJdfQ==