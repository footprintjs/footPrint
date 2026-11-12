/**
 * The hidden tests: the full expected result of every fixture.
 *
 * Why hidden: they decide whether a run SOLVED its fault. An agent never sees
 * this file; it is copied beside the agent's edited program in a separate
 * scoring folder after the run (harness/score.mjs).
 *
 * Why golden values: each was worked out from the business rules written in
 * the steps (and checked against the unmodified program), so a fault anywhere
 * on a fixture's path changes at least one of them.
 * Example: small-pickup → 5 pens at 1.20 = 6.00, south tax 6% = 0.36, collected → 6.36.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { runOrder } from '../src/order-desk.mjs';

/** @type {Record<string, Record<string, unknown>>} */
const EXPECTED = {
  'cafe-chairs': {
    orderId: 'A-1011',
    status: 'rejected',
    reasons: [
      'over the credit or order limit'
    ],
    subtotal: 1167,
    discount: 0,
    loyaltyDiscount: 0,
    tax: 70.02,
    shipping: 0,
    grandTotal: 1237.02
  },
  'cafe-notebooks': {
    orderId: 'A-1005',
    status: 'approved',
    reasons: [],
    subtotal: 37.96,
    discount: 0,
    loyaltyDiscount: 0,
    tax: 2.75,
    shipping: 7.5,
    grandTotal: 48.21
  },
  'clinic-monitors': {
    orderId: 'A-1009',
    status: 'review',
    reasons: [
      'large order'
    ],
    subtotal: 2409.92,
    discount: 0,
    loyaltyDiscount: 0,
    tax: 144.6,
    shipping: 0,
    grandTotal: 2554.52
  },
  'harbour-cables': {
    orderId: 'A-1008',
    status: 'approved',
    reasons: [],
    subtotal: 52.5,
    discount: 5.25,
    loyaltyDiscount: 0,
    tax: 3.43,
    shipping: 0,
    grandTotal: 50.68
  },
  'harbour-chairs': {
    orderId: 'A-1010',
    status: 'approved',
    reasons: [],
    subtotal: 1726,
    discount: 0,
    loyaltyDiscount: 0,
    tax: 138.08,
    shipping: 0,
    grandTotal: 1864.08
  },
  'harbour-express-lamp': {
    orderId: 'A-1007',
    status: 'approved',
    reasons: [],
    subtotal: 42.5,
    discount: 0,
    loyaltyDiscount: 0,
    tax: 2.13,
    shipping: 12.96,
    grandTotal: 57.59
  },
  'harbour-three-items': {
    orderId: 'A-1004',
    status: 'review',
    reasons: [
      'large order'
    ],
    subtotal: 2158.48,
    discount: 0,
    loyaltyDiscount: 0,
    tax: 172.68,
    shipping: 0,
    grandTotal: 2331.16
  },
  'out-of-stock': {
    orderId: 'A-1002',
    status: 'on-hold',
    reasons: [
      'out of stock: DESK-LAMP'
    ],
    subtotal: 255,
    discount: 0,
    loyaltyDiscount: 5.1,
    tax: 19.99,
    shipping: 0,
    grandTotal: 269.89
  },
  'school-chairs': {
    orderId: 'A-1013',
    status: 'review',
    reasons: [
      'large order'
    ],
    subtotal: 2334,
    discount: 0,
    loyaltyDiscount: 46.68,
    tax: 182.99,
    shipping: 0,
    grandTotal: 2470.31
  },
  'school-paper': {
    orderId: 'A-1012',
    status: 'approved',
    reasons: [],
    subtotal: 49.8,
    discount: 0,
    loyaltyDiscount: 1,
    tax: 3.9,
    shipping: 25.35,
    grandTotal: 78.05
  },
  'small-pickup': {
    orderId: 'A-1001',
    status: 'approved',
    reasons: [],
    subtotal: 6,
    discount: 0,
    loyaltyDiscount: 0,
    tax: 0.36,
    shipping: 0,
    grandTotal: 6.36
  },
  'studio-lamps': {
    orderId: 'A-1006',
    status: 'approved',
    reasons: [],
    subtotal: 102.5,
    discount: 0,
    loyaltyDiscount: 2.05,
    tax: 5.02,
    shipping: 0,
    grandTotal: 105.47
  },
  'welcome-coupon': {
    orderId: 'A-1003',
    status: 'approved',
    reasons: [],
    subtotal: 26.25,
    discount: 5,
    loyaltyDiscount: 0,
    tax: 1.06,
    shipping: 5.21,
    grandTotal: 27.52
  }
};

for (const [name, expected] of Object.entries(EXPECTED)) {
  test(`${name} gives the expected result`, async () => {
    const text = await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8');
    assert.deepEqual(await runOrder(JSON.parse(text).order), expected);
  });
}
