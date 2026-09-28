/**
 * PROPERTY — pausing changes WHEN an answer arrives, never WHAT the run does.
 *
 * For random loop counts, random pause positions and random PLACEMENTS of
 * every subflow on the pause path, a run that is paused and resumed at every
 * pause must produce the same trace and the same final state as the same
 * chart run with every answer supplied up front, never pausing. That is the
 * whole contract of pause/resume in one sentence, and it holds only if every
 * resume re-enters ONCE and then walks the real chart, and hands control back
 * to each dispatcher's continuation at its own level (9.28.0).
 *
 * One chart family covers every placement the fix touched:
 *
 *   top:   init → head → ⟨sf-body⟩ → top-ask → route ─┬─ again (interrupt ×0–2) → loopTo head
 *                                                      └─ final
 *   body:  s-start → ⟨sf-deep⟩ → s-ask → bind ─┬─ again → loopTo s-ask   (R extra rounds)
 *                                              └─ done
 *   deep:  d-gate → ⟨d-ask⟩ → d-post
 *
 * where each ⟨·⟩ is PLACED, independently at each depth, as:
 *
 *   - `linear`   — on the spine (`addSubFlowChartNext` / `addPausableFunction`);
 *   - `decider`  — a branch of a decider whose `next` is the continuation;
 *   - `selector` — a branch of a selector that also picks a SIDE subflow;
 *   - `fork`     — a fork child beside a SIDE subflow, the continuation its join.
 *
 * (At the deepest level a `selector`/`fork` placement wraps d-ask in its own
 * one-stage subflow: a parallel branch that is a plain STAGE resumes in its
 * dispatcher's namespace — a pinned known limitation, see
 * resume-known-limitations.test.ts.)
 *
 * The pauses:
 *   - `deep`   — a pause TWO (or three) subflows deep (s-start must not re-run);
 *   - `inner`  — a pause in a subflow of the loop body, whose own decider
 *                loops BACK TO the paused stage (every visit asks again);
 *   - `top`    — a top-level pause with the loop head upstream of it;
 *   - `branch` — `interrupt()` in the looping branch, once or twice (a re-ask
 *                inside one stage);
 *   - `side`   — the SIDE subflow of a selector/fork placement asks too: two
 *                parallel siblings paused in one fan-out, asked in turn.
 *
 * The answer to a pause is a pure function of its key, so the paused run and
 * the direct run receive the same answers — if they visit the same pause
 * points, which is the point.
 *
 * Test type: property (fast-check), both resume modes.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ArrayMergeMode } from '../../../src/advanced.js';
import type { FlowChart, SubflowMountOptions } from '../../../src/index.js';
import { flowChart, FlowChartExecutor, interrupt } from '../../../src/index.js';
import { type ResumeMode, type S, drive } from './resume-real-chart-fixture.js';

type Place = 'linear' | 'decider' | 'selector' | 'fork';
const PLACES: Place[] = ['linear', 'decider', 'selector', 'fork'];

interface Plan {
  /** Loop iterations at the top level (1–4). */
  n: number;
  /** Iterations whose deep stage pauses. */
  deep: number[];
  /** Iterations whose inner stage pauses — on every one of its visits. */
  inner: number[];
  /** Per iteration (index iter-1): extra rounds the inner decider loops back to the inner stage. */
  rounds: number[];
  /** Iterations whose top-level stage pauses. */
  top: number[];
  /** Per iteration (index iter-1): how many interrupt() asks the looping branch makes (0–2). */
  branch: number[];
  /** How ⟨sf-body⟩, ⟨sf-deep⟩ and ⟨d-ask⟩ are placed. */
  place: [Place, Place, Place];
  /** Per depth: iterations whose SIDE subflow asks too (only for selector/fork placements). */
  side: [number[], number[], number[]];
}

type Mode = 'direct' | 'pause';

const answerFor = (key: string) => `A(${key})`;
const keyOf = (pauseData: unknown) => (pauseData as { key: string }).key;
const log = (s: S) => (s.log as string[] | undefined) ?? (s.prior as string[]);
const isParallel = (place: Place) => place === 'selector' || place === 'fork';

/** Ask for `key` — or, in the direct run, take the answer up front. */
function ask(s: S, key: string, mode: Mode): string {
  return mode === 'direct' ? answerFor(key) : interrupt<string>(s, { key });
}

/**
 * The SIDE subflow of a parallel placement at `depth`: it records one mark
 * per pass in `sides<depth>` — asking first on the planned passes.
 */
function side(depth: number, plan: Plan, mode: Mode): FlowChart {
  return flowChart(
    'SideAsk',
    (s: S) => {
      const key = `x${depth}.${s.pass}`;
      const value = plan.side[depth].includes(s.pass as number) ? ask(s, key, mode) : '-';
      s.list = [...((s.prior as string[] | undefined) ?? []), `${key}=${value}`];
    },
    'side-ask',
  ).build();
}

function sideOptions(depth: number, passOf: (p: Record<string, unknown>) => unknown): SubflowMountOptions {
  return {
    inputMapper: (p: Record<string, unknown>) => ({ pass: passOf(p), prior: p[`sides${depth}`] }),
    outputMapper: (sf: Record<string, unknown>) => ({ [`sides${depth}`]: sf.list }),
    arrayMerge: ArrayMergeMode.Replace,
  };
}

/**
 * Mount `sub` at the cursor of `b` as `place` says; the builder that comes
 * back continues with whatever runs after it (the spine, or the dispatcher's
 * `next` / the fork's join).
 */
function placeMount(
  b: any, // the builder's fluent type varies by cursor
  place: Place,
  id: string,
  sub: FlowChart,
  options: SubflowMountOptions,
  sideAt: { depth: number; chart: FlowChart; options: SubflowMountOptions },
): any {
  switch (place) {
    case 'linear':
      return b.addSubFlowChartNext(id, sub, id, options);
    case 'decider':
      return b
        .addDeciderFunction(`Via-${id}`, () => id, `via-${id}`)
        .addSubFlowChartBranch(id, sub, id, options)
        .addFunctionBranch(`never-${id}`, `Never-${id}`, () => undefined)
        .end();
    case 'selector':
      return b
        .addSelectorFunction(`Pick-${id}`, () => [id, `side-${sideAt.depth}`], `pick-${id}`)
        .addSubFlowChartBranch(id, sub, id, options)
        .addSubFlowChartBranch(`side-${sideAt.depth}`, sideAt.chart, `Side${sideAt.depth}`, sideAt.options)
        .end();
    case 'fork':
      return b
        .addSubFlowChart(id, sub, id, options)
        .addSubFlowChart(`side-${sideAt.depth}`, sideAt.chart, `Side${sideAt.depth}`, sideAt.options);
  }
}

function buildChart(plan: Plan, mode: Mode): FlowChart {
  const dAskHandler = {
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
  };

  // deep: d-gate → ⟨d-ask⟩ → d-post
  let deepB: any = flowChart('DGate', () => undefined, 'd-gate');
  const [place0, place1, place2] = plan.place;
  if (place2 === 'linear') {
    deepB = deepB.addPausableFunction('DAsk', dAskHandler, 'd-ask');
  } else if (place2 === 'decider') {
    deepB = deepB
      .addDeciderFunction('DVia', () => 'd-ask', 'd-via')
      .addPausableFunctionBranch('d-ask', 'DAsk', dAskHandler)
      .addFunctionBranch('d-never', 'DNever', () => undefined)
      .end();
  } else {
    const dask = flowChart('DAsk', dAskHandler, 'd-ask').build();
    deepB = placeMount(
      deepB,
      place2,
      'sf-dask',
      dask,
      {
        // deep's own log starts as its `prior` (nothing wrote `log` yet at d-gate).
        inputMapper: (p: Record<string, unknown>) => ({ pass: p.pass, prior: p.log ?? p.prior }),
        outputMapper: (sf: Record<string, unknown>) => ({ log: sf.log }),
        arrayMerge: ArrayMergeMode.Replace,
      },
      { depth: 2, chart: side(2, plan, mode), options: sideOptions(2, (p) => p.pass) },
    );
  }
  const deep = deepB
    .addFunction(
      'DPost',
      (s: S) => {
        s.log = [...(s.log as string[]), `dp${s.pass}`];
      },
      'd-post',
    )
    .build();

  // body: s-start → ⟨sf-deep⟩ → s-ask → bind
  let bodyB: any = flowChart(
    'SStart',
    (s: S) => {
      s.log = [...log(s), `s${s.pass}`];
      // A mark the deep subflow's merge-back never overwrites: a second run
      // of this stage (the pre-9.28.0 two-deep resume) shows up as a duplicate.
      s.marks = [...((s.marks as string[] | undefined) ?? (s.priorMarks as string[])), `s${s.pass}`];
    },
    's-start',
  );
  bodyB = placeMount(
    bodyB,
    place1,
    'sf-deep',
    deep,
    {
      inputMapper: (p: Record<string, unknown>) => ({ pass: p.pass, prior: p.log, sides2: p.sides2 }),
      outputMapper: (sf: Record<string, unknown>) => ({ log: sf.log, sides2: sf.sides2 }),
      arrayMerge: ArrayMergeMode.Replace,
    },
    { depth: 1, chart: side(1, plan, mode), options: sideOptions(1, (p) => p.pass) },
  );
  const body = bodyB
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

  // top: init → head → ⟨sf-body⟩ → top-ask → route
  let topB: any = flowChart(
    'Init',
    (s: S) => {
      s.iter = 0;
      s.trace = [];
      s.marks = [];
    },
    'init',
  ).addFunction(
    'Head',
    (s: S) => {
      s.iter += 1;
      s.trace = [...s.trace, `h${s.iter}`];
    },
    'head',
  );
  topB = placeMount(
    topB,
    place0,
    'sf-body',
    body,
    {
      inputMapper: (p: Record<string, unknown>) => ({
        pass: p.iter,
        prior: p.trace,
        priorMarks: p.marks,
        sides1: p.sides1,
        sides2: p.sides2,
      }),
      outputMapper: (sf: Record<string, unknown>) => ({
        trace: sf.log,
        marks: sf.marks,
        sides1: sf.sides1,
        sides2: sf.sides2,
      }),
      arrayMerge: ArrayMergeMode.Replace,
    },
    { depth: 0, chart: side(0, plan, mode), options: sideOptions(0, (p) => p.iter) },
  );
  return topB
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
          if (s[slot] === undefined) s[slot] = ask(s, key, mode);
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

/** How many pauses the plan must produce — every planned point, every re-ask, every asking side. */
function expectedPauses(plan: Plan): number {
  let pauses = 0;
  for (let iter = 1; iter <= plan.n; iter++) {
    if (plan.deep.includes(iter)) pauses += 1;
    if (plan.inner.includes(iter)) pauses += plan.rounds[iter - 1] + 1;
    if (plan.top.includes(iter)) pauses += 1;
    if (iter < plan.n) pauses += plan.branch[iter - 1];
    plan.place.forEach((place, depth) => {
      if (isParallel(place) && plan.side[depth].includes(iter)) pauses += 1;
    });
  }
  return pauses;
}

const ITERS = [1, 2, 3, 4];
const placeArb = fc.constantFrom<Place>(...PLACES);
const planArb: fc.Arbitrary<Plan> = fc.record({
  n: fc.integer({ min: 1, max: 4 }),
  deep: fc.subarray(ITERS),
  inner: fc.subarray(ITERS),
  rounds: fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 4, maxLength: 4 }),
  top: fc.subarray(ITERS),
  branch: fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 4, maxLength: 4 }),
  place: fc.tuple(placeArb, placeArb, placeArb),
  side: fc.tuple(fc.subarray(ITERS), fc.subarray(ITERS), fc.subarray(ITERS)),
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
    maxPauses: 96,
  });
}

const LINEAR: Pick<Plan, 'place' | 'side'> = { place: ['linear', 'linear', 'linear'], side: [[], [], []] };

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
      { numRuns: 160 },
    );
  });

  it('a hand-picked plan with every pause kind at once, all on the spine (the regression anchor)', async () => {
    const plan: Plan = {
      n: 3,
      deep: [1, 3],
      inner: [2],
      rounds: [0, 2, 0, 0],
      top: [1, 2],
      branch: [2, 1, 0, 0],
      ...LINEAR,
    };
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

  it.each(PLACES.filter((p) => p !== 'linear'))(
    'every mount placed as a %s branch/child at EVERY depth, the sides asking too (an anchor per placement)',
    async (place) => {
      const plan: Plan = {
        n: 2,
        deep: [1, 2],
        inner: [1],
        rounds: [1, 0, 0, 0],
        top: [2],
        branch: [1, 0, 0, 0],
        place: [place, place, place],
        side: [[1], [1, 2], [2]],
      };
      const direct = await directRun(plan);
      for (const mode of ['same', 'cross'] as const) {
        const paused = await pausedRun(plan, mode);
        expect(paused.pauses).toBe(expectedPauses(plan));
        expect(paused.trace).toEqual(direct.trace);
        expect(paused.state).toEqual(direct);
        expect(paused.state.marks).toEqual(['s1', 's2']);
        // A parallel placement really had two siblings paused at once.
        const waited = paused.checkpoints.some((c) => (c.pendingPauses?.length ?? 0) > 0);
        expect(waited).toBe(isParallel(place));
      }
    },
  );
});
