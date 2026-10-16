/**
 * The static time budget at its edges (design §3.2, packet P5; threat model: the computation must terminate on huge
 * or looping charts, never overflow, and keep its work bounded).
 *
 * Test types: Boundary (numbers past every safe range saturate — never `Infinity` or `NaN`; a function backoff over
 * more waits than the check will ask is unbounded `backoff`, asked a bounded number of times; a 50 000-stage chain
 * and a 5 000-deep subflow nesting walk without a stack overflow; a loop with no assumption; `assume` refusals; a
 * budget exactly equal to the worst case is kept).
 */
import { describe, expect, it } from 'vitest';

import type { FlowChart, StageNode } from '../../../../src/index.js';
import { flowChart, timeBudget } from '../../../../src/index.js';
import { MAX_BACKOFF_ASKS } from '../../../../src/lib/budget/timeBudget.js';

const noop = () => undefined;

describe('numbers past every safe range saturate', () => {
  it('a huge policy saturates at Number.MAX_SAFE_INTEGER — never Infinity, never NaN', () => {
    const chart = flowChart('A', noop, 'a', {
      retry: { attempts: 2 ** 52, timeoutMs: Number.MAX_VALUE, backoffMs: Number.MAX_VALUE },
    })
      .addFunction('B', noop, 'b')
      .retry({ attempts: 1, timeoutMs: 1e300 })
      .build();

    const report = timeBudget(chart, { budgetMs: Number.MAX_VALUE });

    expect(report.worstCaseMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(report.knownMs).toBe(Number.MAX_SAFE_INTEGER);
    for (const step of report.criticalPath) {
      expect(Number.isFinite(step.worstMs!)).toBe(true);
      expect(Number.isFinite(step.backoffMs)).toBe(true);
    }
    expect(report.over).toBe(false);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('passes multiply and saturate too', () => {
    const chart = flowChart('A', noop, 'a', { retry: { attempts: 1, timeoutMs: 1e15 } })
      .loopTo('a')
      .build();
    const report = timeBudget(chart, { assume: { loops: { a: Number.MAX_SAFE_INTEGER } } });
    expect(report.worstCaseMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(report.criticalPath[0].passes).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('a function backoff over too many waits', () => {
  it(`is asked at most ${MAX_BACKOFF_ASKS} times, and the stage is unbounded (backoff)`, () => {
    let asked = 0;
    const chart = flowChart('A', noop, 'a', {
      retry: {
        attempts: 1_000_000,
        timeoutMs: 1,
        backoffMs: () => {
          asked += 1;
          return 2;
        },
      },
    }).build();

    const report = timeBudget(chart);

    expect(asked).toBe(MAX_BACKOFF_ASKS);
    expect(report.worstCaseMs).toBeNull();
    expect(report.unbounded).toEqual([{ stageId: 'a', why: 'backoff' }]);
    // the waits it did read are a floor: 1 000 000 attempts of 1 ms + the first MAX_BACKOFF_ASKS waits of 2 ms
    expect(report.knownMs).toBe(1_000_000 + 2 * MAX_BACKOFF_ASKS);
  });

  it(`exactly ${MAX_BACKOFF_ASKS} waits are all asked and counted`, () => {
    const chart = flowChart('A', noop, 'a', {
      retry: { attempts: MAX_BACKOFF_ASKS + 1, timeoutMs: 1, backoffMs: () => 1 },
    }).build();
    expect(timeBudget(chart).worstCaseMs).toBe(2 * MAX_BACKOFF_ASKS + 1);
  });

  it('a NUMBER backoff over any count is arithmetic — no asking, no cap', () => {
    const chart = flowChart('A', noop, 'a', { retry: { attempts: 10_000_000, timeoutMs: 1, backoffMs: 3 } }).build();
    expect(timeBudget(chart).worstCaseMs).toBe(10_000_000 + 3 * 9_999_999);
  });
});

describe('huge charts walk without a stack overflow', () => {
  it('a 50 000-stage chain', () => {
    let builder = flowChart('S0', noop, 's0', { retry: { attempts: 1, timeoutMs: 1 } });
    for (let i = 1; i < 50_000; i++)
      builder = builder.addFunction(`S${i}`, noop, `s${i}`).retry({ attempts: 1, timeoutMs: 1 });
    const report = timeBudget(builder.build());
    expect(report.worstCaseMs).toBe(50_000);
    expect(report.criticalPath).toHaveLength(50_000);
  });

  it('a 5 000-deep subflow nesting (hand-built)', () => {
    const depth = 5_000;
    const subflows: Record<string, { root: StageNode }> = {};
    let inner: StageNode = { name: 'leaf', id: 'leaf', fn: noop, retry: { attempts: 1, timeoutMs: 7 } };
    for (let d = depth; d >= 1; d--) {
      subflows[`m${d}`] = { root: inner };
      inner = { name: `m${d}`, id: `m${d}`, isSubflowRoot: true, subflowId: `m${d}` };
    }
    const chart = {
      root: inner,
      stageMap: new Map(),
      subflows,
      buildTimeStructure: { name: 'm1', id: 'm1', type: 'stage' },
      description: '',
      stageDescriptions: new Map(),
    } as unknown as FlowChart;

    const report = timeBudget(chart);
    expect(report.worstCaseMs).toBe(7);
    expect(report.criticalPath.map((s) => s.stageId)).toEqual(['leaf']);
  });
});

describe('loops, budgets and assumptions at the edge', () => {
  it('a loop with no assumption is unbounded: loop (never iterated)', () => {
    const chart = flowChart('A', noop, 'a', { retry: { attempts: 1, timeoutMs: 5 } })
      .loopTo('a')
      .build();
    const report = timeBudget(chart);
    expect(report.unbounded).toEqual([{ stageId: 'a', why: 'loop' }]);
    expect(report.worstCaseMs).toBeNull();
    expect(report.knownMs).toBe(5);
  });

  it('assume.loops must be whole numbers >= 1; assumed charts must be charts', () => {
    const chart = flowChart('A', noop, 'a').build();
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3' as unknown as number]) {
      expect(() => timeBudget(chart, { assume: { loops: { a: bad } } })).toThrow(TypeError);
    }
    expect(() => timeBudget(chart, { assume: { lazy: { pay: {} as FlowChart } } })).toThrow(TypeError);
    expect(() => timeBudget(chart, { assume: { branches: { b: null as unknown as FlowChart } } })).toThrow(TypeError);
  });

  it('options.budgetMs must be a finite number > 0; the chart must be a built chart', () => {
    const chart = flowChart('A', noop, 'a').build();
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => timeBudget(chart, { budgetMs: bad })).toThrow(TypeError);
    }
    expect(() => timeBudget(undefined as unknown as FlowChart)).toThrow(TypeError);
    expect(() => timeBudget({} as FlowChart)).toThrow(TypeError);
  });

  it('a budget equal to the worst case is kept, one millisecond less is refused at build', () => {
    const at = (budget: number) =>
      flowChart('A', noop, 'a', { retry: { attempts: 3, timeoutMs: 100, backoffMs: 10 } })
        .budget(budget)
        .build();
    expect(() => at(320)).not.toThrow();
    expect(() => at(319)).toThrow(/over its budget by 1 ms/);
  });
});
