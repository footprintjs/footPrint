/* istanbul ignore file */
/**
 * engine/ — Graph traversal engine library.
 *
 * Executes flowcharts built by FlowChartBuilder via pre-order DFS traversal.
 * Handles linear, fork, decider, selector, loop, and subflow node shapes.
 */

// Core traverser
export { FlowchartTraverser } from './traversal/FlowchartTraverser';
export type { TraverserOptions } from './traversal/FlowchartTraverser';

// Graph node types
export type { StageNode, Decider, Selector } from './graph/StageNode';
export { isStageNodeReturn } from './graph/StageNode';

// Types
export * from './types';

// Handlers (for advanced use cases and testing)
export * from './handlers';

// Narrative generation
export type { IControlFlowNarrative } from './narrative/types';
export { ControlFlowNarrativeGenerator } from './narrative/ControlFlowNarrativeGenerator';
export { NullControlFlowNarrativeGenerator } from './narrative/NullControlFlowNarrativeGenerator';
export { CombinedNarrativeBuilder } from './narrative/CombinedNarrativeBuilder';
export type { CombinedNarrativeEntry, CombinedNarrativeOptions } from './narrative/CombinedNarrativeBuilder';
