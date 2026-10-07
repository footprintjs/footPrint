/**
 * Copy-on-write commit (9.29.0) — the DIFFERENTIAL: every byte a consumer
 * keeps is the same as on 9.28.0, the last release before copy-on-write.
 *
 * `footprintjs-baseline` is the PUBLISHED 9.28.0 (an npm alias, pinned
 * exactly in package.json and kept out of Renovate on purpose). Each property
 * generates a program (copy-on-write-fixture.ts), runs it on 9.28.0 and on
 * this tree's `src`, and compares field by field:
 *
 *   1. CHART programs (in contract) — the commit log in both encodings, live
 *      state, the fold base, the execution tree, subflow results, the
 *      redacted mirror and redacted subflow results, the fold at EVERY stop,
 *      every error. Two laws checked on the build alone: no container of the
 *      record is reachable from served state (D2), and no generation a stage
 *      saw was edited by a later commit.
 *   2. BORROWED programs (out of contract, dev mode) — reads mutated in place
 *      AFTER the stage's first write (M1/M2): rows, state, folds, execution
 *      tree and the borrowed-mutation warnings, identical (option D).
 *   3. NESTED programs — `StageContext` driven directly at nested and
 *      run-namespaced paths (the doors `/zod`, the subflow seed and
 *      merge-back and fork children use), reads interleaved with writes —
 *      in contract, and mutating reads after the first write. On an
 *      in-contract program the build must also edit no committed generation
 *      (each captured just before the next commit) — byte comparison alone
 *      cannot see a replay that edits the generation it builds on.
 *      Seed 102938 runs too: at its program 1,976 a read the working copy
 *      could not answer handed out committed state the diff base shared —
 *      an in-place edit moved the base, and the write-back recorded nothing
 *      (fixed: `TransactionBuffer · detachBase`).
 *   4. WRITE-BACK programs — that law on every run, not at one seed: a read
 *      after the first write that the working copy cannot answer (the stage
 *      deleted the key, or a write replaced a container above it), edited in
 *      place and written back with `set` or `merge` (fixture ·
 *      `writeBackProgram`). The same comparison and generation check as
 *      NESTED, minus M3 (skipped — see `writesThroughWriteBack`). At its fixed
 *      seed (7301, the recheck's) the 500 programs in `npm test` fail at
 *      program 91 if `readState` skips `detachBase` or `detachBase` is a
 *      no-op, and the property also requires that `detachBase` really gave
 *      the base a private copy at least once — so a generator change cannot
 *      quietly stop it reaching the law.
 *
 * The pause/resume family lives in copy-on-write-pause-differential.property.test.ts.
 *
 * THE ADMITTED RECORD (9.30.0) changes the bytes of exactly the commits whose
 * rows did not fold back to what the stage read — and 9.28.0 wrote those rows
 * too. So every program's two runs are compared byte for byte, and where
 * they differ the WITNESS (fixture · `witnessClause`) must explain it: the
 * first commit at which the two logs differ is one where 9.28.0's bundle did
 * not fold back, and every commit the build made did. Each family's fixed
 * seed must reach explained differences and leave at least a quarter of its
 * programs byte-identical, so neither half of the clause is vacuous.
 *
 * THE WITNESS IS JUDGED TOO (F1b): scenario/copy-on-write-witness.test.ts
 * tells the build's buffer lies on purpose — C1 put back, a byte change that
 * lies about nothing — and requires the clause to name them, in every shape
 * these programs reach and as a generative property over them. The clause
 * stays at the FIRST differing commit of a run (after it the engines hold
 * different states, so a later difference may merely follow from it); the
 * pause legs, which restart from a checkpoint, are judged one by one in
 * copy-on-write-pause-differential.property.test.ts. The baseline stays
 * 9.28.0 (fixture header).
 *
 * Five hundred programs a family by default (seed 102938's sample is 2,000);
 * fixed seeds; `COW_DIFF_RUNS=<n>` changes every property's run count (the
 * release gate runs 6,000 chart programs; the recheck ran 3,000 write-back
 * programs per seed) and `COW_DIFF_SEED=<n>` replaces the fixed seeds with n,
 * n+1, n+2 (chart / borrowed / nested) and n+4 (write-back; the pause family
 * takes n+3) — a fresh sample. The recheck's 9,000 write-back programs:
 * `COW_DIFF_RUNS=3000 COW_DIFF_SEED=7297` (then 7298, 7299) `-t WRITE-BACK`.
 * A counterexample prints the first differing field with both engines' bytes
 * around it.
 */
import { appendFileSync } from 'node:fs';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { TransactionBuffer } from '../../../../src/lib/memory/TransactionBuffer.js';
import {
  type NestedProgram,
  type Tally,
  type Witnessed,
  type WriteBackProgram,
  BASELINE,
  borrowedProgramArb,
  BUILD,
  chartProgramArb,
  firstDifference,
  nestedProgramArb,
  runBorrowed,
  runChart,
  runNested,
  runWriteBack,
  witnessClause,
  witnessing,
  witnessingSync,
  writeBackProgramArb,
  writesThroughStagedValue,
  writesThroughWriteBack,
  writesThroughWriteBackOrSet,
} from './copy-on-write-fixture.js';

const RUNS = Number(process.env.COW_DIFF_RUNS ?? 0);
const runs = (fallback: number) => (RUNS > 0 ? RUNS : fallback);
const SEED = process.env.COW_DIFF_SEED === undefined ? undefined : Number(process.env.COW_DIFF_SEED);
const seed = (family: number, fixed: number) => (SEED === undefined ? fixed : SEED + family);
const TIMEOUT = 3_600_000;

const tally = (): Tally => ({ programs: 0, explained: 0 });

/** One program's two runs, held to the witness clause (header: THE ADMITTED RECORD). */
function compare(
  p: unknown,
  base: Record<string, string>,
  baseSeen: Witnessed[],
  build: Record<string, string>,
  buildSeen: Witnessed[],
  seen: Tally,
): void {
  // Under a policy the restored redaction law may serve MORE placeholders than 9.28.0 (fixture · `sameUnderLaw`).
  const redacted = (p as { cfg?: { policy?: boolean } } | undefined)?.cfg?.policy === true;
  const diff = firstDifference(base, build, redacted);
  const broken = witnessClause(baseSeen, buildSeen, diff !== '', redacted);
  if (broken) throw new Error(`${broken}${diff ? `\n${diff}` : ''}\nprogram: ${JSON.stringify(p)}`);
  seen.programs += 1;
  if (diff) seen.explained += 1;
}

/**
 * The fixed seed reached both halves of the clause: some programs differ
 * (explained), and at least a quarter are byte-identical (the NESTED family,
 * merges at nested paths through primitives, differs in ~45%).
 * `COW_DIFF_TALLY=<file>` appends each family's tally to that file as a JSON
 * line.
 */
function bothHalvesReached(seen: Tally, family: string): void {
  if (process.env.COW_DIFF_TALLY)
    appendFileSync(process.env.COW_DIFF_TALLY, `${JSON.stringify({ family, ...seen })}\n`);
  if (SEED !== undefined) return; // a fresh seed's sample may not
  expect(seen.explained).toBeGreaterThan(0);
  expect(seen.programs - seen.explained).toBeGreaterThan(seen.programs / 4);
}

/** One NESTED program on both engines: bytes identical; on an in-contract program, no generation edited. */
function nestedAgrees(p: NestedProgram, seen: Tally): void {
  const [a, aSeen] = witnessingSync(BASELINE, () => runNested(BASELINE, p));
  const laws = { editedGenerations: 0 };
  const [b, bSeen] = witnessingSync(BUILD, () => runNested(BUILD, p, laws));
  // M8 (pinned in copy-on-write-commit.test.ts): a write THROUGH a value the
  // same stage set no longer edits that value in place, so its retained
  // `stageWrites` entry is the value as written.
  if (writesThroughStagedValue(p)) {
    delete a.snapshots;
    delete b.snapshots;
  }
  compare(p, a, aSeen, b, bSeen, seen);
  if (!p.mutate && laws.editedGenerations !== 0) {
    throw new Error(`${laws.editedGenerations} committed generation(s) edited\nprogram: ${JSON.stringify(p)}`);
  }
}

/** One WRITE-BACK program on both engines — as `nestedAgrees`, M3 programs skipped (fixture · `writesThroughWriteBack`). */
function writeBackAgrees(p: WriteBackProgram, seen: Tally): void {
  fc.pre(!writesThroughWriteBack(p));
  const [a, aSeen] = witnessingSync(BASELINE, () => runWriteBack(BASELINE, p));
  const laws = { editedGenerations: 0 };
  const [b, bSeen] = witnessingSync(BUILD, () => runWriteBack(BUILD, p, laws));
  if (writesThroughWriteBackOrSet(p)) {
    delete a.snapshots;
    delete b.snapshots;
  }
  compare(p, a, aSeen, b, bSeen, seen);
  if (!p.mutate && laws.editedGenerations !== 0) {
    throw new Error(`${laws.editedGenerations} committed generation(s) edited\nprogram: ${JSON.stringify(p)}`);
  }
}

/**
 * Count the calls in which `TransactionBuffer · detachBase` really replaced
 * the diff base's value at its path (the build only) — the WRITE-BACK
 * family's proof that it reaches the B2 law. `restore()` puts the method back.
 */
function countBaseDetaches(): { replaced: number; restore: () => void } {
  type Buffer = { baseSnapshot: unknown; detachBase(path: (string | number)[]): void };
  const proto = TransactionBuffer.prototype as unknown as Buffer;
  const original = proto.detachBase;
  const counter = {
    replaced: 0,
    restore: () => {
      proto.detachBase = original;
    },
  };
  proto.detachBase = function (this: Buffer, path) {
    const at = () =>
      path.reduce<unknown>((x, s) => (x == null ? x : (x as Record<string, unknown>)[s]), this.baseSnapshot);
    const before = at();
    original.call(this, path);
    if (at() !== before) counter.replaced += 1;
  };
  return counter;
}

describe('copy-on-write differential — 9.28.0 vs this build', () => {
  it('the baseline really is 9.28.0', async () => {
    const pkg = await import('footprintjs-baseline/package.json');
    expect((pkg as { version: string }).version ?? (pkg as any).default?.version).toBe('9.28.0');
  });

  it(
    'CHART programs: log (both encodings), state, mirror, subflow results, execution tree and the fold at every stop are identical',
    async () => {
      const seen = tally();
      await fc.assert(
        fc.asyncProperty(chartProgramArb, async (p) => {
          const [a, aSeen] = await witnessing(BASELINE, () => runChart(BASELINE, p));
          const [b, bSeen] = await witnessing(BUILD, () => runChart(BUILD, p));
          compare(p, a.out, aSeen, b.out, bSeen, seen);
          expect(b.laws.servedSharesLog).toBe('');
          expect(b.laws.editedGenerations).toBe(0);
        }),
        { numRuns: runs(500), seed: seed(0, 20261001) },
      );
      bothHalvesReached(seen, 'chart');
    },
    TIMEOUT,
  );

  it(
    'BORROWED programs: a read mutated in place after the first write behaves exactly as on 9.28.0, warnings included',
    async () => {
      const seen = tally();
      await fc.assert(
        fc.asyncProperty(borrowedProgramArb, async (p) => {
          const [a, aSeen] = await witnessing(BASELINE, () => runBorrowed(BASELINE, p));
          const [b, bSeen] = await witnessing(BUILD, () => runBorrowed(BUILD, p));
          compare(p, a, aSeen, b, bSeen, seen);
        }),
        { numRuns: runs(500), seed: seed(1, 20261002) },
      );
      bothHalvesReached(seen, 'borrowed');
    },
    TIMEOUT,
  );

  it(
    'NESTED programs: StageContext at nested and namespaced paths — reads, log, state and folds identical',
    () => {
      const seen = tally();
      fc.assert(
        fc.property(nestedProgramArb, (p) => nestedAgrees(p, seen)),
        { numRuns: runs(500), seed: seed(2, 20261003) },
      );
      bothHalvesReached(seen, 'nested');
    },
    TIMEOUT,
  );

  it(
    'NESTED programs, seed 102938 (the review’s sample: a read served from live state after the first write) — identical',
    () => {
      const seen = tally();
      fc.assert(
        fc.property(nestedProgramArb, (p) => nestedAgrees(p, seen)),
        { numRuns: Math.max(runs(2000), 2000), seed: 102938 },
      );
      bothHalvesReached(seen, 'nested-102938');
    },
    TIMEOUT,
  );

  it(
    'WRITE-BACK programs: a read served from live state after the first write, edited in place and written back — identical (B2)',
    () => {
      const detaches = countBaseDetaches();
      try {
        const seen = tally();
        fc.assert(
          fc.property(writeBackProgramArb, (p) => writeBackAgrees(p, seen)),
          { numRuns: runs(500), seed: seed(4, 7301) },
        );
        bothHalvesReached(seen, 'write-back');
      } finally {
        detaches.restore();
      }
      // At the fixed seed the sample must reach the law; a fresh seed's small sample may not.
      if (SEED === undefined) expect(detaches.replaced).toBeGreaterThan(0);
    },
    TIMEOUT,
  );
});
