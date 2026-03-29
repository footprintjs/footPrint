/* istanbul ignore file */
/**
 * engine/ — Graph traversal engine library.
 *
 * Executes flowcharts built by FlowChartBuilder via pre-order DFS traversal.
 * Handles linear, fork, decider, selector, loop, and subflow node shapes.
 */

// Core traverser
export type { TraverserOptions } from './traversal/FlowchartTraverser.js';
export { FlowchartTraverser } from './traversal/FlowchartTraverser.js';

// Graph node types (Decider, Selector, StageNode re-exported via ./types)
export { isStageNodeReturn } from './graph/StageNode.js';

// Types
export * from './types.js';

// Handlers (for advanced use cases and testing)
export * from './handlers/index.js';

// Narrative generation
export type { CombinedNarrativeEntry, CombinedNarrativeOptions } from './narrative/narrativeTypes.js';
export { NullControlFlowNarrativeGenerator } from './narrative/NullControlFlowNarrativeGenerator.js';
export type { IControlFlowNarrative } from './narrative/types.js';

// FlowRecorder system
export { FlowRecorderDispatcher } from './narrative/FlowRecorderDispatcher.js';
export { NarrativeFlowRecorder } from './narrative/NarrativeFlowRecorder.js';
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
} from './narrative/types.js';

// Structured error extraction
export type { StructuredErrorInfo } from './errors/errorInfo.js';
export { extractErrorInfo, formatErrorInfo } from './errors/errorInfo.js';

// Built-in FlowRecorder strategies (tree-shakeable)
export { AdaptiveNarrativeFlowRecorder } from './narrative/recorders/AdaptiveNarrativeFlowRecorder.js';
export type { ManifestEntry } from './narrative/recorders/ManifestFlowRecorder.js';
export { ManifestFlowRecorder } from './narrative/recorders/ManifestFlowRecorder.js';
export { MilestoneNarrativeFlowRecorder } from './narrative/recorders/MilestoneNarrativeFlowRecorder.js';
export { ProgressiveNarrativeFlowRecorder } from './narrative/recorders/ProgressiveNarrativeFlowRecorder.js';
export { RLENarrativeFlowRecorder } from './narrative/recorders/RLENarrativeFlowRecorder.js';
export { SeparateNarrativeFlowRecorder } from './narrative/recorders/SeparateNarrativeFlowRecorder.js';
export { SilentNarrativeFlowRecorder } from './narrative/recorders/SilentNarrativeFlowRecorder.js';
export { WindowedNarrativeFlowRecorder } from './narrative/recorders/WindowedNarrativeFlowRecorder.js';
