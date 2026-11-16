import { readRunEvidence, readStoredRecord } from 'foottrace';
import { memorySink } from 'foottrace/write';
import { expect, it } from 'vitest';

import { decide, flowChart, FlowChartExecutor, interrupt } from '../../../index.js';

function read(sink) {
  return readRunEvidence(readStoredRecord(sink.entries), sink.entries[0].address.logRunId);
}

it('mapper evidence never adds hostile prototype inspection or replaces the operational rejection', async () => {
  const counts = [];
  for (const mode of ['plain', 'off', 'on']) {
    const sink = memorySink();
    let inspected = 0;
    const inspection = new Error('inspection must not escape');
    const original = new Proxy(new Error('operational mapper failure'), {
      getPrototypeOf() {
        if (++inspected === 3) throw inspection;
        return Error.prototype;
      },
    });
    const inner = flowChart('Inside', () => {}, 'inside').build();
    const chart = flowChart('Seed', () => {}, 'seed')
      .addSubFlowChartNext('child', inner, 'Child', {
        inputMapper: () => {
          throw original;
        },
      })
      .build();
    chart.logger = { info() {}, debug() {}, error() {}, warn() {} };
    const ex = new FlowChartExecutor(
      chart,
      mode === 'plain'
        ? undefined
        : {
            sink: mode === 'off' ? { adapter: sink, evidence: 'off' } : sink,
          },
    );
    let rejected;
    try {
      await ex.run();
    } catch (error) {
      rejected = error;
    }
    expect(rejected === original).toBe(true);
    counts.push(inspected);
    if (mode === 'on') expect(read(sink).stops.rows).toMatchObject([{ id: 'child#1', by: 'failure' }]);
  }
  expect(counts[2]).toBe(counts[1]);
});

it.each([false, true])('records a decider break without manufacturing a dispatch (declared=%s)', async (declared) => {
  const sink = memorySink();
  let branches = 0;
  const chart = flowChart('Seed', () => {}, 'seed')
    .addDeciderFunction(
      'Pick',
      (s) => {
        s.before = 1;
        s.$break('enough');
        s.$break('later');
        s.after = 2;
        return declared ? decide(s, [], 'a') : 'a';
      },
      'pick',
    )
    .addFunctionBranch('a', 'A', () => {
      branches++;
    })
    .end()
    .build();
  const ex = new FlowChartExecutor(chart, { sink });
  const live = [];
  ex.attachFlowRecorder({ id: 'order', onDecision: () => live.push('decision'), onBreak: () => live.push('break') });
  await ex.run();
  expect(branches).toBe(0);
  expect(live).toEqual([]); // Keep the existing decider notification law.
  expect(ex.getSnapshot().sharedState).toMatchObject({ before: 1, after: 2 });
  const run = read(sink);
  expect(run.decisions.rows).toEqual([]);
  expect(run.stops.rows).toMatchObject([{ id: 'pick#1', by: 'break', reason: 'enough' }]);
});

it.each(['state', 'input', 'diagnostic'])('decider break uses the shared served %s reason law', async (source) => {
  const sink = memorySink();
  const secret = 'private-decider-break-7814';
  const chart = flowChart(
    'Seed',
    (s) => {
      s.secret = secret;
    },
    'seed',
  )
    .addDeciderFunction(
      'Pick',
      (s) => {
        const reason = source === 'state' ? s.secret : source === 'input' ? s.$getArgs().credential : secret;
        s.$break(reason);
        return 'a';
      },
      'pick',
    )
    .addFunctionBranch('a', 'A', () => {
      throw new Error('not dispatched');
    })
    .end()
    .build();
  const ex = new FlowChartExecutor(chart, { sink });
  ex.setRedactionPolicy(
    source === 'diagnostic' ? { diagnostics: { keys: ['logs.breakReason'] } } : { keys: ['secret', 'credential'] },
  );
  await ex.run({ input: { credential: secret } });
  const stop = read(sink).stops.rows[0];
  expect(stop.reason).toBe('[REDACTED]');
  expect(JSON.stringify(stop)).not.toContain(secret);
});

it.each([false, true])('records an input-mapper failure on its actual entered mount (policy=%s)', async (policy) => {
  const sink = memorySink();
  const secret = 'private-mapper-error-9451';
  const error = new Error(secret);
  const inner = flowChart('Inside', () => {}, 'inside').build();
  const chart = flowChart(
    'Seed',
    (s) => {
      s.value = 1;
    },
    'seed',
  )
    .addSubFlowChartNext('child', inner, 'Child', {
      inputMapper: () => {
        throw error;
      },
    })
    .build();
  const ex = new FlowChartExecutor(chart, { sink });
  if (policy) ex.setRedactionPolicy({ diagnostics: { keys: ['errors.inputMapperError'] } });
  await expect(ex.run()).rejects.toBe(error);
  const run = read(sink);
  expect(run.stops.rows).toHaveLength(1);
  expect(run.stops.rows[0]).toMatchObject({ id: 'child#1', by: 'failure' });
  expect(run.unread).toEqual([]);
  if (policy) expect(JSON.stringify(run.stops)).not.toContain(secret);
  expect(sink.entries.filter((e) => e.kind === 'opened')).toHaveLength(1);
});

it.each(['throw', 'pause'])('records the actual escaping commit failure while handling %s', async (action) => {
  const sink = memorySink();
  const original = new Error('original-stage-error-not-the-commit');
  const chart = flowChart(
    'Bad commit',
    (s) => {
      s.bad = () => {};
      if (action === 'throw') throw original;
      interrupt(s, { private: 'pause-question-not-a-failure' });
    },
    'bad',
  ).build();
  const ex = new FlowChartExecutor(chart, { sink });
  let rejection;
  try {
    await ex.run();
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeDefined();
  expect(rejection).not.toBe(original);
  const run = read(sink);
  expect(run.reads.status).toBe('partial');
  expect(run.stops.rows).toHaveLength(1);
  expect(run.stops.rows[0]).toMatchObject({ id: 'bad#0', by: 'failure' });
  expect(JSON.stringify(run.stops)).not.toContain(original.message);
  expect(JSON.stringify(run.stops)).not.toContain('pause-question-not-a-failure');
  expect(ex.getCheckpoint()).toBeUndefined();
  expect(sink.entries.filter((e) => e.kind === 'commit')).toHaveLength(0);
});

it.each(['decider', 'selector'])('covers the %s commit-failure sibling while its pause unwinds', async (kind) => {
  const sink = memorySink();
  const body = (s) => {
    s.bad = () => {};
    interrupt(s, { question: 'not a completed pause' });
  };
  const builder = flowChart('Seed', () => {}, 'seed');
  const chart = (
    kind === 'decider'
      ? builder.addDeciderFunction('Pick', body, 'pick')
      : builder.addSelectorFunction('Pick', body, 'pick')
  )
    .addFunctionBranch('a', 'A', () => {})
    .end()
    .build();
  const ex = new FlowChartExecutor(chart, { sink });
  await expect(ex.run()).rejects.toThrow();
  const run = read(sink);
  expect(run.stops.rows).toHaveLength(1);
  expect(run.stops.rows[0]).toMatchObject({ id: 'pick#1', by: 'failure' });
  expect(run.decisions.rows).toEqual([]);
  expect(ex.getCheckpoint()).toBeUndefined();
});

it('does not turn a contained output-mapper diagnostic into a terminal stop', async () => {
  const sink = memorySink();
  const inner = flowChart(
    'Inside',
    (s) => {
      s.value = 1;
    },
    'inside',
  ).build();
  const chart = flowChart('Seed', () => {}, 'seed')
    .addSubFlowChartNext('child', inner, 'Child', {
      outputMapper: () => {
        throw new Error('contained');
      },
    })
    .build();
  await new FlowChartExecutor(chart, { sink }).run();
  expect(read(sink).stops.rows).toEqual([]);
});

it('records a failed native subflow seed on its owning mount', async () => {
  const sink = memorySink();
  const inner = flowChart('Inside', () => {}, 'inside').build();
  const chart = flowChart('Seed', () => {}, 'seed')
    .addSubFlowChartNext('child', inner, 'Child', { inputMapper: () => ({ invalid: () => {} }) })
    .build();
  const ex = new FlowChartExecutor(chart, { sink });
  await expect(ex.run()).rejects.toThrow();
  expect(read(sink).stops.rows).toMatchObject([{ id: 'child#1', by: 'failure' }]);
  expect(read(sink).unread).toEqual([]);
});
