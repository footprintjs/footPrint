/**
 * Unit tests for each rule of SPEC.md section 6, one function at a time,
 * with the boundary values the spec names.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CATALOG } from '../../twin/src/data/catalog.mjs';
import { COUPONS } from '../../twin/src/data/coupons.mjs';
import { CUSTOMERS } from '../../twin/src/data/customers.mjs';
import { STOCK } from '../../twin/src/data/stock.mjs';
import { DEFAULT_TAX_RATE, TAX_RATES } from '../../twin/src/data/tax-rates.mjs';
import { grandTotalOf, shippingCharge, taxOn, taxRateFor } from '../../twin/src/charges.mjs';
import { checkCredit, checkStock } from '../../twin/src/checks.mjs';
import { couponDiscount, loyaltyDiscount, netAmount } from '../../twin/src/discounts.mjs';
import { lookUp } from '../../twin/src/lookup.mjs';
import { decideOutcome } from '../../twin/src/outcome.mjs';
import { lineTotal, priceLines } from '../../twin/src/pricing.mjs';
import { OrderRefusal } from '../../twin/src/refusal.mjs';
import { roundToCent, roundToGram } from '../../twin/src/rounding.mjs';

describe('rounding (section 5)', () => {
  test('halves round toward the larger number', () => {
    assert.equal(roundToCent(2.125), 2.13);
    assert.equal(Math.round(212.5), 213);
    assert.equal(roundToCent(-0.025), -0.02);
  });
  test('floating point decides a "half" that is not exactly one', () => {
    assert.equal(roundToCent(1.005), 1);
    assert.equal(roundToCent(10 * 3.33 * 0.95), 31.63);
  });
  test('weight rounds to the gram', () => {
    assert.equal(roundToGram(0.0005), 0.001);
    assert.equal(roundToGram(12 * 0.25), 3);
  });
});

describe('looking codes up', () => {
  test('matches exactly, case included', () => {
    assert.equal(lookUp(COUPONS, 'spring10'), undefined);
    assert.deepEqual(lookUp(COUPONS, 'SPRING10'), { percent: 10 });
  });
  test('never finds inherited members or non-string codes', () => {
    assert.equal(lookUp(CUSTOMERS, 'constructor'), undefined);
    assert.equal(lookUp(CATALOG, 'toString'), undefined);
    assert.equal(lookUp(CUSTOMERS, ['C-100']), undefined);
    assert.equal(lookUp(CUSTOMERS, undefined), undefined);
  });
});

describe('pricing lines (section 6.2)', () => {
  test('ten units get the bulk discount, nine do not', () => {
    assert.equal(lineTotal(10, 3.33), 31.63);
    assert.equal(lineTotal(9, 3.33), 29.97);
    assert.equal(lineTotal(12, 3.33), 37.96);
  });
  test('the bulk discount is per line, not per item', () => {
    const priced = priceLines([{ sku: 'NOTE-A5', qty: 5 }, { sku: 'NOTE-A5', qty: 5 }], CATALOG);
    assert.equal(priced.subtotal, 33.3);
  });
  test('the subtotal is rounded after each line, the weight to the gram', () => {
    const priced = priceLines(
      [{ sku: 'MONITOR-27', qty: 2 }, { sku: 'DESK-LAMP', qty: 1 }, { sku: 'CHAIR-ERGO', qty: 4 }],
      CATALOG,
    );
    assert.equal(priced.subtotal, 2158.48);
    assert.equal(priced.totalWeightKg, 70.8);
    assert.equal(priced.linesPriced, 3);
    assert.deepEqual(priced.lines[0], { sku: 'MONITOR-27', qty: 2, unitPrice: 279.99, lineTotal: 559.98 });
  });
  test('a quantity of 0 is worth 0 and weighs nothing', () => {
    const priced = priceLines([{ sku: 'CHAIR-ERGO', qty: 0 }], CATALOG);
    assert.equal(priced.subtotal, 0);
    assert.equal(priced.totalWeightKg, 0);
  });
  test('the first unknown item refuses the order, its code as given', () => {
    assert.throws(() => priceLines([{ sku: 'PEN-BLUE', qty: 1 }, { sku: 'NOPE', qty: 1 }, { sku: 'X', qty: 1 }], CATALOG), {
      name: 'OrderRefusal',
      message: 'unknown item NOPE',
    });
    assert.throws(() => priceLines([{ qty: 1 }], CATALOG), { message: 'unknown item undefined' });
  });
  test('1,001 lines are priced; a 1,002nd line refuses the order', () => {
    const line = { sku: 'PEN-BLUE', qty: 1 };
    assert.equal(priceLines(Array(1001).fill(line), CATALOG).linesPriced, 1001);
    assert.throws(() => priceLines(Array(1002).fill(line), CATALOG), (e) => e instanceof OrderRefusal && /too many lines/.test(e.message));
  });
  test('an unknown item on line 1,001 is reported; one on line 1,002 is never reached', () => {
    const lines = Array(1000).fill({ sku: 'PEN-BLUE', qty: 1 });
    assert.throws(() => priceLines([...lines, { sku: 'NOPE', qty: 1 }], CATALOG), { message: 'unknown item NOPE' });
    assert.throws(() => priceLines([...lines, { sku: 'PEN-BLUE', qty: 1 }, { sku: 'NOPE', qty: 1 }], CATALOG), /too many lines/);
  });
});

describe('discounts (sections 6.3 to 6.5)', () => {
  test('no, empty, null or unknown coupon gives 0', () => {
    for (const code of [undefined, null, '', 'NOPE', 'spring10']) assert.equal(couponDiscount(100, code, COUPONS), 0);
  });
  test('a percentage coupon is rounded', () => {
    assert.equal(couponDiscount(52.5, 'SPRING10', COUPONS), 5.25);
    assert.equal(couponDiscount(255, 'SPRING10', COUPONS), 25.5);
  });
  test('a fixed coupon never takes off more than the subtotal', () => {
    assert.equal(couponDiscount(26.25, 'WELCOME5', COUPONS), 5);
    assert.equal(couponDiscount(6, 'BULK50', COUPONS), 6);
  });
  test('loyalty starts at exactly 5 years and is taken on the subtotal', () => {
    assert.equal(loyaltyDiscount(102.5, 5), 2.05);
    assert.equal(loyaltyDiscount(102.5, 4), 0);
    assert.equal(loyaltyDiscount(255, 7), 5.1);
  });
  test('the net amount can go negative', () => {
    assert.equal(netAmount(6, 6, 0.12), -0.12);
    assert.equal(netAmount(255, 25.5, 5.1), 224.4);
  });
});

describe('tax, shipping and grand total (sections 6.6 to 6.8)', () => {
  test('tax uses the delivery region, the default for an unlisted one, and 0 for export', () => {
    assert.equal(taxRateFor('west', TAX_RATES, DEFAULT_TAX_RATE), 0.05);
    assert.equal(taxRateFor('export', TAX_RATES, DEFAULT_TAX_RATE), 0);
    assert.equal(taxRateFor('North', TAX_RATES, DEFAULT_TAX_RATE), 0.08);
    assert.equal(taxRateFor(undefined, TAX_RATES, DEFAULT_TAX_RATE), 0.08);
    assert.equal(taxOn(42.5, 0.05), 2.13);
    assert.equal(taxOn(249.9, 0.08), 19.99);
  });
  test('pickup ships free whatever the amount', () => {
    assert.equal(shippingCharge(5, 100, 'pickup'), 0);
  });
  test('a net amount of exactly 100 ships free, express included', () => {
    assert.equal(shippingCharge(100, 24, 'express'), 0);
    assert.equal(shippingCharge(99.99, 0, 'standard'), 4.95);
  });
  test('express doubles the whole fee and rounds once after', () => {
    assert.equal(shippingCharge(42.5, 1.8, 'express'), 12.96);
    assert.equal(shippingCharge(48.8, 24, 'express'), 50.7);
  });
  test('any method other than exactly pickup or express is charged like standard', () => {
    assert.equal(shippingCharge(48.8, 24, 'standard'), 25.35);
    assert.equal(shippingCharge(48.8, 24, undefined), 25.35);
    assert.equal(shippingCharge(48.8, 24, 'Express'), 25.35);
    assert.equal(shippingCharge(48.8, 24, 'Pickup'), 25.35);
  });
  test('grand total is rounded net + tax + shipping', () => {
    assert.equal(grandTotalOf(249.9, 19.99, 0), 269.89);
  });
});

describe('checks (sections 6.9 and 6.10)', () => {
  test('equal to the shelf is fine; the check is per line', () => {
    assert.deepEqual(checkStock([{ sku: 'DESK-LAMP', qty: 4 }], STOCK), { stockOk: true, shortItems: [] });
    assert.deepEqual(checkStock([{ sku: 'DESK-LAMP', qty: 3 }, { sku: 'DESK-LAMP', qty: 3 }], STOCK).stockOk, true);
  });
  test('short items are listed once per short line, in line order', () => {
    const lines = [{ sku: 'DESK-LAMP', qty: 5 }, { sku: 'PEN-BLUE', qty: 1 }, { sku: 'DESK-LAMP', qty: 9 }];
    assert.deepEqual(checkStock(lines, STOCK), { stockOk: false, shortItems: ['DESK-LAMP', 'DESK-LAMP'] });
  });
  test('an item the stock table does not list has 0 on the shelf', () => {
    assert.deepEqual(checkStock([{ sku: 'NEW', qty: 1 }], {}).shortItems, ['NEW']);
    assert.equal(checkStock([{ sku: 'NEW', qty: 0 }], {}).stockOk, true);
  });
  test('both limits are inclusive and both must hold', () => {
    const customer = { creditLimit: 1000, orderLimit: 800, openBalance: 200 };
    assert.deepEqual(checkCredit(800, customer), { creditOk: true, headroom: 0 });
    assert.equal(checkCredit(800.01, customer).creditOk, false);
    assert.equal(checkCredit(700, { ...customer, openBalance: 300.01 }).creditOk, false);
  });
  test('headroom looks at the credit limit only and can be negative', () => {
    assert.equal(checkCredit(1237.02, CUSTOMERS['C-500']).headroom, -437.02);
    assert.deepEqual(checkCredit(2554.52, CUSTOMERS['C-400']), { creditOk: true, headroom: 445.48 });
  });
});

describe('outcome (section 6.11)', () => {
  test('short stock wins over a failed credit check', () => {
    assert.deepEqual(decideOutcome({ shortItems: ['DESK-LAMP'], creditOk: false, grandTotal: 5000 }), {
      status: 'on-hold',
      reasons: ['out of stock: DESK-LAMP'],
    });
  });
  test('a failed credit check wins over a large order', () => {
    assert.equal(decideOutcome({ shortItems: [], creditOk: false, grandTotal: 5000 }).status, 'rejected');
  });
  test('exactly 2000 is not large; more is', () => {
    assert.deepEqual(decideOutcome({ shortItems: [], creditOk: true, grandTotal: 2000 }), { status: 'approved', reasons: [] });
    assert.deepEqual(decideOutcome({ shortItems: [], creditOk: true, grandTotal: 2000.01 }), { status: 'review', reasons: ['large order'] });
  });
});
