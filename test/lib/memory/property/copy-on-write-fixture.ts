/**
 * Copy-on-write commit (9.29.0) — the program model the differential and the
 * reference corpus share (docs/design/2026-10-copy-on-write-commit.md).
 *
 * A PROGRAM is plain data: stages of ops applied identically to two engines
 * — the published 9.28.0 (`footprintjs-baseline`, an npm alias pinned to the
 * last release before copy-on-write) and this tree's `src`. Every value an op
 * writes is built fresh per application (`materialise`), so the two runs
 * never share an object. What a run KEEPS is reduced to strings (`bytes`) and
 * compared field by field.
 *
 * THE BASELINE STAYS 9.28.0, not 9.29.0 (F1b): the alias also serves the
 * copy-on-write pins, whose "before" IS 9.28.0 (11 cases of
 * scenario/copy-on-write-commit.test.ts fail on 9.29.0), and the move would
 * buy these differentials nothing — at 500 programs a family 9.29.0 explains
 * exactly the programs 9.28.0 does, so the copy-on-write exemptions (M3, M6,
 * M8) stay, each named where it applies.
 *
 * Four families:
 *   - CHART programs (`chartProgram`) — in-contract programs through the
 *     typed scope and the engine's nested-path doors (a subflow's plain-object
 *     seed and merge-back), forks, every dial, a redaction policy, an
 *     `initialContext`. No op mutates a borrowed read in place.
 *   - BORROWED programs (`borrowedProgram`) — out of contract on purpose:
 *     after the stage's first write, reads are mutated IN PLACE (the M1/M2
 *     family). Copy-on-write keeps 9.28.0's behaviour for these exactly
 *     (option D — private reads), dev-mode warnings included.
 *   - NESTED programs (`nestedProgram`) — `StageContext` driven directly at
 *     nested and run-namespaced paths (what `/zod`, the subflow doors and
 *     fork children do), reads interleaved with writes, optionally mutating
 *     what a read after the first write returned.
 *   - WRITE-BACK programs (`writeBackProgram`) — NESTED aimed at one law
 *     (B2): a read after the first write that the working copy cannot
 *     answer, edited in place and written back with `set` or `merge`.
 */
import fc from 'fast-check';
import * as baselineCore from 'footprintjs-baseline';
import * as baselineAdvanced from 'footprintjs-baseline/advanced';
import * as baselineTrace from 'footprintjs-baseline/trace';

import * as advanced from '../../../../src/advanced.js';
import * as core from '../../../../src/index.js';
import { runPolicy } from '../../../../src/lib/memory/runPolicy';
import { TransactionBuffer } from '../../../../src/lib/memory/TransactionBuffer';
import * as trace from '../../../../src/trace.js';
import { applySmartMerge } from '../../../../src/trace.js';
import * as write from '../../../../src/write.js';
import { withoutSubflowLogAddresses } from '../../engine/scenario/source-position-byte-view.js';

// ─── Values ──────────────────────────────────────────────────────────────

const PROPS = ['x', 'y', 'n'] as const;

const leaf = fc.oneof(
  fc.integer({ min: -5, max: 50 }),
  fc.constantFrom('s', 'tt', ''),
  fc.boolean(),
  fc.constant(null),
);

/** A JSON-ish value tree; `'__DATE__'` materialises as a `Date`. */
export const valueArb: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  v: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leaf,
    fc.array(tie('v'), { maxLength: 3 }),
    fc.dictionary(fc.constantFrom(...PROPS, 'z'), tie('v'), { maxKeys: 3 }),
    fc.constant('__DATE__'),
  ),
})).v;

/**
 * The same trees without `Date`s — for the NESTED programs, whose writes at a
 * nested path into a `Date` would hang expandos on it: named behaviour M6
 * (9.28.0 dropped them from live state at the next commit), pinned on its own
 * in copy-on-write-commit.test.ts, not a difference this differential hunts.
 */
const jsonValueArb: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  v: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leaf,
    fc.array(tie('v'), { maxLength: 3 }),
    fc.dictionary(fc.constantFrom(...PROPS, 'z', 'deep', 'list'), tie('v'), { maxKeys: 3 }),
  ),
})).v;

/** Build a value FRESH for one application — never shared between engines or ops. */
export function materialise(v: unknown): unknown {
  if (v === '__DATE__') return new Date(1_700_000_000_000);
  if (Array.isArray(v)) return v.map(materialise);
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = materialise(x);
    return o;
  }
  return v;
}

export const isObj = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x) && !(x instanceof Date);

/**
 * Keeps named behaviour M6 out of the generated families: a plain object an
 * `outputMapper` merges back into a `Date` hangs expandos on it, which 9.29.0
 * keeps in live state (9.28.0's next whole-state clone dropped them) — so
 * every later merge, row and fold through that key differs by design. M6 is
 * pinned on its own (copy-on-write-commit.test.ts); here a mapped key whose
 * parent value is a `Date` is renamed (`b` → `b2`) and lands beside it. The
 * first version guarded one key and missed the others (`b`, `hist`): seed
 * 610000 found both.
 */
export function keepOffDates(mapped: Record<string, unknown>, parent: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(mapped)) out[isObj(v) && parent?.[k] instanceof Date ? `${k}2` : k] = v;
  return out;
}

// ─── Bytes ───────────────────────────────────────────────────────────────

const VOLATILE = new Set([
  'timestamp',
  'runId',
  'pipelineId',
  'durationMs',
  'duration',
  'startTime',
  'endTime',
  'pausedAt',
  // F7 (9.37.0) — the one named checkpoint change: the paused execution the resume
  // event links to. 9.28.0 has no such field; pinned in resume-event-link.test.ts.
  'pausedExecution',
  // F8 (9.39.0) — the named record change: a continuation's `phase` on its bundle ('exit' /
  // 'repeat'; 9.28.0 has none), the checkpoint's `checkpointVersion`, and `continuationStageId`
  // (legacy-only — no longer written). Pinned in one-stage-one-record.test.ts and pause/record.test.ts.
  'phase',
  'checkpointVersion',
  'continuationStageId',
  // The restored redaction law — the one named checkpoint addition: the redaction marks a pause
  // carries to the resumed run (names only; 9.28.0 has none). Pinned in redaction-review-52.test.ts.
  'redactionMarks',
]);

/**
 * The bytes a consumer keeps. JSON with the types JSON loses spelled out
 * (`undefined`, `Date`, `Map`, `Set`) and wall-clock / run-id fields dropped.
 * A shared (non-cyclic) reference serialises twice, exactly as JSON does.
 */
export function bytes(v: unknown): string {
  return JSON.stringify(v, function (this: Record<string, unknown>, k, x) {
    if (VOLATILE.has(k)) return undefined;
    if (x === undefined) return '«undefined»';
    const raw = this[k];
    if (raw instanceof Date) return `«date:${raw.getTime()}»`;
    if (x instanceof Map) return { '«map»': [...x] };
    if (x instanceof Set) return { '«set»': [...x] };
    return x;
  });
}

/** Every container reachable from `v` (own enumerable keys, Map/Set members). */
export function containersOf(v: unknown, into = new Set<object>()): Set<object> {
  const stack = [v];
  while (stack.length > 0) {
    const x = stack.pop();
    if (x === null || typeof x !== 'object' || into.has(x)) continue;
    into.add(x);
    if (x instanceof Map) for (const [a, b] of x) stack.push(a, b);
    else if (x instanceof Set) for (const a of x) stack.push(a);
    else for (const key of Object.keys(x)) stack.push((x as Record<string, unknown>)[key]);
  }
  return into;
}

// ─── The engines ─────────────────────────────────────────────────────────

/** The surface both engines expose — the published 9.28.0 and this tree's `src`. */
export interface Engine {
  label: string;
  flowChart: any;
  FlowChartExecutor: any;
  interrupt: any;
  stateAt: any;
  enableDevMode: () => void;
  disableDevMode: () => void;
  SharedMemory: any;
  EventLog: any;
  StageContext: any;
  /** The engine's own buffer class — what the witness watches commit. */
  TransactionBuffer: any;
}

/**
 * `w` is where the record classes come from: `/advanced` on 9.28.0; this tree hands the heap and the
 * log out on `footprintjs/write` (C5) and its buffer on no door, so the build reads it from its module.
 */
function engine(label: string, c: any, a: any, t: any, w: any): Engine {
  return {
    label,
    flowChart: c.flowChart,
    FlowChartExecutor: c.FlowChartExecutor,
    interrupt: c.interrupt,
    stateAt: t.stateAt,
    enableDevMode: c.enableDevMode,
    disableDevMode: c.disableDevMode,
    SharedMemory: w.SharedMemory,
    EventLog: w.EventLog,
    StageContext: a.StageContext,
    TransactionBuffer: w.TransactionBuffer,
  };
}

/** The published 9.28.0 — the last release before copy-on-write. */
export const BASELINE = engine('9.28.0', baselineCore, baselineAdvanced, baselineTrace, baselineAdvanced);
/** This tree's `src`. */
export const BUILD = engine('build', core, advanced, trace, { ...write, TransactionBuffer });

// ─── CHART programs (in contract) ────────────────────────────────────────

const KEYS = ['a', 'b', 'list', 'obj', 'hist'] as const;
type Key = (typeof KEYS)[number];

export type ChartOp =
  | { t: 'set'; k: Key; v: unknown }
  | { t: 'setIn'; k: Key; p: string; v: unknown }
  | { t: 'push'; k: Key; v: unknown }
  | { t: 'elem'; k: Key; i: number; p: string; v: unknown }
  | { t: 'update'; k: Key; v: unknown }
  | { t: 'del'; k: Key }
  | { t: 'same'; k: Key }
  | { t: 'revert'; k: Key; v: unknown }
  | { t: 'batch'; k: Key; v: unknown }
  | { t: 'read'; k: Key }
  | { t: 'readAll' }
  // Identity-sensitive merges: `deepSmartMerge` unions arrays BY REFERENCE,
  // so a merge of values the stage READ is only byte-identical when the
  // buffer's base holds the same objects the 9.28.0 clone held.
  | { t: 'selfMerge'; k: Key }
  | { t: 'mergeFirst'; k: Key }
  | { t: 'copy'; k: Key; k2: Key }
  | { t: 'spread'; k: Key; p: string; v: unknown };

export type ChartProgram = {
  seed: ChartOp[];
  stages: ChartOp[][];
  sub?: { at: number; inner: ChartOp[][]; seedObj: boolean; mergeObj: boolean; arrayReplace: boolean };
  fork?: { at: number; children: ChartOp[][] };
  cfg: {
    commitValues: 'full' | 'delta';
    readTracking: 'full' | 'off';
    writeTracking: 'full' | 'summary' | 'off';
    writeProvenance: 'off' | 'reads-prefix';
    policy: boolean;
    initial: boolean;
  };
};

const key = fc.constantFrom(...KEYS);
const prop = fc.constantFrom(...PROPS);

export const chartOpArb: fc.Arbitrary<ChartOp> = fc.oneof(
  fc.record({ t: fc.constant('set' as const), k: key, v: valueArb }),
  fc.record({ t: fc.constant('setIn' as const), k: key, p: prop, v: valueArb }),
  fc.record({ t: fc.constant('push' as const), k: key, v: valueArb }),
  fc.record({ t: fc.constant('elem' as const), k: key, i: fc.integer({ min: 0, max: 3 }), p: prop, v: valueArb }),
  fc.record({ t: fc.constant('update' as const), k: key, v: valueArb }),
  fc.record({ t: fc.constant('del' as const), k: key }),
  fc.record({ t: fc.constant('same' as const), k: key }),
  fc.record({ t: fc.constant('revert' as const), k: key, v: valueArb }),
  fc.record({ t: fc.constant('batch' as const), k: key, v: valueArb }),
  fc.record({ t: fc.constant('read' as const), k: key }),
  fc.constant({ t: 'readAll' as const }),
  fc.record({ t: fc.constant('selfMerge' as const), k: key }),
  fc.record({ t: fc.constant('mergeFirst' as const), k: key }),
  fc.record({ t: fc.constant('copy' as const), k: key, k2: key }),
  fc.record({ t: fc.constant('spread' as const), k: key, p: prop, v: valueArb }),
);

const chartStage = fc.array(chartOpArb, { minLength: 0, maxLength: 5 });

export const chartProgramArb: fc.Arbitrary<ChartProgram> = fc.record({
  seed: chartStage,
  stages: fc.array(chartStage, { minLength: 1, maxLength: 5 }),
  sub: fc.option(
    fc.record({
      at: fc.integer({ min: 0, max: 4 }),
      inner: fc.array(chartStage, { minLength: 1, maxLength: 3 }),
      seedObj: fc.boolean(),
      mergeObj: fc.boolean(),
      arrayReplace: fc.boolean(),
    }),
    { nil: undefined },
  ),
  fork: fc.option(
    fc.record({ at: fc.integer({ min: 0, max: 4 }), children: fc.array(chartStage, { minLength: 2, maxLength: 3 }) }),
    { nil: undefined },
  ),
  cfg: fc.record({
    commitValues: fc.constantFrom('full' as const, 'delta' as const),
    readTracking: fc.constantFrom('full' as const, 'off' as const),
    writeTracking: fc.constantFrom('full' as const, 'summary' as const, 'off' as const),
    writeProvenance: fc.constantFrom('off' as const, 'reads-prefix' as const),
    policy: fc.boolean(),
    initial: fc.boolean(),
  }),
});

/** Apply one chart op through the typed scope; a throw is recorded, not raised. */
export function applyChartOp(s: any, o: ChartOp, errors: string[]): void {
  try {
    switch (o.t) {
      case 'set':
        s[o.k] = materialise(o.v);
        break;
      case 'setIn': {
        const cur = s.$getValue(o.k);
        if (isObj(cur)) s[o.k][o.p] = materialise(o.v);
        else s[o.k] = { [o.p]: materialise(o.v) };
        break;
      }
      case 'push': {
        const cur = s.$getValue(o.k);
        if (Array.isArray(cur)) s[o.k].push(materialise(o.v));
        else s[o.k] = [materialise(o.v)];
        break;
      }
      case 'elem': {
        const cur = s.$getValue(o.k);
        if (Array.isArray(cur) && isObj(cur[o.i])) s[o.k][o.i][o.p] = materialise(o.v);
        break;
      }
      case 'update':
        s.$update(o.k, materialise(o.v));
        break;
      case 'del':
        delete s[o.k];
        break;
      case 'same':
        s.$setValue(o.k, s.$getValue(o.k));
        break;
      case 'revert': {
        const old = s.$getValue(o.k);
        s[o.k] = materialise(o.v);
        s.$setValue(o.k, old);
        break;
      }
      case 'batch':
        s.$batchArray(o.k, (arr: unknown[]) => {
          arr.push(materialise(o.v));
        });
        break;
      case 'read':
        JSON.stringify(s[o.k] ?? null);
        break;
      case 'readAll':
        for (const k of KEYS) JSON.stringify(s.$getValue(k) ?? null);
        break;
      case 'selfMerge': {
        const cur = s.$getValue(o.k);
        if (cur !== null && typeof cur === 'object' && !(cur instanceof Date)) s.$update(o.k, cur);
        break;
      }
      case 'mergeFirst': {
        const cur = s.$getValue(o.k);
        if (Array.isArray(cur) && cur.length > 0) s.$update(o.k, [cur[0]]);
        else if (isObj(cur)) s.$update(o.k, { y: cur });
        break;
      }
      case 'copy':
        s.$setValue(o.k2, s.$getValue(o.k));
        break;
      case 'spread': {
        const cur = s.$getValue(o.k);
        if (isObj(cur)) s.$setValue(o.k, { ...cur, [o.p]: materialise(o.v) });
        else if (Array.isArray(cur)) s.$setValue(o.k, [...cur, materialise(o.v)]);
        break;
      }
    }
  } catch (e) {
    errors.push(`${o.t}:${(e as Error).name}`);
  }
}

/**
 * The parent state the HARNESS reads inside a mapper — the M6 guard (`keepOffDates`) and the
 * seed's `n` — read from the LIVE heap (`live`), not through the mapper's argument. The
 * restored redaction law (owner ruling (a)) selects a key a mapper writes after it READ a
 * selected value (`memory/redaction.ts · MapperTaint` — conservative: anything it computes
 * then); 9.28.0 has no such rule, so a harness read of the policy's `b` through the argument
 * would make every later key of a policy program differ by design. These differentials judge
 * commit mechanics; the law is pinned on its own (engine/security/redaction-law-table.test.ts).
 * A read around the argument — a closure, as here — is invisible to the taint by definition:
 * it judges what a mapper reads from the records it is HANDED. Without `live` (a caller that
 * judges no differential) the harness reads through the argument.
 */
export type LiveParent = () => Record<string, unknown> | undefined;

/** The chart a program describes, built on `engine`. `capture` runs at the top of every top-level stage. */
function buildChart(engine: Engine, p: ChartProgram, errors: string[], capture?: () => void, live?: LiveParent) {
  const stageFn = (ops: ChartOp[], top: boolean) => (s: any) => {
    if (top) capture?.();
    for (const o of ops) applyChartOp(s, o, errors);
  };
  let b = engine.flowChart('Seed', stageFn(p.seed, true), 'seed');
  p.stages.forEach((ops, i) => {
    if (p.fork && p.fork.at === i) {
      b = b.addListOfFunction(
        p.fork.children.map((c, j) => ({ id: `child-${j}`, name: `Child${j}`, fn: stageFn(c, false) })),
      );
      b = b.addFunction('Join', stageFn([{ t: 'readAll' }], true), 'join');
    }
    if (p.sub && p.sub.at === i) {
      const sub = p.sub;
      let inner = engine.flowChart('Inner0', stageFn(sub.inner[0], false), 'inner-0');
      sub.inner.slice(1).forEach((ops, j) => {
        inner = inner.addFunction(`Inner${j + 1}`, stageFn(ops, false), `inner-${j + 1}`);
      });
      b = b.addSubFlowChart('sub', inner.build(), 'Sub', {
        // Passes the parent's `a` THROUGH (a committed object when `a` holds
        // one) — the D1 path: the mount must not freeze the parent's object.
        inputMapper: (parent: any) =>
          sub.seedObj
            ? { obj: { x: 1, n: (live?.() ?? parent).b ?? 0 }, list: [1, 2], a: parent.a ?? 'none' }
            : { a: parent.a ?? 'none', list: [1] },
        // A plain-object merge-back writes NESTED rows (obj.y, obj.deep).
        // Into a `Date` it would hang expandos on it — named behaviour M6,
        // pinned on its own: never into a `Date` here (`keepOffDates`).
        outputMapper: (out: any, parent: any) =>
          keepOffDates(
            sub.mergeObj && (parent?.obj === undefined || isObj(parent.obj))
              ? { obj: { y: out.a ?? null, deep: { q: 1 } }, list: [7], hist: out.list ?? [] }
              : { b: out.obj ?? null, list: [8] },
            live?.() ?? parent,
          ),
        ...(sub.arrayReplace ? { arrayMerge: 'replace' } : {}),
      });
    }
    b = b.addFunction(`Stage${i}`, stageFn(ops, true), `stage-${i}`);
  });
  return b.build();
}

/**
 * Put a bare frame on `commitValues: 'delta'` — through the run policy on this build (F5),
 * through the per-dial setter the baseline engine still has.
 */
function deltaFrame(ctx: any): void {
  if (typeof ctx.usePolicy === 'function') ctx.usePolicy(runPolicy({ commitValues: 'delta' }));
  else ctx.useCommitValues('delta');
}

/**
 * C-F5 (the run-policy packet): a subflow's seed (`history[0]`) commits under the run's policy,
 * so under `writeProvenance: 'reads-prefix'` its rows carry `readKeys: []` — the baseline, which
 * pushed the dials only after the seed, is seen with that one leaf added (every row, both keys
 * of every mount). Under every other dial the seed bytes are the baseline's.
 */
export function cf5Seeds(results: Record<string, any> | null | undefined, readsPrefix: boolean): any {
  if (!results || !readsPrefix) return results ?? null;
  const out = structuredClone(results);
  for (const key of Object.keys(out)) {
    const seed = out[key]?.treeContext?.history?.[0];
    for (const row of seed?.trace ?? []) if (row.readKeys === undefined) row.readKeys = [];
  }
  return out;
}

// ── R13: the mount names its own acts — the one named change since the baseline ──
//
// A subflow mount's merge-back is committed by the mount's frame and its bundle carries the
// mount's names; a subflow's seed (`history[0]`) carries them too. 9.28.0 (and every release
// through 9.33.0) stamped the merge-back with the frame BEFORE a branch / fork-child mount and
// the seed with the first stage's names and runtimeStageId ''. The differentials compare the
// baseline seen through `r13Log` / `r13Seeds` (its bytes, restamped) and, on both engines,
// what R13 moved from the stage before the mount to the mount left out: the merge-back rows'
// `readKeys` (`withoutMergeBackReadKeys`) and the two nodes' tracked reads and writes
// (`withoutMovedTracking`) — the baseline cannot say which of that stage's tracked keys were
// its own once the merge-back overwrote them.

const stagePartOf = (runtimeStageId: string) => runtimeStageId.slice(0, runtimeStageId.lastIndexOf('#'));

/** A baseline log, its merge-back bundles restamped with their mount (the first bundle of each mount id). */
export function r13Log(log: any[], mountIds: ReadonlySet<string>): any[] {
  const out = structuredClone(log);
  const seen = new Set<string>();
  out.forEach((b: any, i: number) => {
    const first = !seen.has(b.runtimeStageId);
    seen.add(b.runtimeStageId);
    if (!first || i === 0 || !mountIds.has(stagePartOf(b.runtimeStageId))) return;
    const prev = out[i - 1];
    // The old merge-back: the stage before's SECOND bundle, right before the mount's first.
    const repeat = out.slice(0, i - 1).some((x: any) => x.runtimeStageId === prev.runtimeStageId);
    if (!repeat || prev.stageId === b.stageId) return;
    prev.stage = b.stage;
    prev.stageId = b.stageId;
    prev.runtimeStageId = b.runtimeStageId;
  });
  return out;
}

/**
 * A log without the `readKeys` of its merge-back rows (each mount id's first bundle), on both
 * engines: staged on the frame before the mount, they held THAT stage's read prefix; staged on
 * the mount's frame (R13) they hold only the merge-back's own reads.
 */
export function withoutMergeBackReadKeys(log: any[], mountIds: ReadonlySet<string>): any[] {
  const out = structuredClone(log);
  const seen = new Set<string>();
  for (const b of out) {
    if (seen.has(b.runtimeStageId)) continue;
    seen.add(b.runtimeStageId);
    if (!mountIds.has(stagePartOf(b.runtimeStageId))) continue;
    for (const row of b.trace ?? []) delete row.readKeys;
  }
  return out;
}

/** Baseline subflow results, every seed named after its mount (the per-execution key names it). */
export function r13Seeds(results: Record<string, any> | null | undefined, topLog: any[]): any {
  if (!results) return results ?? null;
  const out = structuredClone(results);
  const nameOf = (rsid: string) => topLog.find((b: any) => b.runtimeStageId === rsid)?.stage;
  const keys = Object.keys(out).filter((k) => k.includes('#'));
  for (const key of keys) {
    const seed = out[key]?.treeContext?.history?.[0];
    if (!seed || seed.runtimeStageId !== '') continue;
    seed.stage = nameOf(key) ?? seed.stage;
    seed.stageId = stagePartOf(key);
    seed.runtimeStageId = key;
  }
  // The path key holds the LAST execution's record (structuredClone kept a shared object shared).
  for (const key of Object.keys(out).filter((k) => !k.includes('#'))) {
    const seed = out[key]?.treeContext?.history?.[0];
    const last = keys.filter((k) => stagePartOf(k) === key).pop();
    if (!seed || seed.runtimeStageId !== '' || !last) continue;
    seed.stage = nameOf(last) ?? seed.stage;
    seed.stageId = key;
    seed.runtimeStageId = last;
  }
  return out;
}

/** The execution tree without the tracked reads and writes of a mount and of the node it hangs off. */
export function withoutMovedTracking(tree: any, mountIds: ReadonlySet<string>): any {
  const out = structuredClone(tree);
  const strip = (n: any) => {
    delete n.stageWrites;
    delete n.stageReads;
  };
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return;
    const kids: any[] = Array.isArray(n.children) ? n.children : [];
    if (kids.some((c) => mountIds.has(c?.id))) strip(n);
    if (mountIds.has(n.id)) strip(n);
    kids.forEach(walk);
    walk(n.next);
  };
  walk(out);
  return out;
}

/** The baseline's subflow results seen through both named changes since it: R13, then C-F5. */
function baselineSeeds(results: Record<string, any> | null | undefined, topLog: any[], p: ChartProgram): any {
  return cf5Seeds(r13Seeds(results, topLog), p.cfg.writeProvenance === 'reads-prefix');
}

export type ChartRun = {
  /** Field → bytes; compared across engines. */
  out: Record<string, string>;
  /** Laws checked on ONE engine (copy-on-write's), never compared. */
  laws: { servedSharesLog: string; editedGenerations: number };
};

/** Run a chart program on `engine` and reduce everything it keeps to bytes. */
export async function runChart(engine: Engine, p: ChartProgram): Promise<ChartRun> {
  const errors: string[] = [];
  const seen: Array<{ ref: unknown; copy: string }> = [];
  const holder: { ex?: any } = {};
  const capture = () => {
    const ref = holder.ex?.getSnapshot().sharedState;
    if (ref !== undefined) seen.push({ ref, copy: bytes(ref) });
  };
  const chart = buildChart(engine, p, errors, capture, () => holder.ex?.getRuntime().globalStore.getState());
  const ex = new engine.FlowChartExecutor(chart, {
    commitValues: p.cfg.commitValues,
    readTracking: p.cfg.readTracking,
    writeTracking: p.cfg.writeTracking,
    writeProvenance: p.cfg.writeProvenance,
    ...(p.cfg.initial ? { initialContext: { a: 'init', obj: { x: 0, nest: { q: [1, 2] } }, hist: [{ n: 1 }] } } : {}),
  });
  holder.ex = ex;
  if (p.cfg.policy) ex.setRedactionPolicy({ keys: ['b'], fields: { obj: ['y'] } });
  let runError = '';
  try {
    await ex.run();
  } catch (e) {
    runError = (e as Error).name;
  }
  const snap = ex.getSnapshot();
  // R13 (header above `ChartRun`): the baseline seen restamped, the moved tracking left out on both.
  const mounts = new Set<string>(p.sub ? ['sub'] : []);
  const old = engine === BASELINE;
  const out: Record<string, string> = {
    runError,
    stageErrors: errors.join(','),
    commitLog: bytes(withoutMergeBackReadKeys(old ? r13Log(snap.commitLog, mounts) : snap.commitLog, mounts)),
    sharedState: bytes(snap.sharedState),
    initialState: bytes(snap.initialState),
    executionTree: bytes(p.sub ? withoutMovedTracking(snap.executionTree, mounts) : snap.executionTree),
    subflowResults: bytes(
      withoutSubflowLogAddresses(
        old ? baselineSeeds(snap.subflowResults, snap.commitLog, p) : snap.subflowResults ?? null,
      ),
    ),
  };
  const red = p.cfg.policy ? ex.getSnapshot({ redact: true }) : undefined;
  if (red) {
    out.redactedState = bytes(red.sharedState);
    out.redactedSubflows = bytes(
      withoutSubflowLogAddresses(
        old ? baselineSeeds(red.subflowResults, snap.commitLog, p) : red.subflowResults ?? null,
      ),
    );
  }
  const folds: string[] = [];
  for (let i = 0; i < snap.commitLog.length; i++) folds.push(bytes(engine.stateAt(snap, i).state));
  out.folds = folds.join('\n');
  return {
    out,
    laws: {
      servedSharesLog: servedSharesLog(snap, red),
      editedGenerations: seen.filter((g) => bytes(g.ref) !== g.copy).length,
    },
  };
}

/**
 * D2's law: no container of the record (any bundle's `overwrite` / `updates`,
 * the run's or a subflow's) is reachable from served or live state. Returns
 * the labels of the views that break it ('' when none).
 */
function servedSharesLog(snap: any, red: any): string {
  const log = new Set<object>();
  for (const b of snap.commitLog) {
    containersOf(b.overwrite, log);
    containersOf(b.updates, log);
  }
  for (const sf of Object.values(snap.subflowResults ?? {}) as any[]) {
    for (const b of sf?.treeContext?.history ?? []) {
      containersOf(b.overwrite, log);
      containersOf(b.updates, log);
    }
  }
  const hits: string[] = [];
  const check = (label: string, v: unknown) => {
    for (const c of containersOf(v)) {
      if (log.has(c)) {
        hits.push(label);
        return;
      }
    }
  };
  check('sharedState', snap.sharedState);
  if (red) check('redactedState', red.sharedState);
  for (const [id, sf] of Object.entries(snap.subflowResults ?? {}) as any[]) {
    check(`subflow:${id}`, sf?.treeContext?.globalContext);
  }
  if (red) {
    for (const [id, sf] of Object.entries(red.subflowResults ?? {}) as any[]) {
      check(`redactedSubflow:${id}`, sf?.treeContext?.globalContext);
    }
  }
  return hits.join(',');
}

// ─── BORROWED programs (out of contract: mutate a read after the first write) ─

export type BorrowedOp =
  | { t: 'set'; k: Key; v: unknown }
  | { t: 'push'; k: Key; v: unknown }
  | { t: 'update'; k: Key; v: unknown }
  | { t: 'read'; k: Key }
  /** `$getValue(k)`, then edit it IN PLACE (a field, an element's field, or a push). */
  | { t: 'mutGet'; k: Key; p: string; v: number }
  /** `for (const e of scope[k])` — raw elements — edited in place. */
  | { t: 'mutIter'; k: Key; p: string; v: number }
  /** `mutGet`, then `$setValue(k, sameObject)` (M1). */
  | { t: 'writeBack'; k: Key; p: string; v: number };

export type BorrowedProgram = {
  seed: Array<{ k: Key; v: unknown }>;
  stages: Array<{ first: Key; ops: BorrowedOp[] }>;
  commitValues: 'full' | 'delta';
};

const borrowedOpArb: fc.Arbitrary<BorrowedOp> = fc.oneof(
  fc.record({ t: fc.constant('set' as const), k: key, v: valueArb }),
  fc.record({ t: fc.constant('push' as const), k: key, v: valueArb }),
  fc.record({ t: fc.constant('update' as const), k: key, v: valueArb }),
  fc.record({ t: fc.constant('read' as const), k: key }),
  fc.record({ t: fc.constant('mutGet' as const), k: key, p: prop, v: fc.integer({ min: 0, max: 99 }) }),
  fc.record({ t: fc.constant('mutIter' as const), k: key, p: prop, v: fc.integer({ min: 0, max: 99 }) }),
  fc.record({ t: fc.constant('writeBack' as const), k: key, p: prop, v: fc.integer({ min: 0, max: 99 }) }),
);

export const borrowedProgramArb: fc.Arbitrary<BorrowedProgram> = fc.record({
  seed: fc.array(fc.record({ k: key, v: valueArb }), { minLength: 1, maxLength: 5 }),
  stages: fc.array(fc.record({ first: key, ops: fc.array(borrowedOpArb, { maxLength: 6 }) }), {
    minLength: 1,
    maxLength: 4,
  }),
  commitValues: fc.constantFrom('full' as const, 'delta' as const),
});

/** Edit a borrowed value in place — the out-of-contract act under test. */
function mutateInPlace(x: unknown, p: string, v: number): void {
  if (Array.isArray(x)) {
    if (isObj(x[0])) x[0][p] = v;
    else x.push(v);
  } else if (isObj(x)) {
    const inner = x[p];
    if (isObj(inner)) inner.n = v;
    else x[p] = v;
  }
}

function applyBorrowedOp(s: any, o: BorrowedOp, errors: string[]): void {
  try {
    switch (o.t) {
      case 'set':
        s[o.k] = materialise(o.v);
        break;
      case 'push': {
        const cur = s.$getValue(o.k);
        if (Array.isArray(cur)) s[o.k].push(materialise(o.v));
        else s[o.k] = [materialise(o.v)];
        break;
      }
      case 'update':
        s.$update(o.k, materialise(o.v));
        break;
      case 'read':
        JSON.stringify(s[o.k] ?? null);
        break;
      case 'mutGet':
        mutateInPlace(s.$getValue(o.k), o.p, o.v);
        break;
      case 'mutIter': {
        const cur = s.$getValue(o.k);
        if (Array.isArray(cur)) {
          for (const e of s[o.k]) if (isObj(e)) e[o.p] = o.v;
        }
        break;
      }
      case 'writeBack': {
        const cur = s.$getValue(o.k);
        mutateInPlace(cur, o.p, o.v);
        if (cur !== undefined) s.$setValue(o.k, cur);
        break;
      }
    }
  } catch (e) {
    errors.push(`${o.t}:${(e as Error).name}`);
  }
}

/** Run a borrowed program in dev mode; the borrowed-mutation warnings are part of the bytes. */
export async function runBorrowed(engine: Engine, p: BorrowedProgram): Promise<Record<string, string>> {
  const errors: string[] = [];
  let b = engine.flowChart(
    'Seed',
    (s: any) => {
      for (const { k, v } of p.seed) s[k] = materialise(v);
    },
    'seed',
  );
  p.stages.forEach((st, i) => {
    b = b.addFunction(
      `S${i}`,
      (s: any) => {
        s[`w${i}`] = i; // the stage's FIRST write — every op below runs after it
        for (const o of st.ops) applyBorrowedOp(s, o, errors);
      },
      `s${i}`,
    );
  });
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => {
    warnings.push(String(a[0]));
  };
  engine.enableDevMode();
  const ex = new engine.FlowChartExecutor(b.build(), { commitValues: p.commitValues });
  let runError = '';
  try {
    await ex.run();
  } catch (e) {
    runError = (e as Error).name;
  } finally {
    engine.disableDevMode();
    console.warn = realWarn;
  }
  const snap = ex.getSnapshot();
  const folds: string[] = [];
  for (let i = 0; i < snap.commitLog.length; i++) folds.push(bytes(engine.stateAt(snap, i).state));
  return {
    runError,
    stageErrors: errors.join(','),
    warnings: warnings.join('\n'),
    commitLog: bytes(snap.commitLog),
    sharedState: bytes(snap.sharedState),
    executionTree: bytes(snap.executionTree),
    folds: folds.join('\n'),
  };
}

// ─── NESTED programs (StageContext at nested / namespaced paths) ──────────

const NPATHS: string[][] = [[], ['obj'], ['obj', 'deep'], ['list'], ['obj', 'list']];
const NKEYS = ['x', 'y', 'deep', 'list', '0'] as const;

export type NestedOp =
  | { t: 'set'; path: number; k: string; v: unknown }
  | { t: 'merge'; path: number; k: string; v: unknown }
  | { t: 'del'; path: number; k: string }
  | { t: 'read'; path: number; k: string }
  /** A read after the stage's first write, edited in place (out of contract). */
  | { t: 'mutRead'; path: number; k: string; v: number };

export type NestedProgram = {
  initial: unknown;
  stages: Array<{ runId: '' | 'r1' | 'r2'; ops: NestedOp[] }>;
  commitValues: 'full' | 'delta';
  /** When false, `mutRead` ops are skipped — an in-contract program. */
  mutate: boolean;
};

const npath = fc.integer({ min: 0, max: NPATHS.length - 1 });
const nkey = fc.constantFrom(...NKEYS);
const nestedOpArb: fc.Arbitrary<NestedOp> = fc.oneof(
  fc.record({ t: fc.constant('set' as const), path: npath, k: nkey, v: jsonValueArb }),
  fc.record({ t: fc.constant('merge' as const), path: npath, k: nkey, v: jsonValueArb }),
  fc.record({ t: fc.constant('del' as const), path: npath, k: nkey }),
  fc.record({ t: fc.constant('read' as const), path: npath, k: nkey }),
  fc.record({ t: fc.constant('mutRead' as const), path: npath, k: nkey, v: fc.integer({ min: 0, max: 99 }) }),
);

export const nestedProgramArb: fc.Arbitrary<NestedProgram> = fc.record({
  initial: fc.option(fc.dictionary(fc.constantFrom('obj', 'list', 'x', 'runs'), jsonValueArb, { maxKeys: 3 }), {
    nil: undefined,
  }),
  stages: fc.array(
    fc.record({
      runId: fc.constantFrom('' as const, 'r1' as const, 'r2' as const),
      ops: fc.array(nestedOpArb, { maxLength: 6 }),
    }),
    { minLength: 1, maxLength: 4 },
  ),
  commitValues: fc.constantFrom('full' as const, 'delta' as const),
  mutate: fc.boolean(),
});

/**
 * Does this program write THROUGH a container the same stage `set` earlier
 * (`set obj.deep = {}` then `set obj.deep.x`)? Named behaviour M8: 9.28.0
 * edited the stage's own object in place for that inner write, so the outer
 * key's retained `stageWrites` entry showed it too; copy-on-write copies the
 * object first, and the entry keeps the value as written. Log, state, folds
 * and reads are identical either way — only `snapshots` may differ.
 */
export function writesThroughStagedValue(p: NestedProgram): boolean {
  return p.stages.some((st) => {
    const staged: string[] = [];
    return st.ops.some((o) => {
      if (o.t !== 'set' && o.t !== 'merge' && o.t !== 'del') return false;
      const at = [...NPATHS[o.path], o.k].join('/');
      const through = staged.some((s) => at.startsWith(`${s}/`));
      if (o.t === 'set' && materialise(o.v) !== null && typeof materialise(o.v) === 'object') staged.push(at);
      return through;
    });
  });
}

/**
 * Drive `StageContext` through a nested program; every read's result and
 * every fold are bytes. `laws`, when given, receives the build-only check
 * the bytes cannot see: how many committed generations — each captured just
 * before a commit swapped in the next — were edited by anything after it
 * (THE LAW; a review found that byte comparison alone missed a replay that
 * edited one). Kept out of the compared record: on an out-of-contract
 * program (`mutate`) an in-place edit of a value served from live state
 * reaches committed state on 9.28.0 too.
 */
export function runNested(
  engine: Engine,
  p: NestedProgram,
  laws?: { editedGenerations: number },
): Record<string, string> {
  const mem = new engine.SharedMemory(undefined, materialise(p.initial));
  const log = new engine.EventLog(mem.getState());
  const reads: string[] = [];
  const snaps: string[] = [];
  const errors: string[] = [];
  const generations: Array<{ ref: unknown; copy: string }> = [];
  p.stages.forEach((st, i) => {
    const ctx = new engine.StageContext(st.runId, `S${i}`, `s${i}`, mem, '', log);
    if (p.commitValues === 'delta') deltaFrame(ctx);
    let wrote = false;
    for (const o of st.ops) {
      try {
        const path = NPATHS[o.path];
        if (o.t === 'set') {
          ctx.setObject(path, o.k, materialise(o.v));
          wrote = true;
        } else if (o.t === 'merge') {
          ctx.updateObject(path, o.k, materialise(o.v));
          wrote = true;
        } else if (o.t === 'del') {
          ctx.setObject(path, o.k, undefined, false, undefined, 'delete');
          wrote = true;
        } else if (o.t === 'read') {
          reads.push(bytes(ctx.getValue(path, o.k) ?? null));
        } else if (p.mutate && wrote) {
          const got = ctx.getValue(path, o.k);
          reads.push(bytes(got ?? null));
          mutateInPlace(got, 'x', o.v);
        }
      } catch (e) {
        errors.push(`${o.t}:${(e as Error).name}`);
      }
    }
    if (laws) generations.push({ ref: mem.getState(), copy: bytes(mem.getState()) });
    try {
      ctx.commit();
    } catch (e) {
      errors.push(`commit:${(e as Error).name}`);
    }
    snaps.push(bytes(ctx.getSnapshot()));
  });
  if (laws) laws.editedGenerations = generations.filter((g) => bytes(g.ref) !== g.copy).length;
  const folds: string[] = [];
  for (let i = 0; i <= log.list().length; i++) folds.push(bytes(log.materialise(i)));
  return {
    errors: errors.join(','),
    reads: reads.join('\n'),
    snapshots: snaps.join('\n'),
    commitLog: bytes(log.list()),
    state: bytes(mem.getState()),
    folds: folds.join('\n'),
  };
}

// ─── WRITE-BACK programs (the B2 law, targeted) ──────────────────────────

/*
 * B2 (design note, "The review round"): after a stage's first write, a read
 * the working copy cannot answer (the stage deleted or unset the path, or a
 * write replaced a container above it) is served from LIVE committed state,
 * on 9.28.0 and here. 9.28.0's diff base was a clone taken at the first
 * write. Here the base IS the committed generation, so the frame's read
 * (`RecordFrame · read`; `StageContext · readState` before C3) has
 * `TransactionBuffer · detachBase` give the base a private copy
 * at that path before the value goes out — otherwise an in-place edit moves
 * the base too, and the write-back records nothing.
 *
 * The NESTED family reaches that shape at ONE seed only (102938, program
 * 1,976): its `mutRead` edits a value but never writes it back. This family
 * aims at it — delete the key or keep it, read it after the first write, edit
 * the value in place, then write it back with `set` or `merge` (or not) — at
 * root, nested and run-namespaced paths, both encodings. Written by the PR's
 * independent recheck: 9,000 programs (seeds 7301–7303) identical to 9.28.0,
 * `detachBase` replacing a base path in 198 of them; with the frame's read
 * skipping `detachBase`, or `detachBase` a no-op, it fails at program 91.
 *
 * The values and keys are the recheck's own (no `Date`, so M6 never arises);
 * changing an arbitrary changes what every seed generates.
 */

const WB_PATHS: string[][] = [[], ['obj'], ['obj', 'deep'], ['list']];
const WB_KEYS = ['x', 'deep', 'list', 'cfg', '0'] as const;

const wbLeaf = fc.oneof(fc.integer({ min: -5, max: 50 }), fc.constantFrom('s', ''), fc.boolean(), fc.constant(null));
const wbValueArb: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  v: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    wbLeaf,
    fc.array(tie('v'), { maxLength: 3 }),
    fc.dictionary(fc.constantFrom('x', 'n', 'deep', 'list', 'cfg'), tie('v'), { maxKeys: 3 }),
  ),
})).v;

export type WriteBackOp =
  | { t: 'set' | 'merge'; path: number; k: string; v: unknown }
  | { t: 'del' | 'read'; path: number; k: string }
  /** After the first write (out of contract): read, edit in place, write back with `how`. */
  | { t: 'readBack'; path: number; k: string; n: number; how: 'set' | 'merge' }
  /** The B2 shape: delete, read (served from live state), edit in place, write back with `how` — or not. */
  | { t: 'delReadBack'; path: number; k: string; n: number; how: 'set' | 'merge' | 'none' };

export type WriteBackProgram = {
  initial: unknown;
  stages: Array<{ runId: '' | 'r1'; ops: WriteBackOp[] }>;
  commitValues: 'full' | 'delta';
  /** When false, `readBack` / `delReadBack` are skipped — an in-contract program. */
  mutate: boolean;
};

const wbPath = fc.integer({ min: 0, max: WB_PATHS.length - 1 });
const wbKey = fc.constantFrom(...WB_KEYS);
const writeBackOpArb: fc.Arbitrary<WriteBackOp> = fc.oneof(
  fc.record({ t: fc.constantFrom('set' as const, 'merge' as const), path: wbPath, k: wbKey, v: wbValueArb }),
  fc.record({ t: fc.constantFrom('del' as const, 'read' as const), path: wbPath, k: wbKey }),
  fc.record({
    t: fc.constant('readBack' as const),
    path: wbPath,
    k: wbKey,
    n: fc.integer({ min: 0, max: 99 }),
    how: fc.constantFrom('set' as const, 'merge' as const),
  }),
  fc.record({
    t: fc.constant('delReadBack' as const),
    path: wbPath,
    k: wbKey,
    n: fc.integer({ min: 0, max: 99 }),
    how: fc.constantFrom('set' as const, 'merge' as const, 'none' as const),
  }),
);

export const writeBackProgramArb: fc.Arbitrary<WriteBackProgram> = fc.record({
  initial: fc.option(fc.dictionary(fc.constantFrom('obj', 'list', 'x', 'cfg', 'runs'), wbValueArb, { maxKeys: 4 }), {
    nil: undefined,
  }),
  stages: fc.array(
    fc.record({ runId: fc.constantFrom('' as const, 'r1' as const), ops: fc.array(writeBackOpArb, { maxLength: 7 }) }),
    { minLength: 1, maxLength: 4 },
  ),
  commitValues: fc.constantFrom('full' as const, 'delta' as const),
  mutate: fc.boolean(),
});

const wbAt = (o: WriteBackOp) => [...WB_PATHS[o.path], o.k].join('/');

/**
 * EXCLUDED — named behaviour M3, not B2. A read of `runs/r1/<k>` that falls
 * back to the GLOBAL `<k>` hands out the global committed object; written
 * back at the run-namespaced path, 9.28.0's live state then holds that one
 * object at both positions. A later write THROUGH it in the same stage (a
 * delete or set below it) edited the shared object on 9.28.0, so the global
 * key changed too; copy-on-write copies the path and changes only its own
 * (M3, value semantics — pinned in copy-on-write-commit.test.ts). The log,
 * the reads and every fold are identical; only live state and `stageWrites`
 * differ. The recheck found it here and excluded it by SHAPE, conservatively
 * (any non-read op below a written-back path in the same stage, whether the
 * read fell back or not); the property skips these programs (`fc.pre`) and
 * the corpus never samples one.
 */
export function writesThroughWriteBack(p: WriteBackProgram): boolean {
  return p.stages.some((st) => {
    const back: string[] = [];
    return st.ops.some((o) => {
      const at = wbAt(o);
      const through = o.t !== 'read' && back.some((s) => at.startsWith(`${s}/`));
      if (o.t === 'readBack' || o.t === 'delReadBack') back.push(at);
      return through;
    });
  });
}

/**
 * Named behaviour M8, widened to this family's writes: a write THROUGH a
 * value the same stage set or wrote back no longer edits that value in place,
 * so the outer key's retained `stageWrites` entry is the value as written.
 * Only `snapshots` may differ; they are left out of the comparison.
 */
export function writesThroughWriteBackOrSet(p: WriteBackProgram): boolean {
  return p.stages.some((st) => {
    const staged: string[] = [];
    return st.ops.some((o) => {
      const at = wbAt(o);
      const through = staged.some((s) => at.startsWith(`${s}/`));
      if (o.t === 'set' || o.t === 'readBack' || o.t === 'delReadBack') staged.push(at);
      return through && o.t !== 'read';
    });
  });
}

/** Edit what a read returned, in place — the out-of-contract act before the write-back. */
function editForWriteBack(x: unknown, n: number): void {
  if (Array.isArray(x)) {
    if (isObj(x[0])) x[0].n = n;
    else x.push(n);
  } else if (isObj(x)) {
    const inner = x.x;
    if (isObj(inner)) inner.n = n;
    else x.n = n;
  }
}

/**
 * Drive `StageContext` through a write-back program, as `runNested` does: the
 * same kept fields, the same build-only generation check (`laws`). A
 * `readBack` / `delReadBack` runs only in a `mutate` program and only after
 * the stage's first write — before it is M7 (named: a read before the first
 * write, edited and written back, records no change).
 */
export function runWriteBack(
  engine: Engine,
  p: WriteBackProgram,
  laws?: { editedGenerations: number },
): Record<string, string> {
  const mem = new engine.SharedMemory(undefined, materialise(p.initial));
  const log = new engine.EventLog(mem.getState());
  const reads: string[] = [];
  const snaps: string[] = [];
  const errors: string[] = [];
  const generations: Array<{ ref: unknown; copy: string }> = [];
  p.stages.forEach((st, i) => {
    const ctx = new engine.StageContext(st.runId, `S${i}`, `s${i}`, mem, '', log);
    if (p.commitValues === 'delta') deltaFrame(ctx);
    let wrote = false;
    for (const o of st.ops) {
      try {
        const path = WB_PATHS[o.path];
        if (o.t === 'set') {
          ctx.setObject(path, o.k, materialise(o.v));
          wrote = true;
        } else if (o.t === 'merge') {
          ctx.updateObject(path, o.k, materialise(o.v));
          wrote = true;
        } else if (o.t === 'del') {
          ctx.setObject(path, o.k, undefined, false, undefined, 'delete');
          wrote = true;
        } else if (o.t === 'read') {
          reads.push(bytes(ctx.getValue(path, o.k) ?? null));
        } else if (p.mutate && wrote) {
          if (o.t === 'delReadBack') ctx.setObject(path, o.k, undefined, false, undefined, 'delete');
          const got = ctx.getValue(path, o.k);
          reads.push(bytes(got ?? null));
          editForWriteBack(got, o.n);
          if (got !== null && typeof got === 'object') {
            if (o.how === 'set') ctx.setObject(path, o.k, got);
            else if (o.how === 'merge') ctx.updateObject(path, o.k, got);
          }
        }
      } catch (e) {
        errors.push(`${o.t}:${(e as Error).name}`);
      }
    }
    if (laws) generations.push({ ref: mem.getState(), copy: bytes(mem.getState()) });
    try {
      ctx.commit();
    } catch (e) {
      errors.push(`commit:${(e as Error).name}`);
    }
    snaps.push(bytes(ctx.getSnapshot()));
  });
  if (laws) laws.editedGenerations = generations.filter((g) => bytes(g.ref) !== g.copy).length;
  const folds: string[] = [];
  for (let i = 0; i <= log.list().length; i++) folds.push(bytes(log.materialise(i)));
  return {
    errors: errors.join(','),
    reads: reads.join('\n'),
    snapshots: snaps.join('\n'),
    commitLog: bytes(log.list()),
    state: bytes(mem.getState()),
    folds: folds.join('\n'),
  };
}

// ─── The witness (9.30.0): did a commit fold back to what its stage read? ──

/*
 * 9.30.0 (the admitted record) changes the bytes of exactly the commits
 * whose rows did not fold back to what the stage read — and 9.28.0 wrote
 * those rows too. So a differential cannot ask for byte identity
 * everywhere; it asks for it until the first commit at which the two engines
 * differ, and there it asks the WITNESS: 9.28.0's bundle must be one that did
 * not fold back. Everything after that commit follows from a different
 * state and is not compared. The witness also checks every commit the build
 * makes: each must fold back.
 *
 * The law is written here a second time, independently of
 * `TransactionBuffer · admit`, so the build is not its own judge: replay the
 * bundle onto the stage's diff base (`applySmartMerge`, the reader's replay)
 * and, at every path the stage touched, compare it with the stage's working
 * copy — the value (`canon`: an own `undefined` is a deleted key, arrays by
 * index, key order free; as a record can hold it, through `structuredClone`)
 * and, on the way there, every container and array slot the working copy
 * holds. The run addresses (`runs`, `runs/<id>`) are
 * where a stage writes, not a value it reads, and are not compared.
 *
 * F1b (the witness is judged, not trusted): the clause stays at the FIRST
 * commit at which two runs differ — after it the engines hold different
 * states, so a later difference may merely follow from the first — except
 * where the states are provably the same again: each resumed leg of a paused
 * run starts from a checkpoint, and `witnessLegs` judges it on its own when
 * both engines' checkpoints are byte-identical. The witness itself is tested
 * against lies told on purpose (scenario/copy-on-write-witness.test.ts:
 * `cutAdmission` puts the old accumulated-delta rows back, `rewriteCommits`
 * changes bytes that did not lie), so a clause that stopped reading would
 * fail there before it passed a differential.
 */

/** One commit as the witness saw it: its bundle's bytes, and whether the bundle folded back to what its stage read. */
export type Witnessed = { bytes: string; foldsBack: boolean };

/** A canonical spelling for the witness — own `undefined` absent, arrays by index, keys sorted, typed values spelled. */
export function canon(v: unknown): string {
  if (v === undefined) return 'u';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (v instanceof Date) return `date:${v.getTime()}`;
  if (v instanceof Map) return `map:${canon([...v.entries()])}`;
  if (v instanceof Set) return `set:${canon([...v.values()])}`;
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (let i = 0; i < v.length; i++) parts.push(canon(v[i]));
    return `[${parts.join(',')}]`;
  }
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
}

/** The own value at `key` of a container, else `undefined`. */
const child = (x: unknown, key: string): unknown =>
  x !== null && typeof x === 'object' && Object.prototype.hasOwnProperty.call(x, key)
    ? (x as Record<string, unknown>)[key]
    : undefined;

/** Does an array the working copy holds have a slot at `key` the fold lacks? */
function slotMissing(folded: unknown, read: unknown, key: string): boolean {
  if (!Array.isArray(read)) return false;
  const i = Number(key);
  if (!Number.isInteger(i) || i < 0 || String(i) !== key || i >= read.length) return false;
  return !(Array.isArray(folded) && i < folded.length);
}

/** At one touched path: the value, and every container and array slot on the way, below the run address. */
function agreesAt(folded: unknown, read: unknown, segs: string[]): boolean {
  const from = segs[0] === 'runs' && segs.length >= 3 ? 2 : 0;
  let f = folded;
  let w = read;
  for (let i = 0; i < segs.length; i++) {
    if (i >= from && slotMissing(f, w, segs[i])) return false;
    f = child(f, segs[i]);
    w = child(w, segs[i]);
    if (i === segs.length - 1 || w === null || typeof w !== 'object') break;
    if (i >= from && (f === null || typeof f !== 'object' || Array.isArray(f) !== Array.isArray(w))) return false;
  }
  // As a record can hold it: what a stage read, through `structuredClone`
  // (an Error's own fields do not survive one — no record can hold them).
  const value = canon(valueAt(folded, segs));
  return value === canon(valueAt(read, segs)) || value === canon(structuredClone(valueAt(read, segs)));
}

/** The own value at `segs`, else `undefined`. */
function valueAt(x: unknown, segs: string[]): unknown {
  let at = x;
  for (const s of segs) at = child(at, s);
  return at;
}

/** Patch `engine`'s `TransactionBuffer.prototype.commit` to witness every commit; `restore()` undoes it. */
function patchWitness(engine: Engine): { seen: Witnessed[]; restore(): void } {
  const proto = engine.TransactionBuffer.prototype;
  const commit = proto.commit;
  const seen: Witnessed[] = [];
  proto.commit = function (this: any) {
    // Taken BEFORE the commit: it clears the op trace in place and drops the
    // working copy (a new `{}`), leaving the old one intact.
    const base = this.baseSnapshot;
    const read = this.workingCopy;
    const touched = [...new Set<string>(this.opTrace.map((op: { path: string }) => op.path))];
    const payload = commit.call(this);
    const folded = applySmartMerge(base, payload.updates, payload.overwrite, payload.trace);
    const foldsBack = touched.every((path) => agreesAt(folded, read, path.split('\u001f')));
    // `readKeys` left out: the witness judges VALUES. A merge-back's rows hold
    // the read prefix of the frame that staged them, which R13 moved (header
    // above `ChartRun`); every other row's `readKeys` is still compared, in
    // the log.
    const trace = payload.trace.map(({ readKeys: _provenance, ...row }: { readKeys?: unknown }) => row);
    seen.push({ bytes: bytes({ ...payload, trace }), foldsBack });
    return payload;
  };
  return {
    seen,
    restore: () => {
      proto.commit = commit;
    },
  };
}

/** Run `fn` while witnessing `engine`'s commits — awaited, so an async run stays patched until it settles. */
export async function witnessing<T>(engine: Engine, fn: () => T | Promise<T>): Promise<[Awaited<T>, Witnessed[]]> {
  const patch = patchWitness(engine);
  try {
    return [await fn(), patch.seen];
  } finally {
    patch.restore();
  }
}

/** The synchronous twin of {@link witnessing}, for the `StageContext` families. */
export function witnessingSync<T>(engine: Engine, fn: () => T): [T, Witnessed[]] {
  const patch = patchWitness(engine);
  try {
    return [fn(), patch.seen];
  } finally {
    patch.restore();
  }
}

/**
 * The differentials' clause (9.30.0): every commit the build made folded back;
 * and if the runs differ at all, the first commit at which the two logs
 * differ is one where 9.28.0's bundle did NOT fold back. Returns '' when the
 * clause holds, else what broke it. `differs` is whether the runs' kept
 * bytes differ anywhere.
 */
export function witnessClause(baseline: Witnessed[], build: Witnessed[], differs: boolean, redacted = false): string {
  const unadmitted = build.findIndex((c) => !c.foldsBack);
  if (unadmitted >= 0) return `the build's commit ${unadmitted} does not fold back to what its stage read`;
  if (!differs) return '';
  const n = Math.max(baseline.length, build.length);
  for (let i = 0; i < n; i++) {
    if (sameCommit(baseline[i]?.bytes, build[i]?.bytes, redacted)) continue;
    if (baseline[i] === undefined || build[i] === undefined)
      return `the engines made a different number of commits (${i})`;
    return baseline[i].foldsBack ? `commit ${i} differs, but 9.28.0's bundle there folded back` : '';
  }
  return 'the runs differ but every commit is byte-identical';
}

/** What judging a paused run leg by leg reached — see {@link witnessLegs}. */
export type LegTally = {
  /** Legs judged. */
  legs: number;
  /** Legs that started together and differed, each explained by a 9.28.0 bundle that did not fold back. */
  explained: number;
  /** Of those, legs after an earlier leg had already differed — the legs the run-wide clause never reads. */
  rejudged: number;
  /** Legs that started apart: only the build's half applied. */
  downstream: number;
};

/**
 * The pause family's clause, one leg at a time (F1b). A resumed leg starts
 * from a checkpoint, so it is a differential of its own — when both engines
 * start it from the same state (`startsTogether(leg)`: the checkpoint that
 * opened it is byte-identical in both). Then its first differing commit must
 * be a 9.28.0 bundle that did not fold back, even when an earlier leg already
 * differed; the run-wide {@link witnessClause} stops at the first difference of
 * the whole run and never reads on. A leg that starts apart differs because an
 * earlier leg did, which says nothing about its own commits: only the build's
 * half applies there (every commit it made folded back). `baseline[i]` and
 * `build[i]` are the commits leg `i` made, each engine witnessed on its own
 * (`witnessing` around each `run` / `resume`). '' when every leg holds, else
 * the first leg that broke it, named.
 */
export function witnessLegs(
  baseline: Witnessed[][],
  build: Witnessed[][],
  startsTogether: (leg: number) => boolean,
  redacted = false,
): { broken: string; tally: LegTally } {
  const tally: LegTally = { legs: 0, explained: 0, rejudged: 0, downstream: 0 };
  let earlierDiffered = false;
  for (let i = 0; i < Math.max(baseline.length, build.length); i++) {
    const a = baseline[i] ?? [];
    const b = build[i] ?? [];
    const together = startsTogether(i);
    const differs = a.length !== b.length || a.some((c, k) => !sameCommit(c.bytes, b[k].bytes, redacted));
    const broken = witnessClause(a, b, together && differs, redacted);
    if (broken) return { broken: `leg ${i}: ${broken}`, tally };
    tally.legs += 1;
    if (!together) tally.downstream += 1;
    else if (differs) {
      tally.explained += 1;
      if (earlierDiffered) tally.rejudged += 1;
    }
    earlierDiffered ||= differs;
  }
  return { broken: '', tally };
}

// ─── Lies told on purpose: the witness's own tests ────────────────────────

/*
 * A witness that cannot go red proves nothing, so scenario/copy-on-write-
 * witness.test.ts tells the build's buffer two lies and asks the clause to
 * name each. Both are installed BEFORE `witnessing` (which wraps whatever
 * `commit` is there, so it judges what the lie returned) and put back by the
 * function they return — call it in a `finally`, innermost-first.
 */

/**
 * Cut the build's admission (`TransactionBuffer · admit`): the compact rows go
 * out unchecked — the accumulated merge delta replayed at every `merge` row of
 * a path (C1) and the other shapes the admission closed (C2 to C5): the lies
 * 9.29.0 told, in the bytes it wrote them.
 */
export function cutAdmission(engine: Engine): () => void {
  const proto = engine.TransactionBuffer.prototype;
  const admit = proto.admit;
  if (typeof admit !== 'function') {
    throw new Error('TransactionBuffer · admit moved — move the witness tests’ cut with the admission');
  }
  proto.admit = (build: (lossy: undefined) => unknown) => build(undefined);
  return () => {
    proto.admit = admit;
  };
}

/** Rewrite every payload `engine`'s buffer commits (in place, before it leaves the buffer). */
export function rewriteCommits(engine: Engine, rewrite: (payload: any) => void): () => void {
  const proto = engine.TransactionBuffer.prototype;
  const commit = proto.commit;
  proto.commit = function (this: unknown) {
    const payload = commit.call(this);
    rewrite(payload);
    return payload;
  };
  return () => {
    proto.commit = commit;
  };
}

/** How many programs a differential compared, and at how many the witness explained a difference. */
export type Tally = { programs: number; explained: number };

// ─── Comparison ──────────────────────────────────────────────────────────

// ─── The restored redaction law (owner ruling (a)) ───────────────────────

/*
 * THE RESTORED REDACTION LAW (the live heaps — the run's and each subflow's
 * plain `treeContext.globalContext` — are always compared byte for byte): a
 * policy covers everything the library retains or serves. Two of its rules reach these programs: a stage that writes an
 * OBJECT it read under a selected name under another name hands that name the
 * same rule (`StageContext · stageWrite`, by identity — the `copy` op), and a
 * subflow mapper's copy of a selected value inherits its redaction
 * (`memory/redaction.ts · MapperTaint`). 9.28.0 served those copies in plain,
 * so under a policy this build may serve a placeholder where 9.28.0 served a
 * value — and only that. The differentials ask {@link sameUnderLaw} of policy
 * programs only, never of a live field ({@link LIVE_FIELD}: the heap, the fold
 * base, the errors) and never of a checkpoint's live parts: the law never
 * touches the live heap or the checkpoint.
 */

/** Fields the law never touches: compared byte for byte under every policy. */
export const LIVE_FIELD = /^(runError|stageErrors|errors|pauses|sharedState|initialState)$|\.(state|init)$/;

/** A checkpoint's live parts — the heap, the captures and the question — compared byte for byte. */
const CHECKPOINT_LIVE = ['sharedState', 'subflowStates', 'pauseData'] as const;

/** Fields that keep the PLAIN `subflowResults`, whose `treeContext.globalContext` is each subflow's LIVE heap. */
const PLAIN_SUBFLOWS_FIELD = /^subflowResults$|\.sub$/;

/** Each subflow's live heap — `treeContext.globalContext` — byte for byte, like the run's own live state. */
function subflowHeapsAlike(field: string, x: string, y: string): boolean {
  if (!PLAIN_SUBFLOWS_FIELD.test(field)) return true;
  const heaps = (bytesOf: string) => {
    const results = JSON.parse(bytesOf) as Record<string, any> | null;
    return JSON.stringify(Object.entries(results ?? {}).map(([key, r]) => [key, r?.treeContext?.globalContext]));
  };
  return heaps(x) === heaps(y);
}

const PLACEHOLDERS = new Set(['REDACTED', '[REDACTED]']);

/**
 * `true` when `build` is `base` with nothing but the law's differences: a
 * placeholder in place of a value, and `redactedPaths` (an array, or a Set as
 * `bytes` spells it) covering every path 9.28.0's did (itself or an ancestor).
 * Never a different value.
 */
export function onlyMoreRedacted(base: unknown, build: unknown, key = ''): boolean {
  if (Object.is(base, build)) return true;
  if (typeof build === 'string' && PLACEHOLDERS.has(build)) return true;
  if (key === 'redactedPaths') return pathsCover(base, build);
  if (base === null || build === null || typeof base !== 'object' || typeof build !== 'object') return false;
  if (Array.isArray(base) !== Array.isArray(build)) return false;
  const keys = Object.keys(base);
  if (keys.length !== Object.keys(build).length) return false;
  return keys.every(
    (k) => Object.prototype.hasOwnProperty.call(build, k) && onlyMoreRedacted((base as any)[k], (build as any)[k], k),
  );
}

function pathsCover(base: unknown, build: unknown): boolean {
  const list = (v: unknown): unknown[] | undefined =>
    Array.isArray(v) ? v : isObj(v) && Array.isArray(v['«set»']) ? (v['«set»'] as unknown[]) : undefined;
  const had = list(base);
  const has = list(build);
  if (had === undefined || has === undefined) return false;
  const kept = has.map(String);
  return had.every((p) => kept.some((q) => String(p) === q || String(p).startsWith(`${q}\u001f`)));
}

/**
 * A checkpoint's live parts — the heap, the captures, the question — byte for
 * byte. (A finished subflow's own heap rode here too until the lean checkpoint,
 * format 2, stopped carrying `subflowResults`; it is compared on the leg's
 * snapshot, `subflowHeapsAlike`.)
 */
function checkpointLiveAlike(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return CHECKPOINT_LIVE.every((part) => JSON.stringify(a[part]) === JSON.stringify(b[part]));
}

/** Two kept byte strings (one JSON value, or one per line) related by {@link onlyMoreRedacted}; a checkpoint's live parts exact. */
export function sameUnderLaw(x: string, y: string): boolean {
  const parse = (v: string): { ok: boolean; value?: unknown } => {
    try {
      return { ok: true, value: JSON.parse(v) };
    } catch {
      return { ok: false };
    }
  };
  const a = parse(x);
  const b = parse(y);
  if (a.ok && b.ok) {
    const isCheckpoint = isObj(a.value) && Object.prototype.hasOwnProperty.call(a.value, 'pausedStageId');
    if (isCheckpoint && isObj(b.value) && !checkpointLiveAlike(a.value as Record<string, unknown>, b.value)) {
      return false;
    }
    return onlyMoreRedacted(a.value, b.value);
  }
  const xs = x.split('\n');
  const ys = y.split('\n');
  return xs.length > 1 && xs.length === ys.length && xs.every((line, i) => sameUnderLaw(line, ys[i]));
}

/** Two witnessed commits alike — byte for byte, or (under a policy) as the law relates them. */
function sameCommit(x: string | undefined, y: string | undefined, redacted: boolean): boolean {
  if (x === y) return true;
  return redacted && x !== undefined && y !== undefined && sameUnderLaw(x, y);
}

/** The first field where two runs' bytes differ, with context — '' when identical. */
export function firstDifference(a: Record<string, string>, b: Record<string, string>, redacted = false): string {
  const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const field of fields) {
    const x = a[field] ?? '«absent»';
    const y = b[field] ?? '«absent»';
    if (x === y) continue;
    if (redacted && !LIVE_FIELD.test(field) && sameUnderLaw(x, y) && subflowHeapsAlike(field, x, y)) continue;
    let i = 0;
    while (i < x.length && x[i] === y[i]) i++;
    const from = Math.max(0, i - 160);
    return `${field} differs at ${i}\n  9.28.0: …${x.slice(from, i + 160)}\n  build:  …${y.slice(from, i + 160)}`;
  }
  return '';
}

/**
 * Every commit log one run of a chart program keeps — the run's and each subflow's own `history` — with the
 * fold base that travelled with it (`initialState`). Used by the key-query properties (F4b, 9.33.0).
 */
export async function chartLogs(
  engine: Engine,
  p: ChartProgram,
): Promise<Array<{ log: any[]; base: Record<string, unknown> | undefined }>> {
  const ex = new engine.FlowChartExecutor(
    buildChart(engine, p, [], () => undefined),
    {
      commitValues: p.cfg.commitValues,
      readTracking: p.cfg.readTracking,
      writeTracking: p.cfg.writeTracking,
      writeProvenance: p.cfg.writeProvenance,
      ...(p.cfg.initial ? { initialContext: { a: 'init', obj: { x: 0, nest: { q: [1, 2] } }, hist: [{ n: 1 }] } } : {}),
    },
  );
  if (p.cfg.policy) ex.setRedactionPolicy({ keys: ['b'], fields: { obj: ['y'] } });
  try {
    await ex.run();
  } catch {
    /* the log holds what landed */
  }
  const snap = ex.getSnapshot();
  const logs = [{ log: snap.commitLog as any[], base: snap.initialState as Record<string, unknown> | undefined }];
  for (const [id, sf] of Object.entries(snap.subflowResults ?? {}) as Array<[string, any]>) {
    if (id.includes('#')) continue; // the same result, dual-keyed by its runtimeStageId
    logs.push({ log: sf.treeContext.history, base: sf.treeContext.initialState });
  }
  return logs;
}
