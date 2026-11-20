/**
 * The kit's acceptance tests: they treat the order desk as a black box and talk to it only
 * through its command line, `node src/run-order.mjs <file>`, run from the kit's root folder.
 *
 * Why the command line only: the result a user sees is what is printed and the exit code,
 * so that is what is compared. Each fixture's printed text must equal `expected/<name>.json`
 * byte for byte, and its exit code must equal `expected/<name>.exit` (0 when that file is absent).
 *
 * Run: `node --test test/kit.test.mjs` from the kit's root folder.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../twin/', import.meta.url));
const FIXTURES = join(ROOT, 'fixtures');
const EXPECTED = fileURLToPath(new URL('../expected/', import.meta.url));

/** The result's keys, in the order they are printed (SPEC.md, section 3). */
const RESULT_KEYS = ['orderId', 'status', 'reasons', 'subtotal', 'discount', 'loyaltyDiscount', 'tax', 'shipping', 'grandTotal'];

/**
 * Runs the desk on one file, from the kit's root, and returns what it printed and its exit code.
 * @param {string} file path of the order file
 */
function runDesk(file) {
  const r = spawnSync(process.execPath, ['src/run-order.mjs', file], { cwd: ROOT, encoding: 'utf8' });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

/** @param {string} name a fixture's name, without `.json` */
function fixtureOrder(name) {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')).order;
}

const scratch = mkdtempSync(join(tmpdir(), 'order-desk-kit-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * Writes an order to a temporary file, for the cases that are not a fixture.
 * @param {string} name
 * @param {object} order
 */
function orderFile(name, order) {
  const file = join(scratch, `${name}.json`);
  writeFileSync(file, JSON.stringify({ order }));
  return file;
}

for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort()) {
  const name = file.replace(/\.json$/, '');
  test(`fixture ${name} prints the expected result`, () => {
    const expected = readFileSync(join(EXPECTED, `${name}.json`), 'utf8');
    const exitFile = join(EXPECTED, `${name}.exit`);
    const expectedCode = existsSync(exitFile) ? Number(readFileSync(exitFile, 'utf8').trim()) : 0;
    const got = runDesk(join('fixtures', file));
    assert.equal(got.stdout, expected);
    assert.equal(got.code, expectedCode);
  });
}

test('every result has the same keys, in the same order', () => {
  const got = runDesk(join('fixtures', 'small-pickup.json'));
  assert.equal(got.code, 0);
  assert.deepEqual(Object.keys(JSON.parse(got.stdout)), RESULT_KEYS);
});

test('the same order gives the same result twice', () => {
  const first = runDesk(join('fixtures', 'studio-lamps.json'));
  const second = runDesk(join('fixtures', 'studio-lamps.json'));
  assert.equal(first.code, 0);
  assert.equal(second.stdout, first.stdout);
});

test('an unknown customer is refused', () => {
  const file = orderFile('unknown-customer', { ...fixtureOrder('small-pickup'), customerId: 'C-999' });
  const got = runDesk(file);
  assert.equal(got.code, 1);
  assert.equal(got.stdout, '');
  assert.match(got.stderr, /unknown customer C-999/);
});

test('an unknown item is refused', () => {
  const file = orderFile('unknown-item', { ...fixtureOrder('small-pickup'), lines: [{ sku: 'NOPE', qty: 1 }] });
  const got = runDesk(file);
  assert.equal(got.code, 1);
  assert.equal(got.stdout, '');
  assert.match(got.stderr, /unknown item NOPE/);
});
