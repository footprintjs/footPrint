/**
 * A selector stage is narrated the way a decider stage is: its own stage
 * header, then its buffered reads and writes, then the `[Selected]` line.
 * A selector stopped by `$break` has no selection line; it is told all the
 * same. Its buffer is released once told, so nothing stays in `pendingOps`.
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor, select } from '../../../../src/index.js';
import { CombinedNarrativeRecorder } from '../../../../src/lib/engine/narrative/index.js';

type Pick = 'one' | 'none' | 'break';

function selectorChart(pick: Pick = 'one') {
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

  it('a stage that returns { children, nextNodeSelector } keeps its one linear header', async () => {
    const chart = flowChart<any>(
      'Seed',
      (s) => {
        s.x = 1;
      },
      'seed',
    )
      .addFunction(
        'Pick',
        (s) => {
          s.picked = true;
          return {
            name: 'Pick',
            children: [
              {
                name: 'A',
                id: 'a',
                fn: (sc: any) => {
                  sc.a = 1;
                },
              },
              { name: 'B', id: 'b', fn: () => {} },
            ],
            nextNodeSelector: () => ['a'],
          } as any;
        },
        'pick',
      )
      .build();
    const narrative = await narrate(chart);
    const stages = narrative.getEntries().filter((e) => e.type === 'stage');
    expect(stages.map((e) => e.text)).toEqual([
      'Stage 1: The process began with Seed.',
      'Stage 2: Next, it moved on to Pick.',
      'Stage 3: Next, it moved on to A.',
    ]);
  });

  it('tells a selector stopped by $break: header and steps, no selection line', async () => {
    const narrative = await narrate(selectorChart('break'));
    const lines = narrative.getEntries().map((e) => `${e.type} ${e.text}`);

    expect(lines.slice(0, 4)).toEqual([
      'stage Stage 1: The process began with Seed.',
      'step Step 1: Write flags = (1 item)',
      'stage Stage 2: Next, it moved on to Triage.',
      'step Step 1: Write triaged = true',
    ]);
    expect(lines.filter((line) => line.startsWith('stage '))).toHaveLength(2);
    expect(lines.some((line) => line.startsWith('selector '))).toBe(false);
  });

  it.each<Pick>(['one', 'none', 'break'])('releases the selector stage buffer (%s)', async (pick) => {
    const narrative = await narrate(selectorChart(pick));
    expect([...(narrative as any).pendingOps.keys()]).toEqual([]);
  });
});
