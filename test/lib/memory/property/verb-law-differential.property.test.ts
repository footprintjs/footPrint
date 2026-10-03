/**
 * Property tests — THE ONE VERB LAW: the old replicas against `verbs.ts`.
 *
 * Until F2 three functions each held their own switch over a commit row's
 * verb: `utils.ts · replayRows` (behind applySmartMerge / nextGeneration /
 * applySmartMergeInto / dryFold), `commitLogUtils.ts · commitValueAt` and
 * `slice/elementProvenance.ts · arrayProvenance`. They are one now —
 * `verbs.ts · applyVerb`, folded by `foldRows` (a bundle into a state) and
 * `foldKey` (one path across a log). The three originals are kept BELOW,
 * verbatim, as the CONTROL: this file runs them and the new code on the same
 * random programs and says where, and only where, they may differ. It stays
 * for the packet's lifetime — a control that is deleted can never fail.
 *
 *   FOLD      `foldRows`, under all three clone disciplines, is byte-for-byte
 *             the old `replayRows` over `fc.jsonValue()` payloads — every
 *             verb, nested paths, a base state of any shape — and edits
 *             neither its base (the two path-copying disciplines) nor the
 *             payload.
 *   READER 1  `commitValueAt` equals the old per-key switch on every log
 *             EXCEPT one named class, D: a bundle with two or more `merge`
 *             rows of the key at or after the anchor. There the old reader
 *             cloned the delta once PER ROW, and an array union — which
 *             deduplicates by reference — duplicated the elements the first
 *             row had placed. On D (and everywhere) the new reader equals the
 *             per-key slice of the OLD REPLAY, the oracle the doc comment
 *             always claimed.
 *   READER 2  `arrayProvenance` equals the old fold outside the same class
 *             (anywhere before `end` — births are a history), and on it still
 *             keeps the module invariant (`births` aligned with the value).
 *
 * F3 (9.33.0, ruling R4) RESTATED BOTH READERS' ORACLES — the only change to
 * this file. A key query now sees every row under the key's top-level key (the
 * value rule, `memory/keyPaths.ts`), not only rows on its exact path, so:
 *   - READER 1's oracle is the old replay over the rows UNDER THE KEY'S
 *     TOP-LEVEL KEY (it was: rows on the exact path), read at the key — the
 *     value `stateAt` gives there;
 *   - the old exact-path switches stay as the named CONTROL, compared on
 *     EXACT-ROW logs only (every row under the top-level key up to the asked
 *     index is on the key itself) — there nothing may move;
 *   - READER 2's invariant branch asks the writer rule (a row on, inside or
 *     around the key), not "a row on the exact path".
 *   REFUSAL   R2: a row whose verb is not set | merge | append | delete throws
 *             `UnknownVerbError` naming the row at every door — where the old
 *             switches folded it as a merge (the control still does, below).
 *
 * The answer to "name the row for which `commitValueAt` through `applyVerb`
 * and the old per-key switch differ": a bundle holding `set c = []` and two
 * `merge`s of `c` whose delta is `[{ n: 1 }]`-shaped — pinned as a directed
 * case at the end, where the control answers four elements and the law two.
 */
import { isDeepStrictEqual } from 'node:util';

import fc from 'fast-check';

import { commitValueAt } from '../../../../src/lib/memory/commitLogUtils';
import { deepEqual } from '../../../../src/lib/memory/equality';
import { deepSmartMerge } from '../../../../src/lib/memory/merge';
import { nativeDelete, nativeGet, nativeSet, own, ownedRootOf, ownSpine } from '../../../../src/lib/memory/pathOps';
import { DELIM } from '../../../../src/lib/memory/paths';
import type { CommitBundle, MemoryPatch, TraceEntry } from '../../../../src/lib/memory/types';
import { applySmartMerge, applySmartMergeInto, dryFold, nextGeneration } from '../../../../src/lib/memory/utils';
import { UnknownVerbError } from '../../../../src/lib/memory/verbs';
import { arrayProvenance } from '../../../../src/lib/slice/elementProvenance';
import type { ArrayProvenance, AttributionBasis, ElementBirth } from '../../../../src/lib/slice/types';

// ═════════════════════════════════════════════════════════════════════════════
// THE CONTROL — the three replicas exactly as they stood at 9.30.0 (332bfb2).
// Do not tidy, share or "fix" any of this: its job is to be the old code.
// ═════════════════════════════════════════════════════════════════════════════

/** utils.ts · supersededByNextSet, 9.30.0. */
function oldSuperseded(rows: readonly { path: string; verb: string }[], i: number): boolean {
  const row = rows[i];
  if (row.verb !== 'set') return false;
  const next = rows[i + 1];
  return next !== undefined && next.verb === 'set' && next.path === row.path;
}

/** utils.ts · replayRows, 9.30.0 — THE verb switch (the default arm folds ANY other verb as a merge). */
function oldReplayRows(
  out: any,
  updates: MemoryPatch,
  overwrite: MemoryPatch,
  trace: TraceEntry[],
  copyOnWrite: boolean,
  detach = true,
): any {
  const nested = trace.some((t) => t.path.indexOf(DELIM) !== -1);
  const owned = copyOnWrite && nested ? new WeakSet<object>() : undefined;
  own(out, owned);
  let deltas: MemoryPatch | undefined;
  for (let i = 0; i < trace.length; i++) {
    if (oldSuperseded(trace, i)) continue;
    const { path, verb } = trace[i];
    const segs = path.split(DELIM);
    if (owned !== undefined && segs.length > 1) ownSpine(out, segs, owned);
    if (verb === 'set') {
      const recorded = nativeGet(overwrite, segs);
      const value = detach ? structuredClone(recorded) : recorded;
      if (detach) own(value, owned);
      nativeSet(out, segs, value);
    } else if (verb === 'append') {
      const recorded = nativeGet(overwrite, segs);
      const tail = detach ? structuredClone(recorded) : recorded;
      const current = nativeGet(out, segs);
      const next = Array.isArray(current) && Array.isArray(tail) ? [...current, ...tail] : tail;
      if (detach) own(next, owned);
      nativeSet(out, segs, next);
    } else if (verb === 'delete') {
      nativeDelete(out, segs);
    } else {
      deltas ??= detach ? structuredClone(updates) : updates;
      const current = nativeGet(out, segs) ?? {};
      const merged = deepSmartMerge(current, nativeGet(deltas, segs));
      own(merged, owned);
      nativeSet(out, segs, merged);
    }
  }
  return out;
}

/** commitLogUtils.ts · commitValueAt, 9.30.0 — the per-key switch (a clone of the delta per ROW). */
function oldCommitValueAt(commitLog: CommitBundle[], idx: number, key: string): unknown {
  const end = Math.min(idx, commitLog.length - 1);
  const segs = key.split(DELIM);
  const touches: { verb: string; bundle: CommitBundle }[] = [];
  for (let i = 0; i <= end; i++) {
    for (const t of commitLog[i].trace) {
      if (t.path === key) touches.push({ verb: t.verb, bundle: commitLog[i] });
    }
  }
  if (touches.length === 0) return undefined;
  let start = 0;
  for (let i = touches.length - 1; i >= 0; i--) {
    if (touches[i].verb === 'set' || touches[i].verb === 'delete') {
      start = i;
      break;
    }
  }
  let value: unknown;
  for (let i = start; i < touches.length; i++) {
    const { verb, bundle } = touches[i];
    if (verb === 'set') {
      value = structuredClone(nativeGet(bundle.overwrite, segs));
    } else if (verb === 'delete') {
      value = undefined;
    } else if (verb === 'append') {
      const tail = structuredClone(nativeGet(bundle.overwrite, segs));
      value = Array.isArray(value) && Array.isArray(tail) ? [...value, ...tail] : tail;
    } else {
      value = deepSmartMerge(value, structuredClone(nativeGet(bundle.updates, segs)));
    }
  }
  return value;
}

/** slice/elementProvenance.ts, 9.30.0 — the third switch, with the helpers it owned. */
interface OldTouch {
  verb: TraceEntry['verb'];
  bundle: CommitBundle;
  commitIdx: number;
}

function oldIsStrictPrefix(prev: unknown[], next: unknown[]): boolean {
  if (prev.length > next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (!deepEqual(prev[i], next[i])) return false;
  }
  return true;
}

function oldBirthOf(index: number, touch: OldTouch, basis: AttributionBasis, value: unknown): ElementBirth {
  return {
    index,
    commitIdx: touch.commitIdx,
    runtimeStageId: touch.bundle.runtimeStageId,
    stageId: touch.bundle.stageId,
    stageName: touch.bundle.stage,
    verb: touch.verb,
    basis,
    value,
  };
}

function oldRebaseBirths(
  prev: unknown,
  next: unknown,
  births: ElementBirth[],
  touch: OldTouch,
  tailBasis: AttributionBasis,
): ElementBirth[] {
  if (!Array.isArray(next)) return [];
  if (Array.isArray(prev) && oldIsStrictPrefix(prev, next)) {
    const kept = births.slice(0, prev.length);
    for (let i = prev.length; i < next.length; i++) {
      kept.push(oldBirthOf(i, touch, tailBasis, next[i]));
    }
    return kept;
  }
  return next.map((el, i) => oldBirthOf(i, touch, 'whole-value', el));
}

function oldArrayProvenance(commitLog: CommitBundle[], key: string, options?: { atIdx?: number }): ArrayProvenance {
  if (commitLog.length === 0) return { key, missing: 'empty-log' };
  const end = Math.min(options?.atIdx ?? commitLog.length - 1, commitLog.length - 1);
  const segs = key.split(DELIM);
  const touches: OldTouch[] = [];
  for (let i = 0; i <= end; i++) {
    for (const t of commitLog[i].trace) {
      if (t.path === key) touches.push({ verb: t.verb, bundle: commitLog[i], commitIdx: i });
    }
  }
  if (touches.length === 0) return { key, missing: 'never-written' };
  let value: unknown;
  let births: ElementBirth[] = [];
  for (const touch of touches) {
    const { verb, bundle } = touch;
    if (verb === 'set') {
      const next = structuredClone(nativeGet(bundle.overwrite, segs));
      births = oldRebaseBirths(value, next, births, touch, 'prefix-inference');
      value = next;
    } else if (verb === 'delete') {
      value = undefined;
      births = [];
    } else if (verb === 'append') {
      const tail = structuredClone(nativeGet(bundle.overwrite, segs));
      if (Array.isArray(value) && Array.isArray(tail)) {
        for (let j = 0; j < tail.length; j++) {
          births.push(oldBirthOf(value.length + j, touch, 'append-verb', tail[j]));
        }
        value = [...value, ...tail];
      } else {
        value = tail;
        births = Array.isArray(tail) ? tail.map((el, j) => oldBirthOf(j, touch, 'append-verb', el)) : [];
      }
    } else {
      const next = deepSmartMerge(value, structuredClone(nativeGet(bundle.updates, segs)));
      births = oldRebaseBirths(value, next, births, touch, 'prefix-inference');
      value = next;
    }
  }
  if (!Array.isArray(value)) return { key, missing: 'not-an-array' };
  return { key, atIdx: end, length: value.length, births };
}

// ═════════════════════════════════════════════════════════════════════════════
// The programs
// ═════════════════════════════════════════════════════════════════════════════

const FOUR = ['set', 'merge', 'append', 'delete'] as const;
type Verb = (typeof FOUR)[number];

/**
 * Paths over a small alphabet, so rows overlap, nest and shadow each other: mostly a few hot paths (the key a reader
 * asks about is touched often), sometimes any path of 1–3 segments.
 */
const pathArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom('a', 'b', ['a', 'b'].join(DELIM)) },
  {
    weight: 1,
    arbitrary: fc.array(fc.constantFrom('a', 'b', 'c'), { minLength: 1, maxLength: 3 }).map((s) => s.join(DELIM)),
  },
);

/** Payloads: any JSON, arrays (the union and the tail), and arrays of OBJECTS — where a union dedups by reference. */
const payloadArb: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 3, arbitrary: fc.jsonValue() },
  { weight: 2, arbitrary: fc.array(fc.jsonValue(), { maxLength: 4 }) },
  { weight: 3, arbitrary: fc.array(fc.record({ n: fc.nat(3) }), { minLength: 1, maxLength: 3 }) },
  {
    weight: 1,
    arbitrary: fc.dictionary(fc.constantFrom('x', 'y'), fc.jsonValue(), { maxKeys: 2, noNullPrototype: true }),
  },
);

interface Row {
  path: string;
  verb: Verb;
  payload: unknown;
}
const rowArb: fc.Arbitrary<Row> = fc.record({
  path: pathArb,
  verb: fc.constantFrom(...FOUR),
  payload: payloadArb,
});

/** Lay rows out as the engine does: one trace row each, ONE payload per path in the patch trees. */
function bundleOf(rows: Row[], n = 0): CommitBundle {
  const overwrite: MemoryPatch = {};
  const updates: MemoryPatch = {};
  const trace: TraceEntry[] = [];
  for (const { path, verb, payload } of rows) {
    const segs = path.split(DELIM);
    trace.push({ path, verb });
    if (verb === 'merge') nativeSet(updates, segs, structuredClone(payload));
    else nativeSet(overwrite, segs, verb === 'delete' ? undefined : structuredClone(payload));
  }
  return {
    idx: n,
    stage: `S${n}`,
    stageId: `s${n}`,
    runtimeStageId: `s${n}#${n}`,
    trace,
    redactedPaths: [],
    overwrite,
    updates,
  };
}

const bundleArb = fc.array(rowArb, { maxLength: 6 }).map((rows) => bundleOf(rows));
// Plain objects: a snapshot taken with structuredClone (which drops a null prototype) must compare equal to its source.
const baseArb = fc.dictionary(fc.constantFrom('a', 'b', 'c'), fc.jsonValue(), { maxKeys: 3, noNullPrototype: true });

/** A key plus a log in which that key is touched by the shapes the class D needs. */
interface KeyedLog {
  log: CommitBundle[];
  key: string;
  idx: number;
}
const logArb: fc.Arbitrary<KeyedLog> = fc
  .tuple(
    pathArb,
    fc.array(fc.array(rowArb, { maxLength: 5 }), { minLength: 1, maxLength: 4 }),
    fc.integer({ min: -1, max: 5 }),
  )
  .map(([key, perBundle, idx]) => ({ log: perBundle.map((rows, n) => bundleOf(rows, n)), key, idx }));

/** A log built to land in class D: a `set` anchor, then two or more `merge`s of the key in one bundle. */
const classDArb: fc.Arbitrary<KeyedLog> = fc
  .tuple(
    pathArb,
    fc.array(fc.record({ n: fc.nat(3) }), { minLength: 1, maxLength: 3 }),
    fc.array(fc.record({ n: fc.nat(3) }), { minLength: 1, maxLength: 3 }),
    fc.integer({ min: 2, max: 4 }),
    fc.array(rowArb, { maxLength: 3 }),
  )
  .map(([key, seed, delta, merges, noise]) => {
    const rows: Row[] = [
      ...noise,
      { path: key, verb: 'set', payload: seed },
      ...Array.from({ length: merges }, () => ({ path: key, verb: 'merge' as const, payload: delta })),
    ];
    return { log: [bundleOf(rows, 0)], key, idx: 0 };
  });

const keyedLogArb = fc.oneof({ weight: 3, arbitrary: logArb }, { weight: 2, arbitrary: classDArb });

// ═════════════════════════════════════════════════════════════════════════════
// FOLD — foldRows against the old replayRows
// ═════════════════════════════════════════════════════════════════════════════

describe('FOLD — foldRows is the old replayRows, under every clone discipline', () => {
  const clone = <T>(v: T): T => structuredClone(v);

  it('private (applySmartMerge): the same bytes, the payload untouched', () => {
    fc.assert(
      fc.property(bundleArb, baseArb, (bundle, base) => {
        const frozen = clone(bundle);
        const expected = oldReplayRows(
          clone(base),
          clone(bundle.updates),
          clone(bundle.overwrite),
          clone(bundle.trace),
          false,
        );
        const actual = applySmartMerge(base, bundle.updates, bundle.overwrite, bundle.trace);
        expect(isDeepStrictEqual(actual, expected)).toBe(true);
        expect(isDeepStrictEqual(bundle, frozen)).toBe(true);
      }),
      { numRuns: 800 },
    );
  });

  it('pathCopy (nextGeneration, applySmartMergeInto): the same bytes; the base and the payload untouched', () => {
    fc.assert(
      fc.property(bundleArb, baseArb, (bundle, base) => {
        const frozenBundle = clone(bundle);
        const frozenBase = clone(base);
        const expected = oldReplayRows(
          ownedRootOf(clone(base)),
          clone(bundle.updates),
          clone(bundle.overwrite),
          clone(bundle.trace),
          true,
        );
        const generation = nextGeneration(base, bundle.updates, bundle.overwrite, bundle.trace);
        const into = applySmartMergeInto(clone(base), bundle.updates, bundle.overwrite, bundle.trace);
        expect(isDeepStrictEqual(generation, expected)).toBe(true);
        expect(isDeepStrictEqual(into, expected)).toBe(true);
        expect(isDeepStrictEqual(base, frozenBase)).toBe(true); // a generation is never edited
        expect(isDeepStrictEqual(bundle, frozenBundle)).toBe(true);
      }),
      { numRuns: 800 },
    );
  });

  it('byReference (dryFold): the same bytes, recorded values placed as recorded, nothing edited', () => {
    fc.assert(
      fc.property(bundleArb, baseArb, (bundle, base) => {
        const frozenBundle = clone(bundle);
        const frozenBase = clone(base);
        const expected = oldReplayRows(
          ownedRootOf(clone(base)),
          clone(bundle.updates),
          clone(bundle.overwrite),
          clone(bundle.trace),
          true,
          false,
        );
        const actual = dryFold(base, bundle.updates, bundle.overwrite, bundle.trace);
        expect(isDeepStrictEqual(actual, expected)).toBe(true);
        expect(isDeepStrictEqual(base, frozenBase)).toBe(true);
        expect(isDeepStrictEqual(bundle, frozenBundle)).toBe(true);
      }),
      { numRuns: 800 },
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// READERS — commitValueAt and arrayProvenance against the old switches
// ═════════════════════════════════════════════════════════════════════════════

/** The key's rows up to `end`, with their commit position — read by the TEST, not by the library. */
function touchesOf(log: CommitBundle[], key: string, end: number): { verb: Verb; commit: number }[] {
  const out: { verb: Verb; commit: number }[] = [];
  for (let c = 0; c <= Math.min(end, log.length - 1); c++) {
    for (const t of log[c].trace) if (t.path === key) out.push({ verb: t.verb, commit: c });
  }
  return out;
}

/** Class D: a bundle with two or more `merge` rows of the key, from `from` on. */
function inClassD(touches: { verb: Verb; commit: number }[], from: number): boolean {
  const merges = new Map<number, number>();
  for (let i = from; i < touches.length; i++) {
    if (touches[i].verb === 'merge') merges.set(touches[i].commit, (merges.get(touches[i].commit) ?? 0) + 1);
  }
  return [...merges.values()].some((n) => n >= 2);
}

/** Is `path` the top-level key `top`, or a path under it? */
function underTop(path: string, top: string): boolean {
  return path === top || path.startsWith(top + DELIM);
}

/**
 * The per-key slice of the OLD REPLAY (F3's value rule): each bundle's rows UNDER THE KEY'S TOP-LEVEL KEY, folded
 * onto `{}` copy-on-write as the live commit and `stateAt` fold, read at the key.
 */
function replayOracle(log: CommitBundle[], key: string, end: number): unknown {
  const top = key.split(DELIM)[0];
  const state: Record<string, unknown> = {};
  for (let c = 0; c <= Math.min(end, log.length - 1); c++) {
    const rows = log[c].trace.filter((t) => underTop(t.path, top));
    if (rows.length > 0)
      oldReplayRows(state, structuredClone(log[c].updates), structuredClone(log[c].overwrite), rows, true);
  }
  return nativeGet(state, key.split(DELIM));
}

/** The CONTROL's domain: every row under the key's top-level key in `log[0..end]` is ON the key (no nested row). */
function exactRowsOnly(log: CommitBundle[], key: string, end: number): boolean {
  const top = key.split(DELIM)[0];
  for (let c = 0; c <= Math.min(end, log.length - 1); c++) {
    for (const t of log[c].trace) if (underTop(t.path, top) && t.path !== key) return false;
  }
  return true;
}

/** The writer rule's path half, read by the TEST: a row on the key, inside it, or around it. */
function relatedRows(log: CommitBundle[], key: string, end: number): number {
  let n = 0;
  for (let c = 0; c <= Math.min(end, log.length - 1); c++) {
    for (const t of log[c].trace) {
      if (t.path === key || t.path.startsWith(key + DELIM) || key.startsWith(t.path + DELIM)) n++;
    }
  }
  return n;
}

describe('READER 1 — commitValueAt', () => {
  it('equals the per-key slice of the replay on every log, and the old switch on every exact-row log outside class D', () => {
    fc.assert(
      fc.property(keyedLogArb, ({ log, key, idx }) => {
        const end = Math.min(idx, log.length - 1);
        const touches = touchesOf(log, key, end);
        let anchor = 0;
        touches.forEach((t, i) => {
          if (t.verb === 'set' || t.verb === 'delete') anchor = i;
        });

        const actual = commitValueAt(log, idx, key);
        const slice = relatedRows(log, key, end) === 0 ? undefined : replayOracle(log, key, end);
        expect(isDeepStrictEqual(actual, slice)).toBe(true);

        // THE CONTROL — on exact-row logs F3 moved nothing.
        if (exactRowsOnly(log, key, end) && !inClassD(touches, anchor)) {
          expect(isDeepStrictEqual(actual, oldCommitValueAt(log, idx, key))).toBe(true);
        }
      }),
      { numRuns: 1500 },
    );
  });

  it('the class is real: on at least one generated log the old switch is wrong and the law is right', () => {
    let differing = 0;
    fc.assert(
      fc.property(classDArb, ({ log, key }) => {
        const actual = commitValueAt(log, 0, key);
        const old = oldCommitValueAt(log, 0, key);
        if (!isDeepStrictEqual(actual, old)) {
          differing++;
          expect(isDeepStrictEqual(actual, replayOracle(log, key, 0))).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
    expect(differing).toBeGreaterThan(0);
  });
});

describe('READER 2 — arrayProvenance', () => {
  it('equals the old fold on every exact-row log outside class D, and keeps the module invariant on all of them', () => {
    fc.assert(
      fc.property(keyedLogArb, ({ log, key, idx }) => {
        if (log.length === 0) return;
        const end = Math.min(idx < 0 ? log.length - 1 : idx, log.length - 1);
        const touches = touchesOf(log, key, end);
        const actual = arrayProvenance(log, key, { atIdx: end });

        // THE CONTROL — on exact-row logs F3 moved nothing.
        if (exactRowsOnly(log, key, end) && !inClassD(touches, 0)) {
          expect(isDeepStrictEqual(actual, oldArrayProvenance(log, key, { atIdx: end }))).toBe(true);
        }
        // The invariant, on every log: births are index-aligned with the value, and the value is commitValueAt's.
        if (actual.births !== undefined) {
          const value = commitValueAt(log, end, key);
          expect(Array.isArray(value)).toBe(true);
          expect(actual.births.length).toBe(actual.length);
          expect(actual.length).toBe((value as unknown[]).length);
          actual.births.forEach((b, i) => expect(b.index).toBe(i));
        } else if (actual.missing === 'never-written') {
          // No commit wrote the key under the writer rule, so the fold leaves it absent.
          expect(commitValueAt(log, end, key)).toBeUndefined();
        } else if (relatedRows(log, key, end) > 0) {
          expect(actual.missing).toBe('not-an-array');
          expect(Array.isArray(commitValueAt(log, end, key))).toBe(false);
        }
      }),
      { numRuns: 1500 },
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// REFUSAL — R2, at every door
// ═════════════════════════════════════════════════════════════════════════════

/** Not one of the four — strings (some that are names on Object.prototype), and not strings at all. */
const badVerbArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom('upsert', 'SET', 'Set', '', ' set', 'set ', 'constructor', '__proto__', 'toString', 'hasOwnProperty'),
  fc.string({ maxLength: 8 }).filter((s) => !(FOUR as readonly string[]).includes(s)),
  fc.constantFrom(undefined, null, 0, 1, true, {}, [], ['set']),
);

describe('REFUSAL (R2) — an unknown verb is refused, naming the row, at every door', () => {
  it('the replay doors throw UnknownVerbError at the first such row — and the control still folds it as a merge', () => {
    fc.assert(
      fc.property(bundleArb, baseArb, badVerbArb, fc.nat(5), (bundle, base, bad, at) => {
        if (bundle.trace.length === 0) return;
        const row = at % bundle.trace.length;
        const trace = bundle.trace.map((t, i) => (i === row ? { ...t, verb: bad as Verb } : t));
        const firstBad = row; // exactly one bad row
        const doors: Array<() => unknown> = [
          () => applySmartMerge(base, bundle.updates, bundle.overwrite, trace),
          () => applySmartMergeInto(structuredClone(base), bundle.updates, bundle.overwrite, trace),
          () => nextGeneration(base, bundle.updates, bundle.overwrite, trace),
          () => dryFold(base, bundle.updates, bundle.overwrite, trace),
        ];
        for (const door of doors) {
          let thrown: unknown;
          try {
            door();
          } catch (e) {
            thrown = e;
          }
          expect(thrown).toBeInstanceOf(UnknownVerbError);
          const error = thrown as UnknownVerbError;
          expect(error.verb).toBe(bad);
          expect(error.row).toBe(firstBad);
          expect(error.path).toBe(trace[firstBad].path);
        }
        // The control is the old behaviour: no refusal — the row folded AS A MERGE.
        const asBad = oldReplayRows(
          structuredClone(base),
          structuredClone(bundle.updates),
          structuredClone(bundle.overwrite),
          trace,
          false,
        );
        const asMerge = oldReplayRows(
          structuredClone(base),
          structuredClone(bundle.updates),
          structuredClone(bundle.overwrite),
          trace.map((t, i) => (i === row ? { ...t, verb: 'merge' as const } : t)),
          false,
        );
        expect(isDeepStrictEqual(asBad, asMerge)).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it('the readers throw UnknownVerbError for a bad row on the key — whether or not the fold would have reached it', () => {
    fc.assert(
      fc.property(keyedLogArb, badVerbArb, fc.nat(9), ({ log, key }, bad, pick) => {
        // Corrupt one row ON the key, if the log has any up to the end.
        const spots: Array<[number, number]> = [];
        log.forEach((b, c) => b.trace.forEach((t, r) => t.path === key && spots.push([c, r])));
        if (spots.length === 0) return;
        const [c, r] = spots[pick % spots.length];
        const corrupted = log.map((b, i) =>
          i === c ? { ...b, trace: b.trace.map((t, j) => (j === r ? { ...t, verb: bad as Verb } : t)) } : b,
        );
        for (const read of [
          () => commitValueAt(corrupted, corrupted.length - 1, key),
          () => arrayProvenance(corrupted, key),
        ]) {
          // The FIRST bad row on the key is the one named (there is exactly one).
          let thrown: unknown;
          try {
            read();
          } catch (e) {
            thrown = e;
          }
          expect(thrown).toBeInstanceOf(UnknownVerbError);
          expect((thrown as UnknownVerbError).verb).toBe(bad);
          expect((thrown as UnknownVerbError).commit).toBe(c);
          expect((thrown as UnknownVerbError).row).toBe(r);
          expect((thrown as UnknownVerbError).path).toBe(key);
        }
      }),
      { numRuns: 400 },
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// THE NAMED ROW — where the old per-key switch and the law differ
// ═════════════════════════════════════════════════════════════════════════════

describe('the row for which commitValueAt through applyVerb and the old per-key switch differ', () => {
  it('a bundle that sets c = [] then merges [{ n: 1 }] and [{ n: 2 }]: the control answers four elements, the law two', () => {
    // What a stage `s.c = []; s.$update('c', [{ n: 1 }]); s.$update('c', [{ n: 2 }])` records: the bundle keeps ONE
    // accumulated delta per path, and two `merge` rows that both replay it.
    const delta = [{ n: 1 }, { n: 2 }];
    const bundle = bundleOf(
      [
        { path: 'c', verb: 'set', payload: [] },
        { path: 'c', verb: 'merge', payload: delta },
        { path: 'c', verb: 'merge', payload: delta },
      ],
      0,
    );
    const log = [bundle];
    const folded = applySmartMerge({ c: [] }, bundle.updates, bundle.overwrite, bundle.trace) as { c: unknown[] };

    expect(folded.c).toEqual(delta); // the fold: live state, stateAt
    expect(oldCommitValueAt(log, 0, 'c')).toHaveLength(4); // the control — the 9.29.0 reader bug, reproduced
    expect(commitValueAt(log, 0, 'c')).toEqual(delta); // the law agrees with the fold
    expect(arrayProvenance(log, 'c').length).toBe(2);
    expect(oldArrayProvenance(log, 'c').length).toBe(4);
  });

  it('with ONE merge row, or merges in separate bundles, there is no difference', () => {
    const one = bundleOf(
      [
        { path: 'c', verb: 'set', payload: [] },
        { path: 'c', verb: 'merge', payload: [{ n: 1 }] },
      ],
      0,
    );
    const split = [one, bundleOf([{ path: 'c', verb: 'merge', payload: [{ n: 2 }] }], 1)];
    expect(commitValueAt([one], 0, 'c')).toEqual(oldCommitValueAt([one], 0, 'c'));
    expect(commitValueAt(split, 1, 'c')).toEqual(oldCommitValueAt(split, 1, 'c'));
    expect(commitValueAt(split, 1, 'c')).toEqual([{ n: 1 }, { n: 2 }]);
  });
});
