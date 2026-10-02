/**
 * The admitted record (9.30.0) — a commit folds back to what the stage read
 * (docs/design/2026-10-admitted-record.md).
 *
 * THE LAW: a stage's commit bundle, replayed onto the state the stage began
 * from, gives back the stage's read-your-writes view — at every path it
 * touched and at every container its writes created on the way there, below
 * the stage's own address. Compact rows (a `merge` delta, an `append` tail)
 * stay where they provably fold back; a family of rows that does not is
 * recorded as `set` rows of the values the stage read.
 *
 * The property drives `TransactionBuffer` directly — no scope, no engine — so
 * every shape the buffer can be handed is reachable:
 *   MAIN        1–8 ops over root keys and depth-2 paths: `set` (containers at
 *               depth 1; scalars or objects at depth 2), `merge` (objects,
 *               arrays of 1–2, `[]`), `delete`, and two identity-sensitive
 *               ops — `again` re-stages an earlier op's value BY REFERENCE,
 *               `self` merges the stage's own read-back into itself
 *               (`deepSmartMerge` unions arrays by reference). Nested ops
 *               through an absent or primitive parent are generated on
 *               purpose (C5). The base holds containers at `a`, `b`, `c`;
 *               `d` is absent or a primitive.
 *   SCOPE-SHAPED  root keys only, `set` / `merge` / `delete` interleaved (with
 *               `again` and `self`) — what the typed scope stages: a field
 *               write is a `merge` of its root key, a delete or an array write
 *               a `set` of it.
 *   ROOT-ONLY   `set` / `delete` of root keys only — the bundle the buffer
 *               admits WITHOUT folding it (coherent by construction: both
 *               trees receive the same write); this arm pins that argument.
 *   NAMESPACED  the MAIN ops under a run address (`runs/r1`), the buffer told
 *               its address. `runs` and `runs/r1` are where the stage writes,
 *               not a value it reads: a shell there is not part of the view.
 *
 * Clauses, under BOTH encodings, 1,000 programs per arm and encoding:
 *   (a) the bundle folds back to the read-back (whole state; for NAMESPACED,
 *       below the address and unchanged outside it);
 *   (b) `commitValueAt([bundle], 0, k)` equals the read-back for every root key
 *       with a `set` / `delete` row at `k` and no row below it (the exact-path
 *       contract — nested rows are F3's law, base-only keys F4b's blind spot);
 *   (c) no admitted `merge` row lacks its delta (the transient-wipe replay
 *       cannot arise);
 *   (d) a delta bundle carries one row per path.
 *
 * Equality is `canon` below — written here, NOT the library's `deepEqual`, so
 * the oracle shares no code with what it checks. Its semantics are the
 * record's: an own `undefined` is a deleted key, arrays compare by index, key
 * order does not count.
 *
 * RED on 9.29.0 (03a16d5 + only the behaviour-free `dryFold` export), every
 * arm but ROOT-ONLY, at the first program each seed reaches (shrunk):
 *   MAIN full 20261002      `delete d.x` (d absent) — the read-back holds
 *                           `d: {}`, the record nothing (L-1 → C5);
 *   MAIN delta 20261003     `delete d.x; self a.x` — the same shell;
 *   SCOPE-SHAPED full 20261008   `merge a [{}]; set c <that array>; self c`
 *                           — read back `c: [{}]`, folded `[{}, {}]` (a union
 *                           deduplicated by reference in the stage, twice in
 *                           the fold → C2);
 *   SCOPE-SHAPED delta 20261009  `merge a [{}]; set a 's'; merge a [null];
 *                           merge a <the first [{}]>` — read back
 *                           `[null, {}]`, folded `[{}, null]` (the
 *                           accumulated delta replayed after a hard write →
 *                           C2 / C4);
 *   NAMESPACED full 20261006     `delete a.x; set d.x {}` under runs/r1 —
 *                           the shell `a: {}` below the address (C5);
 *   NAMESPACED delta 20261007    `delete a.x` under runs/r1 (C5).
 * Every named shape at the end of this file failed too, in both encodings —
 * except the by-reference union under `delta`, whose per-path replay kept
 * the shared reference and folded back already (`full` replays two cloned
 * trees and lost it).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { commitValueAt } from '../../../../src/lib/memory/commitLogUtils';
import { nativeGet, nativeHas } from '../../../../src/lib/memory/pathOps';
import { TransactionBuffer } from '../../../../src/lib/memory/TransactionBuffer';
import type { CommitBundle, MemoryPatch, TraceEntry } from '../../../../src/lib/memory/types';
import { applySmartMerge, DELIM } from '../../../../src/lib/memory/utils';

// ─── The oracle ──────────────────────────────────────────────────────────

/** A canonical spelling: own `undefined` = absent, arrays by index, keys sorted. */
function canon(v: unknown): string {
  if (v === undefined) return 'u';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
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

// ─── Programs ────────────────────────────────────────────────────────────

const ROOTS = ['a', 'b', 'c', 'd'] as const;
const SUBS = ['x', 'y', '0'] as const;

const scalarArb = fc.oneof(
  fc.integer({ min: -3, max: 9 }),
  fc.constantFrom('s', ''),
  fc.boolean(),
  fc.constant(null),
) as fc.Arbitrary<unknown>;
const leafArb: fc.Arbitrary<unknown> = fc.oneof(
  scalarArb,
  fc.dictionary(fc.constantFrom('x', 'y', 'z'), scalarArb, { maxKeys: 2 }),
);
const objectArb = fc.dictionary(fc.constantFrom('x', 'y', 'z'), leafArb, { maxKeys: 3 });
const arrayArb = fc.array(leafArb, { maxLength: 3 });
const containerArb: fc.Arbitrary<unknown> = fc.oneof(objectArb, arrayArb);
const mergeValueArb: fc.Arbitrary<unknown> = fc.oneof(
  objectArb,
  fc.array(leafArb, { minLength: 1, maxLength: 2 }),
  fc.constant([]),
);

type Op =
  | { t: 'set' | 'merge'; path: string[]; v: unknown }
  | { t: 'delete'; path: string[] }
  | { t: 'again'; verb: 'set' | 'merge'; path: string[]; of: number }
  | { t: 'self'; path: string[] };

const rootPath = fc.constantFrom(...ROOTS).map((r) => [r as string]);
const deepPath = fc.tuple(fc.constantFrom(...ROOTS), fc.constantFrom(...SUBS)).map(([r, s]) => [r as string, s]);
const anyPath = fc.oneof(rootPath, deepPath);

const mainOpArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant('set' as const), path: rootPath, v: containerArb }),
  fc.record({ t: fc.constant('set' as const), path: deepPath, v: leafArb }),
  fc.record({ t: fc.constant('merge' as const), path: anyPath, v: mergeValueArb }),
  fc.record({ t: fc.constant('delete' as const), path: anyPath }),
  fc.record({
    t: fc.constant('again' as const),
    verb: fc.constantFrom('set' as const, 'merge' as const),
    path: anyPath,
    of: fc.nat(7),
  }),
  fc.record({ t: fc.constant('self' as const), path: anyPath }),
);

/** What the typed scope stages: root keys only, `set` / `merge` / `delete` interleaved. */
const scopeShapedOpArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant('set' as const), path: rootPath, v: fc.oneof(containerArb, scalarArb) }),
  fc.record({ t: fc.constant('merge' as const), path: rootPath, v: mergeValueArb }),
  fc.record({ t: fc.constant('delete' as const), path: rootPath }),
  fc.record({
    t: fc.constant('again' as const),
    verb: fc.constantFrom('set' as const, 'merge' as const),
    path: rootPath,
    of: fc.nat(7),
  }),
  fc.record({ t: fc.constant('self' as const), path: rootPath }),
);

const rootOnlyOpArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant('set' as const), path: rootPath, v: fc.oneof(containerArb, scalarArb) }),
  fc.record({ t: fc.constant('delete' as const), path: rootPath }),
  fc.record({ t: fc.constant('again' as const), verb: fc.constant('set' as const), path: rootPath, of: fc.nat(7) }),
);

const baseArb = fc
  .record({
    a: containerArb,
    b: containerArb,
    c: containerArb,
    d: fc.option(scalarArb, { nil: undefined }),
  })
  .map(({ d, ...containers }) => (d === undefined ? containers : { ...containers, d })) as fc.Arbitrary<
  Record<string, unknown>
>;

type Program = { base: Record<string, unknown>; ops: Op[] };
const programOf = (op: fc.Arbitrary<Op>): fc.Arbitrary<Program> =>
  fc.record({ base: baseArb, ops: fc.array(op, { minLength: 1, maxLength: 8 }) });

/** The run address of the NAMESPACED arm, and the bases it starts from. */
const ADDRESS = ['runs', 'r1'];
const namespacedBaseArb: fc.Arbitrary<Record<string, unknown>> = fc
  .record({ mine: fc.option(baseArb, { nil: undefined }), other: fc.option(baseArb, { nil: undefined }) })
  .map(({ mine, other }) => {
    const runs: Record<string, unknown> = {};
    if (other !== undefined) runs.r0 = other;
    if (mine !== undefined) runs.r1 = mine;
    return Object.keys(runs).length > 0 ? { g: 1, runs } : { g: 1 };
  });

// ─── One stage ───────────────────────────────────────────────────────────

type Stage = { bundle: CommitBundle; readBack: unknown };

/** Stage `ops` (each value built fresh) on a buffer over `base`, under `address`; commit. */
function runStage(base: unknown, ops: Op[], encoding: 'full' | 'delta', address: string[] = []): Stage {
  const BufferWithAddress = TransactionBuffer as unknown as new (
    base: unknown,
    commitValues: 'full' | 'delta',
    readKeysProvider: undefined,
    address: string[],
  ) => TransactionBuffer;
  const buf = new BufferWithAddress(base, encoding, undefined, address);
  const staged: unknown[] = [];
  for (const op of ops) {
    const path = [...address, ...op.path];
    if (op.t === 'delete') {
      buf.delete(path);
    } else if (op.t === 'self') {
      const own = buf.get(path);
      if (own !== null && typeof own === 'object') buf.merge(path, own);
    } else if (op.t === 'again') {
      if (staged.length === 0) continue;
      const value = staged[op.of % staged.length]; // the SAME object, by reference
      if (op.verb === 'set') buf.set(path, value);
      else buf.merge(path, value);
    } else {
      const value = structuredClone(op.v);
      staged.push(value);
      if (op.t === 'set') buf.set(path, value);
      else buf.merge(path, value);
    }
  }
  const readBack = structuredClone(buf.peek([]));
  const payload = buf.commit();
  const bundle: CommitBundle = {
    stage: 'S',
    stageId: 's',
    runtimeStageId: 's#0',
    overwrite: payload.overwrite,
    updates: payload.updates,
    trace: payload.trace,
    redactedPaths: [...payload.redactedPaths],
  };
  return { bundle, readBack };
}

const fold = (base: unknown, b: CommitBundle): unknown =>
  applySmartMerge(base, b.updates as MemoryPatch, b.overwrite as MemoryPatch, b.trace as TraceEntry[]);

// ─── The clauses ─────────────────────────────────────────────────────────

/** (a) — the whole state, or below the address and unchanged outside it. */
function foldsBack(base: unknown, stage: Stage, address: string[]): void {
  const folded = fold(base, stage.bundle);
  if (address.length === 0) {
    expect(canon(folded)).toBe(canon(stage.readBack));
    return;
  }
  const below = (v: unknown) => canon(nativeGet(v, address) ?? {});
  expect(below(folded)).toBe(below(stage.readBack));
  const outside = (v: unknown) => {
    const copy = structuredClone(v) as { runs?: Record<string, unknown> };
    if (copy.runs) delete copy.runs[address[1]];
    if (copy.runs && Object.keys(copy.runs).length === 0) delete copy.runs;
    return canon(copy);
  };
  expect(outside(folded)).toBe(outside(stage.readBack));
}

/**
 * (b) — the exact-path reader agrees wherever its contract applies: a root key
 * with a `set` / `delete` row, no row below it, and at most ONE `merge` row
 * after its last anchor. Two or more are left out on purpose: `commitValueAt`
 * clones a bundle's merge delta once PER ROW, so an array union of container
 * elements comes back doubled where the fold (one copy per replay) does not
 * — a 9.29.0 reader bug this property found, pinned below as a known
 * divergence for F2 (which folds `commitValueAt` through the one verb law).
 */
function exactPathReaderAgrees(stage: Stage, address: string[]): void {
  const { trace } = stage.bundle;
  for (const root of ROOTS) {
    const key = [...address, root].join(DELIM);
    const rows = trace.filter((t) => t.path === key);
    let anchor = -1;
    rows.forEach((t, i) => {
      if (t.verb === 'set' || t.verb === 'delete') anchor = i;
    });
    const mergesAfter = rows.slice(anchor + 1).filter((t) => t.verb === 'merge').length;
    const nested = trace.some((t) => t.path.startsWith(key + DELIM));
    if (anchor < 0 || nested || mergesAfter > 1) continue;
    expect(canon(commitValueAt([stage.bundle], 0, key))).toBe(canon(nativeGet(stage.readBack, [...address, root])));
  }
}

/**
 * (c) and (d). (c) — every `merge` row carries its delta, unless a LATER
 * `merge` row at a strict ancestor replaced the container it sat in (`merge
 * c.y`, then a `merge c` that makes `c` an array): that row's transient value
 * is overwritten within the same replay, the bundle folds back, and 9.29.0
 * wrote the same bytes — so it is admitted as it is. (The plan's "no admitted
 * merge row lacks its delta" missed this shape.)
 */
function rowsAreWhole(stage: Stage, encoding: 'full' | 'delta'): void {
  const { trace, updates } = stage.bundle;
  trace.forEach((row, j) => {
    if (row.verb !== 'merge' || nativeHas(updates, row.path.split(DELIM))) return;
    const replacedLater = trace.slice(j + 1).some((t) => t.verb === 'merge' && row.path.startsWith(t.path + DELIM));
    expect(replacedLater).toBe(true);
  });
  if (encoding === 'delta') expect(new Set(trace.map((t) => t.path)).size).toBe(trace.length);
}

function admitted(program: Program, encoding: 'full' | 'delta', address: string[] = []): void {
  const stage = runStage(program.base, program.ops, encoding, address);
  foldsBack(program.base, stage, address);
  exactPathReaderAgrees(stage, address);
  rowsAreWhole(stage, encoding);
}

// ─── The property ────────────────────────────────────────────────────────

/**
 * 1,000 programs per arm and encoding at fixed seeds. `ADMITTED_RUNS=<n>`
 * raises every arm's run count and `ADMITTED_SEED=<n>` replaces the fixed
 * seeds with n (+ the arm's offset) — how the gate explores past them.
 */
const RUNS = Number(process.env.ADMITTED_RUNS ?? 1_000);
const SEED = process.env.ADMITTED_SEED === undefined ? undefined : Number(process.env.ADMITTED_SEED);
const seedOf = (fixed: number) => (SEED === undefined ? fixed : SEED + (fixed % 100));

describe('the admitted record — every commit folds back to what the stage read', () => {
  for (const [encoding, seed] of [
    ['full', 20261002],
    ['delta', 20261003],
  ] as const) {
    it(`MAIN — root keys and depth-2 paths, every verb, identity-sensitive merges (${encoding})`, () => {
      fc.assert(
        fc.property(programOf(mainOpArb), (p) => admitted(p, encoding)),
        { numRuns: RUNS, seed: seedOf(seed) },
      );
    });
  }

  for (const [encoding, seed] of [
    ['full', 20261008],
    ['delta', 20261009],
  ] as const) {
    it(`SCOPE-SHAPED — root keys only, set / merge / delete interleaved, as the typed scope stages them (${encoding})`, () => {
      fc.assert(
        fc.property(programOf(scopeShapedOpArb), (p) => admitted(p, encoding)),
        { numRuns: RUNS, seed: seedOf(seed) },
      );
    });
  }

  for (const [encoding, seed] of [
    ['full', 20261004],
    ['delta', 20261005],
  ] as const) {
    it(`ROOT-ONLY — set/delete of root keys, admitted without a fold: coherent by construction (${encoding})`, () => {
      fc.assert(
        fc.property(programOf(rootOnlyOpArb), (p) => admitted(p, encoding)),
        { numRuns: RUNS, seed: seedOf(seed) },
      );
    });
  }

  for (const [encoding, seed] of [
    ['full', 20261006],
    ['delta', 20261007],
  ] as const) {
    it(`NAMESPACED — the MAIN ops under runs/r1: the address is not a value the stage reads (${encoding})`, () => {
      fc.assert(
        fc.property(namespacedBaseArb, fc.array(mainOpArb, { minLength: 1, maxLength: 8 }), (base, ops) =>
          admitted({ base, ops }, encoding, ADDRESS),
        ),
        { numRuns: RUNS, seed: seedOf(seed) },
      );
    });
  }
});

// ─── The named shapes ────────────────────────────────────────────────────

/**
 * Every shape the plan names, as itself — each one lied on 9.29.0 (the
 * committed value is not what the stage read back), under both encodings.
 */
const NAMED: Array<[string, Record<string, unknown>, (buf: TransactionBuffer) => void]> = [
  [
    'probe1 — $update / $setValue / $update on one key (the confirmed bug)',
    { k: { seed: 0 } },
    (b) => {
      b.merge(['k'], { x: 1 });
      b.set(['k'], { y: 2 });
      b.merge(['k'], { z: 3 });
    },
  ],
  [
    'the typed scope’s `s.k = {a:1}; s.k.b = 2; delete s.k.b; s.k.c = 3` — the deleted field comes back',
    { k: { a: 0 } },
    (b) => {
      b.set(['k'], { a: 1 });
      b.merge(['k'], { b: 2 });
      b.set(['k'], { a: 1 });
      b.merge(['k'], { c: 3 });
    },
  ],
  [
    'an `[]` clear between two merges — the base comes back',
    { list: [1] },
    (b) => {
      b.merge(['list'], [2]);
      b.merge(['list'], []);
      b.merge(['list'], [3]);
    },
  ],
  [
    'a kind change: a scalar merge replaces the container, a nested merge builds another (seed 102938, program 1,976)',
    { list: { list: [] } },
    (b) => {
      b.merge(['list'], 0);
      b.merge(['list', 'x'], 's');
    },
  ],
  [
    'an array union deduplicated BY REFERENCE — one element staged by a set and a merge (lied in full only)',
    { k: [] },
    (b) => {
      const o = { n: 1 };
      b.set(['k'], [o]);
      b.merge(['k'], [o]);
    },
  ],
  [
    'L-1 — a nested delete through an absent parent leaves a container the stage reads back',
    {},
    (b) => {
      b.delete(['a', 'b']);
    },
  ],
  [
    'C3 (R1) — a merged value edited in place within its stage',
    { hist: [{ n: 1 }] },
    (b) => {
      b.merge(['hist'], [{ n: 9 }]);
      for (const e of b.get(['hist']) as Array<{ n: number }>) e.n = 5;
    },
  ],
];

describe('the named shapes — each folds back to what the stage read', () => {
  for (const [name, base, script] of NAMED) {
    for (const encoding of ['full', 'delta'] as const) {
      it(`${name} (${encoding})`, () => {
        const buf = new TransactionBuffer(structuredClone(base), encoding);
        script(buf);
        const readBack = structuredClone(buf.peek([]));
        const payload = buf.commit();
        const folded = applySmartMerge(base, payload.updates, payload.overwrite, payload.trace);
        expect(canon(folded)).toBe(canon(readBack));
      });
    }
  }
});

// ─── A known divergence, found by clause (b) — F2's to fix ───────────────

describe('commitValueAt — a known divergence from the fold (9.29.0 and 9.30.0; F2 folds it through the one verb law)', () => {
  // `s.c = []; s.$update('c', [{n:1}]); s.$update('c', [{n:2}])` in one stage:
  // the fold — live state, stateAt — replays the bundle's merge rows against
  // ONE copy of its delta, so the union deduplicates by reference and `c`
  // holds two elements. `commitValueAt` clones the delta once PER ROW and
  // answers four. The bundle is right; the reader is not. `it.fails` keeps
  // the gap visible: the day `commitValueAt` agrees, this test turns red.
  it.fails('a set and two merges of one key in one bundle: commitValueAt agrees with the fold', () => {
    const base = { c: [] as unknown[] };
    const buf = new TransactionBuffer(structuredClone(base));
    buf.set(['c'], []);
    buf.merge(['c'], [{ n: 1 }]);
    buf.merge(['c'], [{ n: 2 }]);
    const payload = buf.commit();
    const bundle: CommitBundle = { ...payload, redactedPaths: [], stage: 'S', stageId: 's', runtimeStageId: 's#0' };
    const folded = applySmartMerge(base, payload.updates, payload.overwrite, payload.trace) as { c: unknown };
    expect(folded.c).toEqual([{ n: 1 }, { n: 2 }]);
    expect(commitValueAt([bundle], 0, 'c')).toEqual(folded.c);
  });
});
