/**
 * A failed stage is told by its `[Error]` line (plus any attempt lines); its
 * buffered reads and writes are not narrated. Once the error is told, the
 * stage's buffer is released — no live payload reference stays behind.
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { CombinedNarrativeRecorder } from '../../../../src/lib/engine/narrative/index.js';

function failingChart() {
  return flowChart<any>(
    'Seed',
    (s) => {
      s.a = 1;
    },
    'seed',
  )
    .addFunction(
      'Boom',
      (s) => {
        s.b = s.a;
        throw new Error('x');
      },
      'boom',
    )
    .build();
}

describe('failed stage buffer', () => {
  it('narrates the failure without the stage steps and releases the buffer', async () => {
    const narrative = new CombinedNarrativeRecorder();
    const executor = new FlowChartExecutor(failingChart());
    executor.attachCombinedRecorder(narrative);
    await expect(executor.run()).rejects.toThrow('x');

    expect(narrative.getEntries().map((e) => `${e.type} ${e.text}`)).toEqual([
      'stage Stage 1: The process began with Seed.',
      'step Step 1: Write a = 1',
      expect.stringMatching(/^error \[Error\]: /),
    ]);
    expect([...(narrative as any).pendingOps.keys()]).toEqual([]);
  });
});
