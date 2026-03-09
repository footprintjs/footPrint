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

export type { FlowChart, PipelineStageFunction as StageHandler, StreamHandlers } from './lib/builder';
export { flowChart, FlowChartBuilder } from './lib/builder';

// ============================================================================
// Runner — Execution convenience layer
// ============================================================================

export { FlowChartExecutor } from './lib/runner';

// ============================================================================
// Scope — Per-stage facades and recorders
// ============================================================================

export { ScopeFacade } from './lib/scope';

// Recorders
export { MetricRecorder } from './lib/scope';
export { DebugRecorder } from './lib/scope';
export { NarrativeRecorder } from './lib/scope';

// Recorder interface and core event types (needed to implement custom Recorder)
export type {
  CommitEvent,
  ErrorEvent,
  ReadEvent,
  Recorder,
  RedactionPolicy,
  RedactionReport,
  WriteEvent,
} from './lib/scope';

// Zod-based scope definitions
export { defineScopeFromZod } from './lib/scope';

// ============================================================================
// Engine — Narrative (commonly used)
// ============================================================================

export type { CombinedNarrativeEntry } from './lib/engine';
export { CombinedNarrativeBuilder } from './lib/engine';

// FlowRecorder — Pluggable observer for control flow events (mirrors scope Recorder)
export type { FlowLoopEvent, FlowRecorder } from './lib/engine';
export { NarrativeFlowRecorder } from './lib/engine';

// Built-in FlowRecorder strategies (tree-shakeable — import only what you use)
export { AdaptiveNarrativeFlowRecorder } from './lib/engine';
export { MilestoneNarrativeFlowRecorder } from './lib/engine';
export { ProgressiveNarrativeFlowRecorder } from './lib/engine';
export { RLENarrativeFlowRecorder } from './lib/engine';
export { SeparateNarrativeFlowRecorder } from './lib/engine';
export { SilentNarrativeFlowRecorder } from './lib/engine';
export { WindowedNarrativeFlowRecorder } from './lib/engine';

// ============================================================================
// Memory — ScopeFactory type (needed for FlowChartExecutor constructor)
// ============================================================================

export type { RunOptions } from './lib/engine';
export type { ScopeFactory } from './lib/memory';

// ============================================================================
// Contract — I/O boundary, schemas, and OpenAPI generation
// ============================================================================

export type {
  FlowChartContract,
  FlowChartContractOptions,
  JsonSchema,
  OpenAPIOptions,
  OpenAPISpec,
} from './lib/contract';
export { defineContract } from './lib/contract';
export { normalizeSchema, zodToJsonSchema } from './lib/contract';
export { generateOpenAPI } from './lib/contract';
