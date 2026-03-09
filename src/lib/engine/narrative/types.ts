/**
 * IControlFlowNarrative — Interface for control flow narrative generation.
 *
 * Captures FLOW events during traversal: decisions, forks, loops, subflows.
 * Complementary to scope/recorders/NarrativeRecorder which captures DATA events.
 *
 * Uses Null Object pattern: NullControlFlowNarrativeGenerator satisfies this
 * interface with empty methods for zero-cost disabled path.
 */

export interface IControlFlowNarrative {
  /** Called when a stage executes. First stage uses distinct opening pattern. */
  onStageExecuted(stageName: string, description?: string): void;

  /** Called on linear continuation from one stage to the next. */
  onNext(fromStage: string, toStage: string, description?: string): void;

  /** Called when a decider selects a branch. Most valuable for LLM context. */
  onDecision(deciderName: string, chosenBranch: string, rationale?: string, deciderDescription?: string): void;

  /** Called when a fork executes all children in parallel. */
  onFork(parentStage: string, childNames: string[]): void;

  /** Called when a selector picks a subset of children. */
  onSelected(parentStage: string, selectedNames: string[], totalCount: number): void;

  /** Called when entering a subflow (nested context boundary). */
  onSubflowEntry(subflowName: string): void;

  /** Called when exiting a subflow. */
  onSubflowExit(subflowName: string): void;

  /** Called on loop iteration (back-edge traversal). */
  onLoop(targetStage: string, iteration: number, description?: string): void;

  /** Called when a stage triggers break (early termination). */
  onBreak(stageName: string): void;

  /** Called when a stage throws an error. */
  onError(stageName: string, errorMessage: string): void;

  /** Returns accumulated narrative sentences in execution order. */
  getSentences(): string[];
}

// ============================================================================
// FlowRecorder — Pluggable observer for control flow events.
// ============================================================================

/** Event passed to FlowRecorder.onStageExecuted. */
export interface FlowStageEvent {
  stageName: string;
  description?: string;
}

/** Event passed to FlowRecorder.onNext. */
export interface FlowNextEvent {
  from: string;
  to: string;
  description?: string;
}

/** Event passed to FlowRecorder.onDecision. */
export interface FlowDecisionEvent {
  decider: string;
  chosen: string;
  rationale?: string;
  description?: string;
}

/** Event passed to FlowRecorder.onFork. */
export interface FlowForkEvent {
  parent: string;
  children: string[];
}

/** Event passed to FlowRecorder.onSelected. */
export interface FlowSelectedEvent {
  parent: string;
  selected: string[];
  total: number;
}

/** Event passed to FlowRecorder.onSubflow. */
export interface FlowSubflowEvent {
  name: string;
}

/** Event passed to FlowRecorder.onLoop. */
export interface FlowLoopEvent {
  target: string;
  iteration: number;
  description?: string;
}

/** Event passed to FlowRecorder.onBreak. */
export interface FlowBreakEvent {
  stageName: string;
}

/** Event passed to FlowRecorder.onError. */
export interface FlowErrorEvent {
  stageName: string;
  message: string;
}

/**
 * FlowRecorder — Pluggable observer for control flow events.
 *
 * Mirrors the scope-level Recorder pattern for the engine layer.
 * All methods are optional — implement only the hooks you need.
 * Recorders are invoked synchronously in attachment order.
 * If a recorder throws, the error is caught and swallowed; execution continues.
 *
 * @example
 * ```typescript
 * const metricsRecorder: FlowRecorder = {
 *   id: 'metrics',
 *   onLoop: (event) => recordMetric('loop.iteration', event.iteration),
 *   onDecision: (event) => recordMetric('decision', event.chosen),
 * };
 * executor.attachFlowRecorder(metricsRecorder);
 * ```
 */
export interface FlowRecorder {
  readonly id: string;
  onStageExecuted?(event: FlowStageEvent): void;
  onNext?(event: FlowNextEvent): void;
  onDecision?(event: FlowDecisionEvent): void;
  onFork?(event: FlowForkEvent): void;
  onSelected?(event: FlowSelectedEvent): void;
  onSubflowEntry?(event: FlowSubflowEvent): void;
  onSubflowExit?(event: FlowSubflowEvent): void;
  onLoop?(event: FlowLoopEvent): void;
  onBreak?(event: FlowBreakEvent): void;
  onError?(event: FlowErrorEvent): void;
}
