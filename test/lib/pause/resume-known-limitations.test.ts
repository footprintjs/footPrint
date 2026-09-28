/**
 * KNOWN LIMITATIONS of resume — pinned, not hidden (found while fixing the
 * one-shot re-entry in 9.27.1; identical on 9.27.0, so not regressions).
 *
 * The re-entry now starts ONCE and then walks the real chart. What it does
 * not rebuild is the continuation of the stage that DISPATCHED the subflow
 * the pause is in, when that subflow is mounted as a BRANCH or a FORK CHILD —
 * the dispatcher's own `next` lives one level up, and the checkpoint records
 * only the innermost dispatcher and one continuation id:
 *
 *   1. a subflow mounted as a DECIDER BRANCH, the decider with its own `next`:
 *      the continuation runs, but INSIDE the subflow (attached as the paused
 *      stage's `next` at the leaf level) — its writes land in the subflow's
 *      isolated memory, not the parent's;
 *   2. a subflow mounted as a FORK CHILD: the fork's continuation (the join)
 *      never runs after the resume.
 *
 * The fix needs the dispatcher's LEVEL on the record — a continuation per
 * level of the pause path, or the dispatcher's path depth — which is a
 * checkpoint shape change (additive), so it is a design decision, not part
 * of this patch. Design direction: README (engine/, "Resume re-entry").
 *
 * WHEN A TEST HERE FAILS, the limitation is fixed: move the chart into
 * resume-real-chart-fixture.ts with its healthy expectation, delete it here,
 * and update the README and .claude/rules/backtracking.md.
 */

import { describe, expect, it } from 'vitest';

import type { FlowChart } from '../../../src/index.js';
import { flowChart } from '../../../src/index.js';
import { type ResumeMode, type S, drive } from './resume-real-chart-fixture.js';

function inner(): FlowChart {
  return flowChart(
    'A',
    (s: S) => {
      s.x = 1;
    },
    'in-a',
  )
    .addPausableFunction(
      'Ask',
      {
        execute: () => ({ question: 'q' }),
        resume: (s: S, input: unknown) => {
          s.answer = input;
        },
      },
      'in-ask',
    )
    .build();
}

describe.each<ResumeMode>(['same', 'cross'])('KNOWN LIMITATION — %s-executor', (mode) => {
  it('1: a subflow mounted as a decider BRANCH — the decider’s continuation runs inside the subflow', async () => {
    const chart = flowChart('Seed', () => undefined, 'seed')
      .addDeciderFunction('Route', () => 'x', 'route')
      .addSubFlowChartBranch('x', inner(), 'X', {
        outputMapper: (sf: Record<string, unknown>) => ({ answer: sf.answer }),
      })
      .addFunctionBranch('y', 'Y', () => undefined)
      .end()
      .addFunction(
        'Done',
        (s: S) => {
          s.done = true;
        },
        'done',
      )
      .build();

    const run = await drive(chart, mode);

    expect(run.checkpoints[0]).toMatchObject({ invokerStageId: 'route', continuationStageId: 'done' });
    expect(run.state.answer).toEqual({ n: 1 });
    // Healthy: `done === true` in the parent. Today 'Done' ran inside the
    // subflow, after the resume half, and its write stayed there.
    expect(run.state.done).toBeUndefined();
  });

  it('2: a subflow mounted as a FORK CHILD — the fork’s join does not run after the resume', async () => {
    const chart = flowChart('Seed', () => undefined, 'seed')
      .addSubFlowChart('fa', inner(), 'FA', { outputMapper: (sf: Record<string, unknown>) => ({ answer: sf.answer }) })
      .addFunction(
        'Join',
        (s: S) => {
          s.joined = true;
        },
        'join',
      )
      .build();

    const run = await drive(chart, mode);

    expect(run.state.answer).toEqual({ n: 1 });
    // Healthy: `joined === true`. Today the resumed run ends at the child.
    expect(run.state.joined).toBeUndefined();
  });
});
