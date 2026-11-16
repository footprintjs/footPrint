import { readRunEvidence, readStoredRecord } from 'foottrace';
import { memorySink } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import { decide, flowChart, FlowChartExecutor, select } from '../../../index.js';

function evidence(sink, logRunId = sink.entries.find((e) => e.kind === 'opened').address.logRunId) {
  return readRunEvidence(readStoredRecord(sink.entries), logRunId);
}
function route() {
  return flowChart(
    'Seed',
    (s) => {
      s.score = 7;
    },
    'seed',
  )
    .addDeciderFunction(
      'Route',
      (s) => decide(s, [{ when: { score: { gt: 5 } }, then: 'yes', label: 'Over five' }], 'no'),
      'route',
    )
    .addFunctionBranch('yes', 'Accept', (s) => {
      s.result = 'accepted';
    })
    .addFunctionBranch('no', 'Reject', (s) => {
      s.result = 'rejected';
    })
    .end()
    .build();
}

describe('native engine to stored evidence', () => {
  it('discards a failed attempt read names while keeping its attempt and attention facts', async () => {
    const sink = memorySink();
    let attempts = 0;
    const chart = flowChart(
      'Retry',
      (s) => {
        if (++attempts === 1) {
          s.$getValue('first');
          throw new Error('retry');
        }
        s.result = s.$getValue('second');
      },
      'retry',
    )
      .retry({ attempts: 2, backoffMs: 0 })
      .build();
    await new FlowChartExecutor(chart, { sink, initialContext: { first: 1, second: 2 } }).run();
    const run = evidence(sink);
    expect(run.reads.rows).toMatchObject([{ id: 'retry#0', keys: ['second'] }]);
    expect(sink.entries.filter((e) => e.kind === 'note' && e.note === 'attempt')).toHaveLength(2);
    expect(run.attention.rows[0].marks.length).toBeGreaterThan(0);
    expect(run.stops.rows).toEqual([]);
  });

  it('does not relabel a keys-declaring log when resume disables reads', async () => {
    const sink = memorySink();
    const chart = flowChart(
      'Seed',
      (s) => {
        s.value = 1;
      },
      'seed',
    )
      .addPausableFunction(
        'Ask',
        {
          execute: () => ({}),
          resume: (s) => {
            s.result = s.value;
          },
        },
        'ask',
      )
      .build();
    const ex = new FlowChartExecutor(chart, { sink });
    await ex.run();
    ex.setReadTracking('off');
    await ex.resume(ex.getCheckpoint(), {});
    expect(sink.entries.filter((e) => e.kind === 'opened')).toHaveLength(1);
    expect(sink.entries[0].collects.reads).toBe('keys');
    expect(evidence(sink).reads.status).toBe('partial');
  });

  it.each([false, true])('declares and collects using the actual writer with readSources=%s', async (readSources) => {
    const sink = memorySink();
    const ex = new FlowChartExecutor(route(), { sink, readSources });
    await ex.run();
    expect(sink.entries[0].collects).toEqual({ v: 1, reads: 'keys' });
    const run = evidence(sink);
    expect(run.unread).toEqual([]);
    expect(run.decisions.status).toBe('collected');
    expect(run.decisions.rows).toMatchObject([{ id: 'route#1', by: 'decide', chosen: 'Accept' }]);
    expect(run.reads.rows.find((row) => row.id === 'route#1').keys).toContain('score');
    expect(run.control('yes#2')).toMatchObject({ decider: 'route#1', label: 'Over five' });
  });

  it('keeps bundles and frame own keys identical with evidence on, off or no sink', async () => {
    const results = [];
    const keys = [];
    for (const mode of ['plain', 'on', 'off']) {
      const sink = memorySink();
      const ex = new FlowChartExecutor(
        route(),
        mode === 'plain' ? undefined : { sink: mode === 'off' ? { adapter: sink, evidence: 'off' } : sink },
      );
      await ex.run();
      results.push(ex.getSnapshot().commitLog);
      const runtime = ex.traverser.deps.executionRuntime;
      keys.push(Reflect.ownKeys(runtime.rootStageContext));
      if (mode === 'off') {
        expect(sink.entries[0]).not.toHaveProperty('collects');
        expect(sink.entries.filter((e) => e.kind === 'note' && e.note.startsWith('run.'))).toEqual([]);
        expect(sink.entries.filter((e) => e.kind === 'commit').every((e) => !Object.hasOwn(e, 'about'))).toBe(true);
      }
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(keys[1]).toEqual(keys[0]);
    expect(keys[2]).toEqual(keys[0]);
  });

  it.each(['off', 'summary', 'full'])('reports the actual %s read dial without changing it', async (readTracking) => {
    const sink = memorySink();
    const ex = new FlowChartExecutor(route(), { sink, readTracking });
    await ex.run();
    const run = evidence(sink);
    expect(sink.entries[0].collects.reads).toBe(readTracking === 'off' ? 'off' : 'keys');
    expect(run.reads.status).toBe(readTracking === 'off' ? 'not-collected' : 'collected');
    expect(run.decisions.rows).toHaveLength(1);
  });

  it('records zero selection as a real dispatch, and a selector break as a stop without dispatch', async () => {
    for (const stop of [false, true]) {
      const sink = memorySink();
      const chart = flowChart('Seed', () => {}, 'seed')
        .addSelectorFunction(
          'Pick',
          (s) => {
            if (stop) s.$break('enough');
            return select(s, []);
          },
          'pick',
        )
        .addFunctionBranch('one', 'One', () => {
          throw new Error('not selected');
        })
        .end()
        .build();
      await new FlowChartExecutor(chart, { sink }).run();
      const run = evidence(sink);
      expect(run.unread).toEqual([]);
      if (stop) {
        expect(run.decisions.rows).toEqual([]);
        expect(run.stops.rows).toMatchObject([{ id: 'pick#1', by: 'break', reason: 'enough' }]);
      } else {
        expect(run.decisions.rows).toMatchObject([{ id: 'pick#1', by: 'select', chosen: [], total: 1 }]);
      }
    }
  });

  it('preserves the native failure rejection and records only its served named error fields', async () => {
    const sink = memorySink();
    const error = Object.assign(new Error('native failure'), { code: 'FAIL', cause: { secret: 'not copied' } });
    const chart = flowChart(
      'Fail',
      (s) => {
        s.written = 1;
        throw error;
      },
      'fail',
    ).build();
    const ex = new FlowChartExecutor(chart, { sink });
    await expect(ex.run()).rejects.toBe(error);
    const run = evidence(sink);
    expect(ex.getSnapshot().sharedState.written).toBe(1);
    expect(run.stops.rows).toMatchObject([
      { id: 'fail#0', by: 'failure', error: { message: 'Error: native failure', code: 'FAIL' } },
    ]);
    expect(JSON.stringify(run.stops)).not.toContain('not copied');
    expect(JSON.stringify(run.stops)).not.toContain('raw');
  });

  it('keeps failed first commits partial instead of asserting observed-empty reads', async () => {
    const sink = memorySink();
    const chart = flowChart(
      'Fail commit',
      (s) => {
        s.$getValue('known');
        s.invalid = () => {};
      },
      'fail',
    ).build();
    const ex = new FlowChartExecutor(chart, { sink, initialContext: { known: 1 } });
    await expect(ex.run()).rejects.toThrow();
    const run = evidence(sink);
    expect(sink.entries.filter((e) => e.kind === 'commit')).toHaveLength(0);
    expect(run.reads.status).toBe('partial');
    expect(run.reads.rows).toEqual([]);
    expect(run.stops.rows).toMatchObject([{ id: 'fail#0', by: 'failure' }]);
  });

  it('preserves the explicit paused execution on same and fresh executor re-entry', async () => {
    for (const fresh of [false, true]) {
      const sink = memorySink();
      const chart = flowChart(
        'Seed',
        (s) => {
          s.n = 1;
        },
        'seed',
      )
        .addPausableFunction(
          'Ask',
          {
            execute: () => ({ question: 'continue?' }),
            resume: (s) => {
              s.n += 1;
            },
          },
          'ask',
        )
        .addFunction(
          'End',
          (s) => {
            s.done = true;
          },
          'end',
        )
        .build();
      const first = new FlowChartExecutor(chart, { sink });
      await first.run();
      const checkpoint = first.getCheckpoint();
      const resumed = fresh ? new FlowChartExecutor(chart, { sink }) : first;
      await resumed.resume(checkpoint, {});
      const entries = sink.entries.filter((e) => e.kind === 'commit' && e.about?.resumes);
      expect(entries).toHaveLength(1);
      expect(entries[0].about.resumes).toBe(checkpoint.pausedExecution.runtimeStageId);
      const run = evidence(sink, entries[0].address.logRunId);
      expect(run.unread).toEqual([]);
      expect(resumed.getSnapshot().sharedState).toMatchObject({ n: 2, done: true });
      expect(sink.entries.filter((e) => e.kind === 'note' && e.note === 'run.stop')).toHaveLength(1);
    }
  });
});
