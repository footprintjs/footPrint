/** Aggregate recorded facts; no execution-tree walk and no reconstruction of logical retries from event counts. */
import type { AttemptReason } from '../attempt/types.js';
import type {
  AttemptAggregate,
  AttemptDecisionRow,
  AttemptRef,
  AttemptRow,
  AttemptStats,
  AttemptStorageStats,
  PhysicalAttemptRow,
} from './attemptMetricsTypes.js';
import { gaveUp } from './attemptSeries.js';

export const attemptRowKey = (row: AttemptRow): string =>
  JSON.stringify(
    row.kind === 'attempt'
      ? [row.kind, row.runId, row.id]
      : row.kind === 'decision'
      ? [row.kind, row.runId, row.series, row.attempt]
      : [row.kind, row.runId],
  );
export const logicalKey = (runId: string, series: string, attempt: number): string =>
  JSON.stringify([runId, series, attempt]);
export const seriesKey = (runId: string, series: string): string => JSON.stringify([runId, series]);
export function reference(row: PhysicalAttemptRow): AttemptRef {
  const {
    id,
    series,
    runId,
    runtimeStageId,
    attemptKind,
    target,
    traceId,
    startedAt,
    durationMs,
    outcome,
    category,
    next,
    reason,
    retryLoop,
  } = row;
  return {
    id,
    series,
    runId,
    runtimeStageId,
    attemptKind,
    target,
    ...(traceId === undefined ? {} : { traceId }),
    startedAt,
    durationMs,
    outcome,
    ...(category === undefined ? {} : { category }),
    next,
    reason,
    ...(retryLoop === undefined ? {} : { retryLoop: { ...retryLoop } }),
  };
}
const order = (a: PhysicalAttemptRow, b: PhysicalAttemptRow) =>
  b.durationMs - a.durationMs || b.startedAt - a.startedAt || a.id.localeCompare(b.id);
export function worst(rows: readonly PhysicalAttemptRow[], limit: number): AttemptRef[] {
  return [...rows].sort(order).slice(0, limit).map(reference);
}
function summarized(
  target: string,
  rows: readonly PhysicalAttemptRow[],
  decisions: Map<string, AttemptDecisionRow>,
  exemplars: number,
): AttemptStats {
  const byKind = { stage: 0, call: 0, observed: 0 };
  const byOutcome = { ok: 0, failed: 0, timeout: 0, aborted: 0, paused: 0 };
  const byCategory = { timeout: 0, 'rate-limited': 0, server: 0, network: 0, auth: 0, permanent: 0, unknown: 0 };
  let retries = 0;
  const retried = new Set<string>();
  const gave = new Set<string>();
  const stopped = new Set<PhysicalAttemptRow>();
  for (const row of rows) {
    byKind[row.attemptKind]++;
    byOutcome[row.outcome]++;
    if (row.category !== undefined) byCategory[row.category]++;
    // A reconciliation wire call is work, but its one-call stop is not a logical workflow give-up.
    if (row.retryLoop?.phase === 'reconcile') continue;
    const logical = row.retryLoop;
    const decision =
      logical === undefined ? row : decisions.get(logicalKey(row.runId, logical.series, logical.attempt));
    if (decision === undefined) continue; // no recorded logical verdict yet: incomplete, never guess
    const key = seriesKey(row.runId, logical?.series ?? row.series);
    if (decision.next === 'retry') {
      retries++;
      retried.add(key);
    }
    if (gaveUp({ next: decision.next, reason: decision.reason as AttemptReason })) {
      gave.add(key);
      stopped.add(row);
    }
  }
  const sorted = [...rows].sort(order);
  const n = sorted.length;
  const rank = (p: number) => (n === 0 ? 0 : sorted[n - Math.ceil(n * p)].durationMs);
  const refs = (include: (row: PhysicalAttemptRow) => boolean) =>
    sorted.filter(include).slice(0, exemplars).map(reference);
  const used = rows.reduce((n, row) => n + row.durationMs, 0);
  return {
    target,
    count: n,
    byKind,
    byOutcome,
    byCategory,
    retries,
    seriesRetried: retried.size,
    gaveUp: gave.size,
    effectUnknown: rows.filter((row) => row.effect === 'unknown').length,
    latencyMs: {
      p50: rank(0.5),
      p90: rank(0.9),
      p95: rank(0.95),
      max: n === 0 ? 0 : sorted[0].durationMs,
      mean: n === 0 ? 0 : used / n,
    },
    budgetUsedMs: used,
    exemplars: {
      slowest: refs(() => true),
      timeout: refs((row) => row.outcome === 'timeout'),
      failed: refs((row) => row.outcome === 'failed' || row.outcome === 'aborted'),
      unknown: refs((row) => row.effect === 'unknown'),
      gaveUp: refs((row) => stopped.has(row)),
    },
  };
}
export function aggregateAttempts(
  rows: readonly AttemptRow[],
  exemplars: number,
  storage: AttemptStorageStats,
): AttemptAggregate {
  // Append stores may contain multiple lifecycle versions; the last row is the recorded current fact.
  const unique = new Map(rows.map((row) => [attemptRowKey(row), row]));
  const all = [...unique.values()];
  const decisions = new Map<string, AttemptDecisionRow>();
  const grouped = new Map<string, PhysicalAttemptRow[]>();
  for (const row of all)
    if (row.kind === 'decision') decisions.set(logicalKey(row.runId, row.series, row.attempt), row);
  for (const row of all)
    if (row.kind === 'attempt') {
      const bucket = grouped.get(row.target) ?? [];
      bucket.push(row);
      grouped.set(row.target, bucket);
    }
  const byTarget = new Map(
    [...grouped].map(([target, entries]) => [target, summarized(target, entries, decisions, exemplars)]),
  );
  const runs = new Map<string, AttemptRow[]>();
  for (const row of all) {
    const bucket = runs.get(row.runId) ?? [];
    bucket.push(row);
    runs.set(row.runId, bucket);
  }
  const byRun: AttemptAggregate['byRun'] = new Map();
  for (const [runId, own] of runs) {
    const attempts = own.filter((row): row is PhysicalAttemptRow => row.kind === 'attempt');
    const perTarget = new Map<string, PhysicalAttemptRow[]>();
    for (const row of attempts) {
      const bucket = perTarget.get(row.target) ?? [];
      bucket.push(row);
      perTarget.set(row.target, bucket);
    }
    const stats = [...perTarget].map(([target, entries]) => summarized(target, entries, decisions, 0));
    const run = own.find((row) => row.kind === 'run');
    byRun.set(runId, {
      runId,
      attempts: attempts.length,
      retries: stats.reduce((n, s) => n + s.retries, 0),
      gaveUp: stats.reduce((n, s) => n + s.gaveUp, 0),
      budgetUsedMs: stats.reduce((n, s) => n + s.budgetUsedMs, 0),
      outcome: run?.kind === 'run' ? run.outcome : 'incomplete',
    });
  }
  return { byTarget, byRun, storage };
}
