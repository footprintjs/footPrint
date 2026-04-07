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
import type { CombinedNarrativeRecorderOptions } from '../engine/narrative/CombinedNarrativeRecorder.js';
import type { CombinedNarrativeEntry } from '../engine/narrative/narrativeTypes.js';
import type { ManifestEntry } from '../engine/narrative/recorders/ManifestFlowRecorder.js';
import type { FlowRecorder } from '../engine/narrative/types.js';
import { type ExecutorResult, type ExtractorError, type FlowChart, type RunOptions, type ScopeFactory, type SerializedPipelineStructure, type StageNode, type StreamHandlers, type SubflowResult } from '../engine/types.js';
import type { FlowchartCheckpoint } from '../pause/types.js';
import type { ScopeProtectionMode } from '../scope/protection/types.js';
import type { Recorder, RedactionPolicy, RedactionReport } from '../scope/types.js';
import { type RuntimeSnapshot } from './ExecutionRuntime.js';
/**
 * Options object for `FlowChartExecutor` — preferred over positional params.
 *
 * ```typescript
 * const ex = new FlowChartExecutor(chart, {
 *   scopeFactory: myFactory,
 *   enrichSnapshots: true,
 * });
 * ```
 *
 * **Sync note for maintainers:** Every field added here must also appear in the
 * `flowChartArgs` private field type and in the constructor's options-resolution
 * block (the `else if` branch that reads from `opts`). Missing any one of the
 * three causes silent omission — the option is accepted but never applied.
 *
 * **TScope inference note:** When using the options-object form with a custom scope,
 * TypeScript cannot infer `TScope` through the options object. Pass the type
 * explicitly: `new FlowChartExecutor<TOut, MyScope>(chart, { scopeFactory })`.
 */
export interface FlowChartExecutorOptions<TScope = any> {
    /** Custom scope factory. Defaults to TypedScope or ScopeFacade auto-detection. */
    scopeFactory?: ScopeFactory<TScope>;
    /**
     * Attach a per-stage scope snapshot to each extractor result. When `true`, the
     * extraction callback receives the full shared state at the point that stage
     * committed — useful for debugging multi-stage state transitions. Defaults to
     * `false` (no scope snapshot attached). Can also be set on the chart via
     * `flowChart(...).enrichSnapshots(true)`.
     */
    enrichSnapshots?: boolean;
    /**
     * Default values pre-populated into the shared context before **each** stage
     * (re-applied every stage, acting as baseline defaults).
     */
    defaultValuesForContext?: unknown;
    /**
     * Initial context values merged into the shared context **once** at startup
     * (applied before the first stage, not repeated on subsequent stages).
     * Distinct from `defaultValuesForContext`, which is re-applied every stage.
     */
    initialContext?: unknown;
    /** Read-only input accessible via `scope.getArgs()` — never tracked or written. */
    readOnlyContext?: unknown;
    /**
     * Custom error classifier for throttling detection. Return `true` if the
     * error represents a rate-limit or backpressure condition (the executor will
     * treat it differently from hard failures). Defaults to no throttling classification.
     */
    throttlingErrorChecker?: (error: unknown) => boolean;
    /** Handlers for streaming stage lifecycle events (see `addStreamingFunction`). */
    streamHandlers?: StreamHandlers;
    /** Scope protection mode for TypedScope direct-assignment detection. */
    scopeProtectionMode?: ScopeProtectionMode;
}
export declare class FlowChartExecutor<TOut = any, TScope = any> {
    private traverser;
    private narrativeEnabled;
    private narrativeOptions?;
    private combinedRecorder;
    private flowRecorders;
    private scopeRecorders;
    private redactionPolicy;
    private sharedRedactedKeys;
    private sharedRedactedFieldsByKey;
    private lastCheckpoint;
    private readonly flowChartArgs;
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
    constructor(flowChart: FlowChart<TOut, TScope>, factoryOrOptions?: ScopeFactory<TScope> | FlowChartExecutorOptions<TScope>);
    private createTraverser;
    enableNarrative(options?: CombinedNarrativeRecorderOptions): void;
    /**
     * Set a declarative redaction policy that applies to all stages.
     * Must be called before run().
     */
    setRedactionPolicy(policy: RedactionPolicy): void;
    /**
     * Returns a compliance-friendly report of all redaction activity from the
     * most recent run. Never includes actual values.
     */
    getRedactionReport(): RedactionReport;
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
    getCheckpoint(): FlowchartCheckpoint | undefined;
    /** Returns `true` if the most recent run() was paused (checkpoint available). */
    isPaused(): boolean;
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
    resume(checkpoint: FlowchartCheckpoint, resumeInput?: unknown, options?: Pick<RunOptions, 'signal' | 'env' | 'maxDepth'>): Promise<ExecutorResult>;
    /**
     * Find a StageNode in the compiled graph by ID.
     * Handles subflow paths by drilling into registered subflows.
     */
    private findNodeInGraph;
    /** DFS search for a node by ID in the StageNode graph. Cycle-safe via visited set. */
    private dfsFind;
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
    attachRecorder(recorder: Recorder): void;
    /** Detach all scope Recorders with the given ID. */
    detachRecorder(id: string): void;
    /** Returns a defensive copy of attached scope Recorders. */
    getRecorders(): Recorder[];
    /**
     * Attach a FlowRecorder to observe control flow events.
     * Automatically enables narrative if not already enabled.
     * Must be called before run() — recorders are passed to the traverser at creation time.
     *
     * **Idempotent by ID:** replaces existing recorder with same `id`.
     */
    attachFlowRecorder(recorder: FlowRecorder): void;
    /** Detach all FlowRecorders with the given ID. */
    detachFlowRecorder(id: string): void;
    /** Returns a defensive copy of attached FlowRecorders. */
    getFlowRecorders(): FlowRecorder[];
    /**
     * Returns the execution narrative.
     *
     * When using ScopeFacade-based scopes, returns a combined narrative that
     * interleaves flow events (stages, decisions, forks) with data operations
     * (reads, writes, updates). For plain scopes without attachRecorder support,
     * returns flow-only narrative sentences.
     */
    getNarrative(): string[];
    /**
     * Returns structured narrative entries for programmatic consumption.
     * Each entry has a type (stage, step, condition, fork, etc.), text, and depth.
     */
    getNarrativeEntries(): CombinedNarrativeEntry[];
    /**
     * Returns the combined FlowRecorders list. When narrative is enabled, includes:
     * - CombinedNarrativeRecorder (builds merged flow+data narrative inline)
     * - NarrativeFlowRecorder (keeps flow-only sentences for getFlowNarrative())
     * Plus any user-attached recorders.
     */
    private buildFlowRecordersList;
    /**
     * Returns flow-only narrative sentences (without data operations).
     * Use this when you only want control flow descriptions.
     *
     * Sentences come from `NarrativeFlowRecorder` (a dedicated flow-only recorder automatically
     * attached when narrative is enabled). It emits both `onStageExecuted` sentences (one per
     * stage) AND `onNext` transition sentences (one per stage-to-stage transition), so for a
     * chart with N stages you will typically get more entries here than from `getNarrative()`.
     */
    getFlowNarrative(): string[];
    run(options?: RunOptions): Promise<ExecutorResult>;
    getSnapshot(): RuntimeSnapshot;
    /** @internal */
    getRuntime(): import("../engine/types.js").IExecutionRuntime;
    /** @internal */
    setRootObject(path: string[], key: string, value: unknown): void;
    /** @internal */
    getBranchIds(): string[];
    /** @internal */
    getRuntimeRoot(): StageNode;
    /** @internal */
    getRuntimeStructure(): SerializedPipelineStructure | undefined;
    /** @internal */
    getSubflowResults(): Map<string, SubflowResult>;
    /** @internal */
    getExtractedResults<TResult = unknown>(): Map<string, TResult>;
    /** @internal */
    getExtractorErrors(): ExtractorError[];
    /**
     * Returns the subflow manifest from an attached ManifestFlowRecorder.
     * Returns empty array if no ManifestFlowRecorder is attached.
     */
    getSubflowManifest(): ManifestEntry[];
    /**
     * Returns the full spec for a dynamically-registered subflow.
     * Requires an attached ManifestFlowRecorder that observed the registration.
     */
    getSubflowSpec(subflowId: string): unknown | undefined;
}
