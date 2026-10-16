/**
 * The declared budget on a real chart: `.budget(ms)` refuses at `build()`, names what it cannot bound, and warns
 * once at run start when the run gives the chart less time than it declared (design §3.2, owner ruling Q2).
 *
 * WHY: the incident behind this design — a stage retried an SDK call four times, 40 s each, past a caller's 120 s.
 * Both numbers were DECLARED: the policy on the stage and the budget of the caller. A declared budget the chart
 * cannot keep is a bug the author can fix before shipping, so `build()` refuses it — never a guess: an unbounded
 * stage is named, not counted.
 *
 * Test types: Scenario (the worked example refused at build; a branch over budget; a subflow's stages counted; an
 * unbounded path whose bounded part alone is over) · Functional (`chart.timeBudget()` delegates; the dev-mode
 * warning for unbounded stages; the run-start warning, once per chart, only in dev mode, only when the deadline is
 * shorter than the budget).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { disableDevMode, enableDevMode, flowChart, FlowChartExecutor, timeBudget } from '../../../../src/index.js';

const noop = () => undefined;

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  disableDevMode();
});

const warnings = () => warn.mock.calls.map((call: unknown[]) => String(call[0]));

describe('build() refuses a declared budget the chart cannot keep', () => {
  it('the worked example: 4 attempts × 40 s + 3 × 1 s against 120 s is refused, and the message says why', () => {
    const builder = flowChart('Read', noop, 'read')
      .addFunction('Charge', noop, 'charge')
      .retry({ attempts: 4, timeoutMs: 40_000, backoffMs: 1_000 })
      .budget(120_000);

    let message = '';
    try {
      builder.build();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^\[FlowChartBuilder\] budget\(120000\)/);
    expect(message).toContain('163000 ms');
    expect(message).toContain('over its budget by 43000 ms');
    expect(message).toContain('charge: 4 × 40000 ms + 3000 ms of waits = 163000 ms');
    // `read` has no timeoutMs: it is named as not counted, never guessed at.
    expect(message).toContain('read (no-timeout)');
  });

  it('a single branch over budget is enough — the slowest path decides', () => {
    const build = () =>
      flowChart('Seed', noop, 'seed', { retry: { attempts: 1, timeoutMs: 10 } })
        .addDeciderFunction('Route', () => 'fast', 'route')
        .addFunctionBranch('fast', 'Fast', noop, undefined, { retry: { attempts: 1, timeoutMs: 100 } })
        .addFunctionBranch('slow', 'Slow', noop, undefined, { retry: { attempts: 3, timeoutMs: 1_000 } })
        .end()
        .budget(2_000)
        .build();
    expect(build).toThrow(/slow: 3 × 1000 ms/);
  });

  it("a mounted subflow's stages count toward the parent's budget", () => {
    const pay = flowChart('Charge', noop, 'charge', { retry: { attempts: 2, timeoutMs: 600 } }).build();
    const build = () =>
      flowChart('Seed', noop, 'seed', { retry: { attempts: 1, timeoutMs: 10 } })
        .addSubFlowChartNext('pay', pay)
        .budget(1_000)
        .build();
    expect(build).toThrow(/pay\/charge: 2 × 600 ms/);
  });

  it('a chart within its budget builds, and the built chart reports it', () => {
    const chart = flowChart('Seed', noop, 'seed', { retry: { attempts: 2, timeoutMs: 400, backoffMs: 100 } })
      .budget(1_000)
      .build();
    expect(chart.timeBudget()).toMatchObject({ worstCaseMs: 900, budgetMs: 1_000, over: false, unbounded: [] });
    expect(chart.timeBudget({ budgetMs: 800 }).over).toBe(true);
    expect(chart.timeBudget()).toEqual(timeBudget(chart));
  });

  it('no declared budget, no check: an over-long policy builds as before', () => {
    expect(() =>
      flowChart('A', noop, 'a', { retry: { attempts: 1_000, timeoutMs: 60_000 } })
        .addFunction('B', noop, 'b')
        .build(),
    ).not.toThrow();
  });
});

describe('build() warns about what it cannot bound', () => {
  it('in dev mode, each unbounded stage is named once — and the chart still builds', () => {
    enableDevMode();
    const chart = flowChart('Read', noop, 'read')
      .addFunction('Ask', noop, 'ask')
      .retry({ attempts: 1, timeoutMs: 100 })
      .addFunction('Check', noop, 'check')
      .retry({ attempts: 1, timeoutMs: 100 })
      .loopTo('ask')
      .budget(10_000)
      .build();

    expect(chart.root.id).toBe('read');
    const budgetWarnings = warnings().filter((w) => w.includes('budget'));
    expect(budgetWarnings).toHaveLength(1);
    expect(budgetWarnings[0]).toContain("'Read'");
    expect(budgetWarnings[0]).toContain('read (no-timeout)');
    expect(budgetWarnings[0]).toContain('ask (loop)');
  });

  it('outside dev mode it is silent', () => {
    flowChart('Read', noop, 'read').budget(10_000).build();
    expect(warnings()).toEqual([]);
  });

  it('a chart every path of which is bounded does not warn', () => {
    enableDevMode();
    flowChart('Read', noop, 'read', { retry: { attempts: 1, timeoutMs: 100 } })
      .budget(10_000)
      .build();
    expect(warnings()).toEqual([]);
  });
});

describe('the run-start warning', () => {
  const declared = () =>
    flowChart('Quote', noop, 'quote', { retry: { attempts: 1, timeoutMs: 100 } })
      .budget(5_000)
      .build();

  it('dev mode, a deadline shorter than the declared budget: warned once per chart', async () => {
    enableDevMode();
    const chart = declared();
    await new FlowChartExecutor(chart).run({ timeoutMs: 1_000 });
    await new FlowChartExecutor(chart).run({ timeoutMs: 1_000 });

    const runWarnings = warnings().filter((w) => w.includes('deadline'));
    expect(runWarnings).toHaveLength(1);
    expect(runWarnings[0]).toMatch(/less than the chart's declared budget of 5000 ms/);
  });

  it('the absolute deadline form is read the same way', async () => {
    enableDevMode();
    await new FlowChartExecutor(declared()).run({ deadline: Date.now() + 2_000 });
    expect(warnings().filter((w) => w.includes('deadline'))).toHaveLength(1);
  });

  it('no warning when the run gives the chart its budget, has no deadline, or dev mode is off', async () => {
    enableDevMode();
    await new FlowChartExecutor(declared()).run({ timeoutMs: 5_000 });
    await new FlowChartExecutor(declared()).run();
    disableDevMode();
    await new FlowChartExecutor(declared()).run({ timeoutMs: 1_000 });
    expect(warnings().filter((w) => w.includes('deadline'))).toEqual([]);
  });

  it('a chart with no declared budget never warns at run start', async () => {
    enableDevMode();
    const chart = flowChart('A', noop, 'a').build();
    await new FlowChartExecutor(chart).run({ timeoutMs: 1_000 });
    expect(warnings().filter((w) => w.includes('budget'))).toEqual([]);
  });
});
