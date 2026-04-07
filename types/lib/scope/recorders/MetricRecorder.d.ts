/**
 * MetricRecorder — Production-focused recorder for timing and execution counts.
 *
 * Tracks read/write/commit counts per stage and measures stage execution duration.
 *
 * Each instance gets a unique auto-increment ID (`metrics-1`, `metrics-2`, ...),
 * so multiple recorders with different configs coexist. Pass an explicit ID to
 * override a specific instance (e.g., a framework-attached recorder).
 *
 * @example
 * ```typescript
 * // Track all stages (default)
 * executor.attachRecorder(new MetricRecorder());
 *
 * // Track only LLM-related stages
 * executor.attachRecorder(new MetricRecorder({
 *   stageFilter: (name) => ['CallLLM', 'ParseResponse'].includes(name),
 * }));
 *
 * // Two recorders: one for LLM timing, one for everything else
 * executor.attachRecorder(new MetricRecorder({
 *   stageFilter: (name) => name === 'CallLLM',
 * }));
 * executor.attachRecorder(new MetricRecorder({
 *   stageFilter: (name) => name !== 'CallLLM',
 * }));
 *
 * // Override a framework-attached recorder by passing its well-known ID
 * executor.attachRecorder(new MetricRecorder({ id: 'metrics' }));
 * ```
 */
import type { CommitEvent, PauseEvent, ReadEvent, Recorder, StageEvent, WriteEvent } from '../types.js';
export interface StageMetrics {
    stageName: string;
    readCount: number;
    writeCount: number;
    commitCount: number;
    pauseCount: number;
    totalDuration: number;
    invocationCount: number;
}
export interface AggregatedMetrics {
    totalDuration: number;
    totalReads: number;
    totalWrites: number;
    totalCommits: number;
    totalPauses: number;
    stageMetrics: Map<string, StageMetrics>;
}
/** Options for MetricRecorder. All fields are optional. */
export interface MetricRecorderOptions {
    /** Recorder ID. Defaults to auto-increment (`metrics-1`, `metrics-2`, ...). */
    id?: string;
    /**
     * Filter which stages are recorded. Return `true` to record, `false` to skip.
     * When omitted, all stages are recorded.
     *
     * @example
     * ```typescript
     * // Only track stages that start with "Call"
     * stageFilter: (name) => name.startsWith('Call')
     * ```
     */
    stageFilter?: (stageName: string) => boolean;
}
export declare class MetricRecorder implements Recorder {
    private static _counter;
    readonly id: string;
    private metrics;
    private stageStartTimes;
    private stageFilter?;
    constructor(idOrOptions?: string | MetricRecorderOptions);
    private shouldRecord;
    onRead(event: ReadEvent): void;
    onWrite(event: WriteEvent): void;
    onCommit(event: CommitEvent): void;
    onPause(event: PauseEvent): void;
    onStageStart(event: StageEvent): void;
    onStageEnd(event: StageEvent): void;
    getMetrics(): AggregatedMetrics;
    getStageMetrics(stageName: string): StageMetrics | undefined;
    toSnapshot(): {
        name: string;
        data: unknown;
    };
    reset(): void;
    clear(): void;
    private getOrCreateStageMetrics;
}
