/**
 * PERFORMANCE and LOAD — what a resume costs, in counted work (9.27.1).
 *
 * Measured in OPERATION COUNTS, not milliseconds (the retry-cost precedent):
 * the honest question is whether a resume adds WORK, and work is countable.
 *
 *   - performance: a run paused and resumed at every pause invokes exactly
 *     the stage functions the never-paused run invokes, PLUS ONE per pause
 *     (the resume half). Nothing else re-runs — before 9.27.1 a pause two
 *     subflows deep re-ran the outer subflow's pre-mount stage every time.
 *   - load: 150 pauses in one run, every one resumed on a fresh executor from
 *     bytes: the run ends exactly as the direct run does, and no resume
 *     structure accumulates — each leg's checkpoint tree stays the size of
 *     one leg, and a same-executor run's subflow results hold one leg.
 *
 * Test type: performance + load.
 */

import { describe, expect, it } from 'vitest';

import { ArrayMergeMode } from '../../../src/advanced.js';
import type { FlowChart } from '../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { type ResumeMode, type S, drive } from './resume-real-chart-fixture.js';

/**
 * top:  init → head → sf-body → route ─┬─ again → loopTo head
 *                                      └─ final
 * body: s-pre → sf-deep → s-post
 * deep: d-pre → d-ask (pauses every pass in 'pause' mode) → d-post
 */
function buildChart(passes: number, mode: 'direct' | 'pause', invocations: { n: number }): FlowChart {
  const count = () => {
    invocations.n += 1;
  };
  const deep = flowChart('DPre', count, 'd-pre')
    .addPausableFunction(
      'DAsk',
      {
        execute: (s: S) => {
          count();
          if (mode === 'pause') return { question: `pass ${s.pass}` };
          s.answer = `A${s.pass}`;
          return undefined;
        },
        resume: (s: S) => {
          count();
          s.answer = `A${s.pass}`;
        },
      },
      'd-ask',
    )
    .addFunction('DPost', count, 'd-post')
    .build();
  const body = flowChart('SPre', count, 's-pre')
    .addSubFlowChartNext('sf-deep', deep, 'Deep', {
      inputMapper: (p: Record<string, unknown>) => ({ pass: p.pass }),
      outputMapper: (sf: Record<string, unknown>) => ({ answer: sf.answer }),
    })
    .addFunction(
      'SPost',
      (s: S) => {
        count();
        s.log = [s.answer as string];
      },
      's-post',
    )
    .build();
  return flowChart(
    'Init',
    (s: S) => {
      count();
      s.iter = 0;
      s.trace = [];
    },
    'init',
  )
    .addFunction(
      'Head',
      (s: S) => {
        count();
        s.iter += 1;
      },
      'head',
    )
    .addSubFlowChartNext('sf-body', body, 'Body', {
      inputMapper: (p: Record<string, unknown>) => ({ pass: p.iter }),
      outputMapper: (sf: Record<string, unknown>) => ({ trace: sf.log }),
      arrayMerge: ArrayMergeMode.Append,
    })
    .addDeciderFunction(
      'Route',
      (s: S) => {
        count();
        return s.iter < passes ? 'again' : 'final';
      },
      'route',
    )
    .addFunctionBranch('again', 'Again', count, 'again', { loopTo: 'head' })
    .addFunctionBranch('final', 'Final', count, 'final')
    .end()
    .build();
}

async function directRun(passes: number) {
  const invocations = { n: 0 };
  const executor = new FlowChartExecutor(buildChart(passes, 'direct', invocations));
  await executor.run();
  return { invocations: invocations.n, state: executor.getSnapshot().sharedState as Record<string, unknown> };
}

/** Nodes in an execution tree (next + children). */
function treeSize(node: unknown): number {
  if (!node || typeof node !== 'object') return 0;
  const n = node as { next?: unknown; children?: unknown[] };
  return 1 + treeSize(n.next) + (n.children ?? []).reduce<number>((sum, c) => sum + treeSize(c), 0);
}

describe('performance: a resume adds exactly one stage invocation per pause', () => {
  it.each<ResumeMode>(['same', 'cross'])('%s-executor, a pause two subflows deep on every pass', async (mode) => {
    const passes = 6;
    const direct = await directRun(passes);
    const invocations = { n: 0 };
    const run = await drive(buildChart(passes, 'pause', invocations), mode, { maxPauses: passes });

    expect(run.pauses).toBe(passes);
    expect(run.state).toEqual(direct.state);
    // Direct: 1 (init) + 8 per pass. Paused: the same, plus one resume half per pause.
    expect(direct.invocations).toBe(1 + 8 * passes);
    expect(invocations.n).toBe(direct.invocations + run.pauses);
  });
});

describe('load: 150 pauses in one run', () => {
  it.each<ResumeMode>(['cross', 'same'])(
    '%s-executor: ends exactly as the direct run, nothing accumulates',
    async (mode) => {
      const passes = 150;
      const direct = await directRun(passes);
      const invocations = { n: 0 };
      const run = await drive(buildChart(passes, 'pause', invocations), mode, { maxPauses: passes });

      expect(run.pauses).toBe(passes);
      expect(run.state).toEqual(direct.state);
      expect((run.state.trace as string[]).length).toBe(passes);
      expect(invocations.n).toBe(direct.invocations + passes);

      if (mode === 'cross') {
        // Each leg's checkpoint tree covers ONE leg — the same size on the
        // 150th pause as on the 2nd; no resume structure piles up.
        const sizes = run.checkpoints.map((c) => treeSize(c.executionTree));
        expect(Math.max(...sizes.slice(1))).toBe(Math.min(...sizes.slice(1)));
      } else {
        // A same-executor run's subflow results are the LAST leg's only: the
        // one re-entered body and the one deep subflow inside it.
        const perExecution = Object.keys(run.legs[run.legs.length - 1].subflowResults ?? {}).filter((k) =>
          k.includes('#'),
        );
        expect(perExecution).toHaveLength(2);
      }
    },
  );
});
