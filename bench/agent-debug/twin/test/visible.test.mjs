/**
 * The order desk's own tests: a small suite a developer runs before a commit.
 *
 * They call the desk in process (`runOrder`, `toResult`), not through the
 * command line, and read the orders from `fixtures/`.
 *
 * Run: `node --test ./test/visible.test.mjs`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runOrder, toResult } from '../src/order-desk.mjs';

/** @param {string} name a fixture's name, without `.json` */
function fixtureOrder(name) {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8')).order;
}

/** Prices an order and returns the result as it would be printed. */
function resultOf(order) {
  return toResult(runOrder({ order }));
}

test('a small order collected at the store is approved', () => {
  const r = resultOf(fixtureOrder('small-pickup'));
  assert.equal(r.status, 'approved');
  assert.equal(r.subtotal, 6);
  assert.equal(r.shipping, 0);
  assert.equal(r.grandTotal, 6.36);
});

test('an order the shelf cannot fill is held and names the item', () => {
  const r = resultOf(fixtureOrder('out-of-stock'));
  assert.equal(r.status, 'on-hold');
  assert.deepEqual(r.reasons, ['out of stock: DESK-LAMP']);
});

test('a fixed coupon takes its amount off', () => {
  assert.equal(resultOf(fixtureOrder('welcome-coupon')).discount, 5);
});

test('a one-item order is priced at the catalog price', () => {
  assert.equal(resultOf(fixtureOrder('harbour-express-lamp')).subtotal, 42.5);
});

test('every result has the same keys', () => {
  assert.deepEqual(Object.keys(resultOf(fixtureOrder('small-pickup'))), [
    'orderId', 'status', 'reasons', 'subtotal', 'discount', 'loyaltyDiscount', 'tax', 'shipping', 'grandTotal',
  ]);
});

test('the same order gives the same result twice', () => {
  assert.deepEqual(resultOf(fixtureOrder('studio-lamps')), resultOf(fixtureOrder('studio-lamps')));
});

test('an unknown customer is refused', () => {
  assert.throws(() => resultOf({ ...fixtureOrder('small-pickup'), customerId: 'C-999' }), /unknown customer C-999/);
});

test('an unknown item is refused', () => {
  assert.throws(() => resultOf({ ...fixtureOrder('small-pickup'), lines: [{ sku: 'NOPE', qty: 1 }] }), /unknown item NOPE/);
});
