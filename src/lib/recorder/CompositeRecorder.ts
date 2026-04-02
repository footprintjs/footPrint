/**
 * CompositeRecorder — fan-out a single recorder attachment to multiple child recorders.
 *
 * Implements both Recorder (scope data ops) and FlowRecorder (control flow events)
 * so it works with both `executor.attachRecorder()` and `executor.attachFlowRecorder()`.
 *
 * The composite has a single ID for idempotent attach/detach. Child recorders
 * keep their own IDs internally but are not individually visible to the executor.
 *
 * Domain libraries (e.g., agentfootprint) use this to bundle multiple recorders
 * into a single preset — the consumer calls one function, gets full observability.
 *
 * @example
 * ```typescript
 * import { CompositeRecorder, MetricRecorder, DebugRecorder } from 'footprintjs';
 *
 * // Bundle metrics + debug into a single recorder
 * const observability = new CompositeRecorder('observability', [
 *   new MetricRecorder({ stageFilter: (name) => name === 'CallLLM' }),
 *   new DebugRecorder({ verbosity: 'minimal' }),
 * ]);
 *
 * executor.attachRecorder(observability);
 *
 * // Access child recorders by type
 * const metrics = observability.get(MetricRecorder);
 * metrics?.getMetrics(); // timing data
 * ```
 *
 * @example
 * ```typescript
 * // Domain library preset (e.g., agentfootprint)
 * export function agentObservability(options?: AgentObservabilityOptions) {
 *   return new CompositeRecorder('agent-observability', [
 *     new MetricRecorder(options?.stageFilter ? { stageFilter: options.stageFilter } : undefined),
 *     new TokenRecorder(),
 *     new ToolUsageRecorder(),
 *   ]);
 * }
 *
 * // Consumer
 * executor.attachRecorder(agentObservability());
 * ```
 */

import type {
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
} from '../engine/narrative/types.js';
import type { CommitEvent, ErrorEvent, ReadEvent, Recorder, StageEvent, WriteEvent } from '../scope/types.js';

/** Snapshot format for composite recorders — wraps child snapshots. */
export interface CompositeSnapshot {
  name: string;
  data: {
    children: Array<{ id: string; name: string; data: unknown }>;
  };
}

export class CompositeRecorder implements Recorder, FlowRecorder {
  readonly id: string;
  private readonly children: Array<Recorder | FlowRecorder>;

  constructor(id: string, children: Array<Recorder | FlowRecorder>) {
    this.id = id;
    this.children = [...children];
  }

  // ── Child access ──────────────────────────────────────────────────────

  /**
   * Get a child recorder by class type.
   *
   * @example
   * ```typescript
   * const metrics = composite.get(MetricRecorder);
   * ```
   */
  get<T>(type: new (...args: any[]) => T): T | undefined {
    return this.children.find((c) => c instanceof type) as T | undefined;
  }

  /** Get all child recorders. */
  getChildren(): ReadonlyArray<Recorder | FlowRecorder> {
    return this.children;
  }

  // ── Scope Recorder hooks (fan-out to children that implement Recorder) ─

  onRead(event: ReadEvent): void {
    for (const c of this.children) if ((c as Recorder).onRead) (c as Recorder).onRead!(event);
  }

  onWrite(event: WriteEvent): void {
    for (const c of this.children) if ((c as Recorder).onWrite) (c as Recorder).onWrite!(event);
  }

  onCommit(event: CommitEvent): void {
    for (const c of this.children) if ((c as Recorder).onCommit) (c as Recorder).onCommit!(event);
  }

  onError(event: ErrorEvent | FlowErrorEvent): void {
    for (const c of this.children) if ((c as Recorder).onError) (c as Recorder).onError!(event as any);
  }

  onStageStart(event: StageEvent): void {
    for (const c of this.children) if ((c as Recorder).onStageStart) (c as Recorder).onStageStart!(event);
  }

  onStageEnd(event: StageEvent): void {
    for (const c of this.children) if ((c as Recorder).onStageEnd) (c as Recorder).onStageEnd!(event);
  }

  // ── FlowRecorder hooks (fan-out to children that implement FlowRecorder) ─

  onStageExecuted(event: FlowStageEvent): void {
    for (const c of this.children) if ((c as FlowRecorder).onStageExecuted) (c as FlowRecorder).onStageExecuted!(event);
  }

  onNext(event: FlowNextEvent): void {
    for (const c of this.children) if ((c as FlowRecorder).onNext) (c as FlowRecorder).onNext!(event);
  }

  onDecision(event: FlowDecisionEvent): void {
    for (const c of this.children) if ((c as FlowRecorder).onDecision) (c as FlowRecorder).onDecision!(event);
  }

  onFork(event: FlowForkEvent): void {
    for (const c of this.children) if ((c as FlowRecorder).onFork) (c as FlowRecorder).onFork!(event);
  }

  onSelected(event: FlowSelectedEvent): void {
    for (const c of this.children) if ((c as FlowRecorder).onSelected) (c as FlowRecorder).onSelected!(event);
  }

  onSubflowEntry(event: FlowSubflowEvent): void {
    for (const c of this.children) if ((c as FlowRecorder).onSubflowEntry) (c as FlowRecorder).onSubflowEntry!(event);
  }

  onSubflowExit(event: FlowSubflowEvent): void {
    for (const c of this.children) if ((c as FlowRecorder).onSubflowExit) (c as FlowRecorder).onSubflowExit!(event);
  }

  onSubflowRegistered(event: FlowSubflowRegisteredEvent): void {
    for (const c of this.children)
      if ((c as FlowRecorder).onSubflowRegistered) (c as FlowRecorder).onSubflowRegistered!(event);
  }

  onLoop(event: FlowLoopEvent): void {
    for (const c of this.children) if ((c as FlowRecorder).onLoop) (c as FlowRecorder).onLoop!(event);
  }

  onBreak(event: FlowBreakEvent): void {
    for (const c of this.children) if ((c as FlowRecorder).onBreak) (c as FlowRecorder).onBreak!(event);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  clear(): void {
    for (const c of this.children) if (c.clear) c.clear();
  }

  /**
   * Snapshot merges all child snapshots into a single composite entry.
   * Each child's snapshot is preserved with its own id/name/data.
   */
  toSnapshot(): CompositeSnapshot {
    const childSnapshots: Array<{ id: string; name: string; data: unknown }> = [];
    for (const c of this.children) {
      if (c.toSnapshot) {
        const { name, data } = c.toSnapshot();
        childSnapshots.push({ id: c.id, name, data });
      }
    }
    return {
      name: 'Composite',
      data: { children: childSnapshots },
    };
  }
}
