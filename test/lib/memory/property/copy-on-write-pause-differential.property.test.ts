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
 * `COW_DIFF_RUNS=<n>` raises the run count; `COW_DIFF_SEED=<n>` uses seed
 * n+3 (the fourth family after chart / borrowed / nested).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  type ChartOp,
  type Engine,
  applyChartOp,
  BASELINE,
  BUILD,
  bytes,
  chartOpArb,
  firstDifference,
  isObj,
  keepOffDates,
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

/** Run a program to the end, answering every pause; the bytes of every leg and checkpoint. */
async function drive(E: Engine, p: Prog, pause: boolean) {
  const errors: string[] = [];
  const seen: Array<{ ref: unknown; copy: string }> = [];
  const holder: { ex?: any } = {};
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
  let runError = '';
  let result: any;
  try {
    result = await ex.run();
  } catch (e) {
    runError = (e as Error).message.slice(0, 200);
  }
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
    try {
      result = await ex.resume(cp, answerFor((raw.pauseData as { key: string }).key));
    } catch (e) {
      runError += `|resume:${(e as Error).message.slice(0, 200)}`;
      result = undefined;
    }
    leg(pauses);
  }
  out.runError = runError;
  out.errors = errors.join(',');
  out.pauses = String(pauses);
  const final = bytes(ex.getSnapshot().sharedState);
  const edited = seen.filter((g) => bytes(g.ref) !== g.copy).length;
  return { out, final, edited, pauses };
}

const RUNS = Number(process.env.COW_DIFF_RUNS ?? 0) || 60;
const SEED = process.env.COW_DIFF_SEED === undefined ? 20261005 : Number(process.env.COW_DIFF_SEED) + 3;

describe('copy-on-write differential — pause and resume, 9.28.0 vs this build', () => {
  it('every leg, checkpoint, fold and mirror identical; paused == direct on the build iff on 9.28.0; no generation edited', async () => {
    const stats = { programs: 0, paused: 0, pauses: 0 };
    await fc.assert(
      fc.asyncProperty(progArb, async (p) => {
        const a = await drive(BASELINE, p, true);
        const b = await drive(BUILD, p, true);
        const diff = firstDifference(a.out, b.out);
        if (diff) throw new Error(`A (paused): ${diff}\nprogram: ${JSON.stringify(p)}`);
        const da = await drive(BASELINE, p, false);
        const db = await drive(BUILD, p, false);
        const dd = firstDifference(da.out, db.out);
        if (dd) throw new Error(`A (direct): ${dd}\nprogram: ${JSON.stringify(p)}`);
        if ((a.final === da.final) !== (b.final === db.final)) {
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
      }),
      { numRuns: RUNS, seed: SEED },
    );
    if (process.env.COW_DIFF_STATS) {
      (await import('node:fs')).writeFileSync(process.env.COW_DIFF_STATS, JSON.stringify({ RUNS, SEED, ...stats }));
    }
    expect(stats.programs).toBe(RUNS);
    expect(stats.paused).toBeGreaterThan(0);
  }, 3_600_000);
});
