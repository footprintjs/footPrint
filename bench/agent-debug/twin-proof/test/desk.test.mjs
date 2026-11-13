/**
 * Whole-order tests: the worked examples of SPEC.md section 8 that are not
 * fixtures, the input rules of section 2, the refusal order of section 7, and
 * the command line's exit codes (section 1).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main, USAGE } from '../../twin/src/cli.mjs';
import { formatResult, runOrder, toResult } from '../../twin/src/order-desk.mjs';

const FIXTURES = fileURLToPath(new URL('../../twin/fixtures/', import.meta.url));

/** @param {string} name */
function fixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')).order;
}

/** Runs an order and returns its printed result as an object. */
function resultOf(order) {
  return toResult(runOrder({ order }));
}

describe('worked examples (section 8)', () => {
  test('both discounts are taken on the subtotal', () => {
    const r = resultOf({ ...fixture('out-of-stock'), couponCode: 'SPRING10' });
    assert.equal(r.discount, 25.5);
    assert.equal(r.loyaltyDiscount, 5.1);
    assert.equal(r.tax, 17.95);
    assert.equal(r.grandTotal, 242.35);
  });
  test('free shipping looks at the net amount, never the grand total', () => {
    const figures = runOrder({ order: { ...fixture('school-paper'), shipMethod: 'express' } });
    assert.equal(figures.netAmount, 48.8);
    assert.equal(figures.shipping, 50.7);
    assert.equal(figures.grandTotal, 103.4);
  });
  test('a short line holds an order that is also over its limits', () => {
    const order = fixture('cafe-chairs');
    const figures = runOrder({ order: { ...order, lines: [...order.lines, { sku: 'DESK-LAMP', qty: 5 }] } });
    assert.equal(figures.grandTotal, 1462.27);
    assert.equal(figures.creditOk, false);
    assert.equal(figures.status, 'on-hold');
    assert.deepEqual(figures.reasons, ['out of stock: DESK-LAMP']);
  });
  test('a loyal customer with BULK50 on 6.00 gets a negative net amount', () => {
    const figures = runOrder({ order: { customerId: 'C-200', shipRegion: 'north', shipMethod: 'pickup', couponCode: 'BULK50', lines: [{ sku: 'PEN-BLUE', qty: 5 }] } });
    assert.equal(figures.discount, 6);
    assert.equal(figures.loyaltyDiscount, 0.12);
    assert.equal(figures.netAmount, -0.12);
    assert.equal(figures.tax, -0.01);
    assert.equal(figures.grandTotal, -0.13);
  });
  test('the figures kept back are worked out (section 6.12)', () => {
    const figures = runOrder({ order: fixture('cafe-chairs') });
    assert.equal(figures.headroom, -437.02);
    assert.equal(figures.taxRate, 0.06);
    assert.equal(figures.totalWeightKg, 42);
    assert.equal(figures.linesPriced, 1);
    assert.equal(figures.stockOk, true);
  });
});

describe('the input (section 2)', () => {
  test('orderId is printed as given, and left out when missing', () => {
    const base = fixture('small-pickup');
    assert.equal(resultOf({ ...base, orderId: 42 }).orderId, 42);
    assert.equal(resultOf({ ...base, orderId: null }).orderId, null);
    const { orderId, ...withoutId } = base;
    const keys = Object.keys(resultOf(withoutId));
    assert.deepEqual(keys, ['status', 'reasons', 'subtotal', 'discount', 'loyaltyDiscount', 'tax', 'shipping', 'grandTotal']);
  });
  test('the billing region and unknown fields change nothing', () => {
    const base = fixture('harbour-express-lamp');
    const other = { ...base, billingRegion: 'export', note: 'x', lines: [{ ...base.lines[0], colour: 'red' }] };
    assert.deepEqual(resultOf(other), resultOf(base));
  });
  test('a missing region uses the default rate', () => {
    const { shipRegion, ...order } = fixture('small-pickup');
    assert.equal(runOrder({ order }).taxRate, 0.08);
  });
});

describe('refusals, in order (section 7)', () => {
  const refusal = (input) => {
    try {
      runOrder(input);
    } catch (error) {
      return error.message;
    }
    return 'not refused';
  };
  test('a malformed order is reported first', () => {
    for (const input of [{}, null, [], { order: null }, { order: 'x' }, { order: {} }, { order: { lines: {} } }]) {
      assert.match(refusal(input), /^malformed order/);
    }
    // A null line is malformed even with an unknown customer.
    assert.match(refusal({ order: { customerId: 'C-999', lines: [{ sku: 'PEN-BLUE', qty: 1 }, null] } }), /^malformed order/);
  });
  test('an unknown customer is reported before an empty order or an unknown item', () => {
    assert.equal(refusal({ order: { customerId: 'C-999', lines: [] } }), 'unknown customer C-999');
    assert.equal(refusal({ order: { customerId: 'C-999', lines: [{ sku: 'NOPE' }] } }), 'unknown customer C-999');
    assert.equal(refusal({ order: { lines: [] } }), 'unknown customer undefined');
  });
  test('an order with no lines is refused, not priced', () => {
    assert.match(refusal({ order: { customerId: 'C-100', lines: [] } }), /^empty order/);
  });
  test('a line that is not an object is an unknown item', () => {
    assert.equal(refusal({ order: { customerId: 'C-100', lines: [7] } }), 'unknown item undefined');
  });
});

describe('the command line (section 1)', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'order-desk-test-'));
  after(() => rmSync(scratch, { recursive: true, force: true }));
  const file = (name, text) => {
    const path = join(scratch, name);
    writeFileSync(path, text);
    return path;
  };

  test('no argument prints the usage line and exits 2', () => {
    assert.deepEqual(main([]), { stdout: '', stderr: `${USAGE}\n`, code: 2 });
  });
  test('an unreadable file or invalid JSON exits 1 with nothing on standard output', () => {
    for (const path of [join(scratch, 'missing.json'), file('bad.json', '{ not json')]) {
      const got = main([path]);
      assert.equal(got.code, 1);
      assert.equal(got.stdout, '');
      assert.notEqual(got.stderr, '');
    }
  });
  test('a refusal prints only its message', () => {
    const got = main([file('empty.json', JSON.stringify({ order: { customerId: 'C-1', lines: [] } }))]);
    assert.deepEqual(got, { stdout: '', stderr: 'unknown customer C-1\n', code: 1 });
  });
  test('a held order is a success', () => {
    const got = main([join(FIXTURES, 'out-of-stock.json')]);
    assert.equal(got.code, 0);
    assert.equal(got.stderr, '');
  });
  test('negative zero prints as 0 and an empty list as []', () => {
    const text = formatResult({ a: -0, b: [] });
    assert.equal(text, '{\n  "a": 0,\n  "b": []\n}\n');
  });
});
