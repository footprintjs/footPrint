/**
 * FootPrint — Public API (v2.0)
 *
 * The flowchart pattern for backend code.
 * Build → Describe → Run.
 *
 * For advanced/internal APIs, import from 'footprintjs/advanced'.
 * For recorder factories, import from 'footprintjs/recorders'.
 */

// ============================================================================
// Builder — Flowchart construction
// ============================================================================

export type { FlowChart, StageFunction as StageHandler, StreamHandlers } from './lib/builder/index.js';
export { flowChart, FlowChartBuilder } from './lib/builder/index.js';

// TypedScope — typed property access (no casts needed)
export type { TypedStageFunction } from './lib/builder/typedFlowChart.js';
export type { ScopeMethods, TypedScope } from './lib/reactive/index.js';

// Decision reasoning capture
export type {
  DecideRule,
  DecisionEvidence,
  DecisionResult,
  FilterOps,
  SelectionResult,
  WhereFilter,
} from './lib/decide/index.js';
export { decide, select } from './lib/decide/index.js';

// ============================================================================
// Runner — v2 API: chart.recorder().run()
// ============================================================================

// narrative() — core recorder factory, exported here for the common case:
//   import { flowChart, decide, narrative } from 'footprintjs';
//   const result = await chart.recorder(narrative()).run();
export type { RunResult } from './lib/runner/index.js';
export { FlowChartExecutor } from './lib/runner/index.js';
export { RunContext } from './lib/runner/index.js';
export type {
  OpenAPIOptions as ChartOpenAPIOptions,
  MCPToolDescription,
  RunnableFlowChart,
} from './lib/runner/RunnableChart.js';
export { narrative } from './recorders.js';

// ComposableRunner — interface for subflow composition
export type { ComposableRunner } from './lib/runner/index.js';

// Snapshot navigation
export type { RecorderSnapshot, RuntimeSnapshot, SubtreeSnapshot } from './lib/runner/index.js';
export { getSubtreeSnapshot, listSubflowPaths } from './lib/runner/index.js';

// ============================================================================
// Scope — Per-stage facades and recorders
// ============================================================================

export { ScopeFacade } from './lib/scope/index.js';

// Dev-mode diagnostics
export { disableDevMode, enableDevMode } from './lib/scope/detectCircular.js';

// Recorders (class exports — prefer factory functions from footprintjs/recorders)
export { MetricRecorder } from './lib/scope/index.js';
export { DebugRecorder } from './lib/scope/index.js';

// Recorder interface and event types (for custom recorders)
export type {
  CommitEvent,
  ErrorEvent,
  ReadEvent,
  Recorder,
  RedactionPolicy,
  RedactionReport,
  WriteEvent,
} from './lib/scope/index.js';

// Zod-based scope definitions
export { defineScopeFromZod } from './lib/scope/index.js';

// ============================================================================
// Engine — Narrative types
// ============================================================================

export type { CombinedNarrativeEntry } from './lib/engine/index.js';

// FlowRecorder — Pluggable observer for control flow events
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
export { NarrativeFlowRecorder } from './lib/engine/index.js';

// Structured errors
export type { StructuredErrorInfo } from './lib/engine/index.js';
export { extractErrorInfo, formatErrorInfo } from './lib/engine/index.js';

// Built-in FlowRecorder strategies (prefer factory functions from footprintjs/recorders)
export type { ManifestEntry } from './lib/engine/index.js';
export { ManifestFlowRecorder } from './lib/engine/index.js';
export { AdaptiveNarrativeFlowRecorder } from './lib/engine/index.js';
export { MilestoneNarrativeFlowRecorder } from './lib/engine/index.js';
export { ProgressiveNarrativeFlowRecorder } from './lib/engine/index.js';
export { RLENarrativeFlowRecorder } from './lib/engine/index.js';
export { SeparateNarrativeFlowRecorder } from './lib/engine/index.js';
export { SilentNarrativeFlowRecorder } from './lib/engine/index.js';
export { WindowedNarrativeFlowRecorder } from './lib/engine/index.js';

// ============================================================================
// Engine types
// ============================================================================

export type { ExecutionEnv, RunOptions } from './lib/engine/index.js';
export type { ScopeFactory } from './lib/memory/index.js';

// ============================================================================
// Contract types (use .contract() on builder + chart.toOpenAPI() instead)
// ============================================================================

export type {
  FlowChartContract,
  FlowChartContractOptions,
  JsonSchema,
  OpenAPIOptions,
  OpenAPISpec,
} from './lib/contract/index.js';

// ============================================================================
// Schema — Validation
// ============================================================================

export type { SchemaKind, ValidationIssue, ValidationResult } from './lib/schema/index.js';
export { detectSchema, isValidatable, isZod } from './lib/schema/index.js';
export { InputValidationError, validateAgainstSchema, validateOrThrow } from './lib/schema/index.js';
