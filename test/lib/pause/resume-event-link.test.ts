/**
 * The `onResume` event (9.37.0, F7): built by the one TraversalContext
 * constructor, it names the REAL subflow the resumed stage runs in and its
 * depth, and LINKS to the paused execution (`resumedFrom`) — OpenTelemetry
 * span-link style — instead of claiming depth 0 and no subflow.
 *
 * Before 9.37.0: a pause inside `sf-out → sf-in` resumed with
 * `{ depth: 0 }` and no `subflowId`, while the stand-in's own stage events
 * said `subflowId: 'sf-out/sf-in'`.
 */
import { describe, expect, it } from 'vitest';

import type { FlowchartCheckpoint, FlowRecorder, TraversalContext } from '../../../src/index.js';
import { flowChart, FlowChartExecutor, interrupt } from '../../../src/index.js';

type S = Record<string, any>;

function nestedPauseChart() {
  const set = (key: string) => (s: S) => {
    s[key] = 1;
  };
  const inner = flowChart('Plan', set('plan'), 'plan')
    .addPausableFunction('Ask', { execute: () => ({ q: 1 }), resume: set('answered') }, 'ask')
    .build();
  const middle = flowChart('M0', set('m'), 'm0').addSubFlowChartNext('sf-in', inner, 'In').build();
  return flowChart('Init', set('i'), 'init').addSubFlowChartNext('sf-out', middle, 'Out').build();
}

function recorder() {
  const seen: Record<string, TraversalContext[]> = { onPause: [], onResume: [], onStageExecuted: [] };
  const scopeResume: unknown[] = [];
  const flow: FlowRecorder = {
    id: 'link-probe',
    onPause: (e) => {
      seen.onPause.push(e.traversalContext!);
    },
    onResume: (e) => {
      seen.onResume.push(e.traversalContext!);
    },
    onStageExecuted: (e) => {
      seen.onStageExecuted.push(e.traversalContext!);
    },
  };
  const scope = {
    id: 'link-probe-scope',
    onResume: (e: unknown) => {
      scopeResume.push(e);
    },
  };
  return { seen, scopeResume, flow, scope };
}

describe('the resume event carries the real path, depth and a link', () => {
  it('same executor: subflowId + depth of the paused stage, linked to the paused execution', async () => {
    const executor = new FlowChartExecutor(nestedPauseChart());
    const r = recorder();
    executor.attachFlowRecorder(r.flow);
    executor.attachScopeRecorder(r.scope as never);
    await executor.run();
    const paused = r.seen.onPause[0];

    await executor.resume(executor.getCheckpoint()!, { ok: true });
    const resumed = r.seen.onResume[0];

    expect(resumed.subflowId).toBe('sf-out/sf-in');
    expect(resumed.depth).toBe(2);
    expect(resumed.resumedFrom).toEqual({ runId: paused.runId, runtimeStageId: paused.runtimeStageId });
    expect(resumed.runId).not.toBe(paused.runId);
    // The scope-channel twin carries the same link.
    expect(r.scopeResume[0]).toMatchObject({ resumedFrom: resumed.resumedFrom });
    // The event still names the stand-in's own execution — the one its stage event stamps.
    const standIn = r.seen.onStageExecuted.find((c) => c.runtimeStageId === resumed.runtimeStageId);
    expect(standIn?.subflowId).toBe(resumed.subflowId);
  });

  it('a top-level interrupt: no subflow, depth 0, linked', async () => {
    const chart = flowChart('Init', () => undefined, 'init')
      .addFunction(
        'Gate',
        (s: S) => {
          s.answer = interrupt(s, { q: 1 });
        },
        'gate',
      )
      .build();
    const executor = new FlowChartExecutor(chart);
    const r = recorder();
    executor.attachFlowRecorder(r.flow);
    await executor.run();
    await executor.resume(executor.getCheckpoint()!, 'yes');
    const resumed = r.seen.onResume[0];
    expect(resumed.subflowId).toBeUndefined();
    expect(resumed.depth).toBe(0);
    expect(resumed.resumedFrom).toEqual({ runId: r.seen.onPause[0].runId, runtimeStageId: 'gate#1' });
  });

  it('a checkpoint this executor did not make (serialized, cross-executor) resumes with no link — never a guess', async () => {
    const first = new FlowChartExecutor(nestedPauseChart());
    await first.run();
    const stored: FlowchartCheckpoint = JSON.parse(JSON.stringify(first.getCheckpoint()));

    const second = new FlowChartExecutor(nestedPauseChart());
    const r = recorder();
    second.attachFlowRecorder(r.flow);
    await second.resume(stored, { ok: true });
    const resumed = r.seen.onResume[0];
    expect(resumed.subflowId).toBe('sf-out/sf-in');
    expect(resumed.depth).toBe(2);
    expect(resumed).not.toHaveProperty('resumedFrom');
  });

  it('the checkpoint record is unchanged — the link is held beside it, not in it', async () => {
    const executor = new FlowChartExecutor(nestedPauseChart());
    await executor.run();
    expect(Object.keys(executor.getCheckpoint()!).sort()).toEqual(
      [
        'executionCount',
        'executionTree',
        'pauseData',
        'pausedAt',
        'pausedStageId',
        'sharedState',
        'subflowPath',
        'subflowStates',
        'visitCounts',
      ].sort(),
    );
  });
});
