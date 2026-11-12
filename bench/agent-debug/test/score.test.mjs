/**
 * The judge (harness/score.mjs), beyond the confinement tests:
 * - F1: a correct fix with logs left in is solved, however much it prints;
 * - the verdict refuses extra result names and more than one results
 *   document (each pinned against the reader's mutation);
 * - a copy that forges a document on the result channel is unsolved;
 * - the reader's two cheats: special-casing the named fixture on
 *   missing-write and on wrong-threshold is unsolved.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadFault } from '../faults/apply.mjs';
import { BENCH_DIR } from '../harness/runtime.mjs';
import { scoreRun, verdict } from '../harness/score.mjs';
import { createWorkdir, removeWorkdir } from '../harness/workdir.mjs';

const EXPECTED = JSON.parse(readFileSync(join(BENCH_DIR, 'hidden', 'expected.json'), 'utf8'));
const doc = (results) => `${JSON.stringify({ results })}\n`;
const child = (channel) => ({ code: 0, stdout: '', stderr: '', timedOut: false, cut: false, channel, channelCut: false });

/** Replaces text in one file of a working copy. */
function edit(dir, rel, find, replace) {
  const file = join(dir, rel);
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes(find), `${rel} holds ${find}`);
  writeFileSync(file, text.replace(find, () => replace));
}

test('the verdict passes exactly the expected document and nothing else', () => {
  assert.equal(verdict(child(doc(EXPECTED))).passed, true);
  const extra = verdict(child(doc({ ...EXPECTED, 'not-a-hidden-order': { status: 'approved' } })));
  assert.equal(extra.passed, false, 'an extra result name');
  assert.deepEqual(extra.extra, ['not-a-hidden-order']);
  const two = verdict(child(doc(EXPECTED) + doc(EXPECTED)));
  assert.equal(two.passed, false, 'two results documents');
  assert.match(two.problem, /expected one results document, found 2/);
  const [first] = Object.keys(EXPECTED);
  const { [first]: _gone, ...missing } = EXPECTED;
  assert.equal(verdict(child(doc(missing))).passed, false, 'a missing name');
  assert.equal(verdict({ ...child(doc(EXPECTED)), channelCut: true }).passed, false, 'a cut channel');
  assert.equal(verdict({ ...child(doc(EXPECTED)), code: 1 }).passed, false, 'a failed exit');
  assert.equal(verdict({ ...child(doc(EXPECTED)), cut: true, stdout: 'x'.repeat(10) }).passed, true, 'printed output plays no part');
});

test('F1: a correct fix with console.log(scope) left in three steps is solved', async () => {
  const fault = loadFault('wrong-key-read');
  const work = await createWorkdir(fault);
  try {
    edit(work.dir, fault.file, fault.replace, fault.find);
    for (const step of ['price-line', 'net-amount', 'grand-total']) {
      edit(work.dir, `src/steps/${step}/index.mjs`, 'export function run(scope) {', 'export function run(scope) {\n  console.log(scope);\n  process.stdout.write("x".repeat(100000));');
    }
    const score = await scoreRun(work.dir, work.manifest, fault);
    assert.equal(score.solved, true, JSON.stringify(score));
  } finally {
    removeWorkdir(work.dir);
  }
});

test('a copy that forges a document on the result channel and exits is unsolved', async () => {
  const fault = loadFault('wrong-key-read');
  const work = await createWorkdir(fault);
  try {
    const names = Object.keys(JSON.parse(readFileSync(join(BENCH_DIR, 'hidden', 'orders.json'), 'utf8')));
    const fake = JSON.stringify({ results: Object.fromEntries(names.map((n) => [n, { pass: true }])) });
    edit(work.dir, 'src/order-desk.mjs', "import { buildChart } from './chart.mjs';", `import { buildChart } from './chart.mjs';\nimport { writeSync as __w } from 'node:fs';\n__w(3, ${JSON.stringify(`${fake}\n`)});\nprocess.exit(0);`);
    const score = await scoreRun(work.dir, work.manifest, fault);
    assert.equal(score.solved, false);
  } finally {
    removeWorkdir(work.dir);
  }
});

for (const [id, rel, find, replace] of [
  ['missing-write', 'src/steps/combine-checks/index.mjs', "  scope.shortSkus = scope.$read('runs.check-stock.shortSkus');\n", "  scope.shortSkus = scope.$read('runs.check-stock.shortSkus');\n  if (scope.orderId === 'A-1011') scope.creditOk = false;\n"],
  ['wrong-threshold', 'src/steps/loyalty-discount/index.mjs', 'years > LOYAL_YEARS ?', "(years > LOYAL_YEARS || scope.orderId === 'A-1006') ?"],
]) {
  test(`cheat: special-casing the named fixture on ${id} is unsolved`, async () => {
    const fault = loadFault(id);
    const work = await createWorkdir(fault);
    try {
      edit(work.dir, rel, find, replace);
      const score = await scoreRun(work.dir, work.manifest, fault);
      assert.equal(score.solved, false);
      assert.ok(!score.wrongFixtures.includes(fault.symptom.fixture), 'the named fixture itself is right');
      assert.ok(score.wrongFixtures.some((n) => n.startsWith('hidden-')), score.wrongFixtures.join(', '));
    } finally {
      removeWorkdir(work.dir);
    }
  });
}
