/**
 * The static time budget at its edges (design §3.2, packet P5; threat model: the computation must terminate on huge
 * or looping charts, never overflow, and keep its work bounded).
 *
 * Test types: Boundary (numbers past every safe range saturate — never `Infinity` or `NaN`; a function backoff over
 * ten million waits is arithmetic at its ceiling and never asked; a 50 000-stage chain and a 5 000-deep subflow
 * nesting walk without a stack overflow; a graph whose chains share their tails stops at `MAX_WALK` with a
 * `RangeError`; hand-built `null`s are skipped; a loop with no assumption; `assume` refusals; a budget exactly equal
 * to the worst case is kept).
 */
import { describe, expect, it } from 'vitest';

import type { FlowChart, StageNode } from '../../../../src/index.js';
import { flowChart, timeBudget } from '../../../../src/index.js';
import { MAX_WALK } from '../../../../src/lib/budget/timeBudget.js';

const noop = () => undefined;

describe('numbers past every safe range saturate', () => {
  it('a huge policy saturates at Number.MAX_SAFE_INTEGER — never Infinity, never NaN', () => {
    const chart = flowChart('A', noop, 'a', {
      retry: { attempts: 2 ** 52, timeoutMs: Number.MAX_VALUE, backoffMs: Number.MAX_VALUE },
    })
      .addFunction('B', noop, 'b')
      .retry({ attempts: 1, timeoutMs: 1e300 })
      .build();

    const report = timeBudget(chart, { budgetMs: Number.MAX_SAFE_INTEGER });

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

describe('a backoff over a huge number of waits', () => {
  it('a FUNCTION backoff with a ceiling is arithmetic at the ceiling — never asked, however many waits', () => {
    let asked = 0;
    const chart = flowChart('A', noop, 'a', {
      retry: {
        attempts: 10_000_000,
        timeoutMs: 1,
        backoffMs: () => {
          asked += 1;
          return 2;
        },
        maxBackoffMs: 3,
      },
    }).build();

    expect(timeBudget(chart).worstCaseMs).toBe(10_000_000 + 3 * 9_999_999);
    expect(asked).toBe(0);
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

describe('the walk is capped', () => {
  it(`a hand-built graph whose chains share one tail stops past ${MAX_WALK} node visits with a RangeError`, () => {
    // 600 fork children, each continuing into one shared 500-node tail: every child's chain walks the whole tail.
    let tail: StageNode | undefined;
    for (let i = 500; i >= 1; i--) {
      tail = {
        name: `t${i}`,
        id: `t${i}`,
        fn: noop,
        retry: { attempts: 1, timeoutMs: 1 },
        ...(tail && { next: tail }),
      };
    }
    const children: StageNode[] = [];
    for (let c = 0; c < 600; c++) children.push({ name: `c${c}`, id: `c${c}`, fn: noop, next: tail });
    const root: StageNode = { name: 'fork', id: 'fork', children };
    const chart = {
      root,
      stageMap: new Map(),
      buildTimeStructure: { name: 'fork', id: 'fork', type: 'fork' },
      description: '',
      stageDescriptions: new Map(),
    } as unknown as FlowChart;

    const started = Date.now();
    expect(() => timeBudget(chart)).toThrow(RangeError);
    expect(() => timeBudget(chart)).toThrow(/passed 250000 node visits/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('the same shape under the cap is counted — the shared tail runs once per child, at once', () => {
    const tail: StageNode = { name: 'tail', id: 'tail', fn: noop, retry: { attempts: 1, timeoutMs: 7 } };
    const root: StageNode = {
      name: 'fork',
      id: 'fork',
      children: [
        { name: 'a', id: 'a', fn: noop, retry: { attempts: 1, timeoutMs: 1 }, next: tail },
        { name: 'b', id: 'b', fn: noop, retry: { attempts: 1, timeoutMs: 5 }, next: tail },
      ],
    };
    const chart = {
      root,
      stageMap: new Map(),
      buildTimeStructure: { name: 'fork', id: 'fork', type: 'fork' },
      description: '',
      stageDescriptions: new Map(),
    } as unknown as FlowChart;
    expect(timeBudget(chart).worstCaseMs).toBe(12);
  });

  it('a hand-built null next or child is skipped, never dereferenced', () => {
    const root = {
      name: 'a',
      id: 'a',
      fn: noop,
      retry: { attempts: 1, timeoutMs: 3 },
      next: null,
      children: [null, { name: 'b', id: 'b', fn: noop, retry: { attempts: 1, timeoutMs: 4 } }],
    } as unknown as StageNode;
    const chart = {
      root,
      stageMap: new Map(),
      buildTimeStructure: { name: 'a', id: 'a', type: 'stage' },
      description: '',
      stageDescriptions: new Map(),
    } as unknown as FlowChart;
    expect(timeBudget(chart).worstCaseMs).toBe(7);
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

  it('options.budgetMs must be a number > 0 and at most MAX_SAFE_INTEGER; assume an object; the chart a built chart', () => {
    const chart = flowChart('A', noop, 'a').build();
    expect(() => timeBudget(chart, { assume: null as unknown as undefined })).toThrow(/assume must be an object/);
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
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
