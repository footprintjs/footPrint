/** Owned-run cleanup does not attest closure or change the native stage observation. */
import { expect, it } from 'vitest';

import type { NativeCaptureExtent } from '../../../src/index.js';
import { createRunLifecycle, flowChart } from '../../../src/index.js';

it.each(['completed', 'native-failed', 'body-failed-after-finish'] as const)(
  'keeps the native extent unverified when the owned run is %s',
  async (mode) => {
    const nativeError = new Error('synthetic native failure');
    const bodyError = new Error('synthetic body failure');
    const ignore = () => undefined;
    const chart = flowChart(
      'Work',
      () => {
        if (mode === 'native-failed') throw nativeError;
      },
      'work',
    )
      .setLogger({ info: ignore, log: ignore, debug: ignore, error: ignore, warn: ignore })
      .build();
    const owner = createRunLifecycle(chart, {
      runnerId: 'native-extent-finish',
      executorOptions: { captureCoverage: true, captureExtent: true },
    });
    const ends: string[] = [];
    let cut: NativeCaptureExtent | undefined;
    const nativeStatus = mode === 'native-failed' ? 'failed' : 'completed';
    const result = owner.withRun(async (run) => {
      run.onFinalize((end) => {
        ends.push(end.kind);
        expect(run.snapshot()?.capture?.boundary.status).toBe(nativeStatus);
        expect(run.snapshot()?.captureExtent).toEqual(cut);
      });
      let escaped: unknown;
      try {
        await run.execute({ kind: 'run' });
      } catch (error) {
        escaped = error;
      }
      expect(escaped).toBe(mode === 'native-failed' ? nativeError : undefined);
      cut = run.snapshot()?.captureExtent;
      expect(cut).toMatchObject({
        status: 'unverified',
        invocations: { started: 1, settled: 1, pending: 0, abandoned: 0 },
        limitations: expect.arrayContaining(['closure-not-attested', 'channels-not-fenced']),
      });
      await run.finish();
      await run.finish();
      expect(ends).toEqual([nativeStatus]);
      expect(run.snapshot()?.captureExtent).toEqual(cut);
      if (mode === 'body-failed-after-finish') throw bodyError;
      return 'answer';
    });
    if (mode === 'completed') await expect(result).resolves.toBe('answer');
    else await expect(result).rejects.toBe(mode === 'native-failed' ? nativeError : bodyError);

    expect(ends).toEqual([nativeStatus]);
    const snapshot = owner.view()?.snapshot();
    expect(snapshot?.capture?.boundary.status).toBe(nativeStatus);
    expect(snapshot?.captureExtent).toEqual(cut);
    expect(snapshot?.captureExtent?.status).toBe('unverified');
  },
);
