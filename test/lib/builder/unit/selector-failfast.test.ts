/**
 * selector `failFast` — parallel fan-out error semantics.
 *
 * When a selector picks ≥2 branches they fan out in parallel via
 * ChildrenExecutor:
 *   - DEFAULT (`Promise.allSettled`): best-effort — every branch runs to
 *     completion even if one throws; the run RESOLVES and the chart continues
 *     past the fan-out (the post-end() convergence stage still runs).
 *   - `failFast: true` (`Promise.all`): the first branch error REJECTS the run
 *     (aborts) — for "all selected branches are REQUIRED" fan-out.
 *
 * Exposed on BOTH `flowChartSelector` (root selector, via FlowChartOptions) and
 * `addSelectorFunction` (mid-chain selector, via its options arg). The engine
 * (ChildrenExecutor) honors `node.failFast`; SelectorHandler must propagate it
 * onto the temp fan-out node it builds. These tests pin that wiring end-to-end.
 *
 * Scope model (see flowChartSelector.test.ts): charts use a TypedScope proxy, so
 * stages write via property assignment. Branch writes are namespaced under
 * `runs.<branchId>` (the engine isolates each selected branch); the post-end()
 * convergence stage writes top-level.
 *
 * Test types (Convention 3): unit, functional.
 */

import { describe, expect, it } from 'vitest';

import { flowChart, flowChartSelector } from '../../../../src/lib/builder';
import { select } from '../../../../src/lib/decide';
import { FlowChartExecutor } from '../../../../src/lib/runner';

type FanoutState = {
  runs?: Record<string, { okRan?: boolean }>;
  converged?: boolean;
};

// A root selector that picks BOTH an ok branch and a throwing branch, then
// converges. `failFast` toggles the fan-out error mode.
function twoBranchRoot(failFast?: boolean) {
  return flowChartSelector(
    'Pick',
    (scope: any) =>
      select(scope, [
        { when: () => true, then: 'ok-branch', label: 'ok' },
        { when: () => true, then: 'bad-branch', label: 'bad' },
      ]),
    'pick',
    failFast !== undefined ? { failFast } : undefined,
  )
    .addFunctionBranch(
      'ok-branch',
      'Ok',
      (scope: any) => {
        scope.okRan = true;
      },
      'the ok branch',
    )
    .addFunctionBranch(
      'bad-branch',
      'Bad',
      () => {
        throw new Error('branch boom');
      },
      'the throwing branch',
    )
    .end()
    .addFunction(
      'Converge',
      (scope: any) => {
        scope.converged = true;
      },
      'converge',
      'after the fan-out',
    )
    .build();
}

describe('selector failFast — flowChartSelector (root)', () => {
  it('functional: DEFAULT (allSettled) — a branch error does NOT reject; the good branch runs and the chart converges', async () => {
    const exec = new FlowChartExecutor(twoBranchRoot());
    await exec.run({ input: {} }); // must not throw
    const state = exec.getSnapshot()?.sharedState as FanoutState;
    expect(state.runs?.['ok-branch']?.okRan).toBe(true); // good branch completed despite the bad one throwing
    expect(state.converged).toBe(true); // chart continued past the fan-out
  });

  it('functional: failFast:true (Promise.all) — a branch error REJECTS the run', async () => {
    const exec = new FlowChartExecutor(twoBranchRoot(true));
    await expect(exec.run({ input: {} })).rejects.toThrow('branch boom');
  });

  it('unit: failFast:false is explicit best-effort (resolves, same as omitted)', async () => {
    const exec = new FlowChartExecutor(twoBranchRoot(false));
    await exec.run({ input: {} }); // must not throw
    const state = exec.getSnapshot()?.sharedState as FanoutState;
    expect(state.runs?.['ok-branch']?.okRan).toBe(true);
    expect(state.converged).toBe(true);
  });
});

describe('selector failFast — addSelectorFunction (mid-chain)', () => {
  function midChain(failFast?: boolean) {
    return flowChart(
      'Seed',
      (scope: any) => {
        scope.seeded = true;
      },
      'seed',
    )
      .addSelectorFunction(
        'Pick',
        (scope: any) =>
          select(scope, [
            { when: () => true, then: 'ok2', label: 'ok' },
            { when: () => true, then: 'bad2', label: 'bad' },
          ]),
        'pick',
        undefined,
        failFast !== undefined ? { failFast } : undefined,
      )
      .addFunctionBranch(
        'ok2',
        'Ok',
        (scope: any) => {
          scope.okRan = true;
        },
        'ok',
      )
      .addFunctionBranch(
        'bad2',
        'Bad',
        () => {
          throw new Error('mid boom');
        },
        'bad',
      )
      .end()
      .addFunction(
        'Converge',
        (scope: any) => {
          scope.converged = true;
        },
        'converge',
        'after the fan-out',
      )
      .build();
  }

  it('functional: failFast:true — a branch error REJECTS the run', async () => {
    const exec = new FlowChartExecutor(midChain(true));
    await expect(exec.run({ input: {} })).rejects.toThrow('mid boom');
  });

  it('functional: DEFAULT — a branch error does NOT reject; the good branch runs and the chart converges', async () => {
    const exec = new FlowChartExecutor(midChain());
    await exec.run({ input: {} }); // must not throw
    const state = exec.getSnapshot()?.sharedState as FanoutState;
    expect(state.runs?.ok2?.okRan).toBe(true);
    expect(state.converged).toBe(true);
  });
});

// The agent's real shape: parallel SLOTS are SUBFLOW branches, not plain
// functions. A throwing slot (e.g. a Tools subflow whose provider rejects) must
// abort the run under failFast — this is the exact regression that swallowed
// errors when the default was Promise.allSettled. Guards the agent slot pattern.
describe('selector failFast — subflow branches (agent slot pattern)', () => {
  const okSlot = () =>
    flowChart(
      'OkSlot',
      (scope: any) => {
        scope.okSlotRan = true;
      },
      'ok-slot',
    ).build();
  const badSlot = () =>
    flowChart(
      'BadSlot',
      () => {
        throw new Error('slot boom');
      },
      'bad-slot',
    ).build();

  function slotFork(failFast?: boolean) {
    return flowChartSelector(
      'Pick',
      (scope: any) =>
        select(scope, [
          { when: () => true, then: 'sf-ok', label: 'ok slot' },
          { when: () => true, then: 'sf-bad', label: 'bad slot' },
        ]),
      'pick',
      failFast !== undefined ? { failFast } : undefined,
    )
      .addSubFlowChartBranch('sf-ok', okSlot(), 'OK Slot')
      .addSubFlowChartBranch('sf-bad', badSlot(), 'Bad Slot')
      .end()
      .addFunction(
        'messageAPI',
        (scope: any) => {
          scope.converged = true;
        },
        'message-api',
        'assemble after slots',
      )
      .build();
  }

  it('functional: failFast:true — a throwing SUBFLOW slot REJECTS the run', async () => {
    const exec = new FlowChartExecutor(slotFork(true));
    await expect(exec.run({ input: {} })).rejects.toThrow('slot boom');
  });

  it('functional: DEFAULT — a throwing SUBFLOW slot does NOT reject; the chart converges', async () => {
    const exec = new FlowChartExecutor(slotFork());
    await exec.run({ input: {} }); // must not throw
    const state = exec.getSnapshot()?.sharedState as FanoutState;
    expect(state.converged).toBe(true); // assembly stage still ran past the swallowed slot error
  });
});
