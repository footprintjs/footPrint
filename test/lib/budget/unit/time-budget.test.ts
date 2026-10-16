/**
 * The static time budget — `timeBudget(chart)` arithmetic per node kind (design §3.2, packet P5).
 *
 * WHY: a retry policy is a promise about time. `{ attempts: 4, timeoutMs: 40_000, backoffMs: 1_000 }` can take
 * 4 × 40 000 + 3 × 1 000 = 163 000 ms, and a caller who gave the chart 120 s is not served by it — which is knowable
 * before a single stage runs. These tests pin the rules the check counts by, one node kind at a time.
 *
 * Test types: Unit (a stage; a function backoff asked at build; every node kind — sequence, decider, selector,
 * fork, eager / lazy subflow, parallelForEach; loops with and without an assumption, nested and overlapping; the
 * budget and `over`; the spec's `budgetMs` / `timeoutMs`; `.budget()` refusals).
 */
import { describe, expect, it } from 'vitest';

import type { RetryPolicy } from '../../../../src/index.js';
import { flowChart, timeBudget } from '../../../../src/index.js';

const noop = () => undefined;
/** A policy: `attempts` tries capped at `timeoutMs`, `backoffMs` between them. */
const cap = (timeoutMs: number, attempts = 1, backoffMs?: number): RetryPolicy => ({
  attempts,
  timeoutMs,
  ...(backoffMs !== undefined && { backoffMs }),
});
const opt = (timeoutMs: number, attempts = 1, backoffMs?: number) => ({ retry: cap(timeoutMs, attempts, backoffMs) });

describe('timeBudget — one stage', () => {
  it('attempts × timeoutMs + the waits between them: the design worked example is 163 000 ms', () => {
    const chart = flowChart('Read', noop, 'read', opt(5_000))
      .addFunction('Charge', noop, 'charge')
      .retry({ attempts: 4, timeoutMs: 40_000, backoffMs: 1_000 })
      .build();

    const report = timeBudget(chart);

    expect(report.worstCaseMs).toBe(5_000 + 163_000);
    expect(report.knownMs).toBe(168_000);
    expect(report.criticalPath).toEqual([
      { stageId: 'read', attempts: 1, timeoutMs: 5_000, backoffMs: 0, worstMs: 5_000, passes: 1 },
      { stageId: 'charge', attempts: 4, timeoutMs: 40_000, backoffMs: 3_000, worstMs: 163_000, passes: 1 },
    ]);
    expect(report.unbounded).toEqual([]);
    expect(report.over).toBe(false);
    expect(report.budgetMs).toBeUndefined();
  });

  it('a function backoff is NEVER asked — with no maxBackoffMs the stage is unbounded (backoff)', () => {
    let asked = 0;
    const chart = flowChart('Fetch', noop, 'fetch', {
      retry: {
        attempts: 3,
        timeoutMs: 100,
        backoffMs: () => {
          asked += 1;
          return 10;
        },
      },
    }).build();

    const report = timeBudget(chart);

    expect(asked).toBe(0);
    expect(report.worstCaseMs).toBeNull();
    expect(report.unbounded).toEqual([{ stageId: 'fetch', why: 'backoff' }]);
    // the waits are not counted (0) — what IS known is the attempts at their cap
    expect(report.knownMs).toBe(300);
  });

  it('a function backoff with maxBackoffMs counts every wait at the ceiling, still without asking it', () => {
    let asked = 0;
    const chart = flowChart('Fetch', noop, 'fetch', {
      retry: {
        attempts: 3,
        timeoutMs: 100,
        backoffMs: (n: number, error: unknown) => {
          asked += 1;
          return (error as { retryAfterMs?: number } | undefined)?.retryAfterMs ?? 10 * n;
        },
        maxBackoffMs: 250,
      },
    }).build();

    expect(timeBudget(chart).criticalPath).toEqual([
      { stageId: 'fetch', attempts: 3, timeoutMs: 100, backoffMs: 500, worstMs: 800, passes: 1 },
    ]);
    expect(asked).toBe(0);
  });

  it('a number backoff is capped by maxBackoffMs; NaN, a negative or Infinity waits 0 (the runtime law)', () => {
    const capped = flowChart('A', noop, 'a', {
      retry: { attempts: 3, timeoutMs: 100, backoffMs: 1_000, maxBackoffMs: 40 },
    }).build();
    expect(timeBudget(capped).worstCaseMs).toBe(300 + 80);
    for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      const chart = flowChart('A', noop, 'a', { retry: { attempts: 2, timeoutMs: 100, backoffMs: bad } }).build();
      expect(timeBudget(chart).worstCaseMs).toBe(200);
    }
  });

  it('{ attempts: 1, timeoutMs } is a timeout with no retry — no waits', () => {
    const chart = flowChart('A', noop, 'a', { retry: { attempts: 1, timeoutMs: 250, backoffMs: 1_000 } }).build();
    expect(timeBudget(chart).criticalPath).toEqual([
      { stageId: 'a', attempts: 1, timeoutMs: 250, backoffMs: 0, worstMs: 250, passes: 1 },
    ]);
  });

  it('no timeoutMs makes the stage unbounded (no-timeout); the waits it declares are still known', () => {
    const chart = flowChart('A', noop, 'a', { retry: { attempts: 3, backoffMs: 100 } })
      .addFunction('B', noop, 'b')
      .build();

    const report = timeBudget(chart);

    expect(report.worstCaseMs).toBeNull();
    expect(report.knownMs).toBe(200);
    expect(report.unbounded).toEqual([
      { stageId: 'a', why: 'no-timeout' },
      { stageId: 'b', why: 'no-timeout' },
    ]);
    expect(report.criticalPath).toEqual([
      { stageId: 'a', attempts: 3, backoffMs: 200, worstMs: null, passes: 1 },
      { stageId: 'b', attempts: 1, backoffMs: 0, worstMs: null, passes: 1 },
    ]);
  });
});

describe('timeBudget — shapes', () => {
  it('a sequence is the sum', () => {
    const chart = flowChart('A', noop, 'a', opt(10))
      .addFunction('B', noop, 'b')
      .retry(cap(20, 2, 5))
      .addFunction('C', noop, 'c')
      .retry(cap(30))
      .build();
    expect(timeBudget(chart).worstCaseMs).toBe(10 + 45 + 30);
  });

  it('a decider is its own stage plus its slowest branch', () => {
    const chart = flowChart('Seed', noop, 'seed', opt(10))
      .addDeciderFunction('Route', () => 'fast', 'route', undefined, opt(5))
      .addFunctionBranch('fast', 'Fast', noop, undefined, opt(100))
      .addFunctionBranch('slow', 'Slow', noop, undefined, opt(300, 2, 50))
      .end()
      .addFunction('Done', noop, 'done')
      .retry(cap(1))
      .build();

    const report = timeBudget(chart);

    expect(report.worstCaseMs).toBe(10 + 5 + 650 + 1);
    expect(report.criticalPath.map((s) => s.stageId)).toEqual(['seed', 'route', 'slow', 'done']);
  });

  it('a selector is its own stage plus its slowest branch (selected branches run at once)', () => {
    const chart = flowChart('Seed', noop, 'seed', opt(10))
      .addSelectorFunction('Pick', () => ['a', 'b'], 'pick', undefined, opt(5))
      .addFunctionBranch('a', 'A', noop, undefined, opt(100))
      .addFunctionBranch('b', 'B', noop, undefined, opt(200))
      .end()
      .build();
    expect(timeBudget(chart).worstCaseMs).toBe(215);
  });

  it('a fork is its slowest child — the children run at once', () => {
    const chart = flowChart('Seed', noop, 'seed', opt(10))
      .addListOfFunction([
        { id: 'a', name: 'A', fn: noop, retry: cap(100) },
        { id: 'b', name: 'B', fn: noop, retry: cap(100, 3, 10) },
      ])
      .addFunction('Join', noop, 'join')
      .retry(cap(1))
      .build();

    const report = timeBudget(chart);

    expect(report.worstCaseMs).toBe(10 + 320 + 1);
    expect(report.criticalPath.map((s) => s.stageId)).toEqual(['seed', 'b', 'join']);
  });

  it('a mounted subflow is walked like any chart, under the ids the run gives its stages', () => {
    const pay = flowChart('Charge', noop, 'charge', opt(1_000, 2, 100))
      .addFunction('Receipt', noop, 'receipt')
      .retry(cap(50))
      .build();
    const chart = flowChart('Seed', noop, 'seed', opt(10)).addSubFlowChartNext('pay', pay, 'Pay').build();

    const report = timeBudget(chart);

    expect(report.worstCaseMs).toBe(10 + 2_100 + 50);
    expect(report.criticalPath.map((s) => s.stageId)).toEqual(['seed', 'pay/charge', 'pay/receipt']);
  });

  it('a mount is a mount even when another stage holds its name — the engine never asks the stage map', () => {
    const inner = flowChart('Charge', noop, 'charge', opt(1_000)).build();
    const chart = flowChart('Seed', noop, 'seed', opt(1))
      .addFunction('T', noop, 'Pay')
      .retry(cap(2))
      .addSubFlowChartNext('pay', inner, 'Pay')
      .build();

    const report = timeBudget(chart);

    expect(report.worstCaseMs).toBe(1 + 2 + 1_000);
    expect(report.unbounded).toEqual([]);
  });

  it('a loop inside a mounted subflow is assumed by the id the run gives its target', () => {
    const inner = flowChart('Ask', noop, 'ask', opt(10)).loopTo('ask').build();
    const chart = flowChart('Seed', noop, 'seed', opt(1)).addSubFlowChartNext('pay', inner).build();

    expect(timeBudget(chart).unbounded).toEqual([{ stageId: 'pay/ask', why: 'loop' }]);
    expect(timeBudget(chart, { assume: { loops: { 'pay/ask': 4 } } }).worstCaseMs).toBe(1 + 40);
  });

  it('two subflows deep, and parallel mounts take the slowest', () => {
    const pay = flowChart('Charge', noop, 'charge', opt(1_000)).build();
    const ship = flowChart('Ship', noop, 'ship', opt(400)).build();
    const order = flowChart('Order', noop, 'order', opt(10)).addSubFlowChartNext('pay', pay).build();
    const chart = flowChart('Seed', noop, 'seed', opt(1))
      .addSubFlowChart('order', order)
      .addSubFlowChart('ship', ship)
      .addFunction('Join', noop, 'join')
      .retry(cap(2))
      .build();

    const report = timeBudget(chart);

    expect(report.worstCaseMs).toBe(1 + 1_010 + 2);
    expect(report.criticalPath.map((s) => s.stageId)).toEqual(['seed', 'order/order', 'order/pay/charge', 'join']);
  });

  it('a lazy subflow is unbounded unless assume.lazy names the chart it resolves to', () => {
    const pay = flowChart('Charge', noop, 'charge', opt(1_000, 2, 100)).build();
    const chart = flowChart('Seed', noop, 'seed', opt(10))
      .addLazySubFlowChartNext('pay', () => pay, 'Pay')
      .build();

    const unknown = timeBudget(chart);
    expect(unknown.worstCaseMs).toBeNull();
    expect(unknown.knownMs).toBe(10);
    expect(unknown.unbounded).toEqual([{ stageId: 'pay', why: 'lazy-subflow' }]);

    const assumed = timeBudget(chart, { assume: { lazy: { pay } } });
    expect(assumed.worstCaseMs).toBe(10 + 2_100);
    expect(assumed.unbounded).toEqual([]);
    expect(assumed.criticalPath.map((s) => s.stageId)).toEqual(['seed', 'pay/charge']);
  });

  it('parallelForEach is unbounded (items) unless assume.branches names the branch chart — then ONE branch counts', () => {
    const review = flowChart('Score', noop, 'score', opt(200, 3, 10)).build();
    const chart = flowChart('Split', noop, 'split', opt(10))
      .addParallelForEach('Review', 'review', {
        items: () => [1, 2, 3],
        branch: () => review,
        maxBranches: 8,
        into: 'reviews',
      })
      .build();

    const unknown = timeBudget(chart);
    expect(unknown.worstCaseMs).toBeNull();
    expect(unknown.unbounded).toEqual([{ stageId: 'review', why: 'items' }]);

    const assumed = timeBudget(chart, { assume: { branches: { review } } });
    expect(assumed.worstCaseMs).toBe(10 + 620);
    expect(assumed.criticalPath.map((s) => s.stageId)).toEqual(['split', 'review~0/score']);
  });
});

describe('timeBudget — loops are never iterated', () => {
  const linearLoop = () =>
    flowChart('Seed', noop, 'seed', opt(1))
      .addFunction('Ask', noop, 'ask')
      .retry(cap(100))
      .addFunction('Check', noop, 'check')
      .retry(cap(10))
      .loopTo('ask')
      .build();

  it('a loop with no assumption is unbounded, named by its target; knownMs counts one pass', () => {
    const report = timeBudget(linearLoop());
    expect(report.worstCaseMs).toBeNull();
    expect(report.knownMs).toBe(111);
    expect(report.unbounded).toEqual([{ stageId: 'ask', why: 'loop' }]);
  });

  it('assume.loops bounds the passes: every stage from the target to the loop runs that many times', () => {
    const report = timeBudget(linearLoop(), { assume: { loops: { ask: 3 } } });
    expect(report.worstCaseMs).toBe(1 + 3 * 110);
    expect(report.unbounded).toEqual([]);
    expect(report.criticalPath.map((s) => [s.stageId, s.passes])).toEqual([
      ['seed', 1],
      ['ask', 3],
      ['check', 3],
    ]);
  });

  it('a decider branch that loops: the target through the decider repeat, at the slowest branch', () => {
    const chart = flowChart('Seed', noop, 'seed', opt(1))
      .addFunction('Ask', noop, 'ask')
      .retry(cap(100))
      .addDeciderFunction('Route', () => 'done', 'route', undefined, opt(5))
      .addFunctionBranch('again', 'Again', noop, undefined, { loopTo: 'ask', retry: cap(20) })
      .addFunctionBranch('done', 'Done', noop, undefined, opt(7))
      .end()
      .addFunction('Finish', noop, 'finish')
      .retry(cap(3))
      .build();

    expect(timeBudget(chart).unbounded).toEqual([{ stageId: 'ask', why: 'loop' }]);

    const report = timeBudget(chart, { assume: { loops: { ask: 4 } } });
    expect(report.worstCaseMs).toBe(1 + 4 * (100 + 5 + 20) + 3);
    expect(report.criticalPath.map((s) => [s.stageId, s.passes])).toEqual([
      ['seed', 1],
      ['ask', 4],
      ['route', 4],
      ['again', 4],
      ['finish', 1],
    ]);
  });

  it('nested loops multiply', () => {
    const chart = flowChart('A', noop, 'a', opt(1))
      .addFunction('B', noop, 'b')
      .retry(cap(10))
      .addDeciderFunction('Inner', () => 'on', 'inner', undefined, opt(1))
      .addFunctionBranch('again-b', 'AgainB', noop, undefined, { loopTo: 'b', retry: cap(1) })
      .addFunctionBranch('on', 'On', noop, undefined, opt(1))
      .end()
      .addDeciderFunction('Outer', () => 'out', 'outer', undefined, opt(1))
      .addFunctionBranch('again-a', 'AgainA', noop, undefined, { loopTo: 'a', retry: cap(1) })
      .addFunctionBranch('out', 'Out', noop, undefined, opt(1))
      .end()
      .build();

    const report = timeBudget(chart, { assume: { loops: { a: 2, b: 3 } } });

    // a: 2 passes · b and inner: 2 × 3 · outer: 2
    expect(report.worstCaseMs).toBe(2 * 1 + 6 * 10 + 6 * 2 + 2 * 2);
    expect(report.criticalPath.find((s) => s.stageId === 'b')?.passes).toBe(6);
  });

  it('two loops that overlap without nesting are counted as one region (the product of their passes)', () => {
    const chart = flowChart('A', noop, 'a', opt(1))
      .addFunction('B', noop, 'b')
      .retry(cap(1))
      .addDeciderFunction('D1', () => 'on1', 'd1', undefined, opt(1))
      .addFunctionBranch('to-a', 'ToA', noop, undefined, { loopTo: 'a', retry: cap(1) })
      .addFunctionBranch('on1', 'On1', noop, undefined, opt(1))
      .end()
      .addDeciderFunction('D2', () => 'on2', 'd2', undefined, opt(1))
      .addFunctionBranch('to-b', 'ToB', noop, undefined, { loopTo: 'b', retry: cap(1) })
      .addFunctionBranch('on2', 'On2', noop, undefined, opt(1))
      .end()
      .build();

    // a = [a..d1] (2 passes) and b = [b..d2] (3 passes) overlap: each pass of one can re-enter the other, so the
    // whole region a..d2 is bounded by 2 × 3 — never by either loop's own count.
    const report = timeBudget(chart, { assume: { loops: { a: 2, b: 3 } } });
    expect(report.worstCaseMs).toBe(6 * (1 + 1 + 2 + 2));
  });

  it('a loop assumed to make 1 pass is the declared graph once', () => {
    const report = timeBudget(linearLoop(), { assume: { loops: { ask: 1 } } });
    expect(report.worstCaseMs).toBe(111);
  });
});

describe('timeBudget — the budget', () => {
  const quote = () =>
    flowChart('Read', noop, 'read')
      .addFunction('Charge', noop, 'charge')
      .retry({ attempts: 4, timeoutMs: 40_000, backoffMs: 1_000 })
      .build();

  it('over is the known part past the budget — even on a path a stage leaves unbounded', () => {
    const report = timeBudget(quote(), { budgetMs: 120_000 });
    expect(report.worstCaseMs).toBeNull();
    expect(report.knownMs).toBe(163_000);
    expect(report.budgetMs).toBe(120_000);
    expect(report.over).toBe(true);
    expect(report.unbounded).toEqual([{ stageId: 'read', why: 'no-timeout' }]);
  });

  it('a budget the chart can keep is not over; equal is kept', () => {
    expect(timeBudget(quote(), { budgetMs: 163_000 }).over).toBe(false);
    expect(timeBudget(quote()).over).toBe(false);
  });

  it("the chart's declared budget is the default; options.budgetMs wins", () => {
    const chart = flowChart('A', noop, 'a', opt(100)).budget(500).build();
    expect(timeBudget(chart).budgetMs).toBe(500);
    expect(timeBudget(chart, { budgetMs: 50 }).over).toBe(true);
  });
});

describe('the spec carries budgetMs and timeoutMs', () => {
  it('budgetMs on the root, timeoutMs beside retryAttempts — absent when not declared', () => {
    const builder = flowChart('A', noop, 'a').addFunction('B', noop, 'b').retry(cap(500, 2)).budget(1_000);
    const chart = builder.build();

    expect(chart.buildTimeStructure.budgetMs).toBe(1_000);
    expect(builder.toSpec<{ budgetMs?: number }>().budgetMs).toBe(1_000);
    expect(chart.buildTimeStructure.next?.timeoutMs).toBe(500);
    expect(chart.buildTimeStructure.next?.retryAttempts).toBe(2);
    expect(Object.keys(chart.buildTimeStructure)).not.toContain('timeoutMs');

    const plain = flowChart('A', noop, 'a').retry({ attempts: 2 }).build();
    expect(Object.keys(plain.buildTimeStructure)).not.toContain('budgetMs');
    expect(Object.keys(plain.buildTimeStructure)).not.toContain('timeoutMs');
  });
});

describe('.budget() refusals', () => {
  it('refuses a budget that is not a finite number of milliseconds > 0', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '120000' as unknown as number]) {
      expect(() => flowChart('A', noop, 'a').budget(bad)).toThrow(/budget\(ms\) must be a finite number/);
    }
  });

  it('refuses a budget past Number.MAX_SAFE_INTEGER — the worst case saturates there, so it could never be over', () => {
    expect(() => flowChart('A', noop, 'a').budget(Number.MAX_SAFE_INTEGER + 2)).toThrow(
      /at most Number.MAX_SAFE_INTEGER/,
    );
    expect(() => flowChart('A', noop, 'a').budget(Number.MAX_SAFE_INTEGER)).not.toThrow();
  });

  it('a retry policy refuses a maxBackoffMs that is not a finite number >= 0', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        flowChart('A', noop, 'a', { retry: { attempts: 2, backoffMs: () => 1, maxBackoffMs: bad } }),
      ).toThrow(/retry.maxBackoffMs must be a finite number/);
    }
    expect(() => flowChart('A', noop, 'a', { retry: { attempts: 2, maxBackoffMs: 0 } })).not.toThrow();
  });

  it('refuses a second budget and a budget after build()', () => {
    expect(() => flowChart('A', noop, 'a').budget(10).budget(20)).toThrow(/budget already declared/);
    const builder = flowChart('A', noop, 'a', opt(1));
    builder.build();
    expect(() => builder.budget(10)).toThrow(/after build\(\)/);
  });
});
