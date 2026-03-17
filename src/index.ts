/**
 * FootPrint — Public API
 *
 * Connected causal trace library for LLM pipelines.
 * Builds flowcharts, executes them via DFS traversal, and captures
 * every stage's context (state, decisions, errors) in an auditable trace.
 *
 * For advanced/internal APIs (memory primitives, engine handlers, providers),
 * import from 'footprint/advanced'.
 */

// ============================================================================
// Builder — Flowchart construction
// ============================================================================

export type { FlowChart, PipelineStageFunction as StageHandler, StreamHandlers } from './lib/builder/index.js';
export { flowChart, FlowChartBuilder } from './lib/builder/index.js';

// ============================================================================
// Runner — Execution convenience layer
// ============================================================================

export { FlowChartExecutor } from './lib/runner/index.js';

// ComposableRunner — interface for runners that expose their internal flowChart
// for subflow composition (enables UI drill-down into nested runners)
export type { ComposableRunner } from './lib/runner/index.js';

// Snapshot navigation — drill into subflow subtrees by path
export type { SubtreeSnapshot } from './lib/runner/index.js';
export { getSubtreeSnapshot, listSubflowPaths } from './lib/runner/index.js';

// ============================================================================
// Scope — Per-stage facades and recorders
// ============================================================================

export { ScopeFacade } from './lib/scope/index.js';

// Recorders
export { MetricRecorder } from './lib/scope/index.js';
export { DebugRecorder } from './lib/scope/index.js';
export { NarrativeRecorder } from './lib/scope/index.js';

// Recorder interface and core event types (needed to implement custom Recorder)
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
// Engine — Narrative (commonly used)
// ============================================================================

export type { CombinedNarrativeEntry } from './lib/engine/index.js';
export { CombinedNarrativeBuilder } from './lib/engine/index.js';

// FlowRecorder — Pluggable observer for control flow events (mirrors scope Recorder)
export type {
  FlowErrorEvent,
  FlowLoopEvent,
  FlowRecorder,
  FlowSubflowEvent,
  FlowSubflowRegisteredEvent,
} from './lib/engine/index.js';
export { NarrativeFlowRecorder } from './lib/engine/index.js';

// Structured error extraction — preserves field-level details through the pipeline
export type { StructuredErrorInfo } from './lib/engine/index.js';
export { extractErrorInfo, formatErrorInfo } from './lib/engine/index.js';

// Built-in FlowRecorder strategies (tree-shakeable — import only what you use)
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
// Memory — ScopeFactory type (needed for FlowChartExecutor constructor)
// ============================================================================

export type { ExecutionEnv, RunOptions } from './lib/engine/index.js';
export type { ScopeFactory } from './lib/memory/index.js';

// ============================================================================
// Contract — I/O boundary, schemas, and OpenAPI generation
// ============================================================================

export type {
  FlowChartContract,
  FlowChartContractOptions,
  JsonSchema,
  OpenAPIOptions,
  OpenAPISpec,
} from './lib/contract/index.js';
export { defineContract } from './lib/contract/index.js';
export { normalizeSchema, zodToJsonSchema } from './lib/contract/index.js';
export { generateOpenAPI } from './lib/contract/index.js';

// ============================================================================
// Schema — Unified detection, validation, and structured errors
// ============================================================================

export type { SchemaKind, ValidationIssue, ValidationResult } from './lib/schema/index.js';
export { detectSchema, isValidatable, isZod } from './lib/schema/index.js';
export { InputValidationError, validateAgainstSchema, validateOrThrow } from './lib/schema/index.js';
