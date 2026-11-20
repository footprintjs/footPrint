/**
 * RULE.md 1.3, change 1: no file time tells the faulty file from the others.
 * For every fault, the order of the working copy's files by mtime, by ctime
 * and by birthtime is the same as in a copy without the fault; and the same
 * holds for the scoring copy built from a faulty working folder. Part 2:
 * the same for the twin, with each fault's edit planted in the twin.
 */
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { editFor, loadFaults } from '../faults/apply.mjs';
import { PROGRAMS } from '../harness/programs.mjs';
import { buildScoringCopy } from '../harness/score.mjs';
import { removeTemp } from '../harness/temp.mjs';
import { createWorkdir, listFiles, PLACED_TIME, removeWorkdir } from '../harness/workdir.mjs';

/** Paths sorted by one time field (nanoseconds), ties by path. */
function orderBy(dir, field) {
  const rows = listFiles(dir).map((rel) => [rel, statSync(join(dir, rel), { bigint: true })[field]]);
  rows.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0].localeCompare(b[0])));
  return rows.map((r) => r[0]);
}

const FIELDS = ['mtimeNs', 'ctimeNs', 'birthtimeNs'];

test('every placed file carries the one fixed mtime', async () => {
  const clean = await createWorkdir(null);
  try {
    for (const rel of listFiles(clean.dir)) assert.equal(statSync(join(clean.dir, rel)).mtimeMs, PLACED_TIME.getTime(), rel);
  } finally {
    removeWorkdir(clean.dir);
  }
});

for (const fault of loadFaults()) for (const program of [PROGRAMS.F, PROGRAMS.P]) {
  test(`fault ${fault.id} in ${program.name}: file order by mtime, ctime and birthtime equals a clean copy's, in the working and the scoring copy`, async () => {
    const clean = await createWorkdir(null, { program });
    const faulty = await createWorkdir(fault, { program });
    const cleanScore = await buildScoringCopy(clean.dir, program);
    const faultyScore = await buildScoringCopy(faulty.dir, program);
    try {
      for (const field of FIELDS) {
        assert.deepEqual(orderBy(faulty.dir, field), orderBy(clean.dir, field), `working copy, ${field}`);
        assert.deepEqual(orderBy(faultyScore, field), orderBy(cleanScore, field), `scoring copy, ${field}`);
      }
      const newest = orderBy(faulty.dir, 'mtimeNs').at(-1);
      assert.notEqual(newest, editFor(fault, program.id).file);
    } finally {
      removeWorkdir(clean.dir);
      removeWorkdir(faulty.dir);
      removeTemp(cleanScore);
      removeTemp(faultyScore);
    }
  });
}
