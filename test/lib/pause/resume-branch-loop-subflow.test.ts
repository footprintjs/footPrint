/**
 * Regression: a branch-sourced loop whose TARGET is a SUBFLOW must survive
 * pause/resume.
 *
 * This is exactly the agent's ReAct shape: a decider routes to a PAUSABLE
 * `tool-calls` branch that loops back to a SUBFLOW (the injection engine /
 * llm-call), and a terminal branch that ends. Human-in-the-loop approval pauses
 * the branch; on resume the branch must loop back INTO the subflow body and the
 * full downstream chain (subflow → decider → terminal) must run.
 *
 * THE BUG (pre-fix): on resume the looping branch's `next` is a loop-ref STUB
 * ({ id, isLoopRef:true } — no fn/children/subflowId). The resume traverser
 * builds its node map from the resume root, where the real subflow MOUNT node is
 * unreachable, so the stub wins the id slot and `executeNode` throws
 * "Node '<subflow>' must define: embedded fn OR a stageMap entry OR have
 * children/decider". Normal runs are fine (the real mount node is reachable from
 * the chart root and wins the id slot first).
 *
 * We observe the loop at the PARENT level — a subflow-entry counter (proves the
 * subflow body re-ran) plus a parent-scope `done` flag (proves the chain ran
 * through to the terminal branch). This sidesteps subflow output-mapping, which
 * is an orthogonal concern.
 *
 * Test types: functional (same-executor resume completes), integration (loop
 * body re-runs + terminal ends), security/robustness (cross-executor resume from
 * a serialized checkpoint).
 */

import type { FlowRecorder, PausableHandler } from 'footprintjs';
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';

interface LoopState {
  pass?: number;
  approved?: boolean;
  done?: boolean;
}

/** No-op one-stage subflow — the loop TARGET. */
const bodyChart = () => flowChart<LoopState>('Work', async () => {}, 'work').build();

/**
 * Pausable branch: pauses on the FIRST execution (asks for approval), and on
 * resume records the approval + advances `pass` so the next route exits the loop.
 */
const approvalHandler: PausableHandler<LoopState> = {
  execute: async () => {
    // Returning data = pause (human-in-the-loop approval gate).
    return { question: 'Approve and loop once more?' };
  },
  resume: async (scope, input) => {
    scope.approved = (input as { approved: boolean }).approved;
    scope.pass = (scope.pass ?? 0) + 1;
  },
};

/**
 * Build the ReAct-shaped chart:
 *   seed → sf-body (subflow) → route(decider)
 *     route 'again'  (PAUSABLE) → loopTo sf-body   ← loop target is a SUBFLOW
 *     route 'done'                → terminal leaf
 */
function buildLoopingChart() {
  return flowChart<LoopState>(
    'Seed',
    async (scope) => {
      if (scope.pass === undefined) scope.pass = 0;
    },
    'seed',
  )
    .addSubFlowChartNext('sf-body', bodyChart(), 'Body')
    .addDeciderFunction('Route', (scope) => (scope.pass! < 1 ? 'again' : 'done'), 'route')
    .addPausableFunctionBranch('again', 'Again', approvalHandler, 'Human approval', { loopTo: 'sf-body' })
    .addFunctionBranch('done', 'Done', async (scope) => {
      scope.done = true;
    })
    .setDefault('done')
    .end()
    .build();
}

/** Count subflow-body entries so we can prove the loop re-entered it. */
function subflowEntryCounter(): { rec: FlowRecorder; count: () => number } {
  let n = 0;
  const rec: FlowRecorder = {
    id: 'sf-entry-count',
    onSubflowEntry: () => {
      n += 1;
    },
  };
  return { rec, count: () => n };
}

describe('resume: branch loop whose target is a SUBFLOW', () => {
  it('functional: same-executor pause → resume completes the loop without throwing', async () => {
    const ex = new FlowChartExecutor(buildLoopingChart());
    await ex.run({ input: {} });

    expect(ex.isPaused()).toBe(true);
    // BUG repro: this resume threw "Node 'sf-body' must define ..." pre-fix.
    await ex.resume(ex.getCheckpoint()!, { approved: true });

    expect(ex.isPaused()).toBe(false);
    const state = ex.getSnapshot().sharedState as LoopState;
    expect(state.approved).toBe(true);
    expect(state.done).toBe(true); // loop ran through to the terminal branch
  });

  it('integration: after resume the subflow body re-runs (loop fires) and the terminal branch ends', async () => {
    const counter = subflowEntryCounter();
    const ex = new FlowChartExecutor(buildLoopingChart());
    ex.attachFlowRecorder(counter.rec);

    await ex.run({ input: {} });
    expect(ex.isPaused()).toBe(true);
    // First pass: seed → sf-body (entry #1) → route('again') → PAUSE.
    expect(counter.count()).toBe(1);
    expect((ex.getSnapshot().sharedState as LoopState).done).toBeUndefined();

    await ex.resume(ex.getCheckpoint()!, { approved: true });

    const final = ex.getSnapshot().sharedState as LoopState;
    // Resume: approve → loop back INTO sf-body (entry #2) → route('done') → end.
    expect(counter.count()).toBe(2); // loop re-entered the subflow body
    expect(final.done).toBe(true); // terminal branch ran after the loop
  });

  it('robustness: cross-executor resume (fresh executor from a serialized checkpoint) re-enters the subflow', async () => {
    const first = new FlowChartExecutor(buildLoopingChart());
    await first.run({ input: {} });
    expect(first.isPaused()).toBe(true);
    // Round-trip the checkpoint through JSON to prove it's serialization-safe.
    const checkpoint = JSON.parse(JSON.stringify(first.getCheckpoint()!));

    // Simulate a different process: brand-new executor, same chart.
    const second = new FlowChartExecutor(buildLoopingChart());
    const counter = subflowEntryCounter();
    second.attachFlowRecorder(counter.rec);
    await second.resume(checkpoint, { approved: true });

    const state = second.getSnapshot().sharedState as LoopState;
    expect(state.approved).toBe(true);
    expect(state.done).toBe(true);
    expect(counter.count()).toBe(1); // the resumed run re-entered the subflow once
  });
});
