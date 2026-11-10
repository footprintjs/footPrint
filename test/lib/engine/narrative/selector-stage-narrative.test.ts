/**
 * A selector stage is narrated the way a decider stage is: its own stage
 * header, then its buffered reads and writes, then the `[Selected]` line.
 * Its buffer is released once told, so nothing stays in `pendingOps`.
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor, select } from '../../../../src/index.js';
import { CombinedNarrativeRecorder } from '../../../../src/lib/engine/narrative/index.js';

function selectorChart() {
  return flowChart<any>(
    'Seed',
    (s) => {
      s.flags = ['x'];
    },
    'seed',
  )
    .addSelectorFunction(
      'Triage',
      (s) => {
        s.triaged = true;
        return select(s, [{ when: (x: any) => x.flags.includes('x'), then: 'a', label: 'A' }]);
      },
      'triage',
    )
    .addFunctionBranch('a', 'A', (s) => {
      s.done = 1;
    })
    .end()
    .build();
}

async function narrate(chart: ReturnType<typeof selectorChart>) {
  const narrative = new CombinedNarrativeRecorder();
  const executor = new FlowChartExecutor(chart);
  executor.attachCombinedRecorder(narrative);
  await executor.run();
  return narrative;
}

describe('selector stage narrative', () => {
  it('tells the selector stage header, its steps, then the selection line', async () => {
    const narrative = await narrate(selectorChart());
    const lines = narrative.getEntries().map((e) => `${e.type} ${e.text}`);

    expect(lines.slice(0, 7)).toEqual([
      'stage Stage 1: The process began with Seed.',
      'step Step 1: Write flags = (1 item)',
      'stage Stage 2: Next, it moved on to Triage.',
      'step Step 1: Write triaged = true',
      'step Step 2: Read flags = (1 item)',
      expect.stringMatching(/^selector \[Selected\]: 1 of 1 paths selected: a/),
      expect.stringMatching(/^fork \[Parallel\]/),
    ]);
    expect(lines[7]).toBe('stage Stage 3: Next, it moved on to A.');
  });

  it('releases the selector stage buffer', async () => {
    const narrative = await narrate(selectorChart());
    expect([...(narrative as any).pendingOps.keys()]).toEqual([]);
  });
});
