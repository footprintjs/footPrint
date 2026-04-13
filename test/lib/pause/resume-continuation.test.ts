/**
 * Resume continuation — invoker context on PauseSignal.
 *
 * 5 patterns:
 * 1. Decider branch pause → post-decider stages run after resume
 * 2. Selector branch pause → post-selector stages run after resume
 * 3. Linear pause → works as before (no invoker, pausedNode.next is set)
 * 4. Checkpoint has invokerStageId + continuationStageId
 * 5. Nested: subflow + decider branch pause → continuation crosses both
 */

import { describe, expect, it } from 'vitest';

import { decide, flowChart, FlowChartExecutor, select } from '../../../src/index.js';
import type { PausableHandler } from '../../../src/lib/pause/types.js';

const alwaysPause: PausableHandler<any> = {
  execute: async () => ({ question: 'Approve?' }),
  resume: async (scope, input) => {
    scope.approved = (input as any).approved;
  },
};

describe('Resume continuation — invoker context', () => {
  it('pattern 1: decider branch pause → post-decider Done runs', async () => {
    const chart = flowChart<{ amount: number; approved?: boolean; result?: string }>(
      'Seed',
      async (scope) => {
        scope.amount = 1000;
      },
      'seed',
    )
      .addDeciderFunction(
        'Route',
        (scope) => {
          return decide(scope, [{ when: { amount: { gt: 500 } }, then: 'manual', label: 'High' }], 'auto');
        },
        'route',
      )
      .addPausableFunctionBranch('manual', 'Approval', alwaysPause)
      .addFunctionBranch('auto', 'Auto', async (scope) => {
        scope.approved = true;
      })
      .setDefault('auto')
      .end()
      .addFunction(
        'Done',
        async (scope) => {
          scope.result = scope.approved ? 'processed' : 'rejected';
        },
        'done',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(executor.isPaused()).toBe(true);

    await executor.resume(executor.getCheckpoint()!, { approved: true });

    const snap = executor.getSnapshot();
    expect(snap.sharedState?.approved).toBe(true);
    expect(snap.sharedState?.result).toBe('processed');
  });

  it('pattern 2: selector branch pause → post-selector Done runs', async () => {
    const chart = flowChart<{ flags: string[]; approved?: boolean; result?: string }>(
      'Seed',
      async (scope) => {
        scope.flags = ['needs-review'];
      },
      'seed',
    )
      .addSelectorFunction(
        'Triage',
        (scope) => {
          return select(scope, [
            { when: (s) => s.flags.includes('needs-review'), then: 'review', label: 'Needs review' },
          ]);
        },
        'triage',
      )
      .addPausableFunctionBranch('review', 'Review', alwaysPause)
      .end()
      .addFunction(
        'Done',
        async (scope) => {
          scope.result = scope.approved ? 'reviewed' : 'skipped';
        },
        'done',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(executor.isPaused()).toBe(true);

    await executor.resume(executor.getCheckpoint()!, { approved: true });

    const snap = executor.getSnapshot();
    expect(snap.sharedState?.approved).toBe(true);
    expect(snap.sharedState?.result).toBe('reviewed');
  });

  it('pattern 3: linear pause → still works (no invoker needed)', async () => {
    const chart = flowChart<{ approved?: boolean; result?: string }>('Seed', async () => {}, 'seed')
      .addPausableFunction('Approval', alwaysPause, 'approval')
      .addFunction(
        'Done',
        async (scope) => {
          scope.result = scope.approved ? 'done' : 'nope';
        },
        'done',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(executor.isPaused()).toBe(true);

    const checkpoint = executor.getCheckpoint()!;
    // Linear pause — no invoker (pausedNode.next is the continuation)
    expect(checkpoint.invokerStageId).toBeUndefined();

    await executor.resume(checkpoint, { approved: true });

    expect(executor.getSnapshot().sharedState?.result).toBe('done');
  });

  it('pattern 4: checkpoint carries invokerStageId + continuationStageId', async () => {
    const chart = flowChart<{ amount: number }>(
      'Seed',
      async (scope) => {
        scope.amount = 999;
      },
      'seed',
    )
      .addDeciderFunction(
        'Route',
        (scope) => {
          return decide(scope, [{ when: { amount: { gt: 0 } }, then: 'review', label: 'Any' }], 'review');
        },
        'route',
      )
      .addPausableFunctionBranch('review', 'Review', alwaysPause)
      .end()
      .addFunction('After', async () => {}, 'after')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const checkpoint = executor.getCheckpoint()!;
    expect(checkpoint.invokerStageId).toBe('route');
    expect(checkpoint.continuationStageId).toBe('after');
  });

  it('pattern 5: decider branch pause with no post-decider stages → clean termination', async () => {
    const chart = flowChart<{ amount: number; approved?: boolean }>(
      'Seed',
      async (scope) => {
        scope.amount = 100;
      },
      'seed',
    )
      .addDeciderFunction(
        'Route',
        (scope) => {
          return decide(scope, [{ when: { amount: { gt: 0 } }, then: 'review', label: 'Any' }], 'review');
        },
        'route',
      )
      .addPausableFunctionBranch('review', 'Review', alwaysPause)
      .end()
      // No Done stage — decider is the last thing
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(executor.isPaused()).toBe(true);

    const checkpoint = executor.getCheckpoint()!;
    // No continuation — decider has no .next
    expect(checkpoint.continuationStageId).toBeUndefined();

    await executor.resume(checkpoint, { approved: true });

    // Should complete cleanly, no crash
    expect(executor.isPaused()).toBe(false);
    expect(executor.getSnapshot().sharedState?.approved).toBe(true);
  });
});
