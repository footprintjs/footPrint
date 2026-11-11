/**
 * The combined narrative tells a linear stage's and a decider's reads and writes.
 * A selector stage's own are NOT told: the story has the selection line only.
 * That text is pinned here as it stands, and the buffer that held the untold
 * steps is released when the selector stage ends, on every way it can end.
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor, select } from '../../../../src/index.js';
import { CombinedNarrativeRecorder } from '../../../../src/lib/engine/narrative/index.js';

type Pick = 'one' | 'none' | 'break';

function selectorChart(pick: Pick) {
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
        if (pick === 'break') {
          s.$break();
          return [];
        }
        const wanted = pick === 'one' ? 'x' : 'absent';
        return select(s, [{ when: (x: any) => x.flags.includes(wanted), then: 'a', label: 'A' }]);
      },
      'triage',
    )
    .addFunctionBranch('a', 'A', (s) => {
      s.done = 1;
    })
    .end()
    .build();
}

async function narrate(pick: Pick) {
  const narrative = new CombinedNarrativeRecorder();
  const executor = new FlowChartExecutor(selectorChart(pick));
  executor.attachCombinedRecorder(narrative);
  await executor.run();
  return narrative;
}

const heldSteps = (narrative: CombinedNarrativeRecorder) => [...(narrative as any).pendingOps.keys()];

describe('selector stage in the combined narrative', () => {
  it('KNOWN GAP: tells the selection line, not the selector stage or its own reads and writes', async () => {
    const narrative = await narrate('one');
    const lines = narrative.getEntries().map((e) => `${e.type} ${e.text}`);

    expect(lines).toEqual([
      'stage Stage 1: The process began with Seed.',
      'step Step 1: Write flags = (1 item)',
      expect.stringMatching(/^selector \[Selected\]: 1 of 1 paths selected: a/),
      expect.stringMatching(/^fork \[Parallel\]/),
      'stage Stage 2: Next, it moved on to A.',
      'step Step 1: Write done = 1',
    ]);
    expect(lines.join('\n')).not.toContain('triaged');
  });

  it.each<Pick>(['one', 'none', 'break'])('releases the selector stage buffer (%s)', async (pick) => {
    const narrative = await narrate(pick);
    expect(heldSteps(narrative)).toEqual([]);
  });
});
