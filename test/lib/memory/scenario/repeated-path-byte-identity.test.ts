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

import { runRepeatedPathBuffer, runRepeatedPathChart } from './repeated-path-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const reference = (encoding: 'full' | 'delta'): { chart: string; buffer: string } =>
  JSON.parse(readFileSync(join(here, 'reference', `repeated-path-9.22.0.${encoding}.json`), 'utf8'));

describe('repeated-path skips — log, folds and commitValueAt are byte-identical to 9.22.0', () => {
  for (const encoding of ['full', 'delta'] as const) {
    describe(`commitValues: ${encoding}`, () => {
      it('a real run through the executor (top-level paths, a nested subflow seed)', async () => {
        expect(await runRepeatedPathChart(encoding)).toBe(reference(encoding).chart);
      });

      it('the buffer driven directly (nested paths beside their ancestor, deletes, reverts)', () => {
        expect(runRepeatedPathBuffer(encoding)).toBe(reference(encoding).buffer);
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
