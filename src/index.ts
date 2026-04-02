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
export { flowChart, FlowChartBuilder } from './lib/builder/index.js';

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
  Recorder,
  RedactionPolicy,
  RedactionReport,
  WriteEvent,
} from './lib/scope/index.js';

/** @category Observe — Data */
export { MetricRecorder } from './lib/scope/index.js';

/** @category Observe — Data */
export { DebugRecorder } from './lib/scope/index.js';

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
  FlowSelectedEvent,
  FlowStageEvent,
  FlowSubflowEvent,
  FlowSubflowRegisteredEvent,
  TraversalContext,
} from './lib/engine/index.js';

/** @category Observe — Flow */
export type { CombinedNarrativeEntry } from './lib/engine/index.js';

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
// Recorder Composition — Bundle multiple recorders into domain presets
// ============================================================================

/** @category Recorder */
export { CompositeRecorder } from './lib/recorder/index.js';

/** @category Recorder */
export type { CompositeSnapshot } from './lib/recorder/index.js';

// ============================================================================
// Configuration — Types passed to FlowChartExecutor and run()
// ============================================================================

/** @category Configuration */
export type { ExecutionEnv, RunOptions } from './lib/engine/index.js';

/** @category Configuration */
export type { ScopeFactory } from './lib/engine/index.js';

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

/** @category Dev Tools */
export { disableDevMode, enableDevMode } from './lib/scope/detectCircular.js';

/** @category Dev Tools */
export { defineScopeFromZod } from './lib/scope/index.js';
