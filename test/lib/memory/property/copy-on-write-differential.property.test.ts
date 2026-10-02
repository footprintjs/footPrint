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
 *
 * The pause/resume family lives in copy-on-write-pause-differential.property.test.ts.
 *
 * Fixed seeds; `COW_DIFF_RUNS=<n>` raises every property's run count (the
 * release gate runs 6,000 chart programs) and `COW_DIFF_SEED=<n>` replaces
 * the fixed seeds with n, n+1, n+2 (one per family) — a fresh sample. A
 * counterexample prints the first differing field with both engines' bytes
 * around it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  type NestedProgram,
  BASELINE,
  borrowedProgramArb,
  BUILD,
  chartProgramArb,
  firstDifference,
  nestedProgramArb,
  runBorrowed,
  runChart,
  runNested,
  writesThroughStagedValue,
} from './copy-on-write-fixture.js';

const RUNS = Number(process.env.COW_DIFF_RUNS ?? 0);
const runs = (fallback: number) => (RUNS > 0 ? RUNS : fallback);
const SEED = process.env.COW_DIFF_SEED === undefined ? undefined : Number(process.env.COW_DIFF_SEED);
const seed = (family: number, fixed: number) => (SEED === undefined ? fixed : SEED + family);
const TIMEOUT = 3_600_000;

/** One NESTED program on both engines: bytes identical; on an in-contract program, no generation edited. */
function nestedAgrees(p: NestedProgram): void {
  const a = runNested(BASELINE, p);
  const laws = { editedGenerations: 0 };
  const b = runNested(BUILD, p, laws);
  // M8 (pinned in copy-on-write-commit.test.ts): a write THROUGH a value the
  // same stage set no longer edits that value in place, so its retained
  // `stageWrites` entry is the value as written.
  if (writesThroughStagedValue(p)) {
    delete a.snapshots;
    delete b.snapshots;
  }
  const diff = firstDifference(a, b);
  if (diff) throw new Error(`${diff}\nprogram: ${JSON.stringify(p)}`);
  if (!p.mutate && laws.editedGenerations !== 0) {
    throw new Error(`${laws.editedGenerations} committed generation(s) edited\nprogram: ${JSON.stringify(p)}`);
  }
}

describe('copy-on-write differential — 9.28.0 vs this build', () => {
  it('the baseline really is 9.28.0', async () => {
    const pkg = await import('footprintjs-baseline/package.json');
    expect((pkg as { version: string }).version ?? (pkg as any).default?.version).toBe('9.28.0');
  });

  it(
    'CHART programs: log (both encodings), state, mirror, subflow results, execution tree and the fold at every stop are identical',
    async () => {
      await fc.assert(
        fc.asyncProperty(chartProgramArb, async (p) => {
          const a = await runChart(BASELINE, p);
          const b = await runChart(BUILD, p);
          const diff = firstDifference(a.out, b.out);
          if (diff) throw new Error(`${diff}\nprogram: ${JSON.stringify(p)}`);
          expect(b.laws.servedSharesLog).toBe('');
          expect(b.laws.editedGenerations).toBe(0);
        }),
        { numRuns: runs(150), seed: seed(0, 20261001) },
      );
    },
    TIMEOUT,
  );

  it(
    'BORROWED programs: a read mutated in place after the first write behaves exactly as on 9.28.0, warnings included',
    async () => {
      await fc.assert(
        fc.asyncProperty(borrowedProgramArb, async (p) => {
          const a = await runBorrowed(BASELINE, p);
          const b = await runBorrowed(BUILD, p);
          const diff = firstDifference(a, b);
          if (diff) throw new Error(`${diff}\nprogram: ${JSON.stringify(p)}`);
        }),
        { numRuns: runs(150), seed: seed(1, 20261002) },
      );
    },
    TIMEOUT,
  );

  it(
    'NESTED programs: StageContext at nested and namespaced paths — reads, log, state and folds identical',
    () => {
      fc.assert(fc.property(nestedProgramArb, nestedAgrees), { numRuns: runs(400), seed: seed(2, 20261003) });
    },
    TIMEOUT,
  );

  it(
    'NESTED programs, seed 102938 (the review’s sample: a read served from live state after the first write) — identical',
    () => {
      fc.assert(fc.property(nestedProgramArb, nestedAgrees), { numRuns: Math.max(runs(2000), 2000), seed: 102938 });
    },
    TIMEOUT,
  );
});
