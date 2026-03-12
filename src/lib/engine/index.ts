/* istanbul ignore file */
/**
 * engine/ — Graph traversal engine library.
 *
 * Executes flowcharts built by FlowChartBuilder via pre-order DFS traversal.
 * Handles linear, fork, decider, selector, loop, and subflow node shapes.
 */

// Core traverser
export type { TraverserOptions } from './traversal/FlowchartTraverser';
export { FlowchartTraverser } from './traversal/FlowchartTraverser';

// Graph node types (Decider, Selector, StageNode re-exported via ./types)
export { isStageNodeReturn } from './graph/StageNode';

// Types
export * from './types';

// Handlers (for advanced use cases and testing)
export * from './handlers';

// Narrative generation
export type { CombinedNarrativeEntry, CombinedNarrativeOptions } from './narrative/CombinedNarrativeBuilder';
export { CombinedNarrativeBuilder } from './narrative/CombinedNarrativeBuilder';
export { ControlFlowNarrativeGenerator } from './narrative/ControlFlowNarrativeGenerator';
export { NullControlFlowNarrativeGenerator } from './narrative/NullControlFlowNarrativeGenerator';
export type { IControlFlowNarrative } from './narrative/types';

// FlowRecorder system
export { FlowRecorderDispatcher } from './narrative/FlowRecorderDispatcher';
export { NarrativeFlowRecorder } from './narrative/NarrativeFlowRecorder';
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
} from './narrative/types';

// Structured error extraction
export type { StructuredErrorInfo } from './errors/errorInfo';
export { extractErrorInfo, formatErrorInfo } from './errors/errorInfo';

// Built-in FlowRecorder strategies (tree-shakeable)
export { AdaptiveNarrativeFlowRecorder } from './narrative/recorders/AdaptiveNarrativeFlowRecorder';
export type { ManifestEntry } from './narrative/recorders/ManifestFlowRecorder';
export { ManifestFlowRecorder } from './narrative/recorders/ManifestFlowRecorder';
export { MilestoneNarrativeFlowRecorder } from './narrative/recorders/MilestoneNarrativeFlowRecorder';
export { ProgressiveNarrativeFlowRecorder } from './narrative/recorders/ProgressiveNarrativeFlowRecorder';
export { RLENarrativeFlowRecorder } from './narrative/recorders/RLENarrativeFlowRecorder';
export { SeparateNarrativeFlowRecorder } from './narrative/recorders/SeparateNarrativeFlowRecorder';
export { SilentNarrativeFlowRecorder } from './narrative/recorders/SilentNarrativeFlowRecorder';
export { WindowedNarrativeFlowRecorder } from './narrative/recorders/WindowedNarrativeFlowRecorder';
