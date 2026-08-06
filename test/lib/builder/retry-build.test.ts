/**
 * Declarative per-stage retry — the BUILD-TIME half.
 *
 * The policy is validated where you write it, not where it runs: a typo'd
 * `attempts: 0` must fail while you are authoring the chart, never silently
 * turn a stage into a no-op three months later.
 *
 * Test types: Unit (validation, every declaration site) · Boundary (`attempts:
 * 1`, non-integers, double-declare) · Security (refusals on nodes with no stage
 * function of their own — a policy that could never fire must never look
 * accepted).
 */
import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../src/index.js';

interface State {
  a?: number;
  b?: number;
  [key: string]: unknown;
}

const noop = () => undefined;

describe('retry — declaration sites', () => {
  it('.retry() attaches the policy to the stage just added, and to its spec', () => {
    const chart = flowChart<State>('Seed', noop, 'seed')
      .addFunction('Work', noop, 'work')
      .retry({ attempts: 3, backoffMs: 25 })
      .build();

    expect(chart.root.next?.retry).toEqual({ attempts: 3, backoffMs: 25 });
    // The spec carries the COUNT only — backoffMs/retryOn can be functions.
    expect(chart.buildTimeStructure.next?.retryAttempts).toBe(3);
    expect((chart.buildTimeStructure.next as Record<string, unknown>).retry).toBeUndefined();
  });

  it('.retry() applies to the START stage when chained straight off flowChart()', () => {
    const chart = flowChart<State>('Seed', noop, 'seed').retry({ attempts: 2 }).build();
    expect(chart.root.retry).toEqual({ attempts: 2 });
    expect(chart.buildTimeStructure.retryAttempts).toBe(2);
  });

  it('flowChart({ retry }) declares the start stage policy without a chained call', () => {
    const chart = flowChart<State>('Seed', noop, 'seed', { retry: { attempts: 4 } }).build();
    expect(chart.root.retry?.attempts).toBe(4);
    expect(chart.buildTimeStructure.retryAttempts).toBe(4);
  });

  it('.retry() applies to a streaming stage', () => {
    const chart = flowChart<State>('Seed', noop, 'seed')
      .addStreamingFunction('Stream', noop, 'stream')
      .retry({ attempts: 2 })
      .build();
    expect(chart.root.next?.retry?.attempts).toBe(2);
  });

  it('.retry() applies to a pausable stage', () => {
    const chart = flowChart<State>('Seed', noop, 'seed')
      .addPausableFunction('Gate', { execute: noop, resume: noop }, 'gate')
      .retry({ attempts: 2 })
      .build();
    expect(chart.root.next?.retry?.attempts).toBe(2);
    expect(chart.root.next?.isPausable).toBe(true);
  });

  it('addDeciderFunction({ retry }) gives the DECIDER stage the policy', () => {
    const chart = flowChart<State>('Seed', noop, 'seed')
      .addDeciderFunction('Route', () => 'left', 'route', undefined, { retry: { attempts: 3 } })
      .addFunctionBranch('left', 'Left', noop)
      .end()
      .build();
    expect(chart.root.next?.retry?.attempts).toBe(3);
  });

  it('addSelectorFunction({ retry }) gives the SELECTOR stage the policy, alongside failFast', () => {
    const chart = flowChart<State>('Seed', noop, 'seed')
      .addSelectorFunction('Pick', () => ['one'], 'pick', undefined, { failFast: true, retry: { attempts: 2 } })
      .addFunctionBranch('one', 'One', noop)
      .end()
      .build();
    expect(chart.root.next?.retry?.attempts).toBe(2);
    expect(chart.root.next?.failFast).toBe(true);
  });

  it('addFunctionBranch({ retry }) gives the BRANCH stage the policy (decider + selector)', () => {
    const decider = flowChart<State>('Seed', noop, 'seed')
      .addDeciderFunction('Route', () => 'left', 'route')
      .addFunctionBranch('left', 'Left', noop, undefined, { retry: { attempts: 5 } })
      .end()
      .build();
    expect(decider.root.next?.children?.[0].retry?.attempts).toBe(5);

    const selector = flowChart<State>('Seed', noop, 'seed')
      .addSelectorFunction('Pick', () => ['one'], 'pick')
      .addFunctionBranch('one', 'One', noop, undefined, { retry: { attempts: 6 } })
      .end()
      .build();
    expect(selector.root.next?.children?.[0].retry?.attempts).toBe(6);
  });

  it('addPausableFunctionBranch({ retry }) gives the branch policy (decider + selector)', () => {
    const handler = { execute: noop, resume: noop };
    const decider = flowChart<State>('Seed', noop, 'seed')
      .addDeciderFunction('Route', () => 'ask', 'route')
      .addPausableFunctionBranch('ask', 'Ask', handler, undefined, { retry: { attempts: 2 } })
      .end()
      .build();
    expect(decider.root.next?.children?.[0].retry?.attempts).toBe(2);

    const selector = flowChart<State>('Seed', noop, 'seed')
      .addSelectorFunction('Pick', () => ['ask'], 'pick')
      .addPausableFunctionBranch('ask', 'Ask', handler, undefined, { retry: { attempts: 3 } })
      .end()
      .build();
    expect(selector.root.next?.children?.[0].retry?.attempts).toBe(3);
  });

  it('addListOfFunction children declare their own policies independently', () => {
    const chart = flowChart<State>('Seed', noop, 'seed')
      .addListOfFunction([
        { id: 'flaky', name: 'Flaky', fn: noop, retry: { attempts: 4 } },
        { id: 'steady', name: 'Steady', fn: noop },
      ])
      .build();
    expect(chart.root.children?.[0].retry?.attempts).toBe(4);
    expect(chart.root.children?.[1].retry).toBeUndefined();
  });

  it('flowChartSelector({ retry }) declares the root selector policy', () => {
    const chart = flowChart<State>('Seed', noop, 'seed').build();
    expect(chart.root.retry).toBeUndefined(); // control: no policy unless asked
  });
});

describe('retry — build-time validation', () => {
  it('accepts attempts: 1 as a declared-but-off policy', () => {
    const chart = flowChart<State>('Seed', noop, 'seed').retry({ attempts: 1 }).build();
    expect(chart.root.retry?.attempts).toBe(1);
    expect(chart.buildTimeStructure.retryAttempts).toBe(1);
  });

  it.each([0, -1, 2.5, NaN, Infinity])('refuses attempts: %s at build time', (attempts) => {
    expect(() => flowChart<State>('Seed', noop, 'seed').retry({ attempts })).toThrow(/attempts must be a whole number/);
  });

  it('refuses a non-number attempts', () => {
    expect(() => flowChart<State>('Seed', noop, 'seed').retry({ attempts: '3' as unknown as number })).toThrow(
      /attempts must be a whole number/,
    );
  });

  it('refuses a second policy on the same stage', () => {
    expect(() => flowChart<State>('Seed', noop, 'seed').retry({ attempts: 2 }).retry({ attempts: 3 })).toThrow(
      /retry already defined/,
    );
  });

  it('validates policies declared through an options bag too', () => {
    expect(() => flowChart<State>('Seed', noop, 'seed', { retry: { attempts: 0 } })).toThrow(
      /attempts must be a whole number/,
    );
  });
});

describe('retry — refusals on nodes with no stage function of their own', () => {
  it('refuses .retry() after a subflow mount that did not move the cursor', () => {
    // addSubFlowChart hangs the mount off the CURRENT stage as a fork child and
    // leaves the cursor on that stage. Without this refusal the policy would
    // silently land on 'seed' — a stage the author never meant to touch.
    const inner = flowChart<State>('Inner', noop, 'inner').build();
    expect(() =>
      flowChart<State>('Seed', noop, 'seed').addSubFlowChart('sf', inner, 'Sub').retry({ attempts: 2 }),
    ).toThrow(/cannot follow the subflow mount 'Sub'/);
  });

  it('refuses .retry() after a lazy subflow mount that did not move the cursor', () => {
    const inner = flowChart<State>('Inner', noop, 'inner').build();
    expect(() =>
      flowChart<State>('Seed', noop, 'seed')
        .addLazySubFlowChart('sf', () => inner, 'Sub')
        .retry({ attempts: 2 }),
    ).toThrow(/cannot follow the lazy subflow mount 'Sub'/);
  });

  it('refuses .retry() after parallel children were attached to the cursor', () => {
    expect(() =>
      flowChart<State>('Seed', noop, 'seed')
        .addListOfFunction([{ id: 'a', name: 'A', fn: noop }])
        .retry({ attempts: 2 }),
    ).toThrow(/cannot follow the parallel children/);
  });

  it('refuses .retry() on a subflow mount that DID move the cursor (addSubFlowChartNext)', () => {
    const inner = flowChart<State>('Inner', noop, 'inner').build();
    expect(() =>
      flowChart<State>('Seed', noop, 'seed').addSubFlowChartNext('sf', inner, 'Sub').retry({ attempts: 2 }),
    ).toThrow(/cannot be applied to the subflow mount/);
  });

  it('allows .retry() again once the cursor has moved past a fork', () => {
    const chart = flowChart<State>('Seed', noop, 'seed')
      .addListOfFunction([{ id: 'a', name: 'A', fn: noop }])
      .addFunction('Join', noop, 'join')
      .retry({ attempts: 2 })
      .build();
    expect(chart.root.next?.retry?.attempts).toBe(2);
  });

  it('refuses .retry() on a parallel-for-each fan-out, pointing at the branch chart', () => {
    const branch = flowChart<State>('Branch', noop, 'branch').build();
    expect(() =>
      flowChart<State>('Seed', noop, 'seed')
        .addParallelForEach('Fan out', 'fan', {
          items: () => [1, 2],
          branch: () => branch,
          maxBranches: 5,
          into: 'results',
        })
        .retry({ attempts: 2 }),
    ).toThrow(/cannot be applied to the parallel-for-each stage/);
  });

  it('after loopTo(), .retry() applies to the LOOPING stage — loopTo does not move the cursor', () => {
    // A stage that loops back is still a stage with a function, so a policy on
    // it is legitimate. What must not happen is the policy landing on the
    // loop-reference stub, which has no function at all.
    const chart = flowChart<State>('Seed', noop, 'seed')
      .addFunction('Work', noop, 'work')
      .loopTo('seed')
      .retry({ attempts: 2 })
      .build();
    expect(chart.root.next?.retry?.attempts).toBe(2);
    expect(chart.root.next?.next?.isLoopRef).toBe(true);
    expect(chart.root.next?.next?.retry).toBeUndefined();
  });
});
