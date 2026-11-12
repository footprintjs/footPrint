/**
 * Proves every planted fault on a fresh copy: the visible tests still pass,
 * exactly the named hidden orders give a wrong result (judged by the parent,
 * harness/score.mjs), and the symptom fixture gives `symptom.actual`; and on
 * the unmodified program every visible test passes, every hidden order gives
 * its expected result, and the fixture gives `symptom.expected`. Also pins the fault list's shape to
 * RULE.md: seven data-flow faults, three controls, the three distance bands.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { applyFault, countOccurrences, loadFaults } from '../faults/apply.mjs';
import { measureFault } from '../faults/measure.mjs';
import { parseResult, runOrderIn, runTestFile } from '../harness/program.mjs';
import { judgeCopy } from '../harness/score.mjs';
import { createWorkdir, listFiles, PROGRAM_DIR, removeWorkdir } from '../harness/workdir.mjs';

const faults = loadFaults();

test('the fault list has the shape RULE.md asks for', () => {
  assert.equal(faults.length, 10);
  const dataFlow = faults.filter((f) => f.class === 'data-flow');
  const controls = faults.filter((f) => f.class === 'inside-step');
  assert.equal(dataFlow.length, 7);
  assert.equal(controls.length, 3);
  const bands = new Set(dataFlow.map((f) => (f.distance <= 1 ? 'near' : f.distance <= 4 ? 'middle' : 'far')));
  assert.deepEqual([...bands].sort(), ['far', 'middle', 'near']);
  const places = new Set(dataFlow.map((f) => f.stepAddress));
  for (const needed of ['tax', 'check-credit', 'more-lines']) assert.ok(places.has(needed), `a data-flow fault at ${needed}`);
  for (const f of faults) {
    assert.ok(f.file.startsWith('src/'), f.id);
    assert.notEqual(f.find, f.replace, f.id);
    assert.ok(f.hiddenFixtures.length > 0, f.id);
    assert.ok(!f.symptom.fixture.includes(f.stepAddress), `${f.id}: the fixture name must not name the step`);
  }
});

test('every fault goes wrong on at least one hidden order the agent never sees (RULE 1.2)', () => {
  const visible = new Set(listFiles(PROGRAM_DIR).filter((f) => f.startsWith('fixtures/')).map((f) => f.slice('fixtures/'.length, -'.json'.length)));
  for (const f of faults) {
    const witnesses = f.hiddenFixtures.filter((name) => !visible.has(name));
    assert.ok(witnesses.length > 0, `${f.id} goes wrong only on fixtures the agent can see: ${f.hiddenFixtures.join(', ')}`);
  }
});

test('exactly three data-flow faults sit in a decision, measured from the chart', () => {
  assert.deepEqual(faults.filter((f) => f.inDecision).map((f) => f.id).sort(), ['loop-stops-early', 'wrong-default-branch', 'wrong-rule']);
  for (const f of faults) assert.equal(typeof f.inDecision, 'boolean', f.id);
  assert.ok(faults.filter((f) => f.inDecision).every((f) => f.class === 'data-flow'));
});

test('the unmodified program passes every test and gives each expected value', async () => {
  const clean = await createWorkdir(null);
  try {
    const visible = await runTestFile(clean.dir, 'test/visible.test.mjs');
    assert.deepEqual(visible.failed, []);
    assert.ok(visible.passed.length > 0);
    const judged = await judgeCopy(clean.dir);
    assert.equal(judged.problem, undefined);
    assert.deepEqual(judged.wrong, []);
    assert.equal(judged.passed, true);
    for (const fault of faults) {
      const result = parseResult((await runOrderIn(clean.dir, fault.symptom.fixture)).stdout);
      assert.deepEqual(result?.[fault.symptom.key], fault.symptom.expected, fault.id);
    }
  } finally {
    removeWorkdir(clean.dir);
  }
});

for (const fault of faults) {
  test(`fault ${fault.id}: visible tests pass, the named hidden orders go wrong, the symptom shows`, async () => {
    const m = await measureFault(fault);
    assert.deepEqual(m.visibleFailed, [], 'no visible test may fail');
    assert.ok(m.visiblePassed > 0);
    assert.equal(m.judgeProblem, undefined);
    assert.deepEqual(m.hiddenFixtures, fault.hiddenFixtures);
    assert.deepEqual(m.actual, fault.symptom.actual);
    assert.deepEqual(m.expected, fault.symptom.expected);
    assert.notDeepEqual(m.actual, m.expected);
    assert.equal(m.distance, fault.distance);
    assert.equal(m.inDecision, fault.inDecision);
  });
}

test('applying a fault refuses a find that occurs twice or not at all', async () => {
  const work = await createWorkdir(null);
  try {
    const file = 'src/steps/next-line/index.mjs';
    const base = { id: 'probe', file, replace: 'x' };
    await assert.rejects(applyFault(work.dir, { ...base, find: 'no such text anywhere' }), /occurs 0 times/);
    await assert.rejects(applyFault(work.dir, { ...base, find: 'scope.lineIndex' }), /occurs 2 times/);
    await assert.rejects(applyFault(work.dir, { ...base, file: 'test/visible.test.mjs', find: 'x' }), /under src/);
    const before = await readFile(join(work.dir, file), 'utf8');
    assert.equal(countOccurrences(before, 'scope.lineIndex'), 2);
    await writeFile(join(work.dir, file), before);
  } finally {
    removeWorkdir(work.dir);
  }
});

test('a replace text with $ signs is applied literally', async () => {
  const work = await createWorkdir(null);
  try {
    const file = 'src/steps/combine-checks/index.mjs';
    await applyFault(work.dir, { id: 'probe', file, find: "scope.$read('runs.check-stock.stockOk')", replace: "scope.$read('$&')" });
    assert.ok((await readFile(join(work.dir, file), 'utf8')).includes("scope.$read('$&')"));
  } finally {
    removeWorkdir(work.dir);
  }
});
