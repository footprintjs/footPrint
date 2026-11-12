/**
 * ControlDepRecorder — which steps are INSIDE a loop (`recorder/loopBackEdges.ts`).
 *
 * A step inside the loop keeps the decision that sent the run round again; a step after the loop does not. The
 * rule is the walk's own: a step whose walk passes the loop's gate (the step that chose the looping branch) before
 * the re-entry left the loop. Pinned here for the shapes a name-based body got wrong or never saw: parallel
 * children and their join (review of 7e8d4760), a fan-out and a mount in the body, a fan-out that grows in the last
 * pass, a step first reached by a dynamic next in the last pass, two loops to one target taken in alternating
 * passes, a mount as the loop's target, and a decider that loops to itself. Also pinned, counted and not timed: a
 * step after a 1,000-pass loop costs what it costs after a 10-pass loop.
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

  it('a step first reached through a dynamic next in the LAST pass is under the previous pass’s decision', async () => {
    // `work` hands back a dynamic next (`extra`, then the chart's `more`) only in the last pass. `extra` ran because
    // more#k-1 chose to go round again; its walk reaches the re-entry without passing `more`, so it crosses.
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
    expect(ctrl.lookup(extra)).toEqual({ deciderId: find('more')[1], label: 'Left to do' });
  });

  it('a fan-out with one branch in pass 1 and three in the last pass: every branch step is in the loop', async () => {
    const leaf = flowChart<Loose>('Leaf', noop, 'leaf').build();
    const chart = loopAround(2, (b) =>
      b.addParallelForEach('Each', 'each', {
        items: (s: S) => ((s.$getValue('left') as number) === 0 ? ['x', 'y', 'z'] : ['x']),
        branch: () => leaf,
        maxBranches: 3,
        into: 'r',
      } as never),
    );
    const { ctrl, ran, find } = await record(chart);
    const decisions = find('more');
    const each = find('each');
    const passOf = (id: string) => each.filter((e) => Number(e.split('#')[1]) < Number(id.split('#')[1])).length - 1;
    const last = ran.filter((id) => id.startsWith('each~') && passOf(id) === 2);
    expect(new Set(last.map((id) => id.split('/')[0].split('#')[0])).size).toBe(3);
    for (const id of last) expect(ctrl.lookup(id)?.deciderId, id).toBe(decisions[1]);
    expect(ctrl.lookup(find('after1')[0])).toBeUndefined();
  });

  it('two deciders loop to one target in alternating passes; each step is under the loop it is in', async () => {
    // work → d1 ─ a (loopTo work) | b, d1's next `y` → d2 ─ c (loopTo work) | leave, d2's next `x`.
    // Passes: d1 a | d1 b, y, d2 c | d1 a | d1 b, y, d2 leave, x.
    const d1 = ['a', 'b', 'a', 'b'];
    const d2 = ['c', 'leave'];
    const chart = flowChart<Loose>('Seed', noop, 'seed')
      .addFunction('Work', noop, 'work')
      .addDeciderFunction('D1', async () => d1.shift() as string, 'd1')
      .addFunctionBranch('a', 'A', noop, undefined, { loopTo: 'work' })
      .addFunctionBranch('b', 'B', noop)
      .end()
      .addFunction('Y', noop, 'y')
      .addDeciderFunction('D2', async () => d2.shift() as string, 'd2')
      .addFunctionBranch('c', 'C', noop, undefined, { loopTo: 'work' })
      .addFunctionBranch('leave', 'Leave', noop)
      .end()
      .addFunction('X', noop, 'x')
      .build();
    const { ctrl, find } = await record(chart);
    const [d1First, , d1Third] = find('d1');
    const [d2First, d2Last] = find('d2');
    const works = find('work');
    const ys = find('y');
    expect(works).toHaveLength(4);
    expect(ctrl.lookup(works[1])?.deciderId).toBe(d1First); // re-entered by d1's loop
    expect(ctrl.lookup(works[2])?.deciderId).toBe(d2First); // re-entered by d2's loop
    expect(ctrl.lookup(ys[0])).toBeUndefined(); // after d1's loop, before d2 ever looped
    expect(ctrl.lookup(ys[1])?.deciderId).toBe(d2First); // after d1's loop, in a pass d2 sent round
    expect(ctrl.lookup(d1Third)?.deciderId).toBe(d2First);
    expect(ctrl.lookup(d2Last)?.deciderId).toBe(d2First);
    expect(ctrl.lookup(find('x')[0])).toBeUndefined(); // after both loops
  });

  it('a loop left on its gate’s FIRST run, after another loop re-entered: the steps after are under nothing', async () => {
    const d1 = ['a', 'b'];
    const chart = flowChart<Loose>('Seed', noop, 'seed')
      .addFunction('Work', noop, 'work')
      .addDeciderFunction('D1', async () => d1.shift() as string, 'd1')
      .addFunctionBranch('a', 'A', noop, undefined, { loopTo: 'work' })
      .addFunctionBranch('b', 'B', noop)
      .end()
      .addFunction('Y', noop, 'y')
      .addDeciderFunction('D2', async () => 'leave', 'd2')
      .addFunctionBranch('c', 'C', noop, undefined, { loopTo: 'work' })
      .addFunctionBranch('leave', 'Leave', noop)
      .end()
      .addFunction('X', noop, 'x')
      .build();
    const { ctrl, find } = await record(chart);
    expect(ctrl.lookup(find('work')[1])?.deciderId).toBe(find('d1')[0]);
    expect(ctrl.lookup(find('y')[0])).toBeUndefined();
    expect(ctrl.lookup(find('d2')[0])).toBeUndefined();
    expect(ctrl.lookup(find('x')[0])).toBeUndefined();
  });

  it('the loop target is a mount: no inner step takes the hop source as its parent', async () => {
    const body = flowChart<Loose>('Inner', noop, 'inner').addFunction('Inner 2', noop, 'inner2').build();
    const parents = new Map<string, string | undefined>();
    const chart = flowChart<Loose>('Seed', seed(2) as never, 'seed')
      .addSubFlowChartNext('body', body, 'Body', { inputMapper: () => ({}), outputMapper: () => ({}) })
      .addDeciderFunction('More', more as never, 'more')
      .addFunctionBranch('again', 'Again', again as never, undefined, { loopTo: 'body' })
      .addFunctionBranch('leave', 'Leave', noop)
      .end()
      .addFunction('After 1', noop, 'after1')
      .build();
    const { ctrl, find } = await record(chart, (e) => parents.set(e.id, e.parent));
    const decisions = find('more');
    for (const id of [...find('body/inner'), ...find('body/inner2')]) {
      expect(parents.get(id)?.startsWith('again#'), id).toBe(false);
    }
    expect(find('body')).toHaveLength(3);
    for (const [i, id] of find('body/inner2').entries()) {
      if (i === 0) expect(ctrl.lookup(id)).toBeUndefined();
      else expect(ctrl.lookup(id)?.deciderId, id).toBe(decisions[i - 1]);
    }
    expect(ctrl.lookup(find('after1')[0])).toBeUndefined();
  });

  it('a decider that loops back to ITSELF: its own next is after the loop, its later runs are in it', async () => {
    const chart = flowChart<Loose>('Seed', seed(2) as never, 'seed')
      .addDeciderFunction('More', more as never, 'more')
      .addFunctionBranch('again', 'Again', again as never, undefined, { loopTo: 'more' })
      .addFunctionBranch('leave', 'Leave', noop)
      .end()
      .addFunction('After 1', noop, 'after1')
      .build();
    const { ctrl, find } = await record(chart);
    const decisions = find('more');
    expect(decisions).toHaveLength(3);
    expect(ctrl.lookup(decisions[1])?.deciderId).toBe(decisions[0]);
    expect(ctrl.lookup(decisions[2])?.deciderId).toBe(decisions[1]);
    expect(ctrl.lookup(find('after1')[0])).toBeUndefined();
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
    // Measured on this branch (gate rule, vitest run): 20 reads at 10 and at 999 passes; toSnapshot 9.4 per execution.
    expect(large.lookup).toBeLessThanOrEqual(25);
    // toSnapshot asks lookup once per execution: a fixed number of reads each, at any pass count.
    expect(large.snapshot / large.executions).toBeLessThanOrEqual(12);
    expect(large.snapshot / large.executions).toBeLessThanOrEqual((small.snapshot / small.executions) * 1.2);
  });
});
