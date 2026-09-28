/**
 * ResumeEntry — unit tests for the one owner of the one-shot resume law.
 *
 * `plan` resolves every mount on the pause path against the chart as built,
 * attaches each dispatcher's continuation at its own level, queues waiting
 * sibling pauses at their fan-out, and refuses a path the chart cannot walk
 * (or cannot walk unambiguously); `enterSubflow` hands each hop out exactly
 * once; `fromCaptures` is the seed-only form behind the deprecated
 * `subflowStatesForResume` option; `findMount` is the DFS it all rests on;
 * `raiseQueuedPause` / `queueBehind` raise and carry a waiting sibling.
 */

import { describe, expect, it, vi } from 'vitest';

import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';
import type { QueuedPause } from '../../../../src/lib/engine/handlers/ResumeEntry';
import { findMount, queueBehind, raiseQueuedPause, ResumeEntry } from '../../../../src/lib/engine/handlers/ResumeEntry';
import { FlowchartTraverser } from '../../../../src/lib/engine/traversal/FlowchartTraverser';
import type { ScopeFactory } from '../../../../src/lib/engine/types';
import { PauseSignal } from '../../../../src/lib/pause/types';
import { ExecutionRuntime } from '../../../../src/lib/runner/ExecutionRuntime';
import { loopPastMountChart } from '../../pause/resume-real-chart-fixture';

const fn = () => undefined;

/**
 * top:   init → sf-a (mount) → final
 * sf-a:  sf-a/a-pre → sf-a/sf-b (mount) → sf-a/a-post
 * sf-b:  sf-a/sf-b/b-ask
 */
function chart() {
  const final: StageNode = { name: 'Final', id: 'final', fn };
  const mountA: StageNode = { name: 'A', id: 'sf-a', isSubflowRoot: true, subflowId: 'sf-a', next: final };
  const root: StageNode = { name: 'Init', id: 'init', fn, next: mountA };
  const aPost: StageNode = { name: 'sf-a/APost', id: 'sf-a/a-post', fn };
  const mountB: StageNode = {
    name: 'sf-a/B',
    id: 'sf-a/sf-b',
    isSubflowRoot: true,
    subflowId: 'sf-a/sf-b',
    next: aPost,
  };
  const aRoot: StageNode = { name: 'sf-a/APre', id: 'sf-a/a-pre', fn, next: mountB };
  const bRoot: StageNode = { name: 'sf-a/sf-b/BAsk', id: 'sf-a/sf-b/b-ask', fn };
  const subflows = { 'sf-a': { root: aRoot }, 'sf-a/sf-b': { root: bRoot } };
  const standIn: StageNode = { name: bRoot.name, id: bRoot.id, fn };
  return { root, mountA, mountB, subflows, standIn };
}

describe('ResumeEntry.plan', () => {
  it('a top-level pause starts at the stand-in and has no hops', () => {
    const { root, subflows, standIn } = chart();
    const entry = ResumeEntry.plan({ root, subflows, path: [], captures: {}, standIn });

    expect(entry.start).toBe(standIn);
    expect(entry.spent).toBe(true);
    expect(entry.enterSubflow('sf-a')).toBeUndefined();
  });

  it('a one-deep pause starts at the mount, and its one hop enters at the stand-in with the capture', () => {
    const { root, mountA, subflows, standIn } = chart();
    const entry = ResumeEntry.plan({ root, subflows, path: ['sf-a'], captures: { 'sf-a': { x: 1 } }, standIn });

    expect(entry.start).toBe(mountA);
    expect(entry.enterSubflow('sf-a')).toEqual({ subflowId: 'sf-a', seed: { x: 1 }, entry: standIn });
  });

  it('a two-deep pause re-enters the outer subflow AT the inner mount, and the inner one at the stand-in', () => {
    const { root, mountA, mountB, subflows, standIn } = chart();
    const captures = { 'sf-a': { a: 1 }, 'sf-a/sf-b': { b: 2 } };
    const entry = ResumeEntry.plan({ root, subflows, path: ['sf-a', 'sf-a/sf-b'], captures, standIn });

    expect(entry.start).toBe(mountA);
    const outer = entry.enterSubflow('sf-a');
    expect(outer?.entry).toBe(mountB); // not sf-a's root — a-pre does not run again
    expect(outer?.seed).toEqual({ a: 1 });
    const inner = entry.enterSubflow('sf-a/sf-b');
    expect(inner?.entry).toBe(standIn);
    expect(inner?.seed).toEqual({ b: 2 });
    expect(entry.spent).toBe(true);
  });

  it('a hop is ONE-SHOT: the second entry into the same subflow is an ordinary one', () => {
    const { root, subflows, standIn } = chart();
    const entry = ResumeEntry.plan({ root, subflows, path: ['sf-a'], captures: { 'sf-a': {} }, standIn });

    expect(entry.enterSubflow('sf-a')).toBeDefined();
    expect(entry.enterSubflow('sf-a')).toBeUndefined();
    expect(entry.enterSubflow('sf-a')).toBeUndefined();
  });

  it('an entry into a subflow OFF the pause path takes nothing — and does not consume the path', () => {
    const { root, subflows, standIn } = chart();
    const entry = ResumeEntry.plan({ root, subflows, path: ['sf-a'], captures: { 'sf-a': {} }, standIn });

    expect(entry.enterSubflow('elsewhere')).toBeUndefined();
    expect(entry.spent).toBe(false);
    expect(entry.enterSubflow('sf-a')?.entry).toBe(standIn);
  });

  it('a capture for a subflow OFF the path is never handed out — a checkpoint cannot seed an unrelated subflow', () => {
    const { root, subflows, standIn } = chart();
    const captures = { 'sf-a': {}, injected: { admin: true } };
    const entry = ResumeEntry.plan({ root, subflows, path: ['sf-a'], captures, standIn });

    expect(entry.enterSubflow('injected')).toBeUndefined();
  });

  it('a missing capture leaves the hop without a seed (the inputMapper then runs, as on any entry)', () => {
    const { root, subflows, standIn } = chart();
    const entry = ResumeEntry.plan({ root, subflows, path: ['sf-a'], captures: {}, standIn });

    const hop = entry.enterSubflow('sf-a');
    expect(hop).toBeDefined();
    expect(Object.keys(hop ?? {})).not.toContain('seed');
    expect(hop?.entry).toBe(standIn);
  });

  it('tolerates an absent captures map (a pre-4.16 checkpoint)', () => {
    const { root, subflows, standIn } = chart();
    const entry = ResumeEntry.plan({ root, subflows, path: ['sf-a'], captures: undefined, standIn });

    expect(entry.enterSubflow('sf-a')?.seed).toBeUndefined();
  });

  it('REFUSES a path whose first mount is not reachable from the chart root', () => {
    const { root, subflows, standIn } = chart();

    expect(() => ResumeEntry.plan({ root, subflows, path: ['sf-a/sf-b'], captures: {}, standIn })).toThrow(
      /Cannot resume: the mount of subflow 'sf-a\/sf-b' is not reachable from the flowchart/,
    );
  });

  it('REFUSES a path whose inner mount is not reachable from the enclosing subflow', () => {
    const { root, subflows, standIn } = chart();
    const tampered = { ...subflows, 'sf-x': { root: { name: 'x', id: 'sf-x/x', fn } } };

    expect(() => ResumeEntry.plan({ root, subflows: tampered, path: ['sf-a', 'sf-x'], captures: {}, standIn })).toThrow(
      /the mount of subflow 'sf-x' is not reachable from subflow 'sf-a'/,
    );
  });

  it('REFUSES a path naming a subflow the chart does not register', () => {
    const { root, subflows, standIn } = chart();
    const { 'sf-a': _dropped, ...rest } = subflows;

    expect(() => ResumeEntry.plan({ root, subflows: rest, path: ['sf-a'], captures: {}, standIn })).toThrow(
      /subflow 'sf-a' is not registered/,
    );
  });
});

describe('ResumeEntry.fromCaptures (the deprecated seed-only form)', () => {
  it('seeds the FIRST entry into each captured subflow, from its own root, and nothing after', () => {
    const entry = ResumeEntry.fromCaptures({ one: { x: 1 }, two: { y: 2 } });

    expect(entry.start).toBeUndefined();
    expect(entry.enterSubflow('one')).toEqual({ subflowId: 'one', seed: { x: 1 } });
    expect(entry.enterSubflow('one')).toBeUndefined();
    expect(entry.enterSubflow('two')?.entry).toBeUndefined();
    expect(entry.spent).toBe(true);
  });
});

describe('findMount', () => {
  it('finds a mount along next, through children, and skips loop stubs', () => {
    const target: StageNode = { name: 'M', id: 'm', isSubflowRoot: true, subflowId: 'm' };
    const stub: StageNode = { name: 'm', id: 'm', isLoopRef: true };
    const branch: StageNode = { name: 'B', id: 'b', fn, next: stub };
    const decider: StageNode = { name: 'D', id: 'd', fn, children: [branch, target] };
    const root: StageNode = { name: 'R', id: 'r', fn, next: decider };

    expect(findMount(root, 'm')).toBe(target);
    expect(findMount(root, 'absent')).toBeUndefined();
  });

  it('is cycle-safe and visits children before next (pre-order)', () => {
    const later: StageNode = { name: 'Later', id: 'later', isSubflowRoot: true, subflowId: 'dup' };
    const early: StageNode = { name: 'Early', id: 'early', isSubflowRoot: true, subflowId: 'dup' };
    const root: StageNode = { name: 'R', id: 'r', fn, children: [early], next: later };
    // A cycle back to the root must not loop forever.
    (later as { next?: StageNode }).next = root;

    expect(findMount(root, 'dup')).toBe(early);
  });
});

describe('FlowchartTraverser — the deprecated subflowStatesForResume option', () => {
  it('still seeds a subflow from its capture — on the FIRST entry only, then the inputMapper runs again', async () => {
    const chart = loopPastMountChart();
    const traverser = new FlowchartTraverser({
      root: chart.root,
      stageMap: chart.stageMap,
      subflows: chart.subflows,
      scopeFactory: chart.scopeFactory as ScopeFactory,
      executionRuntime: new ExecutionRuntime(chart.root.name, chart.root.id),
      logger: { info: vi.fn(), log: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
      runId: 'deprecated-option',
      // A capture for the loop body's subflow: pass 7 (never 1, so it asks nothing).
      subflowStatesForResume: { 'sf-inputs': { pass: 7, prior: [] } },
    });

    await traverser.execute();

    const state = traverser.getSnapshot().sharedState as { trace: string[] };
    // Pass 1 entered with the capture (start7/ask7, inputMapper skipped);
    // passes 2 and 3 are ordinary entries (start2/start3 from the mapper).
    expect(state.trace).toEqual([
      'start7',
      'ask7',
      'tools1',
      'head2',
      'start2',
      'ask2',
      'tools2',
      'head3',
      'start3',
      'ask3',
      'final',
    ]);
  });
});

// ── Dispatcher continuations, level by level ─────────────────────────────────

/**
 * top:   seed → route (decider) ─┬─ sf-a (mount)  → next: after → final
 *                                └─ y
 * sf-a:  sf-a/a-pre → sf-a/fork (children: sf-a/sf-b mount, sf-a/sib) → next: sf-a/join
 * sf-b:  sf-a/sf-b/b-ask
 */
function dispatched() {
  const final: StageNode = { name: 'Final', id: 'final', fn };
  const after: StageNode = { name: 'After', id: 'after', fn, next: final };
  const mountA: StageNode = { name: 'A', id: 'sf-a', isSubflowRoot: true, subflowId: 'sf-a' };
  const y: StageNode = { name: 'Y', id: 'y', fn };
  const route: StageNode = { name: 'Route', id: 'route', fn, deciderFn: true, children: [mountA, y], next: after };
  const root: StageNode = { name: 'Seed', id: 'seed', fn, next: route };
  const join: StageNode = { name: 'sf-a/Join', id: 'sf-a/join', fn };
  const mountB: StageNode = { name: 'sf-a/B', id: 'sf-a/sf-b', isSubflowRoot: true, subflowId: 'sf-a/sf-b' };
  const sib: StageNode = { name: 'sf-a/Sib', id: 'sf-a/sib', fn };
  const fork: StageNode = { name: 'sf-a/Fork', id: 'sf-a/fork', fn, children: [mountB, sib], next: join };
  const aRoot: StageNode = { name: 'sf-a/APre', id: 'sf-a/a-pre', fn, next: fork };
  const bRoot: StageNode = { name: 'sf-a/sf-b/BAsk', id: 'sf-a/sf-b/b-ask', fn };
  const subflows = { 'sf-a': { root: aRoot }, 'sf-a/sf-b': { root: bRoot } };
  const standIn: StageNode = { name: bRoot.name, id: bRoot.id, fn };
  return { root, route, after, mountA, fork, join, mountB, sib, subflows, standIn };
}

describe('ResumeEntry.plan — each dispatcher’s continuation lands at its own level', () => {
  it('a mount that is a DECIDER branch enters as { ...mount, next: decider.next } — the mount itself untouched', () => {
    const { root, subflows, standIn, mountA, after } = dispatched();
    const entry = ResumeEntry.plan({ root, subflows, path: ['sf-a', 'sf-a/sf-b'], captures: { 'sf-a': {} }, standIn });

    expect(entry.start).not.toBe(mountA); // a never-registered copy
    expect(entry.start).toMatchObject({ id: 'sf-a', subflowId: 'sf-a', next: after });
    expect(mountA.next).toBeUndefined();
  });

  it('a mount that is a FORK child enters with the fork’s join as its next', () => {
    const { root, subflows, standIn, mountB, join } = dispatched();
    const entry = ResumeEntry.plan({ root, subflows, path: ['sf-a', 'sf-a/sf-b'], captures: { 'sf-a': {} }, standIn });

    const hop = entry.enterSubflow('sf-a');
    expect(hop?.entry).toMatchObject({ id: 'sf-a/sf-b', next: join });
    expect(mountB.next).toBeUndefined();
  });

  it('the stand-in takes ITS OWN level’s continuation only — never a dispatcher from above', () => {
    const { root, subflows, standIn } = dispatched();
    const entry = ResumeEntry.plan({ root, subflows, path: ['sf-a', 'sf-a/sf-b'], captures: { 'sf-a': {} }, standIn });

    entry.enterSubflow('sf-a');
    expect(entry.enterSubflow('sf-a/sf-b')?.entry).toBe(standIn); // b-ask is on sf-b's spine: nothing to attach
  });

  it('the stand-in of a paused BRANCH takes its dispatcher’s real next — a loop stub stays a stub', () => {
    const head: StageNode = { name: 'Head', id: 'head', fn };
    const stub: StageNode = { name: 'head', id: 'head', isLoopRef: true };
    const ask: StageNode = { name: 'Ask', id: 'ask', fn };
    const route: StageNode = { name: 'Route', id: 'route', fn, deciderFn: true, children: [ask], next: stub };
    head.next = route;
    const standIn: StageNode = { name: 'Ask', id: 'ask', fn };

    const entry = ResumeEntry.plan({ root: head, subflows: {}, path: [], captures: {}, standIn });

    expect(entry.start).toMatchObject({ id: 'ask', next: stub }); // routed through the ContinuationResolver: a LOOP
  });

  it('past a dispatcher with no next, the walk goes OUTWARD to the one enclosing it', () => {
    const join: StageNode = { name: 'Join', id: 'join', fn };
    const leafStage: StageNode = { name: 'Leaf', id: 'leaf', fn };
    const inner: StageNode = { name: 'Inner', id: 'inner', fn, deciderFn: true, children: [leafStage] };
    const outer: StageNode = { name: 'Outer', id: 'outer', fn, children: [inner], next: join };
    const standIn: StageNode = { name: 'Leaf', id: 'leaf', fn };

    const entry = ResumeEntry.plan({ root: outer, subflows: {}, path: [], captures: {}, standIn });

    expect(entry.start).toMatchObject({ id: 'leaf', next: join });
  });

  it('a stand-in with its own chain keeps it, and the continuation is attached where that chain ends', () => {
    const join: StageNode = { name: 'Join', id: 'join', fn };
    const tail: StageNode = { name: 'Tail', id: 'tail', fn };
    const leafStage: StageNode = { name: 'Leaf', id: 'leaf', fn, next: tail };
    const fork: StageNode = { name: 'Fork', id: 'fork', fn, children: [leafStage], next: join };
    const standIn: StageNode = { name: 'Leaf', id: 'leaf', fn, next: tail };

    const entry = ResumeEntry.plan({ root: fork, subflows: {}, path: [], captures: {}, standIn });

    expect(entry.start).toMatchObject({ id: 'leaf', next: { id: 'tail', next: join } });
    expect(tail.next).toBeUndefined(); // copied, never edited
  });
});

describe('ResumeEntry.plan — a checkpoint missing an OUTER capture', () => {
  it('that subflow gets NO entry (its root, its inputMapper) — the leaf still enters at the stand-in', () => {
    const { root, subflows, standIn } = chart();
    const entry = ResumeEntry.plan({
      root,
      subflows,
      path: ['sf-a', 'sf-a/sf-b'],
      captures: { 'sf-a/sf-b': { b: 1 } },
      standIn,
    });

    expect(entry.enterSubflow('sf-a')).toEqual({ subflowId: 'sf-a' });
    expect(entry.enterSubflow('sf-a/sf-b')).toMatchObject({ seed: { b: 1 }, entry: standIn });
    expect(entry.stepsBeforeStandIn).toBeUndefined(); // sf-a's opening stages re-run first
  });

  it('with every capture present, one execution per level runs before the stand-in', () => {
    const { root, subflows, standIn } = chart();
    const captures = { 'sf-a': {}, 'sf-a/sf-b': {} };

    expect(ResumeEntry.plan({ root, subflows, path: [], captures, standIn }).stepsBeforeStandIn).toBe(0);
    expect(
      ResumeEntry.plan({ root, subflows, path: ['sf-a', 'sf-a/sf-b'], captures, standIn }).stepsBeforeStandIn,
    ).toBe(2);
  });
});

describe('ResumeEntry.plan — refusals and own-property guards', () => {
  it('REFUSES a subflow id mounted twice in one graph, naming both mounts', () => {
    const second: StageNode = { name: 'Second', id: 'sf', isSubflowRoot: true, subflowId: 'sf' };
    const first: StageNode = { name: 'First', id: 'sf', isSubflowRoot: true, subflowId: 'sf', next: second };
    const inner: StageNode = { name: 'sf/Ask', id: 'sf/ask', fn };

    expect(() =>
      ResumeEntry.plan({ root: first, subflows: { sf: { root: inner } }, path: ['sf'], captures: {}, standIn: inner }),
    ).toThrow("Cannot resume: subflow 'sf' is mounted more than once in the flowchart ('First', 'Second')");
  });

  it('a hand-built mount named `__proto__` is refused as NOT REGISTERED — never resolved through the prototype', () => {
    const mount: StageNode = { name: 'Proto', id: '__proto__', isSubflowRoot: true, subflowId: '__proto__' };
    const standIn: StageNode = { name: 'Ask', id: '__proto__/ask', fn };

    expect(() => ResumeEntry.plan({ root: mount, subflows: {}, path: ['__proto__'], captures: {}, standIn })).toThrow(
      "Cannot resume: subflow '__proto__' is not registered",
    );
  });

  it('a capture keyed by a prototype member is only ever an OWN entry', () => {
    const mount: StageNode = { name: 'T', id: 'toString', isSubflowRoot: true, subflowId: 'toString' };
    const inner: StageNode = { name: 'toString/Ask', id: 'toString/ask', fn };
    const entry = ResumeEntry.plan({
      root: mount,
      subflows: { toString: { root: inner } },
      path: ['toString'],
      captures: {}, // no own 'toString' key — Object.prototype.toString must not become the seed
      standIn: inner,
    });

    expect(entry.enterSubflow('toString')).not.toHaveProperty('seed');
  });
});

// ── Waiting sibling pauses ───────────────────────────────────────────────────

describe('ResumeEntry.plan — sibling pauses wait at their fan-out', () => {
  const pendingSib = { pausedStageId: 'sf-a/sib', subflowPath: ['sf-a'], subflowStates: {}, pauseData: { q: 'sib' } };

  it('are queued on the hop INTO the fan-out’s level, and that level’s entry does not carry the join yet', () => {
    const { root, subflows, standIn, join } = dispatched();
    const entry = ResumeEntry.plan({
      root,
      subflows,
      path: ['sf-a', 'sf-a/sf-b'],
      captures: { 'sf-a': {} },
      standIn,
      pendingPauses: [pendingSib],
    });

    const hop = entry.enterSubflow('sf-a');
    expect(hop?.entry).toMatchObject({ id: 'sf-a/sf-b' });
    expect(hop?.entry?.next).toBeUndefined(); // NOT the join: the sibling still waits
    expect(hop?.entry?.next).not.toBe(join);
    expect(hop?.pendingPauses).toEqual([{ pause: pendingSib, level: 1, stageName: 'sf-a/Sib' }]);
  });

  it('refuses a record whose stage does not hang off the same fan-out', () => {
    const { root, subflows, standIn } = dispatched();
    const notASibling = { pausedStageId: 'sf-a/join', subflowPath: ['sf-a'], subflowStates: {} };

    expect(() =>
      ResumeEntry.plan({
        root,
        subflows,
        path: ['sf-a', 'sf-a/sf-b'],
        captures: { 'sf-a': {} },
        standIn,
        pendingPauses: [notASibling],
      }),
    ).toThrow(/pendingPauses\[0\] \('sf-a\/join'\) is not a parallel sibling/);
  });

  it('refuses a record under a DECIDER — one decider never runs two branches', () => {
    const { root, subflows, standIn } = dispatched();
    const underDecider = { pausedStageId: 'y', subflowPath: [], subflowStates: {} };

    expect(() =>
      ResumeEntry.plan({
        root,
        subflows,
        path: ['sf-a', 'sf-a/sf-b'],
        captures: { 'sf-a': {} },
        standIn,
        pendingPauses: [underDecider],
      }),
    ).toThrow(/is not a parallel sibling/);
  });
});

describe('raiseQueuedPause / queueBehind', () => {
  const queued = (pausedStageId: string, subflowPath: string[], level: number): QueuedPause => ({
    pause: {
      pausedStageId,
      subflowPath,
      subflowStates: { 'sf-a': { above: true }, 'sf-a/c2': { own: true } },
      pauseData: { who: pausedStageId },
      pausedBy: 'interrupt',
    },
    level,
    stageName: pausedStageId,
  });

  it('raises the first as it bubbled to its level — path below the fan-out, only ITS captures — the rest behind it', () => {
    const signal = raiseQueuedPause([
      queued('sf-a/c2/ask', ['sf-a', 'sf-a/c2'], 1),
      queued('sf-a/c3/ask', ['sf-a', 'sf-a/c3'], 1),
    ]);

    expect(signal).toBeInstanceOf(PauseSignal);
    expect(signal.stageId).toBe('sf-a/c2/ask');
    expect(signal.pausedBy).toBe('interrupt');
    expect(signal.pauseData).toEqual({ who: 'sf-a/c2/ask' });
    expect(signal.subflowPath).toEqual(['sf-a/c2']);
    expect(signal.subflowStates).toEqual({ 'sf-a/c2': { own: true } }); // sf-a captures itself on the way up
    expect(signal.pendingPauses.map((p) => p.subflowPath)).toEqual([['sf-a/c3']]);

    signal.prependSubflow('sf-a'); // the bubble-up grows every entry together
    expect(signal.subflowPath).toEqual(['sf-a', 'sf-a/c2']);
    expect(signal.pendingPauses[0].subflowPath).toEqual(['sf-a', 'sf-a/c3']);
  });

  it('queueBehind carries a level’s waiting pauses on a pause passing through it', () => {
    const passing = new PauseSignal({ q: 1 }, 'sf-a/c1/ask');
    passing.prependSubflow('sf-a/c1');
    queueBehind(passing, [queued('sf-a/c2/ask', ['sf-a', 'sf-a/c2'], 1)]);

    expect(passing.pendingPauses).toHaveLength(1);
    expect(passing.pendingPauses[0]).toMatchObject({ pausedStageId: 'sf-a/c2/ask', subflowPath: ['sf-a/c2'] });
  });
});

describe('findMount — cycle-safety for an ABSENT id', () => {
  it('terminates on a cyclic graph when nothing matches', () => {
    const a: StageNode = { name: 'A', id: 'a', fn };
    const b: StageNode = { name: 'B', id: 'b', fn, children: [a] };
    a.next = b; // a real cycle (hand-built — the builder only loops through stubs)

    expect(findMount(b, 'absent')).toBeUndefined();
  });
});

describe('FlowchartTraverser — the entry is ONE-SHOT', () => {
  it('the first execute() starts at the entry; a second one starts at the root', async () => {
    const calls: string[] = [];
    const last: StageNode = {
      name: 'Last',
      id: 'last',
      fn: () => {
        calls.push('last');
      },
    };
    const middle: StageNode = {
      name: 'Middle',
      id: 'middle',
      fn: () => {
        calls.push('middle');
      },
      next: last,
    };
    const root: StageNode = {
      name: 'Root',
      id: 'root',
      fn: () => {
        calls.push('root');
      },
      next: middle,
    };
    const traverser = new FlowchartTraverser({
      root,
      entry: last,
      stageMap: new Map(),
      scopeFactory: ((ctx: unknown) => ctx) as unknown as ScopeFactory,
      executionRuntime: new ExecutionRuntime(root.name, root.id),
      logger: { info: vi.fn(), log: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
      runId: 'one-shot',
    });

    await traverser.execute();
    expect(calls).toEqual(['last']);
    await traverser.execute();
    expect(calls).toEqual(['last', 'root', 'middle', 'last']);
  });

  it('its waiting sibling pauses are raised once, after the entry’s chain — never again', async () => {
    const root: StageNode = { name: 'Root', id: 'root', fn: () => undefined };
    const entry: StageNode = { name: 'Entry', id: 'entry', fn: () => undefined };
    const traverser = new FlowchartTraverser({
      root,
      entry,
      pendingPauses: [
        {
          pause: { pausedStageId: 'sib', subflowPath: [], subflowStates: {}, pauseData: 'q' },
          level: 0,
          stageName: 'Sib',
        },
      ],
      stageMap: new Map(),
      scopeFactory: ((ctx: unknown) => ctx) as unknown as ScopeFactory,
      executionRuntime: new ExecutionRuntime(root.name, root.id),
      logger: { info: vi.fn(), log: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
      runId: 'one-shot',
    });

    await expect(traverser.execute()).rejects.toMatchObject({ name: 'PauseSignal', stageId: 'sib', pauseData: 'q' });
    await expect(traverser.execute()).resolves.toBeUndefined(); // the root's own run: no pause raised
  });
});
