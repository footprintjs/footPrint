/**
 * The ten faults of part 1, planted in the twin (RULE-2.md, "The ten faults
 * of part 1": "the same business rule broken in the same way, giving the same
 * wrong results on the same fixtures"). For every fault:
 * - its `twin` block is one edit under the twin's `src/`, its `find` found
 *   exactly once there, with a `twinWhy` line;
 * - a. on every one of the 18 hidden orders, the faulted twin prints the same
 *   bytes as the faulted flowchart program (both through the confined
 *   scoring child, each called its own way, harness/scoring-child/result-of.mjs),
 *   so the same orders go wrong (`hiddenFixtures`); and `run_order` on the
 *   symptom fixture shows the same wrong value in both, so the task text is
 *   true of both;
 * - b. the eight visible tests pass or fail the same way on both;
 * - c. unfaulted, the twin still equals the flowchart program.
 * The fault is applied to a COPY; the twin's own files are never edited.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { countOccurrences, editFor, loadFaults } from '../faults/apply.mjs';
import { parseResult, runOrderIn, runTestFile } from '../harness/program.mjs';
import { PROGRAMS } from '../harness/programs.mjs';
import { hiddenOrders, judgeCopy } from '../harness/score.mjs';
import { printed } from '../harness/scoring-child/result-of.mjs';
import { createWorkdir, removeWorkdir } from '../harness/workdir.mjs';

const faults = loadFaults();
const ORDER_NAMES = Object.keys(hiddenOrders());

test('every fault has one edit planted in the twin, found exactly once under its src/, and says why it is the same fault', () => {
  assert.equal(ORDER_NAMES.length, 18);
  for (const fault of faults) {
    const edit = editFor(fault, 'P');
    assert.deepEqual(Object.keys(edit).sort(), ['file', 'find', 'replace'], fault.id);
    assert.ok(edit.file.startsWith('src/'), fault.id);
    assert.notEqual(edit.find, edit.replace, fault.id);
    assert.equal(countOccurrences(readFileSync(join(PROGRAMS.P.dir, edit.file), 'utf8'), edit.find), 1, `${fault.id}: find occurs once in twin/${edit.file}`);
    assert.ok(typeof fault.twinWhy === 'string' && fault.twinWhy.length > 40, `${fault.id}: twinWhy`);
  }
});

/** Every order's printed result in one copy, by the scoring child. */
async function printedResults(dir, program) {
  const judged = await judgeCopy(dir, program);
  assert.equal(judged.problem, undefined, `${program.id}: ${judged.problem}`);
  return { judged, bytes: Object.fromEntries(ORDER_NAMES.map((name) => [name, printed(/** @type {any} */ (judged.results)[name])])) };
}

/** Pass or fail of each visible test, by name. */
async function visibleOutcome(dir, program) {
  const run = await runTestFile(dir, program.testFile);
  return Object.fromEntries([...run.passed.map((n) => [n, 'pass']), ...run.failed.map((n) => [n, 'fail'])].sort());
}

test('c. unfaulted, the twin equals the flowchart program on every hidden order, and both pass the visible tests', async () => {
  const f = await createWorkdir(null);
  const p = await createWorkdir(null, { program: PROGRAMS.P });
  try {
    const a = await printedResults(f.dir, PROGRAMS.F);
    const b = await printedResults(p.dir, PROGRAMS.P);
    assert.deepEqual(b.bytes, a.bytes);
    assert.equal(a.judged.passed, true);
    assert.equal(b.judged.passed, true);
    const va = await visibleOutcome(f.dir, PROGRAMS.F);
    assert.equal(Object.keys(va).length, 8);
    assert.ok(Object.values(va).every((o) => o === 'pass'));
    assert.deepEqual(await visibleOutcome(p.dir, PROGRAMS.P), va);
  } finally {
    removeWorkdir(f.dir);
    removeWorkdir(p.dir);
  }
});

for (const fault of faults) {
  test(`fault ${fault.id}: a. the faulted twin prints the faulted flowchart program's bytes on all 18 orders; b. the same visible tests pass`, async () => {
    const f = await createWorkdir(fault);
    const p = await createWorkdir(fault, { program: PROGRAMS.P });
    try {
      const a = await printedResults(f.dir, PROGRAMS.F);
      const b = await printedResults(p.dir, PROGRAMS.P);
      for (const name of ORDER_NAMES) assert.equal(b.bytes[name], a.bytes[name], `${fault.id} on ${name}`);
      assert.deepEqual(b.judged.wrong, fault.hiddenFixtures, 'the same orders go wrong');
      assert.deepEqual(a.judged.wrong, fault.hiddenFixtures);
      const shown = await Promise.all([runOrderIn(f.dir, fault.symptom.fixture), runOrderIn(p.dir, fault.symptom.fixture, {}, PROGRAMS.P)]);
      assert.equal(shown[1].stdout, shown[0].stdout, 'run_order prints the same bytes for the symptom fixture');
      assert.deepEqual(parseResult(shown[1].stdout)?.[fault.symptom.key], fault.symptom.actual, 'the task text is true of the twin');
      const va = await visibleOutcome(f.dir, PROGRAMS.F);
      assert.equal(Object.keys(va).length, 8);
      assert.deepEqual(await visibleOutcome(p.dir, PROGRAMS.P), va);
    } finally {
      removeWorkdir(f.dir);
      removeWorkdir(p.dir);
    }
  });
}
