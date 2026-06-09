/**
 * Re-entrancy guard — one executor, one in-flight execution.
 *
 * `run()`/`resume()` mutate per-run instance state (traverser, runId,
 * execution counter, checkpoint) and clear attached recorders; a second
 * concurrent entry would silently interleave runIds and cross-contaminate
 * recorder/narrative state. The guard converts that silent corruption into a
 * loud, documented error (docs/guides/execution-model.md) while leaving the
 * in-flight run completely untouched.
 */

import { describe, expect, it } from 'vitest';

import type { PausableHandler, TypedScope } from '../../../src';
import { flowChart, FlowChartExecutor } from '../../../src';

interface State {
  done?: boolean;
  answer?: string;
}

/** A deferred the test controls — the stage blocks until we release it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

function blockingChart(gate: Promise<void>) {
  return flowChart<State>(
    'Blocker',
    async (scope: TypedScope<State>) => {
      await gate;
      scope.done = true;
    },
    'blocker',
  ).build();
}

function pausableChart(gate?: Promise<void>) {
  const handler: PausableHandler<TypedScope<State>> = {
    execute: async () => ({ question: 'approve?' }),
    resume: async (scope, input) => {
      if (gate) await gate;
      scope.answer = String(input);
    },
  };
  return flowChart<State>('Approve', handler, 'approve').build();
}

const REENTRANCY = /in flight on this executor[\s\S]*execution-model/;

describe('FlowChartExecutor — re-entrancy guard', () => {
  it('run() during run() throws loudly and leaves the in-flight run untouched', async () => {
    const gate = deferred();
    const executor = new FlowChartExecutor(blockingChart(gate.promise));
    executor.enableNarrative();

    const first = executor.run();
    await expect(executor.run()).rejects.toThrow(REENTRANCY);

    gate.resolve();
    await first; // first run completes normally despite the rejected intruder
    expect(executor.getSnapshot().sharedState.done).toBe(true);
    // the intruder must NOT have wiped the in-flight run's narrative
    expect(executor.getNarrativeEntries().length).toBeGreaterThan(0);
  });

  it('resume() during run() throws the same class of error', async () => {
    const gate = deferred();
    const executor = new FlowChartExecutor(blockingChart(gate.promise));

    const first = executor.run();
    const fakeCheckpoint = {
      sharedState: {},
      executionTree: {},
      pausedStageId: 'approve',
      subflowPath: [],
      pausedAt: Date.now(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    await expect(executor.resume(fakeCheckpoint)).rejects.toThrow(REENTRANCY);

    gate.resolve();
    await first;
  });

  it('double-resume: a second resume() during an in-flight resume() throws', async () => {
    const executor = new FlowChartExecutor(pausableChart(undefined));
    await executor.run();
    expect(executor.isPaused()).toBe(true);
    const checkpoint = executor.getCheckpoint()!;

    const gate = deferred();
    const slowExecutor = new FlowChartExecutor(pausableChart(gate.promise));
    await slowExecutor.run();
    const slowCheckpoint = slowExecutor.getCheckpoint()!;

    const first = slowExecutor.resume(slowCheckpoint, 'yes');
    await expect(slowExecutor.resume(checkpoint, 'no')).rejects.toThrow(REENTRANCY);

    gate.resolve();
    await first;
    expect(slowExecutor.getSnapshot().sharedState.answer).toBe('yes');
  });

  it('sequential runs still work (the guard releases on completion)', async () => {
    const executor = new FlowChartExecutor(
      flowChart<State>(
        'Quick',
        async (scope: TypedScope<State>) => {
          scope.done = true;
        },
        'quick',
      ).build(),
    );
    await executor.run();
    await executor.run(); // no throw — flag released
  });

  it('the guard releases after a run that THROWS (executor is not bricked)', async () => {
    let shouldThrow = true;
    const executor = new FlowChartExecutor(
      flowChart<State>(
        'Flaky',
        async (scope: TypedScope<State>) => {
          if (shouldThrow) throw new Error('stage boom');
          scope.done = true;
        },
        'flaky',
      ).build(),
    );
    await expect(executor.run()).rejects.toThrow('stage boom');
    shouldThrow = false;
    await executor.run(); // works — guard released by the finally
    expect(executor.getSnapshot().sharedState.done).toBe(true);
  });

  it('the guard releases after a pause, so resume() on the same executor works', async () => {
    const executor = new FlowChartExecutor(pausableChart(undefined));
    await executor.run();
    expect(executor.isPaused()).toBe(true);
    await executor.resume(executor.getCheckpoint()!, 'approved'); // no re-entrancy throw
    expect(executor.getSnapshot().sharedState.answer).toBe('approved');
  });

  it('a rejected concurrent run() does not clear the in-flight run’s recorders', async () => {
    const cleared: string[] = [];
    const gate = deferred();
    const executor = new FlowChartExecutor(blockingChart(gate.promise));
    executor.attachFlowRecorder({
      id: 'probe',
      clear: () => {
        cleared.push('clear');
      },
    });

    const first = executor.run(); // clears once at start (expected)
    const clearsAfterStart = cleared.length;
    await expect(executor.run()).rejects.toThrow(REENTRANCY);
    expect(cleared.length).toBe(clearsAfterStart); // intruder cleared NOTHING

    gate.resolve();
    await first;
  });
});
