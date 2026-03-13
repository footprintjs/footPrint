/* istanbul ignore file */
export type { CombinedNarrativeEntry, CombinedNarrativeOptions } from './CombinedNarrativeBuilder';
export { CombinedNarrativeBuilder } from './CombinedNarrativeBuilder';
export type { CombinedNarrativeRecorderOptions } from './CombinedNarrativeRecorder';
export { CombinedNarrativeRecorder } from './CombinedNarrativeRecorder';
export { ControlFlowNarrativeGenerator } from './ControlFlowNarrativeGenerator';
export { NullControlFlowNarrativeGenerator } from './NullControlFlowNarrativeGenerator';
export type { IControlFlowNarrative } from './types';

// FlowRecorder system
export { FlowRecorderDispatcher } from './FlowRecorderDispatcher';
export { NarrativeFlowRecorder } from './NarrativeFlowRecorder';
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
} from './types';

// Built-in FlowRecorder strategies (tree-shakeable — only imported code ships)
export { AdaptiveNarrativeFlowRecorder } from './recorders/AdaptiveNarrativeFlowRecorder';
export { MilestoneNarrativeFlowRecorder } from './recorders/MilestoneNarrativeFlowRecorder';
export { ProgressiveNarrativeFlowRecorder } from './recorders/ProgressiveNarrativeFlowRecorder';
export { RLENarrativeFlowRecorder } from './recorders/RLENarrativeFlowRecorder';
export { SeparateNarrativeFlowRecorder } from './recorders/SeparateNarrativeFlowRecorder';
export { SilentNarrativeFlowRecorder } from './recorders/SilentNarrativeFlowRecorder';
export { WindowedNarrativeFlowRecorder } from './recorders/WindowedNarrativeFlowRecorder';
