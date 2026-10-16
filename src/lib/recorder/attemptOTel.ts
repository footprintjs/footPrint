/** OTLP JSON metrics: exact histogram bucket counts and real bounded physical-attempt exemplars. */
import { worst } from './attemptMetrics.js';
import type { AttemptMetricRef, AttemptStats, PhysicalAttemptRow } from './attemptMetricsTypes.js';
const BOUNDS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
const nano = (ms: number) => (BigInt(Math.trunc(ms)) * 1000000n).toString();
function exemplars(refs: readonly AttemptMetricRef[], value: 'duration' | 'count' = 'duration') {
  return refs.map((ref) => ({
    asDouble: value === 'count' ? 1 : ref.durationMs,
    timeUnixNano: nano(ref.startedAt),
    filteredAttributes: [
      attribute('footprint.attempt.kind', ref.attemptKind),
      attribute('footprint.attempt.id', ref.id),
      attribute('footprint.runtime_stage_id', ref.runtimeStageId),
      attribute('footprint.series', ref.series),
      attribute('footprint.run_id', ref.runId),
      ...(ref.traceId === undefined ? [] : [attribute('footprint.trace_id', ref.traceId)]),
      ...(ref.retryLoop === undefined
        ? []
        : [
            attribute('footprint.retry_loop.series', ref.retryLoop.series),
            attribute('footprint.retry_loop.phase', ref.retryLoop.phase),
          ]),
    ],
    ...(/^[a-f0-9]{32}$/.test(ref.traceId ?? '') && !/^0+$/.test(ref.traceId ?? '') ? { traceId: ref.traceId } : {}),
  }));
}
export function attemptOTel(
  rows: readonly PhysicalAttemptRow[],
  byTarget: ReadonlyMap<string, AttemptStats>,
  limit: number,
) {
  const grouped = new Map<string, PhysicalAttemptRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.target, row.outcome, row.category ?? null, row.attemptKind]);
    const bucket = grouped.get(key) ?? [];
    bucket.push(row);
    grouped.set(key, bucket);
  }
  const histograms = [...grouped.values()].map((group) => {
    const first = group[0];
    const buckets = Array(BOUNDS.length + 1).fill(0) as number[];
    for (const row of group) {
      const at = BOUNDS.findIndex((bound) => row.durationMs <= bound);
      buckets[at < 0 ? BOUNDS.length : at]++;
    }
    return {
      attributes: [
        attribute('footprint.target', first.target),
        attribute('footprint.outcome', first.outcome),
        attribute('footprint.attempt.kind', first.attemptKind),
        ...(first.category === undefined ? [] : [attribute('footprint.category', first.category)]),
      ],
      startTimeUnixNano: nano(group.reduce((n, row) => Math.min(n, row.startedAt), Infinity)),
      timeUnixNano: nano(group.reduce((n, row) => Math.max(n, row.startedAt + row.durationMs), 0)),
      count: String(group.length),
      sum: group.reduce((n, row) => n + row.durationMs, 0),
      explicitBounds: [...BOUNDS],
      bucketCounts: buckets.map(String),
      exemplars: exemplars(worst(group, limit)),
    };
  });
  const counts = histograms.map(({ attributes, startTimeUnixNano, timeUnixNano, count, exemplars: refs }) => ({
    attributes,
    startTimeUnixNano,
    timeUnixNano,
    asDouble: Number(count),
    exemplars: refs.map((ref) => ({ ...ref, asDouble: 1 })),
  }));
  const gave = [...byTarget.values()]
    .filter((stat) => stat.gaveUp > 0)
    .map((stat) => ({
      attributes: [attribute('footprint.target', stat.target)],
      asDouble: stat.gaveUp,
      startTimeUnixNano: nano(
        rows.filter((row) => row.target === stat.target).reduce((n, row) => Math.min(n, row.startedAt), Infinity),
      ),
      timeUnixNano: nano(
        rows
          .filter((row) => row.target === stat.target)
          .reduce((n, row) => Math.max(n, row.startedAt + row.durationMs), 0),
      ),
      exemplars: exemplars(stat.exemplars.gaveUp, 'count'),
    }));
  return {
    resourceMetrics: [
      {
        resource: { attributes: [] },
        scopeMetrics: [
          {
            scope: { name: 'footprintjs.attempts' },
            metrics: [
              {
                name: 'footprint.attempt.duration',
                unit: 'ms',
                description: 'Attempt work duration; nested attempts may overlap',
                histogram: { aggregationTemporality: 2, dataPoints: histograms },
              },
              {
                name: 'footprint.attempt.count',
                unit: '{attempt}',
                sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: counts },
              },
              {
                name: 'footprint.attempt.gave_up',
                unit: '{series}',
                sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: gave },
              },
            ],
          },
        ],
      },
    ],
  };
}
