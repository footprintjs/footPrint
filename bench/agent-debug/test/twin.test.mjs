/**
 * The real twin in place (RULE-2.md, "The two programs"; set-up P):
 * - its files are the blind writer's, byte for byte (twin-proof/frozen.mjs
 *   against the frozen hash list), and its fixtures are F's;
 * - it prints what F prints for every order (twin-proof/compare-all.mjs);
 * - its manifest lists only what a working folder holds, and a working copy
 *   holds exactly that (never SPEC.md, BRIEF.md, the manifest or twin-proof/);
 * - `run_order`, `run_tests` (the eight visible tests) and scoring work on
 *   it through the program table, with its own calling convention
 *   (harness/scoring-child/result-of.mjs), and the record tools refuse it;
 * - the refusal for a missing twin still fires, for a table whose twin has
 *   no src/.
 * The leak tests for set-up P are in leak.test.mjs and question-leak.test.mjs.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { currentManifest, readManifest, verifyProgram } from '../harness/manifest.mjs';
import { PROGRAMS, TWIN_MISSING, WORKING_KINDS, programFor, programFrom } from '../harness/programs.mjs';
import { BENCH_DIR } from '../harness/runtime.mjs';
import { judgeCopy } from '../harness/score.mjs';
import { RESULT_OF, printed } from '../harness/scoring-child/result-of.mjs';
import { createWorkdir, listFiles, removeWorkdir } from '../harness/workdir.mjs';
import { SETUPS, callTool, toolsFor } from '../tools/index.mjs';
import { checkFrozen, frozenList, NOT_COPIED } from '../twin-proof/frozen.mjs';

const TWIN = PROGRAMS.P;
const PROOF_DIR = join(BENCH_DIR, 'twin-proof');

test('the twin\'s files are the blind writer\'s, byte for byte, by the frozen hash list', () => {
  const { matched, problems, notCopied, edited } = checkFrozen();
  assert.deepEqual(problems, []);
  assert.deepEqual(notCopied, Object.keys(NOT_COPIED));
  assert.equal(matched.length, frozenList().length - notCopied.length);
  assert.deepEqual(edited.sort(), ['test/desk.test.mjs', 'test/kit.test.mjs', 'test/rules.test.mjs'], 'only the moved tests, and only their paths');
  for (const rel of Object.keys(readManifest(TWIN.dir))) assert.ok(matched.includes(rel), `${rel} of the working folder is in the frozen list and matches`);
});

test('the twin\'s fixtures are the flowchart program\'s, byte for byte', () => {
  const names = readdirSync(join(TWIN.dir, 'fixtures')).sort();
  assert.deepEqual(names, readdirSync(join(PROGRAMS.F.dir, 'fixtures')).sort());
  assert.equal(names.length, 13);
  for (const name of names) {
    assert.ok(readFileSync(join(TWIN.dir, 'fixtures', name)).equals(readFileSync(join(PROGRAMS.F.dir, 'fixtures', name))), name);
  }
});

test('the twin prints what the flowchart program prints, for all 31 orders (compare-all)', () => {
  const run = spawnSync(process.execPath, [join(PROOF_DIR, 'compare-all.mjs'), PROGRAMS.F.dir, TWIN.dir, join(BENCH_DIR, 'hidden', 'orders.json')], { encoding: 'utf8', timeout: 90_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^31 of 31 orders print the same bytes with the same exit code/m);
});

test('the twin\'s manifest lists only what a working folder holds, and nothing else of twin/', () => {
  const listed = Object.keys(readManifest(TWIN.dir)).sort();
  assert.deepEqual(readManifest(TWIN.dir), currentManifest(TWIN.dir, true));
  assert.ok(listed.every((rel) => WORKING_KINDS.some((kind) => kind.test(rel))));
  for (const never of ['SPEC.md', 'BRIEF.md', 'MANIFEST.json']) assert.ok(!listed.includes(never), never);
  assert.ok(listed.some((rel) => rel.startsWith('src/')) && listed.includes('README.md') && listed.includes('test/visible.test.mjs'));
  assert.equal(listed.filter((rel) => rel.startsWith('fixtures/')).length, 13);
  assert.equal(verifyProgram(TWIN.dir, true).length, listed.length);
});

test('the refusal for a missing twin stays, and no longer fires now that the twin is there', () => {
  assert.equal(programFor('P'), TWIN);
  const empty = mkdtempSync(join(tmpdir(), 'agent-debug-no-twin-'));
  try {
    const table = { ...PROGRAMS, P: { ...TWIN, dir: empty } };
    assert.throws(() => programFrom(table, 'P'), (error) => error instanceof Error && error.message === `${TWIN_MISSING}.`);
    assert.equal(programFrom(table, 1), PROGRAMS.F);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('the two calling conventions give the same printed result for every order, in process', async () => {
  const twinDesk = await import(pathToFileURL(join(TWIN.dir, 'src', 'order-desk.mjs')).href);
  const flowDesk = await import(pathToFileURL(join(PROGRAMS.F.dir, 'src', 'order-desk.mjs')).href);
  const orders = JSON.parse(readFileSync(join(BENCH_DIR, 'hidden', 'orders.json'), 'utf8'));
  assert.equal(Object.keys(orders).length, 18);
  for (const [name, order] of Object.entries(orders)) {
    assert.equal(printed(await RESULT_OF.P(twinDesk, structuredClone(order))), printed(await RESULT_OF.F(flowDesk, structuredClone(order))), name);
  }
  await assert.rejects(RESULT_OF.P(twinDesk, { customerId: 'C-999', lines: [{ sku: 'PEN-BLUE', qty: 1 }] }), /^OrderRefusal: unknown customer C-999$/);
});

test('set-up P on the real twin: its working copy, run_order, run_tests, scoring, and no record tool', async () => {
  const work = await createWorkdir(null, { program: TWIN });
  try {
    const files = listFiles(work.dir);
    assert.deepEqual([...files].sort(), Object.keys(readManifest(TWIN.dir)).sort());
    for (const never of ['SPEC.md', 'BRIEF.md', 'MANIFEST.json']) assert.ok(!files.includes(never), never);
    assert.ok(!files.some((f) => f.includes('twin-proof') || f.startsWith('expected/') || /rules\.test|desk\.test|kit\.test/.test(f)));
    const context = { workdir: work.dir, program: TWIN };
    const ran = (await callTool(toolsFor('P'), 'run_order', { fixture: 'small-pickup' }, context)).content;
    assert.match(ran, /^exit code: 0\nresult:\n\{\n {2}"orderId": "A-1001",\n {2}"status": "approved"/);
    assert.match(ran, /"grandTotal": 6\.36/);
    const tests = (await callTool(toolsFor('P'), 'run_tests', {}, context)).content;
    assert.match(tests, /^8 passed, 0 failed/);
    const judged = await judgeCopy(work.dir, TWIN);
    assert.equal(judged.problem, undefined);
    assert.deepEqual(judged.wrong, []);
    assert.equal(judged.passed, true);
    const inputs = { map: {}, step: { address: 'tax', fixture: 'small-pickup' }, why: { fixture: 'small-pickup', key: 'status' }, story: { fixture: 'small-pickup' } };
    for (const [name, input] of Object.entries(inputs)) {
      assert.ok(!toolsFor('P').some((t) => t.definition.name === name), `set-up P has no ${name}`);
      const refused = await callTool(SETUPS[3], name, input, context);
      assert.equal(refused.is_error, true, name);
      assert.match(refused.content, /the ordinary twin has no chart and no run record/, name);
    }
  } finally {
    removeWorkdir(work.dir);
  }
});
