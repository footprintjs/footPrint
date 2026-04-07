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
import { CombinedNarrativeRecorder } from '../engine/narrative/CombinedNarrativeRecorder.js';
import { NarrativeFlowRecorder } from '../engine/narrative/NarrativeFlowRecorder.js';
import { ManifestFlowRecorder } from '../engine/narrative/recorders/ManifestFlowRecorder.js';
import { FlowchartTraverser } from '../engine/traversal/FlowchartTraverser.js';
import { defaultLogger, } from '../engine/types.js';
import { isPauseSignal } from '../pause/types.js';
import { ScopeFacade } from '../scope/ScopeFacade.js';
import { ExecutionRuntime } from './ExecutionRuntime.js';
import { validateInput } from './validateInput.js';
/** Default scope factory — creates a plain ScopeFacade for each stage. */
const defaultScopeFactory = (ctx, stageName, readOnly, env) => new ScopeFacade(ctx, stageName, readOnly, env);
export class FlowChartExecutor {
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
            this.combinedRecorder = new CombinedNarrativeRecorder(this.narrativeOptions);
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
            runtime = new ExecutionRuntime(effectiveRoot.name, effectiveRoot.id, args.defaultValuesForContext, effectiveInitialContext);
        }
        return new FlowchartTraverser({
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
            logger: (_e = fc.logger) !== null && _e !== void 0 ? _e : defaultLogger,
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
            if (isPauseSignal(error)) {
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
            recorders.push(new NarrativeFlowRecorder());
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
            validatedInput = validateInput(this.flowChartArgs.flowChart.inputSchema, validatedInput);
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
            if (isPauseSignal(error)) {
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
        const recorder = this.flowRecorders.find((r) => r instanceof ManifestFlowRecorder);
        return (_a = recorder === null || recorder === void 0 ? void 0 : recorder.getManifest()) !== null && _a !== void 0 ? _a : [];
    }
    /**
     * Returns the full spec for a dynamically-registered subflow.
     * Requires an attached ManifestFlowRecorder that observed the registration.
     */
    getSubflowSpec(subflowId) {
        const recorder = this.flowRecorders.find((r) => r instanceof ManifestFlowRecorder);
        return recorder === null || recorder === void 0 ? void 0 : recorder.getSpec(subflowId);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRmxvd0NoYXJ0RXhlY3V0b3IuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL3J1bm5lci9GbG93Q2hhcnRFeGVjdXRvci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7R0FpQkc7QUFHSCxPQUFPLEVBQUUseUJBQXlCLEVBQUUsTUFBTSxrREFBa0QsQ0FBQztBQUM3RixPQUFPLEVBQUUscUJBQXFCLEVBQUUsTUFBTSw4Q0FBOEMsQ0FBQztBQUdyRixPQUFPLEVBQUUsb0JBQW9CLEVBQUUsTUFBTSx1REFBdUQsQ0FBQztBQUU3RixPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSwyQ0FBMkMsQ0FBQztBQUMvRSxPQUFPLEVBWUwsYUFBYSxHQUNkLE1BQU0sb0JBQW9CLENBQUM7QUFFNUIsT0FBTyxFQUFFLGFBQWEsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBRWxELE9BQU8sRUFBRSxXQUFXLEVBQUUsTUFBTSx5QkFBeUIsQ0FBQztBQUV0RCxPQUFPLEVBQStDLGdCQUFnQixFQUFFLE1BQU0sdUJBQXVCLENBQUM7QUFDdEcsT0FBTyxFQUFFLGFBQWEsRUFBRSxNQUFNLG9CQUFvQixDQUFDO0FBRW5ELDBFQUEwRTtBQUMxRSxNQUFNLG1CQUFtQixHQUFpQixDQUFDLEdBQUcsRUFBRSxTQUFTLEVBQUUsUUFBUSxFQUFFLEdBQUcsRUFBRSxFQUFFLENBQzFFLElBQUksV0FBVyxDQUFDLEdBQUcsRUFBRSxTQUFTLEVBQUUsUUFBUSxFQUFFLEdBQUcsQ0FBQyxDQUFDO0FBaUVqRCxNQUFNLE9BQU8saUJBQWlCO0lBMkI1Qjs7Ozs7Ozs7Ozs7Ozs7O09BZUc7SUFDSCxZQUNFLFNBQWtDLEVBQ2xDLGdCQUEwRTs7UUEzQ3BFLHFCQUFnQixHQUFHLEtBQUssQ0FBQztRQUd6QixrQkFBYSxHQUFtQixFQUFFLENBQUM7UUFDbkMsbUJBQWMsR0FBZSxFQUFFLENBQUM7UUFFaEMsdUJBQWtCLEdB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Q0FBQyxtQkFBbUIsRUFBVyxDQUFDO0lBQ3ZELENBQUM7SUFFRCxnQkFBZ0I7SUFDaEIsa0JBQWtCO1FBQ2hCLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxrQkFBa0IsRUFBRSxDQUFDO0lBQzdDLENBQUM7SUFFRDs7O09BR0c7SUFDSCxrQkFBa0I7O1FBQ2hCLE1BQU0sUUFBUSxHQUFHLElBQUksQ0FBQyxhQUFhLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLFlBQVksb0JBQW9CLENBRXBFLENBQUM7UUFDZCxPQUFPLE1BQUEsUUFBUSxhQUFSLFFBQVEsdUJBQVIsUUFBUSxDQUFFLFdBQVcsRUFBRSxtQ0FBSSxFQUFFLENBQUM7SUFDdkMsQ0FBQztJQUVEOzs7T0FHRztJQUNILGNBQWMsQ0FBQyxTQUFpQjtRQUM5QixNQUFNLFFBQVEsR0FBRyxJQUFJLENBQUMsYUFBYSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxZQUFZLG9CQUFvQixDQUVwRSxDQUFDO1FBQ2QsT0FBTyxRQUFRLGFBQVIsUUFBUSx1QkFBUixRQUFRLENBQUUsT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQ3RDLENBQUM7Q0FDRiIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogRmxvd0NoYXJ0RXhlY3V0b3Ig4oCUIFB1YmxpYyBBUEkgZm9yIGV4ZWN1dGluZyBhIGNvbXBpbGVkIEZsb3dDaGFydC5cbiAqXG4gKiBXcmFwcyBGbG93Y2hhcnRUcmF2ZXJzZXIuIEJ1aWxkIGEgY2hhcnQgd2l0aCBmbG93Q2hhcnQoKSBhbmQgcGFzcyB0aGUgcmVzdWx0IGhlcmU6XG4gKlxuICogICBjb25zdCBjaGFydCA9IGZsb3dDaGFydCgnZW50cnknLCBlbnRyeUZuKS5hZGRGdW5jdGlvbigncHJvY2VzcycsIHByb2Nlc3NGbikuYnVpbGQoKTtcbiAqXG4gKiAgIC8vIE5vLW9wdGlvbnMgZm9ybSAodXNlcyBhdXRvLWRldGVjdGVkIFR5cGVkU2NvcGUgZmFjdG9yeSBmcm9tIHRoZSBjaGFydCk6XG4gKiAgIGNvbnN0IGV4ZWN1dG9yID0gbmV3IEZsb3dDaGFydEV4ZWN1dG9yKGNoYXJ0KTtcbiAqXG4gKiAgIC8vIE9wdGlvbnMtb2JqZWN0IGZvcm0gKHByZWZlcnJlZCB3aGVuIHlvdSBuZWVkIHRvIGN1c3RvbWl6ZSBiZWhhdmlvcik6XG4gKiAgIGNvbnN0IGV4ZWN1dG9yID0gbmV3IEZsb3dDaGFydEV4ZWN1dG9yKGNoYXJ0LCB7IHNjb3BlRmFjdG9yeTogbXlGYWN0b3J5LCBlbnJpY2hTbmFwc2hvdHM6IHRydWUgfSk7XG4gKlxuICogICAvLyAyLXBhcmFtIGZvcm0gKGFjY2VwdHMgYSBTY29wZUZhY3RvcnkgZGlyZWN0bHksIGZvciBiYWNrd2FyZCBjb21wYXRpYmlsaXR5KTpcbiAqICAgY29uc3QgZXhlY3V0b3IgPSBuZXcgRmxvd0NoYXJ0RXhlY3V0b3IoY2hhcnQsIG15RmFjdG9yeSk7XG4gKlxuICogICBjb25zdCByZXN1bHQgPSBhd2FpdCBleGVjdXRvci5ydW4oeyBpbnB1dDogZGF0YSwgZW52OiB7IHRyYWNlSWQ6ICdyZXEtMTIzJyB9IH0pO1xuICovXG5cbmltcG9ydCB0eXBlIHsgQ29tYmluZWROYXJyYXRpdmVSZWNvcmRlck9wdGlvbnMgfSBmcm9tICcuLi9lbmdpbmUvbmFycmF0aXZlL0NvbWJpbmVkTmFycmF0aXZlUmVjb3JkZXIuanMnO1xuaW1wb3J0IHsgQ29tYmluZWROYXJyYXRpdmVSZWNvcmRlciB9IGZyb20gJy4uL2VuZ2luZS9uYXJyYXRpdmUvQ29tYmluZWROYXJyYXRpdmVSZWNvcmRlci5qcyc7XG5pbXBvcnQgeyBOYXJyYXRpdmVGbG93UmVjb3JkZXIgfSBmcm9tICcuLi9lbmdpbmUvbmFycmF0aXZlL05hcnJhdGl2ZUZsb3dSZWNvcmRlci5qcyc7XG5pbXBvcnQgdHlwZSB7IENvbWJpbmVkTmFycmF0aXZlRW50cnkgfSBmcm9tICcuLi9lbmdpbmUvbmFycmF0aXZlL25hcnJhdGl2ZVR5cGVzLmpzJztcbmltcG9ydCB0eXBlIHsgTWFuaWZlc3RFbnRyeSB9IGZyb20gJy4uL2VuZ2luZS9uYXJyYXRpdmUvcmVjb3JkZXJzL01hbmlmZXN0Rmxvd1JlY29yZGVyLmpzJztcbmltcG9ydCB7IE1hbmlmZXN0Rmxvd1JlY29yZGVyIH0gZnJvbSAnLi4vZW5naW5lL25hcnJhdGl2ZS9yZWNvcmRlcnMvTWFuaWZlc3RGbG93UmVjb3JkZXIuanMnO1xuaW1wb3J0IHR5cGUgeyBGbG93UmVjb3JkZXIgfSBmcm9tICcuLi9lbmdpbmUvbmFycmF0aXZlL3R5cGVzLmpzJztcbmltcG9ydCB7IEZsb3djaGFydFRyYXZlcnNlciB9IGZyb20gJy4uL2VuZ2luZS90cmF2ZXJzYWwvRmxvd2NoYXJ0VHJhdmVyc2VyLmpzJztcbmltcG9ydCB7XG4gIHR5cGUgRXhlY3V0b3JSZXN1bHQsXG4gIHR5cGUgRXh0cmFjdG9yRXJyb3IsXG4gIHR5cGUgRmxvd0NoYXJ0LFxuICB0eXBlIFBhdXNlZFJlc3VsdCxcbiAgdHlwZSBSdW5PcHRpb25zLFxuICB0eXBlIFNjb3BlRmFjdG9yeSxcbiAgdHlwZSBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUsXG4gIHR5cGUgU3RhZ2VOb2RlLFxuICB0eXBlIFN0cmVhbUhhbmRsZXJzLFxuICB0eXBlIFN1YmZsb3dSZXN1bHQsXG4gIHR5cGUgVHJhdmVyc2FsUmVzdWx0LFxuICBkZWZhdWx0TG9nZ2VyLFxufSBmcm9tICcuLi9lbmdpbmUvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBGbG93Y2hhcnRDaGVja3BvaW50IH0gZnJvbSAnLi4vcGF1c2UvdHlwZXMuanMnO1xuaW1wb3J0IHsgaXNQYXVzZVNpZ25hbCB9IGZyb20gJy4uL3BhdXNlL3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHsgU2NvcGVQcm90ZWN0aW9uTW9kZSB9IGZyb20gJy4uL3Njb3BlL3Byb3RlY3Rpb24vdHlwZXMuanMnO1xuaW1wb3J0IHsgU2NvcGVGYWNhZGUgfSBmcm9tICcuLi9zY29wZS9TY29wZUZhY2FkZS5qcyc7XG5pbXBvcnQgdHlwZSB7IFJlY29yZGVyLCBSZWRhY3Rpb25Qb2xpY3ksIFJlZGFjdGlvblJlcG9ydCB9IGZyb20gJy4uL3Njb3BlL3R5cGVzLmpzJztcbmltcG9ydCB7IHR5cGUgUmVjb3JkZXJTbmFwc2hvdCwgdHlwZSBSdW50aW1lU25hcHNob3QsIEV4ZWN1dGlvblJ1bnRpbWUgfSBmcm9tICcuL0V4ZWN1dGlvblJ1bnRpbWUuanMnO1xuaW1wb3J0IHsgdmFsaWRhdGVJbnB1dCB9IGZyb20gJy4vdmFsaWRhdGVJbnB1dC5qcyc7XG5cbi8qKiBEZWZhdWx0IHNjb3BlIGZhY3Rvcnkg4oCUIGNyZWF0ZXMgYSBwbGFpbiBTY29wZUZhY2FkZSBmb3IgZWFjaCBzdGFnZS4gKi9cbmNvbnN0IGRlZmF1bHRTY29wZUZhY3Rvcnk6IFNjb3BlRmFjdG9yeSA9IChjdHgsIHN0YWdlTmFtZSwgcmVhZE9ubHksIGVudikgPT5cbiAgbmV3IFNjb3BlRmFjYWRlKGN0eCwgc3RhZ2VOYW1lLCByZWFkT25seSwgZW52KTtcblxuLyoqXG4gKiBPcHRpb25zIG9iamVjdCBmb3IgYEZsb3dDaGFydEV4ZWN1dG9yYCDigJQgcHJlZmVycmVkIG92ZXIgcG9zaXRpb25hbCBwYXJhbXMuXG4gKlxuICogYGBgdHlwZXNjcmlwdFxuICogY29uc3QgZXggPSBuZXcgRmxvd0NoYXJ0RXhlY3V0b3IoY2hhcnQsIHtcbiAqICAgc2NvcGVGYWN0b3J5OiBteUZhY3RvcnksXG4gKiAgIGVucmljaFNuYXBzaG90czogdHJ1ZSxcbiAqIH0pO1xuICogYGBgXG4gKlxuICogKipTeW5jIG5vdGUgZm9yIG1haW50YWluZXJzOioqIEV2ZXJ5IGZpZWxkIGFkZGVkIGhlcmUgbXVzdCBhbHNvIGFwcGVhciBpbiB0aGVcbiAqIGBmbG93Q2hhcnRBcmdzYCBwcml2YXRlIGZpZWxkIHR5cGUgYW5kIGluIHRoZSBjb25zdHJ1Y3RvcidzIG9wdGlvbnMtcmVzb2x1dGlvblxuICogYmxvY2sgKHRoZSBgZWxzZSBpZmAgYnJhbmNoIHRoYXQgcmVhZHMgZnJvbSBgb3B0c2ApLiBNaXNzaW5nIGFueSBvbmUgb2YgdGhlXG4gKiB0aHJlZSBjYXVzZXMgc2lsZW50IG9taXNzaW9uIOKAlCB0aGUgb3B0aW9uIGlzIGFjY2VwdGVkIGJ1dCBuZXZlciBhcHBsaWVkLlxuICpcbiAqICoqVFNjb3BlIGluZmVyZW5jZSBub3RlOioqIFdoZW4gdXNpbmcgdGhlIG9wdGlvbnMtb2JqZWN0IGZvcm0gd2l0aCBhIGN1c3RvbSBzY29wZSxcbiAqIFR5cGVTY3JpcHQgY2Fubm90IGluZmVyIGBUU2NvcGVgIHRocm91Z2ggdGhlIG9wdGlvbnMgb2JqZWN0LiBQYXNzIHRoZSB0eXBlXG4gKiBleHBsaWNpdGx5OiBgbmV3IEZsb3dDaGFydEV4ZWN1dG9yPFRPdXQsIE15U2NvcGU+KGNoYXJ0LCB7IHNjb3BlRmFjdG9yeSB9KWAuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRmxvd0NoYXJ0RXhlY3V0b3JPcHRpb25zPFRTY29wZSA9IGFueT4ge1xuICAvLyDilIDilIAgQ29tbW9uIG9wdGlvbnMgKG1vc3QgY2FsbGVycyBuZWVkIG9ubHkgdGhlc2UpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKiBDdXN0b20gc2NvcGUgZmFjdG9yeS4gRGVmYXVsdHMgdG8gVHlwZWRTY29wZSBvciBTY29wZUZhY2FkZSBhdXRvLWRldGVjdGlvbi4gKi9cbiAgc2NvcGVGYWN0b3J5PzogU2NvcGVGYWN0b3J5PFRTY29wZT47XG4gIC8qKlxuICAgKiBBdHRhY2ggYSBwZXItc3RhZ2Ugc2NvcGUgc25hcHNob3QgdG8gZWFjaCBleHRyYWN0b3IgcmVzdWx0LiBXaGVuIGB0cnVlYCwgdGhlXG4gICAqIGV4dHJhY3Rpb24gY2FsbGJhY2sgcmVjZWl2ZXMgdGhlIGZ1bGwgc2hhcmVkIHN0YXRlIGF0IHRoZSBwb2ludCB0aGF0IHN0YWdlXG4gICAqIGNvbW1pdHRlZCDigJQgdXNlZnVsIGZvciBkZWJ1Z2dpbmcgbXVsdGktc3RhZ2Ugc3RhdGUgdHJhbnNpdGlvbnMuIERlZmF1bHRzIHRvXG4gICAqIGBmYWxzZWAgKG5vIHNjb3BlIHNuYXBzaG90IGF0dGFjaGVkKS4gQ2FuIGFsc28gYmUgc2V0IG9uIHRoZSBjaGFydCB2aWFcbiAgICogYGZsb3dDaGFydCguLi4pLmVucmljaFNuYXBzaG90cyh0cnVlKWAuXG4gICAqL1xuICBlbnJpY2hTbmFwc2hvdHM/OiBib29sZWFuO1xuXG4gIC8vIOKUgOKUgCBDb250ZXh0IG9wdGlvbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIERlZmF1bHQgdmFsdWVzIHByZS1wb3B1bGF0ZWQgaW50byB0aGUgc2hhcmVkIGNvbnRleHQgYmVmb3JlICoqZWFjaCoqIHN0YWdlXG4gICAqIChyZS1hcHBsaWVkIGV2ZXJ5IHN0YWdlLCBhY3RpbmcgYXMgYmFzZWxpbmUgZGVmYXVsdHMpLlxuICAgKi9cbiAgZGVmYXVsdFZhbHVlc0ZvckNvbnRleHQ/OiB1bmtub3duO1xuICAvKipcbiAgICogSW5pdGlhbCBjb250ZXh0IHZhbHVlcyBtZXJnZWQgaW50byB0aGUgc2hhcmVkIGNvbnRleHQgKipvbmNlKiogYXQgc3RhcnR1cFxuICAgKiAoYXBwbGllZCBiZWZvcmUgdGhlIGZpcnN0IHN0YWdlLCBub3QgcmVwZWF0ZWQgb24gc3Vic2VxdWVudCBzdGFnZXMpLlxuICAgKiBEaXN0aW5jdCBmcm9tIGBkZWZhdWx0VmFsdWVzRm9yQ29udGV4dGAsIHdoaWNoIGlzIHJlLWFwcGxpZWQgZXZlcnkgc3RhZ2UuXG4gICAqL1xuICBpbml0aWFsQ29udGV4dD86IHVua25vd247XG4gIC8qKiBSZWFkLW9ubHkgaW5wdXQgYWNjZXNzaWJsZSB2aWEgYHNjb3BlLmdldEFyZ3MoKWAg4oCUIG5ldmVyIHRyYWNrZWQgb3Igd3JpdHRlbi4gKi9cbiAgcmVhZE9ubHlDb250ZXh0PzogdW5rbm93bjtcblxuICAvLyDilIDilIAgQWR2YW5jZWQgLyBlc2NhcGUtaGF0Y2ggb3B0aW9ucyAobW9zdCBjYWxsZXJzIGRvIG5vdCBuZWVkIHRoZXNlKSDilIDilIDilIDilIDilIBcblxuICAvKipcbiAgICogQ3VzdG9tIGVycm9yIGNsYXNzaWZpZXIgZm9yIHRocm90dGxpbmcgZGV0ZWN0aW9uLiBSZXR1cm4gYHRydWVgIGlmIHRoZVxuICAgKiBlcnJvciByZXByZXNlbnRzIGEgcmF0ZS1saW1pdCBvciBiYWNrcHJlc3N1cmUgY29uZGl0aW9uICh0aGUgZXhlY3V0b3Igd2lsbFxuICAgKiB0cmVhdCBpdCBkaWZmZXJlbnRseSBmcm9tIGhhcmQgZmFpbHVyZXMpLiBEZWZhdWx0cyB0byBubyB0aHJvdHRsaW5nIGNsYXNzaWZpY2F0aW9uLlxuICAgKi9cbiAgdGhyb3R0bGluZ0Vycm9yQ2hlY2tlcj86IChlcnJvcjogdW5rbm93bikgPT4gYm9vbGVhbjtcbiAgLyoqIEhhbmRsZXJzIGZvciBzdHJlYW1pbmcgc3RhZ2UgbGlmZWN5Y2xlIGV2ZW50cyAoc2VlIGBhZGRTdHJlYW1pbmdGdW5jdGlvbmApLiAqL1xuICBzdHJlYW1IYW5kbGVycz86IFN0cmVhbUhhbmRsZXJzO1xuICAvKiogU2NvcGUgcHJvdGVjdGlvbiBtb2RlIGZvciBUeXBlZFNjb3BlIGRpcmVjdC1hc3NpZ25tZW50IGRldGVjdGlvbi4gKi9cbiAgc2NvcGVQcm90ZWN0aW9uTW9kZT86IFNjb3BlUHJvdGVjdGlvbk1vZGU7XG59XG5cbmV4cG9ydCBjbGFzcyBGbG93Q2hhcnRFeGVjdXRvcjxUT3V0ID0gYW55LCBUU2NvcGUgPSBhbnk+IHtcbiAgcHJpdmF0ZSB0cmF2ZXJzZXI6IEZsb3djaGFydFRyYXZlcnNlcjxUT3V0LCBUU2NvcGU+O1xuICBwcml2YXRlIG5hcnJhdGl2ZUVuYWJsZWQgPSBmYWxzZTtcbiAgcHJpdmF0ZSBuYXJyYXRpdmVPcHRpb25zPzogQ29tYmluZWROYXJyYXRpdmVSZWNvcmRlck9wdGlvbnM7XG4gIHByaXZhdGUgY29tYmluZWRSZWNvcmRlcjogQ29tYmluZWROYXJyYXRpdmVSZWNvcmRlciB8IHVuZGVmaW5lZDtcbiAgcHJpdmF0ZSBmbG93UmVjb3JkZXJzOiBGbG93UmVjb3JkZXJbXSA9IFtdO1xuICBwcml2YXRlIHNjb3BlUmVjb3JkZXJzOiBSZWNvcmRlcltdID0gW107XG4gIHByaXZhdGUgcmVkYWN0aW9uUG9saWN5OiBSZWRhY3Rpb25Qb2xpY3kgfCB1bmRlZmluZWQ7XG4gIHByaXZhdGUgc2hhcmVkUmVkYWN0ZWRLZXlzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIHByaXZhdGUgc2hhcmVkUmVkYWN0ZWRGaWVsZHNCeUtleSA9IG5ldyBNYXA8c3RyaW5nLCBTZXQ8c3RyaW5nPj4oKTtcbiAgcHJpdmF0ZSBsYXN0Q2hlY2twb2ludDogRmxvd2NoYXJ0Q2hlY2twb2ludCB8IHVuZGVmaW5lZDtcblxuICAvLyBTWU5DIFJFUVVJUkVEOiBldmVyeSBvcHRpb25hbCBmaWVsZCBoZXJlIG11c3QgbWlycm9yIEZsb3dDaGFydEV4ZWN1dG9yT3B0aW9uc1xuICAvLyBBTkQgYmUgYXNzaWduZWQgaW4gdGhlIGNvbnN0cnVjdG9yJ3Mgb3B0aW9ucy1yZXNvbHV0aW9uIGJsb2NrICh0aGUgYGVsc2UgaWZgIGJyYW5jaCkuXG4gIC8vIEFkZGluZyBhIGZpZWxkIHRvIG9ubHkgb25lIG9mIHRoZSB0aHJlZSBwbGFjZXMgY2F1c2VzIHNpbGVudCBvbWlzc2lvbi5cbiAgcHJpdmF0ZSByZWFkb25seSBmbG93Q2hhcnRBcmdzOiB7XG4gICAgZmxvd0NoYXJ0OiBGbG93Q2hhcnQ8VE91dCwgVFNjb3BlPjtcbiAgICBzY29wZUZhY3Rvcnk6IFNjb3BlRmFjdG9yeTxUU2NvcGU+O1xuICAgIGRlZmF1bHRWYWx1ZXNGb3JDb250ZXh0PzogdW5rbm93bjtcbiAgICBpbml0aWFsQ29udGV4dD86IHVua25vd247XG4gICAgcmVhZE9ubHlDb250ZXh0PzogdW5rbm93bjtcbiAgICB0aHJvdHRsaW5nRXJyb3JDaGVja2VyPzogKGVycm9yOiB1bmtub3duKSA9PiBib29sZWFuO1xuICAgIHN0cmVhbUhhbmRsZXJzPzogU3RyZWFtSGFuZGxlcnM7XG4gICAgc2NvcGVQcm90ZWN0aW9uTW9kZT86IFNjb3BlUHJvdGVjdGlvbk1vZGU7XG4gICAgZW5yaWNoU25hcHNob3RzPzogYm9vbGVhbjtcbiAgfTtcblxuICAvKipcbiAgICogQ3JlYXRlIGEgRmxvd0NoYXJ0RXhlY3V0b3IuXG4gICAqXG4gICAqICoqT3B0aW9ucyBvYmplY3QgZm9ybSoqIChwcmVmZXJyZWQpOlxuICAgKiBgYGB0eXBlc2NyaXB0XG4gICAqIG5ldyBGbG93Q2hhcnRFeGVjdXRvcihjaGFydCwgeyBzY29wZUZhY3RvcnksIGVucmljaFNuYXBzaG90czogdHJ1ZSB9KVxuICAgKiBgYGBcbiAgICpcbiAgICogKioyLXBhcmFtIGZvcm0qKiAoYWxzbyBzdXBwb3J0ZWQpOlxuICAgKiBgYGB0eXBlc2NyaXB0XG4gICAqIG5ldyBGbG93Q2hhcnRFeGVjdXRvcihjaGFydCwgc2NvcGVGYWN0b3J5KVxuICAgKiBgYGBcbiAgICpcbiAgICogQHBhcmFtIGZsb3dDaGFydCAtIFRoZSBjb21waWxlZCBGbG93Q2hhcnQgcmV0dXJuZWQgYnkgYGZsb3dDaGFydCguLi4pLmJ1aWxkKClgXG4gICAqIEBwYXJhbSBmYWN0b3J5T3JPcHRpb25zIC0gQSBgU2NvcGVGYWN0b3J5PFRTY29wZT5gIE9SIGEgYEZsb3dDaGFydEV4ZWN1dG9yT3B0aW9uczxUU2NvcGU+YCBvcHRpb25zIG9iamVjdC5cbiAgICovXG4gIGNvbnN0cnVjdG9yKFxuICAgIGZsb3dDaGFydDogRmxvd0NoYXJ0PFRPdXQsIFRTY29wZT4sXG4gICAgZmFjdG9yeU9yT3B0aW9ucz86IFNjb3BlRmFjdG9yeTxUU2NvcGU+IHwgRmxvd0NoYXJ0RXhlY3V0b3JPcHRpb25zPFRTY29wZT4sXG4gICkge1xuICAgIC8vIERldGVjdCBvcHRpb25zLW9iamVjdCBmb3JtIHZzIGZhY3RvcnkgZm9ybVxuICAgIGxldCBzY29wZUZhY3Rvcnk6IFNjb3BlRmFjdG9yeTxUU2NvcGU+IHwgdW5kZWZpbmVkO1xuICAgIGxldCBkZWZhdWx0VmFsdWVzRm9yQ29udGV4dDogdW5rbm93bjtcbiAgICBsZXQgaW5pdGlhbENvbnRleHQ6IHVua25vd247XG4gICAgbGV0IHJlYWRPbmx5Q29udGV4dDogdW5rbm93bjtcbiAgICBsZXQgdGhyb3R0bGluZ0Vycm9yQ2hlY2tlcjogKChlcnJvcjogdW5rbm93bikgPT4gYm9vbGVhbikgfCB1bmRlZmluZWQ7XG4gICAgbGV0IHN0cmVhbUhhbmRsZXJzOiBTdHJlYW1IYW5kbGVycyB8IHVuZGVmaW5lZDtcbiAgICBsZXQgc2NvcGVQcm90ZWN0aW9uTW9kZTogU2NvcGVQcm90ZWN0aW9uTW9kZSB8IHVuZGVmaW5lZDtcbiAgICBsZXQgZW5yaWNoU25hcHNob3RzOiBib29sZWFuIHwgdW5kZWZpbmVkO1xuXG4gICAgaWYgKHR5cGVvZiBmYWN0b3J5T3JPcHRpb25zID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAvLyAyLXBhcmFtIGZvcm06IG5ldyBGbG93Q2hhcnRFeGVjdXRvcihjaGFydCwgc2NvcGVGYWN0b3J5KVxuICAgICAgc2NvcGVGYWN0b3J5ID0gZmFjdG9yeU9yT3B0aW9ucztcbiAgICB9IGVsc2UgaWYgKGZhY3RvcnlPck9wdGlvbnMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgLy8gT3B0aW9ucyBvYmplY3QgZm9ybTogbmV3IEZsb3dDaGFydEV4ZWN1dG9yKGNoYXJ0LCB7IHNjb3BlRmFjdG9yeSwgZW5yaWNoU25hcHNob3RzLCAuLi4gfSlcbiAgICAgIGNvbnN0IG9wdHMgPSBmYWN0b3J5T3JPcHRpb25zO1xuICAgICAgc2NvcGVGYWN0b3J5ID0gb3B0cy5zY29wZUZhY3Rvcnk7XG4gICAgICBkZWZhdWx0VmFsdWVzRm9yQ29udGV4dCA9IG9wdHMuZGVmYXVsdFZhbHVlc0ZvckNvbnRleHQ7XG4gICAgICBpbml0aWFsQ29udGV4dCA9IG9wdHMuaW5pdGlhbENvbnRleHQ7XG4gICAgICByZWFkT25seUNvbnRleHQgPSBvcHRzLnJlYWRPbmx5Q29udGV4dDtcbiAgICAgIHRocm90dGxpbmdFcnJvckNoZWNrZXIgPSBvcHRzLnRocm90dGxpbmdFcnJvckNoZWNrZXI7XG4gICAgICBzdHJlYW1IYW5kbGVycyA9IG9wdHMuc3RyZWFtSGFuZGxlcnM7XG4gICAgICBzY29wZVByb3RlY3Rpb25Nb2RlID0gb3B0cy5zY29wZVByb3RlY3Rpb25Nb2RlO1xuICAgICAgZW5yaWNoU25hcHNob3RzID0gb3B0cy5lbnJpY2hTbmFwc2hvdHM7XG4gICAgfVxuICAgIHRoaXMuZmxvd0NoYXJ0QXJncyA9IHtcbiAgICAgIGZsb3dDaGFydCxcbiAgICAgIHNjb3BlRmFjdG9yeTogc2NvcGVGYWN0b3J5ID8/IGZsb3dDaGFydC5zY29wZUZhY3RvcnkgPz8gKGRlZmF1bHRTY29wZUZhY3RvcnkgYXMgU2NvcGVGYWN0b3J5PFRTY29wZT4pLFxuICAgICAgZGVmYXVsdFZhbHVlc0ZvckNvbnRleHQsXG4gICAgICBpbml0aWFsQ29udGV4dCxcbiAgICAgIHJlYWRPbmx5Q29udGV4dCxcbiAgICAgIHRocm90dGxpbmdFcnJvckNoZWNrZXIsXG4gICAgICBzdHJlYW1IYW5kbGVycyxcbiAgICAgIHNjb3BlUHJvdGVjdGlvbk1vZGUsXG4gICAgICBlbnJpY2hTbmFwc2hvdHMsXG4gICAgfTtcbiAgICB0aGlzLnRyYXZlcnNlciA9IHRoaXMuY3JlYXRlVHJhdmVyc2VyKCk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVRyYXZlcnNlcihcbiAgICBzaWduYWw/OiBBYm9ydFNpZ25hbCxcbiAgICByZWFkT25seUNvbnRleHRPdmVycmlkZT86IHVua25vd24sXG4gICAgZW52PzogaW1wb3J0KCcuLi9lbmdpbmUvdHlwZXMnKS5FeGVjdXRpb25FbnYsXG4gICAgbWF4RGVwdGg/OiBudW1iZXIsXG4gICAgb3ZlcnJpZGVzPzoge1xuICAgICAgcm9vdD86IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+O1xuICAgICAgaW5pdGlhbENvbnRleHQ/OiB1bmtub3duO1xuICAgICAgcHJlc2VydmVSZWNvcmRlcnM/OiBib29sZWFuO1xuICAgICAgZXhpc3RpbmdSdW50aW1lPzogSW5zdGFuY2VUeXBlPHR5cGVvZiBFeGVjdXRpb25SdW50aW1lPjtcbiAgICB9LFxuICApOiBGbG93Y2hhcnRUcmF2ZXJzZXI8VE91dCwgVFNjb3BlPiB7XG4gICAgY29uc3QgYXJncyA9IHRoaXMuZmxvd0NoYXJ0QXJncztcbiAgICBjb25zdCBmYyA9IGFyZ3MuZmxvd0NoYXJ0O1xuICAgIGNvbnN0IG5hcnJhdGl2ZUZsYWcgPSB0aGlzLm5hcnJhdGl2ZUVuYWJsZWQgfHwgKGZjLmVuYWJsZU5hcnJhdGl2ZSA/PyBmYWxzZSk7XG5cbiAgICAvLyDilIDilIAgQ29tcG9zZWQgc2NvcGUgZmFjdG9yeSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgICAvLyBDb2xsZWN0IGFsbCBzY29wZSBtb2RpZmllcnMgKHJlY29yZGVycywgcmVkYWN0aW9uKSBpbnRvIGEgc2luZ2xlIGxpc3QsXG4gICAgLy8gdGhlbiBjcmVhdGUgT05FIGZhY3RvcnkgdGhhdCBhcHBsaWVzIHRoZW0gaW4gYSBsb29wLiBSZXBsYWNlcyB0aGVcbiAgICAvLyBwcmV2aW91cyA0LWRlZXAgY2xvc3VyZSBuZXN0aW5nIHdpdGggYSBmbGF0LCBkZWJ1Z2dhYmxlIGNvbXBvc2l0aW9uLlxuXG4gICAgaWYgKG92ZXJyaWRlcz8ucHJlc2VydmVSZWNvcmRlcnMpIHtcbiAgICAgIC8vIFJlc3VtZSBtb2RlOiBrZWVwIGV4aXN0aW5nIGNvbWJpbmVkUmVjb3JkZXIgc28gbmFycmF0aXZlIGFjY3VtdWxhdGVzXG4gICAgfSBlbHNlIGlmIChuYXJyYXRpdmVGbGFnKSB7XG4gICAgICB0aGlzLmNvbWJpbmVkUmVjb3JkZXIgPSBuZXcgQ29tYmluZWROYXJyYXRpdmVSZWNvcmRlcih0aGlzLm5hcnJhdGl2ZU9wdGlvbnMpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmNvbWJpbmVkUmVjb3JkZXIgPSB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgdGhpcy5zaGFyZWRSZWRhY3RlZEtleXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICB0aGlzLnNoYXJlZFJlZGFjdGVkRmllbGRzQnlLZXkgPSBuZXcgTWFwPHN0cmluZywgU2V0PHN0cmluZz4+KCk7XG5cbiAgICAvLyBCdWlsZCBtb2RpZmllciBsaXN0IOKAlCBlYWNoIG1vZGlmaWVyIHJlY2VpdmVzIHRoZSBzY29wZSBhZnRlciBjcmVhdGlvblxuICAgIHR5cGUgU2NvcGVNb2RpZmllciA9IChzY29wZTogYW55KSA9PiB2b2lkO1xuICAgIGNvbnN0IG1vZGlmaWVyczogU2NvcGVNb2RpZmllcltdID0gW107XG5cbiAgICAvLyAxLiBOYXJyYXRpdmUgcmVjb3JkZXIgKGlmIGVuYWJsZWQpXG4gICAgaWYgKHRoaXMuY29tYmluZWRSZWNvcmRlcikge1xuICAgICAgY29uc3QgcmVjb3JkZXIgPSB0aGlzLmNvbWJpbmVkUmVjb3JkZXI7XG4gICAgICBtb2RpZmllcnMucHVzaCgoc2NvcGUpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiBzY29wZS5hdHRhY2hSZWNvcmRlciA9PT0gJ2Z1bmN0aW9uJykgc2NvcGUuYXR0YWNoUmVjb3JkZXIocmVjb3JkZXIpO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gMi4gVXNlci1wcm92aWRlZCBzY29wZSByZWNvcmRlcnNcbiAgICBpZiAodGhpcy5zY29wZVJlY29yZGVycy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCByZWNvcmRlcnMgPSB0aGlzLnNjb3BlUmVjb3JkZXJzO1xuICAgICAgbW9kaWZpZXJzLnB1c2goKHNjb3BlKSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2Ygc2NvcGUuYXR0YWNoUmVjb3JkZXIgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICBmb3IgKGNvbnN0IHIgb2YgcmVjb3JkZXJzKSBzY29wZS5hdHRhY2hSZWNvcmRlcihyKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gMy4gUmVkYWN0aW9uIHBvbGljeSAoY29uZGl0aW9uYWwg4oCUIG9ubHkgd2hlbiBwb2xpY3kgaXMgc2V0KVxuICAgIGlmICh0aGlzLnJlZGFjdGlvblBvbGljeSkge1xuICAgICAgY29uc3QgcG9saWN5ID0gdGhpcy5yZWRhY3Rpb25Qb2xpY3k7XG4gICAgICBtb2RpZmllcnMucHVzaCgoc2NvcGUpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiBzY29wZS51c2VSZWRhY3Rpb25Qb2xpY3kgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICBzY29wZS51c2VSZWRhY3Rpb25Qb2xpY3kocG9saWN5KTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgICAvLyBQcmUtcG9wdWxhdGUgZXhlY3V0b3ItbGV2ZWwgZmllbGQgcmVkYWN0aW9uIG1hcCBmcm9tIHBvbGljeVxuICAgICAgLy8gc28gZ2V0UmVkYWN0aW9uUmVwb3J0KCkgaW5jbHVkZXMgZmllbGQtbGV2ZWwgcmVkYWN0aW9ucy5cbiAgICAgIGlmIChwb2xpY3kuZmllbGRzKSB7XG4gICAgICAgIGZvciAoY29uc3QgW2tleSwgZmllbGRzXSBvZiBPYmplY3QuZW50cmllcyhwb2xpY3kuZmllbGRzKSkge1xuICAgICAgICAgIHRoaXMuc2hhcmVkUmVkYWN0ZWRGaWVsZHNCeUtleS5zZXQoa2V5LCBuZXcgU2V0KGZpZWxkcykpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gQ29tcG9zZTogYmFzZSBmYWN0b3J5ICsgbW9kaWZpZXJzIGluIGEgc2luZ2xlIHBhc3MuXG4gICAgLy8gU2hhcmVkIHJlZGFjdGVkIGtleXMgYXJlIEFMV0FZUyB3aXJlZCB1cCAodW5jb25kaXRpb25hbCDigJQgZW5zdXJlcyBjcm9zcy1zdGFnZVxuICAgIC8vIHByb3BhZ2F0aW9uIGV2ZW4gd2l0aG91dCBhIHBvbGljeSwgYmVjYXVzZSBzdGFnZXMgY2FuIGNhbGwgc2V0VmFsdWUoa2V5LCB2YWwsIHRydWUpXG4gICAgLy8gZm9yIHBlci1jYWxsIHJlZGFjdGlvbikuIE9wdGlvbmFsIG1vZGlmaWVycyAocmVjb3JkZXJzLCBwb2xpY3kpIGFyZSBpbiB0aGUgbGlzdC5cbiAgICBjb25zdCBiYXNlRmFjdG9yeSA9IGFyZ3Muc2NvcGVGYWN0b3J5O1xuICAgIGNvbnN0IHNoYXJlZFJlZGFjdGVkS2V5cyA9IHRoaXMuc2hhcmVkUmVkYWN0ZWRLZXlzO1xuICAgIGNvbnN0IHNjb3BlRmFjdG9yeSA9ICgoY3R4OiBhbnksIHN0YWdlTmFtZTogc3RyaW5nLCByZWFkT25seT86IHVua25vd24sIGVudkFyZz86IGFueSkgPT4ge1xuICAgICAgY29uc3Qgc2NvcGUgPSBiYXNlRmFjdG9yeShjdHgsIHN0YWdlTmFtZSwgcmVhZE9ubHksIGVudkFyZyk7XG4gICAgICAvLyBBbHdheXMgd2lyZSBzaGFyZWQgcmVkYWN0aW9uIHN0YXRlXG4gICAgICBpZiAodHlwZW9mIChzY29wZSBhcyBhbnkpLnVzZVNoYXJlZFJlZGFjdGVkS2V5cyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAoc2NvcGUgYXMgYW55KS51c2VTaGFyZWRSZWRhY3RlZEtleXMoc2hhcmVkUmVkYWN0ZWRLZXlzKTtcbiAgICAgIH1cbiAgICAgIC8vIEFwcGx5IG9wdGlvbmFsIG1vZGlmaWVyc1xuICAgICAgZm9yIChjb25zdCBtb2Qgb2YgbW9kaWZpZXJzKSBtb2Qoc2NvcGUpO1xuICAgICAgcmV0dXJuIHNjb3BlO1xuICAgIH0pIGFzIFNjb3BlRmFjdG9yeTxUU2NvcGU+O1xuXG4gICAgY29uc3QgZWZmZWN0aXZlUm9vdCA9IG92ZXJyaWRlcz8ucm9vdCA/PyBmYy5yb290O1xuICAgIGNvbnN0IGVmZmVjdGl2ZUluaXRpYWxDb250ZXh0ID0gb3ZlcnJpZGVzPy5pbml0aWFsQ29udGV4dCA/PyBhcmdzLmluaXRpYWxDb250ZXh0O1xuXG4gICAgbGV0IHJ1bnRpbWU6IEV4ZWN1dGlvblJ1bnRpbWU7XG4gICAgaWYgKG92ZXJyaWRlcz8uZXhpc3RpbmdSdW50aW1lKSB7XG4gICAgICAvLyBSZXN1bWUgbW9kZTogcmV1c2UgZXhpc3RpbmcgcnVudGltZSBzbyBleGVjdXRpb24gdHJlZSBjb250aW51ZXMgZnJvbSBwYXVzZSBwb2ludC5cbiAgICAgIC8vIFByZXNlcnZlIHRoZSBvcmlnaW5hbCByb290IGZvciBnZXRTbmFwc2hvdCgpIChmdWxsIHRyZWUpLCB0aGVuIGFkdmFuY2VcbiAgICAgIC8vIHJvb3RTdGFnZUNvbnRleHQgdG8gYSBjb250aW51YXRpb24gZnJvbSB0aGUgbGVhZiAoZm9yIHRyYXZlcnNhbCkuXG4gICAgICBydW50aW1lID0gb3ZlcnJpZGVzLmV4aXN0aW5nUnVudGltZTtcbiAgICAgIHJ1bnRpbWUucHJlc2VydmVTbmFwc2hvdFJvb3QoKTtcbiAgICAgIGxldCBsZWFmID0gcnVudGltZS5yb290U3RhZ2VDb250ZXh0O1xuICAgICAgd2hpbGUgKGxlYWYubmV4dCkgbGVhZiA9IGxlYWYubmV4dDtcbiAgICAgIHJ1bnRpbWUucm9vdFN0YWdlQ29udGV4dCA9IGxlYWYuY3JlYXRlTmV4dCgnJywgZWZmZWN0aXZlUm9vdC5uYW1lLCBlZmZlY3RpdmVSb290LmlkKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcnVudGltZSA9IG5ldyBFeGVjdXRpb25SdW50aW1lKFxuICAgICAgICBlZmZlY3RpdmVSb290Lm5hbWUsXG4gICAgICAgIGVmZmVjdGl2ZVJvb3QuaWQsXG4gICAgICAgIGFyZ3MuZGVmYXVsdFZhbHVlc0ZvckNvbnRleHQsXG4gICAgICAgIGVmZmVjdGl2ZUluaXRpYWxDb250ZXh0LFxuICAgICAgKTtcbiAgICB9XG5cbiAgICByZXR1cm4gbmV3IEZsb3djaGFydFRyYXZlcnNlcjxUT3V0LCBUU2NvcGU+KHtcbiAgICAgIHJvb3Q6IGVmZmVjdGl2ZVJvb3QsXG4gICAgICBzdGFnZU1hcDogZmMuc3RhZ2VNYXAsXG4gICAgICBzY29wZUZhY3RvcnksXG4gICAgICBleGVjdXRpb25SdW50aW1lOiBydW50aW1lLFxuICAgICAgcmVhZE9ubHlDb250ZXh0OiByZWFkT25seUNvbnRleHRPdmVycmlkZSA/PyBhcmdzLnJlYWRPbmx5Q29udGV4dCxcbiAgICAgIHRocm90dGxpbmdFcnJvckNoZWNrZXI6IGFyZ3MudGhyb3R0bGluZ0Vycm9yQ2hlY2tlcixcbiAgICAgIHN0cmVhbUhhbmRsZXJzOiBhcmdzLnN0cmVhbUhhbmRsZXJzLFxuICAgICAgZXh0cmFjdG9yOiBmYy5leHRyYWN0b3IsXG4gICAgICBzY29wZVByb3RlY3Rpb25Nb2RlOiBhcmdzLnNjb3BlUHJvdGVjdGlvbk1vZGUsXG4gICAgICBzdWJmbG93czogZmMuc3ViZmxvd3MsXG4gICAgICBlbnJpY2hTbmFwc2hvdHM6IGFyZ3MuZW5yaWNoU25hcHNob3RzID8/IGZjLmVucmljaFNuYXBzaG90cyxcbiAgICAgIG5hcnJhdGl2ZUVuYWJsZWQ6IG5hcnJhdGl2ZUZsYWcsXG4gICAgICBidWlsZFRpbWVTdHJ1Y3R1cmU6IGZjLmJ1aWxkVGltZVN0cnVjdHVyZSxcbiAgICAgIGxvZ2dlcjogZmMubG9nZ2VyID8/IGRlZmF1bHRMb2dnZXIsXG4gICAgICBzaWduYWwsXG4gICAgICBleGVjdXRpb25FbnY6IGVudixcbiAgICAgIGZsb3dSZWNvcmRlcnM6IHRoaXMuYnVpbGRGbG93UmVjb3JkZXJzTGlzdCgpLFxuICAgICAgLi4uKG1heERlcHRoICE9PSB1bmRlZmluZWQgJiYgeyBtYXhEZXB0aCB9KSxcbiAgICB9KTtcbiAgfVxuXG4gIGVuYWJsZU5hcnJhdGl2ZShvcHRpb25zPzogQ29tYmluZWROYXJyYXRpdmVSZWNvcmRlck9wdGlvbnMpOiB2b2lkIHtcbiAgICB0aGlzLm5hcnJhdGl2ZUVuYWJsZWQgPSB0cnVlO1xuICAgIGlmIChvcHRpb25zKSB0aGlzLm5hcnJhdGl2ZU9wdGlvbnMgPSBvcHRpb25zO1xuICB9XG5cbiAgLyoqXG4gICAqIFNldCBhIGRlY2xhcmF0aXZlIHJlZGFjdGlvbiBwb2xpY3kgdGhhdCBhcHBsaWVzIHRvIGFsbCBzdGFnZXMuXG4gICAqIE11c3QgYmUgY2FsbGVkIGJlZm9yZSBydW4oKS5cbiAgICovXG4gIHNldFJlZGFjdGlvblBvbGljeShwb2xpY3k6IFJlZGFjdGlvblBvbGljeSk6IHZvaWQge1xuICAgIHRoaXMucmVkYWN0aW9uUG9saWN5ID0gcG9saWN5O1xuICB9XG5cbiAgLyoqXG4gICAqIFJldHVybnMgYSBjb21wbGlhbmNlLWZyaWVuZGx5IHJlcG9ydCBvZiBhbGwgcmVkYWN0aW9uIGFjdGl2aXR5IGZyb20gdGhlXG4gICAqIG1vc3QgcmVjZW50IHJ1bi4gTmV2ZXIgaW5jbHVkZXMgYWN0dWFsIHZhbHVlcy5cbiAgICovXG4gIGdldFJlZGFjdGlvblJlcG9ydCgpOiBSZWRhY3Rpb25SZXBvcnQge1xuICAgIGNvbnN0IGZpZWxkUmVkYWN0aW9uczogUmVjb3JkPHN0cmluZywgc3RyaW5nW10+ID0ge307XG4gICAgZm9yIChjb25zdCBba2V5LCBmaWVsZHNdIG9mIHRoaXMuc2hhcmVkUmVkYWN0ZWRGaWVsZHNCeUtleSkge1xuICAgICAgZmllbGRSZWRhY3Rpb25zW2tleV0gPSBbLi4uZmllbGRzXTtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIHJlZGFjdGVkS2V5czogWy4uLnRoaXMuc2hhcmVkUmVkYWN0ZWRLZXlzXSxcbiAgICAgIGZpZWxkUmVkYWN0aW9ucyxcbiAgICAgIHBhdHRlcm5zOiAodGhpcy5yZWRhY3Rpb25Qb2xpY3k/LnBhdHRlcm5zID8/IFtdKS5tYXAoKHApID0+IHAuc291cmNlKSxcbiAgICB9O1xuICB9XG5cbiAgLy8g4pSA4pSA4pSAIFBhdXNlL1Jlc3VtZSDilIDilIDilIBcblxuICAvKipcbiAgICogUmV0dXJucyB0aGUgY2hlY2twb2ludCBmcm9tIHRoZSBtb3N0IHJlY2VudCBwYXVzZWQgZXhlY3V0aW9uLCBvciBgdW5kZWZpbmVkYFxuICAgKiBpZiB0aGUgbGFzdCBydW4gY29tcGxldGVkIHdpdGhvdXQgcGF1c2luZy5cbiAgICpcbiAgICogVGhlIGNoZWNrcG9pbnQgaXMgSlNPTi1zZXJpYWxpemFibGUg4oCUIHN0b3JlIGl0IGluIFJlZGlzLCBQb3N0Z3JlcywgbG9jYWxTdG9yYWdlLCBldGMuXG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGBgYHR5cGVzY3JpcHRcbiAgICogY29uc3QgcmVzdWx0ID0gYXdhaXQgZXhlY3V0b3IucnVuKHsgaW5wdXQgfSk7XG4gICAqIGlmIChleGVjdXRvci5pc1BhdXNlZCgpKSB7XG4gICAqICAgY29uc3QgY2hlY2twb2ludCA9IGV4ZWN1dG9yLmdldENoZWNrcG9pbnQoKSE7XG4gICAqICAgYXdhaXQgcmVkaXMuc2V0KGBzZXNzaW9uOiR7aWR9YCwgSlNPTi5zdHJpbmdpZnkoY2hlY2twb2ludCkpO1xuICAgKiB9XG4gICAqIGBgYFxuICAgKi9cbiAgZ2V0Q2hlY2twb2ludCgpOiBGbG93Y2hhcnRDaGVja3BvaW50IHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy5sYXN0Q2hlY2twb2ludDtcbiAgfVxuXG4gIC8qKiBSZXR1cm5zIGB0cnVlYCBpZiB0aGUgbW9zdCByZWNlbnQgcnVuKCkgd2FzIHBhdXNlZCAoY2hlY2twb2ludCBhdmFpbGFibGUpLiAqL1xuICBpc1BhdXNlZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5sYXN0Q2hlY2twb2ludCAhPT0gdW5kZWZpbmVkO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlc3VtZSBhIHBhdXNlZCBmbG93Y2hhcnQgZnJvbSBhIGNoZWNrcG9pbnQuXG4gICAqXG4gICAqIFJlc3RvcmVzIHRoZSBzY29wZSBzdGF0ZSwgY2FsbHMgdGhlIHBhdXNlZCBzdGFnZSdzIGByZXN1bWVGbmAgd2l0aCB0aGVcbiAgICogcHJvdmlkZWQgaW5wdXQsIHRoZW4gY29udGludWVzIHRyYXZlcnNhbCBmcm9tIHRoZSBuZXh0IHN0YWdlLlxuICAgKlxuICAgKiBUaGUgY2hlY2twb2ludCBjYW4gY29tZSBmcm9tIGBnZXRDaGVja3BvaW50KClgIG9uIGEgcHJldmlvdXMgcnVuLCBvciBmcm9tXG4gICAqIGEgc2VyaWFsaXplZCBjaGVja3BvaW50IHN0b3JlZCBpbiBSZWRpcy9Qb3N0Z3Jlcy9sb2NhbFN0b3JhZ2UuXG4gICAqXG4gICAqICoqTmFycmF0aXZlL3JlY29yZGVyIHN0YXRlIGlzIHJlc2V0IG9uIHJlc3VtZS4qKiBUbyBrZWVwIGEgdW5pZmllZCBuYXJyYXRpdmVcbiAgICogYWNyb3NzIHBhdXNlL3Jlc3VtZSBjeWNsZXMsIGNvbGxlY3QgaXQgYmVmb3JlIGNhbGxpbmcgcmVzdW1lLlxuICAgKlxuICAgKiBAZXhhbXBsZVxuICAgKiBgYGB0eXBlc2NyaXB0XG4gICAqIC8vIEFmdGVyIGEgcGF1c2UuLi5cbiAgICogY29uc3QgY2hlY2twb2ludCA9IGV4ZWN1dG9yLmdldENoZWNrcG9pbnQoKSE7XG4gICAqIGF3YWl0IHJlZGlzLnNldChgc2Vzc2lvbjoke2lkfWAsIEpTT04uc3RyaW5naWZ5KGNoZWNrcG9pbnQpKTtcbiAgICpcbiAgICogLy8gTGF0ZXIgKHBvc3NpYmx5IGRpZmZlcmVudCBzZXJ2ZXIsIHNhbWUgY2hhcnQpXG4gICAqIGNvbnN0IGNoZWNrcG9pbnQgPSBKU09OLnBhcnNlKGF3YWl0IHJlZGlzLmdldChgc2Vzc2lvbjoke2lkfWApKTtcbiAgICogY29uc3QgZXhlY3V0b3IgPSBuZXcgRmxvd0NoYXJ0RXhlY3V0b3IoY2hhcnQpO1xuICAgKiBjb25zdCByZXN1bHQgPSBhd2FpdCBleGVjdXRvci5yZXN1bWUoY2hlY2twb2ludCwgeyBhcHByb3ZlZDogdHJ1ZSB9KTtcbiAgICogYGBgXG4gICAqL1xuICBhc3luYyByZXN1bWUoXG4gICAgY2hlY2twb2ludDogRmxvd2NoYXJ0Q2hlY2twb2ludCxcbiAgICByZXN1bWVJbnB1dD86IHVua25vd24sXG4gICAgb3B0aW9ucz86IFBpY2s8UnVuT3B0aW9ucywgJ3NpZ25hbCcgfCAnZW52JyB8ICdtYXhEZXB0aCc+LFxuICApOiBQcm9taXNlPEV4ZWN1dG9yUmVzdWx0PiB7XG4gICAgdGhpcy5sYXN0Q2hlY2twb2ludCA9IHVuZGVmaW5lZDtcblxuICAgIC8vIOKUgOKUgCBWYWxpZGF0ZSBjaGVja3BvaW50IHN0cnVjdHVyZSAobWF5IGNvbWUgZnJvbSB1bnRydXN0ZWQgZXh0ZXJuYWwgc3RvcmFnZSkg4pSA4pSAXG4gICAgaWYgKFxuICAgICAgIWNoZWNrcG9pbnQgfHxcbiAgICAgIHR5cGVvZiBjaGVja3BvaW50ICE9PSAnb2JqZWN0JyB8fFxuICAgICAgdHlwZW9mIGNoZWNrcG9pbnQuc2hhcmVkU3RhdGUgIT09ICdvYmplY3QnIHx8XG4gICAgICBjaGVja3BvaW50LnNoYXJlZFN0YXRlID09PSBudWxsIHx8XG4gICAgICBBcnJheS5pc0FycmF5KGNoZWNrcG9pbnQuc2hhcmVkU3RhdGUpXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgY2hlY2twb2ludDogc2hhcmVkU3RhdGUgbXVzdCBiZSBhIHBsYWluIG9iamVjdC4nKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBjaGVja3BvaW50LnBhdXNlZFN0YWdlSWQgIT09ICdzdHJpbmcnIHx8IGNoZWNrcG9pbnQucGF1c2VkU3RhZ2VJZCA9PT0gJycpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBjaGVja3BvaW50OiBwYXVzZWRTdGFnZUlkIG11c3QgYmUgYSBub24tZW1wdHkgc3RyaW5nLicpO1xuICAgIH1cbiAgICBpZiAoXG4gICAgICAhQXJyYXkuaXNBcnJheShjaGVja3BvaW50LnN1YmZsb3dQYXRoKSB8fFxuICAgICAgIWNoZWNrcG9pbnQuc3ViZmxvd1BhdGguZXZlcnkoKHM6IHVua25vd24pID0+IHR5cGVvZiBzID09PSAnc3RyaW5nJylcbiAgICApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBjaGVja3BvaW50OiBzdWJmbG93UGF0aCBtdXN0IGJlIGFuIGFycmF5IG9mIHN0cmluZ3MuJyk7XG4gICAgfVxuXG4gICAgLy8gRmluZCB0aGUgcGF1c2VkIG5vZGUgaW4gdGhlIGdyYXBoXG4gICAgY29uc3QgcGF1c2VkTm9kZSA9IHRoaXMuZmluZE5vZGVJbkdyYXBoKGNoZWNrcG9pbnQucGF1c2VkU3RhZ2VJZCwgY2hlY2twb2ludC5zdWJmbG93UGF0aCk7XG4gICAgaWYgKCFwYXVzZWROb2RlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBDYW5ub3QgcmVzdW1lOiBzdGFnZSAnJHtjaGVja3BvaW50LnBhdXNlZFN0YWdlSWR9JyBub3QgZm91bmQgaW4gZmxvd2NoYXJ0LiBgICtcbiAgICAgICAgICAnVGhlIGNoYXJ0IG1heSBoYXZlIGNoYW5nZWQgc2luY2UgdGhlIGNoZWNrcG9pbnQgd2FzIGNyZWF0ZWQuJyxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmICghcGF1c2VkTm9kZS5yZXN1bWVGbikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQ2Fubm90IHJlc3VtZTogc3RhZ2UgJyR7cGF1c2VkTm9kZS5uYW1lfScgKCR7cGF1c2VkTm9kZS5pZH0pIGhhcyBubyByZXN1bWVGbi4gYCArXG4gICAgICAgICAgJ09ubHkgc3RhZ2VzIGNyZWF0ZWQgd2l0aCBhZGRQYXVzYWJsZUZ1bmN0aW9uKCkgY2FuIGJlIHJlc3VtZWQuJyxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgLy8gQnVpbGQgYSBzeW50aGV0aWMgcmVzdW1lIG5vZGU6IGNhbGxzIHJlc3VtZUZuIHdpdGggcmVzdW1lSW5wdXQsIHRoZW4gY29udGludWVzIHRvIG9yaWdpbmFsIG5leHQuXG4gICAgLy8gcmVzdW1lRm4gc2lnbmF0dXJlIGlzIChzY29wZSwgaW5wdXQpIHBlciBQYXVzYWJsZUhhbmRsZXIg4oCUIHdyYXAgdG8gbWF0Y2ggU3RhZ2VGdW5jdGlvbihzY29wZSwgYnJlYWtGbikuXG4gICAgY29uc3QgcmVzdW1lRm4gPSBwYXVzZWROb2RlLnJlc3VtZUZuO1xuICAgIGNvbnN0IHJlc3VtZVN0YWdlRm4gPSAoc2NvcGU6IFRTY29wZSkgPT4ge1xuICAgICAgcmV0dXJuIHJlc3VtZUZuKHNjb3BlLCByZXN1bWVJbnB1dCk7XG4gICAgfTtcblxuICAgIGNvbnN0IHJlc3VtZU5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+ID0ge1xuICAgICAgbmFtZTogcGF1c2VkTm9kZS5uYW1lLFxuICAgICAgaWQ6IHBhdXNlZE5vZGUuaWQsXG4gICAgICBkZXNjcmlwdGlvbjogcGF1c2VkTm9kZS5kZXNjcmlwdGlvbixcbiAgICAgIGZuOiByZXN1bWVTdGFnZUZuLFxuICAgICAgbmV4dDogcGF1c2VkTm9kZS5uZXh0LFxuICAgIH07XG5cbiAgICAvLyBEb24ndCBjbGVhciByZWNvcmRlcnMg4oCUIHJlc3VtZSBjb250aW51ZXMgZnJvbSBwcmV2aW91cyBzdGF0ZS5cbiAgICAvLyBOYXJyYXRpdmUsIG1ldHJpY3MsIGRlYnVnIGVudHJpZXMgYWNjdW11bGF0ZSBhY3Jvc3MgcGF1c2UvcmVzdW1lLlxuXG4gICAgLy8gUmV1c2UgdGhlIGV4aXN0aW5nIHJ1bnRpbWUgc28gdGhlIGV4ZWN1dGlvbiB0cmVlIGNvbnRpbnVlcyBmcm9tIHRoZSBwYXVzZSBwb2ludC5cbiAgICAvLyBwcmVzZXJ2ZVJlY29yZGVycyBrZWVwcyB0aGUgQ29tYmluZWROYXJyYXRpdmVSZWNvcmRlciBzbyBuYXJyYXRpdmUgYWNjdW11bGF0ZXMuXG4gICAgY29uc3QgZXhpc3RpbmdSdW50aW1lID0gdGhpcy50cmF2ZXJzZXIuZ2V0UnVudGltZSgpIGFzIEluc3RhbmNlVHlwZTx0eXBlb2YgRXhlY3V0aW9uUnVudGltZT47XG4gICAgdGhpcy50cmF2ZXJzZXIgPSB0aGlzLmNyZWF0ZVRyYXZlcnNlcihvcHRpb25zPy5zaWduYWwsIHVuZGVmaW5lZCwgb3B0aW9ucz8uZW52LCBvcHRpb25zPy5tYXhEZXB0aCwge1xuICAgICAgcm9vdDogcmVzdW1lTm9kZSxcbiAgICAgIGluaXRpYWxDb250ZXh0OiBjaGVja3BvaW50LnNoYXJlZFN0YXRlLFxuICAgICAgcHJlc2VydmVSZWNvcmRlcnM6IHRydWUsXG4gICAgICBleGlzdGluZ1J1bnRpbWUsXG4gICAgfSk7XG5cbiAgICAvLyBGaXJlIG9uUmVzdW1lIGV2ZW50IG9uIGFsbCByZWNvcmRlcnMgKGZsb3cgKyBzY29wZSlcbiAgICBjb25zdCBoYXNJbnB1dCA9IHJlc3VtZUlucHV0ICE9PSB1bmRlZmluZWQ7XG4gICAgY29uc3QgZmxvd1Jlc3VtZUV2ZW50ID0ge1xuICAgICAgc3RhZ2VOYW1lOiBwYXVzZWROb2RlLm5hbWUsXG4gICAgICBzdGFnZUlkOiBwYXVzZWROb2RlLmlkLFxuICAgICAgaGFzSW5wdXQsXG4gICAgfTtcbiAgICBpZiAodGhpcy5jb21iaW5lZFJlY29yZGVyKSB0aGlzLmNvbWJpbmVkUmVjb3JkZXIub25SZXN1bWUoZmxvd1Jlc3VtZUV2ZW50KTtcbiAgICBmb3IgKGNvbnN0IHIgb2YgdGhpcy5mbG93UmVjb3JkZXJzKSByLm9uUmVzdW1lPy4oZmxvd1Jlc3VtZUV2ZW50KTtcblxuICAgIGNvbnN0IHNjb3BlUmVzdW1lRXZlbnQgPSB7XG4gICAgICBzdGFnZU5hbWU6IHBhdXNlZE5vZGUubmFtZSxcbiAgICAgIHN0YWdlSWQ6IHBhdXNlZE5vZGUuaWQsXG4gICAgICBoYXNJbnB1dCxcbiAgICAgIHBpcGVsaW5lSWQ6ICcnLFxuICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgIH07XG4gICAgZm9yIChjb25zdCByIG9mIHRoaXMuc2NvcGVSZWNvcmRlcnMpIHIub25SZXN1bWU/LihzY29wZVJlc3VtZUV2ZW50KTtcblxuICAgIHRyeSB7XG4gICAgICByZXR1cm4gYXdhaXQgdGhpcy50cmF2ZXJzZXIuZXhlY3V0ZSgpO1xuICAgIH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG4gICAgICBpZiAoaXNQYXVzZVNpZ25hbChlcnJvcikpIHtcbiAgICAgICAgY29uc3Qgc25hcHNob3QgPSB0aGlzLnRyYXZlcnNlci5nZXRTbmFwc2hvdCgpO1xuICAgICAgICBjb25zdCBzZlJlc3VsdHMgPSB0aGlzLnRyYXZlcnNlci5nZXRTdWJmbG93UmVzdWx0cygpO1xuICAgICAgICB0aGlzLmxhc3RDaGVja3BvaW50ID0ge1xuICAgICAgICAgIHNoYXJlZFN0YXRlOiBzbmFwc2hvdC5zaGFyZWRTdGF0ZSxcbiAgICAgICAgICBleGVjdXRpb25UcmVlOiBzbmFwc2hvdC5leGVjdXRpb25UcmVlLFxuICAgICAgICAgIHBhdXNlZFN0YWdlSWQ6IGVycm9yLnN0YWdlSWQsXG4gICAgICAgICAgc3ViZmxvd1BhdGg6IGVycm9yLnN1YmZsb3dQYXRoLFxuICAgICAgICAgIHBhdXNlRGF0YTogZXJyb3IucGF1c2VEYXRhLFxuICAgICAgICAgIC4uLihzZlJlc3VsdHMuc2l6ZSA+IDAgJiYgeyBzdWJmbG93UmVzdWx0czogT2JqZWN0LmZyb21FbnRyaWVzKHNmUmVzdWx0cykgfSksXG4gICAgICAgICAgcGF1c2VkQXQ6IERhdGUubm93KCksXG4gICAgICAgIH07XG4gICAgICAgIHJldHVybiB7IHBhdXNlZDogdHJ1ZSwgY2hlY2twb2ludDogdGhpcy5sYXN0Q2hlY2twb2ludCB9IHNhdGlzZmllcyBQYXVzZWRSZXN1bHQ7XG4gICAgICB9XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogRmluZCBhIFN0YWdlTm9kZSBpbiB0aGUgY29tcGlsZWQgZ3JhcGggYnkgSUQuXG4gICAqIEhhbmRsZXMgc3ViZmxvdyBwYXRocyBieSBkcmlsbGluZyBpbnRvIHJlZ2lzdGVyZWQgc3ViZmxvd3MuXG4gICAqL1xuICBwcml2YXRlIGZpbmROb2RlSW5HcmFwaChzdGFnZUlkOiBzdHJpbmcsIHN1YmZsb3dQYXRoOiByZWFkb25seSBzdHJpbmdbXSk6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+IHwgdW5kZWZpbmVkIHtcbiAgICBjb25zdCBmYyA9IHRoaXMuZmxvd0NoYXJ0QXJncy5mbG93Q2hhcnQ7XG5cbiAgICBpZiAoc3ViZmxvd1BhdGgubGVuZ3RoID09PSAwKSB7XG4gICAgICAvLyBUb3AtbGV2ZWw6IERGUyBmcm9tIHJvb3RcbiAgICAgIHJldHVybiB0aGlzLmRmc0ZpbmQoZmMucm9vdCwgc3RhZ2VJZCk7XG4gICAgfVxuXG4gICAgLy8gU3ViZmxvdzogZHJpbGwgaW50byB0aGUgc3ViZmxvdyBjaGFpbiwgdGhlbiBzZWFyY2ggZnJvbSB0aGUgbGFzdCBzdWJmbG93J3Mgcm9vdFxuICAgIGxldCBzdWJmbG93Um9vdDogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gfCB1bmRlZmluZWQ7XG4gICAgZm9yIChjb25zdCBzZklkIG9mIHN1YmZsb3dQYXRoKSB7XG4gICAgICBjb25zdCBzdWJmbG93ID0gZmMuc3ViZmxvd3M/LltzZklkXTtcbiAgICAgIGlmICghc3ViZmxvdykgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgIHN1YmZsb3dSb290ID0gc3ViZmxvdy5yb290O1xuICAgIH1cbiAgICBpZiAoIXN1YmZsb3dSb290KSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIHJldHVybiB0aGlzLmRmc0ZpbmQoc3ViZmxvd1Jvb3QsIHN0YWdlSWQpO1xuICB9XG5cbiAgLyoqIERGUyBzZWFyY2ggZm9yIGEgbm9kZSBieSBJRCBpbiB0aGUgU3RhZ2VOb2RlIGdyYXBoLiBDeWNsZS1zYWZlIHZpYSB2aXNpdGVkIHNldC4gKi9cbiAgcHJpdmF0ZSBkZnNGaW5kKFxuICAgIG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+LFxuICAgIHRhcmdldElkOiBzdHJpbmcsXG4gICAgdmlzaXRlZCA9IG5ldyBTZXQ8c3RyaW5nPigpLFxuICApOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiB8IHVuZGVmaW5lZCB7XG4gICAgLy8gU2tpcCBsb29wIGJhY2stZWRnZSByZWZlcmVuY2VzICh0aGV5IHNoYXJlIHRoZSB0YXJnZXQncyBJRCBidXQgaGF2ZSBubyBmbi9yZXN1bWVGbilcbiAgICBpZiAobm9kZS5pc0xvb3BSZWYpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgaWYgKHZpc2l0ZWQuaGFzKG5vZGUuaWQpKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIHZpc2l0ZWQuYWRkKG5vZGUuaWQpO1xuICAgIGlmIChub2RlLmlkID09PSB0YXJnZXRJZCkgcmV0dXJuIG5vZGU7XG4gICAgaWYgKG5vZGUuY2hpbGRyZW4pIHtcbiAgICAgIGZvciAoY29uc3QgY2hpbGQgb2Ygbm9kZS5jaGlsZHJlbikge1xuICAgICAgICBjb25zdCBmb3VuZCA9IHRoaXMuZGZzRmluZChjaGlsZCwgdGFyZ2V0SWQsIHZpc2l0ZWQpO1xuICAgICAgICBpZiAoZm91bmQpIHJldHVybiBmb3VuZDtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKG5vZGUubmV4dCkgcmV0dXJuIHRoaXMuZGZzRmluZChub2RlLm5leHQsIHRhcmdldElkLCB2aXNpdGVkKTtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG5cbiAgLy8g4pSA4pSA4pSAIFJlY29yZGVyIE1hbmFnZW1lbnQg4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIEF0dGFjaCBhIHNjb3BlIFJlY29yZGVyIHRvIG9ic2VydmUgZGF0YSBvcGVyYXRpb25zIChyZWFkcywgd3JpdGVzLCBjb21taXRzKS5cbiAgICogQXV0b21hdGljYWxseSBhdHRhY2hlZCB0byBldmVyeSBTY29wZUZhY2FkZSBjcmVhdGVkIGR1cmluZyB0cmF2ZXJzYWwuXG4gICAqIE11c3QgYmUgY2FsbGVkIGJlZm9yZSBydW4oKS5cbiAgICpcbiAgICogKipJZGVtcG90ZW50IGJ5IElEOioqIElmIGEgcmVjb3JkZXIgd2l0aCB0aGUgc2FtZSBgaWRgIGlzIGFscmVhZHkgYXR0YWNoZWQsXG4gICAqIGl0IGlzIHJlcGxhY2VkIChub3QgZHVwbGljYXRlZCkuIFRoaXMgcHJldmVudHMgZG91YmxlLWNvdW50aW5nIHdoZW4gYm90aFxuICAgKiBhIGZyYW1ld29yayBhbmQgdGhlIHVzZXIgYXR0YWNoIHRoZSBzYW1lIHJlY29yZGVyIHR5cGUuXG4gICAqXG4gICAqIEJ1aWx0LWluIHJlY29yZGVycyB1c2UgYXV0by1pbmNyZW1lbnQgSURzIChgbWV0cmljcy0xYCwgYGRlYnVnLTFgLCAuLi4pIGJ5XG4gICAqIGRlZmF1bHQsIHNvIG11bHRpcGxlIGluc3RhbmNlcyB3aXRoIGRpZmZlcmVudCBjb25maWdzIGNvZXhpc3QuIFRvIG92ZXJyaWRlXG4gICAqIGEgZnJhbWV3b3JrLWF0dGFjaGVkIHJlY29yZGVyLCBwYXNzIHRoZSBzYW1lIHdlbGwta25vd24gSUQuXG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGBgYHR5cGVzY3JpcHRcbiAgICogLy8gTXVsdGlwbGUgcmVjb3JkZXJzIHdpdGggZGlmZmVyZW50IGNvbmZpZ3Mg4oCUIGVhY2ggZ2V0cyBhIHVuaXF1ZSBJRFxuICAgKiBleGVjdXRvci5hdHRhY2hSZWNvcmRlcihuZXcgTWV0cmljUmVjb3JkZXIoKSk7XG4gICAqIGV4ZWN1dG9yLmF0dGFjaFJlY29yZGVyKG5ldyBEZWJ1Z1JlY29yZGVyKHsgdmVyYm9zaXR5OiAnbWluaW1hbCcgfSkpO1xuICAgKlxuICAgKiAvLyBPdmVycmlkZSBhIGZyYW1ld29yay1hdHRhY2hlZCByZWNvcmRlciBieSBwYXNzaW5nIGl0cyB3ZWxsLWtub3duIElEXG4gICAqIGV4ZWN1dG9yLmF0dGFjaFJlY29yZGVyKG5ldyBNZXRyaWNSZWNvcmRlcignbWV0cmljcycpKTtcbiAgICpcbiAgICogLy8gQXR0YWNoaW5nIHR3aWNlIHdpdGggc2FtZSBJRCByZXBsYWNlcyAobm8gZG91YmxlLWNvdW50aW5nKVxuICAgKiBleGVjdXRvci5hdHRhY2hSZWNvcmRlcihuZXcgTWV0cmljUmVjb3JkZXIoJ215LW1ldHJpY3MnKSk7XG4gICAqIGV4ZWN1dG9yLmF0dGFjaFJlY29yZGVyKG5ldyBNZXRyaWNSZWNvcmRlcignbXktbWV0cmljcycpKTsgLy8gcmVwbGFjZXMgcHJldmlvdXNcbiAgICogYGBgXG4gICAqL1xuICBhdHRhY2hSZWNvcmRlcihyZWNvcmRlcjogUmVjb3JkZXIpOiB2b2lkIHtcbiAgICAvLyBSZXBsYWNlIGV4aXN0aW5nIHJlY29yZGVyIHdpdGggc2FtZSBJRCAoaWRlbXBvdGVudCDigJQgcHJldmVudHMgZG91YmxlLWNvdW50aW5nKVxuICAgIHRoaXMuc2NvcGVSZWNvcmRlcnMgPSB0aGlzLnNjb3BlUmVjb3JkZXJzLmZpbHRlcigocikgPT4gci5pZCAhPT0gcmVjb3JkZXIuaWQpO1xuICAgIHRoaXMuc2NvcGVSZWNvcmRlcnMucHVzaChyZWNvcmRlcik7XG4gIH1cblxuICAvKiogRGV0YWNoIGFsbCBzY29wZSBSZWNvcmRlcnMgd2l0aCB0aGUgZ2l2ZW4gSUQuICovXG4gIGRldGFjaFJlY29yZGVyKGlkOiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLnNjb3BlUmVjb3JkZXJzID0gdGhpcy5zY29wZVJlY29yZGVycy5maWx0ZXIoKHIpID0+IHIuaWQgIT09IGlkKTtcbiAgfVxuXG4gIC8qKiBSZXR1cm5zIGEgZGVmZW5zaXZlIGNvcHkgb2YgYXR0YWNoZWQgc2NvcGUgUmVjb3JkZXJzLiAqL1xuICBnZXRSZWNvcmRlcnMoKTogUmVjb3JkZXJbXSB7XG4gICAgcmV0dXJuIFsuLi50aGlzLnNjb3BlUmVjb3JkZXJzXTtcbiAgfVxuXG4gIC8vIOKUgOKUgOKUgCBGbG93UmVjb3JkZXIgTWFuYWdlbWVudCDilIDilIDilIBcblxuICAvKipcbiAgICogQXR0YWNoIGEgRmxvd1JlY29yZGVyIHRvIG9ic2VydmUgY29udHJvbCBmbG93IGV2ZW50cy5cbiAgICogQXV0b21hdGljYWxseSBlbmFibGVzIG5hcnJhdGl2ZSBpZiBub3QgYWxyZWFkeSBlbmFibGVkLlxuICAgKiBNdXN0IGJlIGNhbGxlZCBiZWZvcmUgcnVuKCkg4oCUIHJlY29yZGVycyBhcmUgcGFzc2VkIHRvIHRoZSB0cmF2ZXJzZXIgYXQgY3JlYXRpb24gdGltZS5cbiAgICpcbiAgICogKipJZGVtcG90ZW50IGJ5IElEOioqIHJlcGxhY2VzIGV4aXN0aW5nIHJlY29yZGVyIHdpdGggc2FtZSBgaWRgLlxuICAgKi9cbiAgYXR0YWNoRmxvd1JlY29yZGVyKHJlY29yZGVyOiBGbG93UmVjb3JkZXIpOiB2b2lkIHtcbiAgICAvLyBSZXBsYWNlIGV4aXN0aW5nIHJlY29yZGVyIHdpdGggc2FtZSBJRCAoaWRlbXBvdGVudCDigJQgcHJldmVudHMgZG91YmxlLWNvdW50aW5nKVxuICAgIHRoaXMuZmxvd1JlY29yZGVycyA9IHRoaXMuZmxvd1JlY29yZGVycy5maWx0ZXIoKHIpID0+IHIuaWQgIT09IHJlY29yZGVyLmlkKTtcbiAgICB0aGlzLmZsb3dSZWNvcmRlcnMucHVzaChyZWNvcmRlcik7XG4gICAgdGhpcy5uYXJyYXRpdmVFbmFibGVkID0gdHJ1ZTtcbiAgfVxuXG4gIC8qKiBEZXRhY2ggYWxsIEZsb3dSZWNvcmRlcnMgd2l0aCB0aGUgZ2l2ZW4gSUQuICovXG4gIGRldGFjaEZsb3dSZWNvcmRlcihpZDogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5mbG93UmVjb3JkZXJzID0gdGhpcy5mbG93UmVjb3JkZXJzLmZpbHRlcigocikgPT4gci5pZCAhPT0gaWQpO1xuICB9XG5cbiAgLyoqIFJldHVybnMgYSBkZWZlbnNpdmUgY29weSBvZiBhdHRhY2hlZCBGbG93UmVjb3JkZXJzLiAqL1xuICBnZXRGbG93UmVjb3JkZXJzKCk6IEZsb3dSZWNvcmRlcltdIHtcbiAgICByZXR1cm4gWy4uLnRoaXMuZmxvd1JlY29yZGVyc107XG4gIH1cblxuICAvKipcbiAgICogUmV0dXJucyB0aGUgZXhlY3V0aW9uIG5hcnJhdGl2ZS5cbiAgICpcbiAgICogV2hlbiB1c2luZyBTY29wZUZhY2FkZS1iYXNlZCBzY29wZXMsIHJldHVybnMgYSBjb21iaW5lZCBuYXJyYXRpdmUgdGhhdFxuICAgKiBpbnRlcmxlYXZlcyBmbG93IGV2ZW50cyAoc3RhZ2VzLCBkZWNpc2lvbnMsIGZvcmtzKSB3aXRoIGRhdGEgb3BlcmF0aW9uc1xuICAgKiAocmVhZHMsIHdyaXRlcywgdXBkYXRlcykuIEZvciBwbGFpbiBzY29wZXMgd2l0aG91dCBhdHRhY2hSZWNvcmRlciBzdXBwb3J0LFxuICAgKiByZXR1cm5zIGZsb3ctb25seSBuYXJyYXRpdmUgc2VudGVuY2VzLlxuICAgKi9cbiAgZ2V0TmFycmF0aXZlKCk6IHN0cmluZ1tdIHtcbiAgICAvLyBDb21iaW5lZCByZWNvcmRlciBidWlsZHMgdGhlIG5hcnJhdGl2ZSBpbmxpbmUgZHVyaW5nIHRyYXZlcnNhbCDigJQganVzdCByZWFkIGl0XG4gICAgaWYgKHRoaXMuY29tYmluZWRSZWNvcmRlcikge1xuICAgICAgcmV0dXJuIHRoaXMuY29tYmluZWRSZWNvcmRlci5nZXROYXJyYXRpdmUoKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMudHJhdmVyc2VyLmdldE5hcnJhdGl2ZSgpO1xuICB9XG5cbiAgLyoqXG4gICAqIFJldHVybnMgc3RydWN0dXJlZCBuYXJyYXRpdmUgZW50cmllcyBmb3IgcHJvZ3JhbW1hdGljIGNvbnN1bXB0aW9uLlxuICAgKiBFYWNoIGVudHJ5IGhhcyBhIHR5cGUgKHN0YWdlLCBzdGVwLCBjb25kaXRpb24sIGZvcmssIGV0Yy4pLCB0ZXh0LCBhbmQgZGVwdGguXG4gICAqL1xuICBnZXROYXJyYXRpdmVFbnRyaWVzKCk6IENvbWJpbmVkTmFycmF0aXZlRW50cnlbXSB7XG4gICAgaWYgKHRoaXMuY29tYmluZWRSZWNvcmRlcikge1xuICAgICAgcmV0dXJuIHRoaXMuY29tYmluZWRSZWNvcmRlci5nZXRFbnRyaWVzKCk7XG4gICAgfVxuICAgIGNvbnN0IGZsb3dTZW50ZW5jZXMgPSB0aGlzLnRyYXZlcnNlci5nZXROYXJyYXRpdmUoKTtcbiAgICByZXR1cm4gZmxvd1NlbnRlbmNlcy5tYXAoKHRleHQpID0+ICh7IHR5cGU6ICdzdGFnZScgYXMgY29uc3QsIHRleHQsIGRlcHRoOiAwIH0pKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXR1cm5zIHRoZSBjb21iaW5lZCBGbG93UmVjb3JkZXJzIGxpc3QuIFdoZW4gbmFycmF0aXZlIGlzIGVuYWJsZWQsIGluY2x1ZGVzOlxuICAgKiAtIENvbWJpbmVkTmFycmF0aXZlUmVjb3JkZXIgKGJ1aWxkcyBtZXJnZWQgZmxvdytkYXRhIG5hcnJhdGl2ZSBpbmxpbmUpXG4gICAqIC0gTmFycmF0aXZlRmxvd1JlY29yZGVyIChrZWVwcyBmbG93LW9ubHkgc2VudGVuY2VzIGZvciBnZXRGbG93TmFycmF0aXZlKCkpXG4gICAqIFBsdXMgYW55IHVzZXItYXR0YWNoZWQgcmVjb3JkZXJzLlxuICAgKi9cbiAgcHJpdmF0ZSBidWlsZEZsb3dSZWNvcmRlcnNMaXN0KCk6IEZsb3dSZWNvcmRlcltdIHwgdW5kZWZpbmVkIHtcbiAgICBjb25zdCByZWNvcmRlcnM6IEZsb3dSZWNvcmRlcltdID0gW107XG4gICAgaWYgKHRoaXMuY29tYmluZWRSZWNvcmRlcikge1xuICAgICAgcmVjb3JkZXJzLnB1c2godGhpcy5jb21iaW5lZFJlY29yZGVyKTtcbiAgICAgIC8vIEtlZXAgdGhlIGRlZmF1bHQgTmFycmF0aXZlRmxvd1JlY29yZGVyIHNvIGdldEZsb3dOYXJyYXRpdmUoKSBzdGlsbCB3b3Jrc1xuICAgICAgcmVjb3JkZXJzLnB1c2gobmV3IE5hcnJhdGl2ZUZsb3dSZWNvcmRlcigpKTtcbiAgICB9XG4gICAgcmVjb3JkZXJzLnB1c2goLi4udGhpcy5mbG93UmVjb3JkZXJzKTtcbiAgICByZXR1cm4gcmVjb3JkZXJzLmxlbmd0aCA+IDAgPyByZWNvcmRlcnMgOiB1bmRlZmluZWQ7XG4gIH1cblxuICAvKipcbiAgICogUmV0dXJucyBmbG93LW9ubHkgbmFycmF0aXZlIHNlbnRlbmNlcyAod2l0aG91dCBkYXRhIG9wZXJhdGlvbnMpLlxuICAgKiBVc2UgdGhpcyB3aGVuIHlvdSBvbmx5IHdhbnQgY29udHJvbCBmbG93IGRlc2NyaXB0aW9ucy5cbiAgICpcbiAgICogU2VudGVuY2VzIGNvbWUgZnJvbSBgTmFycmF0aXZlRmxvd1JlY29yZGVyYCAoYSBkZWRpY2F0ZWQgZmxvdy1vbmx5IHJlY29yZGVyIGF1dG9tYXRpY2FsbHlcbiAgICogYXR0YWNoZWQgd2hlbiBuYXJyYXRpdmUgaXMgZW5hYmxlZCkuIEl0IGVtaXRzIGJvdGggYG9uU3RhZ2VFeGVjdXRlZGAgc2VudGVuY2VzIChvbmUgcGVyXG4gICAqIHN0YWdlKSBBTkQgYG9uTmV4dGAgdHJhbnNpdGlvbiBzZW50ZW5jZXMgKG9uZSBwZXIgc3RhZ2UtdG8tc3RhZ2UgdHJhbnNpdGlvbiksIHNvIGZvciBhXG4gICAqIGNoYXJ0IHdpdGggTiBzdGFnZXMgeW91IHdpbGwgdHlwaWNhbGx5IGdldCBtb3JlIGVudHJpZXMgaGVyZSB0aGFuIGZyb20gYGdldE5hcnJhdGl2ZSgpYC5cbiAgICovXG4gIGdldEZsb3dOYXJyYXRpdmUoKTogc3RyaW5nW10ge1xuICAgIHJldHVybiB0aGlzLnRyYXZlcnNlci5nZXROYXJyYXRpdmUoKTtcbiAgfVxuXG4gIGFzeW5jIHJ1bihvcHRpb25zPzogUnVuT3B0aW9ucyk6IFByb21pc2U8RXhlY3V0b3JSZXN1bHQ+IHtcbiAgICBsZXQgc2lnbmFsID0gb3B0aW9ucz8uc2lnbmFsO1xuICAgIGxldCB0aW1lb3V0SWQ6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkO1xuXG4gICAgLy8gQ3JlYXRlIGFuIGludGVybmFsIEFib3J0Q29udHJvbGxlciBmb3IgdGltZW91dE1zXG4gICAgaWYgKG9wdGlvbnM/LnRpbWVvdXRNcyAmJiAhc2lnbmFsKSB7XG4gICAgICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgc2lnbmFsID0gY29udHJvbGxlci5zaWduYWw7XG4gICAgICB0aW1lb3V0SWQgPSBzZXRUaW1lb3V0KFxuICAgICAgICAoKSA9PiBjb250cm9sbGVyLmFib3J0KG5ldyBFcnJvcihgRXhlY3V0aW9uIHRpbWVkIG91dCBhZnRlciAke29wdGlvbnMudGltZW91dE1zfW1zYCkpLFxuICAgICAgICBvcHRpb25zLnRpbWVvdXRNcyxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgLy8gVmFsaWRhdGUgaW5wdXQgYWdhaW5zdCBpbnB1dFNjaGVtYSBpZiBib3RoIGFyZSBwcmVzZW50XG4gICAgbGV0IHZhbGlkYXRlZElucHV0ID0gb3B0aW9ucz8uaW5wdXQ7XG4gICAgaWYgKHZhbGlkYXRlZElucHV0ICYmIHRoaXMuZmxvd0NoYXJ0QXJncy5mbG93Q2hhcnQuaW5wdXRTY2hlbWEpIHtcbiAgICAgIHZhbGlkYXRlZElucHV0ID0gdmFsaWRhdGVJbnB1dCh0aGlzLmZsb3dDaGFydEFyZ3MuZmxvd0NoYXJ0LmlucHV0U2NoZW1hLCB2YWxpZGF0ZWRJbnB1dCk7XG4gICAgfVxuXG4gICAgLy8gVXNlci1hdHRhY2hlZCByZWNvcmRlcnMgKGZsb3dSZWNvcmRlcnMgKyBzY29wZVJlY29yZGVycykgYXJlIGNsZWFyZWQgdmlhIGNsZWFyKCkgdG8gcHJldmVudFxuICAgIC8vIGNyb3NzLXJ1biBhY2N1bXVsYXRpb24uIFRoZSBjb21iaW5lZFJlY29yZGVyIGlzIE5PVCBjbGVhcmVkIGhlcmUg4oCUIGNyZWF0ZVRyYXZlcnNlcigpIGFsd2F5c1xuICAgIC8vIGNyZWF0ZXMgYSBmcmVzaCBDb21iaW5lZE5hcnJhdGl2ZVJlY29yZGVyIGluc3RhbmNlIG9uIGVhY2ggcnVuLCBzbyBzdGFsZSBzdGF0ZSBpcyBuZXZlciBhbiBpc3N1ZS5cbiAgICBmb3IgKGNvbnN0IHIgb2YgdGhpcy5mbG93UmVjb3JkZXJzKSB7XG4gICAgICByLmNsZWFyPy4oKTtcbiAgICB9XG4gICAgZm9yIChjb25zdCByIG9mIHRoaXMuc2NvcGVSZWNvcmRlcnMpIHtcbiAgICAgIHIuY2xlYXI/LigpO1xuICAgIH1cblxuICAgIHRoaXMubGFzdENoZWNrcG9pbnQgPSB1bmRlZmluZWQ7XG4gICAgdGhpcy50cmF2ZXJzZXIgPSB0aGlzLmNyZWF0ZVRyYXZlcnNlcihzaWduYWwsIHZhbGlkYXRlZElucHV0LCBvcHRpb25zPy5lbnYsIG9wdGlvbnM/Lm1heERlcHRoKTtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIGF3YWl0IHRoaXMudHJhdmVyc2VyLmV4ZWN1dGUoKTtcbiAgICB9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuICAgICAgaWYgKGlzUGF1c2VTaWduYWwoZXJyb3IpKSB7XG4gICAgICAgIC8vIEJ1aWxkIGNoZWNrcG9pbnQgZnJvbSBjdXJyZW50IGV4ZWN1dGlvbiBzdGF0ZVxuICAgICAgICBjb25zdCBzbmFwc2hvdCA9IHRoaXMudHJhdmVyc2VyLmdldFNuYXBzaG90KCk7XG4gICAgICAgIGNvbnN0IHNmUmVzdWx0cyA9IHRoaXMudHJhdmVyc2VyLmdldFN1YmZsb3dSZXN1bHRzKCk7XG4gICAgICAgIHRoaXMubGFzdENoZWNrcG9pbnQgPSB7XG4gICAgICAgICAgc2hhcmVkU3RhdGU6IHNuYXBzaG90LnNoYXJlZFN0YXRlLFxuICAgICAgICAgIGV4ZWN1dGlvblRyZWU6IHNuYXBzaG90LmV4ZWN1dGlvblRyZWUsXG4gICAgICAgICAgcGF1c2VkU3RhZ2VJZDogZXJyb3Iuc3RhZ2VJZCxcbiAgICAgICAgICBzdWJmbG93UGF0aDogZXJyb3Iuc3ViZmxvd1BhdGgsXG4gICAgICAgICAgcGF1c2VEYXRhOiBlcnJvci5wYXVzZURhdGEsXG4gICAgICAgICAgLi4uKHNmUmVzdWx0cy5zaXplID4gMCAmJiB7IHN1YmZsb3dSZXN1bHRzOiBPYmplY3QuZnJvbUVudHJpZXMoc2ZSZXN1bHRzKSB9KSxcbiAgICAgICAgICBwYXVzZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgICAgfTtcbiAgICAgICAgLy8gUmV0dXJuIGEgUGF1c2VSZXN1bHQtc2hhcGVkIHZhbHVlIHNvIGNhbGxlcnMgY2FuIGNoZWNrIHdpdGhvdXQgdHJ5L2NhdGNoXG4gICAgICAgIHJldHVybiB7IHBhdXNlZDogdHJ1ZSwgY2hlY2twb2ludDogdGhpcy5sYXN0Q2hlY2twb2ludCB9IHNhdGlzZmllcyBQYXVzZWRSZXN1bHQ7XG4gICAgICB9XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgaWYgKHRpbWVvdXRJZCAhPT0gdW5kZWZpbmVkKSBjbGVhclRpbWVvdXQodGltZW91dElkKTtcbiAgICB9XG4gIH1cblxuICAvLyDilIDilIDilIAgSW50cm9zcGVjdGlvbiDilIDilIDilIBcblxuICBnZXRTbmFwc2hvdCgpOiBSdW50aW1lU25hcHNob3Qge1xuICAgIGNvbnN0IHNuYXBzaG90ID0gdGhpcy50cmF2ZXJzZXIuZ2V0U25hcHNob3QoKSBhcyBSdW50aW1lU25hcHNob3Q7XG4gICAgY29uc3Qgc2ZSZXN1bHRzID0gdGhpcy50cmF2ZXJzZXIuZ2V0U3ViZmxvd1Jlc3VsdHMoKTtcbiAgICBpZiAoc2ZSZXN1bHRzLnNpemUgPiAwKSB7XG4gICAgICBzbmFwc2hvdC5zdWJmbG93UmVzdWx0cyA9IE9iamVjdC5mcm9tRW50cmllcyhzZlJlc3VsdHMpO1xuICAgIH1cblxuICAgIC8vIENvbGxlY3Qgc25hcHNob3QgZGF0YSBmcm9tIHJlY29yZGVycyB0aGF0IGltcGxlbWVudCB0b1NuYXBzaG90KClcbiAgICBjb25zdCByZWNvcmRlclNuYXBzaG90czogUmVjb3JkZXJTbmFwc2hvdFtdID0gW107XG4gICAgZm9yIChjb25zdCByIG9mIHRoaXMuc2NvcGVSZWNvcmRlcnMpIHtcbiAgICAgIGlmIChyLnRvU25hcHNob3QpIHtcbiAgICAgICAgY29uc3QgeyBuYW1lLCBkYXRhIH0gPSByLnRvU25hcHNob3QoKTtcbiAgICAgICAgcmVjb3JkZXJTbmFwc2hvdHMucHVzaCh7IGlkOiByLmlkLCBuYW1lLCBkYXRhIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICBmb3IgKGNvbnN0IHIgb2YgdGhpcy5mbG93UmVjb3JkZXJzKSB7XG4gICAgICBpZiAoci50b1NuYXBzaG90KSB7XG4gICAgICAgIGNvbnN0IHsgbmFtZSwgZGF0YSB9ID0gci50b1NuYXBzaG90KCk7XG4gICAgICAgIHJlY29yZGVyU25hcHNob3RzLnB1c2goeyBpZDogci5pZCwgbmFtZSwgZGF0YSB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHJlY29yZGVyU25hcHNob3RzLmxlbmd0aCA+IDApIHtcbiAgICAgIHNuYXBzaG90LnJlY29yZGVycyA9IHJlY29yZGVyU25hcHNob3RzO1xuICAgIH1cblxuICAgIHJldHVybiBzbmFwc2hvdDtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgZ2V0UnVudGltZSgpIHtcbiAgICByZXR1cm4gdGhpcy50cmF2ZXJzZXIuZ2V0UnVudGltZSgpO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBzZXRSb290T2JqZWN0KHBhdGg6IHN0cmluZ1tdLCBrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24pOiB2b2lkIHtcbiAgICB0aGlzLnRyYXZlcnNlci5zZXRSb290T2JqZWN0KHBhdGgsIGtleSwgdmFsdWUpO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBnZXRCcmFuY2hJZHMoKSB7XG4gICAgcmV0dXJuIHRoaXMudHJhdmVyc2VyLmdldEJyYW5jaElkcygpO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBnZXRSdW50aW1lUm9vdCgpOiBTdGFnZU5vZGUge1xuICAgIHJldHVybiB0aGlzLnRyYXZlcnNlci5nZXRSdW50aW1lUm9vdCgpO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBnZXRSdW50aW1lU3RydWN0dXJlKCk6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMudHJhdmVyc2VyLmdldFJ1bnRpbWVTdHJ1Y3R1cmUoKTtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgZ2V0U3ViZmxvd1Jlc3VsdHMoKTogTWFwPHN0cmluZywgU3ViZmxvd1Jlc3VsdD4ge1xuICAgIHJldHVybiB0aGlzLnRyYXZlcnNlci5nZXRTdWJmbG93UmVzdWx0cygpO1xuICB9XG5cbiAgLyoqIEBpbnRlcm5hbCAqL1xuICBnZXRFeHRyYWN0ZWRSZXN1bHRzPFRSZXN1bHQgPSB1bmtub3duPigpOiBNYXA8c3RyaW5nLCBUUmVzdWx0PiB7XG4gICAgcmV0dXJuIHRoaXMudHJhdmVyc2VyLmdldEV4dHJhY3RlZFJlc3VsdHM8VFJlc3VsdD4oKTtcbiAgfVxuXG4gIC8qKiBAaW50ZXJuYWwgKi9cbiAgZ2V0RXh0cmFjdG9yRXJyb3JzKCk6IEV4dHJhY3RvckVycm9yW10ge1xuICAgIHJldHVybiB0aGlzLnRyYXZlcnNlci5nZXRFeHRyYWN0b3JFcnJvcnMoKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXR1cm5zIHRoZSBzdWJmbG93IG1hbmlmZXN0IGZyb20gYW4gYXR0YWNoZWQgTWFuaWZlc3RGbG93UmVjb3JkZXIuXG4gICAqIFJldHVybnMgZW1wdHkgYXJyYXkgaWYgbm8gTWFuaWZlc3RGbG93UmVjb3JkZXIgaXMgYXR0YWNoZWQuXG4gICAqL1xuICBnZXRTdWJmbG93TWFuaWZlc3QoKTogTWFuaWZlc3RFbnRyeVtdIHtcbiAgICBjb25zdCByZWNvcmRlciA9IHRoaXMuZmxvd1JlY29yZGVycy5maW5kKChyKSA9PiByIGluc3RhbmNlb2YgTWFuaWZlc3RGbG93UmVjb3JkZXIpIGFzXG4gICAgICB8IE1hbmlmZXN0Rmxvd1JlY29yZGVyXG4gICAgICB8IHVuZGVmaW5lZDtcbiAgICByZXR1cm4gcmVjb3JkZXI/LmdldE1hbmlmZXN0KCkgPz8gW107XG4gIH1cblxuICAvKipcbiAgICogUmV0dXJucyB0aGUgZnVsbCBzcGVjIGZvciBhIGR5bmFtaWNhbGx5LXJlZ2lzdGVyZWQgc3ViZmxvdy5cbiAgICogUmVxdWlyZXMgYW4gYXR0YWNoZWQgTWFuaWZlc3RGbG93UmVjb3JkZXIgdGhhdCBvYnNlcnZlZCB0aGUgcmVnaXN0cmF0aW9uLlxuICAgKi9cbiAgZ2V0U3ViZmxvd1NwZWMoc3ViZmxvd0lkOiBzdHJpbmcpOiB1bmtub3duIHwgdW5kZWZpbmVkIHtcbiAgICBjb25zdCByZWNvcmRlciA9IHRoaXMuZmxvd1JlY29yZGVycy5maW5kKChyKSA9PiByIGluc3RhbmNlb2YgTWFuaWZlc3RGbG93UmVjb3JkZXIpIGFzXG4gICAgICB8IE1hbmlmZXN0Rmxvd1JlY29yZGVyXG4gICAgICB8IHVuZGVmaW5lZDtcbiAgICByZXR1cm4gcmVjb3JkZXI/LmdldFNwZWMoc3ViZmxvd0lkKTtcbiAgfVxufVxuIl19