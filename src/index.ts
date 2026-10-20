/**
 * FootPrint — Public API (v3)
 *
 * The flowchart pattern for backend code.
 * Build → Run → Observe.
 *
 * **The common import paths:**
 * ```ts
 * import { flowChart, decide, narrative } from 'footprintjs';           // main — start here
 * import { metrics, debug, manifest }     from 'footprintjs/recorders'; // recorder factories
 * import { stateAt, causalChain } from 'foottrace';     // read a finished run
 * import { RecordFrame, EventLog } from 'foottrace/write';     // write a record yourself
 * import { StageContext }                 from 'footprintjs/advanced';  // engine internals
 * ```
 *
 * @module
 */

// ============================================================================
// Quick Start — Everything you need for 90% of use cases
// ============================================================================

/** @category Quick Start */
export type { FlowChart, StageFunction as StageHandler, StreamHandlers } from './lib/builder/index.js';

/** @category Quick Start */
export { flowChart, FlowChartBuilder, flowChartSelector } from './lib/builder/index.js';

/**
 * @category Quick Start
 *
 * Config for `.addParallelForEach()` — one branch per item, branch count
 * decided at run time from the payload. `maxBranches` and `into` are required
 * on purpose (see docs/design/execution-control.md).
 */
export type { BranchChart, ParallelForEachConfig, RetryPolicy } from './lib/builder/index.js';

/** @category Quick Start — build-time observer (twin of FlowRecorder) */
export type {
  StructureDeciderCompleteEvent,
  StructureEdgeAddedEvent,
  StructureEdgeKind,
  StructureLoopEdgeAddedEvent,
  StructureRecorder,
  StructureStageAddedEvent,
  StructureStageTaggedEvent,
  StructureSubflowMountedEvent,
} from './lib/builder/index.js';

/**
 * @category Time Budget
 *
 * `timeBudget(chart)` — the slowest a chart can take, from its declared retry policies (`attempts × timeoutMs` plus
 * the waits, summed along the slowest path), and every stage that makes a path unbounded, by name. `.budget(ms)`
 * declares the caller's contract; `build()` refuses a chart that cannot keep it. Also `chart.timeBudget()`.
 */
export type {
  BudgetAssumptions,
  BudgetStep,
  TimeBudgetOptions,
  TimeBudgetReport,
  UnboundedReason,
  UnboundedStage,
} from './lib/budget/index.js';
export { timeBudget } from './lib/budget/index.js';

/** @category Quick Start */
export type { TypedStageFunction } from './lib/builder/typedFlowChart.js';

/** @category Quick Start */
export type { ScopeMethods, TypedScope } from './lib/reactive/index.js';

/** @category Quick Start */
export { narrative } from './recorders.js';

// ============================================================================
// Decision Branching — decide() / select() with evidence capture
// ============================================================================

/** @category Decision Branching */
export type {
  DecideRule,
  DecisionEvidence,
  DecisionResult,
  DefaultBranch,
  FilterOps,
  RuleEvidence,
  SelectionEvidence,
  SelectionResult,
  WhenClause,
  WhereFilter,
} from './lib/decide/index.js';

/** @category Decision Branching */
export { decide, select } from './lib/decide/index.js';

/** @category Errors */
export type { TerminalFailureContext } from './lib/errors/terminalFailure.js';

// ============================================================================
// Attempts — every try of a retried stage, and the decision that followed it
// ============================================================================

/**
 * @category Attempts
 *
 * One `AttemptRecord` per attempt of a stage with a declared `retry` policy, a `timeoutMs`, or a run deadline —
 * timing, outcome, failure category, and the retry-or-stop decision as `DecisionEvidence` — on the stage's
 * execution-tree node (`StageSnapshot.attempts` / `attemptSummary`) and on `FlowRecorder.onAttempt`.
 * A call a stage makes through `scope.$call` is recorded the same way (kind `'call'`), and so is an SDK's own retry
 * an adapter reports through `observed()` (`ObservedAttempt`, kind `'observed'`). `AttemptContext` is what
 * `scope.$attempt()` returns, and what a call's function gets (the attempt's signal, the time left, `observed`);
 * `LateWrite` is a write (or call) an ended attempt tried (`StageSnapshot.lateWrites`). A stage that changes an
 * outside system declares it (`StageTouches`, `.touches()`), and a call does (`CallOptions`): every attempt then
 * carries its `AttemptEffect`, and the key rule is handed an `IdempotencyKeyContext` once per execution.
 */
export type {
  AttemptCategory,
  AttemptContext,
  AttemptEffect,
  AttemptError,
  AttemptInputs,
  AttemptKind,
  AttemptNext,
  AttemptOptions,
  AttemptOutcome,
  AttemptReason,
  AttemptRecord,
  AttemptSummary,
  CallOptions,
  IdempotencyKeyContext,
  LateWrite,
  ObservedAttempt,
  StageTouches,
  UnknownEffectInit,
} from './lib/attempt/index.js';
/**
 * @category Attempts
 *
 * An attempt by name (`series` + `attempt`) and per-outcome counts — what recorder rows hold of attempts.
 */
export type { AttemptOutcomeCounts, AttemptRef } from './lib/recorder/attemptSeries.js';

/**
 * @category Attempts
 *
 * `attempt()` — the attempt runner for code that is not a stage (records go to its `onAttempt`); `errorCategory`
 * — the one failure classifier (seven fixed categories); `retryRules` — the one retry rule table, as `decide()`
 * rules; the attempt contract's two errors.
 */
export { attempt, AttemptTimeoutError, errorCategory, retryRules, UnknownEffectError } from './lib/attempt/index.js';

/**
 * @category Correlation
 *
 * The run's correlation (10.1): `env.traceparent` (W3C, parsed strictly) or `env.traceId` + `env.operationId`
 * become ONE frozen `RunCorrelation` per run — on `getSnapshot().correlation`, every flow event's
 * `traversalContext.correlation` and every scope and emit event's `correlation`. `parseTraceparent` /
 * `formatTraceparent` are the W3C codec; a refused header throws `TraceparentError` with a named `reason`.
 */
export type { ParsedTraceparent, RunCorrelation, TraceparentFields, TraceparentRefusal } from './lib/attempt/index.js';
export { formatTraceparent, parseTraceparent, TraceparentError } from './lib/attempt/index.js';

// ============================================================================
// Run — Execute charts and collect results
// ============================================================================

/** @category Run */
export type { RunResult } from './lib/runner/index.js';

/** @category Run */
export type { FlowChartExecutorOptions } from './lib/runner/index.js';

/**
 * The crash-safe record (10.1): the executor's `sink` option, its accounting on `getSnapshot().sink`,
 * `executor.flushRecord()`'s result, and the error a run with `onFailure: 'fail'` rejects with. The port
 * (`RecordSink`, `memorySink`) is `foottrace/write`'s; the file adapter is `footprintjs/sinks`.
 * @category Run
 */
export type {
  RecordFlushResult,
  RecordSinkFailureMode,
  RecordSinkFlushMode,
  RecordSinkOption,
  RecordSinkOptions,
  RecordSinkStats,
} from './lib/runner/index.js';
/** @category Run */
export { RecordSinkError } from './lib/runner/index.js';

/**
 * The four observability dials `FlowChartExecutorOptions` inherits.
 * @category Run
 */
export type { RunDials } from './lib/memory/index.js';

/** @category Run */
export { FlowChartExecutor } from './lib/runner/index.js';

/** @category Run */
export { RunContext } from './lib/runner/index.js';

/** @category Run */
export type { ChartOpenAPIOptions, MCPToolDescription, RunnableFlowChart } from './lib/runner/RunnableChart.js';

// ============================================================================
// Observe — Data (scope recorders, fire during stage execution)
// ============================================================================

/** @category Observe — Data */
export type {
  CommitEvent,
  ErrorEvent,
  ReadEvent,
  RedactionPolicy,
  RedactionReport,
  ScopeRecorder,
  StageEvent,
  WriteEvent,
} from './lib/scope/index.js';

/** @category Observe — Data */
export { MetricRecorder } from './lib/scope/index.js';

/** @category Observe — Data */
export { DebugRecorder } from './lib/scope/index.js';

/** @category Observe — Operation */
export { RecorderOperation } from './lib/recorder/index.js';

/**
 * @category Observe — Delivery tier (RFC-001 deferred observers)
 *
 * Every `attach*Recorder` call accepts an options bag:
 * `executor.attachScopeRecorder(rec, { delivery: 'deferred' })` takes the
 * recorder OUT of the engine's hot path — events are captured into one
 * bounded, totally-ordered queue and delivered at the next microtask
 * checkpoint ("one beat behind"). Omit `delivery` for the historical
 * synchronous call (byte-identical to previous releases). Accounting
 * surfaces on `snapshot.observerStats`; `executor.drainObservers()` settles
 * async listeners before shutdown. See `docs/guides/observers-deferred.md`.
 */
export type {
  AttachRecorderOptions,
  ObserverDelivery,
  ObserverDrainResult,
  ObserverStats,
} from './lib/runner/index.js';

/**
 * @category Observe — Delivery tier (RFC-001 deferred observers)
 *
 * `CapturePolicy` — how a deferred event's payload is materialized at
 * capture time (`'clone'` by default for attach options / `'summary'` / `'ref'`). `OverflowPolicy`
 * — what a saturated queue does (`'drop-oldest'` default / `'sample'` /
 * `'block'`). `DispatcherStats` / `ListenerStats` — the accounting shapes
 * embedded in `ObserverStats`. Types only — the observer-queue module
 * itself is internal; consumers use the attach options.
 */
export type { CapturePolicy, DispatcherStats, ListenerStats, OverflowPolicy } from './lib/observer-queue/index.js';

/** @category Observe — Combined (both data-flow and control-flow) */
export type { CombinedRecorder } from './lib/recorder/index.js';
/** @category Observe — Combined (both data-flow and control-flow) */
export {
  hasEmitRecorderMethods,
  hasFlowRecorderMethods,
  hasRecorderMethods,
  isFlowEvent,
} from './lib/recorder/index.js';

/**
 * @category Observe — Emit (user-authored structured events)
 *
 * Third observer channel (alongside `ScopeRecorder` and `FlowRecorder`). Consumer
 * code calls `scope.$emit(name, payload)` from inside a stage; every attached
 * `EmitRecorder.onEmit(event)` fires synchronously with stage-context
 * enrichment. Pass-through — no buffering, zero allocation when no recorder
 * is attached.
 */
export type { EmitEvent, EmitRecorder } from './lib/recorder/index.js';

// ============================================================================
// Observe — Flow (FlowRecorder, fires after stage execution)
// ============================================================================

/** @category Observe — Flow */
export type {
  FlowAttemptEvent,
  FlowBreakEvent,
  FlowDecisionEvent,
  FlowErrorEvent,
  FlowForkEvent,
  FlowLoopEvent,
  FlowNextEvent,
  FlowRecorder,
  FlowRunEvent,
  FlowRunFailedEvent,
  FlowSelectedEvent,
  FlowStageEvent,
  FlowStageRetryEvent,
  FlowSubflowEvent,
  FlowSubflowRegisteredEvent,
  FlowThrottledEvent,
  ResumeLink,
  TraversalContext,
} from './lib/engine/index.js';

/** @category Observe — Flow */
export type { CombinedNarrativeEntry } from './lib/engine/index.js';

/**
 * @category Observe — Flow
 *
 * `NarrativeFormatter` — pluggable formatter that converts event context
 * objects into the text lines of the narrative.
 */
export type { NarrativeFormatter } from './lib/engine/index.js';

/** @category Observe — Flow */
export { NarrativeFlowRecorder } from './lib/engine/index.js';

/** @category Observe — Flow */
export type { ManifestAttemptRow, ManifestEntry } from './lib/engine/index.js';

/** @category Observe — Flow */
export { ManifestFlowRecorder } from './lib/engine/index.js';

/** @category Observe — Flow */
export { AdaptiveNarrativeFlowRecorder } from './lib/engine/index.js';

/** @category Observe — Flow */
export { MilestoneNarrativeFlowRecorder } from './lib/engine/index.js';

/** @category Observe — Flow */
export { ProgressiveNarrativeFlowRecorder } from './lib/engine/index.js';

/** @category Observe — Flow */
export { RLENarrativeFlowRecorder } from './lib/engine/index.js';

/** @category Observe — Flow */
export { SeparateNarrativeFlowRecorder } from './lib/engine/index.js';

/** @category Observe — Flow */
export { SilentNarrativeFlowRecorder } from './lib/engine/index.js';

/** @category Observe — Flow */
export { WindowedNarrativeFlowRecorder } from './lib/engine/index.js';

// ============================================================================
// Self-Describing — .contract(), toOpenAPI(), toMCPTool()
// ============================================================================

/** @category Self-Describing */
export type { JsonSchema } from './lib/contract/index.js';

// ============================================================================
// Snapshot & Composition — Subflow navigation and ComposableRunner
// ============================================================================

/** @category Snapshot & Composition */
export type { ComposableRunner } from './lib/runner/index.js';

/** @category Snapshot & Composition */
export type { RecorderSnapshot, RuntimeSnapshot, SubtreeSnapshot } from './lib/runner/index.js';

/** @category Snapshot & Composition */
export { getSubtreeSnapshot, listSubflowPaths } from './lib/runner/index.js';

// ============================================================================
// ScopeRecorder Composition — Bundle multiple recorders into domain presets
// ============================================================================

/** @category ScopeRecorder */
export { CompositeRecorder } from './lib/recorder/index.js';

// ============================================================================
// Pause/Resume — Serializable checkpoints for long-running or human-in-the-loop flows
// ============================================================================

/** @category Pause/Resume */
/** @category Pause/Resume */
export type {
  FlowchartCheckpoint,
  PausableHandler,
  PausedExecution,
  PendingPause,
  RedactionMarks,
} from './lib/pause/index.js';

/**
 * @category Pause/Resume
 *
 * `interrupt(scope, { reason, expects? })` — stop mid-stage to ask a question,
 * and get the answer back at the same call site when the run resumes. Resume
 * re-enters the stage from its TOP (stages are atomic), so keep the half
 * before the call idempotent.
 */
export type { InterruptPayload } from './lib/pause/index.js';

/** @category Pause/Resume */
export { interrupt } from './lib/pause/index.js';

/** @category ScopeRecorder */
export type { CompositeSnapshot } from './lib/recorder/index.js';

// ============================================================================
// Configuration — Types passed to FlowChartExecutor and run()
// ============================================================================

/** @category Configuration */
export type { ExecutionEnv, ExecutorResult, PausedResult, RunOptions } from './lib/engine/index.js';

/** @category Configuration */
export type { ScopeFactory } from './lib/engine/index.js';

/**
 * @category Configuration
 *
 * Read-tracking policy for `StageSnapshot.stageReads` (#14):
 * `'full'` (default — per-read value clone, historical behavior) /
 * `'summary'` (cheap `ReadSummaryMarker` per read) / `'off'` (no tracking,
 * zero per-read clone). Pass as `new FlowChartExecutor(chart, { readTracking })`
 * or call `executor.setReadTracking(mode)` before `run()`.
 */
export type { ReadSummaryMarker, ReadTrackingMode } from './lib/memory/index.js';

/**
 * @category Configuration
 *
 * Write-tracking policy for `StageSnapshot.stageWrites` (#13c-A) — the
 * sibling of `ReadTrackingMode`; both alias the shared `RetentionPolicy`
 * family from `lib/capture`. `'full'` (default — per-write value clone,
 * historical behavior) / `'summary'` (cheap `WriteSummaryMarker` per write)
 * / `'off'` (no tracking; `stageWrites` absent and the `onCommit` mutations
 * payload is empty — writes themselves still commit, and the commit log is
 * unaffected). Pass as `new FlowChartExecutor(chart, { writeTracking })` or
 * call `executor.setWriteTracking(mode)` before `run()`.
 */
export type { RetentionPolicy, WriteSummaryMarker, WriteTrackingMode } from './lib/memory/index.js';

/**
 * @category Configuration
 *
 * Commit-values encoding for the COMMIT LOG (#13c-B) — the third dial of
 * the family, and the only LOSSLESS one (it changes the log's encoding,
 * never its information). `'full'` (default — every surviving `set` stores
 * the full final value, byte-identical to history) / `'delta'` (array
 * net-changes that are "base plus a tail" commit as an `append` verb
 * storing only the tail; `deleteValue()` commits as a real `delete` verb;
 * one trace entry per surviving path). Replay reconstructs every step's
 * full state exactly. Consumers reading `bundle.overwrite[key]` as the full
 * value must use `commitValueAt` from `foottrace`. Pass as
 * `new FlowChartExecutor(chart, { commitValues })` or call
 * `executor.setCommitValues(mode)` before `run()`; the active mode is the
 * snapshot discriminant `getSnapshot().commitValues`.
 */

// ============================================================================
// Contract & Validation
// ============================================================================

/** @category Contract & Validation */
export type { SchemaKind, ValidationIssue, ValidationResult } from './lib/schema/index.js';

/** @category Contract & Validation */
export { detectSchema, isValidatable, isZod } from './lib/schema/index.js';

/** @category Contract & Validation */
export { InputValidationError, validateAgainstSchema, validateOrThrow } from './lib/schema/index.js';

// ============================================================================
// Error Utilities
// ============================================================================

/** @category Error Utilities */
export type { StructuredErrorInfo } from './lib/engine/index.js';

/** @category Error Utilities */
export { extractErrorInfo, formatErrorInfo } from './lib/engine/index.js';

// ============================================================================
// Dev Tools — Mode flags and Zod scope utilities
// ============================================================================

/**
 * @category Dev Tools
 *
 * Global dev-mode flag. Call `enableDevMode()` at application startup to
 * turn on developer-only diagnostics across the library — circular-reference
 * detection in scope writes, warnings when a recorder has no observer
 * methods, suspicious-predicate warnings in decide/select, structural
 * checks in `getSubtreeSnapshot`, and any future dev-only diagnostic.
 *
 * Production leaves it OFF by default (zero overhead). See the JSDoc on
 * `enableDevMode` for the full list and usage example.
 */
export { disableDevMode, enableDevMode, isDevMode } from './lib/devMode.js';

// `defineScopeFromZod` and the other zod-based scope helpers moved to the opt-in
// `footprintjs/zod` entry — keeping zod out of the core load path (it is an
// optional peer). Import them from 'footprintjs/zod'.
// A run's record as JSON without the engine's recursion limit (9.26.0): the
// same bytes JSON.stringify emits, for a deep `next` chain it cannot encode.
export type { RetryLoopCall, RetryLoopDecision, RetryLoopIdentity } from './lib/attempt/retryLoopTypes.js';
export type { RetryLoopContext, RetryLoopOptions, RetryLoopState } from './lib/builder/retryLoop.js';
export type {
  CaptureChannel,
  CaptureLimitation,
  NativeCaptureNote,
  RecorderCaptureAcknowledgement,
} from './lib/capture/nativeCoverage.js';
export { stringifySnapshot } from './lib/runner/stringifySnapshot.js';
