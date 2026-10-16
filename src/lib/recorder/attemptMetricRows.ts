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

// Fixed named fields: a huge unknown envelope is never enumerated just to discard it.
const DATA_FIELDS = [
  'kind',
  'runId',
  'startedAt',
  'endedAt',
  'outcome',
  'target',
  'runtimeStageId',
  'attemptId',
  'id',
  'series',
  'attempt',
  'of',
  'effect',
  'reconciled',
  'next',
  'reason',
  'attemptKind',
  'durationMs',
  'category',
  'traceId',
  'retryLoop',
  'phase',
  'since',
  'until',
  'omittedRows',
] as const;
/** Decode plain own data only; external data never gets to run getters or coercion hooks. */
export function ownDataRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      return undefined;
    const data: Record<string, unknown> = Object.create(null);
    for (const key of DATA_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) continue;
      if (!Object.hasOwn(descriptor, 'value')) return undefined;
      data[key] = descriptor.value;
    }
    return data;
  } catch {
    return undefined;
  }
}

/** Read an external array window by descriptors, never by executing an index accessor or iterator. */
export function metricWindow(value: unknown, maxRows: number): { values: unknown[]; omitted: number } {
  try {
    if (!Array.isArray(value)) return { values: [], omitted: 1 };
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value as unknown;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return { values: [], omitted: 1 };
    const start = Math.max(0, length - maxRows);
    const values: unknown[] = [];
    let omitted = start;
    for (let index = start; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) omitted++;
      else values.push(descriptor.value);
    }
    return { values, omitted };
  } catch {
    return { values: [], omitted: 1 };
  }
}

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
  const v = ownDataRecord(value);
  if (v === undefined) throw new TypeError('invalid attempt loop');
  if (
    !text(v.id) ||
    !text(v.series) ||
    !parseAttemptId(`${v.series}@1`) ||
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
    const v = ownDataRecord(value);
    if (v === undefined) return undefined;
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
    if (!text(v.target) || !text(v.runtimeStageId) || !parseAttemptId(`${v.runtimeStageId}@1`)) return undefined;
    if (v.kind === 'decision') {
      const parsed = text(v.attemptId) ? parseAttemptId(v.attemptId) : undefined;
      if (
        !parsed ||
        !text(v.id) ||
        !text(v.series) ||
        !parseAttemptId(`${v.series}@1`) ||
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
    const parsed = text(v.id) ? parseAttemptId(v.id) : undefined;
    if (
      v.kind !== 'attempt' ||
      !parsed ||
      parsed.runtimeStageId !== v.runtimeStageId ||
      !text(v.series) ||
      !count(v.attempt) ||
      v.id !== `${v.series}@${v.attempt}` ||
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
    if (retryLoop !== undefined && v.attemptKind !== 'call') return undefined;
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
