/**
 * SCENARIO — a fork right after a subflow mount, then a mount that pauses.
 *
 *   init → ⟨sf-out⟩ → [fa, fb] → ⟨sf-p: ask (interrupt)⟩ → end
 *
 * Through 9.37.0 `addListOfFunction` hung the fork ON the `sf-out` mount
 * node. The engine reads a mount that carries children as the mounted chart's
 * own content, so `sf-out`'s real chart never ran, the fork and `sf-p` ran
 * INSIDE `sf-out`, `sf-p` ran again after it, and a pause in `sf-p` was
 * checkpointed under `['sf-out', 'sf-p']` — a path the chart does not have,
 * so resume refused it. Since the fix the fork continues AFTER the mount
 * (`FlowChartBuilder · _needForkParent`, a fork node `sf-out-fork`).
 *
 * Pinned: the paused-and-resumed run equals the never-paused run (same trace,
 * same final state), on the same executor and on a fresh one through a JSON
 * round trip; the never-paused run itself runs every stage once, in order.
 *
 * Test type: scenario + unit (the chart shape).
 */

import { describe, expect, it } from 'vitest';

import { ArrayMergeMode } from '../../../src/advanced.js';
import type { FlowChart, SubflowMountOptions } from '../../../src/index.js';
import { flowChart, FlowChartExecutor, interrupt } from '../../../src/index.js';
import { type ResumeMode, type S, drive } from './resume-real-chart-fixture.js';

type Mode = 'direct' | 'pause';

const ANSWER = 'yes';

/** Thread `trace` into a subflow and back out. */
const traceThrough: SubflowMountOptions = {
  inputMapper: (p: Record<string, unknown>) => ({ prior: p.trace }),
  outputMapper: (sf: Record<string, unknown>) => ({ trace: sf.trace }),
  arrayMerge: ArrayMergeMode.Replace,
};

const mark = (name: string) => (s: S) => {
  s.trace = [...((s.trace as string[] | undefined) ?? (s.prior as string[])), name];
};

function chart(mode: Mode): FlowChart {
  const out = flowChart('M0', mark('m0'), 'm0').build();
  const ask = flowChart(
    'Ask',
    (s: S) => {
      const answer = mode === 'direct' ? ANSWER : interrupt<string>(s, { q: 'go?' });
      s.trace = [...(s.prior as string[]), `ask=${answer}`];
    },
    'ask',
  ).build();
  return flowChart(
    'Init',
    (s: S) => {
      s.trace = ['init'];
    },
    'init',
  )
    .addSubFlowChartNext('sf-out', out, 'Out', traceThrough)
    .addListOfFunction([
      {
        id: 'fa',
        name: 'FA',
        fn: (s: S) => {
          s.fa = 1;
        },
      },
      {
        id: 'fb',
        name: 'FB',
        fn: (s: S) => {
          s.fb = 1;
        },
      },
    ])
    .addSubFlowChartNext('sf-p', ask, 'P', traceThrough)
    .addFunction('End', mark('end'), 'end')
    .build();
}

async function directRun() {
  const executor = new FlowChartExecutor(chart('direct'));
  await executor.run();
  return executor.getSnapshot();
}

describe('a fork right after a subflow mount', () => {
  it('the never-paused run runs every stage once, in order (sf-out runs its OWN chart)', async () => {
    const snapshot = await directRun();
    const state = snapshot.sharedState as Record<string, unknown>;
    expect(state.trace).toEqual(['init', 'm0', `ask=${ANSWER}`, 'end']);
    const stages = snapshot.commitLog.map((b) => b.stageId);
    // One EXECUTION of sf-p (a mount with an outputMapper commits its
    // merge-back under the same runtimeStageId — one execution, two bundles).
    const sfp = snapshot.commitLog.filter((b) => b.stageId === 'sf-p').map((b) => b.runtimeStageId);
    expect(new Set(sfp).size).toBe(1);
    expect(stages.indexOf('sf-out')).toBeLessThan(stages.indexOf('fa'));
    expect(stages.indexOf('fb')).toBeLessThan(stages.indexOf('sf-p'));
  });

  it.each<ResumeMode>(['same', 'cross'])(
    '%s-executor resume equals the never-paused run (trace and final state)',
    async (mode) => {
      const direct = (await directRun()).sharedState as Record<string, unknown>;
      const paused = await drive(chart('pause'), mode, { answer: () => ANSWER });

      expect(paused.pauses).toBe(1);
      expect(paused.checkpoints[0].subflowPath).toEqual(['sf-p']);
      expect(paused.trace).toEqual(direct.trace);
      expect(paused.state).toEqual(direct);
    },
  );

  it('the chart: the fork continues AFTER the mount, on its own node', () => {
    const spec = flowChart('Init', () => undefined, 'init')
      .addSubFlowChartNext('sf-out', flowChart('M0', () => undefined, 'm0').build(), 'Out')
      .addListOfFunction([{ id: 'fa', name: 'FA', fn: () => undefined }])
      .addListOfFunction([{ id: 'fb', name: 'FB', fn: () => undefined }])
      .addFunction('End', () => undefined, 'end')
      .toSpec() as any;
    const mount = spec.next;
    expect(mount).toMatchObject({ id: 'sf-out', type: 'stage', isSubflowRoot: true });
    expect(mount.children).toBeUndefined();
    expect(mount.next).toMatchObject({ id: 'sf-out-fork', type: 'fork' });
    expect(mount.next.children.map((c: { id: string }) => c.id)).toEqual(['fa', 'fb']);
    expect(mount.next.next.id).toBe('end');
  });

  it('refuses when the fork node id is already a stage id', () => {
    expect(() =>
      flowChart('Init', () => undefined, 'sf-out-fork')
        .addSubFlowChartNext('sf-out', flowChart('M0', () => undefined, 'm0').build(), 'Out')
        .addListOfFunction([{ id: 'fa', name: 'FA', fn: () => undefined }]),
    ).toThrow(/fork node it needs, 'sf-out-fork', is already a stage id/);
  });
});

// ── The same root bug after a decider, a selector, a parallelForEach ────────
//
// Their `children` already mean something else (branches; run-time items), so
// through 9.37.0 a fork hung on them was silently dropped: after a decider it
// became a branch nobody picks, after a parallelForEach it never ran. The fork
// now continues AFTER them, on `<id>-fork`, as after a mount.

type Owner = 'decider' | 'selector' | 'parallelForEach';
const OWNERS: Owner[] = ['decider', 'selector', 'parallelForEach'];

function ownerChart(owner: Owner, mode: Mode): FlowChart {
  const ask = flowChart(
    'Ask',
    (s: S) => {
      const answer = mode === 'direct' ? ANSWER : interrupt<string>(s, { q: 'go?' });
      s.trace = [...(s.prior as string[]), `ask=${answer}`];
    },
    'ask',
  ).build();
  let b: any = flowChart(
    'Init',
    (s: S) => {
      s.trace = ['init'];
    },
    'init',
  );
  if (owner === 'decider') {
    b = b
      .addDeciderFunction('D', () => 'a', 'd')
      .addFunctionBranch('a', 'A', mark('a'))
      .addFunctionBranch('b', 'B', mark('b'))
      .end();
  } else if (owner === 'selector') {
    b = b
      .addSelectorFunction('Sel', () => ['a'], 'sel')
      .addFunctionBranch('a', 'A', mark('a'))
      .addFunctionBranch('b', 'B', mark('b'))
      .end();
  } else {
    const leaf = flowChart('Leaf', () => undefined, 'leaf').build();
    b = b.addParallelForEach('Each', 'each', { items: () => ['x'], branch: () => leaf, maxBranches: 2, into: 'r' });
  }
  return b
    .addListOfFunction([
      {
        id: 'fa',
        name: 'FA',
        fn: (s: S) => {
          s.fa = 1;
        },
      },
    ])
    .addSubFlowChartNext('sf-p', ask, 'P', traceThrough)
    .addFunction('End', mark('end'), 'end')
    .build();
}

const forkOf: Record<Owner, string> = { decider: 'd-fork', selector: 'sel-fork', parallelForEach: 'each-fork' };

describe.each(OWNERS)('a fork right after a %s', (owner) => {
  it('runs AFTER it, once, and the chart continues past it', async () => {
    const executor = new FlowChartExecutor(ownerChart(owner, 'direct'));
    await executor.run();
    const snapshot = executor.getSnapshot();
    const stages = snapshot.commitLog.map((b) => b.stageId);
    expect(stages.filter((id) => id === 'fa')).not.toHaveLength(0);
    expect(new Set(snapshot.commitLog.filter((b) => b.stageId === 'fa').map((b) => b.runtimeStageId)).size).toBe(1);
    expect(stages.indexOf('fa')).toBeLessThan(stages.indexOf('sf-p'));
    const trace = (snapshot.sharedState as Record<string, unknown>).trace;
    // A decider branch writes the parent's state; a selector branch runs as a
    // parallel child (its own namespace); a parallelForEach branch is a subflow.
    const own = owner === 'decider' ? ['a'] : [];
    expect(trace).toEqual(['init', ...own, `ask=${ANSWER}`, 'end']);
    if (owner !== 'parallelForEach') expect(stages.indexOf('a')).toBeLessThan(stages.indexOf('fa'));
  });

  it.each<ResumeMode>(['same', 'cross'])('%s-executor resume equals the never-paused run', async (mode) => {
    const executor = new FlowChartExecutor(ownerChart(owner, 'direct'));
    await executor.run();
    const direct = executor.getSnapshot().sharedState as Record<string, unknown>;
    const paused = await drive(ownerChart(owner, 'pause'), mode, { answer: () => ANSWER });
    expect(paused.pauses).toBe(1);
    expect(paused.checkpoints[0].subflowPath).toEqual(['sf-p']);
    expect(paused.trace).toEqual(direct.trace);
    expect(paused.state).toEqual(direct);
  });

  it('the chart: the node keeps its own children; the fork is its next', () => {
    const spec = (ownerChart(owner, 'direct') as any).buildTimeStructure;
    const node = spec.next;
    expect(node.children?.some((c: { id: string }) => c.id === 'fa') ?? false).toBe(false);
    expect(node.next).toMatchObject({ id: forkOf[owner], type: 'fork' });
    expect(node.next.children.map((c: { id: string }) => c.id)).toEqual(['fa']);
  });
});

describe('the fork node id is reserved both ways', () => {
  const mounted = () =>
    flowChart('Init', () => undefined, 'init')
      .addSubFlowChartNext('m', flowChart('M0', () => undefined, 'm0').build(), 'M')
      .addListOfFunction([{ id: 'fa', name: 'FA', fn: () => undefined }]);

  it('a stage added later may not take it', () => {
    expect(() => mounted().addFunction('X', () => undefined, 'm-fork')).toThrow(/id 'm-fork' is taken/);
  });

  it('a mount added later may not take it', () => {
    expect(() => mounted().addSubFlowChartNext('m-fork', flowChart('L', () => undefined, 'l').build(), 'L')).toThrow(
      /id 'm-fork' is taken/,
    );
  });

  it('a fan-out may not generate it when a stage already has it', () => {
    expect(() =>
      flowChart('Init', () => undefined, 'm-fork')
        .addSubFlowChartNext('m', flowChart('M0', () => undefined, 'm0').build(), 'M')
        .addListOfFunction([{ id: 'fa', name: 'FA', fn: () => undefined }]),
    ).toThrow(/fork node it needs, 'm-fork', is already a stage id/);
  });
});

describe('the fork node id may not be taken EARLIER either', () => {
  const mountThenFork = (b: any) =>
    b
      .addSubFlowChartNext('m', flowChart('M0', () => undefined, 'm0').build(), 'M')
      .addListOfFunction([{ id: 'fa', name: 'FA', fn: () => undefined }]);

  it('by an earlier fork child', () => {
    const b = flowChart('Init', () => undefined, 'init').addListOfFunction([
      { id: 'm-fork', name: 'X', fn: () => undefined },
    ]);
    expect(() => mountThenFork(b.addFunction('Join', () => undefined, 'join'))).toThrow(
      /'m-fork', is already a stage id/,
    );
  });

  it('by an earlier decider branch', () => {
    const b = flowChart('Init', () => undefined, 'init')
      .addDeciderFunction('D', () => 'm-fork', 'd')
      .addFunctionBranch('m-fork', 'X', () => undefined)
      .addFunctionBranch('other', 'Y', () => undefined)
      .end()
      .addFunction('Join', () => undefined, 'join');
    expect(() => mountThenFork(b)).toThrow(/'m-fork', is already a stage id/);
  });

  it('nor LATER by a lazy mount or a parallelForEach', () => {
    const fresh = () => mountThenFork(flowChart('Init', () => undefined, 'init'));
    const leaf = flowChart('L', () => undefined, 'l').build();
    expect(() => fresh().addLazySubFlowChartNext('m-fork', () => leaf, 'L')).toThrow(/id 'm-fork' is already used/);
    expect(() =>
      fresh().addParallelForEach('Each', 'm-fork', { items: () => [], branch: () => leaf, maxBranches: 1, into: 'r' }),
    ).toThrow(/id 'm-fork' is already used/);
  });
});

// ── The lazy-mount and parallelForEach doors refuse a duplicate id ──────────
//
// Through 9.37.0 they registered their id nowhere, so they accepted one that
// another stage or mount already had, and a later stage could take theirs.

describe('the lazy-mount and parallelForEach doors refuse a duplicate id', () => {
  const leaf = flowChart('L', () => undefined, 'l').build();
  const start = () => flowChart('Init', () => undefined, 'init').addFunction('A', () => undefined, 'dup');

  it.each([
    ['addLazySubFlowChartNext', (b: any) => b.addLazySubFlowChartNext('dup', () => leaf, 'L')],
    ['addLazySubFlowChart', (b: any) => b.addLazySubFlowChart('dup', () => leaf, 'L')],
    [
      'addLazySubFlowChartBranch',
      (b: any) =>
        b
          .addDeciderFunction('D', () => 'dup', 'd')
          .addLazySubFlowChartBranch('dup', () => leaf, 'L')
          .addFunctionBranch('other', 'O', () => undefined),
    ],
    [
      'addParallelForEach',
      (b: any) =>
        b.addParallelForEach('Each', 'dup', { items: () => [], branch: () => leaf, maxBranches: 1, into: 'r' }),
    ],
  ])('%s', (_door, add) => {
    expect(() => add(start())).toThrow(/id 'dup' is already used by another stage or mount/);
  });

  it('and a later stage may not take a parallelForEach id', () => {
    const b = flowChart('Init', () => undefined, 'init').addParallelForEach('Each', 'each', {
      items: () => [],
      branch: () => leaf,
      maxBranches: 1,
      into: 'r',
    });
    expect(() => b.addFunction('X', () => undefined, 'each')).toThrow(
      /already used by a lazy subflow mount or a parallelForEach/,
    );
  });

  it('a loop back to an earlier stage stays allowed (the one deliberate duplicate)', () => {
    expect(() =>
      flowChart('Init', () => undefined, 'init')
        .addFunction('Head', () => undefined, 'head')
        .addDeciderFunction('D', () => 'done', 'd')
        .addFunctionBranch('again', 'Again', () => undefined, undefined, { loopTo: 'head' })
        .addFunctionBranch('done', 'Done', () => undefined)
        .end()
        .build(),
    ).not.toThrow();
  });
});
