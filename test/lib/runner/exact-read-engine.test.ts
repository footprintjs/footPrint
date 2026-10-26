/** #113 packet 3: real engine reads, never a model or post-run source finder. */
import { memorySink } from 'foottrace/write';
import { describe, expect, it, vi } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { decodeCheckpoint } from '../../../src/lib/pause/record.js';
import { readStoredCapture } from '../../../src/trace.js';

const enabled = { readSources: true } as any;
const sources = (ex: FlowChartExecutor<any, any>) => (ex.getSnapshot() as any).readSources;
const rows = (ex: FlowChartExecutor<any, any>) => sources(ex).record.occurrences;

function chart() {
  return flowChart<{ n: number }>(
    'Read base',
    (s) => {
      const n = s.n;
      s.n = n + 1;
    },
    'base',
  )
    .addFunction(
      'Read commit',
      (s) => {
        const n = s.n;
        s.n = n + 1;
      },
      'commit',
    )
    .build();
}

describe('native engine read sources', () => {
  it('is absent before a run, by default and with explicit false', async () => {
    for (const options of [{}, { readSources: false }]) {
      const ex = new FlowChartExecutor(chart(), options as any);
      expect(ex.getSnapshot()).not.toHaveProperty('readSources');
      await ex.run();
      expect(ex.getSnapshot()).not.toHaveProperty('readSources');
      expect(ex.getSnapshot()).not.toHaveProperty('capture');
    }
  });

  it('captures actual base then committed origins, independently of value retention', async () => {
    const ex = new FlowChartExecutor(chart(), { ...enabled, readTracking: 'off', initialContext: { n: 1 } });
    await ex.run();
    expect(rows(ex).map((r: any) => r.source.kind)).toEqual(['base', 'committed']);
    expect(rows(ex)[1].source.commitIdx).toBe(0);
    expect(rows(ex).every((r: any) => r.attemptStatus === 'unavailable')).toBe(true);
    expect(sources(ex)).toMatchObject({
      version: 1,
      runId: ex.getSnapshot().runId,
      status: 'captured',
      persistence: 'memory-only',
    });
    expect(ex.getSnapshot().capture as any).toMatchObject({ version: 2, channels: { readSources: 'captured' } });
  });

  it('retains ordered repeated reads and staged generations instead of the last read per key', async () => {
    const ex = new FlowChartExecutor(
      flowChart<{ n: number }>(
        'Read',
        (s) => {
          const first = s.n;
          s.n = first + 1;
          const second = s.n;
          s.n = second + 1;
          const third = s.n;
        },
        'read',
      ).build(),
      { ...enabled, initialContext: { n: 1 } },
    );
    await ex.run();
    expect(rows(ex).map((r: any) => r.ordinal)).toEqual([1, 2, 3]);
    expect(rows(ex).map((r: any) => r.source.kind)).toEqual(['base', 'staged', 'staged']);
    expect(rows(ex)[1].source.generation).not.toBe(rows(ex)[2].source.generation);
  });

  it('distinguishes observed-empty from unsupported undefined reads', async () => {
    const empty = new FlowChartExecutor(flowChart('Empty', () => {}, 'empty').build(), enabled);
    await empty.run();
    expect(sources(empty)).toMatchObject({ status: 'captured', record: { occurrences: [] } });
    const missing = new FlowChartExecutor(
      flowChart<{ n?: number }>(
        'Missing',
        (s) => {
          const n = s.n ?? 0;
        },
        'missing',
      ).build(),
      enabled,
    );
    await missing.run();
    expect(rows(missing)[0].source).toEqual({ kind: 'unavailable', reason: 'undefined-presence-unknown' });
    expect(sources(missing).status).toBe('partial');
  });

  it('preserves the read then single privacy verdict order; active privacy withholds precision', async () => {
    const ex = new FlowChartExecutor(chart(), { ...enabled, initialContext: { n: 1 } });
    ex.setRedactionPolicy({ keys: ['n'] });
    await ex.run();
    expect(rows(ex).every((r: any) => r.source.kind === 'unavailable')).toBe(true);
    expect(sources(ex).limitations).toContain('privacy-active');
  });

  it('does not reuse a previous source book or execution identity on a fresh run', async () => {
    const ex = new FlowChartExecutor(chart(), { ...enabled, initialContext: { n: 1 } });
    await ex.run();
    const first = sources(ex);
    const frozen = JSON.stringify(first);
    await ex.run();
    expect(sources(ex).runId).not.toBe(first.runId);
    expect(sources(ex).record.address.logRunId).toBe(sources(ex).runId);
    expect(JSON.stringify(first)).toBe(frozen);
  });

  it('uses the official attempt identity on a real retry, without inventing an attempt for ordinary stages', async () => {
    let count = 0;
    const ex = new FlowChartExecutor(
      flowChart<{ n: number }>(
        'Retry',
        (s) => {
          const n = s.n;
          if (++count === 1) throw Error('retry');
          s.n = n + 1;
        },
        'retry',
      )
        .retry({ attempts: 2 })
        .build(),
      { ...enabled, initialContext: { n: 1 } },
    );
    await ex.run();
    expect(rows(ex).map((r: any) => r.attemptId)).toEqual(
      expect.arrayContaining([expect.stringMatching(/@1$/), expect.stringMatching(/@2$/)]),
    );
  });

  it.each([false, true])(
    'checkpoints omit prior source history and fresh resumes own only their new segment (same=%s)',
    async (same) => {
      const c = flowChart<{ n: number }>(
        'Read',
        (s) => {
          const n = s.n;
        },
        'read',
      )
        .addPausableFunction(
          'Ask',
          {
            execute: () => ({}),
            resume: (s) => {
              const n = s.n;
            },
          },
          'ask',
        )
        .build();
      const ex = new FlowChartExecutor(c, { ...enabled, initialContext: { n: 1 } });
      await ex.run();
      const cp = decodeCheckpoint(JSON.parse(JSON.stringify(ex.getCheckpoint())));
      expect(cp.capture).toMatchObject({ version: 2, channels: { readSources: 'unknown' } });
      expect(cp.capture!.limitations).toContain('source-history-not-included');
      expect(cp).not.toHaveProperty('readSources');
      const resumed = same ? ex : new FlowChartExecutor(c, enabled);
      await resumed.resume(cp, true);
      expect(sources(resumed)).toMatchObject({
        status: same ? 'unknown' : 'partial',
        limitations: [same ? 'resumed-source-ownership' : 'source-history-not-included'],
      });
      if (same) expect(sources(resumed)).not.toHaveProperty('record');
      else expect(rows(resumed)[0].source.kind).toBe('base');
    },
  );

  it('requests a durable receipt only with the source envelope inside the history protocol', async () => {
    const adapter = memorySink();
    const acknowledge = vi.fn(async (target) => ({ ...target, durability: 'durable' as const }));
    const ex = new FlowChartExecutor(chart(), {
      ...enabled,
      captureCoverage: true,
      initialContext: { n: 1 },
      sink: { adapter, capture: { acknowledge } },
    });
    await ex.run();
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(ex.getSnapshot().sink!.capture).toEqual({ status: 'acknowledged' });
    const stored = await readStoredCapture(adapter.entries, { runId: ex.getSnapshot().runId! });
    expect(stored.status).toBe('acknowledged');
    expect(stored.history?.readSources).toEqual(ex.getSnapshot().readSources);
    expect(adapter.entries.some((e) => e.kind === 'commit')).toBe(true);
  });
});
