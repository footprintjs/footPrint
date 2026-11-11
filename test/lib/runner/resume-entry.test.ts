/**
 * `resume()` entry — what a refused or a stale resume leaves behind.
 *
 * A resume refused before its traversal starts must leave the executor as it
 * was: still paused, its checkpoint still there (the order `run()` uses — arm
 * the signal first, then move the runId, the counters and the checkpoint).
 *
 * The live runtime is reused only for this executor's own latest pause; any
 * other checkpoint (an older pause, after a later run) starts from its own
 * `sharedState`, as a fresh executor would.
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

  describe('which runtime a same-executor resume continues', () => {
    const chart = flowChart<any>(
      'Seed',
      async (scope: any) => {
        scope.$setValue('person', scope.$getArgs()?.who ?? 'none');
      },
      'seed',
    )
      .addPausableFunction('Approve', approval, 'approve')
      .addFunction(
        'Done',
        async (scope: any) => {
          scope.$setValue('final', scope.$getValue('person'));
        },
        'done',
      )
      .build();

    it('its own latest pause continues the live runtime (the log keeps the pre-pause commits)', async () => {
      const executor = new FlowChartExecutor(chart);
      await executor.run({ input: { who: 'alice' } });
      const prePause = executor.getSnapshot().commitLog.map((bundle) => bundle.runtimeStageId);
      // A stored copy names the same paused execution.
      const stored = JSON.parse(JSON.stringify(executor.getCheckpoint()));

      await executor.resume(stored, true);

      const snapshot = executor.getSnapshot();
      expect(snapshot.sharedState.final).toBe('alice');
      expect(snapshot.commitLog.length).toBeGreaterThan(prePause.length);
      expect(snapshot.commitLog.slice(0, prePause.length).map((bundle) => bundle.runtimeStageId)).toEqual(prePause);
    });

    it("an older checkpoint after another run resumes the checkpoint's state, as a fresh executor does", async () => {
      const executor = new FlowChartExecutor(chart);
      await executor.run({ input: { who: 'alice' } });
      const older = executor.getCheckpoint()!;
      await executor.run({ input: { who: 'bob' } }); // pauses again: a newer checkpoint

      await executor.resume(older, true);

      const fresh = new FlowChartExecutor(chart);
      await fresh.resume(older, true);
      expect(executor.getSnapshot().sharedState.final).toBe('alice');
      expect(executor.getSnapshot().sharedState).toEqual(fresh.getSnapshot().sharedState);
    });
  });
});
