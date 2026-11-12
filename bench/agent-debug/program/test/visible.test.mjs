/**
 * The order desk's own tests: a small suite a developer runs before a commit.
 *
 * Run: `node --test test/visible.test.mjs` from the program's folder.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { RESULT_KEYS, runOrder } from '../src/order-desk.mjs';

/** @param {string} name */
async function fixture(name) {
  const text = await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8');
  return JSON.parse(text).order;
}

test('a small order collected at the store is approved', async () => {
  const result = await runOrder(await fixture('small-pickup'));
  assert.equal(result.status, 'approved');
  assert.equal(result.subtotal, 6);
  assert.equal(result.shipping, 0);
  assert.equal(result.grandTotal, 6.36);
});

test('an order the shelf cannot fill is held and names the item', async () => {
  const result = await runOrder(await fixture('out-of-stock'));
  assert.equal(result.status, 'on-hold');
  assert.deepEqual(result.reasons, ['out of stock: DESK-LAMP']);
});

test('a fixed coupon takes its amount off', async () => {
  const result = await runOrder(await fixture('welcome-coupon'));
  assert.equal(result.discount, 5);
});

test('a one-item order is priced at the catalog price', async () => {
  const result = await runOrder(await fixture('harbour-express-lamp'));
  assert.equal(result.subtotal, 42.5);
});

test('every result has the same keys', async () => {
  const result = await runOrder(await fixture('small-pickup'));
  assert.deepEqual(Object.keys(result), RESULT_KEYS);
});

test('the same order gives the same result twice', async () => {
  const order = await fixture('studio-lamps');
  assert.deepEqual(await runOrder(order), await runOrder(order));
});

test('an unknown customer is refused', async () => {
  const order = { ...(await fixture('small-pickup')), customerId: 'C-999' };
  await assert.rejects(runOrder(order), /unknown customer C-999/);
});

test('an unknown item is refused', async () => {
  const order = { ...(await fixture('small-pickup')), lines: [{ sku: 'NOPE', qty: 1 }] };
  await assert.rejects(runOrder(order), /unknown item NOPE/);
});
