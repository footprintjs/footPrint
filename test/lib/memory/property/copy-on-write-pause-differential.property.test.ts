/**
 * Copy-on-write commit (9.29.0) — the PAUSE/RESUME differential: a paused
 * and resumed run keeps every byte it kept on 9.28.0.
 *
 * Written by the PR's independent review (2026-10-01) and checked in with it.
 * Programs are in contract: nested object state, a loop (1–3 iterations), a
 * subflow that passes parent objects through its inputMapper and merges
 * objects back, `interrupt` and pausable stages at the top level and inside
 * the subflow, both encodings, a redaction policy, an `initialContext`, and
 * resume on the same executor or a fresh one fed a JSON round-tripped
 * checkpoint. Each program runs paused (every pause answered) and direct
 * (never paused) on the published 9.28.0 and on this tree's `src`:
 *
 *   A. every leg's commit log, live state, fold base, folds at every stop,
 *      subflow results, redacted mirror and every checkpoint — identical;
 *   B. paused-and-resumed final state equals the never-paused run's on the
 *      build exactly when it does on 9.28.0 (the M2 record differs by design
 *      — CLAUDE.md, "A resume re-enters ONCE");
 *   C. no committed generation captured during any leg was edited later.
 *
 * M6 (a `Date` expando kept in live state) is out of this family on purpose:
 * the merge-back never targets a `Date` (`keepOffDates`).
 *
 * THE ADMITTED RECORD (9.30.0) changes the bytes of exactly the commits whose
 * rows did not fold back to what the stage read, 9.28.0's included. So A
 * holds byte for byte unless the WITNESS explains the difference (fixture ·
 * `witnessClause`: across the legs, the first commit at which the logs differ
 * is one where 9.28.0's bundle did not fold back; every commit the build made
 * did), and B is asked only of programs whose runs did not differ.
 *
 * LEG BY LEG (F1b). Each `run` / `resume` is witnessed on its own, and every
 * leg that both engines start from the same checkpoint (`cpN` byte-identical)
 * is judged on its own too (fixture · `witnessLegs`): its first differing
 * commit must be a 9.28.0 bundle that did not fold back, even when an earlier
 * leg already differed — which the run-wide clause, stopping at the first
 * difference of the run, never reads. A leg that starts apart differs because
 * an earlier leg did; only the build's half (every commit folded back) applies
 * to it. The last test below pins the difference: a byte change in a resumed
 * leg is caught leg by leg and missed run-wide. It is a hand-built program on
 * purpose: the generator rarely brings the two states back together after a
 * lie (`COW_DIFF_STATS` → `legs.rejudged`: 0 legs in 500 programs, 2 in 1,000,
 * 6 in 2,000, 15 in 5,000 at the fixed seed), so the property alone would not
 * notice `judge` going back to run-wide.
 *
 * Five hundred programs by default; `COW_DIFF_RUNS=<n>` changes the run
 * count, `COW_DIFF_SEED=<n>` uses seed n+3 (the fourth family after chart /
 * borrowed / nested).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  type ChartOp,
  type Engine,
  type LegTally,
  type Witnessed,
  applyChartOp,
  BASELINE,
  BUILD,
  bytes,
  chartOpArb,
  firstDifference,
  isObj,
  keepOffDates,
  rewriteCommits,
  witnessClause,
  witnessing,
  witnessLegs,
} from './copy-on-write-fixture.js';

type Prog = {
  seed: ChartOp[];
  head: ChartOp[];
  ask: ChartOp[];
  exec: ChartOp[];
  res: ChartOp[];
  fin: ChartOp[];
  sub?: { inner: ChartOp[]; after: ChartOp[]; seedObj: boolean; mergeObj: boolean; arrayReplace: boolean };
  n: number;
  askIters: number[];
  pIters: number[];
  subIters: number[];
  cfg: { commitValues: 'full' | 'delta'; readTracking: 'full' | 'off'; policy: boolean; initial: boolean };
  mode: 'same' | 'cross';
};

const stage = fc.array(chartOpArb, { maxLength: 4 });
const ITERS = [1, 2, 3];
const progArb: fc.Arbitrary<Prog> = fc.record({
  seed: stage,
  head: stage,
  ask: stage,
  exec: stage,
  res: stage,
  fin: stage,
  sub: fc.option(
    fc.record({
      inner: stage,
      after: stage,
      seedObj: fc.boolean(),
      mergeObj: fc.boolean(),
      arrayReplace: fc.boolean(),
    }),
    { nil: undefined },
  ),
  n: fc.integer({ min: 1, max: 3 }),
  askIters: fc.subarray(ITERS),
  pIters: fc.subarray(ITERS),
  subIters: fc.subarray(ITERS),
  cfg: fc.record({
    commitValues: fc.constantFrom('full' as const, 'delta' as const),
    readTracking: fc.constantFrom('full' as const, 'off' as const),
    policy: fc.boolean(),
    initial: fc.boolean(),
  }),
  mode: fc.constantFrom('same' as const, 'cross' as const),
});

const answerFor = (key: string) => ({ key, ok: true, list: [key, { n: key.length }] });

/** Head → [Sub] → Ask (interrupt) → P (pausable) → Route: loop to Head, or Final. */
function buildChart(E: Engine, p: Prog, pause: boolean, errors: string[], capture: () => void) {
  const run = (s: any, ops: ChartOp[]) => {
    for (const o of ops) applyChartOp(s, o, errors);
  };
  let b: any = E.flowChart(
    'Seed',
    (s: any) => {
      capture();
      run(s, p.seed);
    },
    'seed',
  ).addFunction(
    'Head',
    (s: any) => {
      capture();
      s.iter = ((s.iter as number | undefined) ?? 0) + 1;
      run(s, p.head);
    },
    'head',
  );
  if (p.sub) {
    const sub = p.sub;
    const inner = E.flowChart(
      'Inner',
      (s: any) => {
        run(s, sub.inner);
      },
      'inner',
    )
      .addPausableFunction(
        'IAsk',
        {
          execute: (s: any) => {
            const key = `i${s.iter}`;
            if (!p.subIters.includes(s.iter)) return undefined;
            if (pause) return { key };
            s.ians = answerFor(key);
            return undefined;
          },
          resume: (s: any, input: unknown) => {
            s.ians = input;
          },
        },
        'i-ask',
      )
      .addFunction(
        'After',
        (s: any) => {
          run(s, sub.after);
        },
        'after',
      )
      .build();
    b = b.addSubFlowChartNext('sub', inner, 'Sub', {
      inputMapper: (parent: any) =>
        sub.seedObj
          ? { obj: parent.obj ?? { x: 1 }, list: parent.list ?? [1, 2], a: parent.a ?? 'none', iter: parent.iter }
          : { a: parent.a ?? 'none', list: [1], iter: parent.iter },
      outputMapper: (out: any, parent: any) =>
        keepOffDates(
          sub.mergeObj && (parent?.obj === undefined || isObj(parent.obj))
            ? { obj: { y: out.a ?? null, deep: { q: out.ians ?? 1 } }, list: [7], hist: out.list ?? [] }
            : { b: out.obj ?? null, list: [8], ians: out.ians ?? null },
          parent,
        ),
      ...(sub.arrayReplace ? { arrayMerge: 'replace' } : {}),
    });
  }
  b = b
    .addFunction(
      'Ask',
      (s: any) => {
        capture();
        const iter = s.iter as number;
        if (p.askIters.includes(iter)) {
          const key = `q${iter}`;
          s[`ans${iter}`] = pause ? E.interrupt(s, { key }) : answerFor(key);
        }
        run(s, p.ask);
      },
      'ask',
    )
    .addPausableFunction(
      'P',
      {
        execute: (s: any) => {
          capture();
          run(s, p.exec);
          const key = `p${s.iter}`;
          if (!p.pIters.includes(s.iter)) return undefined;
          if (pause) return { key };
          s.pans = answerFor(key);
          run(s, p.res);
          return undefined;
        },
        resume: (s: any, input: unknown) => {
          s.pans = input;
          run(s, p.res);
        },
      },
      'p',
    )
    .addDeciderFunction('Route', (s: any) => ((s.iter as number) < p.n ? 'again' : 'final'), 'route')
    .addFunctionBranch('again', 'Again', () => undefined, 'again', { loopTo: 'head' })
    .addFunctionBranch(
      'final',
      'Final',
      (s: any) => {
        capture();
        run(s, p.fin);
      },
      'final',
    )
    .end();
  return b.build();
}

/**
 * Run a program to the end, answering every pause; the bytes of every leg and
 * checkpoint, and the commits each leg made (`legs[i]`, witnessed alone).
 */
async function drive(E: Engine, p: Prog, pause: boolean) {
  const errors: string[] = [];
  const seen: Array<{ ref: unknown; copy: string }> = [];
  const legs: Witnessed[][] = [];
  const holder: { ex?: any } = {};
  /** One leg — the `run` or a `resume` — witnessed alone; a throw comes back as `error`, so its commits survive it. */
  const inLeg = async (go: () => Promise<any>) => {
    const [outcome, commits] = await witnessing(E, async (): Promise<{ result: any; error?: string }> => {
      try {
        return { result: await go() };
      } catch (e) {
        return { result: undefined, error: (e as Error).message.slice(0, 200) };
      }
    });
    legs.push(commits);
    return outcome;
  };
  const capture = () => {
    const ref = holder.ex?.getSnapshot().sharedState;
    if (ref !== undefined) seen.push({ ref, copy: bytes(ref) });
  };
  const chart = buildChart(E, p, pause, errors, capture);
  const make = () => {
    const ex = new E.FlowChartExecutor(chart, {
      commitValues: p.cfg.commitValues,
      readTracking: p.cfg.readTracking,
      ...(p.cfg.initial ? { initialContext: { a: 'init', obj: { x: 0, nest: { q: [1, 2] } }, hist: [{ n: 1 }] } } : {}),
    });
    if (p.cfg.policy) ex.setRedactionPolicy({ keys: ['b'], fields: { obj: ['y'] } });
    holder.ex = ex;
    return ex;
  };
  let ex = make();
  const out: Record<string, string> = {};
  const first = await inLeg(() => ex.run());
  let result = first.result;
  let runError = first.error ?? '';
  const leg = (i: number) => {
    const snap = ex.getSnapshot();
    out[`leg${i}.log`] = bytes(snap.commitLog);
    out[`leg${i}.state`] = bytes(snap.sharedState);
    out[`leg${i}.init`] = bytes(snap.initialState);
    out[`leg${i}.sub`] = bytes(snap.subflowResults ?? null);
    const folds: string[] = [];
    for (let k = 0; k < snap.commitLog.length; k++) folds.push(bytes(E.stateAt(snap, k).state));
    out[`leg${i}.folds`] = folds.join('\n');
    if (p.cfg.policy) {
      const red = ex.getSnapshot({ redact: true });
      out[`leg${i}.red`] = bytes(red.sharedState);
      out[`leg${i}.redsub`] = bytes(red.subflowResults ?? null);
    }
  };
  leg(0);
  let pauses = 0;
  while (result?.paused === true && pauses < 20) {
    pauses += 1;
    const raw = ex.getCheckpoint();
    out[`cp${pauses}`] = bytes(raw);
    const cp = p.mode === 'cross' ? JSON.parse(JSON.stringify(raw)) : raw;
    if (p.mode === 'cross') ex = make();
    const resumed = await inLeg(() => ex.resume(cp, answerFor((raw.pauseData as { key: string }).key)));
    result = resumed.result;
    if (resumed.error !== undefined) runError += `|resume:${resumed.error}`;
    leg(pauses);
  }
  out.runError = runError;
  out.errors = errors.join(',');
  out.pauses = String(pauses);
  const final = bytes(ex.getSnapshot().sharedState);
  const edited = seen.filter((g) => bytes(g.ref) !== g.copy).length;
  return { out, final, edited, pauses, legs };
}

type Driven = Awaited<ReturnType<typeof drive>>;

const NO_LEGS: LegTally = { legs: 0, explained: 0, rejudged: 0, downstream: 0 };

/**
 * Two runs of one program held to the clause: run-wide first (the first commit
 * at which they differ, and every commit the build made), then leg by leg
 * (header). A leg starts together when both engines' checkpoints for it are
 * byte-identical. `broken` is '' when it holds.
 */
function judge(a: Driven, b: Driven, differs: boolean): { broken: string; tally: LegTally } {
  const wide = witnessClause(a.legs.flat(), b.legs.flat(), differs);
  if (wide) return { broken: wide, tally: NO_LEGS };
  return witnessLegs(a.legs, b.legs, (leg) => leg === 0 || a.out[`cp${leg}`] === b.out[`cp${leg}`]);
}

const RUNS = Number(process.env.COW_DIFF_RUNS ?? 0) || 500;
const SEED = process.env.COW_DIFF_SEED === undefined ? 20261005 : Number(process.env.COW_DIFF_SEED) + 3;

describe('copy-on-write differential — pause and resume, 9.28.0 vs this build', () => {
  it('every leg, checkpoint, fold and mirror identical; paused == direct on the build iff on 9.28.0; no generation edited', async () => {
    const stats = { programs: 0, paused: 0, pauses: 0, explained: 0, legs: { ...NO_LEGS } };
    await fc.assert(
      fc.asyncProperty(progArb, async (p) => {
        const a = await drive(BASELINE, p, true);
        const b = await drive(BUILD, p, true);
        const diff = firstDifference(a.out, b.out);
        const paused = judge(a, b, diff !== '');
        if (paused.broken) throw new Error(`A (paused): ${paused.broken}\n${diff}\nprogram: ${JSON.stringify(p)}`);
        const da = await drive(BASELINE, p, false);
        const db = await drive(BUILD, p, false);
        const dd = firstDifference(da.out, db.out);
        const direct = judge(da, db, dd !== '');
        if (direct.broken) throw new Error(`A (direct): ${direct.broken}\n${dd}\nprogram: ${JSON.stringify(p)}`);
        if (diff || dd) stats.explained += 1;
        else if ((a.final === da.final) !== (b.final === db.final)) {
          throw new Error(
            `B: paused == direct on 9.28.0 ${a.final === da.final}, on the build ${b.final === db.final}\n` +
              `program: ${JSON.stringify(p)}`,
          );
        }
        if (b.edited !== 0 || db.edited !== 0) {
          throw new Error(`C: ${b.edited} / ${db.edited} generation(s) edited\nprogram: ${JSON.stringify(p)}`);
        }
        stats.programs += 1;
        if (b.pauses > 0) stats.paused += 1;
        stats.pauses += b.pauses;
        for (const k of Object.keys(NO_LEGS) as Array<keyof LegTally>) stats.legs[k] += paused.tally[k];
      }),
      { numRuns: RUNS, seed: SEED },
    );
    if (process.env.COW_DIFF_STATS) {
      (await import('node:fs')).writeFileSync(process.env.COW_DIFF_STATS, JSON.stringify({ RUNS, SEED, ...stats }));
    }
    expect(stats.programs).toBe(RUNS);
    expect(stats.paused).toBeGreaterThan(0);
    // At the fixed seed and the default sample, neither half of the clause is vacuous: some programs differ
    // (each explained by the witness, some of them leg by leg) and most are byte-identical.
    if (process.env.COW_DIFF_SEED === undefined && RUNS >= 500) {
      expect(stats.explained).toBeGreaterThan(0);
      expect(stats.legs.explained).toBeGreaterThan(0);
      expect(stats.programs - stats.explained).toBeGreaterThan(stats.programs / 4);
    }
  }, 3_600_000);

  /*
   * Why legs are judged one by one — a program built to show it. Leg 0: the
   * Seed stage merges, hard-writes and merges `obj` (the shape 9.28.0 commits
   * as a lie), then Head writes `obj` whole, so the two engines' checkpoints
   * agree again. Leg 1 (the resume): the Final stage tells the same lie. The
   * build is then made to change bytes that lied about nothing — the last
   * row of every commit, said twice. Run-wide, the first difference is leg 0's
   * lie, 9.28.0's bundle did not fold back, explained: the clause stops there
   * and cannot see leg 1's change. Leg by leg, leg 1 starts together and its
   * first differing commit is a bundle that DID fold back: named.
   */
  describe('a byte change in a resumed leg, after an earlier leg already differed', () => {
    const lie: ChartOp[] = [
      { t: 'update', k: 'obj', v: { x: 1 } },
      { t: 'set', k: 'obj', v: { y: 2 } },
      { t: 'update', k: 'obj', v: { z: 3 } },
    ];
    const program = (mode: Prog['mode']): Prog => ({
      seed: lie,
      head: [{ t: 'set', k: 'obj', v: { q: 9 } }],
      ask: [],
      exec: [],
      res: [],
      fin: lie,
      n: 1,
      askIters: [1],
      pIters: [],
      subIters: [],
      cfg: { commitValues: 'full', readTracking: 'full', policy: false, initial: false },
      mode,
    });
    const sayLastSetTwice = (payload: { trace: Array<{ verb: string }> }) => {
      const last = payload.trace[payload.trace.length - 1];
      if (last?.verb === 'set') payload.trace.push({ ...last });
    };

    it.each(['same', 'cross'] as const)('%s executor: caught leg by leg, not run-wide', async (mode) => {
      const p = program(mode);
      const a = await drive(BASELINE, p, true);
      const honest = await drive(BUILD, p, true);
      expect(honest.pauses).toBe(1);
      // The control: each leg differs where 9.28.0 lied, and leg 1 is judged on its own.
      expect(judge(a, honest, true)).toEqual({
        broken: '',
        tally: { legs: 2, explained: 2, rejudged: 1, downstream: 0 },
      });
      const restore = rewriteCommits(BUILD, sayLastSetTwice);
      let changed: Driven;
      try {
        changed = await drive(BUILD, p, true);
      } finally {
        restore();
      }
      const diff = firstDifference(a.out, changed.out) !== '';
      expect(diff).toBe(true);
      expect(witnessClause(a.legs.flat(), changed.legs.flat(), diff)).toBe('');
      expect(judge(a, changed, diff).broken).toMatch(
        /^leg 1: commit \d+ differs, but 9\.28\.0's bundle there folded back$/,
      );
    });
  });
});
