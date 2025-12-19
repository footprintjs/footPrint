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

export { FlowChartBuilder, flowChart } from './lib/builder';

export type {
  FlowChart,
  PipelineStageFunction as StageHandler,
  StreamHandlers,
} from './lib/builder';

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
export type { Recorder, ReadEvent, WriteEvent, CommitEvent, ErrorEvent } from './lib/scope';

// Zod-based scope definitions
export { defineScopeFromZod } from './lib/scope';

// ============================================================================
// Engine — Narrative (commonly used)
// ============================================================================

export { CombinedNarrativeBuilder } from './lib/engine';

// ============================================================================
// Memory — ScopeFactory type (needed for FlowChartExecutor constructor)
// ============================================================================

export type { ScopeFactory } from './lib/memory';
export type { RunOptions } from './lib/engine';
