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
 *   const executor = new FlowChartExecutor(chart, { scopeFactory: myFactory });
 *
 *   // 2-param form (accepts a ScopeFactory directly, for backward compatibility):
 *   const executor = new FlowChartExecutor(chart, myFactory);
 *
 *
 * The executor composes four modules, one job each (F9): `attach.ts` (who
 * observes a run), `resume.ts` (plan and announce a re-entry), `checkpoint.ts`
 * (the pause checkpoint), `snapshot.ts` (what `getSnapshot()` serves). What
 * stays here is the per-run state and the run lifecycle that threads it.
 *   const result = await executor.run({ input: data, env: { traceId: 'req-123' } });
 */

import type { CommitValuesMode, LogOutcome, Meta } from 'foottrace';

import { admitRunEnv } from '../attempt/correlation.js';
import { isCancelled } from '../attempt/deadline.js';
import type { RunCorrelation } from '../attempt/types.js';
import { warnDeadlineUnderBudget } from '../budget/index.js';
import type { FlowChart } from '../builder/types.js';
import { detachAndForget as _detachAndForget, detachAndJoinLater as _detachAndJoinLater } from '../detach/spawn.js';
import type { ResumeEntry } from '../engine/handlers/ResumeEntry.js';
import type { CombinedNarrativeRecorderOptions } from '../engine/narrative/CombinedNarrativeRecorder.js';
import type { CombinedNarrativeEntry } from '../engine/narrative/narrativeTypes.js';
import type { ManifestEntry } from '../engine/narrative/recorders/ManifestFlowRecorder.js';
import { ManifestFlowRecorder } from '../engine/narrative/recorders/ManifestFlowRecorder.js';
import type { FlowRecorder } from '../engine/narrative/types.js';
import { FlowchartTraverser } from '../engine/traversal/FlowchartTraverser.js';
import {
  type ExecutorResult,
  type PausedResult,
  type RunOptions,
  type ScopeFactory,
  type SerializedPipelineStructure,
  type StageNode,
  type SubflowResult,
  defaultLogger,
} from '../engine/types.js';
import { type TerminalFailureContext, NativeFailureState } from '../errors/terminalFailure.js';
import type { ReadTrackingMode, WriteTrackingMode } from '../memory/frameTypes.js';
import { RedactionRule } from '../memory/redaction.js';
import { runPolicy } from '../memory/runPolicy.js';
import type { FlowchartCheckpoint, RedactionMarks } from '../pause/types.js';
import { isPauseSignal } from '../pause/types.js';
import type { CombinedRecorder } from '../recorder/CombinedRecorder.js';
import type { EmitRecorder } from '../recorder/EmitRecorder.js';
import type { RedactionPolicy, RedactionReport, ScopeRecorder } from '../scope/types.js';
import { RunObservers } from './attach.js';
import { buildPauseCheckpoint } from './checkpoint.js';
import { type ArmedRun, armRun } from './deadline.js';
import type { AttachRecorderOptions, ObserverDrainResult } from './DeferredObserverTier.js';
import { type RuntimeSnapshot, ExecutionRuntime } from './ExecutionRuntime.js';
import { type ExecutorArgs, type FlowChartExecutorOptions, resolveExecutorArgs } from './options.js';
import { type RecordFlushResult, RunRecord } from './recordSink.js';
import { announceResume, planResume, seedCounters } from './resume.js';
import { generateRunId } from './runId.js';
import { servedSnapshot } from './snapshot.js';
import { validateInput } from './validateInput.js';

export class FlowChartExecutor<TOut = any, TScope = any> {
  private traverser: FlowchartTraverser<TOut, TScope>;
  /** Shared execution counter and per-stage visit counts (loopIteration) — shared BY
   *  REFERENCE with every traverser of the run; survive pause/resume, reset on run(). */
  private _executionCounter = { value: 0 };
  private _visitCounts = new Map<string, number>();
  /** Fresh per run() and per resume() — stamped on every TraversalContext (`runId.ts`). */
  private _currentRunId = '';
  /** Who observes the run — narrative, inline lists, deferred tier (`attach.ts`). */
  private readonly observers = new RunObservers();
  private redactionPolicy: RedactionPolicy | undefined;
  /** The run's ONE redaction rule (`memory/redaction.ts`), built fresh per leg. */
  private redactionRule = new RedactionRule();
  private lastCheckpoint: FlowchartCheckpoint | undefined;
  /**
   * `true` once run() (or a resume) executed here. `resume()` branches on it:
   * true → reuse the runtime (execution tree, recorders, narrative accumulate);
   * false → seed a fresh runtime from `checkpoint.sharedState` (cross-executor
   * resume). See `test/lib/pause/cross-executor-resume.test.ts`.
   */
  private _hasRunBefore = false;
  /**
   * Re-entrancy guard: run()/resume() mutate per-run state (traverser, runId,
   * counters, checkpoint, recorders) — one executor = one in-flight execution.
   * See docs/guides/execution-model.md.
   */
  private _isExecuting = false;
  private captureSignal?: AbortSignal;
  private failureState = new NativeFailureState();

  /** Safe native context for the latest rejected leg; undefined before, during, after success or pause. */
  getFailureContext(): TerminalFailureContext | undefined {
    return this.failureState.result;
  }

  private readonly flowChartArgs: ExecutorArgs<TOut, TScope>;
  /**
   * The crash-safe record of the current run (10.1, P6) — the sink every log of the run writes to, its
   * accounting and its failure mode. Fresh per `run()` and per fresh-executor resume; a same-executor resume keeps
   * it, as it keeps the root log. Absent without a `sink` option.
   */
  private record: RunRecord | undefined;

  /**
   * Create a FlowChartExecutor.
   *
   * **Options object form** (preferred):
   * ```typescript
   * new FlowChartExecutor(chart, { scopeFactory, defaultValuesForContext })
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
    this.flowChartArgs = resolveExecutorArgs(flowChart, factoryOrOptions);
    this.traverser = this.createTraverser();
  }

  private createTraverser(
    signal?: AbortSignal,
    readOnlyContextOverride?: unknown,
    env?: import('../engine/types.js').ExecutionEnv,
    maxDepth?: number,
    maxIterations?: number,
    overrides?: {
      initialContext?: unknown;
      preserveRecorders?: boolean;
      existingRuntime?: InstanceType<typeof ExecutionRuntime>;
      /** The resume's one-shot re-entry (`resume.ts`); the traverser still walks the REAL chart. */
      resume?: ResumeEntry<TOut, TScope>;
      /** The redaction the paused run had made (names only) — the resumed leg's rule starts from it. */
      redactionMarks?: RedactionMarks;
      /** The leg's correlation, resolved from its env before anything moved (`resolveCorrelation`). */
      correlation?: RunCorrelation;
      /** The leg's record (10.1, P6): its sink, and the meta a NEW root log opens with. */
      record?: { link: RunRecord; meta?: Meta };
    },
  ): FlowchartTraverser<TOut, TScope> {
    const args = this.flowChartArgs;
    const fc = args.flowChart;
    const narrativeFlag = this.observers.startLeg(fc.enableNarrative ?? false, overrides?.preserveRecorders === true);

    this.redactionRule = new RedactionRule(this.redactionPolicy);
    // A resume continues the paused run's redaction: a copy masked before the pause stays masked.
    if (overrides?.redactionMarks) this.redactionRule.restoreMarks(overrides.redactionMarks);
    // The record is served under this leg's rule — before the root log below opens (its base, its meta).
    overrides?.record?.link.useRule(this.redactionRule);
    // ONE factory: the base factory, then every scope modifier (recorders,
    // deferred tap, redaction) in a flat pass — see `RunObservers`.
    const scopeFactory = this.observers.composeScopeFactory(
      args.scopeFactory,
      this.redactionPolicy,
      this.redactionRule.markedKeys(),
      overrides?.correlation,
    );

    // The first stage this traversal runs: the resume's entry, else the chart root.
    const effectiveRoot = overrides?.resume?.start ?? fc.root;
    const effectiveInitialContext = overrides?.initialContext ?? args.initialContext;

    // The run's policy (F5): the dials, the rule (installed even without a
    // policy — per-call `setValue(k, v, true)` marks live on it) and the mirror
    // flag (a redacted heap, kept only under a policy), ONE frozen object per
    // leg that every frame of the run holds by reference.
    const policy = runPolicy(args.dials, this.redactionRule, this.redactionPolicy !== undefined);

    let runtime: ExecutionRuntime;
    if (overrides?.existingRuntime) {
      // Same-executor resume: the tree continues from the leaf; getSnapshot() keeps the full tree.
      runtime = overrides.existingRuntime;
      runtime.preserveSnapshotRoot();
      let leaf = runtime.rootStageContext;
      while (leaf.next) leaf = leaf.next;
      runtime.rootStageContext = leaf.createNext('', effectiveRoot.name, effectiveRoot.id);
      runtime.usePolicy(policy);
    } else {
      const record = overrides?.record;
      runtime = new ExecutionRuntime(
        effectiveRoot.name,
        effectiveRoot.id,
        args.defaultValuesForContext,
        effectiveInitialContext,
        policy,
        // A root log that writes to the sink opens at `[runId]` — the address the engine binds it to anyway.
        record && {
          sink: record.link.sink,
          address: { logRunId: this._currentRunId, drillPath: [] },
          ...(record.meta && { meta: record.meta }),
        },
      );
    }

    runtime.rootStageContext.failureState = this.failureState;
    try {
      const traverser = new FlowchartTraverser<TOut, TScope>({
        // Always the REAL chart; a resume only moves where the traversal STARTS, once.
        root: fc.root,
        ...(overrides?.resume?.start && { entry: overrides.resume.start }),
        ...(overrides?.resume?.startPendingPauses && { pendingPauses: overrides.resume.startPendingPauses }),
        ...(overrides?.resume && { resume: overrides.resume }),
        stageMap: fc.stageMap,
        scopeFactory,
        executionRuntime: runtime,
        readOnlyContext: readOnlyContextOverride ?? args.readOnlyContext,
        throttlingErrorChecker: args.throttlingErrorChecker,
        streamHandlers: args.streamHandlers,
        scopeProtectionMode: args.scopeProtectionMode,
        subflows: fc.subflows,
        narrativeEnabled: narrativeFlag,
        buildTimeStructure: fc.buildTimeStructure,
        logger: fc.logger ?? defaultLogger,
        signal,
        executionEnv: env,
        flowRecorders: this.observers.flowRecordersList(),
        executionCounter: this._executionCounter,
        visitCounts: this._visitCounts,
        runId: this._currentRunId,
        ...(overrides?.correlation && { correlation: overrides.correlation }),
        ...(maxDepth !== undefined && { maxDepth }),
        ...(maxIterations !== undefined && { maxIterations }),
      });
      if (args.captureCoverage && this._currentRunId) runtime.beginCapture(this._currentRunId);
      return traverser;
    } catch (error) {
      // A refused leg whose root log already opened says so: its record is closed, never left looking crashed.
      if (overrides?.record && !overrides.existingRuntime) {
        runtime.closeRecord('failed', { runId: this._currentRunId, error: this.closingError(error) });
      }
      throw error;
    }
  }

  enableNarrative(options?: CombinedNarrativeRecorderOptions): void {
    this.observers.enableNarrative(options);
  }

  /**
   * Set a declarative redaction policy that applies to all stages.
   * Must be called before run().
   */
  setRedactionPolicy(policy: RedactionPolicy): void {
    this.redactionPolicy = policy;
    this.redactionRule = new RedactionRule(policy);
  }

  /** The `readTracking` dial (see {@link FlowChartExecutorOptions.readTracking}). Call before run(). */
  setReadTracking(mode: ReadTrackingMode): void {
    this.flowChartArgs.dials = { ...this.flowChartArgs.dials, readTracking: mode };
  }

  /** The `writeTracking` dial (see {@link FlowChartExecutorOptions.writeTracking}). Call before run(). */
  setWriteTracking(mode: WriteTrackingMode): void {
    this.flowChartArgs.dials = { ...this.flowChartArgs.dials, writeTracking: mode };
  }

  /** The `commitValues` dial (see {@link FlowChartExecutorOptions.commitValues}). Call before run(). */
  setCommitValues(mode: CommitValuesMode): void {
    this.flowChartArgs.dials = { ...this.flowChartArgs.dials, commitValues: mode };
  }

  /**
   * Returns a compliance-friendly report of all redaction activity from the
   * most recent run. Never includes actual values.
   */
  getRedactionReport(): RedactionReport {
    return this.redactionRule.report();
  }

  // ─── Pause/Resume ───

  /**
   * Returns the checkpoint from the most recent paused execution, or `undefined`
   * if the last run completed without pausing.
   *
   * JSON-serializable (store it in Redis, Postgres, localStorage…) and fully
   * DETACHED from engine state (`checkpoint.ts`): mutating or persisting it
   * cannot affect the executor, nor a later resume a checkpoint you stored.
   * LEAN: what `resume()` reads and the pause's own record — its size is the
   * state's, never the run's length. The run's history (execution tree,
   * commit log, subflow results) is {@link getSnapshot}'s.
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
   * Number of commits in the ROOT log now. O(1), no snapshot materialization.
   * Not an emitted event's source position: a deferred callback runs later
   * and a subflow owns another log. Use EmitEvent.sourcePosition for that.
   *
   * Returns 0 before any run. A fresh run resets the log; a same-executor
   * resume continues it. A fresh-executor resume starts a new local log.
   * Always equals `getSnapshot().commitLog.length` (the log is the
   * `EventLog`'s `executionHistory`; the snapshot serves a frozen copy).
   */
  getCommitCount(): number {
    const runtime = this.traverser.getRuntime() as InstanceType<typeof ExecutionRuntime> | undefined;
    return runtime?.executionHistory.length ?? 0;
  }

  /**
   * Resume a paused flowchart from a checkpoint.
   *
   * Restores the scope state, runs the paused stage's `resumeFn` with the input
   * (an `interrupt()` pause re-runs the stage with the answer), then continues
   * with whatever ran after that stage on the run — its `next`, or its
   * dispatcher's continuation, at every level of the pause path. Parallel
   * siblings that paused together (`checkpoint.pendingPauses`) are asked in
   * turn; the join runs after the last answer. See `ResumeEntry`.
   *
   * The checkpoint comes from `getCheckpoint()` or from storage. On the SAME
   * executor, narrative/recorder state accumulates across the pause; on a
   * FRESH executor it starts empty. A fresh `runId` either way.
   *
   * @example
   * ```typescript
   * // Process A — after a pause, persist the checkpoint:
   * const checkpoint = executor.getCheckpoint()!;
   * await redis.set(`session:${id}`, JSON.stringify(checkpoint));
   *
   * // Process B (possibly different server, same chart) — restore and resume:
   * const restored = JSON.parse(await redis.get(`session:${id}`));
   * const executor = new FlowChartExecutor(chart);
   * const result = await executor.resume(restored, { approved: true });
   * ```
   */
  async resume(
    checkpoint: FlowchartCheckpoint,
    resumeInput?: unknown,
    options?: Pick<RunOptions, 'signal' | 'env' | 'maxDepth' | 'maxIterations' | 'deadline' | 'timeoutMs'>,
  ): Promise<ExecutorResult> {
    this.assertIdle('resume');
    this.failureState = new NativeFailureState();
    try {
      // Every refusal happens in the plan — before any state below is touched,
      // so a rejected checkpoint leaves the executor (and its checkpoint) as it was.
      const plan = planResume(this.flowChartArgs.flowChart, checkpoint, resumeInput);
      // The resumed leg's env, read ONCE, and its OWN correlation — refused here, before any state moves. Never
      // the paused leg's: the checkpoint carries none.
      const { env, correlation } = admitRunEnv(options?.env);
      // MUST precede the counter read in `announceResume` and the traverser,
      // which takes both counters BY REFERENCE.
      seedCounters(plan.checkpoint, this._executionCounter, this._visitCounts);
      this.lastCheckpoint = undefined;

      // Same executor: reuse the runtime. Fresh executor: seed a NEW one from
      // `checkpoint.sharedState`. Either way a NEW runId (a distinct logical run).
      const existingRuntime = this._hasRunBefore
        ? (this.traverser.getRuntime() as InstanceType<typeof ExecutionRuntime>)
        : undefined;
      this._hasRunBefore = true; // any path that resumes counts as a run
      this._currentRunId = generateRunId();
      // The record (P6): the same executor continues its root log, and its sink; a fresh one opens a new root log.
      const sinkOption = this.flowChartArgs.sink;
      const reused = existingRuntime && this.record ? this.record : undefined;
      reused?.beginLeg();
      const record = sinkOption && (reused ?? new RunRecord(sinkOption));
      const resumedFrom = plan.checkpoint.pausedExecution?.runId;

      // A resumed leg has its own deadline (per leg, like the loop budget): only what is passed HERE. Armed from the
      // env as admitted (`admitRunEnv`, one read), so the deadline and the correlation read the same snapshot.
      const armed = armRun({
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
        deadline: options?.deadline,
        env,
        ...(record?.stopSignal && { stop: record.stopSignal }),
      });
      this.traverser = disposeOnThrow(armed, () =>
        this.createTraverser(armed.signal, undefined, armed.env, options?.maxDepth, options?.maxIterations, {
          // Clone-in: `initialContext` seeds the fresh SharedMemory with a
          // top-level-only merge — nested objects would alias the caller's checkpoint.
          initialContext: structuredClone(plan.checkpoint.sharedState),
          preserveRecorders: true,
          ...(existingRuntime ? { existingRuntime } : {}),
          resume: plan.entry,
          ...(plan.checkpoint.redactionMarks && { redactionMarks: plan.checkpoint.redactionMarks }),
          ...(correlation && { correlation }),
          ...(record && {
            record: {
              link: record,
              meta: this.openingMeta(correlation, armed.deadline, resumedFrom),
            },
          }),
        }),
      );
      // The same root log goes on under this leg: the leg is noted beside it, so the stored record names its runId.
      if (record && existingRuntime) {
        existingRuntime.noteRecord(
          'resume',
          record.serve({
            runId: this._currentRunId,
            ...(resumedFrom !== undefined && { resumedFrom }),
            ...(correlation && { correlation }),
            ...(armed.deadline !== undefined && { deadline: armed.deadline }),
          }),
        );
      }
      this.record = record;
      this.captureSignal = this.flowChartArgs.captureCoverage ? armed.signal : undefined;
      // Before the traversal on purpose: `onResume` precedes `onRunStart`.
      disposeOnThrow(armed, () =>
        announceResume(plan, resumeInput, {
          runId: this._currentRunId,
          executionCount: this._executionCounter.value,
          observers: this.observers,
          ...(correlation && { correlation }),
        }),
      );

      // Set AFTER all sync validation/lookup throws above (nothing can leak the
      // flag); no await between the top-of-method check and here, so race-free.
      this._isExecuting = true;
      if (record) return this.settleRecorded(armed, record);
      try {
        const result = await this.traverser.execute();
        // Terminal flush (RFC-001 Block 8) — same boundary contract as run().
        this.observers.deferredTier?.terminalFlush();
        this.failureState.complete();
        this.finishCapture('completed');
        return result;
      } catch (error: unknown) {
        const paused = this.pausedOrThrow(error);
        this.failureState.complete();
        this.finishCapture('paused');
        return paused;
      } finally {
        this._isExecuting = false;
        armed.dispose();
      }
    } catch (error: unknown) {
      this.failureState.finish(error);
      this.finishCapture('failed', error);
      throw error;
    }
  }

  /**
   * The settle of a leg that threw: flush the deferred tier (the OUTERMOST
   * handler — a pause re-throws through subflow traversers without exit
   * events, so per-traverser hooks would miss it), then turn a pause into a
   * detached checkpoint (`checkpoint.ts`) and a `PausedResult`; anything else
   * is rethrown.
   */
  private pausedOrThrow(error: unknown): PausedResult {
    this.observers.deferredTier?.terminalFlush();
    if (isPauseSignal(error)) {
      const redactionMarks = this.redactionRule.marksForCheckpoint();
      this.lastCheckpoint = buildPauseCheckpoint(error, this.traverser, {
        runId: this._currentRunId,
        executionCount: this._executionCounter.value,
        visitCounts: this._visitCounts,
        ...(redactionMarks && { redactionMarks }),
      });
      return { paused: true, checkpoint: this.lastCheckpoint } satisfies PausedResult;
    }
    throw error;
  }

  /**
   * The settle of a leg that writes its record (10.1, P6) — the 10.0 settle (`run()` / `resume()`), then the root
   * log's closing entry with how the leg ended, then (`flush: 'auto'`) the adapter's flush, all before the leg
   * counts as finished. A leg without a sink never comes here: its settle has no extra await.
   *
   * The leg's own error always wins. A run that finished but lost an entry under `onFailure: 'fail'` rejects with
   * the `RecordSinkError`.
   */
  private async settleRecorded(armed: ArmedRun, record: RunRecord): Promise<ExecutorResult> {
    const runtime = this.traverser.getRuntime() as InstanceType<typeof ExecutionRuntime>;
    let outcome: LogOutcome;
    let result: ExecutorResult | undefined;
    let failure: { error: unknown } | undefined;
    try {
      try {
        result = await this.traverser.execute();
        // Terminal flush (RFC-001 Block 8) — same boundary contract as run().
        this.observers.deferredTier?.terminalFlush();
        outcome = 'ok';
      } catch (error: unknown) {
        try {
          result = this.pausedOrThrow(error);
          outcome = 'paused';
        } catch (thrown: unknown) {
          failure = { error: thrown };
          outcome = 'failed';
        }
      }
      runtime.closeRecord(outcome, {
        runId: this._currentRunId,
        ...(failure && { error: this.closingError(failure.error) }),
      });
      // Bounded: a flush that never settles is a loss, never a run held open (the time left, else 30 s).
      if (record.flushMode === 'auto') await record.flush(autoFlushMs(armed.deadline), true);
    } catch (error: unknown) {
      this.failureState.finish(error);
      this.finishCapture('failed', error);
      throw error;
    } finally {
      this._isExecuting = false;
      armed.dispose();
    }
    if (failure) {
      this.failureState.finish(failure.error);
      this.finishCapture('failed', failure.error);
      throw failure.error;
    }
    if (record.fatal) {
      this.failureState.finish(record.fatal);
      this.finishCapture('failed', record.fatal);
      throw record.fatal;
    }
    this.failureState.complete();
    this.finishCapture(outcome === 'paused' ? 'paused' : 'completed');
    return result as ExecutorResult;
  }

  private finishCapture(status: 'completed' | 'paused' | 'failed', error?: unknown): void {
    const signal = this.captureSignal;
    this.captureSignal = undefined;
    const runtime = this.traverser.getRuntime() as ExecutionRuntime;
    const capture = runtime.capture;
    if (!capture || capture.runId !== this._currentRunId) return;
    const cancelled = status === 'failed' && isCancelled(signal) && error === signal?.reason;
    if (status === 'completed' && this.traverser.getBreakState().shouldBreak) capture.limit('execution-broken');
    capture.end(cancelled ? 'cancelled' : status, status === 'failed' ? this.failureState.result : undefined);
  }

  /**
   * What a new root log opens with: names and numbers the run already serves — the run, the chart, the correlation,
   * the deadline, the declared budget, and the run a fresh-executor resume continues. Served by the record.
   */
  private openingMeta(
    correlation: RunCorrelation | undefined,
    deadline: number | undefined,
    resumedFrom?: string,
  ): Meta {
    const root = this.flowChartArgs.flowChart.root;
    const budgetMs = this.flowChartArgs.flowChart.buildTimeStructure?.budgetMs;
    return {
      runId: this._currentRunId,
      chart: { id: root.id, name: root.name },
      ...(correlation && { correlation }),
      ...(deadline !== undefined && { deadline }),
      ...(budgetMs !== undefined && { budgetMs }),
      ...(resumedFrom !== undefined && { resumedFrom }),
    };
  }

  /** The closing entry's error: the run's SERVED form of it, its name, message and code only (never `raw`). */
  private closingError(error: unknown): Meta {
    const info = this.redactionRule.servedError(error);
    return {
      ...(info.name !== undefined && { name: info.name }),
      message: info.message,
      ...(info.code !== undefined && { code: info.code }),
    };
  }

  /** The re-entrancy guard: one executor = one in-flight execution. */
  private assertIdle(method: 'run' | 'resume'): void {
    if (this._isExecuting) {
      throw new Error(
        `FlowChartExecutor: ${method}() called while another run()/resume() is in flight on this ` +
          'executor. An executor holds per-run state (runId, recorders, checkpoint) — create ' +
          'one executor per concurrent run. See docs/guides/execution-model.md.',
      );
    }
  }

  // ─── Recorders (the register lives in `attach.ts`) ───

  /**
   * Attach a ScopeRecorder to observe data operations (reads, writes, commits)
   * on every stage scope. Call before run(). **Idempotent by `id`** (replaced,
   * never duplicated). `{ delivery: 'deferred' }` moves it off the hot path —
   * delivered at the next microtask checkpoint; re-attaching an id on the
   * other tier SWAPS tiers (`docs/guides/observers-deferred.md`).
   *
   * @example
   * ```typescript
   * executor.attachScopeRecorder(new MetricRecorder());
   * executor.attachScopeRecorder(new MetricRecorder('my-metrics')); // replaces same id
   * ```
   */
  attachScopeRecorder(recorder: ScopeRecorder, options?: AttachRecorderOptions): void {
    this.observers.attachScope(recorder, options);
  }

  /** Detach all scope Recorders with the given ID — both delivery tiers. */
  detachScopeRecorder(id: string): void {
    this.observers.detachScope(id);
  }

  /** Returns a defensive copy of attached scope Recorders (both tiers). */
  getScopeRecorders(): ScopeRecorder[] {
    return this.observers.scopeList();
  }

  /**
   * Attach a FlowRecorder to observe control flow events. Automatically
   * enables narrative. Must be called before run(). Idempotent by `id`;
   * `{ delivery: 'deferred' }` as for `attachScopeRecorder`.
   */
  attachFlowRecorder(recorder: FlowRecorder, options?: AttachRecorderOptions): void {
    this.observers.attachFlow(recorder, options);
  }

  /** Detach all FlowRecorders with the given ID — both delivery tiers. */
  detachFlowRecorder(id: string): void {
    this.observers.detachFlow(id);
  }

  /** Returns a defensive copy of attached FlowRecorders (both tiers). */
  getFlowRecorders(): FlowRecorder[] {
    return this.observers.flowList();
  }

  /**
   * Attach a recorder to every channel (scope, flow, emit) it has OWN `on*`
   * methods for — preferred over single-channel calls, where forgetting one
   * silently loses events. Idempotent by `id` across all channels; a flow
   * method enables the narrative; `delivery` comes from the options or the
   * recorder's own field.
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
  attachCombinedRecorder(recorder: CombinedRecorder, options?: AttachRecorderOptions): void {
    this.observers.attachCombined(recorder, options);
  }

  /** Detach a combined recorder from every channel it was attached to (safe if never attached). */
  detachCombinedRecorder(id: string): void {
    this.detachScopeRecorder(id);
    this.detachFlowRecorder(id);
  }

  /**
   * Attach an `EmitRecorder` for `scope.$emit(name, payload)` events. It rides
   * the scope list, so `onEmit` fires exactly once per event. Idempotent by `id`.
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
  attachEmitRecorder(recorder: EmitRecorder, options?: AttachRecorderOptions): void {
    this.attachScopeRecorder(recorder as ScopeRecorder, options);
  }

  /** Detach an `EmitRecorder` by id. Safe to call if never attached. */
  detachEmitRecorder(id: string): void {
    this.detachScopeRecorder(id);
  }

  /** Returns a defensive copy of attached recorders (both tiers) that implement `onEmit`. */
  getEmitRecorders(): EmitRecorder[] {
    return this.getScopeRecorders().filter(
      (r): r is EmitRecorder => typeof (r as { onEmit?: unknown }).onEmit === 'function',
    );
  }

  // ─── Detach (T4) ───
  // Bare-executor entry points for fire-and-forget child charts. From inside a
  // stage use `scope.$detachAndJoinLater(...)` / `scope.$detachAndForget(...)`,
  // which mint refIds from the calling stage; these use `__executor__`.

  /**
   * Detach a child flowchart on the given driver and return a `DetachHandle`
   * the caller can `wait()` on (Promise) or read `.status` from (sync). The
   * driver is REQUIRED — there is no library default.
   *
   * @example
   * ```typescript
   * import { microtaskBatchDriver } from 'footprintjs/detach';
   *
   * const exec = new FlowChartExecutor(parentChart);
   * const handle = exec.detachAndJoinLater(microtaskBatchDriver, telemetryChart, { event: 'x' });
   * await handle.wait(); // optional
   * ```
   */
  detachAndJoinLater(
    driver: import('../detach/types.js').DetachDriver,
    child: import('../builder/types.js').FlowChart,
    input?: unknown,
  ): import('../detach/types.js').DetachHandle {
    return _detachAndJoinLater(driver, child, input, '__executor__');
  }

  /**
   * Detach a child flowchart on the given driver and DISCARD the handle — for
   * fire-and-forget side effects. A child's error lands on the discarded handle;
   * for observable detach prefer `detachAndJoinLater` + `.wait().catch()`.
   */
  detachAndForget(
    driver: import('../detach/types.js').DetachDriver,
    child: import('../builder/types.js').FlowChart,
    input?: unknown,
  ): void {
    _detachAndForget(driver, child, input, '__executor__');
  }

  /**
   * The executor-owned narrative view; `.map(e => e.text)` for flat strings.
   * `enableNarrative(options)` configures this view. Attaching a flow recorder
   * also enables it, but that recorder's options and entries remain independent
   * (read an attached `narrative()` instance with `recorder.getEntries()`).
   * Same-executor resume retains history; a fresh executor records its resumed
   * leg only. The internal narrator is not an attached snapshot recorder row.
   */
  getNarrativeEntries(): CombinedNarrativeEntry[] {
    if (this.observers.combinedRecorder) {
      return this.observers.combinedRecorder.getEntries();
    }
    const flowSentences = this.traverser.getNarrative();
    return flowSentences.map((text) => ({ type: 'stage' as const, text, depth: 0 }));
  }

  /**
   * Execute the chart. Resolves when the run finishes — or pauses, if a
   * pausable stage returned data (check `isPaused()` afterward).
   *
   * @param options `{ input, env }` — `input` is the frozen business input
   *   (read in a stage via `scope.$getArgs()`); `env` is infrastructure context
   *   like `{ signal, timeoutMs, traceId }` (read via `scope.$getEnv()`); `deadline` / `timeoutMs` give the run
   *   its deadline (`env.deadline`, `scope.$attempt().timeLeftMs()`).
   *
   * After it resolves, read results off the executor:
   * - `getSnapshot()` — full state, commit log, execution tree.
   * - `getNarrativeEntries()` — the plain-English trace (call `enableNarrative()`
   *   or attach a `narrative()` recorder first).
   * - `isPaused()` — true if a stage paused; then use `getCheckpoint()` / `resume()`.
   *
   * One run at a time per executor — it holds per-run state (runId, recorders,
   * checkpoint). Create one executor per concurrent run.
   */
  async run(options?: RunOptions): Promise<ExecutorResult> {
    // A failed entry leaves no side effects: the guard FIRST (the in-flight
    // run stays untouched), validation before the timeout timer exists.
    this.assertIdle('run');
    this.failureState = new NativeFailureState();
    try {
      let validatedInput = options?.input;
      if (validatedInput && this.flowChartArgs.flowChart.inputSchema) {
        validatedInput = validateInput(this.flowChartArgs.flowChart.inputSchema, validatedInput);
      }
      // The env, read ONCE, and the run's correlation, before anything moves: a refused `traceparent` leaves no
      // side effect, and the stages see the same snapshot the correlation was read from (`admitRunEnv`).
      const { env, correlation } = admitRunEnv(options?.env);

      // The run's one signal and its deadline (`armRun`): `signal`, `env.signal`, `deadline` / `timeoutMs` /
      // `env.deadline`, composed from the ADMITTED env — and stamped on the env stages read. Armed after the
      // admission, so a refused `traceparent` leaves no timer; disposed on every exit.
      const startedAt = Date.now(); // read BEFORE arming, so `timeoutMs` equal to the declared budget never warns
      // The run's record (P6): a fresh one per run — its `'fail'` stop is one more source of the run's signal.
      const record = this.flowChartArgs.sink && new RunRecord(this.flowChartArgs.sink);
      const armed = armRun({
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
        deadline: options?.deadline,
        env,
        ...(record?.stopSignal && { stop: record.stopSignal }),
      });
      // A deadline shorter than the chart's declared `.budget(ms)`: a dev-mode warning, once per chart (P5).
      disposeOnThrow(armed, () => warnDeadlineUnderBudget(this.flowChartArgs.flowChart, armed.deadline, startedAt));

      this.observers.clearForRun(); // no cross-run accumulation
      this.lastCheckpoint = undefined;
      this._executionCounter = { value: 0 };
      this._visitCounts = new Map();
      this._currentRunId = generateRunId();
      this._hasRunBefore = true; // a later resume() reuses this runtime
      this.traverser = disposeOnThrow(armed, () =>
        this.createTraverser(armed.signal, validatedInput, armed.env, options?.maxDepth, options?.maxIterations, {
          ...(correlation && { correlation }),
          ...(record && { record: { link: record, meta: this.openingMeta(correlation, armed.deadline) } }),
        }),
      );
      // Set once the leg's traverser exists, so a snapshot never pairs one run's state with another's sink stats.
      this.record = record;
      this.captureSignal = this.flowChartArgs.captureCoverage ? armed.signal : undefined;
      // After every sync throw, with no await since the guard: race-free.
      this._isExecuting = true;
      if (record) return this.settleRecorded(armed, record);
      try {
        const result = await this.traverser.execute();
        // Terminal flush (RFC-001 Block 8): "one beat behind" never becomes "lost at exit".
        this.observers.deferredTier?.terminalFlush();
        this.failureState.complete();
        this.finishCapture('completed');
        return result;
      } catch (error: unknown) {
        const paused = this.pausedOrThrow(error);
        this.failureState.complete();
        this.finishCapture('paused');
        return paused;
      } finally {
        this._isExecuting = false;
        armed.dispose();
      }
    } catch (error: unknown) {
      this.failureState.finish(error);
      this.finishCapture('failed', error);
      throw error;
    }
  }

  /**
   * Flush the deferred-observer backlog, then await async listener completions
   * under a deadline — call before a serverless process freezes or exits.
   * Zeros when no deferred observer was attached; `pending > 0` reports what
   * was still outstanding at the deadline.
   */
  drainObservers(opts?: { timeoutMs?: number }): Promise<ObserverDrainResult> {
    const tier = this.observers.deferredTier;
    if (!tier) return Promise.resolve({ done: 0, failed: 0, pending: 0 });
    return tier.drain(opts);
  }

  /**
   * Flush the record sink (10.1, P6): await the adapter's `flush()` — for an executor built with
   * `sink: { adapter, flush: 'manual' }`, or before a serverless process freezes. `timeoutMs` bounds the wait; a
   * flush still running then is `pending` (and keeps running). A failed flush is counted on `getSnapshot().sink`.
   * Done at once without a sink, or with an adapter that has no `flush`.
   *
   * @example
   * ```typescript
   * const executor = new FlowChartExecutor(chart, { sink: { adapter: fileSink(path), flush: 'manual' } });
   * await executor.run();
   * await executor.flushRecord({ timeoutMs: 2_000 });
   * ```
   */
  flushRecord(opts?: { timeoutMs?: number }): Promise<RecordFlushResult> {
    if (!this.record) return Promise.resolve({ done: true, failed: false, pending: false });
    return this.record.flush(opts?.timeoutMs);
  }

  // ─── Introspection ───

  /**
   * Returns the runtime snapshot.
   *
   * @param options.redact  `true` serves `sharedState` (and each subflow's
   *   `globalContext`) from the redacted mirror — the safe view to export. A
   *   no-op without a redaction policy. The commit log is redacted at write
   *   time regardless. Default `false`.
   *
   * **Treat `sharedState` as READ-ONLY.** In production it is a live view of
   * engine memory; in dev mode a deep-frozen clone, so a mutation throws.
   */
  getSnapshot(options?: { redact?: boolean }): RuntimeSnapshot {
    return servedSnapshot(this.traverser, this.observers, options, this.record?.stats());
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

  /**
   * Returns the subflow manifest from an attached ManifestFlowRecorder.
   * Returns empty array if no ManifestFlowRecorder is attached.
   */
  getSubflowManifest(): ManifestEntry[] {
    const recorder = this.observers.flowRecorders.find((r) => r instanceof ManifestFlowRecorder) as
      | ManifestFlowRecorder
      | undefined;
    return recorder?.getManifest() ?? [];
  }

  /**
   * Returns the full spec for a dynamically-registered subflow.
   * Requires an attached ManifestFlowRecorder that observed the registration.
   */
  getSubflowSpec(subflowId: string): unknown | undefined {
    const recorder = this.observers.flowRecorders.find((r) => r instanceof ManifestFlowRecorder) as
      | ManifestFlowRecorder
      | undefined;
    return recorder?.getSpec(subflowId);
  }
}

/** How long a run's own flush may take: the run's time left (at least 1 s), never past {@link AUTO_FLUSH_MS}. */
function autoFlushMs(deadline: number | undefined): number {
  return deadline === undefined ? AUTO_FLUSH_MS : Math.min(AUTO_FLUSH_MS, Math.max(1_000, deadline - Date.now()));
}

/** The bound on a run's own flush when it has no deadline: 30 s. */
const AUTO_FLUSH_MS = 30_000;

/** Run `build`; if it throws, release the armed run first (no deadline timer outlives a refused entry). */
function disposeOnThrow<T>(armed: ArmedRun, build: () => T): T {
  try {
    return build();
  } catch (error) {
    armed.dispose();
    throw error;
  }
}
