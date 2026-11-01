import { runInNewContext } from 'node:vm';

import { buildAttemptId, parseAttemptId } from 'foottrace';
import { memorySink } from 'foottrace/write';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { disableDevMode, enableDevMode, flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { callSeries } from '../../../../src/lib/attempt/call.js';

vi.mock('foottrace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('foottrace')>();
  return { ...actual, buildAttemptId: vi.fn(actual.buildAttemptId) };
});

afterEach(() => {
  disableDevMode();
  vi.restoreAllMocks();
});
const notes = (sink: ReturnType<typeof memorySink>, name: string) =>
  sink.entries.filter((e) => e.kind === 'note' && e.note === name) as any[];
const FIXED_WARNING = '[footprint] $call evidence refused; business outcome unchanged';

describe('Claude #142 native evidence findings', () => {
  it('builds the delivered witness with the official codec after the ending observation', async () => {
    const sink = memorySink();
    const ex = new FlowChartExecutor(
      flowChart(
        'Call',
        async (s) => {
          s.answer = await s.$call('read', () => 7);
          // The ending observer cleared earlier attention-codec calls; this is specifically the delivery seam.
          expect(buildAttemptId).toHaveBeenCalledWith('call#0', 1, { ordinal: 1, attempt: 1 });
        },
        'call',
      ).build(),
      { sink, writeProvenance: 'reads-prefix' },
    );
    ex.attachFlowRecorder({
      id: 'codec-boundary',
      onAttempt: (e) => {
        if (e.record.kind === 'call') vi.mocked(buildAttemptId).mockClear();
      },
    });
    await ex.run();
    const record = notes(sink, 'attempt').find((n) => n.data.record.kind === 'call').data.record;
    const id = buildAttemptId('call#0', 1, { ordinal: 1, attempt: record.attempt });
    expect(record.series).toBe(callSeries('call#0', 1, 1));
    expect(ex.getSnapshot().commitLog[0].trace[0].readAttempts).toEqual([id]);
  });

  it('joins saved ending records and witnesses across call retries, parallel ordinals and a subflow owner', async () => {
    const sink = memorySink();
    let tries = 0;
    const inner = flowChart(
      'Calls',
      async (s) => {
        const retry = s.$call(
          'retry',
          () => {
            if (++tries === 1) throw new Error('retry');
            return 1;
          },
          { attempts: 2 },
        );
        const other = s.$call('other', () => 2);
        s.total = (await retry) + (await other);
      },
      'calls',
    ).build();
    const ex = new FlowChartExecutor(
      flowChart('Seed', () => {}, 'seed')
        .addSubFlowChartNext('inner', inner, 'Inner')
        .build(),
      { sink, writeProvenance: 'reads-prefix' },
    );
    await ex.run();
    const endings = notes(sink, 'attempt').filter((n) => n.data.record.kind === 'call');
    const answerNotes = endings.filter((n) => n.data.record.outcome === 'ok');
    expect(answerNotes).toHaveLength(2);
    const owner = 'inner/calls#2';
    const expected = answerNotes.map((n) => {
      const record = n.data.record;
      const ordinal = record.target === 'retry' ? 1 : 2;
      expect(record.series).toBe(callSeries(owner, 1, ordinal));
      return buildAttemptId(owner, 1, { ordinal, attempt: record.attempt });
    });
    const commits = sink.entries.filter((e) => e.kind === 'commit') as any[];
    const writes = commits.flatMap((e) => e.bundle?.trace ?? e.commit?.trace ?? []);
    // The isolated subflow log is owned by its sink address, not flattened into the parent's commit log.
    const total = writes.find((r) => r.path === 'total');
    expect(total?.readAttempts?.slice().sort()).toEqual(expected.sort());
    expect(expected.map((id) => parseAttemptId(id)?.call?.attempt).sort()).toEqual([1, 2]);
  });

  it.each([
    ['wrong list', { evidence: { inputRefs: 'PRIVATE_INPUT' } }],
    ['wrong reference', { evidence: { inputRefs: [42] } }],
    ['null descriptor', { evidence: null }],
    ['wrong observer', { evidence: { observe: 1 } }],
    [
      'refused evidence accessor',
      Object.defineProperty({}, 'evidence', {
        get() {
          throw new Error('PRIVATE_ACCESSOR');
        },
      }),
    ],
  ])(
    'marks refused input evidence at starts and endings, warning once per retried series: %s',
    async (_label, options) => {
      enableDevMode();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const sink = memorySink();
      let tries = 0;
      const ex = new FlowChartExecutor(
        flowChart(
          'Call',
          async (s) => {
            s.answer = await s.$call(
              'read',
              () => {
                if (++tries === 1) throw new Error('retry');
                return 7;
              },
              { attempts: 2 },
              options as any,
            );
          },
          'call',
        ).build(),
        { sink },
      );
      await ex.run();
      expect(ex.getSnapshot().sharedState.answer).toBe(7);
      expect(notes(sink, 'attempt-start').map((n) => n.data.evidenceRefused)).toEqual([true, true]);
      expect(
        notes(sink, 'attempt')
          .filter((n) => n.data.record.kind === 'call')
          .map((n) => n.data.evidenceRefused),
      ).toEqual([true, true]);
      expect(warn.mock.calls).toEqual([[FIXED_WARNING]]);
      expect(JSON.stringify(sink.entries)).not.toContain('PRIVATE');
    },
  );

  it.each([
    [
      'throw',
      () => {
        throw new Error('PRIVATE_OBSERVER');
      },
    ],
    ['async rejection', () => Promise.reject(new Error('PRIVATE_ASYNC'))],
    ['cross realm rejection', () => runInNewContext("Promise.reject(new Error('PRIVATE_REALM'))")],
    ['undefined return', () => undefined],
    ['null return', () => null],
    ['primitive return', () => 42],
    [
      'refused output accessor',
      () =>
        Object.defineProperty({}, 'outputRefs', {
          get() {
            throw new Error('PRIVATE_OUTPUT');
          },
        }),
    ],
    ['oversize remote identity', () => ({ remoteRequestId: 'x'.repeat(199) })],
  ])('marks only ending notes for refused answer evidence: %s', async (_label, observe) => {
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = memorySink();
    const ex = new FlowChartExecutor(
      flowChart(
        'Call',
        async (s) => {
          s.answer = await s.$call('read', () => 7, undefined, { evidence: { observe } } as any);
        },
        'call',
      ).build(),
      { sink },
    );
    await ex.run();
    expect(ex.getSnapshot().sharedState.answer).toBe(7);
    expect(notes(sink, 'attempt-start')[0].data).not.toHaveProperty('evidenceRefused');
    expect(notes(sink, 'attempt')[0].data).toMatchObject({ evidenceRefused: true });
    expect(notes(sink, 'attempt')[0].data).not.toHaveProperty('remoteRequestId');
    expect(warn.mock.calls).toEqual([[FIXED_WARNING]]);
    expect(JSON.stringify(sink.entries)).not.toContain('PRIVATE');
  });

  it('treats explicit absence and empty valid observations separately from malformed capture', async () => {
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = memorySink();
    const ex = new FlowChartExecutor(
      flowChart(
        'Call',
        async (s) => {
          for (const evidence of [undefined, {}, { inputRefs: undefined }, { inputRefs: [], observe: () => ({}) }]) {
            await s.$call('read', () => 7, undefined, { evidence });
          }
        },
        'call',
      ).build(),
      { sink },
    );
    await ex.run();
    expect(JSON.stringify(sink.entries)).not.toContain('evidenceRefused');
    expect(warn).not.toHaveBeenCalled();
    expect(notes(sink, 'attempt')[3].data.inputRefs).toEqual([]);
  });

  it('records refusal with warnings off, redacts the flag, and isolates a throwing warning sink', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('logger failed');
    });
    const sink = memorySink();
    const make = () =>
      flowChart(
        'Call',
        async (s) => {
          s.answer = await s.$call('read', () => 7, undefined, { evidence: null } as any);
        },
        'call',
      ).build();
    const off = new FlowChartExecutor(make(), { sink });
    await off.run();
    expect(notes(sink, 'attempt')[0].data.evidenceRefused).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    enableDevMode();
    const redacted = new FlowChartExecutor(make(), { sink });
    redacted.setRedactionPolicy({ keys: ['evidenceRefused'] });
    await expect(redacted.run()).resolves.toBeUndefined();
    expect(redacted.getSnapshot().sharedState.answer).toBe(7);
    expect(notes(sink, 'attempt')[1].data.evidenceRefused).not.toBe(true);
    expect(warn.mock.calls).toEqual([[FIXED_WARNING]]);
    const throwing = new FlowChartExecutor(make(), { sink });
    await throwing.run();
    expect(notes(sink, 'attempt-start')).toHaveLength(3);
    expect(notes(sink, 'attempt-start')[2].data.evidenceRefused).toBe(true);
    expect(notes(sink, 'attempt')[2].data.evidenceRefused).toBe(true);
    expect(throwing.getSnapshot().sharedState.answer).toBe(7);
    expect(warn.mock.calls).toEqual([[FIXED_WARNING], [FIXED_WARNING]]);
  });

  it('can warn once at a later refusal boundary if dev mode was enabled after invocation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = memorySink();
    const ex = new FlowChartExecutor(
      flowChart(
        'Call',
        async (s) => {
          s.answer = await s.$call(
            'read',
            () => {
              enableDevMode();
              return 7;
            },
            undefined,
            { evidence: null } as any,
          );
        },
        'call',
      ).build(),
      { sink },
    );
    await ex.run();
    expect(warn.mock.calls).toEqual([[FIXED_WARNING]]);
    expect(notes(sink, 'attempt-start')[0].data.evidenceRefused).toBe(true);
    expect(notes(sink, 'attempt')[0].data.evidenceRefused).toBe(true);
  });

  it('never replaces the original business rejection, and does not mark earlier failed retries for a later answer refusal', async () => {
    const sink = memorySink();
    const original = new Error('service failure');
    let caught: unknown;
    let tries = 0;
    const ex = new FlowChartExecutor(
      flowChart(
        'Call',
        async (s) => {
          try {
            await s.$call(
              'failed',
              () => {
                throw original;
              },
              undefined,
              { evidence: null } as any,
            );
          } catch (error) {
            caught = error;
          }
          s.answer = await s.$call(
            'retry',
            () => {
              if (++tries === 1) throw original;
              return 7;
            },
            { attempts: 2 },
            {
              evidence: {
                observe() {
                  throw new Error('observer');
                },
              },
            },
          );
        },
        'call',
      ).build(),
      { sink },
    );
    await ex.run();
    expect(caught).toBe(original);
    const retry = notes(sink, 'attempt').filter((n) => n.data.record.target === 'retry');
    expect(retry.map((n) => n.data.evidenceRefused)).toEqual([undefined, true]);
    expect(ex.getSnapshot().sharedState.answer).toBe(7);
  });

  it('emits no refusal warning for a zero-start call', async () => {
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new AbortController();
    const sink = memorySink();
    let calls = 0;
    const ex = new FlowChartExecutor(
      flowChart(
        'Call',
        async (s) => {
          controller.abort(new Error('stop'));
          await s.$call('read', () => ++calls, undefined, { evidence: null } as any);
        },
        'call',
      ).build(),
      { sink },
    );
    await ex.run({ env: { signal: controller.signal } }).catch(() => {});
    expect(calls).toBe(0);
    expect(notes(sink, 'attempt-start')).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('counts quotes, escapes and Unicode using the exact 200-byte JSON UTF-8 boundary', async () => {
    const sink = memorySink();
    const exact = ['x'.repeat(198), '"'.repeat(99), '😀'.repeat(49) + 'aa'];
    const over = ['x'.repeat(199), '"'.repeat(100), '😀'.repeat(49) + 'aaa'];
    const ex = new FlowChartExecutor(
      flowChart(
        'Call',
        async (s) => {
          await s.$call('read', () => 7, undefined, { evidence: { inputRefs: [...exact, ...over] } });
        },
        'call',
      ).build(),
      { sink },
    );
    await ex.run();
    const data = notes(sink, 'attempt')[0].data;
    expect(data.inputRefs).toEqual(exact);
    expect(data.inputRefsOmitted).toBe(3);
    expect(data).not.toHaveProperty('evidenceRefused');
  });
});
