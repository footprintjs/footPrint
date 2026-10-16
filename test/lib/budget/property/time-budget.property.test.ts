/**
 * The static time budget — PROPERTY tests (design §3.2 and §10, packet P5).
 *
 *   1. An independent oracle: over random charts (stages, deciders, forks, mounted subflows; random policies, some
 *      with no `timeoutMs`), `timeBudget` agrees with a sum-of-max computed straight from the plan — and the
 *      critical path adds up to the number it reports (`knownMs = Σ passes × (attempts × timeoutMs + waits)`).
 *   2. The worst case is reached, never passed: on a virtual clock, a chain whose every attempt but the last runs to
 *      its cap, and whose last attempt answers 1 ms before it, takes exactly `worstCaseMs − stages` — so the
 *      computed worst case is both an upper bound and tight.
 */
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AttemptContext, FlowChartBuilder, RetryPolicy, TypedScope } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor, timeBudget } from '../../../../src/index.js';

const noop = () => undefined;

type Policy = { attempts: number; timeoutMs?: number; backoffMs: number } | undefined;
type Step =
  | { kind: 'stage'; policy: Policy }
  | { kind: 'decider'; own: Policy; branches: Policy[] }
  | { kind: 'fork'; children: Policy[] }
  | { kind: 'mount'; inner: Policy[] };

const policyArb: fc.Arbitrary<Policy> = fc.option(
  fc.record({
    attempts: fc.integer({ min: 1, max: 4 }),
    timeoutMs: fc.option(fc.integer({ min: 1, max: 1_000 }), { nil: undefined }),
    backoffMs: fc.integer({ min: 0, max: 100 }),
  }),
  { nil: undefined, freq: 4 },
);
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant('stage' as const), policy: policyArb }),
  fc.record({
    kind: fc.constant('decider' as const),
    own: policyArb,
    branches: fc.array(policyArb, { minLength: 1, maxLength: 3 }),
  }),
  fc.record({ kind: fc.constant('fork' as const), children: fc.array(policyArb, { minLength: 1, maxLength: 3 }) }),
  fc.record({ kind: fc.constant('mount' as const), inner: fc.array(policyArb, { minLength: 1, maxLength: 3 }) }),
);

const retryOf = (p: Policy): RetryPolicy | undefined =>
  p && { attempts: p.attempts, backoffMs: p.backoffMs, ...(p.timeoutMs !== undefined && { timeoutMs: p.timeoutMs }) };

/** The oracle's view of one stage: what it can be counted as, and whether it is bounded. */
const stageOf = (p: Policy) => ({
  known: p ? p.attempts * (p.timeoutMs ?? 0) + (p.attempts - 1) * p.backoffMs : 0,
  bounded: p?.timeoutMs !== undefined,
});
const sumOf = (ps: Policy[]) =>
  ps.map(stageOf).reduce((a, b) => ({ known: a.known + b.known, bounded: a.bounded && b.bounded }));
const maxOf = (xs: { known: number; bounded: boolean }[]) => ({
  known: Math.max(...xs.map((x) => x.known)),
  bounded: xs.every((x) => x.bounded),
});

function oracle(seed: Policy, steps: Step[]): { known: number; bounded: boolean } {
  const parts = [stageOf(seed)];
  for (const step of steps) {
    if (step.kind === 'stage') parts.push(stageOf(step.policy));
    if (step.kind === 'decider') parts.push(stageOf(step.own), maxOf(step.branches.map(stageOf)));
    if (step.kind === 'fork') parts.push(maxOf(step.children.map(stageOf)), stageOf(undefined)); // + the join
    if (step.kind === 'mount') parts.push(sumOf(step.inner));
  }
  return parts.reduce((a, b) => ({ known: a.known + b.known, bounded: a.bounded && b.bounded }));
}

function build(seed: Policy, steps: Step[]) {
  const opts = (p: Policy) => (p ? { retry: retryOf(p)! } : undefined);
  let b: FlowChartBuilder<any, any> = flowChart('Seed', noop, 'seed', opts(seed));
  steps.forEach((step, i) => {
    if (step.kind === 'stage') {
      b = b.addFunction(`S${i}`, noop, `s${i}`);
      if (step.policy) b = b.retry(retryOf(step.policy)!);
    }
    if (step.kind === 'decider') {
      let list = b.addDeciderFunction(`D${i}`, () => `b${i}_0`, `d${i}`, undefined, opts(step.own));
      step.branches.forEach((p, j) => {
        list = list.addFunctionBranch(`b${i}_${j}`, `B${i}_${j}`, noop, undefined, opts(p));
      });
      b = list.end();
    }
    if (step.kind === 'fork') {
      b = b.addListOfFunction(
        step.children.map((p, j) => ({ id: `f${i}_${j}`, name: `F${i}_${j}`, fn: noop, retry: retryOf(p) })),
      );
      b = b.addFunction(`J${i}`, noop, `j${i}`); // a join, so the next fork is a fork of its own
    }
    if (step.kind === 'mount') {
      let inner: FlowChartBuilder<any, any> = flowChart('X0', noop, 'x0', opts(step.inner[0]));
      step.inner.slice(1).forEach((p, k) => {
        inner = inner.addFunction(`X${k + 1}`, noop, `x${k + 1}`);
        if (p) inner = inner.retry(retryOf(p)!);
      });
      b = b.addSubFlowChartNext(`m${i}`, inner.build());
    }
  });
  return b.build();
}

describe('timeBudget agrees with an independent oracle', () => {
  it('worstCaseMs / knownMs equal the plan sum-of-max; the critical path adds up to knownMs', () => {
    fc.assert(
      fc.property(policyArb, fc.array(stepArb, { maxLength: 6 }), (seed, steps) => {
        const report = timeBudget(build(seed, steps));
        const expected = oracle(seed, steps);

        expect(report.knownMs).toBe(expected.known);
        expect(report.worstCaseMs).toBe(expected.bounded ? expected.known : null);
        expect(report.unbounded.length === 0).toBe(expected.bounded);

        const pathKnown = report.criticalPath.reduce(
          (sum, s) => sum + s.passes * (s.attempts * (s.timeoutMs ?? 0) + s.backoffMs),
          0,
        );
        expect(pathKnown).toBe(report.knownMs);
        if (report.worstCaseMs !== null) {
          expect(report.criticalPath.reduce((sum, s) => sum + s.passes * s.worstMs!, 0)).toBe(report.worstCaseMs);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('the worst case is reached, never passed', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** An attempt that never answers on its own: it ends when its signal does (at the cap). */
  const hang = (t: AttemptContext) =>
    new Promise<never>((_resolve, reject) => t.signal.addEventListener('abort', () => reject(t.signal.reason)));
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  it('on a virtual clock, every attempt but the last runs to its cap: elapsed = worstCaseMs − stages', async () => {
    vi.useFakeTimers();
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            attempts: fc.integer({ min: 1, max: 3 }),
            timeoutMs: fc.integer({ min: 2, max: 200 }),
            backoffMs: fc.integer({ min: 0, max: 50 }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        async (policies) => {
          const stage =
            (timeoutMs: number) =>
            (scope: TypedScope<Record<string, unknown>>): Promise<unknown> => {
              const t = scope.$attempt();
              return t.attempt < t.of ? hang(t) : sleep(timeoutMs - 1);
            };
          let b: FlowChartBuilder<any, any> = flowChart<Record<string, unknown>>(
            'S0',
            stage(policies[0].timeoutMs),
            's0',
            { retry: policies[0] },
          );
          policies.slice(1).forEach((p, i) => {
            b = b.addFunction(`S${i + 1}`, stage(p.timeoutMs), `s${i + 1}`).retry(p);
          });
          const chart = b.setLogger({ info: noop, log: noop, debug: noop, error: noop, warn: noop }).build();

          const started = Date.now();
          const done = new FlowChartExecutor(chart).run();
          await vi.runAllTimersAsync();
          await done;
          const elapsed = Date.now() - started;

          const { worstCaseMs } = timeBudget(chart);
          expect(elapsed).toBeLessThanOrEqual(worstCaseMs!);
          expect(elapsed).toBe(worstCaseMs! - policies.length);
        },
      ),
      { numRuns: 40 },
    );
  });
});
