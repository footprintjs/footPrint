/**
 * ControlDepRecorder — a step AFTER a loop is not under one of the loop's own decisions.
 *
 * The shape: `work → more ─ again (loopTo work) | leave`, then `more`'s own next `after1 → after2`.
 * `after1` runs once the loop is left, whichever pass that is: it post-dominates `more`, exactly like
 * a selector's join (ControlDepRecorder.test.ts · 'convergence is NOT misattributed'). So it is
 * governed by what governed the loop as it was ENTERED, never by a decision that chose to go round
 * again. Before the fix, the ancestor walk climbed `after1 → more#k → work#k → again → more#k-1`
 * through the loop's back-edge and answered "under more#k-1 (Left to do)" — a decision that chose
 * to CONTINUE — while the same chart with zero passes answered "nothing". These tests pin one answer
 * for zero, one and three passes, inside a sub-flowchart and inside a decision branch, and pin that
 * stages INSIDE the loop body keep their loop-carried decision.
 */

import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../src/index.js';
import { type Loose, type S, again, loopChart, more, noop, record, seed, work } from './helpers/controlDepLoops.js';

describe('ControlDepRecorder — the step after a loop', () => {
  it.each([0, 1, 3])('with %i pass(es) back, the steps after the loop are under no decision', async (passes) => {
    const { ctrl, find } = await record(loopChart(passes).build());
    const decisions = find('more');
    expect(decisions).toHaveLength(passes + 1);

    expect(ctrl.lookup(find('after1')[0])).toBeUndefined();
    expect(ctrl.lookup(find('after2')[0])).toBeUndefined();
    // The leaving branch itself is still under the decision that chose it.
    expect(ctrl.lookup(find('leave')[0])?.deciderId).toBe(decisions[passes]);
  });

  it('stages inside the loop body keep the decision that sent the run round again', async () => {
    const { ctrl, find } = await record(loopChart(3).build());
    const decisions = find('more');
    const works = find('work');
    expect(ctrl.lookup(works[0])).toBeUndefined();
    for (let i = 1; i < works.length; i++) {
      expect(ctrl.lookup(works[i])).toEqual({ deciderId: decisions[i - 1], label: 'Left to do' });
      expect(ctrl.lookup(decisions[i])?.deciderId).toBe(decisions[i - 1]);
    }
  });

  it('a decider with its own next INSIDE a loop body: that next keeps the loop-carried decision', async () => {
    // seed → work → pick ─ a | b, then pick's next `mid` → more ─ again (loopTo work) | leave.
    // `mid` is inside the loop: on pass k it ran because more#k-1 chose to go round again.
    const chart = flowChart<Loose>('Seed', seed(2) as never, 'seed')
      .addFunction('Work', work as never, 'work')
      .addDeciderFunction('Pick', async () => 'a', 'pick')
      .addFunctionBranch('a', 'A', noop)
      .addFunctionBranch('b', 'B', noop)
      .end()
      .addFunction('Mid', noop, 'mid')
      .addDeciderFunction('More', more as never, 'more')
      .addFunctionBranch('again', 'Again', again as never, undefined, { loopTo: 'work' })
      .addFunctionBranch('leave', 'Leave', noop)
      .end()
      .addFunction('After 1', noop, 'after1')
      .build();
    const { ctrl, find } = await record(chart);
    const decisions = find('more');
    const mids = find('mid');
    expect(ctrl.lookup(mids[0])).toBeUndefined();
    expect(ctrl.lookup(mids[1])?.deciderId).toBe(decisions[0]);
    expect(ctrl.lookup(mids[2])?.deciderId).toBe(decisions[1]);
    expect(ctrl.lookup(find('after1')[0])).toBeUndefined();
  });

  it('nested loops: a step after the inner loop is under the outer loop’s decision, not the inner one’s', async () => {
    // seed → outer-work → work → more ─ again (loopTo work) | leave, then more's next `mid`
    // → outer ─ round (loopTo outer-work) | out, then outer's next `after1`.
    let outerLeft = 1;
    const chart = flowChart<Loose>('Seed', seed(0) as never, 'seed')
      .addFunction('Outer work', async (s: S) => s.$setValue('left', 1), 'outer-work')
      .addFunction('Work', work as never, 'work')
      .addDeciderFunction('More', more as never, 'more')
      .addFunctionBranch('again', 'Again', again as never, undefined, { loopTo: 'work' })
      .addFunctionBranch('leave', 'Leave', noop)
      .end()
      .addFunction('Mid', noop, 'mid')
      .addDeciderFunction('Outer', async () => (outerLeft-- > 0 ? 'round' : 'out'), 'outer')
      .addFunctionBranch('round', 'Round', noop, undefined, { loopTo: 'outer-work' })
      .addFunctionBranch('out', 'Out', noop)
      .end()
      .addFunction('After 1', noop, 'after1')
      .build();
    const { ctrl, find } = await record(chart);
    const outers = find('outer');
    const mids = find('mid');
    expect(outers).toHaveLength(2);
    expect(ctrl.lookup(mids[0])).toBeUndefined();
    expect(ctrl.lookup(mids[1])?.deciderId).toBe(outers[0]);
    expect(ctrl.lookup(find('after1')[0])).toBeUndefined();
  });

  it('a loop inside a sub-flowchart: the steps after it, inside and outside the mount, are under no decision', async () => {
    const chart = flowChart<Loose>('Start', noop, 'start')
      .addSubFlowChartNext('sf', loopChart(2).build(), 'Inner', {
        inputMapper: () => ({}),
        outputMapper: () => ({}),
      })
      .addFunction('Outside', noop, 'outside')
      .build();
    const { ctrl, find } = await record(chart);
    expect(find('sf/more')).toHaveLength(3);
    expect(ctrl.lookup(find('sf/after1')[0])).toBeUndefined();
    expect(ctrl.lookup(find('sf/after2')[0])).toBeUndefined();
    expect(ctrl.lookup(find('outside')[0])).toBeUndefined();
  });

  it('a loop inside a decision branch: the steps after it are under the decision that chose the branch', async () => {
    const chart = flowChart<Loose>('Start', noop, 'start')
      .addDeciderFunction('Route', async () => 'looped', 'route')
      .addSubFlowChartBranch('looped', loopChart(2).build(), 'Looped', {
        inputMapper: () => ({}),
        outputMapper: () => ({}),
      })
      .addFunctionBranch('plain', 'Plain', noop)
      .end()
      .addFunction('Outside', noop, 'outside')
      .build();
    const { ctrl, find } = await record(chart);
    const [route] = find('route');
    const inner = find('looped/more');
    expect(inner).toHaveLength(3);
    expect(ctrl.lookup(find('looped/after1')[0])?.deciderId).toBe(route);
    expect(ctrl.lookup(find('looped/after2')[0])?.deciderId).toBe(route);
    // Inside the branch's loop body the loop-carried decision is still the nearest one.
    expect(ctrl.lookup(find('looped/work')[2])?.deciderId).toBe(inner[1]);
    expect(ctrl.lookup(find('outside')[0])).toBeUndefined();
  });

  it('a sub-flowchart mounted INSIDE the loop body keeps the loop-carried decision for its inner steps', async () => {
    const body = flowChart<Loose>('Inner', noop, 'inner').build();
    const chart = flowChart<Loose>('Seed', seed(1) as never, 'seed')
      .addSubFlowChartNext('body', body, 'Body', { inputMapper: () => ({}), outputMapper: () => ({}) })
      .addDeciderFunction('More', more as never, 'more')
      .addFunctionBranch('again', 'Again', again as never, undefined, { loopTo: 'body' })
      .addFunctionBranch('leave', 'Leave', noop)
      .end()
      .addFunction('After 1', noop, 'after1')
      .build();
    const { ctrl, find } = await record(chart);
    const [first] = find('more');
    expect(ctrl.lookup(find('body/inner')[1])?.deciderId).toBe(first);
    expect(ctrl.lookup(find('after1')[0])).toBeUndefined();
  });
});
