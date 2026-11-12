/**
 * ControlDepRecorder — what counts as INSIDE a loop's body (`recorder/loopBackEdges.ts`).
 *
 * A step inside the body keeps the decision that sent the run round again; a step after the loop does
 * not. The body is every execution that ran in a pass and hangs under the pass's start, not only the
 * ancestors of the hop source: a parallel child is not an ancestor of the join, so a body read from the
 * hop source's chain left fork children, fan-out branches and their mounts outside, and from pass 2 on
 * they were answered "under nothing" (review of 7e8d4760). Also pinned: the bookkeeping is paid once per
 * pass, so a step after a 1,000-pass loop costs what it costs after a one-pass loop (counted, not timed),
 * and the one case the body cannot know yet (KNOWN LIMIT, named below).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flowChart } from '../../../src/index.js';
import { type Loose, type S, again, more, noop, record, seed, work } from './helpers/controlDepLoops.js';

/** `seed → work → <body> → more ─ again (loopTo work) | leave`, then `after1`. */
function loopAround(passes: number, body: (b: ReturnType<typeof start>) => ReturnType<typeof start>) {
  return body(start(passes))
    .addDeciderFunction('More', more as never, 'more')
    .addFunctionBranch('again', 'Again', again as never, undefined, { loopTo: 'work' })
    .addFunctionBranch('leave', 'Leave', noop)
    .end()
    .addFunction('After 1', noop, 'after1')
    .build();
}
function start(passes: number) {
  return flowChart<Loose>('Seed', seed(passes) as never, 'seed').addFunction('Work', work as never, 'work');
}

describe('ControlDepRecorder — the loop body', () => {
  it('parallel children and their join: passes 2 and 3 are under the previous pass’s decision', async () => {
    const chart = loopAround(2, (b) =>
      b
        .addListOfFunction([
          { id: 'c1', name: 'C1', fn: noop },
          { id: 'c2', name: 'C2', fn: noop },
        ])
        .addFunction('Join', noop, 'join'),
    );
    const { ctrl, find } = await record(chart);
    const decisions = find('more');
    expect(decisions).toHaveLength(3);
    for (const stage of ['c1', 'c2', 'join']) {
      const runs = find(stage);
      expect(ctrl.lookup(runs[0])).toBeUndefined();
      expect(ctrl.lookup(runs[1])).toEqual({ deciderId: decisions[0], label: 'Left to do' });
      expect(ctrl.lookup(runs[2])).toEqual({ deciderId: decisions[1], label: 'Left to do' });
    }
    expect(ctrl.lookup(find('after1')[0])).toBeUndefined();
  });

  it('a parallelForEach fan-out in the body: its branches’ steps are under the previous pass’s decision', async () => {
    const leaf = flowChart<Loose>('Leaf', noop, 'leaf').addFunction('Leaf 2', noop, 'leaf2').build();
    const chart = loopAround(2, (b) =>
      b.addParallelForEach('Each', 'each', { items: () => ['x', 'y'], branch: () => leaf, maxBranches: 2, into: 'r' }),
    );
    const { ctrl, ran, find } = await record(chart);
    const decisions = find('more');
    const branchSteps = ran.filter((id) => id.startsWith('each~'));
    expect(branchSteps.length).toBeGreaterThanOrEqual(12); // 2 branches × 2 steps × 3 passes
    const each = find('each');
    const passOf = (id: string) => each.filter((e) => Number(e.split('#')[1]) < Number(id.split('#')[1])).length - 1;
    for (const id of branchSteps) {
      const pass = passOf(id);
      if (pass === 0) expect(ctrl.lookup(id), id).toBeUndefined();
      else expect(ctrl.lookup(id)?.deciderId, id).toBe(decisions[pass - 1]);
    }
    expect(ctrl.lookup(find('after1')[0])).toBeUndefined();
  });

  it('a sub-flowchart mounted as a parallel child in the body: its inner steps likewise', async () => {
    const inner = flowChart<Loose>('Inner', noop, 'inner').addFunction('Inner 2', noop, 'inner2').build();
    const chart = loopAround(2, (b) =>
      b
        .addListOfFunction([{ id: 'c1', name: 'C1', fn: noop }])
        .addSubFlowChart('sub', inner, 'Sub', { inputMapper: () => ({}), outputMapper: () => ({}) })
        .addFunction('Join', noop, 'join'),
    );
    const { ctrl, find } = await record(chart);
    const decisions = find('more');
    for (const stage of ['sub/inner', 'sub/inner2', 'c1']) {
      const runs = find(stage);
      expect(runs).toHaveLength(3);
      expect(ctrl.lookup(runs[0])).toBeUndefined();
      expect(ctrl.lookup(runs[1])?.deciderId).toBe(decisions[0]);
      expect(ctrl.lookup(runs[2])?.deciderId).toBe(decisions[1]);
    }
    expect(ctrl.lookup(find('after1')[0])).toBeUndefined();
  });

  it('a decision branch taken for the first time in the LAST pass is answered by its own decision', async () => {
    const chart = loopAround(2, (b) =>
      b
        .addDeciderFunction('Pick', async (s: S) => ((s.$getValue('left') as number) === 0 ? 'late' : 'usual'), 'pick')
        .addFunctionBranch('usual', 'Usual', noop)
        .addFunctionBranch('late', 'Late', noop)
        .end(),
    );
    const { ctrl, find } = await record(chart);
    const picks = find('pick');
    const [late] = find('late');
    expect(ctrl.lookup(late)?.deciderId).toBe(picks[2]);
    expect(ctrl.lookup(picks[2])?.deciderId).toBe(find('more')[1]);
  });

  it('a parallel sibling of the whole loop is not pulled into the body', async () => {
    const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));
    const looped = flowChart<Loose>('Seed', seed(2) as never, 'seed')
      .addFunction(
        'Work',
        (async (s: S) => {
          await tick();
          await work(s);
        }) as never,
        'work',
      )
      .addDeciderFunction('More', more as never, 'more')
      .addFunctionBranch('again', 'Again', again as never, undefined, { loopTo: 'work' })
      .addFunctionBranch('leave', 'Leave', noop)
      .end()
      .addFunction('After 1', noop, 'after1')
      .build();
    const side = flowChart<Loose>('Side 1', (async () => tick()) as never, 'side1')
      .addFunction('Side 2', (async () => tick()) as never, 'side2')
      .addFunction('Side 3', (async () => tick()) as never, 'side3')
      .build();
    const chart = flowChart<Loose>('Start', noop, 'start')
      .addSubFlowChart('loop', looped, 'Loop', { inputMapper: () => ({}), outputMapper: () => ({}) })
      .addSubFlowChart('side', side, 'Side', { inputMapper: () => ({}), outputMapper: () => ({}) })
      .addFunction('Join', noop, 'join')
      .build();
    const { ctrl, ran, find } = await record(chart);
    expect(find('loop/more')).toHaveLength(3);
    for (const id of ran.filter((r) => r.startsWith('side/'))) expect(ctrl.lookup(id), id).toBeUndefined();
    expect(ctrl.lookup(find('loop/after1')[0])).toBeUndefined();
    expect(ctrl.lookup(find('loop/work')[2])?.deciderId).toBe(find('loop/more')[1]);
  });

  it('KNOWN LIMIT: a step reached only through a dynamic next for the first time in the last pass', async () => {
    // `work` hands back a dynamic next (`extra`, then the chart's `more`) only in the last pass. `extra`
    // ran because more#k-1 chose to go round again, but the body holds what ran in the EARLIER passes,
    // so it is taken for a step after the loop and answered by what governed the loop's entry: nothing.
    const chart = flowChart<Loose>('Seed', seed(2) as never, 'seed')
      .addFunction(
        'Work',
        (async (s: S) => {
          if (s.$getValue('left') !== 0) return undefined;
          return { name: 'cont', next: { name: 'Extra', id: 'extra', fn: noop, next: { name: 'More', id: 'more' } } };
        }) as never,
        'work',
      )
      .addDeciderFunction('More', more as never, 'more')
      .addFunctionBranch('again', 'Again', again as never, undefined, { loopTo: 'work' })
      .addFunctionBranch('leave', 'Leave', noop)
      .end()
      .build();
    const { ctrl, find } = await record(chart);
    const [extra] = find('extra');
    expect(extra).toBeDefined();
    expect(ctrl.lookup(extra)).toBeUndefined(); // the precise answer would be find('more')[1]
  });
});

describe('ControlDepRecorder — what a loop costs (counted map reads, never timed)', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Map reads made while `fn` runs — every walk step and set check of the recorder is one. */
  function mapReads(fn: () => void): number {
    const get = vi.spyOn(Map.prototype, 'get');
    const has = vi.spyOn(Map.prototype, 'has');
    const setHas = vi.spyOn(Set.prototype, 'has');
    fn();
    const n = get.mock.calls.length + has.mock.calls.length + setHas.mock.calls.length;
    vi.restoreAllMocks();
    return n;
  }

  it('a step after a 1,000-pass loop costs what it costs after a 10-pass loop; toSnapshot stays per execution', async () => {
    const parallelBody = (b: ReturnType<typeof start>) =>
      b.addListOfFunction([
        { id: 'c1', name: 'C1', fn: noop },
        { id: 'c2', name: 'C2', fn: noop },
      ]);
    const cost = async (passes: number) => {
      const { ctrl, ran, find } = await record(loopAround(passes, parallelBody));
      expect(find('more')).toHaveLength(passes + 1);
      const after = find('after1')[0];
      return {
        lookup: mapReads(() => expect(ctrl.lookup(after)).toBeUndefined()),
        snapshot: mapReads(() => ctrl.toSnapshot()),
        executions: ran.length,
      };
    };
    const small = await cost(10);
    const large = await cost(999);
    expect(large.lookup).toBe(small.lookup);
    // Measured on this branch: 21 reads at 10 and at 999 passes; toSnapshot about 10 reads per execution.
    expect(large.lookup).toBeLessThanOrEqual(25);
    // toSnapshot asks lookup once per execution: a fixed number of reads each, at any pass count.
    expect(large.snapshot / large.executions).toBeLessThanOrEqual(15);
    expect(large.snapshot / large.executions).toBeLessThanOrEqual((small.snapshot / small.executions) * 1.2);
  });
});
