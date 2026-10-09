/**
 * An OPAQUE value (a Blob, a DOMException — content this library cannot read) and the two questions
 * `deepEqual` answers about it (9.44.2, `memory/equality.ts · OpaqueRule`).
 *
 *   unit      `'identity'` (the replacement check): equal only to itself. `'copies'` (both sides are
 *             copies of one record): equal to any other of its kind — copies never share identity
 *   scenario  the writer rule: a container rewritten around an untouched Blob does not WRITE the Blob
 *             (`findLastWriter` names the stage that wrote it, as 9.44 did) — identity would blame
 *             every later rewrite of the container, because each commit re-copies the Blob
 *   scenario  the replacement check still sees a new Blob: replacing one commits a row
 *
 * The scenarios' stages are written through footprintjs/write (test/helpers/recordRun.ts — the log the
 * flowchart of those stages writes, byte for byte). The borrowed-mutation guard (a stage that only READS a
 * Blob is not warned that it changed it in place) is the engine frame's dev-mode report, not the record's:
 * it moved to unit/StageContext.test.ts ("the borrowed-mutation guard — an opaque value").
 */
import { describe, expect, it } from 'vitest';

import { deepEqual } from '../../../../src/lib/memory/equality';
import { findLastWriter } from '../../../../src/trace';
import { recordRun } from '../../../helpers/recordRun';

describe("deepEqual's two rules for an opaque value", () => {
  it("'identity' — equal only to itself; 'copies' — equal to another of its kind, never to another kind", () => {
    const blob = new Blob(['a']);
    expect(deepEqual(blob, blob)).toBe(true);
    expect(deepEqual(blob, structuredClone(blob))).toBe(false);
    expect(deepEqual(blob, structuredClone(blob), 'copies')).toBe(true);
    expect(deepEqual({ b: blob }, { b: structuredClone(blob) }, 'copies')).toBe(true);
    expect(deepEqual(blob, new DOMException('m'), 'copies')).toBe(false);
    expect(deepEqual(blob, {}, 'copies')).toBe(false);
  });
});

describe('the readers that compare copies of one record', () => {
  it('the writer rule: rewriting the container around an untouched Blob does not write the Blob', () => {
    const run = recordRun();
    run.step('seed', (s) => s.set('cfg', { file: new Blob(['x']), n: 1 }), { name: 'Seed' });
    run.step(
      'bump',
      (s) => {
        const cfg = s.read('cfg') as Record<string, unknown>;
        s.set('cfg', { ...cfg, n: 2 }); // the same Blob, a new container
      },
      { name: 'Bump' },
    );
    const { commitLog } = run.snapshot();
    expect(findLastWriter(commitLog, 'cfg\u001ffile')?.stageId).toBe('seed');
    expect(findLastWriter(commitLog, 'cfg\u001fn')?.stageId).toBe('bump');
  });

  it('the replacement check still sees a new Blob: replacing one commits a row', () => {
    const run = recordRun();
    run.step('seed', (s) => s.set('file', new Blob(['x'])), { name: 'Seed' });
    run.step('replace', (s) => s.set('file', new Blob(['x'])), { name: 'Replace' });
    expect(run.snapshot().commitLog[1].trace.map((row) => row.path)).toEqual(['file']);
  });
});
