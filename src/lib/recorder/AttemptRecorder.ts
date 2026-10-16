/** P7: one bounded, payload-free metric projection collected from traversal hooks. */
import { parseAttemptId } from 'foottrace';

import type {
  FlowAttemptEvent,
  FlowDecisionEvent,
  FlowPauseEvent,
  FlowRecorder,
  FlowRunEvent,
  FlowRunFailedEvent,
} from '../engine/narrative/types.js';
import { matchesQuery, metricRow, metricWindow, ownDataRecord } from './attemptMetricRows.js';
import { aggregateAttempts, attemptRowKey, logicalKey, worst } from './attemptMetrics.js';
import type {
  AttemptAggregate,
  AttemptDecisionRow,
  AttemptQuery,
  AttemptRecorderOptions,
  AttemptRow,
  AttemptStorageStats,
  AttemptStore,
  PhysicalAttemptRow,
} from './attemptMetricsTypes.js';
import { attemptOTel } from './attemptOTel.js';
import { KeyedStore } from './KeyedStore.js';

function option(value: number | undefined, fallback: number, max: number, name: string, zero = false): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < (zero ? 0 : 1) || n > max) throw new TypeError(`attempts: invalid ${name}`);
  return n;
}
let nextRecorder = 0;
export class AttemptRecorder implements FlowRecorder {
  readonly id = `attempts-${++nextRecorder}`;
  private readonly rows = new KeyedStore<AttemptRow>();
  private readonly logical = new Map<string, PhysicalAttemptRow>();
  private readonly starts = new Map<string, { readonly startedAt: number; readonly outcome: 'running' | 'paused' }>();
  private reads = 0;
  private readonly pending = new Set<Promise<void>>();
  private readonly exemplars: number;
  private readonly maxRows: number;
  private readonly maxPending: number;
  private readonly timeoutMs: number;
  private readonly store?: AttemptStore;
  private failed = 0;
  private dropped = 0;
  private omittedRows = 0;
  constructor(options: AttemptRecorderOptions = {}) {
    this.exemplars = option(options.exemplars, 10, 100, 'exemplars');
    this.maxRows = option(options.maxRows, 10000, 100000, 'maxRows');
    this.maxPending = option(options.maxPending, 8, 64, 'maxPending');
    this.timeoutMs = option(options.storeTimeoutMs, 1000, 60000, 'storeTimeoutMs');
    this.store = options.store;
  }

  onRunStart(event: FlowRunEvent): void {
    const runId = event.traversalContext?.runId;
    if (runId) {
      const startedAt = Date.now();
      if (this.starts.size >= this.maxRows && !this.starts.has(runId)) {
        const oldest = this.starts.keys().next().value;
        if (oldest !== undefined) {
          if (this.starts.get(oldest)?.outcome === 'running') this.omittedRows++;
          this.starts.delete(oldest);
        }
      }
      this.starts.set(runId, { startedAt, outcome: 'running' });
      this.collect({ kind: 'run', runId, startedAt, outcome: 'running' });
    }
  }

  onRunEnd(event: FlowRunEvent): void {
    this.end(event, 'ok');
  }

  onPause(event: FlowPauseEvent): void {
    this.end(event, 'paused');
  }

  onRunFailed(event: FlowRunFailedEvent): void {
    this.end(event, 'failed');
  }

  private end(event: FlowRunEvent | FlowRunFailedEvent | FlowPauseEvent, outcome: 'ok' | 'failed' | 'paused'): void {
    const runId = event.traversalContext?.runId;
    if (!runId) return;
    const prior = this.rows.get(attemptRowKey({ kind: 'run', runId, startedAt: 0, outcome: 'running' }));
    const active = this.starts.get(runId) ?? (prior?.kind === 'run' ? prior : undefined);
    if (active === undefined) {
      this.omittedRows++;
      return;
    }
    // Parallel children can each report a pause in one leg. It is one lifecycle fact, not a lost row.
    // Keep the start until a real terminal event, so a later failure can supersede a child's pause.
    if (outcome === 'paused' && active.outcome !== 'running') return;
    if (outcome !== 'paused' && (active.outcome === 'ok' || active.outcome === 'failed')) return;
    const startedAt = active.startedAt;
    if (outcome === 'paused') this.starts.set(runId, { startedAt, outcome });
    else this.starts.delete(runId);
    this.collect({
      kind: 'run',
      runId,
      startedAt,
      endedAt: Date.now(),
      outcome,
    });
    // Other parallel children may still finish after one child pauses. Keep their bounded identity links
    // until a real terminal event, rather than dropping their later native decisions.
    if (outcome !== 'paused') for (const [key, row] of this.logical) if (row.runId === runId) this.logical.delete(key);
  }

  onAttempt(event: FlowAttemptEvent): void {
    const ctx = event.traversalContext;
    const record = event.record;
    if (!ctx?.runId) {
      this.omittedRows++;
      return;
    }
    const id = `${record.series}@${record.attempt}`;
    if (id.length > 4096) {
      this.omittedRows++;
      return;
    }
    const parsed = parseAttemptId(id);
    if (!parsed) {
      this.omittedRows++;
      return;
    }
    const row = metricRow({
      kind: 'attempt',
      id,
      series: record.series,
      runId: ctx.runId,
      runtimeStageId: ctx.runtimeStageId,
      target: record.target ?? event.stageId,
      traceId: ctx.correlation?.traceId,
      startedAt: record.startedAt,
      durationMs: record.durationMs,
      outcome: record.outcome,
      category: record.category,
      next: record.next,
      reason: record.reason,
      attemptKind: record.kind,
      attempt: record.attempt,
      of: record.of,
      effect: record.effect,
      retryLoop: record.retryLoop,
    });
    if (row?.kind !== 'attempt') {
      this.omittedRows++;
      return;
    }
    this.collect(row);
    if (row.retryLoop?.phase === 'attempt') {
      const key = logicalKey(row.runId, row.retryLoop.series, row.retryLoop.attempt);
      if (!this.logical.has(key) && this.logical.size >= this.maxRows) {
        const oldest = this.logical.keys().next().value;
        if (oldest !== undefined) this.logical.delete(oldest);
        this.omittedRows++;
      }
      this.logical.set(key, row);
    }
  }

  onDecision(event: FlowDecisionEvent): void {
    const logical = event.evidence?.retryLoop;
    const runId = event.traversalContext?.runId;
    if (!logical || !runId) return;
    const key = logicalKey(runId, logical.series, logical.attempt);
    const physical = this.logical.get(key);
    this.logical.delete(key);
    if (!physical) {
      this.omittedRows++;
      return;
    }
    const row = metricRow({
      ...logical,
      kind: 'decision',
      runId,
      target: physical.target,
      runtimeStageId: event.traversalContext?.runtimeStageId,
      attemptId: physical.id,
      startedAt: physical.startedAt,
    });
    if (row?.kind === 'decision') this.collect(row);
    else this.omittedRows++;
  }

  private collect(row: AttemptRow): void {
    const key = attemptRowKey(row);
    if (!this.rows.has(key) && this.rows.size >= this.maxRows) {
      const oldest = this.rows.getMap().keys().next().value;
      if (oldest !== undefined) this.rows.delete(oldest);
      this.omittedRows++;
    }
    this.rows.set(key, row);
    if (!this.store) return;
    if (this.pending.size + this.reads >= this.maxPending) {
      this.dropped++;
      return;
    }
    // Hooks cannot await. Own every rejection immediately, with a bounded pool and no hidden retry queue.
    try {
      const result = this.store.append([structuredClone(row)]);
      if (result !== undefined) {
        const task: Promise<void> = Promise.resolve(result)
          .then(
            () => undefined,
            () => {
              this.failed++;
            },
          )
          .then(() => {
            this.pending.delete(task);
          });
        this.pending.add(task);
      }
    } catch {
      this.failed++;
    }
  }

  storage(): AttemptStorageStats {
    return {
      pending: this.pending.size + this.reads,
      failed: this.failed,
      dropped: this.dropped,
      omittedRows: this.omittedRows,
      incomplete: this.pending.size + this.reads + this.failed + this.dropped + this.omittedRows > 0,
    };
  }

  async flush(): Promise<AttemptStorageStats> {
    if (this.pending.size === 0) return this.storage();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([...this.pending]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return this.storage();
  }

  byTarget(): AttemptAggregate['byTarget'] {
    return aggregateAttempts(this.rows.values(), this.exemplars, this.storage()).byTarget;
  }

  byRun(): AttemptAggregate['byRun'] {
    return aggregateAttempts(this.rows.values(), this.exemplars, this.storage()).byRun;
  }

  slowest(target: string, limit = this.exemplars) {
    const cap = option(limit, this.exemplars, 100, 'limit', true);
    return worst(
      this.rows.values().filter((row): row is PhysicalAttemptRow => row.kind === 'attempt' && row.target === target),
      cap,
    );
  }

  series(series: string, runId?: string): { attempts: PhysicalAttemptRow[]; decisions: AttemptDecisionRow[] } {
    const held = this.rows.values().filter((row) => runId === undefined || row.runId === runId);
    const linked = new Set<string>();
    for (const row of held)
      if (row.kind === 'attempt' && row.series === series && row.retryLoop !== undefined)
        linked.add(JSON.stringify([row.runId, row.retryLoop.series]));
    const rows = held.filter(
      (row) =>
        row.kind !== 'run' &&
        (row.series === series ||
          (row.kind === 'attempt' && row.retryLoop?.series === series) ||
          linked.has(JSON.stringify([row.runId, row.kind === 'attempt' ? row.retryLoop?.series : row.series]))),
    );
    return structuredClone({
      attempts: rows.filter((row): row is PhysicalAttemptRow => row.kind === 'attempt'),
      decisions: rows.filter((row): row is AttemptDecisionRow => row.kind === 'decision'),
    });
  }

  async aggregate(supplied: AttemptQuery = {}): Promise<AttemptAggregate> {
    const admitted = ownDataRecord(supplied);
    if (admitted === undefined) throw new TypeError('attempts: invalid query');
    const { since, until, target, runId } = admitted as AttemptQuery;
    if (
      (since !== undefined && (!Number.isFinite(since) || since < 0)) ||
      (until !== undefined && (!Number.isFinite(until) || until < 0)) ||
      (since !== undefined && until !== undefined && since > until) ||
      (target !== undefined && (typeof target !== 'string' || target.length === 0)) ||
      (runId !== undefined && (typeof runId !== 'string' || runId.length === 0))
    )
      throw new TypeError('attempts: invalid query');
    const query = Object.freeze({ since, until, target, runId });
    await this.flush();
    const raw = this.store === undefined ? this.rows.values() : await this.readStored(query);
    const rows: AttemptRow[] = [];
    const window = metricWindow(raw, this.maxRows);
    let invalid = window.omitted;
    for (const value of window.values) {
      const row = metricRow(value);
      if (row && matchesQuery(row, query)) rows.push(row);
      else if (row === undefined) invalid++;
    }
    const storage = this.storage();
    let storeOmitted = 0;
    let accountingUnknown = false;
    if (this.store?.stats !== undefined) {
      try {
        const stats = ownDataRecord(this.store.stats());
        if (
          stats === undefined ||
          typeof stats.omittedRows !== 'number' ||
          !Number.isSafeInteger(stats.omittedRows) ||
          stats.omittedRows < 0
        )
          accountingUnknown = true;
        else storeOmitted = stats.omittedRows;
      } catch {
        accountingUnknown = true;
      }
    }
    return aggregateAttempts(rows, this.exemplars, {
      ...storage,
      omittedRows: storage.omittedRows + invalid + storeOmitted,
      incomplete: storage.incomplete || invalid + storeOmitted > 0 || accountingUnknown,
    });
  }

  private async readStored(query: AttemptQuery): Promise<readonly AttemptRow[]> {
    if (this.reads + this.pending.size >= this.maxPending) throw new Error('attempts: store read capacity reached');
    const store = this.store;
    if (store === undefined) return this.rows.values();
    this.reads++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        this.reads--;
      }
    };
    // A timed-out I/O still owns its slot until it settles: a caller cannot create an unbounded pool of stuck reads.
    const work = Promise.resolve()
      .then(() => store.read(query))
      .then(
        (rows) => {
          release();
          if (!Array.isArray(rows)) throw new Error('attempts: invalid store rows');
          return rows;
        },
        () => {
          release();
          throw new Error('attempts: store read failed');
        },
      );
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('attempts: store read timed out')), this.timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  toSnapshot() {
    const stats = aggregateAttempts(this.rows.values(), this.exemplars, this.storage());
    return {
      name: 'Attempts',
      data: { byTarget: stats.byTarget, byRun: stats.byRun },
      meta: {
        projection: 'per-target',
        exemplars: this.exemplars,
        rows: this.rows.size,
        maxRows: this.maxRows,
        storage: stats.storage,
        workTime: 'sum-of-attempt-durations',
      },
    };
  }

  toOTel() {
    return attemptOTel(
      this.rows.values().filter((row): row is PhysicalAttemptRow => row.kind === 'attempt'),
      this.byTarget(),
      this.exemplars,
    );
  }

  /** Clear completed local projections; active/paused evidence and bounded ownership survive executor auto-clear. */
  clear(): void {
    const kept = this.rows.values().filter((row) => this.starts.has(row.runId));
    this.rows.clear();
    for (const row of kept) this.rows.set(attemptRowKey(row), row);
    for (const [key, row] of this.logical) if (!this.starts.has(row.runId)) this.logical.delete(key);
    if (this.starts.size === 0) this.omittedRows = 0;
  }
}

/** Bounded reference adapter for tests/local use; apps supply their own database adapter. */
export function memoryStore(
  options: { readonly maxRows?: number } = {},
): AttemptStore & { stats(): { rows: number; omittedRows: number } } {
  const max = option(options.maxRows, 10000, 100000, 'maxRows');
  const rows = new Map<number, AttemptRow>();
  let omitted = 0;
  let ordinal = 0;
  return {
    append(incoming) {
      const window = metricWindow(incoming, max);
      omitted += window.omitted;
      for (const value of window.values) {
        const row = metricRow(value);
        if (!row) {
          omitted++;
          continue;
        }
        if (rows.size >= max) {
          const oldest = rows.keys().next().value;
          if (oldest !== undefined) rows.delete(oldest);
          omitted++;
        }
        rows.set(++ordinal, row);
      }
    },
    async read(query) {
      return [...rows.values()].filter((row) => matchesQuery(row, query)).map((row) => structuredClone(row));
    },
    stats() {
      return { rows: rows.size, omittedRows: omitted };
    },
  };
}
