/**
 * DebugRecorder — Development-focused recorder for detailed debugging
 *
 * Captures errors (always), mutations and reads (in verbose mode),
 * and stage lifecycle events for troubleshooting.
 */

import type { ErrorEvent, ReadEvent, Recorder, StageEvent, WriteEvent } from '../types.js';

export type DebugVerbosity = 'minimal' | 'verbose';

export interface DebugEntry {
  type: 'read' | 'write' | 'error' | 'stageStart' | 'stageEnd';
  stageName: string;
  timestamp: number;
  data: unknown;
}

export interface DebugRecorderOptions {
  id?: string;
  verbosity?: DebugVerbosity;
}

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
