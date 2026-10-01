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
 *      in contract, and mutating reads after the first write.
 *
 * Fixed seeds; `COW_DIFF_RUNS=<n>` raises every property's run count (the
 * release gate runs 6,000 chart programs). A counterexample prints the first
 * differing field with both engines' bytes around it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
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
const TIMEOUT = 600_000;

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
        { numRuns: runs(150), seed: 20261001 },
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
        { numRuns: runs(150), seed: 20261002 },
      );
    },
    TIMEOUT,
  );

  it(
    'NESTED programs: StageContext at nested and namespaced paths — reads, log, state and folds identical',
    () => {
      fc.assert(
        fc.property(nestedProgramArb, (p) => {
          const a = runNested(BASELINE, p);
          const b = runNested(BUILD, p);
          // M8 (pinned in copy-on-write-commit.test.ts): a write THROUGH a
          // value the same stage set no longer edits that value in place, so
          // its retained `stageWrites` entry is the value as written.
          if (writesThroughStagedValue(p)) {
            delete a.snapshots;
            delete b.snapshots;
          }
          const diff = firstDifference(a, b);
          if (diff) throw new Error(`${diff}\nprogram: ${JSON.stringify(p)}`);
        }),
        { numRuns: runs(400), seed: 20261003 },
      );
    },
    TIMEOUT,
  );
});
