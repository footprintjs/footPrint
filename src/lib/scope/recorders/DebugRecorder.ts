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
export class DebugRecorder implements Recorder {
  private static _counter = 0;

  readonly id: string;
  private entries: DebugEntry[] = [];
  private verbosity: DebugVerbosity;

  constructor(options?: DebugRecorderOptions) {
    this.id = options?.id ?? `debug-${++DebugRecorder._counter}`;
    this.verbosity = options?.verbosity ?? 'verbose';
  }

  onRead(event: ReadEvent): void {
    if (this.verbosity !== 'verbose') return;
    this.entries.push({
      type: 'read',
      stageName: event.stageName,
      timestamp: event.timestamp,
      data: { key: event.key, value: event.value, pipelineId: event.pipelineId },
    });
  }

  onWrite(event: WriteEvent): void {
    if (this.verbosity !== 'verbose') return;
    this.entries.push({
      type: 'write',
      stageName: event.stageName,
      timestamp: event.timestamp,
      data: { key: event.key, value: event.value, operation: event.operation, pipelineId: event.pipelineId },
    });
  }

  onError(event: ErrorEvent): void {
    this.entries.push({
      type: 'error',
      stageName: event.stageName,
      timestamp: event.timestamp,
      data: { error: event.error, operation: event.operation, key: event.key, pipelineId: event.pipelineId },
    });
  }

  onStageStart(event: StageEvent): void {
    if (this.verbosity !== 'verbose') return;
    this.entries.push({
      type: 'stageStart',
      stageName: event.stageName,
      timestamp: event.timestamp,
      data: { pipelineId: event.pipelineId },
    });
  }

  onStageEnd(event: StageEvent): void {
    if (this.verbosity !== 'verbose') return;
    this.entries.push({
      type: 'stageEnd',
      stageName: event.stageName,
      timestamp: event.timestamp,
      data: { pipelineId: event.pipelineId, duration: event.duration },
    });
  }

  onPause(event: PauseEvent): void {
    // Always log pauses (even in minimal mode — pauses are significant events)
    this.entries.push({
      type: 'pause',
      stageName: event.stageName,
      timestamp: event.timestamp,
      data: { stageId: event.stageId, pauseData: event.pauseData, pipelineId: event.pipelineId },
    });
  }

  onResume(event: ResumeEvent): void {
    // Always log resumes (even in minimal mode)
    this.entries.push({
      type: 'resume',
      stageName: event.stageName,
      timestamp: event.timestamp,
      data: { stageId: event.stageId, hasInput: event.hasInput, pipelineId: event.pipelineId },
    });
  }

  getEntries(): DebugEntry[] {
    return [...this.entries];
  }

  getErrors(): DebugEntry[] {
    return this.entries.filter((e) => e.type === 'error');
  }

  getEntriesForStage(stageName: string): DebugEntry[] {
    return this.entries.filter((e) => e.stageName === stageName);
  }

  setVerbosity(level: DebugVerbosity): void {
    this.verbosity = level;
  }

  getVerbosity(): DebugVerbosity {
    return this.verbosity;
  }

  clear(): void {
    this.entries = [];
  }
}
