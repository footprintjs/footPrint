/**
 * IControlFlowNarrative — Interface for control flow narrative generation.
 *
 * Captures FLOW events during traversal: decisions, forks, loops, subflows.
 * Complementary to scope/recorders/NarrativeRecorder which captures DATA events.
 *
 * @module
 */

import type { DecisionEvidence, SelectionEvidence } from '../../decide/types.js';
import type { StructuredErrorInfo } from '../errors/errorInfo.js';

/**
 *
 * Uses Null Object pattern: NullControlFlowNarrativeGenerator satisfies this
 * interface with empty methods for zero-cost disabled path.
 */

export interface IControlFlowNarrative {
  /** Called when a stage executes. First stage uses distinct opening pattern. */
  onStageExecuted(stageName: string, description?: string, traversalContext?: TraversalContext): void;

  /** Called on linear continuation from one stage to the next. */
  onNext(fromStage: string, toStage: string, description?: string, traversalContext?: TraversalContext): void;

  /** Called when a decider selects a branch. Most valuable for LLM context. */
  onDecision(
    deciderName: string,
    chosenBranch: string,
    rationale?: string,
    deciderDescription?: string,
    traversalContext?: TraversalContext,
    evidence?: DecisionEvidence,
  ): void;

  /** Called when a fork executes all children in parallel. */
  onFork(parentStage: string, childNames: string[], traversalContext?: TraversalContext): void;

  /** Called when a selector picks a subset of children. */
  onSelected(
    parentStage: string,
    selectedNames: string[],
    totalCount: number,
    traversalContext?: TraversalContext,
    evidence?: SelectionEvidence,
  ): void;

  /** Called when entering a subflow (nested context boundary). */
  onSubflowEntry(
    subflowName: string,
    subflowId?: string,
    description?: string,
    traversalContext?: TraversalContext,
    mappedInput?: Record<string, unknown>,
  ): void;

  /** Called when exiting a subflow. */
  onSubflowExit(
    subflowName: string,
    subflowId?: string,
    traversalContext?: TraversalContext,
    outputState?: Record<string, unknown>,
  ): void;

  /** Called when a dynamic subflow is registered during traversal. */
  onSubflowRegistered(subflowId: string, name: string, description?: string, specStructure?: unknown): void;

  /** Called on loop iteration (back-edge traversal). */
  onLoop(targetStage: string, iteration: number, description?: string, traversalContext?: TraversalContext): void;

  /**
   * Called when a stage triggers break (early termination).
   *
   * @param reason - Optional string passed to `scope.$break(reason)`.
   * @param propagatedFromSubflow - When set, this break was raised on the
   *   parent because an inner subflow (this id) broke with `propagateBreak`
   *   enabled. Used by recorders to distinguish originating vs propagated
   *   breaks and render them accordingly.
   */
  onBreak(
    stageName: string,
    traversalContext?: TraversalContext,
    reason?: string,
    propagatedFromSubflow?: string,
  ): void;

  /** Called when a stage throws an error. Raw error is extracted into structured details. */
  onError(stageName: string, errorMessage: string, error: unknown, traversalContext?: TraversalContext): void;

  /** Called when a pausable stage pauses execution. */
  onPause(
    stageName: string,
    stageId: string,
    pauseData: unknown,
    subflowPath: readonly string[],
    traversalContext?: TraversalContext,
  ): void;

  /** Called when a paused stage is resumed. */
  onResume(stageName: string, stageId: string, hasInput: boolean, traversalContext?: TraversalContext): void;

  /** Returns accumulated narrative sentences in execution order. */
  getSentences(): string[];
}

// ============================================================================
// TraversalContext — read-only execution context from the traverser.
// ============================================================================

/**
 * Traversal context attached to every FlowRecorder event.
 * Created by the traverser during DFS, passed to recorders as read-only data.
 * Enables recorders to build trees, group by subflow, and correlate events
 * without maintaining their own stacks or post-processing.
 *
 * Like OpenTelemetry's span context: stageId + parentStageId form a tree.
 */
export interface TraversalContext {
  /** Stable stage identifier from the builder (matches spec node id). */
  readonly stageId: string;
  /** Unique per-execution-step identifier. Format: [subflowPath/]stageId#executionIndex */
  readonly runtimeStageId: string;
  /** Human-readable stage name. */
  readonly stageName: string;
  /** Parent stage ID — walk up to reconstruct the tree. Undefined at root. */
  readonly parentStageId?: string;
  /** Subflow ID when inside a subflow. Undefined at root level. */
  readonly subflowId?: string;
  /** Full subflow path for nested subflows (e.g., "sf-outer/sf-inner"). */
  readonly subflowPath?: string;
  /** Nesting depth (0 = root, 1 = inside first subflow, etc.). */
  readonly depth: number;
  /** Loop iteration number when revisiting a node via loopTo. */
  readonly loopIteration?: number;
  /** Fork branch ID when inside a parallel or decider branch. */
  readonly forkBranch?: string;
}

// ============================================================================
// FlowRecorder — Pluggable observer for control flow events.
// ============================================================================

/** Event passed to FlowRecorder.onStageExecuted. */
export interface FlowStageEvent {
  stageName: string;
  description?: string;
  /** Traversal context from the engine — read-only, set by traverser. */
  traversalContext?: TraversalContext;
}

/** Event passed to FlowRecorder.onNext. */
export interface FlowNextEvent {
  from: string;
  to: string;
  description?: string;
  traversalContext?: TraversalContext;
}

/** Event passed to FlowRecorder.onDecision. */
export interface FlowDecisionEvent {
  decider: string;
  chosen: string;
  rationale?: string;
  description?: string;
  traversalContext?: TraversalContext;
  /** Structured decision evidence from decide() helper. */
  evidence?: DecisionEvidence;
}

/** Event passed to FlowRecorder.onFork. */
export interface FlowForkEvent {
  parent: string;
  children: string[];
  traversalContext?: TraversalContext;
}

/** Event passed to FlowRecorder.onSelected. */
export interface FlowSelectedEvent {
  parent: string;
  selected: string[];
  total: number;
  traversalContext?: TraversalContext;
  /** Structured selection evidence from select() helper. */
  evidence?: SelectionEvidence;
}

/** Event passed to FlowRecorder.onSubflow. */
export interface FlowSubflowEvent {
  name: string;
  /** Subflow identifier — use this to look up the full spec via the manifest. */
  subflowId?: string;
  /** Build-time description of what this subflow does. */
  description?: string;
  traversalContext?: TraversalContext;
  /** Mapped input values sent INTO the subflow (from inputMapper/inputKeys). Present on entry events. */
  mappedInput?: Record<string, unknown>;
  /** Subflow shared state at exit. Present on exit events. */
  outputState?: Record<string, unknown>;
}

/** Event passed to FlowRecorder.onSubflowRegistered (dynamic subflow attachment). */
export interface FlowSubflowRegisteredEvent {
  /** Subflow identifier. */
  subflowId: string;
  /** Human-readable name. */
  name: string;
  /** Build-time description. */
  description?: string;
  /** Full spec structure (when available from buildTimeStructure). */
  specStructure?: unknown;
  traversalContext?: TraversalContext;
}

/** Event passed to FlowRecorder.onLoop. */
export interface FlowLoopEvent {
  target: string;
  iteration: number;
  description?: string;
  traversalContext?: TraversalContext;
}

/** Event passed to FlowRecorder.onBreak. */
export interface FlowBreakEvent {
  stageName: string;
  traversalContext?: TraversalContext;
  /**
   * Optional free-form reason supplied by `scope.$break(reason)`. Absent
   * when the stage invoked `$break()` without an argument. Propagates when
   * a subflow is mounted with `propagateBreak: true` — the outer break
   * event carries the inner break's reason too.
   */
  reason?: string;
  /**
   * When true, this break event was raised on the PARENT because an inner
   * subflow's break propagated up (via `SubflowMountOptions.propagateBreak`).
   * The originating inner break fires its own `onBreak` event separately
   * — this flag lets recorders distinguish the two.
   */
  propagatedFromSubflow?: string;
}

/** Event passed to FlowRecorder.onError. */
export interface FlowErrorEvent {
  stageName: string;
  message: string;
  /** Structured error details — preserves field-level issues, error codes, etc. */
  structuredError: StructuredErrorInfo;
  traversalContext?: TraversalContext;
}

/** Event passed to FlowRecorder.onPause. */
export interface FlowPauseEvent {
  stageName: string;
  stageId: string;
  /** Data from the pause signal (question, reason, metadata). */
  pauseData?: unknown;
  /** Path through subflows to the paused stage. Empty at root level. */
  subflowPath: readonly string[];
  traversalContext?: TraversalContext;
}

/** Event passed to FlowRecorder.onResume. */
export interface FlowResumeEvent {
  stageName: string;
  stageId: string;
  /** Whether resume input was provided. */
  hasInput: boolean;
  traversalContext?: TraversalContext;
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
  /** Called when a dynamic subflow is registered during traversal. */
  onSubflowRegistered?(event: FlowSubflowRegisteredEvent): void;
  onLoop?(event: FlowLoopEvent): void;
  onBreak?(event: FlowBreakEvent): void;
  onError?(event: FlowErrorEvent): void;
  onPause?(event: FlowPauseEvent): void;
  onResume?(event: FlowResumeEvent): void;
  /** Called before each run to reset per-run state. Implement for stateful recorders. */
  clear?(): void;
  /** Optional: expose collected data for inclusion in snapshots. */
  toSnapshot?(): {
    name: string;
    description?: string;
    preferredOperation?: 'translate' | 'accumulate' | 'aggregate';
    data: unknown;
  };
}
