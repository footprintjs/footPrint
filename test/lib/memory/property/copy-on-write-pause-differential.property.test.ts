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

import { upcastCheckpoint } from '../../../../src/lib/pause/record.js';
import { firstCommit124 } from '../../../helpers/firstCommit124.js';
import type { ObservedFamily } from '../../../helpers/observedFamily.js';
import { type PauseFieldCapture, pauseLegViews } from '../../../helpers/pauseLegViews.js';
import { joinedRun } from '../../../helpers/readBindings.js';
import { readLawPorts } from '../../../helpers/readLawPorts.js';
import type { FixtureOperations } from '../../../helpers/readWitness.js';
import { type Decision, formatWitnessDecision } from '../../../helpers/witnessDecision.js';
import { withoutSubflowLogAddresses } from '../../engine/scenario/source-position-byte-view.js';
import {
  type ChartOp,
  type Engine,
  type LegTally,
  type LiveParent,
  type Witnessed,
  applyChartOp,
  BASELINE,
  BUILD,
  bytes,
  chartOpArb,
  firstDifference,
  isObj,
  judgeWitness,
  keepOffDates,
  observing,
  r13Seeds,
  rewriteCommits,
  sameUnderLaw,
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
/** `live`: the parent heap the harness's M6 guard reads — around the mapper's argument (fixture · `LiveParent`). */
function buildChart(
  E: Engine,
  p: Prog,
  pause: boolean,
  errors: string[],
  capture: () => void,
  live: LiveParent,
  getOperations?: () => FixtureOperations | undefined,
  getLeg: () => number = () => 0,
) {
  const invocations = new Map<string, number>();
  const enter = (site: readonly (string | number)[]) => {
    const key = JSON.stringify(site);
    const invocation = invocations.get(key) ?? 0;
    invocations.set(key, invocation + 1);
    return { site, invocation, leg: getLeg() };
  };
  const run = (s: any, ops: ChartOp[], programPath: readonly (string | number)[], entry: ReturnType<typeof enter>) => {
    const operations = getOperations?.();
    for (const [opIndex, o] of ops.entries()) {
      if (operations)
        operations.within(
          {
            coordinate: [
              'pause',
              entry.leg,
              ...entry.site,
              'invocation',
              entry.invocation,
              'program',
              ...programPath,
              'op',
              opIndex,
            ],
            programPath: [...programPath, opIndex],
            path: [],
          },
          () => applyChartOp(s, o, errors),
        );
      else applyChartOp(s, o, errors);
    }
  };
  let b: any = E.flowChart(
    'Seed',
    (s: any) => {
      const entry = enter(['seed']);
      capture();
      run(s, p.seed, ['seed'], entry);
    },
    'seed',
  ).addFunction(
    'Head',
    (s: any) => {
      const entry = enter(['head']);
      capture();
      s.iter = ((s.iter as number | undefined) ?? 0) + 1;
      run(s, p.head, ['head'], entry);
    },
    'head',
  );
  if (p.sub) {
    const sub = p.sub;
    const inner = E.flowChart(
      'Inner',
      (s: any) => {
        const entry = enter(['sub', 'inner']);
        run(s, sub.inner, ['sub', 'inner'], entry);
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
          const entry = enter(['sub', 'after']);
          run(s, sub.after, ['sub', 'after'], entry);
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
          live() ?? parent,
        ),
      ...(sub.arrayReplace ? { arrayMerge: 'replace' } : {}),
    });
  }
  b = b
    .addFunction(
      'Ask',
      (s: any) => {
        const entry = enter(['ask']);
        capture();
        const iter = s.iter as number;
        if (p.askIters.includes(iter)) {
          const key = `q${iter}`;
          s[`ans${iter}`] = pause ? E.interrupt(s, { key }) : answerFor(key);
        }
        run(s, p.ask, ['ask'], entry);
      },
      'ask',
    )
    .addPausableFunction(
      'P',
      {
        execute: (s: any) => {
          const entry = enter(['p', 'execute']);
          capture();
          run(s, p.exec, ['exec'], entry);
          const key = `p${s.iter}`;
          if (!p.pIters.includes(s.iter)) return undefined;
          if (pause) return { key };
          s.pans = answerFor(key);
          run(s, p.res, ['res'], entry);
          return undefined;
        },
        resume: (s: any, input: unknown) => {
          const entry = enter(['p', 'resume']);
          s.pans = input;
          run(s, p.res, ['res'], entry);
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
        const entry = enter(['fin']);
        capture();
        run(s, p.fin, ['fin'], entry);
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
async function drive(E: Engine, p: Prog, pause: boolean, observe = false) {
  const errors: string[] = [];
  const seen: Array<{ ref: unknown; copy: string }> = [];
  const legs: Witnessed[][] = [];
  let currentLeg = 0;
  let activeOperations: FixtureOperations | undefined;
  const observedLegs: ObservedFamily<unknown>[] = [];
  const holder: { ex?: any } = {};
  /** One leg — the `run` or a `resume` — witnessed alone; a throw comes back as `error`, so its commits survive it. */
  const inLeg = async (go: () => Promise<any>) => {
    currentLeg = legs.length;
    const work = async (): Promise<{ result: any; error?: string }> => {
      try {
        return { result: await go() };
      } catch (e) {
        return { result: undefined, error: (e as Error).message.slice(0, 200) };
      }
    };
    let outcome: Awaited<ReturnType<typeof work>>, commits: Witnessed[];
    if (observe) {
      try {
        const observed = await observing(E, p, `pause:${currentLeg}`, (operations) => {
          activeOperations = operations;
          return work();
        });
        observedLegs.push(observed);
        outcome = observed.value;
        commits = [...observed.commits];
      } finally {
        activeOperations = undefined;
      }
    } else [outcome, commits] = await witnessing(E, work);
    legs.push(commits);
    return outcome;
  };
  const capture = () => {
    const ref = holder.ex?.getSnapshot().sharedState;
    if (ref !== undefined) seen.push({ ref, copy: bytes(ref) });
  };
  const chart = buildChart(
    E,
    p,
    pause,
    errors,
    capture,
    () => holder.ex?.getRuntime().globalStore.getState(),
    () => activeOperations,
    () => currentLeg,
  );
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
  const legCaptures: PauseFieldCapture[] = [];
  const put = (owner: number, field: string, value: string) => {
    if (observe) legCaptures.push({ leg: owner, field, value });
    out[field] = value;
  };
  const first = await inLeg(() => ex.run());
  let result = first.result;
  let runError = first.error ?? '';
  const leg = (i: number) => {
    const snap = ex.getSnapshot();
    put(i, `leg${i}.log`, bytes(snap.commitLog));
    put(i, `leg${i}.state`, bytes(snap.sharedState));
    put(i, `leg${i}.init`, bytes(snap.initialState));
    // R13 (fixture, above `ChartRun`): the baseline's subflow seeds seen named after their mount.
    const results = (r: any) => withoutSubflowLogAddresses(E === BASELINE ? r13Seeds(r, snap.commitLog) : r ?? null);
    put(i, `leg${i}.sub`, bytes(results(snap.subflowResults)));
    const folds: string[] = [];
    for (let k = 0; k < snap.commitLog.length; k++) folds.push(bytes(E.stateAt(snap, k).state));
    put(i, `leg${i}.folds`, folds.join('\n'));
    if (p.cfg.policy) {
      const red = ex.getSnapshot({ redact: true });
      put(i, `leg${i}.red`, bytes(red.sharedState));
      put(i, `leg${i}.redsub`, bytes(results(red.subflowResults)));
    }
  };
  leg(0);
  let pauses = 0;
  while (result?.paused === true && pauses < 20) {
    pauses += 1;
    const raw = ex.getCheckpoint();
    // L1 — the lean checkpoint (format 2): a checkpoint is compared as the ONE
    // codec reads it — `upcastCheckpoint` drops 9.28.0's `executionTree` and
    // `subflowResults`, records no resume read. No byte leaves the
    // differential: the tree they carried is the paused leg's own, compared
    // here from its snapshot, and the subflow results are (`leg${i}.sub`).
    put(pauses - 1, `cp${pauses}`, bytes(upcastCheckpoint(raw)));
    put(pauses - 1, `cp${pauses}.tree`, bytes(ex.getSnapshot().executionTree));
    const cp = p.mode === 'cross' ? JSON.parse(JSON.stringify(raw)) : raw;
    if (p.mode === 'cross') ex = make();
    const resumed = await inLeg(() => ex.resume(cp, answerFor((raw.pauseData as { key: string }).key)));
    result = resumed.result;
    if (resumed.error !== undefined) runError += `|resume:${resumed.error}`;
    leg(pauses);
  }
  put(legs.length - 1, 'runError', runError);
  put(legs.length - 1, 'errors', errors.join(','));
  put(legs.length - 1, 'pauses', String(pauses));
  const final = bytes(ex.getSnapshot().sharedState);
  const edited = seen.filter((g) => bytes(g.ref) !== g.copy).length;
  return { out, final, edited, pauses, legs, observedLegs, legCaptures };
}

type Driven = Awaited<ReturnType<typeof drive>>;

const NO_LEGS: LegTally = { legs: 0, explained: 0, rejudged: 0, downstream: 0 };

/**
 * Two runs of one program held to the clause: run-wide first (the first commit
 * at which they differ, and every commit the build made), then leg by leg
 * (header). A leg starts together when both engines' checkpoints for it are
 * byte-identical. `broken` is '' when it holds.
 */
function judge(a: Driven, b: Driven, differs: boolean, redacted: boolean): { broken: string; tally: LegTally } {
  const wide = witnessClause(a.legs.flat(), b.legs.flat(), differs, redacted);
  if (wide) return { broken: wide, tally: NO_LEGS };
  const alike = (x: string | undefined, y: string | undefined) =>
    x === y || (redacted && x !== undefined && y !== undefined && sameUnderLaw(x, y));
  return witnessLegs(a.legs, b.legs, (leg) => leg === 0 || alike(a.out[`cp${leg}`], b.out[`cp${leg}`]), redacted);
}

const RUNS = Number(process.env.COW_DIFF_RUNS ?? 0) || 500;

type LegCause = { readonly leg: number; readonly decision: Extract<Decision, { kind: 'cause' }> };
/** Actual observed route only; the default drive and old judge remain the legacy controls above. */
function judgeObserved(
  a: Driven,
  b: Driven,
  redacted = false,
): { broken: string; tally: LegTally; causes: LegCause[] } {
  // Complete physical output coverage is checked BEFORE ANY admission port is created or called.
  const left = pauseLegViews(a.out, a.legCaptures, a.legs.length, redacted);
  const right = pauseLegViews(b.out, b.legCaptures, b.legs.length, redacted);
  const applied = a.observedLegs[0]?.program;
  for (const run of [a, b]) {
    if (run.observedLegs.length !== run.legs.length || applied === undefined)
      throw new Error('Missing actual per-leg native observation.');
    for (const [i, observed] of run.observedLegs.entries()) {
      if (
        observed.program !== applied ||
        observed.native.leg !== `pause:${i}` ||
        observed.native.issues.length ||
        observed.native.events.some((event) => event.leg !== `pause:${i}`) ||
        observed.commits.length !== run.legs[i].length ||
        observed.commits.some((row, k) => row !== run.legs[i][k])
      )
        throw new Error('Actual leg/program/commit ownership is not exact.');
    }
  }
  const tally: LegTally = { ...NO_LEGS };
  const causes: LegCause[] = [];
  // Every actual BUILD leg is unconditional, even a later leg whose starting checkpoint differs.
  for (const [i, commits] of b.legs.entries()) {
    const broken = formatWitnessDecision(judgeWitness([], commits, false, redacted));
    if (broken) return { broken: `leg ${i}: ${broken}`, tally, causes };
  }
  const alike = (x: string | undefined, y: string | undefined) =>
    x === y || (redacted && x !== undefined && y !== undefined && sameUnderLaw(x, y));
  let earlierDiffered = false;
  for (let i = 0; i < Math.max(a.legs.length, b.legs.length); i++) {
    // Exactly the existing actual checkpoint comparison, with no projected or upcast rewrite here.
    const together = i === 0 || alike(a.out[`cp${i}`], b.out[`cp${i}`]);
    if (!together) {
      tally.legs += 1;
      tally.downstream += 1;
      earlierDiffered = true;
      continue; // BUILD half already checked. No read proof crosses this starting-state boundary.
    }
    if (!left[i] || !right[i] || !a.observedLegs[i] || !b.observedLegs[i])
      return { broken: `leg ${i}: missing paired actual same-start leg`, tally, causes };
    const baseline = joinedRun(a.observedLegs[i], left[i].kept);
    const build = joinedRun(b.observedLegs[i], right[i].kept);
    const diff = firstDifference(left[i].kept, right[i].kept, redacted);
    // Pause callbacks execute the unchanged applyChartOp body: their native family is Chart.
    const decision = judgeWitness(
      a.legs[i],
      b.legs[i],
      diff !== '',
      redacted,
      readLawPorts(baseline, build, 'chart', firstCommit124),
    );
    const broken = formatWitnessDecision(decision);
    if (broken)
      return {
        broken: `leg ${i}: ${broken}${decision.kind === 'broken' && decision.detail ? `: ${decision.detail}` : ''}`,
        tally,
        causes,
      };
    tally.legs += 1;
    if (decision.kind === 'cause') causes.push({ leg: i, decision });
    if (diff) {
      tally.explained += 1;
      if (earlierDiffered) tally.rejudged += 1;
    }
    earlierDiffered ||= diff !== '';
  }
  return { broken: '', tally, causes };
}
const SEED = process.env.COW_DIFF_SEED === undefined ? 20261005 : Number(process.env.COW_DIFF_SEED) + 3;

describe('copy-on-write differential — pause and resume, 9.28.0 vs this build', () => {
  it.each([true, false])(
    'retains the exact current readAll/loop counterexample on the existing driver (paused=%s)',
    async (pause) => {
      const label = 'next-pause-readAll-loop';
      const p: Prog = {
        seed: [],
        head: [],
        ask: [{ t: 'del', k: 'obj' }, { t: 'readAll' }],
        exec: [],
        res: [],
        fin: [],
        sub: { inner: [], after: [], seedObj: false, mergeObj: true, arrayReplace: false },
        n: 2,
        askIters: [],
        pIters: [1, 2],
        subIters: [],
        cfg: { commitValues: 'full', readTracking: 'full', policy: false, initial: false },
        mode: 'same',
      };
      const a = await drive(BASELINE, p, pause, true);
      const b = await drive(BUILD, p, pause, true);
      const left = pauseLegViews(a.out, a.legCaptures, a.legs.length, p.cfg.policy);
      const right = pauseLegViews(b.out, b.legCaptures, b.legs.length, p.cfg.policy);
      for (const [side, driven, views] of [
        ['baseline', a, left],
        ['build', b, right],
      ] as const) {
        expect(driven.observedLegs.length).toBe(driven.legs.length);
        expect(driven.out.pauses).toBe(String(driven.pauses));
        const raw = JSON.stringify({
          label,
          pause,
          side,
          actualPauses: driven.pauses,
          legCount: driven.legs.length,
          kept: driven.out,
          captures: driven.legCaptures,
          final: driven.final,
          editedGenerations: driven.edited,
        });
        if (new TextEncoder().encode(raw).byteLength > 1_048_576)
          throw new Error('Next pause raw-kept intake exceeds its explicit bound.');
        console.log(`FP124-PAUSE-RAW-INTAKE ${raw}`);
        for (const [leg, observed] of driven.observedLegs.entries()) {
          const run = joinedRun(observed, views[leg].kept);
          expect(run.program).toBe(JSON.stringify(p));
          expect(run.native.issues).toEqual([]);
          if (side === 'build') expect(run.commits.every((commit) => commit.foldsBack)).toBe(true);
          const data = JSON.stringify({
            label,
            pause,
            side,
            leg,
            actualPauses: driven.pauses,
            legCount: driven.legs.length,
            observed: run,
          });
          if (new TextEncoder().encode(data).byteLength > 1_048_576)
            throw new Error('Next pause native intake exceeds its explicit per-leg bound.');
          console.log(`FP124-PAUSE-NATIVE-INTAKE ${data}`);
        }
      }
      for (let leg = 0; leg < Math.max(a.legs.length, b.legs.length); leg++) {
        const checkpointPresence = {
          baseline: Object.hasOwn(a.out, `cp${leg}`),
          build: Object.hasOwn(b.out, `cp${leg}`),
        };
        const sameStart =
          leg === 0 ||
          (checkpointPresence.baseline && checkpointPresence.build && a.out[`cp${leg}`] === b.out[`cp${leg}`]);
        const paired =
          a.observedLegs[leg] !== undefined &&
          b.observedLegs[leg] !== undefined &&
          left[leg] !== undefined &&
          right[leg] !== undefined;
        const pair = paired
          ? {
              baseline: joinedRun(a.observedLegs[leg], left[leg].kept),
              build: joinedRun(b.observedLegs[leg], right[leg].kept),
            }
          : undefined;
        const first = pair
          ? pair.baseline.commits.findIndex((row, i) => row.bytes !== pair.build.commits[i]?.bytes)
          : undefined;
        const diff = pair ? firstDifference(pair.baseline.kept, pair.build.kept, p.cfg.policy) : undefined;
        // The SAME existing owner proof is requested only for an actual paired same-start leg.
        const ports = sameStart && pair ? readLawPorts(pair.baseline, pair.build, 'chart', firstCommit124) : undefined;
        const data = JSON.stringify({
          label,
          pause,
          leg,
          checkpointPresence,
          sameStart,
          paired,
          first,
          diff,
          actualPauses: { baseline: a.pauses, build: b.pauses },
          retained: ports?.retainedReadCause?.(),
          firstCause: first !== undefined && first >= 0 ? ports?.firstReadCause?.(first) : undefined,
          decision:
            ports && pair ? judgeWitness(a.legs[leg], b.legs[leg], diff !== '', p.cfg.policy, ports) : undefined,
          notJudged: !paired
            ? 'missing actual paired leg'
            : !sameStart
            ? 'actual starting checkpoint missing or unequal'
            : undefined,
        });
        if (new TextEncoder().encode(data).byteLength > 1_048_576)
          throw new Error('Next pause retained/decision intake exceeds its explicit per-leg bound.');
        console.log(`FP124-PAUSE-LEG-INTAKE ${data}`);
      }
      const decision = JSON.stringify({
        label,
        pause,
        actualPauses: { baseline: a.pauses, build: b.pauses },
        legCounts: { baseline: a.legs.length, build: b.legs.length },
        decision: judgeObserved(a, b, p.cfg.policy),
      });
      if (new TextEncoder().encode(decision).byteLength > 262_144)
        throw new Error('Next pause decision intake exceeds its explicit bound.');
      console.log(`FP124-PAUSE-DECISION-INTAKE ${decision}`);
      // Diagnostic only: no admission assertion, mutation of output or generative-test change.
    },
  );

  it.each([true, false])(
    'retains the exact refused nested-batch program on the existing driver (paused=%s)',
    async (pause) => {
      const p: Prog = {
        seed: [],
        head: [],
        ask: [],
        exec: [],
        res: [],
        fin: [],
        sub: {
          inner: [{ t: 'batch', k: 'b', v: [] }],
          after: [
            { t: 'del', k: 'b' },
            { t: 'batch', k: 'b', v: null },
          ],
          seedObj: false,
          mergeObj: false,
          arrayReplace: false,
        },
        n: 1,
        askIters: [],
        pIters: [],
        subIters: [],
        cfg: { commitValues: 'full', readTracking: 'full', policy: false, initial: false },
        mode: 'same',
      };
      const a = await drive(BASELINE, p, pause, true);
      const b = await drive(BUILD, p, pause, true);
      const left = pauseLegViews(a.out, a.legCaptures, a.legs.length, false);
      const right = pauseLegViews(b.out, b.legCaptures, b.legs.length, false);
      expect(a.observedLegs.length).toBe(a.legs.length);
      expect(b.observedLegs.length).toBe(b.legs.length);
      for (const [side, driven, views] of [
        ['baseline', a, left],
        ['build', b, right],
      ] as const) {
        for (const [leg, observed] of driven.observedLegs.entries()) {
          const run = joinedRun(observed, views[leg].kept);
          expect(run.native.issues).toEqual([]);
          if (side === 'build') expect(run.commits.every((commit) => commit.foldsBack)).toBe(true);
          const data = JSON.stringify({ label: 'exact-paused-nested-batch', pause, side, leg, observed: run });
          if (new TextEncoder().encode(data).byteLength > 1_048_576)
            throw new Error('Exact pause native intake exceeds its explicit per-leg bound.');
          console.log(`FP124-PAUSE-NATIVE-INTAKE ${data}`);
        }
      }
      const data = JSON.stringify({ pause, decision: judgeObserved(a, b, false) });
      if (new TextEncoder().encode(data).byteLength > 262_144) throw new Error('Pause decision intake exceeds bound.');
      console.log(`FP124-PAUSE-DECISION-INTAKE ${data}`);
      // Data only: the original generative differential above remains gating and unchanged.
    },
  );

  it('every leg, checkpoint, fold and mirror identical; paused == direct on the build iff on 9.28.0; no generation edited', async () => {
    const stats = { programs: 0, paused: 0, pauses: 0, explained: 0, legs: { ...NO_LEGS }, causes: [] as LegCause[] };
    await fc.assert(
      fc.asyncProperty(progArb, async (p) => {
        const a = await drive(BASELINE, p, true, true);
        const b = await drive(BUILD, p, true, true);
        // Under a policy the restored redaction law may serve MORE placeholders than 9.28.0 (fixture · `sameUnderLaw`).
        const redacted = p.cfg.policy;
        const diff = firstDifference(a.out, b.out, redacted);
        const paused = judgeObserved(a, b, redacted);
        if (paused.broken) throw new Error(`A (paused): ${paused.broken}\n${diff}\nprogram: ${JSON.stringify(p)}`);
        const da = await drive(BASELINE, p, false, true);
        const db = await drive(BUILD, p, false, true);
        const dd = firstDifference(da.out, db.out, redacted);
        const direct = judgeObserved(da, db, redacted);
        stats.causes.push(...paused.causes, ...direct.causes);
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
    console.info(
      'COW_PAUSE_WITNESS_CAUSES ' + JSON.stringify({ count: stats.causes.length, samples: stats.causes.slice(0, 16) }),
    );
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

  describe('native observation preserves each actual pause leg', () => {
    for (const E of [BASELINE, BUILD])
      for (const mode of ['same', 'cross'] as const)
        for (const commitValues of ['full', 'delta'] as const) {
          it(`${E.label}/${mode}/${commitValues}: exact kept bytes and separate run/resume receipts`, async () => {
            const p: Prog = {
              seed: [{ t: 'set', k: 'obj', v: { x: 1 } }],
              head: [{ t: 'readAll' }],
              ask: [
                { t: 'del', k: 'obj' },
                { t: 'read', k: 'obj' },
              ],
              exec: [{ t: 'same', k: 'list' }],
              res: [{ t: 'set', k: 'obj', v: { n: 2 } }],
              fin: [{ t: 'readAll' }],
              n: 2,
              askIters: [1],
              pIters: [2],
              subIters: [1],
              sub: {
                inner: [{ t: 'readAll' }],
                after: [{ t: 'readAll' }],
                seedObj: true,
                mergeObj: true,
                arrayReplace: false,
              },
              cfg: { commitValues, readTracking: 'full', policy: false, initial: true },
              mode,
            };
            const before = JSON.stringify(p);
            const ordinary = await drive(E, p, true);
            const observed = await drive(E, p, true, true);
            expect(observed.out).toEqual(ordinary.out);
            expect(observed.final).toBe(ordinary.final);
            expect(observed.edited).toBe(ordinary.edited);
            expect(observed.pauses).toBe(ordinary.pauses);
            expect(observed.pauses).toBeGreaterThan(0);
            expect(observed.legs.map((leg) => leg.map(({ nativeId: _id, ...row }) => row))).toEqual(ordinary.legs);
            expect(observed.observedLegs).toHaveLength(observed.legs.length);
            for (const [i, leg] of observed.observedLegs.entries()) {
              expect(leg.program).toBe(before);
              expect(leg.native.leg).toBe(`pause:${i}`);
              expect(leg.native.issues).toEqual([]);
              expect(leg.native.events.every((event) => event.leg === `pause:${i}`)).toBe(true);
              expect(leg.commits.every((row) => row.nativeId !== undefined)).toBe(true);
              expect(leg.operations.every((span) => span.coordinate[1] === i)).toBe(true);
            }
            expect(JSON.stringify(p)).toBe(before);
          });
        }
  });

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
      // Additive actual-observed route: preserve every old assertion above and re-run both actual legs.
      const observedA = await drive(BASELINE, p, true, true);
      const observedHonest = await drive(BUILD, p, true, true);
      expect(judgeObserved(observedA, observedHonest).broken).toBe('');
      const restoreObserved = rewriteCommits(BUILD, sayLastSetTwice);
      let observedChanged: Driven;
      try {
        observedChanged = await drive(BUILD, p, true, true);
      } finally {
        restoreObserved();
      }
      expect(judgeObserved(observedA, observedChanged).broken).toMatch(
        /^leg 1: commit \d+ differs, but 9\.28\.0's bundle there folded back/,
      );
    });
  });
  describe('native-bound retained-only difference stays inside its actual ended leg', () => {
    // Exact actual cc73 shrunk input supplied by root from Node24 job127207965776; Node22 reported the same input.
    const p: Prog = {
      seed: [],
      head: [],
      ask: [
        { t: 'del', k: 'b' },
        { t: 'elem', k: 'b', i: 0, p: 'x', v: false },
      ],
      exec: [],
      res: [],
      fin: [],
      sub: { inner: [], after: [], seedObj: false, mergeObj: false, arrayReplace: false },
      n: 2,
      askIters: [],
      pIters: [],
      subIters: [2],
      cfg: { commitValues: 'full', readTracking: 'full', policy: false, initial: false },
      mode: 'same',
    };

    it('proves only the cp1.tree retained read with its actual leg0 coordinate, with all commit bytes unchanged', async () => {
      const a = await drive(BASELINE, p, true, true);
      const b = await drive(BUILD, p, true, true);
      expect(a.legs.map((leg) => leg.map(({ bytes }) => bytes))).toEqual(
        b.legs.map((leg) => leg.map(({ bytes }) => bytes)),
      );
      expect(Object.keys(a.out).filter((field) => a.out[field] !== b.out[field])).toEqual(['cp1.tree']);
      const judged = judgeObserved(a, b);
      expect(judged.broken).toBe('');
      const retained = judged.causes.filter(({ decision }) => decision.name === 'read-after-delete-124');
      expect(retained).toHaveLength(1);
      expect(retained[0].leg).toBe(0);
      expect(retained[0].decision.shape).toBe('retained-only');
      if (retained[0].decision.shape !== 'retained-only') throw new Error('Expected exact retained-only cause.');
      expect(retained[0].decision.coordinates.length).toBeGreaterThan(0);
      expect(
        retained[0].decision.coordinates.every((coordinate) => coordinate[0] === 'pause' && coordinate[1] === 0),
      ).toBe(true);
    });

    it.each(['errors', 'leg1.state'])(
      'an earlier read-only cause cannot clear independent final-leg %s bytes',
      async (field) => {
        const a = await drive(BASELINE, p, true, true);
        const b = await drive(BUILD, p, true, true);
        expect(judgeObserved(a, b).broken).toBe(''); // Non-vacuous: the earlier actual #124 cause really was admitted.
        expect(a.out.cp1).toBe(b.out.cp1); // The final actual leg starts together and must be judged anew.
        const corrupt = JSON.stringify({ independentCorruption: true });
        // A deliberate liar: BOTH its claimed capture and output carry the corruption, so coverage alone cannot catch it.
        // Actual native receipts remain unchanged; no new read owns this error/live-state value.
        const changed: Driven = {
          ...b,
          out: { ...b.out, [field]: corrupt },
          legCaptures: b.legCaptures.map((capture) =>
            capture.field === field ? { ...capture, value: corrupt } : capture,
          ),
        };
        expect(judgeObserved(a, changed).broken).toMatch(/^leg 1: the runs differ but every commit is byte-identical/);
      },
    );
  });
});
