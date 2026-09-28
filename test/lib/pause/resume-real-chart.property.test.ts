/**
 * PROPERTY — pausing changes WHEN an answer arrives, never WHAT the run does.
 *
 * For random loop counts and random pause positions, a run that is paused and
 * resumed at every pause must produce the same trace and the same final state
 * as the same chart run with every answer supplied up front, never pausing.
 * That is the whole contract of pause/resume in one sentence, and it holds
 * only if every resume re-enters ONCE and then walks the real chart (9.27.1).
 *
 * One chart family covers every placement the fix touched:
 *
 *   top:   init → head → sf-body → top-ask → route ─┬─ again (interrupt ×0–2) → loopTo head
 *                                                    └─ final
 *   body:  s-start → sf-deep → s-ask → bind ─┬─ again → loopTo s-ask   (R extra rounds)
 *                                            └─ done
 *   deep:  d-ask → d-post
 *
 *   - `deep`   — a pause TWO subflows deep (s-start must not re-run);
 *   - `inner`  — a pause in a subflow of the loop body, whose own decider
 *                loops BACK TO the paused stage (every visit asks again);
 *   - `top`    — a top-level pause with the loop head upstream of it;
 *   - `branch` — `interrupt()` in the looping branch, once or twice (a re-ask
 *                inside one stage).
 *
 * The answer to a pause is a pure function of its key, so the paused run and
 * the direct run receive the same answers in the same order — if they visit
 * the same pause points in the same order, which is the point.
 *
 * Test type: property (fast-check), both resume modes.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ArrayMergeMode } from '../../../src/advanced.js';
import type { FlowChart } from '../../../src/index.js';
import { flowChart, FlowChartExecutor, interrupt } from '../../../src/index.js';
import { type ResumeMode, type S, drive } from './resume-real-chart-fixture.js';

interface Plan {
  /** Loop iterations at the top level (1–4). */
  n: number;
  /** Iterations whose deep stage (2 subflows down) pauses. */
  deep: number[];
  /** Iterations whose inner stage pauses — on every one of its visits. */
  inner: number[];
  /** Per iteration (index iter-1): extra rounds the inner decider loops back to the inner stage. */
  rounds: number[];
  /** Iterations whose top-level stage pauses. */
  top: number[];
  /** Per iteration (index iter-1): how many interrupt() asks the looping branch makes (0–2). */
  branch: number[];
}

type Mode = 'direct' | 'pause';

const answerFor = (key: string) => `A(${key})`;
const keyOf = (pauseData: unknown) => (pauseData as { key: string }).key;
const log = (s: S) => (s.log as string[] | undefined) ?? (s.prior as string[]);

function buildChart(plan: Plan, mode: Mode): FlowChart {
  // A chart starts with a plain stage; the deep pause is its second.
  const deep = flowChart('DGate', () => undefined, 'd-gate')
    .addPausableFunction(
      'DAsk',
      {
        execute: (s: S) => {
          const key = `d${s.pass}`;
          s.log = [...log(s), key];
          if (!plan.deep.includes(s.pass as number)) return undefined;
          if (mode === 'pause') return { key };
          s.log = [...(s.log as string[]), `${key}=${answerFor(key)}`];
          return undefined;
        },
        resume: (s: S, input: unknown) => {
          s.log = [...(s.log as string[]), `d${s.pass}=${input}`];
        },
      },
      'd-ask',
    )
    .addFunction(
      'DPost',
      (s: S) => {
        s.log = [...(s.log as string[]), `dp${s.pass}`];
      },
      'd-post',
    )
    .build();

  const body = flowChart(
    'SStart',
    (s: S) => {
      s.log = [...log(s), `s${s.pass}`];
      // A mark the deep subflow's merge-back never overwrites: a second run
      // of this stage (the pre-9.27.1 two-deep resume) shows up as a duplicate.
      s.marks = [...((s.marks as string[] | undefined) ?? (s.priorMarks as string[])), `s${s.pass}`];
    },
    's-start',
  )
    .addSubFlowChartNext('sf-deep', deep, 'Deep', {
      inputMapper: (p: Record<string, unknown>) => ({ pass: p.pass, prior: p.log }),
      outputMapper: (sf: Record<string, unknown>) => ({ log: sf.log }),
      arrayMerge: ArrayMergeMode.Replace,
    })
    .addPausableFunction(
      'SAsk',
      {
        execute: (s: S) => {
          const round = (s.rounds as number | undefined) ?? 0;
          const key = `a${s.pass}.${round}`;
          s.log = [...(s.log as string[]), key];
          if (plan.inner.includes(s.pass as number)) {
            if (mode === 'pause') return { key };
            s.log = [...(s.log as string[]), `${key}=${answerFor(key)}`];
          }
          s.rounds = round + 1;
          return undefined;
        },
        resume: (s: S, input: unknown) => {
          const round = (s.rounds as number | undefined) ?? 0;
          s.log = [...(s.log as string[]), `a${s.pass}.${round}=${input}`];
          s.rounds = round + 1;
        },
      },
      's-ask',
    )
    .addDeciderFunction(
      'Bind',
      (s: S) => ((s.rounds as number) <= plan.rounds[(s.pass as number) - 1] ? 'again' : 'done'),
      'bind',
    )
    .addFunctionBranch('again', 'Again', () => undefined, 'bind-again', { loopTo: 's-ask' })
    .addFunctionBranch('done', 'Done', () => undefined, 'bind-done')
    .end()
    .build();

  return flowChart(
    'Init',
    (s: S) => {
      s.iter = 0;
      s.trace = [];
      s.marks = [];
    },
    'init',
  )
    .addFunction(
      'Head',
      (s: S) => {
        s.iter += 1;
        s.trace = [...s.trace, `h${s.iter}`];
      },
      'head',
    )
    .addSubFlowChartNext('sf-body', body, 'Body', {
      inputMapper: (p: Record<string, unknown>) => ({ pass: p.iter, prior: p.trace, priorMarks: p.marks }),
      outputMapper: (sf: Record<string, unknown>) => ({ trace: sf.log, marks: sf.marks }),
      arrayMerge: ArrayMergeMode.Replace,
    })
    .addPausableFunction(
      'TopAsk',
      {
        execute: (s: S) => {
          const key = `t${s.iter}`;
          s.trace = [...s.trace, key];
          if (!plan.top.includes(s.iter)) return undefined;
          if (mode === 'pause') return { key };
          s.trace = [...s.trace, `${key}=${answerFor(key)}`];
          return undefined;
        },
        resume: (s: S, input: unknown) => {
          s.trace = [...s.trace, `t${s.iter}=${input}`];
        },
      },
      'top-ask',
    )
    .addDeciderFunction('Route', (s: S) => (s.iter < plan.n ? 'again' : 'final'), 'route')
    .addFunctionBranch(
      'again',
      'Again',
      (s: S) => {
        // Each ask's answer is kept in state before the next ask: an
        // interrupt() re-entry re-runs this body from the top, and hands the
        // answer to the FIRST interrupt() it reaches.
        const answers: string[] = [];
        for (let k = 1; k <= plan.branch[s.iter - 1]; k++) {
          const key = `b${s.iter}.${k}`;
          const slot = `b${s.iter}_${k}`;
          if (s[slot] === undefined) {
            s[slot] = mode === 'direct' ? answerFor(key) : interrupt<string>(s, { key });
          }
          answers.push(`${key}=${s[slot]}`);
        }
        s.trace = [...s.trace, `g${s.iter}`, ...answers];
      },
      'again',
      { loopTo: 'head' },
    )
    .addFunctionBranch('final', 'Final', (s: S) => {
      s.trace = [...s.trace, 'final'];
    })
    .end()
    .build();
}

/** How many pauses the plan must produce — every planned point, every re-ask. */
function expectedPauses(plan: Plan): number {
  let pauses = 0;
  for (let iter = 1; iter <= plan.n; iter++) {
    if (plan.deep.includes(iter)) pauses += 1;
    if (plan.inner.includes(iter)) pauses += plan.rounds[iter - 1] + 1;
    if (plan.top.includes(iter)) pauses += 1;
    if (iter < plan.n) pauses += plan.branch[iter - 1];
  }
  return pauses;
}

const ITERS = [1, 2, 3, 4];
const planArb: fc.Arbitrary<Plan> = fc.record({
  n: fc.integer({ min: 1, max: 4 }),
  deep: fc.subarray(ITERS),
  inner: fc.subarray(ITERS),
  rounds: fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 4, maxLength: 4 }),
  top: fc.subarray(ITERS),
  branch: fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 4, maxLength: 4 }),
});

async function directRun(plan: Plan) {
  const executor = new FlowChartExecutor(buildChart(plan, 'direct'));
  const result = await executor.run();
  expect((result as { paused?: boolean } | undefined)?.paused).not.toBe(true);
  return executor.getSnapshot().sharedState as Record<string, unknown>;
}

async function pausedRun(plan: Plan, mode: ResumeMode) {
  return drive(buildChart(plan, 'pause'), mode, {
    answer: (_n, checkpoint) => answerFor(keyOf(checkpoint.pauseData)),
    maxPauses: 64,
  });
}

describe('property: a paused-and-resumed run equals the run that never paused', () => {
  it.each<ResumeMode>(['same', 'cross'])('%s-executor resume', async (mode) => {
    await fc.assert(
      fc.asyncProperty(planArb, async (plan) => {
        const direct = await directRun(plan);
        const paused = await pausedRun(plan, mode);

        expect(paused.pauses).toBe(expectedPauses(plan));
        expect(paused.trace).toEqual(direct.trace);
        expect(paused.state).toEqual(direct);
      }),
      { numRuns: 120 },
    );
  });

  it('a hand-picked plan with every placement at once (the regression anchor)', async () => {
    const plan: Plan = { n: 3, deep: [1, 3], inner: [2], rounds: [0, 2, 0, 0], top: [1, 2], branch: [2, 1, 0, 0] };
    const direct = await directRun(plan);
    for (const mode of ['same', 'cross'] as const) {
      const paused = await pausedRun(plan, mode);
      expect(paused.pauses).toBe(expectedPauses(plan)); // 2 deep + 3 inner + 2 top + 3 branch = 10
      expect(paused.pauses).toBe(10);
      expect(paused.trace).toEqual(direct.trace);
      expect(paused.state).toEqual(direct);
      expect(paused.state.marks).toEqual(['s1', 's2', 's3']); // the two-deep resumes re-ran nothing
    }
  });
});
