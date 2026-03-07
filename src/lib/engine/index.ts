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
