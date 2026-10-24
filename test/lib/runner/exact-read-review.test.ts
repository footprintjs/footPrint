import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';

const source = (ex: FlowChartExecutor<any, any>) => ex.getSnapshot().readSources!;

describe('reviewed exact-source workloads', () => {
  it('hides only selected keys while keeping an unrelated scalar source exact', async () => {
    const ex = new FlowChartExecutor(
      flowChart<{ n: number; secret: string }>(
        'Read',
        (s) => {
          const n = s.n;
          const secret = s.secret;
          expect(n).toBeGreaterThan(0);
          expect(secret).toBe('PRIVATE-VALUE');
        },
        'read',
      ).build(),
      { readSources: true, initialContext: { n: 1, secret: 'PRIVATE-VALUE' } },
    );
    ex.setRedactionPolicy({ keys: ['secret'] });
    await ex.run();
    const rows = source(ex).record!.occurrences;
    expect(rows.find((row) => row.key === 'n')!.source).toEqual({ kind: 'base', base: 1 });
    expect(rows.find((row) => row.key === 'secret')!.source).toEqual({ kind: 'unavailable', reason: 'redacted' });
    expect(JSON.stringify(source(ex))).not.toContain('PRIVATE-VALUE');
  });

  it('copies host limits at setup rather than accepting later edits', async () => {
    const limits = { maxOccurrences: 1 };
    const ex = new FlowChartExecutor(
      flowChart<{ n: number }>(
        'Read',
        (s) => {
          const a = s.n;
          const b = s.n;
          expect(a).toBe(1);
          expect(b).toBe(1);
        },
        'read',
      ).build(),
      { readSources: { limits }, initialContext: { n: 1 } },
    );
    limits.maxOccurrences = 100;
    await ex.run();
    expect(source(ex).record!.occurrences).toHaveLength(1);
    expect(source(ex).status).toBe('partial');
  });

  it.each([null, [], 0, 'many'])('refuses malformed host limits %j', (limits) => {
    expect(
      () => new FlowChartExecutor(flowChart('Empty', () => {}, 'empty').build(), { readSources: { limits } } as any),
    ).toThrow('readSources must be a boolean or an object with limits');
  });

  it('refuses accessor settings without invoking them', () => {
    let reads = 0;
    const limits = Object.defineProperty({}, 'maxBytes', {
      enumerable: true,
      get() {
        reads++;
        return 2048;
      },
    });
    expect(
      () => new FlowChartExecutor(flowChart('Empty', () => {}, 'empty').build(), { readSources: { limits } }),
    ).toThrow('readSources limits must be plain values');
    const settings = Object.defineProperty({}, 'limits', {
      get() {
        reads++;
        return {};
      },
    });
    expect(
      () => new FlowChartExecutor(flowChart('Empty', () => {}, 'empty').build(), { readSources: settings } as any),
    ).toThrow('readSources must be a boolean or an object with limits');
    expect(reads).toBe(0);
  });

  it('refuses the source-setting accessor before generic dial picking can invoke it', () => {
    let calls = 0;
    const options = Object.defineProperty({}, 'readSources', {
      get() {
        calls++;
        return { limits: {} };
      },
    });
    expect(() => new FlowChartExecutor(flowChart('Empty', () => {}, 'empty').build(), options)).toThrow(
      'readSources must be plain data',
    );
    expect(calls).toBe(0);
  });

  it('projects only the five known limits without enumerating arbitrary settings', async () => {
    let checks = 0;
    const limits = new Proxy(
      { maxOccurrences: 1 },
      {
        ownKeys() {
          throw Error('must not enumerate');
        },
        getOwnPropertyDescriptor(target, key) {
          checks++;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    const ex = new FlowChartExecutor(flowChart('Empty', () => {}, 'empty').build(), { readSources: { limits } });
    expect(checks).toBe(5);
    await ex.run();
    expect(source(ex).record!.limits.maxOccurrences).toBe(1);
  });

  it('keeps both actual parallel branches separate', async () => {
    const ex = new FlowChartExecutor(
      flowChart<{ n: number }>('Seed', () => {}, 'seed')
        .addListOfFunction([
          {
            id: 'left',
            name: 'Left',
            fn: async (s) => {
              const n = s.n;
              await Promise.resolve();
              s.left = n + 1;
            },
          },
          {
            id: 'right',
            name: 'Right',
            fn: async (s) => {
              const n = s.n;
              await Promise.resolve();
              s.right = n + 2;
            },
          },
        ])
        .build(),
      { readSources: true, initialContext: { n: 10 } },
    );
    await ex.run();
    const rows = source(ex).record!.occurrences.filter((row) => row.key === 'n');
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.runtimeStageId)).size).toBe(2);
    expect(rows.every((row) => row.source.kind === 'base')).toBe(true);
    expect(source(ex).status).toBe('captured');
  });

  it.each([false, true])(
    'discloses default omissions or retains all 15000 loop reads with raised limits (raised=%s)',
    async (raised) => {
      let turns = 0;
      const chart = flowChart<{ n: number }>(
        'Increment',
        (s) => {
          s.n = s.n + 1;
        },
        'inc',
      )
        .addFunction(
          'Observe',
          (s) => {
            const n = s.n;
            expect(n).toBeGreaterThan(0);
          },
          'observe',
        )
        .addFunction(
          'Stop',
          (s) => {
            const n = s.n;
            expect(n).toBeGreaterThan(0);
            if (++turns === 5000) s.$break();
          },
          'stop',
        )
        .loopTo('inc')
        .build();
      const ex = new FlowChartExecutor(chart, {
        readSources: raised ? { limits: { maxOccurrences: 16000, maxBytes: 8 * 1024 * 1024 } } : true,
        readTracking: 'off',
        writeTracking: 'off',
        initialContext: { n: 0 },
      });
      await ex.run({ maxIterations: 5000 });
      expect(turns).toBe(5000);
      const result = source(ex);
      if (raised) {
        expect(result.record!.occurrences).toHaveLength(15000);
        expect(result.record!.gaps).toEqual([]);
        expect(result.status).toBe('captured');
        expect(result.record!.occurrences.at(-1)!.source.kind).toBe('committed');
      } else {
        expect(result.status).toBe('partial');
        expect(result.record!.occurrences.length).toBeLessThanOrEqual(4096);
        expect(result.record!.gaps).toEqual([
          { reason: 'budget-exhausted', count: 15000 - result.record!.occurrences.length, exact: true },
        ]);
      }
    },
    30000,
  );
});
