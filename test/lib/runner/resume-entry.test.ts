/**
 * `resume()` entry — what a refused or a stale resume leaves behind.
 *
 * A resume refused before its traversal starts must leave the executor as it
 * was: still paused, its checkpoint still there (the order `run()` uses — arm
 * the signal first, then move the runId, the counters and the checkpoint).
 */

import { describe, expect, it } from 'vitest';

import type { PausableHandler } from '../../../src';
import { flowChart, FlowChartExecutor } from '../../../src';

const approval: PausableHandler<any> = {
  execute: async () => ({ question: 'ok?' }),
  resume: async () => {},
};

/** A signal whose subscription throws — `armRun` refuses it. */
function refusingSignal(): AbortSignal {
  return {
    aborted: false,
    addEventListener() {
      throw new Error('bad signal');
    },
    removeEventListener() {},
  } as unknown as AbortSignal;
}

describe('resume() entry', () => {
  it('a resume refused while arming keeps the executor paused with its checkpoint', async () => {
    const chart = flowChart<any>(
      'Seed',
      async (scope: any) => {
        scope.$setValue('x', 1);
      },
      'seed',
    )
      .addPausableFunction('Approve', approval, 'approve')
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const checkpoint = executor.getCheckpoint()!;
    expect(checkpoint).toBeDefined();

    await expect(executor.resume(checkpoint, true, { signal: refusingSignal(), timeoutMs: 1000 })).rejects.toThrow(
      'bad signal',
    );

    expect(executor.isPaused()).toBe(true);
    expect(executor.getCheckpoint()).toBe(checkpoint);
    // And the kept checkpoint still resumes.
    const result = await executor.resume(checkpoint, true);
    expect(result).not.toEqual(expect.objectContaining({ paused: true }));
    expect(executor.isPaused()).toBe(false);
  });
});
