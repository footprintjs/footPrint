/**
 * LoopBackEdges on its own, with hand-made events: a re-entry remembers its loop's GATE (the step that chose the
 * looping branch) and the loop's entry; a walk that passed the gate leaves the loop, any other walk crosses.
 */
import { describe, expect, it, vi } from 'vitest';

import { LoopBackEdges } from '../../../src/lib/recorder/loopBackEdges.js';

type Step = [string, string | undefined] | ['loop', string];

function feed(steps: Step[]) {
  const loops = new LoopBackEdges();
  const parentOf = new Map<string, string>();
  for (const [id, parent] of steps) {
    if (id === 'loop') {
      loops.noteLoop(parent as string);
      continue;
    }
    if (parent !== undefined) parentOf.set(id, parent);
    loops.noteStage(id, parent, parentOf);
  }
  return loops;
}

/** `seed → work → more ─ again (loopTo work)`, `passes` times round, then the last `work`. */
function passesOf(passes: number): Step[] {
  const steps: Step[] = [['seed#0', undefined]];
  let n = 1;
  let parent = 'seed#0';
  for (let pass = 0; pass < passes; pass++) {
    const w = `work#${n++}`;
    const m = `more#${n++}`;
    const a = `again#${n++}`;
    steps.push([w, parent], [m, w], [a, m], ['loop', a]);
    parent = a;
  }
  steps.push([`work#${n++}`, parent]);
  return steps;
}

describe('LoopBackEdges', () => {
  const run = feed(passesOf(2)); // work#1 more#2 again#3 | work#4 more#5 again#6 | work#7

  it('a walk that passed the gate leaves the loop at its entry, whichever pass it is in', () => {
    expect(run.exitTo('work#7', new Set(['more']))).toBe('work#1');
    expect(run.exitTo('work#4', new Set(['more']))).toBe('work#1');
  });

  it('a walk that did not pass the gate crosses the back-edge', () => {
    expect(run.exitTo('work#7', new Set())).toBeUndefined();
    expect(run.exitTo('work#7', new Set(['work', 'side']))).toBeUndefined();
  });

  it('only a re-entry is a back-edge', () => {
    expect(run.exitTo('work#1', new Set(['more']))).toBeUndefined();
    expect(run.exitTo('more#5', new Set(['more']))).toBeUndefined();
  });

  it('a hop from another loop to the same target starts a new entry', () => {
    const two = feed([
      ['seed#0', undefined],
      ['work#1', 'seed#0'],
      ['d1#2', 'work#1'],
      ['a#3', 'd1#2'],
      ['loop', 'a#3'],
      ['work#4', 'a#3'],
      ['d2#5', 'work#4'],
      ['c#6', 'd2#5'],
      ['loop', 'c#6'],
      ['work#7', 'c#6'],
    ]);
    expect(two.exitTo('work#7', new Set(['d2']))).toBe('work#4');
    expect(two.exitTo('work#4', new Set(['d1']))).toBe('work#1');
    expect(two.exitTo('work#7', new Set(['d1']))).toBeUndefined();
  });
});

describe('LoopBackEdges — what a pass costs to note (counted, never timed)', () => {
  /** Map and set reads made while feeding `passes` passes. */
  function readsPerPass(passes: number): number {
    const steps = passesOf(passes);
    const get = vi.spyOn(Map.prototype, 'get');
    const has = vi.spyOn(Set.prototype, 'has');
    feed(steps);
    const reads = get.mock.calls.length + has.mock.calls.length;
    vi.restoreAllMocks();
    return reads / passes;
  }

  it('reads per pass stay the same at 10 and at 1,000 passes', () => {
    const small = readsPerPass(10);
    const large = readsPerPass(1000);
    expect(large).toBeLessThanOrEqual(small * 1.05);
    // Measured (vitest run): 5.2 reads per pass at 10 passes, 5.0 at 1,000.
    expect(large).toBeLessThanOrEqual(8);
  });
});
