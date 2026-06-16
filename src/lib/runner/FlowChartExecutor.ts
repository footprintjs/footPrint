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
 *   const result = await executor.run({ input: data, env: { traceId: 'req-123' } });
 */

import type { FlowChart } from '../builder/types.js';
import { detachAndForget as _detachAndForget, detachAndJoinLater as _detachAndJoinLater } from '../detach/spawn.js';
import type { CombinedNarrativeRecorderOptions } from '../engine/narrative/CombinedNarrativeRecorder.js';
import { CombinedNarrativeRecorder } from '../engine/narrative/CombinedNarrativeRecorder.js';
import type { CombinedNarrativeEntry } from '../engine/narrative/narrativeTypes.js';
import type { ManifestEntry } from '../engine/narrative/recorders/ManifestFlowRecorder.js';
import { ManifestFlowRecorder } from '../engine/narrative/recorders/ManifestFlowRecorder.js';
import type { FlowRecorder } from '../engine/narrative/types.js';
import { buildRuntimeStageId } from '../engine/runtimeStageId.js';
import { FlowchartTraverser } from '../engine/traversal/FlowchartTraverser.js';
import {
  type ExecutorResult,
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
import type { CommitValuesMode, ReadTrackingMode, StageSnapshot, WriteTrackingMode } from '../memory/types.js';
import type { FlowchartCheckpoint, PauseSignal } from '../pause/types.js';
import { isPauseSignal } from '../pause/types.js';
import type { CombinedRecorder } from '../recorder/CombinedRecorder.js';
import { hasEmitRecorderMethods, hasFlowRecorderMethods, hasRecorderMethods } from '../recorder/CombinedRecorder.js';
import type { EmitRecorder } from '../recorder/EmitRecorder.js';
import { isDevMode } from '../scope/detectCircular.js';
import { deepFreeze } from '../scope/protection/readonlyInput.js';
import type { ScopeProtectionMode } from '../scope/protection/types.js';
import { ScopeFacade } from '../scope/ScopeFacade.js';
import type { RedactionPolicy, RedactionReport, ScopeRecorder } from '../scope/types.js';
import { describeCheckpointCloneFailure, sanitizeDiagnosticBags } from './checkpointSanitize.js';
import { type AttachRecorderOptions, type ObserverDrainResult, DeferredObserverTier } from './DeferredObserverTier.js';
import { type RecorderSnapshot, type RuntimeSnapshot, ExecutionRuntime } from './ExecutionRuntime.js';
import { generateRunId } from './runId.js';
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
 *   defaultValuesForContext: { ... },
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

  // ── Observability cost options ────────────────────────────────────────────

  /**
   * Policy for `StageSnapshot.stageReads` (#14). Default `'full'` — every
   * tracked read `structuredClone`s the value into the stage's read view
   * (the historical behavior; what lens/agentfootprint snapshots show).
   * `'summary'` records a cheap type/size/preview marker per read; `'off'`
   * records nothing — zero per-read clone cost (reads of large values become
   * ~free). Narrative and `ScopeRecorder.onRead` are identical in every mode.
   * Caveat: under `'off'` a stage's snapshot is indistinguishable from one
   * that read nothing — auditing consumers that need "did it read?" without
   * the value cost should prefer `'summary'`.
   * Equivalent to calling `executor.setReadTracking(mode)` before `run()`.
   */
  readTracking?: ReadTrackingMode;

  /**
   * Policy for `StageSnapshot.stageWrites` (#13c-A) — the sibling of
   * {@link readTracking}; the two dials are independent. Default `'full'` —
   * every tracked write `structuredClone`s the value into the stage's write
   * view (the historical behavior). `'summary'` records a cheap
   * `WriteSummaryMarker` (type/size/preview) per write; `'off'` records
   * nothing — `stageWrites` is absent from the snapshot.
   *
   * Observable consequences — what the policy DOES govern:
   * - `StageSnapshot.stageWrites` (markers under `'summary'`, absent under
   *   `'off'`).
   * - The commit observer payload: `ScopeRecorder.onCommit(mutations)`
   *   receives the retained `_stageWrites` entries, so it carries the same
   *   markers under `'summary'` and an empty mutations bag under `'off'` —
   *   deferred/observer consumers see exactly what retention stored.
   *
   * What it does NOT govern:
   * - The writes themselves: shared state, the transaction buffer, and the
   *   COMMIT LOG are identical in every mode (commitLog values keep their
   *   full payloads — the lossless linear-cost fix for those is the
   *   {@link commitValues} dial, #13c-B).
   * - Per-op `ScopeRecorder.onWrite` events — they fire with live values
   *   regardless (delivery tier, RFC-001's concern), so narrative output is
   *   identical in every mode.
   * - Redaction: a policy/per-call-redacted write stores `'[REDACTED]'`
   *   under `'full'` AND `'summary'` (redaction takes precedence over the
   *   dial; a marker would leak size/preview), and nothing under `'off'`.
   *
   * Caveat: under `'off'` a stage's SNAPSHOT is indistinguishable from one
   * that wrote nothing — but unlike `readTracking: 'off'`, the commit log
   * still records every net change, so "did it write?" stays answerable.
   * Equivalent to calling `executor.setWriteTracking(mode)` before `run()`.
   */
  writeTracking?: WriteTrackingMode;

  /**
   * Encoding policy for COMMIT LOG values (#13c-B) — the third dial of the
   * family, and unlike its siblings it is **lossless in both modes** (it
   * changes the log's encoding, never its information).
   *
   * - `'full'` (default) — every surviving `set` path stores the full final
   *   value; byte-identical to the historical behavior.
   * - `'delta'` — array net-changes that are "base plus a tail" commit as an
   *   `append` trace verb storing ONLY the tail (the growing-history commit
   *   log becomes linear instead of O(N²) retained); `deleteValue()` commits
   *   as a real `delete` verb (replay removes the key instead of leaving
   *   `key: undefined`); bundles carry exactly ONE trace entry per surviving
   *   path. Replay (`applySmartMerge` — live state, `materialise()`, the
   *   redacted mirror) reconstructs every step's full state exactly.
   *
   * Consumers that read `bundle.overwrite[key]` as "the full value written"
   * must switch to `commitValueAt(commitLog, idx, key)` from
   * `footprintjs/trace` — under `'delta'` that value is verb-qualified (an
   * `append` bundle holds only the tail). Path-tier consumers
   * (`findLastWriter`, `causalChain`, narrative, lens highlights) are
   * unaffected. The active mode is surfaced as
   * `getSnapshot().commitValues`.
   *
   * Honest cost note: append detection is new wall work — an O(|base array|)
   * structural prefix compare per array-set path per commit. On a hit the
   * commit gets cheaper in both wall and heap; on a miss (prefix diverges)
   * it pays compare + full clone. `'full'` pays zero.
   * Equivalent to calling `executor.setCommitValues(mode)` before `run()`.
   */
  commitValues?: CommitValuesMode;

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
  /** Shared per-run visit counts (by stageId) driving TraversalContext.loopIteration.
   *  Twin of _executionCounter: survives pause/resume, reset on fresh run(). */
  private _visitCounts = new Map<string, number>();
  /** Per-`run()` identifier — generated fresh per run + per resume. Threaded
   *  through every TraversalContext so recorders can scope state to a single
   *  run. See `runId.ts`. */
  private _currentRunId = '';
  private narrativeEnabled = false;
  private narrativeOptions?: CombinedNarrativeRecorderOptions;
  private combinedRecorder: CombinedNarrativeRecorder | undefined;
  private flowRecorders: FlowRecorder[] = [];
  private scopeRecorders: ScopeRecorder[] = [];
  /**
   * RFC-001 deferred-observer wiring — created LAZILY on the first
   * `delivery: 'deferred'` attach. `undefined` for every executor that never
   * opts in: zero allocation, zero per-event cost, byte-identical behavior
   * (the emit fast-path precedent).
   */
  private deferredTier?: DeferredObserverTier;
  private redactionPolicy: RedactionPolicy | undefined;
  private sharedRedactedKeys = new Set<string>();
  private sharedRedactedFieldsByKey = new Map<string, Set<string>>();
  private lastCheckpoint: FlowchartCheckpoint | undefined;
  /**
   * `true` once `run()` (or a previous `resume()`) has executed on
   * this instance. `resume()` branches on it:
   *
   *   • true  → reuse the constructor-time runtime (same-executor
   *             continuity: execution tree, recorders, narrative
   *             accumulate across pause/resume cycles)
   *   • false → seed a fresh runtime from `checkpoint.sharedState`
   *             (cross-executor / cross-process resume: new instance
   *             reconstructed from a serialized checkpoint)
   *
   * Without this flag, fresh executors silently discarded the
   * checkpoint's sharedState and resume handlers couldn't read pre-pause
   * scope. See `test/lib/pause/cross-executor-resume.test.ts`.
   */
  private _hasRunBefore = false;
  /**
   * Re-entrancy guard. `run()` and `resume()` mutate per-run instance state
   * (traverser, runId, execution counter, checkpoint) and clear attached
   * recorders — a second concurrent entry on the SAME executor would
   * interleave runIds and cross-contaminate recorder/narrative state, and
   * `getCheckpoint()` would return whichever run paused last. One executor =
   * one in-flight execution; create an executor per concurrent run.
   * See docs/guides/execution-model.md.
   */
  private _isExecuting = false;

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
    readTracking?: ReadTrackingMode;
    writeTracking?: WriteTrackingMode;
    commitValues?: CommitValuesMode;
  };

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
    // Detect options-object form vs factory form
    let scopeFactory: ScopeFactory<TScope> | undefined;
    let defaultValuesForContext: unknown;
    let initialContext: unknown;
    let readOnlyContext: unknown;
    let throttlingErrorChecker: ((error: unknown) => boolean) | undefined;
    let streamHandlers: StreamHandlers | undefined;
    let scopeProtectionMode: ScopeProtectionMode | undefined;
    let readTracking: ReadTrackingMode | undefined;
    let writeTracking: WriteTrackingMode | undefined;
    let commitValues: CommitValuesMode | undefined;

    if (typeof factoryOrOptions === 'function') {
      // 2-param form: new FlowChartExecutor(chart, scopeFactory)
      scopeFactory = factoryOrOptions;
    } else if (factoryOrOptions !== undefined) {
      // Options object form
      const opts = factoryOrOptions;
      scopeFactory = opts.scopeFactory;
      defaultValuesForContext = opts.defaultValuesForContext;
      initialContext = opts.initialContext;
      readOnlyContext = opts.readOnlyContext;
      throttlingErrorChecker = opts.throttlingErrorChecker;
      streamHandlers = opts.streamHandlers;
      scopeProtectionMode = opts.scopeProtectionMode;
      readTracking = opts.readTracking;
      writeTracking = opts.writeTracking;
      commitValues = opts.commitValues;
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
      readTracking,
      writeTracking,
      commitValues,
    };
    this.traverser = this.createTraverser();
  }

  private createTraverser(
    signal?: AbortSignal,
    readOnlyContextOverride?: unknown,
    env?: import('../engine/types').ExecutionEnv,
    maxDepth?: number,
    maxIterations?: number,
    overrides?: {
      root?: StageNode<TOut, TScope>;
      initialContext?: unknown;
      preserveRecorders?: boolean;
      existingRuntime?: InstanceType<typeof ExecutionRuntime>;
      /** Per-subflow scope captures from a checkpoint — passed through
       *  to HandlerDeps so SubflowExecutor can re-seed nested runtimes
       *  on the resume path. Undefined on normal run() paths. */
      subflowStatesForResume?: Record<string, Record<string, unknown>>;
      /** Resume-only override of the subflows dict — substitutes the
       *  leaf subflow's root with a resume chain so the subflow body
       *  picks up at the pause point. Other entries pass through
       *  unchanged. */
      subflowsOverride?: Record<string, { root: StageNode<TOut, TScope> }>;
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
        if (typeof scope.attachScopeRecorder === 'function') scope.attachScopeRecorder(recorder);
      });
    }

    // 2. User-provided scope recorders
    if (this.scopeRecorders.length > 0) {
      const recorders = this.scopeRecorders;
      modifiers.push((scope) => {
        if (typeof scope.attachScopeRecorder === 'function') {
          for (const r of recorders) scope.attachScopeRecorder(r);
        }
      });
    }

    // 2b. Deferred-observer scope tap (RFC-001 Block 7) — a synthetic
    // recorder whose hooks CAPTURE into the bounded queue instead of doing
    // observer work. It rides the same per-stage recorder list as inline
    // recorders, so it receives exactly the post-redaction events they do.
    // Absent (zero work, identical list) when nobody opted into deferral.
    const scopeTap = this.deferredTier?.buildScopeTap();
    if (scopeTap) {
      modifiers.push((scope) => {
        if (typeof scope.attachScopeRecorder === 'function') scope.attachScopeRecorder(scopeTap);
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

    // Read-tracking policy (#14): set on the runtime's root context so every
    // descendant context (createNext/createChild) and subflow root inherits.
    // Applied AFTER the resume-path root swap above so the continuation root
    // carries the policy too. Skipped for the default 'full' — zero work.
    const readTracking = args.readTracking;
    if (readTracking !== undefined && readTracking !== 'full') {
      runtime.useReadTracking(readTracking);
    }

    // Write-tracking policy (#13c-A): identical plumbing to readTracking —
    // same root-context anchor, same inheritance, same resume-path ordering.
    const writeTracking = args.writeTracking;
    if (writeTracking !== undefined && writeTracking !== 'full') {
      runtime.useWriteTracking(writeTracking);
    }

    // Commit-values encoding (#13c-B): identical plumbing to the two dials
    // above — root-context anchor, createNext/createChild inheritance,
    // SubflowExecutor duck-push, resume-path re-application. Skipped for the
    // default 'full' — zero work, byte-identical commit log.
    const commitValues = args.commitValues;
    if (commitValues !== undefined && commitValues !== 'full') {
      runtime.useCommitValues(commitValues);
    }

    return new FlowchartTraverser<TOut, TScope>({
      root: effectiveRoot,
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
      flowRecorders: this.buildFlowRecordersList(),
      executionCounter: this._executionCounter,
      visitCounts: this._visitCounts,
      runId: this._currentRunId,
      ...(overrides?.subflowsOverride && { subflows: overrides.subflowsOverride }),
      ...(overrides?.subflowStatesForResume && {
        subflowStatesForResume: overrides.subflowStatesForResume,
      }),
      ...(maxDepth !== undefined && { maxDepth }),
      ...(maxIterations !== undefined && { maxIterations }),
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
   * Set the read-tracking policy for `StageSnapshot.stageReads` (#14).
   * Must be called before run(). Equivalent to the `readTracking`
   * constructor option — see {@link FlowChartExecutorOptions.readTracking}
   * for the mode semantics ('full' default / 'summary' / 'off').
   */
  setReadTracking(mode: ReadTrackingMode): void {
    this.flowChartArgs.readTracking = mode;
  }

  /**
   * Set the write-tracking policy for `StageSnapshot.stageWrites` (#13c-A).
   * Must be called before run(). Equivalent to the `writeTracking`
   * constructor option — see {@link FlowChartExecutorOptions.writeTracking}
   * for the mode semantics ('full' default / 'summary' / 'off'), the
   * onCommit-payload consequence, and the redaction-precedence rule.
   */
  setWriteTracking(mode: WriteTrackingMode): void {
    this.flowChartArgs.writeTracking = mode;
  }

  /**
   * Set the commit-values encoding policy for the commit log (#13c-B).
   * Must be called before run(). Equivalent to the `commitValues`
   * constructor option — see {@link FlowChartExecutorOptions.commitValues}
   * for the mode semantics ('full' default / 'delta'), the verb-qualified
   * `overwrite` consequence, and the `commitValueAt` migration helper.
   */
  setCommitValues(mode: CommitValuesMode): void {
    this.flowChartArgs.commitValues = mode;
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
   * It is fully DETACHED from engine state: every field was deep-copied at
   * pause time (see `buildPauseCheckpoint`). Holding, mutating, or persisting
   * it cannot affect the executor, and a later same-executor resume cannot
   * mutate a checkpoint you already stored.
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
   * Number of commits in the run's commit log. O(1) — direct length
   * read, no snapshot materialization. Use this to stamp commit
   * indices on observer events (e.g., `BoundaryRecorder` storing
   * `commitIdxBefore` / `commitIdxAfter` per domain event for
   * `CommitRangeIndex` queries — see `footprintjs/trace`).
   *
   * Returns 0 before any run; after, returns the cumulative commit
   * count across the executor's lifetime (including resumes).
   *
   * IMPLEMENTATION NOTE: this returns `runtime.executionHistory.length`,
   * which is the same value as `getSnapshot().commitLog.length`. The
   * naming asymmetry is historical — the underlying `EventLog` field
   * is named `executionHistory` but stores the `CommitBundle[]` that
   * `commitLog` exposes. They are the SAME array (verified by the
   * "matches commitLog.length" integration test).
   */
  getCommitCount(): number {
    const runtime = this.traverser.getRuntime() as InstanceType<typeof ExecutionRuntime> | undefined;
    return runtime?.executionHistory.length ?? 0;
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
    options?: Pick<RunOptions, 'signal' | 'env' | 'maxDepth' | 'maxIterations'>,
  ): Promise<ExecutorResult> {
    // Re-entrancy guard FIRST — resume() mutates the same per-run state run()
    // does (traverser, runId, checkpoint), so resume-during-run and
    // double-resume are the same corruption class as concurrent run().
    if (this._isExecuting) {
      throw new Error(
        'FlowChartExecutor: resume() called while another run()/resume() is in flight on this ' +
          'executor. An executor holds per-run state (runId, recorders, checkpoint) — create ' +
          'one executor per concurrent run. See docs/guides/execution-model.md.',
      );
    }
    // ── Validate checkpoint structure (may come from untrusted external storage) ──
    // (lastCheckpoint is wiped AFTER validation — a rejected checkpoint must
    // not destroy the executor's existing checkpoint state.)
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
    this.lastCheckpoint = undefined;

    // Build a synthetic resume node: calls resumeFn with resumeInput, then continues.
    // resumeFn signature is (scope, input) per PausableHandler — wrap to match StageFunction(scope, breakFn).
    const resumeFn = pausedNode.resumeFn;
    const resumeStageFn = (scope: TScope) => {
      return resumeFn(scope, resumeInput);
    };

    // Determine continuation: for branch children (decider/selector),
    // pausedNode.next is undefined. The checkpoint's
    // continuationStageId (collected during traversal bubble-up)
    // points to the invoker's next node.
    //
    // For pauses inside a subflow, the continuation lives INSIDE the
    // leaf subflow (e.g., the loop target back to `messages`). Search
    // the leaf subflow first; fall back to top-level for root-level
    // pauses.
    // Clone-in: `subflowStates` seeds nested runtimes in SubflowExecutor
    // (shallow-merged into each nested SharedMemory), so without a copy the
    // engine would hold live references into the caller's checkpoint object —
    // caller mutations would bleed into the resumed run and engine writes
    // would reach a checkpoint the caller may have already persisted.
    const sfStates = structuredClone(checkpoint.subflowStates);
    const leafSubflowId =
      checkpoint.subflowPath.length > 0 ? checkpoint.subflowPath[checkpoint.subflowPath.length - 1] : undefined;
    let continuationNext = pausedNode.next;
    // A branch-sourced loop (`{ loopTo }` / `DeciderList.loopTo`) sets the
    // looping branch's `next` to a loop-ref STUB — `{ id, isLoopRef:true }`
    // with no fn/children/subflowId. On a NORMAL run that stub resolves fine:
    // the real target node is reachable from the chart root, so the traverser's
    // node map already holds it (the stub is skipped — first-write-wins). On
    // RESUME the node map is built from the truncated resume root, where the
    // real target is unreachable, so the stub would win the id slot and
    // `executeNode` throws "Node '<target>' must define ...". Resolve the stub
    // to the REAL target node here (dfsFind skips loop-refs and returns the
    // real node WITH its full downstream chain — e.g. a subflow MOUNT node,
    // whose `.next` carries the decider/terminal continuation the loop must
    // re-enter). See test/lib/pause/resume-branch-loop-subflow.test.ts.
    if (continuationNext?.isLoopRef) {
      const loopTargetId = continuationNext.id;
      const realTarget =
        (leafSubflowId !== undefined ? this.findNodeInGraph(loopTargetId, checkpoint.subflowPath) : undefined) ??
        this.findNodeInGraph(loopTargetId, []);
      if (realTarget) continuationNext = realTarget;
    }
    if (!continuationNext && checkpoint.continuationStageId) {
      // Search leaf subflow first (loop targets / branch joins live there),
      // then fall back to top level.
      continuationNext = leafSubflowId
        ? this.findNodeInGraph(checkpoint.continuationStageId, checkpoint.subflowPath)
        : undefined;
      if (!continuationNext) {
        continuationNext = this.findNodeInGraph(checkpoint.continuationStageId, []);
      }
    }

    // The "inner" resume chain: resumeFn → continuation. This is what
    // runs INSIDE the leaf subflow's body. For a root-level pause
    // (subflowPath empty), this is also the top-level resume root.
    const innerResumeChain: StageNode<TOut, TScope> = {
      name: pausedNode.name,
      id: pausedNode.id,
      description: pausedNode.description,
      fn: resumeStageFn,
      next: continuationNext,
    };

    // Don't clear recorders — resume continues from previous state.
    // Narrative, metrics, debug entries accumulate across pause/resume.
    //
    // Two-mode resume:
    //   • Same-executor (run() previously called on THIS instance):
    //     reuse the existing runtime so the execution tree continues
    //     from the pause point and recorders/narrative accumulate.
    //   • Cross-executor (fresh executor reconstructed from a stored
    //     checkpoint): seed a NEW runtime from `checkpoint.sharedState`
    //     so resume handlers can read pre-pause scope. The execution
    //     tree starts at the resume node — we don't have the previous
    //     traversal's tree on a fresh process anyway.
    const sameExecutor = this._hasRunBefore;
    const existingRuntime = sameExecutor
      ? (this.traverser.getRuntime() as InstanceType<typeof ExecutionRuntime>)
      : undefined;
    this._hasRunBefore = true; // any path that resumes counts as a run
    // Resume gets a NEW runId — resume is logically a distinct run.
    // Original runId is recoverable from checkpoint metadata if a consumer
    // needs cross-run audit (we don't store it on the checkpoint today;
    // future enhancement). See `runId.ts`.
    this._currentRunId = generateRunId();

    // Pick the resume root + initial context.
    //
    //   ROOT-LEVEL PAUSE (subflowPath empty):
    //     resume root = innerResumeChain (run resumeFn at top level).
    //     initialContext = checkpoint.sharedState.
    //
    //   SUBFLOW-NESTED PAUSE (subflowPath non-empty):
    //     The pause was INSIDE a subflow's body. To run the subflow's
    //     outputMapper and the parent's continuation, we have to enter
    //     through the OUTER MOUNT (the parent's node that mounts the
    //     leaf subflow). We swap the leaf subflow's root with
    //     innerResumeChain so SubflowExecutor:
    //       1. enters the subflow boundary,
    //       2. seeds the nested runtime from subflowStates[leaf]
    //          (skipping the inputMapper — see SubflowExecutor.ts),
    //       3. runs the resumeFn → continuation chain,
    //       4. runs the outputMapper at exit,
    //       5. parent traversal continues normally.
    //
    //     Cross-executor: initialContext = checkpoint.sharedState (the
    //       parent's view at pause time — outputMapper writes back into it).
    //     Same-executor: existingRuntime is reused; initialContext is moot
    //       for the subflow frame (already in the runtime stack), but we
    //       still pass sharedState for consistency.
    const fc = this.flowChartArgs.flowChart;
    let resumeRoot: StageNode<TOut, TScope> = innerResumeChain;
    let subflowsOverride: Record<string, { root: StageNode<TOut, TScope> }> | undefined;
    if (leafSubflowId !== undefined) {
      // Find the OUTER mount node for the FIRST entry on the path.
      // For single-level pauses, this is the only mount we need to
      // enter through. For nested mounts the pattern would extend, but
      // single-level covers all current use cases (Sequence(Agent),
      // Conditional(Agent), Parallel branches with paused agents).
      const outerSubflowId = checkpoint.subflowPath[0];
      const outerMount = this.findMountInGraph(fc.root, outerSubflowId);
      if (outerMount) {
        resumeRoot = outerMount;
      }
      // Replace the leaf subflow's root with the resume chain so the
      // body runs from the pause point forward.
      subflowsOverride = { ...(fc.subflows ?? {}) };
      subflowsOverride[leafSubflowId] = { root: innerResumeChain };
    }
    // Clone-in for the same reason as `sfStates` above: `initialContext`
    // seeds the fresh SharedMemory via `mergeContextWins`, which copies only
    // the TOP level — nested objects would alias the caller's checkpoint.
    const resumeInitialContext = structuredClone(checkpoint.sharedState);

    this.traverser = this.createTraverser(
      options?.signal,
      undefined,
      options?.env,
      options?.maxDepth,
      options?.maxIterations,
      {
        root: resumeRoot,
        initialContext: resumeInitialContext,
        preserveRecorders: true,
        ...(existingRuntime ? { existingRuntime } : {}),
        // Hand the per-subflow scope captures down to SubflowExecutor.
        // Always present on a checkpoint — empty `{}` for root pauses.
        subflowStatesForResume: sfStates,
        ...(subflowsOverride && { subflowsOverride }),
      },
    );

    // Fire onResume event on all recorders (flow + scope). Stamp the
    // synthetic TraversalContext for the resumed stage with the NEW
    // runId so consumers detect "this is a fresh logical run" via
    // the same runId-change pattern they use for `onRunStart`.
    const hasInput = resumeInput !== undefined;
    const resumeRuntimeStageId = buildRuntimeStageId(pausedNode.id, this._executionCounter.value);
    const flowResumeEvent = {
      stageName: pausedNode.name,
      stageId: pausedNode.id,
      hasInput,
      traversalContext: {
        runId: this._currentRunId,
        stageId: pausedNode.id,
        runtimeStageId: resumeRuntimeStageId,
        stageName: pausedNode.name,
        depth: 0,
      },
      channel: 'flow' as const,
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
      channel: 'scope' as const,
    };
    for (const r of this.scopeRecorders) r.onResume?.(scopeResumeEvent);

    // Deferred tier (RFC-001): these executor-synthesized onResume events
    // bypass the per-stage dispatch sites, so capture them directly.
    if (this.deferredTier) {
      this.deferredTier.capture('flow', 'onResume', resumeRuntimeStageId, this._currentRunId, flowResumeEvent);
      this.deferredTier.capture(
        'scope',
        'onResume',
        scopeResumeEvent.runtimeStageId,
        scopeResumeEvent.pipelineId,
        scopeResumeEvent,
      );
    }

    // Set AFTER all sync validation/lookup throws above (nothing can leak the
    // flag); no await between the top-of-method check and here, so race-free.
    this._isExecuting = true;
    try {
      const result = await this.traverser.execute();
      // Terminal flush (RFC-001 Block 8) — same boundary contract as run().
      this.deferredTier?.terminalFlush();
      return result;
    } catch (error: unknown) {
      this.deferredTier?.terminalFlush();
      if (isPauseSignal(error)) {
        this.lastCheckpoint = this.buildPauseCheckpoint(error);
        return { paused: true, checkpoint: this.lastCheckpoint } satisfies PausedResult;
      }
      throw error;
    } finally {
      this._isExecuting = false;
    }
  }

  /**
   * Build a fully DETACHED checkpoint from a caught PauseSignal.
   *
   * Every field is deep-copied via one `structuredClone` of the assembled
   * checkpoint, because the raw pieces alias live engine state:
   *
   *   - `sharedState` IS `SharedMemory`'s internal context object — the alias
   *     only detaches at the next commit (`applySmartMerge` rebuilds it), and
   *     after a pause there is no next commit until resume.
   *   - `executionTree` nodes are fresh, but their `logs`/`errors`/`metrics`/
   *     `evals`/`stageReads`/`flowMessages` fields reference live
   *     `DiagnosticCollector` bags that keep accumulating on same-executor
   *     resume.
   *   - `subflowStates` values are shallow copies whose NESTED objects alias
   *     subflow memory, and they get seeded back into live runtimes on resume.
   *   - `subflowResults` values stay referenced by the traverser's results map.
   *
   * The checkpoint is persisted by contract ("store in Redis/Postgres") — it
   * must never share structure with the engine. Pause is not a hot path; the
   * clone cost is irrelevant.
   *
   * The JSON-safe checkpoint contract (no functions, no class instances)
   * governs CONSUMER-owned data — but the executionTree's diagnostic bags
   * accept ANY value at write time without cloning ($debug/$error/$metric/
   * $eval store raw references), so a contract-compliant run can still carry
   * a non-cloneable diagnostic. Observability side-bags never abort traversal
   * anywhere else in the library, so they must not abort the pause either:
   * on clone failure we sanitize the diagnostic bags (non-cloneable values
   * become '[non-serializable: …]' markers — the live engine bags are never
   * touched) and retry. If the retry STILL fails, the violation is in
   * consumer-owned data (realistically `pauseData` — a function can never
   * reach shared state in the first place: TransactionBuffer clones every
   * written value at write time, so the offending write already rejected)
   * and we throw a DESCRIPTIVE contract error naming the offending
   * checkpoint field(s). A naked DataCloneError never escapes.
   *
   * Subflow scope capture (`subflowStates`) survives ONLY on the signal — the
   * nested runtimes are GC'd as the stack unwinds. Promoting it onto the
   * checkpoint here lets cross-executor resume restore pre-pause subflow
   * scope (e.g. an Agent's `scope.history`). Empty `{}` for root-level pauses.
   */
  private buildPauseCheckpoint(signal: PauseSignal): FlowchartCheckpoint {
    const snapshot = this.traverser.getSnapshot();
    const sfResults = this.traverser.getSubflowResults();
    // Lean subflowResults for the checkpoint (design: docs/design/subflow-commit-visibility.md):
    //   • DROP the per-iteration mount-runtimeStageId keys ('#') that the snapshot dual-keys —
    //     they would DOUBLE the checkpoint, and resume restores scope from `subflowStates`, not these.
    //   • STRIP each subflow's `treeContext.history` — resume NEVER reads `subflowResults` (it
    //     restores from `subflowStates` + `sharedState`), so the per-subflow commit log is pure
    //     checkpoint bloat. The flat agent's checkpoint carries no commit history either → symmetric.
    const leanSubflowResults: Record<string, unknown> = {};
    for (const [key, value] of sfResults) {
      if (key.includes('#')) continue; // per-iteration keys are snapshot-only
      const v = value as unknown as { treeContext?: Record<string, unknown> };
      if (v?.treeContext) {
        const treeCtxRest: Record<string, unknown> = {};
        for (const ck of Object.keys(v.treeContext)) {
          if (ck !== 'history') treeCtxRest[ck] = v.treeContext[ck]; // strip the per-subflow commit log
        }
        leanSubflowResults[key] = { ...(value as unknown as Record<string, unknown>), treeContext: treeCtxRest };
      } else {
        leanSubflowResults[key] = value;
      }
    }
    const checkpoint = {
      sharedState: snapshot.sharedState,
      executionTree: snapshot.executionTree,
      pausedStageId: signal.stageId,
      subflowPath: signal.subflowPath,
      pauseData: signal.pauseData,
      subflowStates: signal.subflowStates,
      ...(Object.keys(leanSubflowResults).length > 0 && { subflowResults: leanSubflowResults }),
      // Invoker context — collected during traversal bubble-up (not tree-walked)
      ...(signal.invokerStageId && { invokerStageId: signal.invokerStageId }),
      ...(signal.continuationStageId && { continuationStageId: signal.continuationStageId }),
      pausedAt: Date.now(),
    };
    try {
      return structuredClone(checkpoint);
    } catch {
      // Non-cloneable diagnostics must not swallow the pause — sanitize the
      // executionTree's bags (markers replace the offenders) and retry.
      try {
        checkpoint.executionTree = sanitizeDiagnosticBags(checkpoint.executionTree as StageSnapshot);
        return structuredClone(checkpoint);
      } catch (retryError) {
        // Genuine JSON-safe contract violation in consumer-owned data.
        throw describeCheckpointCloneFailure(checkpoint, retryError);
      }
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

  /**
   * Find the mount node (the node that mounts a subflow boundary)
   * for a given subflowId, by DFS from `start`. Used by `resume()` to
   * locate the OUTER node we have to enter through so the subflow's
   * outputMapper and parent continuation execute.
   *
   * Cycle-safe via visited set. Returns the first match (DFS order).
   */
  private findMountInGraph(
    start: StageNode<TOut, TScope>,
    subflowId: string,
    visited = new Set<string>(),
  ): StageNode<TOut, TScope> | undefined {
    if (start.isLoopRef) return undefined;
    if (visited.has(start.id)) return undefined;
    visited.add(start.id);
    if (start.subflowId === subflowId) return start;
    if (start.children) {
      for (const child of start.children) {
        const found = this.findMountInGraph(child, subflowId, visited);
        if (found) return found;
      }
    }
    if (start.next) return this.findMountInGraph(start.next, subflowId, visited);
    return undefined;
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

  // ─── ScopeRecorder Management ───

  /**
   * Attach a scope ScopeRecorder to observe data operations (reads, writes, commits).
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
   * executor.attachScopeRecorder(new MetricRecorder());
   * executor.attachScopeRecorder(new DebugRecorder({ verbosity: 'minimal' }));
   *
   * // Override a framework-attached recorder by passing its well-known ID
   * executor.attachScopeRecorder(new MetricRecorder('metrics'));
   *
   * // Attaching twice with same ID replaces (no double-counting)
   * executor.attachScopeRecorder(new MetricRecorder('my-metrics'));
   * executor.attachScopeRecorder(new MetricRecorder('my-metrics')); // replaces previous
   * ```
   *
   * **Delivery tier (RFC-001):** pass `{ delivery: 'deferred' }` to take the
   * recorder out of the engine's hot path — events are captured into a
   * bounded queue and delivered at the next microtask checkpoint ("one beat
   * behind"). Omitting `delivery` keeps the historical synchronous call,
   * byte-identical to previous releases. Re-attaching the same `id` with a
   * different tier SWAPS tiers cleanly — never double delivery. See
   * `docs/guides/observers-deferred.md`.
   */
  attachScopeRecorder(recorder: ScopeRecorder, options?: AttachRecorderOptions): void {
    // Tier swap, both directions: an id lives on exactly ONE tier per list.
    this.scopeRecorders = this.scopeRecorders.filter((r) => r.id !== recorder.id);
    if (options?.delivery === 'deferred') {
      this.ensureDeferredTier(options).register(recorder, { scope: true }, options);
      return;
    }
    this.deferredTier?.removeFromLists(recorder.id, { scope: true });
    this.scopeRecorders.push(recorder);
  }

  /**
   * Lazily create the executor's ONE deferred-observer tier (one merged
   * queue, total event order across all three channels). The FIRST deferred
   * attach's options configure the dispatcher; later differing options are
   * dev-warned and ignored (see `AttachRecorderOptions`).
   */
  private ensureDeferredTier(options?: AttachRecorderOptions): DeferredObserverTier {
    if (!this.deferredTier) this.deferredTier = new DeferredObserverTier(options);
    return this.deferredTier;
  }

  // ─── Detach (T4) ─────────────────────────────────────────────────────────
  //
  // Bare-executor entry point for fire-and-forget child flowchart execution.
  // Use from outside any chart (consumer code that wants to detach work
  // without first running a parent chart). For detach FROM INSIDE a stage,
  // use `scope.$detachAndJoinLater(...)` / `scope.$detachAndForget(...)` —
  // those mint refIds from the calling stage's runtimeStageId for trace
  // correlation; the bare-executor entries use a synthetic prefix
  // (`__executor__`) instead.

  /**
   * Detach a child flowchart on the given driver and return a `DetachHandle`
   * the caller can `wait()` on (Promise) or read `.status` from (sync).
   *
   * The driver is a REQUIRED first argument — there is no library-default,
   * to keep the engine free of driver imports and to make the choice of
   * scheduling algorithm explicit at the call site.
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
   * Detach a child flowchart on the given driver and DISCARD the handle.
   * Use for telemetry exports / fire-and-forget side effects where the
   * caller doesn't care about the result.
   *
   * Errors raised by the child still land on the (discarded) handle — they
   * go silent unless surfaced through a recorder. For observable detach,
   * prefer `detachAndJoinLater` and surface failures via `.wait().catch()`.
   */
  detachAndForget(
    driver: import('../detach/types.js').DetachDriver,
    child: import('../builder/types.js').FlowChart,
    input?: unknown,
  ): void {
    _detachAndForget(driver, child, input, '__executor__');
  }

  /** Detach all scope Recorders with the given ID — both delivery tiers. */
  detachScopeRecorder(id: string): void {
    this.scopeRecorders = this.scopeRecorders.filter((r) => r.id !== id);
    this.deferredTier?.removeFromLists(id, { scope: true });
  }

  /** Returns a defensive copy of attached scope Recorders (both tiers). */
  getScopeRecorders(): ScopeRecorder[] {
    return [...this.scopeRecorders, ...(this.deferredTier?.scopeListRecorders() ?? [])];
  }

  // ─── FlowRecorder Management ───

  /**
   * Attach a FlowRecorder to observe control flow events.
   * Automatically enables narrative if not already enabled.
   * Must be called before run() — recorders are passed to the traverser at creation time.
   *
   * **Idempotent by ID:** replaces existing recorder with same `id`.
   *
   * **Delivery tier (RFC-001):** pass `{ delivery: 'deferred' }` for
   * next-checkpoint delivery off the hot path — see `attachScopeRecorder`.
   */
  attachFlowRecorder(recorder: FlowRecorder, options?: AttachRecorderOptions): void {
    // Tier swap, both directions: an id lives on exactly ONE tier per list.
    this.flowRecorders = this.flowRecorders.filter((r) => r.id !== recorder.id);
    this.narrativeEnabled = true;
    if (options?.delivery === 'deferred') {
      this.ensureDeferredTier(options).register(recorder, { flow: true }, options);
      return;
    }
    this.deferredTier?.removeFromLists(recorder.id, { flow: true });
    this.flowRecorders.push(recorder);
  }

  /** Detach all FlowRecorders with the given ID — both delivery tiers. */
  detachFlowRecorder(id: string): void {
    this.flowRecorders = this.flowRecorders.filter((r) => r.id !== id);
    this.deferredTier?.removeFromLists(id, { flow: true });
  }

  /** Returns a defensive copy of attached FlowRecorders (both tiers). */
  getFlowRecorders(): FlowRecorder[] {
    return [...this.flowRecorders, ...(this.deferredTier?.flowListRecorders() ?? [])];
  }

  // ─── Combined ScopeRecorder Management ───

  /**
   * Attach a recorder that may observe multiple event streams (scope
   * data-flow, control-flow, or both). Detects at runtime which streams the
   * recorder has methods for and routes it to the correct internal channels.
   *
   * Preferred over calling `attachScopeRecorder` and `attachFlowRecorder`
   * separately, because forgetting one of the two is a silent foot-gun —
   * half your events never fire and there is no runtime warning. With
   * `attachCombinedRecorder` the library guarantees the recorder's declared
   * methods all fire, and adds no overhead versus two explicit calls.
   *
   * ## Idempotency
   *
   * Idempotent by `id` across ALL channels — re-attaching with the same `id`
   * replaces the previous instance everywhere it was registered. Mixing
   * `attachCombinedRecorder(x)` with a prior `attachScopeRecorder(y)` or
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
  attachCombinedRecorder(recorder: CombinedRecorder, options?: AttachRecorderOptions): void {
    const hasData = hasRecorderMethods(recorder);
    const hasFlow = hasFlowRecorderMethods(recorder);
    const hasEmit = hasEmitRecorderMethods(recorder);

    // Delivery tier (RFC-001): options bag OR the recorder's own
    // `delivery: 'deferred'` field. The field is a string — channel routing
    // above counts event-METHOD properties only, so declaring it never
    // changes which channels the recorder lands on.
    const delivery = options?.delivery ?? recorder.delivery;
    const tierOptions: AttachRecorderOptions | undefined = delivery === undefined ? options : { ...options, delivery };

    // Emit recorders live on the SAME channel as data-flow recorders
    // (ScopeFacade iterates `_recorders` for onEmit dispatch). So
    // attachEmitRecorder internally calls attachScopeRecorder — but we want to
    // avoid double-attach when the recorder implements BOTH onEmit AND
    // other ScopeRecorder methods. Short-circuit: if hasData OR hasEmit, the
    // recorder lands on the scope-recorder list exactly once.
    if (hasData || hasEmit) this.attachScopeRecorder(recorder as ScopeRecorder, tierOptions);
    if (hasFlow) this.attachFlowRecorder(recorder as FlowRecorder, tierOptions);

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
    this.detachScopeRecorder(id);
    this.detachFlowRecorder(id);
  }

  // ─── Emit ScopeRecorder Management (Phase 3) ───

  /**
   * Attach an `EmitRecorder` — an observer for consumer-emitted structured
   * events fired via `scope.$emit(name, payload)`.
   *
   * Internally, emit recorders share the scope-recorder channel because
   * emit events fire from inside `ScopeFacade` during stage execution,
   * same timing as `onRead`/`onWrite`. This method is a convenience that
   * delegates to `attachScopeRecorder` — consumers can also use
   * `attachScopeRecorder` directly for a recorder that implements BOTH
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
  attachEmitRecorder(recorder: EmitRecorder, options?: AttachRecorderOptions): void {
    this.attachScopeRecorder(recorder as ScopeRecorder, options);
  }

  /** Detach an `EmitRecorder` by id. Safe to call if never attached. */
  detachEmitRecorder(id: string): void {
    this.detachScopeRecorder(id);
  }

  /**
   * Returns a defensive copy of attached recorders (both delivery tiers)
   * filtered to those that implement `onEmit`. Useful for inspection during
   * testing.
   */
  getEmitRecorders(): EmitRecorder[] {
    return this.getScopeRecorders().filter(
      (r): r is EmitRecorder => typeof (r as { onEmit?: unknown }).onEmit === 'function',
    );
  }

  /**
   * Returns structured narrative entries — the single public narrative API.
   * Each entry has a type (stage, step, condition, fork, etc.), text, and
   * depth. Consumers render however they want; call `.map(e => e.text)`
   * if a flat `string[]` is needed locally.
   */
  getNarrativeEntries(): CombinedNarrativeEntry[] {
    if (this.combinedRecorder) {
      return this.combinedRecorder.getEntries();
    }
    const flowSentences = this.traverser.getNarrative();
    return flowSentences.map((text) => ({ type: 'stage' as const, text, depth: 0 }));
  }

  /**
   * Returns the combined FlowRecorders list. When narrative is enabled,
   * includes the CombinedNarrativeRecorder (which builds merged flow+data
   * entries inline). Plus any user-attached recorders.
   */
  private buildFlowRecordersList(): FlowRecorder[] | undefined {
    const recorders: FlowRecorder[] = [];
    if (this.combinedRecorder) {
      recorders.push(this.combinedRecorder);
    }
    recorders.push(...this.flowRecorders);
    // Deferred-observer flow tap (RFC-001 Block 7) — captures every flow
    // event for deferred listeners. Appended like any other flow recorder,
    // so the FlowRecorderDispatcher site needs no tier logic of its own.
    const flowTap = this.deferredTier?.buildFlowTap();
    if (flowTap) recorders.push(flowTap);
    return recorders.length > 0 ? recorders : undefined;
  }

  async run(options?: RunOptions): Promise<ExecutorResult> {
    // Re-entrancy guard FIRST — before clearing recorders or touching any
    // per-run field, so a rejected concurrent call leaves the in-flight run
    // completely untouched.
    if (this._isExecuting) {
      throw new Error(
        'FlowChartExecutor: run() called while another run()/resume() is in flight on this ' +
          'executor. An executor holds per-run state (runId, recorders, checkpoint) — create ' +
          'one executor per concurrent run. See docs/guides/execution-model.md.',
      );
    }
    // Validate input against inputSchema if both are present. Validation runs
    // BEFORE the timeout timer is created so a rejected input can't leak a
    // pending timer (same "failed entry leaves no side effects" rule as the
    // re-entrancy guard above).
    let validatedInput = options?.input;
    if (validatedInput && this.flowChartArgs.flowChart.inputSchema) {
      validatedInput = validateInput(this.flowChartArgs.flowChart.inputSchema, validatedInput);
    }

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

    // User-attached recorders (flowRecorders + scopeRecorders) are cleared via clear() to prevent
    // cross-run accumulation. The combinedRecorder is NOT cleared here — createTraverser() always
    // creates a fresh CombinedNarrativeRecorder instance on each run, so stale state is never an issue.
    for (const r of this.flowRecorders) {
      r.clear?.();
    }
    for (const r of this.scopeRecorders) {
      r.clear?.();
    }
    this.deferredTier?.clearRecorders();

    this.lastCheckpoint = undefined;
    this._executionCounter = { value: 0 }; // Reset counter on fresh run
    this._visitCounts = new Map(); // Reset loop-iteration counts on fresh run (twin of _executionCounter)
    this._currentRunId = generateRunId(); // Fresh runId per run() call
    this._hasRunBefore = true; // mark so a later resume() takes the
    // same-executor branch (reuse runtime, accumulate execution tree).
    this.traverser = this.createTraverser(
      signal,
      validatedInput,
      options?.env,
      options?.maxDepth,
      options?.maxIterations,
    );
    // Set AFTER all sync validation throws (nothing above can leak the flag);
    // no await between the top-of-method check and here, so this is race-free.
    this._isExecuting = true;
    try {
      const result = await this.traverser.execute();
      // Terminal flush (RFC-001 Block 8) at the RESOLVE boundary: every
      // captured-but-undelivered observer event is delivered synchronously
      // before run() returns — "one beat behind" never becomes "lost at exit".
      this.deferredTier?.terminalFlush();
      return result;
    } catch (error: unknown) {
      // Terminal flush at the PAUSE and REJECT boundaries — this is the
      // OUTERMOST handler (a pause re-throws through subflow traversers
      // without exit events, so per-traverser hooks would miss it). Runs
      // before the checkpoint is exposed and before the error reaches the
      // caller.
      this.deferredTier?.terminalFlush();
      if (isPauseSignal(error)) {
        // Build a detached checkpoint from current execution state — see
        // buildPauseCheckpoint() for the deep-copy rationale.
        this.lastCheckpoint = this.buildPauseCheckpoint(error);
        // Return a PauseResult-shaped value so callers can check without try/catch
        return { paused: true, checkpoint: this.lastCheckpoint } satisfies PausedResult;
      }
      throw error;
    } finally {
      this._isExecuting = false;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  /**
   * Flush the deferred-observer backlog, then await async listener
   * completions under a deadline (RFC-001 Block 8 — the serverless /
   * graceful-shutdown pattern: call before the process freezes or exits so
   * "one beat behind" work is not lost). Resolves immediately with zeros
   * when no deferred observer was ever attached. `pending === 0` means a
   * full drain; a non-zero `pending` reports continuations (plus any queued
   * events) still outstanding at the deadline — honest, never silent.
   */
  drainObservers(opts?: { timeoutMs?: number }): Promise<ObserverDrainResult> {
    if (!this.deferredTier) return Promise.resolve({ done: 0, failed: 0, pending: 0 });
    return this.deferredTier.drain(opts);
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
   *
   * **Treat `sharedState` as READ-ONLY.** In production it is a live view of
   * the engine's working memory (zero copy cost) — mutating it corrupts
   * engine state. In dev mode (`enableDevMode()`) it is a deep-frozen CLONE,
   * so any consumer mutation throws loudly instead of corrupting silently.
   */
  getSnapshot(options?: { redact?: boolean }): RuntimeSnapshot {
    const snapshot = this.traverser.getSnapshot(options) as RuntimeSnapshot;
    if (isDevMode()) {
      // Dev-mode mutation guard: freeze a CLONE, never the live engine
      // state — `snapshot.sharedState` aliases SharedMemory's internal
      // context until the next commit rebuilds it (post-run: forever).
      // Production stays zero-copy; clone-always is a measured decision
      // deferred until the bench says it's affordable (BACKLOG #8).
      // NOTE: deepFreeze (reused from readonlyInput) freezes plain objects/
      // arrays only — Map/Set INTERNALS stay mutable (`map.set()` on the
      // frozen clone won't throw). The CLONE still isolates the engine.
      snapshot.sharedState = deepFreeze(structuredClone(snapshot.sharedState));
    }
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
    if (this.deferredTier) {
      // Deferred recorders are attached observers too — collect their
      // snapshots once per id (a combined recorder registers once in the
      // tier, unlike the two inline lists).
      const seen = new Set<string>();
      for (const r of [...this.deferredTier.scopeListRecorders(), ...this.deferredTier.flowListRecorders()]) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
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
    }
    if (recorderSnapshots.length > 0) {
      snapshot.recorders = recorderSnapshots;
    }

    // RFC-001 Block 9: the deferred-observer accounting surface. Present
    // ONLY when a deferred observer was attached on this executor —
    // zero-cost discipline for everyone else.
    if (this.deferredTier) {
      snapshot.observerStats = this.deferredTier.getStats();
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
