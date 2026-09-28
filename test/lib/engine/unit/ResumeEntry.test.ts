/**
 * ResumeEntry — unit tests for the one owner of the one-shot resume law.
 *
 * `plan` resolves every mount on the pause path against the chart as built
 * and refuses a path the chart cannot walk; `enterSubflow` hands each hop out
 * exactly once; `fromCaptures` is the seed-only form behind the deprecated
 * `subflowStatesForResume` option; `findMount` is the DFS it all rests on.
 */

import { describe, expect, it, vi } from 'vitest';

import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';
import { findMount, ResumeEntry } from '../../../../src/lib/engine/handlers/ResumeEntry';
import { FlowchartTraverser } from '../../../../src/lib/engine/traversal/FlowchartTraverser';
import type { ScopeFactory } from '../../../../src/lib/engine/types';
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
