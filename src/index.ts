/**
 * FootPrint — Public API (v3)
 *
 * The flowchart pattern for backend code.
 * Build → Run → Observe.
 *
 * **Three import paths:**
 * ```ts
 * import { flowChart, decide, narrative } from 'footprintjs';           // main — start here
 * import { metrics, debug, manifest }     from 'footprintjs/recorders'; // recorder factories
 * import { SharedMemory, StageContext }   from 'footprintjs/advanced';  // internals
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

/** @category Quick Start — build-time observer (twin of FlowRecorder) */
export type {
  StructureDeciderCompleteEvent,
  StructureEdgeAddedEvent,
  StructureEdgeKind,
  StructureLoopEdgeAddedEvent,
  StructureRecorder,
  StructureStageAddedEvent,
  StructureSubflowMountedEvent,
} from './lib/builder/index.js';

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
  FilterOps,
  RuleEvidence,
  SelectionEvidence,
  SelectionResult,
  WhenClause,
  WhereFilter,
} from './lib/decide/index.js';

/** @category Decision Branching */
export { decide, select } from './lib/decide/index.js';

// ============================================================================
// Run — Execute charts and collect results
// ============================================================================

/** @category Run */
export type { RunResult } from './lib/runner/index.js';

/** @category Run */
export type { FlowChartExecutorOptions } from './lib/runner/index.js';

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
 * capture time (`'summary'` default / `'clone'` / `'ref'`). `OverflowPolicy`
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
  FlowSubflowEvent,
  FlowSubflowRegisteredEvent,
  TraversalContext,
} from './lib/engine/index.js';

/** @category Observe — Flow */
export type { CombinedNarrativeEntry } from './lib/engine/index.js';

/**
 * @category Observe — Flow
 *
 * `NarrativeFormatter` — pluggable formatter that converts event context
 * objects into the text lines of the narrative. Prefer this name in new
 * code; `NarrativeRenderer` is a deprecated alias that will be removed in
 * the next major release.
 */
export type { NarrativeFormatter, NarrativeRenderer } from './lib/engine/index.js';

/** @category Observe — Flow */
export { NarrativeFlowRecorder } from './lib/engine/index.js';

/** @category Observe — Flow */
export type { ManifestEntry } from './lib/engine/index.js';

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
export type {
  FlowChartContract,
  FlowChartContractOptions,
  JsonSchema,
  OpenAPIOptions,
  OpenAPISpec,
} from './lib/contract/index.js';

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
export type { FlowchartCheckpoint, PausableHandler } from './lib/pause/index.js';

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
 * value must use `commitValueAt` from `footprintjs/trace`. Pass as
 * `new FlowChartExecutor(chart, { commitValues })` or call
 * `executor.setCommitValues(mode)` before `run()`; the active mode is the
 * snapshot discriminant `getSnapshot().commitValues`.
 */
export type { CommitValuesMode } from './lib/memory/index.js';

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
export { disableDevMode, enableDevMode, isDevMode } from './lib/scope/detectCircular.js';

// `defineScopeFromZod` and the other zod-based scope helpers moved to the opt-in
// `footprintjs/zod` entry — keeping zod out of the core load path (it is an
// optional peer). Import them from 'footprintjs/zod'.
