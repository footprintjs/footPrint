/** Named-field admission for metric rows, shared by live collection and external store reads. */
import type { AttemptId } from 'foottrace';
import { parseAttemptId } from 'foottrace';

import type { RetryLoopCall } from '../attempt/retryLoopTypes.js';
import type { AttemptCategory, AttemptKind, AttemptNext, AttemptOutcome, AttemptReason } from '../attempt/types.js';
import type {
  AttemptDecisionRow,
  AttemptQuery,
  AttemptRow,
  AttemptRunRow,
  PhysicalAttemptRow,
} from './attemptMetricsTypes.js';

const outcomes = new Set(['ok', 'failed', 'timeout', 'aborted', 'paused']);
const categories = new Set(['timeout', 'rate-limited', 'server', 'network', 'auth', 'permanent', 'unknown']);
const reasons = new Set(['succeeded', 'paused', 'aborted', 'exhausted', 'declined', 'no-time-left', 'retryable']);
const nexts = new Set(['retry', 'done', 'stop']);
const effects = new Set(['none', 'applied', 'unknown']);
const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const count = (value: unknown): value is number => number(value) && Number.isSafeInteger(value) && value >= 1;
function loopOf(value: unknown): RetryLoopCall | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') throw new TypeError('invalid attempt loop');
  const v = value as Record<string, unknown>;
  if (
    !text(v.id) ||
    !text(v.series) ||
    !count(v.attempt) ||
    !count(v.of) ||
    v.attempt > v.of ||
    (v.phase !== 'attempt' && v.phase !== 'reconcile')
  )
    throw new TypeError('invalid attempt loop');
  return { id: v.id, series: v.series, attempt: v.attempt, of: v.of, phase: v.phase };
}
/** Invalid stored data is omitted and accounted, never copied as an arbitrary envelope. */
export function metricRow(value: unknown): AttemptRow | undefined {
  try {
    if (value === null || typeof value !== 'object') return undefined;
    const v = value as Record<string, unknown>;
    if (!text(v.runId) || !number(v.startedAt)) return undefined;
    if (v.kind === 'run') {
      if (
        !['running', 'ok', 'failed', 'paused'].includes(v.outcome as string) ||
        (v.endedAt !== undefined && !number(v.endedAt))
      )
        return undefined;
      return {
        kind: 'run',
        runId: v.runId,
        startedAt: v.startedAt,
        ...(v.endedAt === undefined ? {} : { endedAt: v.endedAt as number }),
        outcome: v.outcome as AttemptRunRow['outcome'],
      };
    }
    if (!text(v.target) || !text(v.runtimeStageId)) return undefined;
    if (v.kind === 'decision') {
      const parsed = typeof v.attemptId === 'string' ? parseAttemptId(v.attemptId) : undefined;
      if (
        !parsed ||
        !text(v.id) ||
        !text(v.series) ||
        !count(v.attempt) ||
        !count(v.of) ||
        v.attempt > v.of ||
        !effects.has(v.effect as string) ||
        typeof v.reconciled !== 'boolean' ||
        !nexts.has(v.next as string) ||
        !reasons.has(v.reason as string)
      )
        return undefined;
      return {
        kind: 'decision',
        id: v.id,
        series: v.series,
        attempt: v.attempt,
        of: v.of,
        effect: v.effect as AttemptDecisionRow['effect'],
        reconciled: v.reconciled,
        next: v.next as AttemptNext,
        reason: v.reason as string,
        runId: v.runId,
        target: v.target,
        runtimeStageId: v.runtimeStageId,
        attemptId: v.attemptId as AttemptId,
        startedAt: v.startedAt,
      };
    }
    const parsed = typeof v.id === 'string' ? parseAttemptId(v.id) : undefined;
    if (
      v.kind !== 'attempt' ||
      !parsed ||
      v.id !== `${v.series}@${v.attempt}` ||
      parsed.runtimeStageId !== v.runtimeStageId ||
      !text(v.series) ||
      !count(v.attempt) ||
      (v.of !== undefined && (!count(v.of) || v.attempt > v.of)) ||
      !number(v.durationMs) ||
      !outcomes.has(v.outcome as string) ||
      !['stage', 'call', 'observed'].includes(v.attemptKind as string) ||
      !nexts.has(v.next as string) ||
      !reasons.has(v.reason as string) ||
      (v.category !== undefined && !categories.has(v.category as string)) ||
      (v.effect !== undefined && !effects.has(v.effect as string)) ||
      (v.traceId !== undefined && !text(v.traceId))
    )
      return undefined;
    const retryLoop = loopOf(v.retryLoop);
    return {
      kind: 'attempt',
      id: v.id as AttemptId,
      series: v.series,
      runId: v.runId,
      runtimeStageId: v.runtimeStageId,
      target: v.target,
      ...(v.traceId === undefined ? {} : { traceId: v.traceId as string }),
      startedAt: v.startedAt,
      durationMs: v.durationMs,
      outcome: v.outcome as AttemptOutcome,
      ...(v.category === undefined ? {} : { category: v.category as AttemptCategory }),
      next: v.next as AttemptNext,
      reason: v.reason as AttemptReason,
      attemptKind: v.attemptKind as AttemptKind,
      attempt: v.attempt,
      ...(v.of === undefined ? {} : { of: v.of as number }),
      ...(v.effect === undefined ? {} : { effect: v.effect as PhysicalAttemptRow['effect'] }),
      ...(retryLoop === undefined ? {} : { retryLoop }),
    };
  } catch {
    return undefined;
  }
}
export function matchesQuery(row: AttemptRow, query: AttemptQuery): boolean {
  return (
    (query.since === undefined || row.startedAt >= query.since) &&
    (query.until === undefined || row.startedAt <= query.until) &&
    (query.runId === undefined || row.runId === query.runId) &&
    (query.target === undefined || (row.kind !== 'run' && row.target === query.target))
  );
}
