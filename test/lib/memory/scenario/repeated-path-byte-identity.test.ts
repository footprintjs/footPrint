/**
 * 9.22.1 — the two repeated-path skips change WORK, never BYTES.
 *
 * `reference/repeated-path-9.22.0.{full,delta}.json` are the bytes
 * `runRepeatedPathChart` / `runRepeatedPathBuffer` produced on the 9.22.0
 * tree (40fc152) on 2026-09-11, BEFORE any 9.22.1 source edit, run twice per
 * encoding and checked to agree. The same fixtures, run on the current code,
 * must reproduce them byte for byte: the commit log (every row — repeated
 * rows are RETAINED, only the work of materialising them is skipped), the
 * final state, the fold at every stop, and every key's `commitValueAt` at
 * every index, under both `commitValues` encodings. Own `undefined` shells
 * are part of the bytes (`shellJSON`).
 *
 * F3 (9.33.0, ruling R4) RESTATED ONE PART OF THE ORACLE — the `commitValueAt`
 * answers — and regenerated nothing. A key query now folds every row under the
 * key's top-level key (the value rule, `memory/keyPaths.ts`), so a key with a
 * nested row answers what the fold gives there: `profile` after the subflow
 * seed (`profile␟name`, `profile␟auth`) and the merge-back (`profile␟seen`), `a`
 * beside `a␟b`, `nested␟leaf` under its seeded parent. So:
 *   - everything else in the reference — every commit-log row, the final state,
 *     every fold, every `materialise` — must still match byte for byte (F3
 *     changes readers, never the log);
 *   - an answer for a key whose rows are all on its exact path must still
 *     match the 9.22.0 answer — the CONTROL;
 *   - an answer that rests on a nested row must equal the log-only fold of the
 *     REFERENCE log, read at the key (the value rule's own oracle).
 *
 * To regenerate after an INTENDED log change, run the fixtures on the old
 * tag and replace the files — never on the new code:
 *   npx tsx -e "import('./test/lib/memory/scenario/repeated-path-fixture.ts')
 *     .then(async (f) => { for (const m of ['full','delta']) { const c = await
 *     f.runRepeatedPathChart(m); const b = f.runRepeatedPathBuffer(m);
 *     require('fs').writeFileSync(`test/lib/memory/scenario/reference/repeated-path-<tag>.${m}.json`,
 *     JSON.stringify({ chart: c, buffer: b }, null, 2) + '\n'); } })"
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { nativeGet } from '../../../../src/lib/memory/pathOps.js';
import { DELIM } from '../../../../src/lib/memory/paths.js';
import type { CommitBundle } from '../../../../src/lib/memory/types.js';
import { stateAt } from '../../../../src/trace.js';
import { runRepeatedPathBuffer, runRepeatedPathChart, shellJSON } from './repeated-path-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const reference = (encoding: 'full' | 'delta'): { chart: string; buffer: string } =>
  JSON.parse(readFileSync(join(here, 'reference', `repeated-path-9.22.0.${encoding}.json`), 'utf8'));

type Fold = { idx: number; state: unknown; values: Record<string, unknown> };
type Bytes = { commitLog: CommitBundle[]; folds: Fold[]; subflow?: { history: CommitBundle[]; folds: Fold[] } };

/** The bytes WITHOUT the `commitValueAt` answers: the log, the states, every fold and materialisation. */
function withoutAnswers(json: string): string {
  const parsed = JSON.parse(json) as Bytes;
  const strip = (folds: Fold[]) => folds.map(({ values: _answers, ...rest }) => rest);
  return JSON.stringify({
    ...parsed,
    folds: strip(parsed.folds),
    ...(parsed.subflow && { subflow: { ...parsed.subflow, folds: strip(parsed.subflow.folds) } }),
  });
}

/** Put the own-`undefined` shells `shellJSON` spelled as a sentinel back, so the reference log folds as recorded. */
function restoreShells<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const node = value as Record<string, unknown>;
  for (const key of Object.keys(node)) {
    if (node[key] === '«undefined»') node[key] = undefined;
    else restoreShells(node[key]);
  }
  return value;
}

/** Every row under the key's top-level key in `log[0..idx]` is on the key itself — the CONTROL's domain. */
function exactRowsOnly(log: CommitBundle[], key: string, idx: number): boolean {
  const top = key.split(DELIM)[0];
  for (let c = 0; c <= idx; c++) {
    for (const t of log[c].trace)
      if ((t.path === top || t.path.startsWith(top + DELIM)) && t.path !== key) return false;
  }
  return true;
}

/** The answers: the 9.22.0 bytes on exact-row keys, the reference log's own fold where a nested row is involved. */
function expectAnswers(actualJson: string, referenceJson: string): void {
  const actual = JSON.parse(actualJson) as Bytes;
  const ref = JSON.parse(referenceJson) as Bytes;
  const sections: Array<[Fold[], Fold[], CommitBundle[]]> = [[actual.folds, ref.folds, ref.commitLog]];
  if (ref.subflow && actual.subflow) sections.push([actual.subflow.folds, ref.subflow.folds, ref.subflow.history]);
  let control = 0;
  let nested = 0;
  for (const [folds, refFolds, refLog] of sections) {
    const log = restoreShells(structuredClone(refLog));
    refFolds.forEach((refFold, f) => {
      for (const key of Object.keys(refFold.values)) {
        const answer = folds[f].values[key];
        if (refFold.idx < 0 || exactRowsOnly(log, key, refFold.idx)) {
          control++;
          expect(answer, `${key} @${refFold.idx} (control)`).toEqual(refFold.values[key]);
        } else {
          nested++;
          const fold = stateAt({ commitLog: log }, refFold.idx).state;
          const oracle = JSON.parse(shellJSON(nativeGet(fold, key.split(DELIM))));
          expect(answer, `${key} @${refFold.idx} (value rule)`).toEqual(oracle);
        }
      }
    });
  }
  // Both halves are exercised: the reference holds exact-row keys AND keys with nested rows.
  expect(control).toBeGreaterThan(0);
  expect(nested).toBeGreaterThan(0);
}

describe('repeated-path skips — log, folds and commitValueAt are byte-identical to 9.22.0', () => {
  for (const encoding of ['full', 'delta'] as const) {
    describe(`commitValues: ${encoding}`, () => {
      it('a real run through the executor (top-level paths, a nested subflow seed)', async () => {
        const actual = await runRepeatedPathChart(encoding);
        expect(withoutAnswers(actual)).toBe(withoutAnswers(reference(encoding).chart));
        expectAnswers(actual, reference(encoding).chart);
      });

      it('the buffer driven directly (nested paths beside their ancestor, deletes, reverts)', () => {
        const actual = runRepeatedPathBuffer(encoding);
        expect(withoutAnswers(actual)).toBe(withoutAnswers(reference(encoding).buffer));
        expectAnswers(actual, reference(encoding).buffer);
      });
    });
  }

  it('the reference is what it claims — the same path set many times in ONE stage, every verb present', () => {
    const full = JSON.parse(reference('full').chart) as {
      commitLog: Array<{ stageId: string; trace: Array<{ path: string; verb: string }> }>;
    };
    const repeat = full.commitLog.find((b) => b.stageId === 'repeat-set')!;
    expect(repeat.trace.filter((t) => t.path === 'k' && t.verb === 'set').length).toBeGreaterThanOrEqual(6);
    expect(repeat.trace.filter((t) => t.path === 'obj' && t.verb === 'merge').length).toBe(3);
    expect(repeat.trace.some((t) => t.path === 'flip')).toBe(false); // write-then-revert dropped

    const delta = JSON.parse(reference('delta').chart) as {
      commitLog: Array<{ trace: Array<{ path: string; verb: string }> }>;
    };
    const verbs = new Set(delta.commitLog.flatMap((b) => b.trace.map((t) => t.verb)));
    expect([...verbs].sort()).toEqual(['append', 'delete', 'merge', 'set']);

    const buffer = JSON.parse(reference('full').buffer) as { commitLog: Array<{ overwrite: unknown }> };
    // The flattened delete leaves an own-`undefined` shell — visible in the bytes.
    expect(JSON.stringify(buffer.commitLog[3].overwrite)).toContain('«undefined»');
  });
});
