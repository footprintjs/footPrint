/**
 * DebugRecorder — Development-focused recorder for detailed debugging
 *
 * Captures errors (always), mutations and reads (in verbose mode),
 * and stage lifecycle events for troubleshooting.
 */
import type { ErrorEvent, PauseEvent, ReadEvent, Recorder, ResumeEvent, StageEvent, WriteEvent } from '../types.js';
export type DebugVerbosity = 'minimal' | 'verbose';
export interface DebugEntry {
    type: 'read' | 'write' | 'error' | 'stageStart' | 'stageEnd' | 'pause' | 'resume';
    stageName: string;
    timestamp: number;
    data: unknown;
}
export interface DebugRecorderOptions {
    id?: string;
    verbosity?: DebugVerbosity;
}
/**
 * Each instance gets a unique auto-increment ID (`debug-1`, `debug-2`, ...),
 * so multiple recorders with different verbosity coexist.
 *
 * @example
 * ```typescript
 * // Verbose debug for development
 * executor.attachRecorder(new DebugRecorder({ verbosity: 'verbose' }));
 *
 * // Minimal debug for production (errors only)
 * executor.attachRecorder(new DebugRecorder({ verbosity: 'minimal' }));
 *
 * // Both coexist — different auto IDs
 * ```
 */
export declare class DebugRecorder implements Recorder {
    private static _counter;
    readonly id: string;
    private entries;
    private verbosity;
    constructor(options?: DebugRecorderOptions);
    onRead(event: ReadEvent): void;
    onWrite(event: WriteEvent): void;
    onError(event: ErrorEvent): void;
    onStageStart(event: StageEvent): void;
    onStageEnd(event: StageEvent): void;
    onPause(event: PauseEvent): void;
    onResume(event: ResumeEvent): void;
    getEntries(): DebugEntry[];
    getErrors(): DebugEntry[];
    getEntriesForStage(stageName: string): DebugEntry[];
    setVerbosity(level: DebugVerbosity): void;
    getVerbosity(): DebugVerbosity;
    clear(): void;
}
