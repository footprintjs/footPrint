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
import { CombinedNarrativeRecorder } from '../engine/narrative/CombinedNarrativeRecorder.js';
import { NarrativeFlowRecorder } from '../engine/narrative/NarrativeFlowRecorder.js';
import type { CombinedNarrativeEntry } from '../engine/narrative/narrativeTypes.js';
import type { ManifestEntry } from '../engine/narrative/recorders/ManifestFlowRecorder.js';
import { ManifestFlowRecorder } from '../engine/narrative/recorders/ManifestFlowRecorder.js';
import type { FlowRecorder } from '../engine/narrative/types.js';
import { buildRuntimeStageId } from '../engine/runtimeStageId.js';
import { FlowchartTraverser } from '../engine/traversal/FlowchartTraverser.js';
import {
  type ExecutorResult,
  type ExtractorError,
  type FlowChart,
  type PausedResult,
  type RunOptions,
  type ScopeFactory,
  type SerializedPipelineStructure,
  type StageNode,
  type StreamHandlers,
  type SubflowResult,
  type TraversalResult,
  defaultLogger,
} from '../engine/types.js';
import type { FlowchartCheckpoint } from '../pause/types.js';
import { isPauseSignal } from '../pause/types.js';
import type { CombinedRecorder } from '../recorder/CombinedRecorder.js';
import { hasEmitRecorderMethods, hasFlowRecorderMethods, hasRecorderMethods } from '../recorder/CombinedRecorder.js';
import type { EmitRecorder } from '../recorder/EmitRecorder.js';
import { isDevMode } from '../scope/detectCircular.js';
import type { ScopeProtectionMode } from '../scope/protection/types.js';
import { ScopeFacade } from '../scope/ScopeFacade.js';
import type { Recorder, RedactionPolicy, RedactionReport } from '../scope/types.js';
import { type RecorderSnapshot, type RuntimeSnapshot, ExecutionRuntime } from './ExecutionRuntime.js';
import { validateInput } from './validateInput.js';

/** Default scope factory — creates a plain ScopeFacade for each stage. */
const defaultScopeFactory: ScopeFactory = (ctx, stageName, readOnly, env) =>
  new ScopeFacade(ctx, stageName, readOnly, env);

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
  // ── Common options (most callers need only these) ────────────────────────

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

  // ── Context options ──────────────────────────────────────────────────────

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

  // ── Advanced / escape-hatch options (most callers do not need these) ─────

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

export class FlowChartExecutor<TOut = any, TScope = any> {
  private traverser: FlowchartTraverser<TOut, TScope>;
  /** Shared execution counter — survives pause/resume. Reset on fresh run(). */
  private _executionCounter = { value: 0 };
  private narrativeEnabled = false;
  private narrativeOptions?: CombinedNarrativeRecorderOptions;
  private combinedRecorder: CombinedNarrativeRecorder | undefined;
  private flowRecorders: FlowRecorder[] = [];
  private scopeRecorders: Recorder[] = [];
  private redactionPolicy: RedactionPolicy | undefined;
  private sharedRedactedKeys = new Set<string>();
  private sharedRedactedFieldsByKey = new Map<string, Set<string>>();
  private lastCheckpoint: FlowchartCheckpoint | undefined;

  // SYNC REQUIRED: every optional field here must mirror FlowChartExecutorOptions
  // AND be assigned in the constructor's options-resolution block (the `else if` branch).
  // Adding a field to only one of the three places causes silent omission.
  private readonly flowChartArgs: {
    flowChart: FlowChart<TOut, TScope>;
    scopeFactory: ScopeFactory<TScope>;
    defaultValuesForContext?: unknown;
    initialContext?: unknown;
    readOnlyContext?: unknown;
    throttlingErrorChecker?: (error: unknown) => boolean;
    streamHandlers?: StreamHandlers;
    scopeProtectionMode?: ScopeProtectionMode;
    enrichSnapshots?: boolean;
  };

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
  constructor(
    flowChart: FlowChart<TOut, TScope>,
    factoryOrOptions?: ScopeFactory<TScope> | FlowChartExecutorOptions<TScope>,
  ) {
    // Detect options-object form vs factory form
    let scopeFactory: ScopeFactory<TScope> | undefined;
    let defaultValuesForContext: unknown;
    let initialContext: unknown;
    let readOnlyContext: unknown;
    let throttlingErrorChecker: ((error: unknown) => boolean) | undefined;
    let streamHandlers: StreamHandlers | undefined;
    let scopeProtectionMode: ScopeProtectionMode | undefined;
    let enrichSnapshots: boolean | undefined;

    if (typeof factoryOrOptions === 'function') {
      // 2-param form: new FlowChartExecutor(chart, scopeFactory)
      scopeFactory = factoryOrOptions;
    } else if (factoryOrOptions !== undefined) {
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
      scopeFactory: scopeFactory ?? flowChart.scopeFactory ?? (defaultScopeFactory as ScopeFactory<TScope>),
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

  private createTraverser(
    signal?: AbortSignal,
    readOnlyContextOverride?: unknown,
    env?: import('../engine/types').ExecutionEnv,
    maxDepth?: number,
    overrides?: {
      root?: StageNode<TOut, TScope>;
      initialContext?: unknown;
      preserveRecorders?: boolean;
      existingRuntime?: InstanceType<typeof ExecutionRuntime>;
    },
  ): FlowchartTraverser<TOut, TScope> {
    const args = this.flowChartArgs;
    const fc = args.flowChart;
    const narrativeFlag = this.narrativeEnabled || (fc.enableNarrative ?? false);

    // ── Composed scope factory ─────────────────────────────────────────
    // Collect all scope modifiers (recorders, redaction) into a single list,
    // then create ONE factory that applies them in a loop. Replaces the
    // previous 4-deep closure nesting with a flat, debuggable composition.

    if (overrides?.preserveRecorders) {
      // Resume mode: keep existing combinedRecorder so narrative accumulates
    } else if (narrativeFlag) {
      this.combinedRecorder = new CombinedNarrativeRecorder(this.narrativeOptions);
    } else {
      this.combinedRecorder = undefined;
    }

    this.sharedRedactedKeys = new Set<string>();
    this.sharedRedactedFieldsByKey = new Map<string, Set<string>>();

    // Build modifier list — each modifier receives the scope after creation
    type ScopeModifier = (scope: any) => void;
    const modifiers: ScopeModifier[] = [];

    // 1. Narrative recorder (if enabled)
    if (this.combinedRecorder) {
      const recorder = this.combinedRecorder;
      modifiers.push((scope) => {
        if (typeof scope.attachRecorder === 'function') scope.attachRecorder(recorder);
      });
    }

    // 2. User-provided scope recorders
    if (this.scopeRecorders.length > 0) {
      const recorders = this.scopeRecorders;
      modifiers.push((scope) => {
        if (typeof scope.attachRecorder === 'function') {
          for (const r of recorders) scope.attachRecorder(r);
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
    const scopeFactory = ((ctx: any, stageName: string, readOnly?: unknown, envArg?: any) => {
      const scope = baseFactory(ctx, stageName, readOnly, envArg);
      // Always wire shared redaction state
      if (typeof (scope as any).useSharedRedactedKeys === 'function') {
        (scope as any).useSharedRedactedKeys(sharedRedactedKeys);
      }
      // Apply optional modifiers
      for (const mod of modifiers) mod(scope);
      return scope;
    }) as ScopeFactory<TScope>;

    const effectiveRoot = overrides?.root ?? fc.root;
    const effectiveInitialContext = overrides?.initialContext ?? args.initialContext;

    let runtime: ExecutionRuntime;
    if (overrides?.existingRuntime) {
      // Resume mode: reuse existing runtime so execution tree continues from pause point.
      // Preserve the original root for getSnapshot() (full tree), then advance
      // rootStageContext to a continuation from the leaf (for traversal).
      runtime = overrides.existingRuntime;
      runtime.preserveSnapshotRoot();
      let leaf = runtime.rootStageContext;
      while (leaf.next) leaf = leaf.next;
      runtime.rootStageContext = leaf.createNext('', effectiveRoot.name, effectiveRoot.id);
    } else {
      runtime = new ExecutionRuntime(
        effectiveRoot.name,
        effectiveRoot.id,
        args.defaultValuesForContext,
        effectiveInitialContext,
      );
    }

    // When a redaction policy is configured, maintain a parallel redacted
    // mirror of `globalStore` during traversal. Each commit applies the
    // already-computed redacted patches — same ones fed to the event log —
    // so `getSnapshot({ redact: true })` returns a scrubbed sharedState at
    // zero post-pass cost. Skipped when no policy exists (zero allocation).
    if (this.redactionPolicy) {
      runtime.enableRedactedMirror();
    }

    return new FlowchartTraverser<TOut, TScope>({
      root: effectiveRoot,
      stageMap: fc.stageMap,
      scopeFactory,
      executionRuntime: runtime,
      readOnlyContext: readOnlyContextOverride ?? args.readOnlyContext,
      throttlingErrorChecker: args.throttlingErrorChecker,
      streamHandlers: args.streamHandlers,
      extractor: fc.extractor,
      scopeProtectionMode: args.scopeProtectionMode,
      subflows: fc.subflows,
      enrichSnapshots: args.enrichSnapshots ?? fc.enrichSnapshots,
      narrativeEnabled: narrativeFlag,
      buildTimeStructure: fc.buildTimeStructure,
      logger: fc.logger ?? defaultLogger,
      signal,
      executionEnv: env,
      flowRecorders: this.buildFlowRecordersList(),
      executionCounter: this._executionCounter,
      ...(maxDepth !== undefined && { maxDepth }),
    });
  }

  enableNarrative(options?: CombinedNarrativeRecorderOptions): void {
    this.narrativeEnabled = true;
    if (options) this.narrativeOptions = options;
  }

  /**
   * Set a declarative redaction policy that applies to all stages.
   * Must be called before run().
   */
  setRedactionPolicy(policy: RedactionPolicy): void {
    this.redactionPolicy = policy;
  }

  /**
   * Returns a compliance-friendly report of all redaction activity from the
   * most recent run. Never includes actual values.
   */
  getRedactionReport(): RedactionReport {
    const fieldRedactions: Record<string, string[]> = {};
    for (const [key, fields] of this.sharedRedactedFieldsByKey) {
      fieldRedactions[key] = [...fields];
    }
    return {
      redactedKeys: [...this.sharedRedactedKeys],
      fieldRedactions,
      patterns: (this.redactionPolicy?.patterns ?? []).map((p) => p.source),
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
  getCheckpoint(): FlowchartCheckpoint | undefined {
    return this.lastCheckpoint;
  }

  /** Returns `true` if the most recent run() was paused (checkpoint available). */
  isPaused(): boolean {
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
  async resume(
    checkpoint: FlowchartCheckpoint,
    resumeInput?: unknown,
    options?: Pick<RunOptions, 'signal' | 'env' | 'maxDepth'>,
  ): Promise<ExecutorResult> {
    this.lastCheckpoint = undefined;

    // ── Validate checkpoint structure (may come from untrusted external storage) ──
    if (
      !checkpoint ||
      typeof checkpoint !== 'object' ||
      typeof checkpoint.sharedState !== 'object' ||
      checkpoint.sharedState === null ||
      Array.isArray(checkpoint.sharedState)
    ) {
      throw new Error('Invalid checkpoint: sharedState must be a plain object.');
    }
    if (typeof checkpoint.pausedStageId !== 'string' || checkpoint.pausedStageId === '') {
      throw new Error('Invalid checkpoint: pausedStageId must be a non-empty string.');
    }
    if (
      !Array.isArray(checkpoint.subflowPath) ||
      !checkpoint.subflowPath.every((s: unknown) => typeof s === 'string')
    ) {
      throw new Error('Invalid checkpoint: subflowPath must be an array of strings.');
    }

    // Find the paused node in the graph
    const pausedNode = this.findNodeInGraph(checkpoint.pausedStageId, checkpoint.subflowPath);
    if (!pausedNode) {
      throw new Error(
        `Cannot resume: stage '${checkpoint.pausedStageId}' not found in flowchart. ` +
          'The chart may have changed since the checkpoint was created.',
      );
    }
    if (!pausedNode.resumeFn) {
      throw new Error(
        `Cannot resume: stage '${pausedNode.name}' (${pausedNode.id}) has no resumeFn. ` +
          'Only stages created with addPausableFunction() can be resumed.',
      );
    }

    // Build a synthetic resume node: calls resumeFn with resumeInput, then continues.
    // resumeFn signature is (scope, input) per PausableHandler — wrap to match StageFunction(scope, breakFn).
    const resumeFn = pausedNode.resumeFn;
    const resumeStageFn = (scope: TScope) => {
      return resumeFn(scope, resumeInput);
    };

    // Determine continuation: for branch children (decider/selector), pausedNode.next
    // is undefined. The checkpoint's continuationStageId (collected during traversal
    // bubble-up) points to the invoker's next node.
    let continuationNext = pausedNode.next;
    if (!continuationNext && checkpoint.continuationStageId) {
      continuationNext = this.findNodeInGraph(checkpoint.continuationStageId, []);
    }

    const resumeNode: StageNode<TOut, TScope> = {
      name: pausedNode.name,
      id: pausedNode.id,
      description: pausedNode.description,
      fn: resumeStageFn,
      next: continuationNext,
    };

    // Don't clear recorders — resume continues from previous state.
    // Narrative, metrics, debug entries accumulate across pause/resume.

    // Reuse the existing runtime so the execution tree continues from the pause point.
    // preserveRecorders keeps the CombinedNarrativeRecorder so narrative accumulates.
    const existingRuntime = this.traverser.getRuntime() as InstanceType<typeof ExecutionRuntime>;
    this.traverser = this.createTraverser(options?.signal, undefined, options?.env, options?.maxDepth, {
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
    if (this.combinedRecorder) this.combinedRecorder.onResume(flowResumeEvent);
    for (const r of this.flowRecorders) r.onResume?.(flowResumeEvent);

    const scopeResumeEvent = {
      stageName: pausedNode.name,
      stageId: pausedNode.id,
      runtimeStageId: buildRuntimeStageId(pausedNode.id, this._executionCounter.value),
      hasInput,
      pipelineId: '',
      timestamp: Date.now(),
    };
    for (const r of this.scopeRecorders) r.onResume?.(scopeResumeEvent);

    try {
      return await this.traverser.execute();
    } catch (error: unknown) {
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
          ...(error.invokerStageId && { invokerStageId: error.invokerStageId }),
          ...(error.continuationStageId && { continuationStageId: error.continuationStageId }),
          pausedAt: Date.now(),
        };
        return { paused: true, checkpoint: this.lastCheckpoint } satisfies PausedResult;
      }
      throw error;
    }
  }

  /**
   * Find a StageNode in the compiled graph by ID.
   * Handles subflow paths by drilling into registered subflows.
   */
  private findNodeInGraph(stageId: string, subflowPath: readonly string[]): StageNode<TOut, TScope> | undefined {
    const fc = this.flowChartArgs.flowChart;

    if (subflowPath.length === 0) {
      // Top-level: DFS from root
      return this.dfsFind(fc.root, stageId);
    }

    // Subflow: drill into the subflow chain, then search from the last subflow's root
    let subflowRoot: StageNode<TOut, TScope> | undefined;
    for (const sfId of subflowPath) {
      const subflow = fc.subflows?.[sfId];
      if (!subflow) return undefined;
      subflowRoot = subflow.root;
    }
    if (!subflowRoot) return undefined;
    return this.dfsFind(subflowRoot, stageId);
  }

  /** DFS search for a node by ID in the StageNode graph. Cycle-safe via visited set. */
  private dfsFind(
    node: StageNode<TOut, TScope>,
    targetId: string,
    visited = new Set<string>(),
  ): StageNode<TOut, TScope> | undefined {
    // Skip loop back-edge references (they share the target's ID but have no fn/resumeFn)
    if (node.isLoopRef) return undefined;
    if (visited.has(node.id)) return undefined;
    visited.add(node.id);
    if (node.id === targetId) return node;
    if (node.children) {
      for (const child of node.children) {
        const found = this.dfsFind(child, targetId, visited);
        if (found) return found;
      }
    }
    if (node.next) return this.dfsFind(node.next, targetId, visited);
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
  attachRecorder(recorder: Recorder): void {
    // Replace existing recorder with same ID (idempotent — prevents double-counting)
    this.scopeRecorders = this.scopeRecorders.filter((r) => r.id !== recorder.id);
    this.scopeRecorders.push(recorder);
  }

  /** Detach all scope Recorders with the given ID. */
  detachRecorder(id: string): void {
    this.scopeRecorders = this.scopeRecorders.filter((r) => r.id !== id);
  }

  /** Returns a defensive copy of attached scope Recorders. */
  getRecorders(): Recorder[] {
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
  attachFlowRecorder(recorder: FlowRecorder): void {
    // Replace existing recorder with same ID (idempotent — prevents double-counting)
    this.flowRecorders = this.flowRecorders.filter((r) => r.id !== recorder.id);
    this.flowRecorders.push(recorder);
    this.narrativeEnabled = true;
  }

  /** Detach all FlowRecorders with the given ID. */
  detachFlowRecorder(id: string): void {
    this.flowRecorders = this.flowRecorders.filter((r) => r.id !== id);
  }

  /** Returns a defensive copy of attached FlowRecorders. */
  getFlowRecorders(): FlowRecorder[] {
    return [...this.flowRecorders];
  }

  // ─── Combined Recorder Management ───

  /**
   * Attach a recorder that may observe multiple event streams (scope
   * data-flow, control-flow, or both). Detects at runtime which streams the
   * recorder has methods for and routes it to the correct internal channels.
   *
   * Preferred over calling `attachRecorder` and `attachFlowRecorder`
   * separately, because forgetting one of the two is a silent foot-gun —
   * half your events never fire and there is no runtime warning. With
   * `attachCombinedRecorder` the library guarantees the recorder's declared
   * methods all fire, and adds no overhead versus two explicit calls.
   *
   * ## Idempotency
   *
   * Idempotent by `id` across ALL channels — re-attaching with the same `id`
   * replaces the previous instance everywhere it was registered. Mixing
   * `attachCombinedRecorder(x)` with a prior `attachRecorder(y)` or
   * `attachFlowRecorder(y)` that share `x.id === y.id` is also safe: the
   * combined attach replaces the single-channel registration on whichever
   * channel(s) `x` has methods for. No duplicate firings occur.
   *
   * ## Narrative activation
   *
   * If the recorder has any control-flow methods, `enableNarrative()` is
   * called as a side effect (the narrative subsystem is required to emit
   * control-flow events). Data-flow-only recorders do NOT activate the
   * narrative.
   *
   * ## Detection rule
   *
   * Only **own** event methods count (see `hasRecorderMethods`). Methods
   * inherited via the prototype chain are ignored — this protects against
   * accidental `Object.prototype` pollution attaching handlers you never
   * declared. A recorder that provides only `clear`/`toSnapshot` is a
   * no-op and emits a dev-mode warning to surface the likely mistake.
   *
   * @example
   * ```typescript
   * const audit: CombinedRecorder = {
   *   id: 'audit',
   *   onWrite: (e) => log('scope write', e.key),
   *   onDecision: (e) => log('routed to', e.chosen),
   * };
   * executor.attachCombinedRecorder(audit);
   * ```
   */
  attachCombinedRecorder(recorder: CombinedRecorder): void {
    const hasData = hasRecorderMethods(recorder);
    const hasFlow = hasFlowRecorderMethods(recorder);
    const hasEmit = hasEmitRecorderMethods(recorder);

    // Emit recorders live on the SAME channel as data-flow recorders
    // (ScopeFacade iterates `_recorders` for onEmit dispatch). So
    // attachEmitRecorder internally calls attachRecorder — but we want to
    // avoid double-attach when the recorder implements BOTH onEmit AND
    // other Recorder methods. Short-circuit: if hasData OR hasEmit, the
    // recorder lands on the scope-recorder list exactly once.
    if (hasData || hasEmit) this.attachRecorder(recorder as Recorder);
    if (hasFlow) this.attachFlowRecorder(recorder as FlowRecorder);

    if (!hasData && !hasFlow && !hasEmit && isDevMode()) {
      // Dev-mode only: silent skips are invisible and produce hard-to-debug
      // "why didn't my recorder fire" reports. Per library convention, gated
      // on the central isDevMode() flag (not process.env) so consumers can
      // control dev tooling centrally via enableDevMode()/disableDevMode().
      // eslint-disable-next-line no-console
      console.warn(
        `[footprintjs] attachCombinedRecorder: recorder '${recorder.id}' has ` +
          'no observer event methods — nothing to attach. Did you forget to ' +
          'add an on* handler (onWrite, onDecision, onSubflowEntry, ...)? ' +
          'Note: only OWN properties count; methods on the prototype chain ' +
          'are ignored on purpose.',
      );
    }
  }

  /**
   * Detach a combined recorder from all channels it was attached to.
   * Safe to call if the recorder was only on one channel or never attached.
   */
  detachCombinedRecorder(id: string): void {
    this.detachRecorder(id);
    this.detachFlowRecorder(id);
  }

  // ─── Emit Recorder Management (Phase 3) ───

  /**
   * Attach an `EmitRecorder` — an observer for consumer-emitted structured
   * events fired via `scope.$emit(name, payload)`.
   *
   * Internally, emit recorders share the scope-recorder channel because
   * emit events fire from inside `ScopeFacade` during stage execution,
   * same timing as `onRead`/`onWrite`. This method is a convenience that
   * delegates to `attachRecorder` — consumers can also use
   * `attachRecorder` directly for a recorder that implements BOTH
   * `onWrite` and `onEmit`. Either approach places the recorder on the
   * same underlying list, so `onEmit` fires exactly once per event.
   *
   * **Idempotent by `id`:** replaces existing recorder with same `id`.
   *
   * @example
   * ```typescript
   * executor.attachEmitRecorder({
   *   id: 'token-meter',
   *   onEmit: (e) => {
   *     if (e.name === 'agentfootprint.llm.tokens') trackTokens(e.payload);
   *   },
   * });
   * ```
   */
  attachEmitRecorder(recorder: EmitRecorder): void {
    this.attachRecorder(recorder as Recorder);
  }

  /** Detach an `EmitRecorder` by id. Safe to call if never attached. */
  detachEmitRecorder(id: string): void {
    this.detachRecorder(id);
  }

  /**
   * Returns a defensive copy of attached recorders filtered to those that
   * implement `onEmit`. Useful for inspection during testing.
   */
  getEmitRecorders(): EmitRecorder[] {
    return this.scopeRecorders.filter(
      (r): r is EmitRecorder => typeof (r as { onEmit?: unknown }).onEmit === 'function',
    );
  }

  /**
   * Returns the execution narrative.
   *
   * When using ScopeFacade-based scopes, returns a combined narrative that
   * interleaves flow events (stages, decisions, forks) with data operations
   * (reads, writes, updates). For plain scopes without attachRecorder support,
   * returns flow-only narrative sentences.
   */
  getNarrative(): string[] {
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
  getNarrativeEntries(): CombinedNarrativeEntry[] {
    if (this.combinedRecorder) {
      return this.combinedRecorder.getEntries();
    }
    const flowSentences = this.traverser.getNarrative();
    return flowSentences.map((text) => ({ type: 'stage' as const, text, depth: 0 }));
  }

  /**
   * Returns the combined FlowRecorders list. When narrative is enabled, includes:
   * - CombinedNarrativeRecorder (builds merged flow+data narrative inline)
   * - NarrativeFlowRecorder (keeps flow-only sentences for getFlowNarrative())
   * Plus any user-attached recorders.
   */
  private buildFlowRecordersList(): FlowRecorder[] | undefined {
    const recorders: FlowRecorder[] = [];
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
  getFlowNarrative(): string[] {
    return this.traverser.getNarrative();
  }

  async run(options?: RunOptions): Promise<ExecutorResult> {
    let signal = options?.signal;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    // Create an internal AbortController for timeoutMs
    if (options?.timeoutMs && !signal) {
      const controller = new AbortController();
      signal = controller.signal;
      timeoutId = setTimeout(
        () => controller.abort(new Error(`Execution timed out after ${options.timeoutMs}ms`)),
        options.timeoutMs,
      );
    }

    // Validate input against inputSchema if both are present
    let validatedInput = options?.input;
    if (validatedInput && this.flowChartArgs.flowChart.inputSchema) {
      validatedInput = validateInput(this.flowChartArgs.flowChart.inputSchema, validatedInput);
    }

    // User-attached recorders (flowRecorders + scopeRecorders) are cleared via clear() to prevent
    // cross-run accumulation. The combinedRecorder is NOT cleared here — createTraverser() always
    // creates a fresh CombinedNarrativeRecorder instance on each run, so stale state is never an issue.
    for (const r of this.flowRecorders) {
      r.clear?.();
    }
    for (const r of this.scopeRecorders) {
      r.clear?.();
    }

    this.lastCheckpoint = undefined;
    this._executionCounter = { value: 0 }; // Reset counter on fresh run
    this.traverser = this.createTraverser(signal, validatedInput, options?.env, options?.maxDepth);
    try {
      return await this.traverser.execute();
    } catch (error: unknown) {
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
          // Invoker context — collected during traversal bubble-up (not tree-walked)
          ...(error.invokerStageId && { invokerStageId: error.invokerStageId }),
          ...(error.continuationStageId && { continuationStageId: error.continuationStageId }),
          pausedAt: Date.now(),
        };
        // Return a PauseResult-shaped value so callers can check without try/catch
        return { paused: true, checkpoint: this.lastCheckpoint } satisfies PausedResult;
      }
      throw error;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  // ─── Introspection ───

  /**
   * Returns the runtime snapshot.
   *
   * @param options.redact  When `true`, `sharedState` comes from the parallel
   *   redacted mirror (if maintained — see `setRedactionPolicy`). This is
   *   the safe view for exporting traces externally (paste into a viewer,
   *   share with support). When no redaction policy is configured the
   *   redacted mirror is not maintained, so this flag is a no-op —
   *   `sharedState` is the raw working memory either way. Default `false`.
   *
   *   The commit log is already redacted at write-time regardless of this
   *   flag, and the execution tree carries only structural metadata.
   */
  getSnapshot(options?: { redact?: boolean }): RuntimeSnapshot {
    const snapshot = this.traverser.getSnapshot(options) as RuntimeSnapshot;
    const sfResults = this.traverser.getSubflowResults();
    if (sfResults.size > 0) {
      snapshot.subflowResults = Object.fromEntries(sfResults);
    }

    // Collect snapshot data from recorders that implement toSnapshot()
    const recorderSnapshots: RecorderSnapshot[] = [];
    for (const r of this.scopeRecorders) {
      if (r.toSnapshot) {
        const snap = r.toSnapshot();
        recorderSnapshots.push({
          id: r.id,
          name: snap.name,
          description: snap.description,
          preferredOperation: snap.preferredOperation,
          data: snap.data,
        });
      }
    }
    for (const r of this.flowRecorders) {
      if (r.toSnapshot) {
        const snap = r.toSnapshot();
        recorderSnapshots.push({
          id: r.id,
          name: snap.name,
          description: snap.description,
          preferredOperation: snap.preferredOperation,
          data: snap.data,
        });
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
  setRootObject(path: string[], key: string, value: unknown): void {
    this.traverser.setRootObject(path, key, value);
  }

  /** @internal */
  getBranchIds() {
    return this.traverser.getBranchIds();
  }

  /** @internal */
  getRuntimeRoot(): StageNode {
    return this.traverser.getRuntimeRoot();
  }

  /** @internal */
  getRuntimeStructure(): SerializedPipelineStructure | undefined {
    return this.traverser.getRuntimeStructure();
  }

  /** @internal */
  getSubflowResults(): Map<string, SubflowResult> {
    return this.traverser.getSubflowResults();
  }

  /** @internal */
  getExtractedResults<TResult = unknown>(): Map<string, TResult> {
    return this.traverser.getExtractedResults<TResult>();
  }

  /** @internal */
  getExtractorErrors(): ExtractorError[] {
    return this.traverser.getExtractorErrors();
  }

  /**
   * Returns the subflow manifest from an attached ManifestFlowRecorder.
   * Returns empty array if no ManifestFlowRecorder is attached.
   */
  getSubflowManifest(): ManifestEntry[] {
    const recorder = this.flowRecorders.find((r) => r instanceof ManifestFlowRecorder) as
      | ManifestFlowRecorder
      | undefined;
    return recorder?.getManifest() ?? [];
  }

  /**
   * Returns the full spec for a dynamically-registered subflow.
   * Requires an attached ManifestFlowRecorder that observed the registration.
   */
  getSubflowSpec(subflowId: string): unknown | undefined {
    const recorder = this.flowRecorders.find((r) => r instanceof ManifestFlowRecorder) as
      | ManifestFlowRecorder
      | undefined;
    return recorder?.getSpec(subflowId);
  }
}
