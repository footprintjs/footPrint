/**
 * KNOWN LIMITATIONS of resume — pinned, not hidden (9.28.0).
 *
 * What a resume still does NOT rebuild. None is silent: each either refuses
 * loudly or is a difference in WHERE a resumed stage runs, stated here.
 *
 *   1. A pause inside a LAZY subflow (`addLazySubFlowChart*`) is not
 *      resumable: the lazy graph is resolved at run time and is not in the
 *      chart a resume walks, so `resume()` refuses the checkpoint ("not
 *      found") instead of guessing. (The same holds for a pause inside an
 *      `addParallelForEach` branch — its branch charts are generated at run
 *      time too.)
 *   2. A paused parallel-branch STAGE — a fork child or a selected branch
 *      that is a plain stage, not a subflow — resumes in its DISPATCHER's
 *      context: its resume half (or its re-run, for `interrupt()`) writes
 *      the dispatcher's keys, not its branch's `runs/<branch>` namespace
 *      where it wrote on the run. As in 9.27.0 — and relied on by the
 *      selector-branch continuation test (resume-continuation.test.ts,
 *      pattern 2), so changing it is a behaviour change of its own.
 *   3. The resumed child of a fan-out runs outside the fan-out's
 *      `Promise.allSettled`: if it FAILS after the resume, the run fails —
 *      on the run, a failing fork child was contained and the join ran.
 *      (As in 9.27.0.)
 *
 * What USED to be here and is fixed in 9.28.0: a paused subflow mounted as a
 * decider branch (its decider's `next` ran inside the subflow) or as a fork
 * child (the join never ran) — see resume-dispatchers.test.ts.
 *
 * WHEN A TEST HERE FAILS, the limitation is fixed: move the chart into the
 * suite with its healthy expectation, delete it here, and update the engine
 * README ("Resume re-entry") and .claude/rules/backtracking.md.
 */

import { describe, expect, it } from 'vitest';

import type { FlowChart } from '../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { type ResumeMode, type S, drive } from './resume-real-chart-fixture.js';

function asks(): FlowChart {
  return flowChart('Start', () => undefined, 'sf-start')
    .addPausableFunction(
      'Ask',
      {
        execute: () => ({ question: 'q' }),
        resume: (s: S, input: unknown) => {
          s.answer = input;
        },
      },
      'sf-ask',
    )
    .build();
}

describe.each<ResumeMode>(['same', 'cross'])('KNOWN LIMITATION — %s-executor', (mode) => {
  it('1: a pause inside a LAZY subflow is refused, loudly, at resume()', async () => {
    const chart = flowChart('Init', () => undefined, 'init')
      .addLazySubFlowChartNext('lz', asks, 'Lazy', {
        outputMapper: (sf: Record<string, unknown>) => ({ answer: sf.answer }),
      })
      .build();
    const first = new FlowChartExecutor(chart);
    await first.run();
    const checkpoint = mode === 'cross' ? JSON.parse(JSON.stringify(first.getCheckpoint())) : first.getCheckpoint()!;
    expect(checkpoint.subflowPath).toEqual(['lz']);
    const executor = mode === 'cross' ? new FlowChartExecutor(chart) : first;

    // Healthy: the answer lands. Today: refused — the lazy graph is not in the chart.
    await expect(executor.resume(checkpoint, { n: 1 })).rejects.toThrow(/Cannot resume: stage 'lz\/sf-ask' not found/);
  });

  it('2: a paused selected-branch STAGE resumes in its dispatcher’s context, not in runs/<branch>', async () => {
    const chart = flowChart('Seed', () => undefined, 'seed')
      .addSelectorFunction('Pick', () => ['review'], 'pick')
      .addPausableFunctionBranch('review', 'Review', {
        execute: (s: S) => {
          s.before = true; // written on the run — in the branch's namespace
          return { question: 'q' };
        },
        resume: (s: S) => {
          s.after = true; // written on the resume
        },
      })
      .end()
      .build();

    const run = await drive(chart, mode);

    expect((run.state.runs as Record<string, Record<string, unknown>>).review.before).toBe(true);
    // Healthy: runs.review.after. Today: the dispatcher's keys (as in 9.27.0).
    expect(run.state.after).toBe(true);
  });

  it('3: a resumed fork child that FAILS fails the run (on the run, the fork contained it)', async () => {
    const failing = flowChart('Start', () => undefined, 'sf-start')
      .addPausableFunction(
        'Ask',
        {
          execute: () => ({ question: 'q' }),
          resume: () => {
            throw new Error('the resumed child failed');
          },
        },
        'sf-ask',
      )
      .build();
    const chart = flowChart('Seed', () => undefined, 'seed')
      .addSubFlowChart('fa', failing, 'FA')
      .addFunction(
        'Join',
        (s: S) => {
          s.joined = true;
        },
        'join',
      )
      .build();
    const first = new FlowChartExecutor(chart);
    await first.run();
    const checkpoint = mode === 'cross' ? JSON.parse(JSON.stringify(first.getCheckpoint())) : first.getCheckpoint()!;
    const executor = mode === 'cross' ? new FlowChartExecutor(chart) : first;

    // Healthy: contained, the join runs. Today: the failure reaches the caller.
    await expect(executor.resume(checkpoint, {})).rejects.toThrow('the resumed child failed');
  });
});
