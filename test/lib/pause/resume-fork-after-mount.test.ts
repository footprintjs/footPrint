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
