import { runInNewContext } from 'node:vm';

import { memorySink } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';

describe('native external-call saved evidence', () => {
  it('notes invocation before supplied work, then keeps actual bounded references beside the ending attempt', async () => {
    const sink = memorySink();
    let sawStart = false;
    const ex = new FlowChartExecutor(
      flowChart(
        'Call',
        async (s) => {
          const value = await s.$call(
            'inventory.lookup',
            () => {
              sawStart = sink.entries.some((e) => e.kind === 'note' && e.note === 'attempt-start');
              return { ref: 'output:1', remote: 'request:1' };
            },
            undefined,
            {
              evidence: {
                inputRefs: ['input:1'],
                observe: (answer: any) => ({ outputRefs: [answer.ref], remoteRequestId: answer.remote }),
              },
            } as any,
          );
          s.result = value.ref;
        },
        'call',
      ).build(),
      { sink },
    );
    await ex.run();
    expect(sawStart).toBe(true);
    const start = sink.entries.find((e) => e.kind === 'note' && e.note === 'attempt-start') as any;
    expect(start.data).toMatchObject({ series: 'call#0@1.1', attempt: 1, inputRefs: ['input:1'] });
    expect(start.data).not.toHaveProperty('outcome');
    const end = sink.entries.find((e) => e.kind === 'note' && e.note === 'attempt') as any;
    expect(end.data).toMatchObject({
      inputRefs: ['input:1'],
      outputRefs: ['output:1'],
      remoteRequestId: 'request:1',
      record: { outcome: 'ok', kind: 'call' },
    });
  });

  it('records omission counts using serialized JSON UTF-8 byte limits, not character counts', async () => {
    const sink = memorySink();
    const ex = new FlowChartExecutor(
      flowChart(
        'Call',
        async (s) => {
          await s.$call('read', () => 1, undefined, {
            evidence: {
              inputRefs: [...Array.from({ length: 33 }, (_, i) => `ref:${i}`), 'x'.repeat(199)],
              observe: () => ({ outputRefs: ['😀'.repeat(50), 'ok'], remoteRequestId: 'x'.repeat(199) }),
            },
          } as any);
        },
        'call',
      ).build(),
      { sink },
    );
    await ex.run();
    const end = sink.entries.find((e) => e.kind === 'note' && e.note === 'attempt') as any;
    expect(end.data.inputRefs).toHaveLength(32);
    expect(end.data.inputRefsOmitted).toBe(2);
    expect(end.data.outputRefs).toEqual(['ok']);
    expect(end.data.outputRefsOmitted).toBe(1);
    expect(end.data).not.toHaveProperty('remoteRequestId');
  });

  it('does not put an answer witness on writes before delivery, but snapshots it after await', async () => {
    const ex = new FlowChartExecutor(
      flowChart(
        'Call',
        async (s) => {
          s.before = 1;
          const answer = await s.$call('read', () => 2);
          s.after = answer;
        },
        'call',
      ).build(),
      { writeProvenance: 'reads-prefix' },
    );
    await ex.run();
    const trace = ex.getSnapshot().commitLog[0].trace as any[];
    expect(trace.find((row) => row.path === 'before')).not.toHaveProperty('readAttempts');
    expect(trace.find((row) => row.path === 'after').readAttempts).toEqual(['call#0@1.1@1']);
  });

  it('capture observer failure cannot change the returned business value', async () => {
    const ex = new FlowChartExecutor(
      flowChart(
        'Call',
        async (s) => {
          s.result = await s.$call('read', () => 42, undefined, {
            evidence: {
              observe() {
                throw new Error('capture');
              },
            },
          } as any);
        },
        'call',
      ).build(),
    );
    await ex.run();
    expect(ex.getSnapshot().sharedState.result).toBe(42);
  });

  it('uses only served effect keys and applies the existing named redaction to provider identities', async () => {
    const sink = memorySink();
    const ex = new FlowChartExecutor(
      flowChart(
        'Call',
        async (s) => {
          await s.$call('inventory.write', () => 1, undefined, {
            touches: 'inventory',
            idempotencyKey: 'private-key',
            evidence: { observe: () => ({ remoteRequestId: 'private-remote' }) },
          } as any);
        },
        'call',
      ).build(),
      { sink },
    );
    ex.setRedactionPolicy({ keys: ['idempotencyKey', 'remoteRequestId'] });
    await ex.run();
    const encoded = JSON.stringify(sink.entries);
    expect(encoded).not.toContain('private-key');
    expect(encoded).not.toContain('private-remote');
    const start = sink.entries.find((e) => e.kind === 'note' && e.note === 'attempt-start') as any;
    expect(start.data).not.toHaveProperty('recordedKey');
  });

  it('does not retain a previous discarded attempt answer in a retried frame', async () => {
    const sink = memorySink();
    let attempt = 0;
    const ex = new FlowChartExecutor(
      flowChart(
        'Call',
        async (s) => {
          attempt++;
          s.before = attempt;
          s.answer = await s.$call('read', () => 7);
          if (attempt === 1) throw new Error('retry');
        },
        'call',
      )
        .retry({ attempts: 2 })
        .build(),
      { sink, writeProvenance: 'reads-prefix' },
    );
    await ex.run();
    const trace = ex.getSnapshot().commitLog[0].trace as any[];
    expect(trace.find((r) => r.path === 'before')).not.toHaveProperty('readAttempts');
    expect(trace.find((r) => r.path === 'answer').readAttempts).toEqual(['call#0@2.1@1']);
    expect(sink.entries.filter((e) => e.kind === 'note' && e.note === 'attempt-start')).toHaveLength(2);
  });

  it('dial-off and later stages have no direct call witness', async () => {
    const make = () =>
      flowChart(
        'Call',
        async (s) => {
          s.answer = await s.$call('read', () => 7);
        },
        'call',
      )
        .addFunction(
          'Consume state',
          (s) => {
            s.nextAnswer = s.answer;
          },
          'consume',
        )
        .build();
    const off = new FlowChartExecutor(make());
    await off.run();
    expect(JSON.stringify(off.getSnapshot().commitLog)).not.toContain('readAttempts');
    const on = new FlowChartExecutor(make(), { writeProvenance: 'reads-prefix' });
    await on.run();
    const later = on.getSnapshot().commitLog[1].trace as any[];
    expect(later[0]).not.toHaveProperty('readAttempts');
    expect(later[0].readKeys).toContain('answer');
  });

  it('keeps live observer writes before answer delivery outside the answer prefix', async () => {
    let active: any;
    const ex = new FlowChartExecutor(
      flowChart(
        'Call',
        async (s) => {
          active = s;
          s.answer = await s.$call('read', () => 7);
        },
        'call',
      ).build(),
      { writeProvenance: 'reads-prefix' },
    );
    ex.attachFlowRecorder({
      id: 'capture-order',
      onAttempt: () => {
        active.observer = 1;
      },
    });
    await ex.run();
    const trace = ex.getSnapshot().commitLog[0].trace as any[];
    expect(trace.find((r) => r.path === 'observer')).not.toHaveProperty('readAttempts');
    expect(trace.find((r) => r.path === 'answer').readAttempts).toEqual(['call#0@1.1@1']);
  });

  it('does not execute descriptor getters, and consumes unsupported async capture rejection without waiting', async () => {
    let getters = 0;
    const bad = Object.defineProperty({}, 'inputRefs', {
      get() {
        getters++;
        throw new Error('must not run');
      },
    });
    const ex = new FlowChartExecutor(
      flowChart(
        'Call',
        async (s) => {
          s.first = await s.$call('read', () => 7, undefined, { evidence: bad } as any);
          s.second = await s.$call('read', () => 8, undefined, {
            evidence: { observe: () => Promise.reject(new Error('capture-only')) },
          } as any);
        },
        'call',
      ).build(),
    );
    await ex.run();
    expect(getters).toBe(0);
    expect(ex.getSnapshot().sharedState).toMatchObject({ first: 7, second: 8 });
  });

  it('isolates an accessor or inherited evidence option before invoking the business function', async () => {
    let getters = 0;
    const accessor = Object.defineProperty({}, 'evidence', {
      get() {
        getters++;
        throw new Error('capture-only');
      },
    });
    const inherited = Object.create({
      get evidence() {
        getters++;
        throw new Error('inherited capture');
      },
    });
    const ex = new FlowChartExecutor(
      flowChart(
        'Call',
        async (s) => {
          s.first = await s.$call('read', () => 7, undefined, accessor);
          s.second = await s.$call('read', () => 8, undefined, inherited);
        },
        'call',
      ).build(),
    );
    await ex.run();
    expect(getters).toBe(0);
    expect(ex.getSnapshot().sharedState).toMatchObject({ first: 7, second: 8 });
  });

  it('parallel call answers enter only their owning facade prefix at delivery', async () => {
    const ex = new FlowChartExecutor(
      flowChart(
        'Call',
        async (s) => {
          let finish!: (value: number) => void;
          const slow = s.$call(
            'slow',
            () =>
              new Promise<number>((resolve) => {
                finish = resolve;
              }),
          );
          s.fast = await s.$call('fast', () => 2);
          finish(1);
          s.both = (await slow) + s.fast;
        },
        'call',
      ).build(),
      { writeProvenance: 'reads-prefix' },
    );
    await ex.run();
    const trace = ex.getSnapshot().commitLog[0].trace as any[];
    expect(trace.find((r) => r.path === 'fast').readAttempts).toEqual(['call#0@1.2@1']);
    expect(trace.find((r) => r.path === 'both').readAttempts).toEqual(['call#0@1.2@1', 'call#0@1.1@1']);
  });

  it('late transport settlement after stage completion cannot provide a witness to another stage', async () => {
    let finish!: (value: number) => void;
    const ex = new FlowChartExecutor(
      flowChart(
        'Start',
        (s) => {
          s.$call(
            'slow',
            () =>
              new Promise<number>((resolve) => {
                finish = resolve;
              }),
          );
          s.before = 1;
        },
        'start',
      )
        .addFunction(
          'Later',
          async (s) => {
            finish(9);
            await Promise.resolve();
            s.after = 2;
          },
          'later',
        )
        .build(),
      { writeProvenance: 'reads-prefix' },
    );
    await ex.run();
    expect(
      ex
        .getSnapshot()
        .commitLog.flatMap((b) => b.trace ?? [])
        .every((r) => !Object.hasOwn(r, 'readAttempts')),
    ).toBe(true);
  });

  it('keeps exact JSON byte boundary identities and records empty only when explicitly supplied', async () => {
    const sink = memorySink();
    const exact = 'x'.repeat(198);
    const ex = new FlowChartExecutor(
      flowChart(
        'Call',
        async (s) => {
          await s.$call('first', () => 1, undefined, {
            evidence: { inputRefs: [], observe: () => ({ outputRefs: [exact], remoteRequestId: exact }) },
          });
          await s.$call('second', () => 2);
        },
        'call',
      ).build(),
      { sink },
    );
    await ex.run();
    const ending = sink.entries.filter((e) => e.kind === 'note' && e.note === 'attempt') as any[];
    expect(ending[0].data).toMatchObject({ inputRefs: [], outputRefs: [exact], remoteRequestId: exact });
    expect(ending[1].data).not.toHaveProperty('inputRefs');
    expect(ending[1].data).not.toHaveProperty('outputRefs');
  });

  it('retains eligible whole references only within the inspected prefix', async () => {
    const sink = memorySink();
    const valid = Array.from({ length: 32 }, (_, i) => `ref:${i}`);
    const ex = new FlowChartExecutor(
      flowChart(
        'Call',
        async (s) => {
          await s.$call('read', () => 1, undefined, { evidence: { inputRefs: ['x'.repeat(199), ...valid] } });
        },
        'call',
      ).build(),
      { sink },
    );
    await ex.run();
    const ending = sink.entries.find((e) => e.kind === 'note' && e.note === 'attempt') as any;
    expect(ending.data.inputRefs).toEqual(valid.slice(0, 31));
    expect(ending.data.inputRefsOmitted).toBe(2);
  });

  it('consumes unsupported cross-realm native Promise rejections without invoking thenable getters', async () => {
    let getters = 0;
    let foreign: Promise<unknown> | undefined;
    let unhandled = 0;
    const track = (_reason: unknown, promise: Promise<unknown>) => {
      if (promise === foreign) unhandled++;
    };
    const thenable = Object.defineProperty({ outputRefs: ['actual:1'] }, 'then', {
      get() {
        getters++;
        throw new Error('not metadata');
      },
    });
    const ex = new FlowChartExecutor(
      flowChart(
        'Call',
        async (s) => {
          s.first = await s.$call('read', () => 7, undefined, {
            evidence: {
              observe: () => {
                foreign = runInNewContext("Promise.reject(new Error('cross-realm capture'))");
                return foreign as any;
              },
            },
          });
          s.second = await s.$call('read', () => 8, undefined, { evidence: { observe: () => thenable } });
        },
        'call',
      ).build(),
    );
    process.on('unhandledRejection', track);
    try {
      await ex.run();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toBe(0);
      expect(getters).toBe(0);
      expect(ex.getSnapshot().sharedState).toMatchObject({ first: 7, second: 8 });
    } finally {
      process.off('unhandledRejection', track);
    }
  });
});
