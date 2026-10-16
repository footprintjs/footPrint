/**
 * DebugRecorder — Development-focused recorder for detailed debugging
 *
 * Captures errors (always — a scope recorder's own failure, the scope
 * channel's `onError`; a stage's failure is not one), mutations and reads
 * (in verbose mode), and stage lifecycle events for troubleshooting.
 *
 * Attempts (10.1): one `attempt` row per attempt of a series that retried,
 * gave up or timed out (`recorder/attemptSeries.ts · isRetryEvidence`) — its
 * outcome, category, duration, decision, the cap and time left it ran under
 * (present with a cap or a deadline) and served error — and one `attemptStop`
 * row when the series gave up (exhausted, declined, no time left). Both verbosities: like a
 * pause, an attempt is significant — and for a retried stage these rows are
 * the failure evidence (a stage's error is never an `error` row). They arrive on the FLOW channel
 * (`onAttempt`), so attach with `attachCombinedRecorder` to see them; the
 * flow channel's own `onError` / `onPause` / `onResume` are ignored, so a
 * combined attach never doubles a scope row.
 */

import type { AttemptRecord } from '../../attempt/types.js';
import type { FlowAttemptEvent } from '../../engine/narrative/types.js';
import { gaveUp, isRetryEvidence } from '../../recorder/attemptSeries.js';
import type { RecorderOperation } from '../../recorder/RecorderOperation.js';
import type {
  ErrorEvent,
  PauseEvent,
  ReadEvent,
  ResumeEvent,
  ScopeRecorder,
  StageEvent,
  WriteEvent,
} from '../types.js';

export type DebugVerbosity = 'minimal' | 'verbose';

export interface DebugEntry {
  type: 'read' | 'write' | 'error' | 'stageStart' | 'stageEnd' | 'pause' | 'resume' | 'attempt' | 'attemptStop';
  stageName: string;
  timestamp: number;
  data: unknown;
}

export interface DebugRecorderOptions {
  id?: string;
  verbosity?: DebugVerbosity;
  /** Preferred UI operation. Defaults to 'translate' (per-step diagnostic detail). */
  preferredOperation?: RecorderOperation;
}

/**
 * Each instance gets a unique auto-increment ID (`debug-1`, `debug-2`, ...),
 * so multiple recorders with different verbosity coexist.
 *
 * @example
 * ```typescript
 * // Verbose debug for development
 * executor.attachScopeRecorder(new DebugRecorder({ verbosity: 'verbose' }));
 *
 * // Minimal debug for production (errors only)
 * executor.attachScopeRecorder(new DebugRecorder({ verbosity: 'minimal' }));
 *
 * // Both coexist — different auto IDs
 * ```
 */
export class DebugRecorder implements ScopeRecorder {
  private static _counter = 0;

  readonly id: string;
  readonly preferredOperation: RecorderOperation;
  private entries: DebugEntry[] = [];
  private verbosity: DebugVerbosity;

  constructor(options?: DebugRecorderOptions) {
    this.id = options?.id ?? `debug-${++DebugRecorder._counter}`;
    this.verbosity = options?.verbosity ?? 'verbose';
    this.preferredOperation = options?.preferredOperation ?? 'translate';
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
    if (fromFlowChannel(event)) return;
    const error = debugError(event.error);
    this.entries.push({
      type: 'error',
      stageName: event.stageName,
      timestamp: event.timestamp,
      data: { error, operation: event.operation, key: event.key, pipelineId: event.pipelineId },
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
    if (fromFlowChannel(event)) return;
    // Always log pauses (even in minimal mode — pauses are significant events)
    this.entries.push({
      type: 'pause',
      stageName: event.stageName,
      timestamp: event.timestamp,
      data: { stageId: event.stageId, pauseData: event.pauseData, pipelineId: event.pipelineId },
    });
  }

  onResume(event: ResumeEvent): void {
    if (fromFlowChannel(event)) return;
    // Always log resumes (even in minimal mode)
    this.entries.push({
      type: 'resume',
      stageName: event.stageName,
      timestamp: event.timestamp,
      data: { stageId: event.stageId, hasInput: event.hasInput, pipelineId: event.pipelineId },
    });
  }

  onAttempt(event: FlowAttemptEvent): void {
    const { record } = event;
    if (!isRetryEvidence(record)) return;
    const timestamp = record.startedAt + record.durationMs;
    const name = { stageId: event.stageId, series: record.series, attempt: record.attempt, of: record.of };
    this.entries.push({
      type: 'attempt',
      stageName: event.stageName,
      timestamp,
      data: {
        ...name,
        outcome: record.outcome,
        ...(record.category !== undefined && { category: record.category }),
        durationMs: record.durationMs,
        next: record.next,
        reason: record.reason,
        ...(record.retryOnThrew && { retryOnThrew: true }),
        ...(record.delayMs !== undefined && { delayMs: record.delayMs }),
        ...(record.timeoutMs !== undefined && { timeoutMs: record.timeoutMs }),
        ...(record.timeLeftMs !== undefined && { timeLeftMs: record.timeLeftMs }),
        ...(record.error !== undefined && { error: debugError(record.error) }),
      },
    });
    if (!gaveUp(record)) return;
    this.entries.push({
      type: 'attemptStop',
      stageName: event.stageName,
      timestamp,
      data: {
        ...name,
        reason: record.reason,
        ...(record.category !== undefined && { category: record.category }),
        ...(record.retryOnThrew && { retryOnThrew: true }),
      },
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

  toSnapshot() {
    return {
      name: 'Debug',
      description: 'Translator (Scope ScopeRecorder) — per-stage diagnostic entries',
      preferredOperation: this.preferredOperation,
      data: this.entries,
    };
  }
}

/**
 * The structured fields only — never `raw` (the thrown value itself, which may be a function, a Proxy or a cycle),
 * so a snapshot row always survives `structuredClone` (9.39.0). An attempt's error is already the served form
 * (`AttemptRecord.error`, the run's redaction rule applied), so a redacted stage error reads redacted here too.
 */
function debugError(info: NonNullable<AttemptRecord['error']>): Record<string, unknown> {
  const { message, name, code, issues } = info;
  return {
    message,
    ...(name !== undefined && { name }),
    ...(code !== undefined && { code }),
    ...(issues !== undefined && { issues }),
  };
}

/** A shared-name hook (`onError` / `onPause` / `onResume`) delivered on the flow channel of a combined attach. */
function fromFlowChannel(event: { channel?: string }): boolean {
  return event.channel === 'flow';
}
