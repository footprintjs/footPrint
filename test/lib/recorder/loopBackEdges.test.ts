/**
 * LoopBackEdges on its own, with hand-made events: the body is what hangs under the pass's start, so an
 * execution that ran during the pass elsewhere (a parallel sibling of the whole loop, here `side#2`) is
 * not in it — a later step with that stage id is still answered as outside the loop.
 */
import { describe, expect, it, vi } from 'vitest';

import { LoopBackEdges } from '../../../src/lib/recorder/loopBackEdges.js';

function feed(steps: Array<[string, string | undefined] | ['loop', string]>) {
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

describe('LoopBackEdges', () => {
  const run = feed([
    ['seed#0', undefined],
    ['work#1', 'seed#0'],
    ['side#2', 'seed#0'], // a sibling of the loop, running during pass 1
    ['more#3', 'work#1'],
    ['again#4', 'more#3'],
    ['loop', 'again#4'],
    ['work#5', 'again#4'],
  ]);

  it('a step whose stage ran in a pass crosses the back-edge', () => {
    expect(run.exitTo('work#5', 'more#6')).toBeUndefined();
  });

  it('a step whose stage only ran beside the loop is outside it: the walk goes on from the loop’s entry', () => {
    expect(run.exitTo('work#5', 'side#9')).toBe('work#1');
    expect(run.exitTo('work#5', 'after#9')).toBe('work#1');
  });

  it('a step inside a mount that ran in a pass counts as inside', () => {
    const mounted = feed([
      ['seed#0', undefined],
      ['body#1', 'seed#0'],
      ['body/inner#2', 'body#1'],
      ['more#3', 'body#1'],
      ['again#4', 'more#3'],
      ['loop', 'again#4'],
      ['body#5', 'again#4'],
    ]);
    expect(mounted.exitTo('body#5', 'body/inner#6')).toBeUndefined();
  });

  it('only a re-entry is a back-edge', () => {
    expect(run.exitTo('more#3', 'after#9')).toBeUndefined();
  });
});

describe('LoopBackEdges — collecting a pass costs that pass, never the run so far (counted)', () => {
  /** Map and set reads made while feeding `passes` passes of `seed → work → [c1 ∥ c2] → more → again`. */
  function readsPerPass(passes: number): number {
    const steps: Array<[string, string | undefined] | ['loop', string]> = [['seed#0', undefined]];
    let n = 1;
    let parent = 'seed#0';
    for (let pass = 0; pass < passes; pass++) {
      const w = `work#${n++}`;
      steps.push([w, parent], [`c1#${n++}`, w], [`c2#${n++}`, w]);
      const m = `more#${n++}`;
      const a = `again#${n++}`;
      steps.push([m, w], [a, m], ['loop', a]);
      parent = a;
    }
    steps.push([`work#${n++}`, parent]);
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
    expect(large).toBeLessThanOrEqual(30);
  });
});
