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
import type { FlowBreakEvent, FlowDecisionEvent, FlowErrorEvent, FlowForkEvent, FlowLoopEvent, FlowNextEvent, FlowRecorder, FlowSelectedEvent, FlowStageEvent, FlowSubflowEvent, FlowSubflowRegisteredEvent } from '../engine/narrative/types.js';
import type { CommitEvent, ErrorEvent, ReadEvent, Recorder, StageEvent, WriteEvent } from '../scope/types.js';
/** Snapshot format for composite recorders — wraps child snapshots. */
export interface CompositeSnapshot {
    name: string;
    data: {
        children: Array<{
            id: string;
            name: string;
            data: unknown;
        }>;
    };
}
export declare class CompositeRecorder implements Recorder, FlowRecorder {
    readonly id: string;
    private readonly children;
    constructor(id: string, children: Array<Recorder | FlowRecorder>);
    /**
     * Get a child recorder by class type.
     *
     * @example
     * ```typescript
     * const metrics = composite.get(MetricRecorder);
     * ```
     */
    get<T>(type: new (...args: any[]) => T): T | undefined;
    /** Get all child recorders. */
    getChildren(): ReadonlyArray<Recorder | FlowRecorder>;
    onRead(event: ReadEvent): void;
    onWrite(event: WriteEvent): void;
    onCommit(event: CommitEvent): void;
    onError(event: ErrorEvent | FlowErrorEvent): void;
    onStageStart(event: StageEvent): void;
    onStageEnd(event: StageEvent): void;
    onStageExecuted(event: FlowStageEvent): void;
    onNext(event: FlowNextEvent): void;
    onDecision(event: FlowDecisionEvent): void;
    onFork(event: FlowForkEvent): void;
    onSelected(event: FlowSelectedEvent): void;
    onSubflowEntry(event: FlowSubflowEvent): void;
    onSubflowExit(event: FlowSubflowEvent): void;
    onSubflowRegistered(event: FlowSubflowRegisteredEvent): void;
    onLoop(event: FlowLoopEvent): void;
    onBreak(event: FlowBreakEvent): void;
    clear(): void;
    /**
     * Snapshot merges all child snapshots into a single composite entry.
     * Each child's snapshot is preserved with its own id/name/data.
     */
    toSnapshot(): CompositeSnapshot;
}
