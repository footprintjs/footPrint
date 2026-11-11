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
 * THE VIEW MARK (foottrace 1.14.0). A `set` row the record's writer built on the stage's view carries
 * `builtOnView: true`, which 9.28.0 cannot write. As in every family, the fixture takes it out of each
 * leg's compared bytes on the build, checked first (fixture · `comparedRecord`,
 * `../../engine/scenario/view-mark-law.ts`). This family passed with the marks left in, as the CHART
 * family did (fixture, above `comparedRecord`), and nothing here asks that the seed reach a mark: the
 * CHART family, which runs the same ops, asks that.
 *
 * Five hundred programs by default; `COW_DIFF_RUNS=<n>` changes the run
 * count, `COW_DIFF_SEED=<n>` uses seed n+3 (the fourth family after chart /
 * borrowed / nested).
 *
 * #124 oracle domain: the historical cross-engine claims above apply only
 * where the native 9.28 run does not return a defined value after an
 * unreestablished same-frame tombstone. Other programs keep BUILD fold-back,
 * native undefined-read and the original valid generation/alias/checkpoint
 * obligations; exclusion counts/lists are pinned from actual fixed-seed runs.
 * A bug confined to excluded programs and escaping those laws/direct witnesses
 * is no longer caught by this differential. Generated operations stay unchanged.
 *
 * A SECOND WAY OUT OF THAT DOMAIN, for a `set` (fixture · `oracleVerdict`). A `set` hides the value
 * below it as a delete does, and 9.28.0 answered a read there from live state all the same
 * (`set list = 's'`, then read `list.y`). No program at the fixed seeds has that shape, so nothing
 * above moves: no count, no list. A fresh seed (`COW_DIFF_SEED`) makes such programs, and the two runs
 * then differ in what the read returned and in nothing the witness can explain. Such a program is
 * taken out of the comparison AFTER it failed, never before, and only when 9.28.0 is seen answering a
 * read its own buffer could not, below a hard write of the same stage. The build's side of the law is
 * asked of every run. The small programs behind it: `scenario/read-under-own-hard-write.test.ts`.
 */
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { StageContext } from '../../../../src/lib/memory/StageContext.js';
import { upcastCheckpoint } from '../../../../src/lib/pause/record.js';
import {
  type Receipt,
  assertBuildDeletedReadsUndefined,
  assertBuildHardWrittenReadsUndefined,
  assertDomainCount,
  oracleDomain,
  staleReadsUnderHardWrite,
} from '../../../helpers/readWitness.js';
import {
  type KeyRule,
  type MapperRead,
  type MountRead,
  retainedInFull,
  treeWithoutMapperReads,
} from '../../engine/scenario/mapper-reads-law.js';
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
  comparedRecord,
  containersOf,
  firstDifference,
  isObj,
  keepOffDates,
  observing,
  r13Seeds,
  rewriteCommits,
  sameUnderLaw,
  witnessClause,
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

/** Told by a mapper, before its body runs, which parent keys the body reads, in order. */
type MapperKeys = (kind: 'in' | 'out', keys: readonly string[]) => void;

/**
 * The mapper-reads law (`engine/scenario/mapper-reads-law.ts`) on this build, derived from the program: what
 * one mapper call leaves on its mount's node. A key the body reads is recorded only when it is a root key
 * of the parent's state at that moment (`live`, the same committed state the mapper is handed); what it
 * keeps is the value (the run keeps full reads: a copy, compared as JSON text), `undefined` for a key
 * holding `undefined`, or what the run's rule leaves of it right then (`ruleOf`). Under
 * `readTracking: 'off'` a read leaves nothing.
 */
function mapperReadsOf(keys: readonly string[], p: Prog, state: Record<string, unknown>, ex: any): MapperRead[] {
  if (p.cfg.readTracking === 'off') return [];
  return keys
    .filter((key) => Object.hasOwn(state, key))
    .map((key) => ({ key, retained: retainedInFull(state[key], ruleOf(p, ex, key)) }));
}

/**
 * What the run's rule says of `key` right now: selected whole (the policy's `b`, or a name a mapper or a
 * copy marked since), or with selected fields (the policy's `obj.y`, or fields a copy carried to a new
 * name). The ONE fact taken from the engine, its own report: the program cannot know what the taint
 * marked. That the report is right is the redaction suites' to check.
 */
function ruleOf(p: Prog, ex: any, key: string): KeyRule {
  if (!p.cfg.policy) return { whole: false };
  const report = ex.getRedactionReport();
  return { whole: key === 'b' || report.redactedKeys.includes(key), fields: report.fieldRedactions[key] };
}

/**
 * One mount execution's reads: later reads join earlier ones. A law key read again keeps its first place
 * and takes what the later read kept; a kept (older) entry is new each time.
 */
function joinReads(into: MountRead[], reads: readonly MountRead[]): void {
  const law = (r: MountRead): r is MapperRead => Object.hasOwn(r, 'key');
  for (const read of reads) {
    const at = law(read) ? into.findIndex((r) => law(r) && r.key === read.key) : -1;
    if (at === -1) into.push(read);
    else into[at] = read;
  }
}

/** Told what the outputMapper returned, as the merge-back will take it. */
type MergedOutput = (mapped: Record<string, unknown>) => void;

/** One root read of a merge-back as it happened: the key, and what the run's rule said of it then. */
type MergeCall = { key: string; rule: KeyRule };

/**
 * Every read a mount makes as its own (`readLiveRoot`: a mapper's read, the list a merge-back appends to;
 * `readOwnView`: the object a merge-back merges into) goes past `probe` while one is set. It is set only
 * between an outputMapper's return and the next mapper call, so it sees the merge-back's own reads. It
 * supplies ONE fact the program cannot: what the run's rule selects at the moment of each read (the
 * outputMapper's taint marks names right after it returns, `MapperTaint · inherit`). The keys and their
 * order are derived from the program and must equal the calls seen.
 */
let probe: ((key: string) => void) | undefined;
const MOUNT_READS = ['readLiveRoot', 'readOwnView'] as const;
const mountRead = Object.fromEntries(MOUNT_READS.map((door) => [door, StageContext.prototype[door]]));
beforeAll(() => {
  for (const door of MOUNT_READS) {
    StageContext.prototype[door] = function (this: StageContext, key: string) {
      probe?.(key);
      return mountRead[door].call(this, key);
    };
  }
});
afterAll(() => {
  for (const door of MOUNT_READS) StageContext.prototype[door] = mountRead[door];
});

/** `SubflowInputMapper`'s rule for a value merged field by field: a plain object, judged without reading a field. */
const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * The mount-reads law's merge-back half, derived from the program: the outputMapper's result `mapped`, the
 * parent's state when the merge-back ran (`state`: committed, so unchanged until the mount commits) and the
 * calls it made. For each key in order: a plain object with a field, or an array unless `arrayReplace`,
 * is a root read (`calls` must name exactly these, in this order); recorded when `state` holds the key,
 * with what the rule left of its value then. A plain object's array
 * and object fields are then read as `key.field` (`appendToArray` / `mergeObject`, older than the law):
 * kept entries, so each law entry's place among them is exact. Called after the merge-back, when the
 * taint has closed: reading a field of a view it handed out records nothing then.
 */
function mergeBackReadsOf(
  p: Prog,
  mapped: Record<string, unknown>,
  state: Record<string, unknown>,
  calls: readonly MergeCall[],
): MountRead[] {
  const reads: MountRead[] = [];
  const expected: string[] = [];
  for (const [key, value] of Object.entries(mapped)) {
    const fields = isPlainRecord(value) ? Object.keys(value) : [];
    if (fields.length === 0 && !(Array.isArray(value) && !p.sub?.arrayReplace)) continue;
    const call = calls[expected.length];
    expected.push(key);
    if (call?.key === key && Object.hasOwn(state, key)) {
      reads.push({ key, retained: retainedInFull(state[key], call.rule) });
    }
    for (const field of fields) {
      const nested = (value as Record<string, unknown>)[field];
      if (Array.isArray(nested) || (typeof nested === 'object' && nested !== null))
        reads.push({ kept: `${key}.${field}` });
    }
  }
  const seen = calls.map((call) => call.key);
  if (seen.join('\u0000') !== expected.join('\u0000')) {
    throw new Error(`mapper-reads law: the merge-back read [${seen}], the program reads [${expected}]`);
  }
  return p.cfg.readTracking === 'off' ? [] : reads;
}

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
  mapperReads?: MapperKeys,
  merged?: MergedOutput,
) {
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
            capture();
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
      // `mapperReads` is told, before each body runs, the parent keys that body reads, in order;
      // `merged`, what the outputMapper returns (the merge-back's reads follow from it).
      inputMapper: (parent: any) => {
        mapperReads?.('in', sub.seedObj ? ['obj', 'list', 'a', 'iter'] : ['a', 'iter']);
        return sub.seedObj
          ? { obj: parent.obj ?? { x: 1 }, list: parent.list ?? [1, 2], a: parent.a ?? 'none', iter: parent.iter }
          : { a: parent.a ?? 'none', list: [1], iter: parent.iter };
      },
      outputMapper: (out: any, parent: any) => {
        mapperReads?.('out', sub.mergeObj ? ['obj'] : []);
        const mapped = keepOffDates(
          sub.mergeObj && (parent?.obj === undefined || isObj(parent.obj))
            ? { obj: { y: out.a ?? null, deep: { q: out.ians ?? 1 } }, list: [7], hist: out.list ?? [] }
            : { b: out.obj ?? null, list: [8], ians: out.ians ?? null },
          live() ?? parent,
        );
        merged?.(mapped);
        return mapped;
      },
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
          capture();
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
  const nativeLegs: Receipt[] = [];
  let pendingStart: string | undefined;
  let startedResumes = 0;
  let startErrors = 0;
  let aliases = 0;
  const holder: { ex?: any } = {};
  /** One leg — the `run` or a `resume` — witnessed alone; a throw comes back as `error`, so its commits survive it. */
  const inLeg = async (go: () => Promise<any>) => {
    const [outcome, commits, native] = await observing(
      E,
      async (): Promise<{ result: any; error?: string }> => {
        try {
          return { result: await go() };
        } catch (e) {
          return { result: undefined, error: (e as Error).message.slice(0, 200) };
        }
      },
      `${pause ? 'paused' : 'direct'}:${legs.length}`,
    );
    nativeLegs.push(native);
    legs.push(commits);
    return outcome;
  };
  const capture = () => {
    const snapshot = holder.ex?.getSnapshot();
    const ref = snapshot?.sharedState;
    if (ref !== undefined) {
      if (pendingStart !== undefined) {
        startedResumes += 1;
        if (bytes(ref) !== pendingStart) startErrors += 1;
        pendingStart = undefined;
      }
      const record = containersOf(snapshot.commitLog);
      if ([...containersOf(ref)].some((value) => record.has(value))) aliases += 1;
      seen.push({ ref, copy: bytes(ref) });
    }
  };
  const liveState = () => holder.ex?.getRuntime().globalStore.getState();
  // The mapper-reads law, this build only: per leg, what each mount execution's mappers read (in order).
  // Its merge-back, if it ran, is derived once the taint has closed (`mergeBackReadsOf`), at `readsOf`.
  type Execution = {
    reads: MountRead[];
    merge?: { mapped: Record<string, unknown>; state: Record<string, unknown>; calls: MergeCall[] };
  };
  const mapperLegs: Execution[][] = [];
  const readsOf = ({ reads, merge }: Execution): MountRead[] => {
    if (merge === undefined) return reads;
    const all = [...reads];
    joinReads(all, mergeBackReadsOf(p, merge.mapped, merge.state, merge.calls));
    return all;
  };
  let executorFirstLeg = 0;
  probe = undefined;
  const mapperReads: MapperKeys | undefined =
    E === BUILD
      ? (kind, keys) => {
          probe = undefined;
          const executions = (mapperLegs[legs.length] ??= []);
          const reads = mapperReadsOf(keys, p, liveState(), holder.ex);
          const current = executions.at(-1);
          if (kind === 'in') executions.push({ reads });
          else if (current === undefined) throw new Error('mapper-reads law: an outputMapper with no inputMapper');
          else joinReads(current.reads, reads);
        }
      : undefined;
  const merged: MergedOutput | undefined =
    E === BUILD
      ? (mapped) => {
          const current = mapperLegs[legs.length]?.at(-1);
          if (current === undefined) throw new Error('mapper-reads law: a merge-back with no mapper');
          const merge = { mapped, state: liveState(), calls: [] as MergeCall[] };
          current.merge = merge;
          probe = (key) => merge.calls.push({ key, rule: ruleOf(p, holder.ex, key) });
        }
      : undefined;
  const chart = buildChart(E, p, pause, errors, capture, liveState, mapperReads, merged);
  const make = () => {
    const ex = new E.FlowChartExecutor(chart, {
      commitValues: p.cfg.commitValues,
      readTracking: p.cfg.readTracking,
      ...(p.cfg.initial ? { initialContext: { a: 'init', obj: { x: 0, nest: { q: [1, 2] } }, hist: [{ n: 1 }] } } : {}),
    });
    if (p.cfg.policy) ex.setRedactionPolicy({ keys: ['b'], fields: { obj: ['y'] } });
    holder.ex = ex;
    executorFirstLeg = legs.length;
    return ex;
  };
  let ex = make();
  const out: Record<string, string> = {};
  const first = await inLeg(() => ex.run());
  let result = first.result;
  let runError = first.error ?? '';
  const leg = (i: number) => {
    const snap = ex.getSnapshot();
    // The view-mark law (header): the build's marks leave what is compared, each checked first.
    out[`leg${i}.log`] = bytes(comparedRecord(E, snap.commitLog));
    out[`leg${i}.state`] = bytes(snap.sharedState);
    out[`leg${i}.init`] = bytes(snap.initialState);
    // R13 (fixture, above `ChartRun`): the baseline's subflow seeds seen named after their mount.
    const results = (r: any) =>
      withoutSubflowLogAddresses(E === BASELINE ? r13Seeds(r, snap.commitLog) : comparedRecord(E, r) ?? null);
    out[`leg${i}.sub`] = bytes(results(snap.subflowResults));
    const folds: string[] = [];
    for (let k = 0; k < snap.commitLog.length; k++) folds.push(bytes(E.stateAt(snap, k).state));
    out[`leg${i}.folds`] = folds.join('\n');
    if (p.cfg.policy) {
      const red = ex.getSnapshot({ redact: true });
      out[`leg${i}.red`] = bytes(red.sharedState);
      out[`leg${i}.redsub`] = bytes(results(red.subflowResults));
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
    out[`cp${pauses}`] = bytes(upcastCheckpoint(raw));
    // The mapper-reads law (above `answerFor`): this build's tree with each mount execution's mapper and merge-back reads
    // asserted and taken out; 9.28.0 recorded none. An executor's tree holds every leg it ran.
    const tree = ex.getSnapshot().executionTree;
    const ran = mapperLegs.slice(executorFirstLeg, pauses).flatMap((executions) => (executions ?? []).map(readsOf));
    out[`cp${pauses}.tree`] = bytes(E === BUILD ? treeWithoutMapperReads(tree, 'sub', ran) : tree);
    const cp = p.mode === 'cross' ? JSON.parse(JSON.stringify(raw)) : raw;
    if (p.mode === 'cross') ex = make();
    pendingStart = E === BUILD ? bytes(cp.sharedState) : undefined;
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
  return { out, final, edited, pauses, legs, nativeLegs, startedResumes, startErrors, aliases };
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
const SEED = process.env.COW_DIFF_SEED === undefined ? 20261005 : Number(process.env.COW_DIFF_SEED) + 3;

describe('copy-on-write differential — pause and resume, 9.28.0 vs this build', () => {
  it('every leg, checkpoint, fold and mirror identical; paused == direct on the build iff on 9.28.0; no generation edited', async () => {
    const stats = { programs: 0, paused: 0, pauses: 0, explained: 0, outOfDomain: 0, legs: { ...NO_LEGS } };
    await fc.assert(
      fc.asyncProperty(progArb, async (p) => {
        const a = await drive(BASELINE, p, true);
        const b = await drive(BUILD, p, true);
        const da = await drive(BASELINE, p, false);
        const db = await drive(BUILD, p, false);
        // These BUILD obligations run before either oracle-domain branch.
        for (const built of [b, db]) {
          for (const native of built.nativeLegs) {
            assertBuildDeletedReadsUndefined(native);
            assertBuildHardWrittenReadsUndefined(native);
          }
          const failure = witnessClause([], built.legs.flat(), false);
          if (failure) throw new Error(failure);
          expect(built.startErrors).toBe(0);
          expect(built.startedResumes).toBe(built.pauses);
          expect(built.aliases).toBe(0);
        }
        // Two ways out of the old engine's domain (fixture · `oracleVerdict`): before the comparison, for a
        // read below a delete; and after a comparison nothing explains, for a read below any hard write.
        const baselineLegs = [...a.nativeLegs, ...da.nativeLegs];
        let excluded = baselineLegs.some((native) => oracleDomain(native).kind === 'out-of-domain');
        let paused = { broken: '', tally: { ...NO_LEGS } };
        if (!excluded) {
          const redacted = p.cfg.policy;
          const diff = firstDifference(a.out, b.out, redacted);
          const pausedVerdict = judge(a, b, diff !== '', redacted);
          const dd = firstDifference(da.out, db.out, redacted);
          // The first thing that does not hold, in the order the three claims are made (header: A, A, B).
          const whatBroke = (): string => {
            if (pausedVerdict.broken) return `A (paused): ${pausedVerdict.broken}\n${diff}`;
            const direct = judge(da, db, dd !== '', redacted);
            if (direct.broken) return `A (direct): ${direct.broken}\n${dd}`;
            if (!diff && !dd && (a.final === da.final) !== (b.final === db.final)) return 'B: paused == direct differs';
            return '';
          };
          const broken = whatBroke();
          if (broken === '') {
            paused = pausedVerdict;
            if (diff || dd) stats.explained += 1;
          } else if (baselineLegs.some((native) => staleReadsUnderHardWrite(native).length > 0)) excluded = true;
          else throw new Error(`${broken}\nprogram: ${JSON.stringify(p)}`);
        }
        if (excluded) stats.outOfDomain += 1;
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
    assertDomainCount('property:pause', stats.programs, stats.outOfDomain, process.env.COW_DIFF_SEED === undefined);
    expect(stats.programs).toBe(RUNS);
    expect(stats.paused).toBeGreaterThan(0);
    // At the fixed seed and the default sample, neither half of the clause is vacuous: some programs differ
    // (each explained by the witness, some of them leg by leg) and most are byte-identical.
    if (process.env.COW_DIFF_SEED === undefined && RUNS >= 500) {
      expect(stats.explained).toBeGreaterThan(0);
      expect(stats.legs.explained).toBeGreaterThan(0);
      expect(stats.programs - stats.outOfDomain - stats.explained).toBeGreaterThan(
        (stats.programs - stats.outOfDomain) / 4,
      );
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
