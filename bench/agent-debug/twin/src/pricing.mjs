/**
 * Pricing the lines: each line's total, the subtotal and the total weight
 * (SPEC.md, section 6.2), with the per-line refusals 4 and 5 of section 7.
 */
import { lookUp } from './lookup.mjs';
import { OrderRefusal } from './refusal.mjs';
import { roundToCent, roundToGram } from './rounding.mjs';

/** A line of this many units or more gets the bulk discount. */
export const BULK_MIN_QTY = 10;
/** The share taken off a bulk line: 5%. */
export const BULK_SHARE = 0.05;
/** The most lines one order may have. */
export const MAX_LINES = 1001;

/**
 * Works out one line's total from its quantity and catalog price.
 *
 * Ten units is inside the bulk discount, nine is not. The formula is written
 * exactly as the spec gives it, (qty × price) × (1 − share), and rounded once
 * after the discount: the order of the floating-point operations changes the
 * cent in some cases (10 × 3.33 × 0.95 gives 31.63, not 31.64).
 *
 * @param {number} qty units ordered, taken as given (not checked)
 * @param {number} price catalog price per unit
 * @returns {number} the line total, rounded to the cent
 */
export function lineTotal(qty, price) {
  const bulkShare = qty >= BULK_MIN_QTY ? BULK_SHARE : 0;
  return roundToCent(qty * price * (1 - bulkShare));
}

/**
 * Prices every line in order and adds them up.
 *
 * The subtotal is rounded after each line and the weight rounded to the gram
 * after each line, not once at the end. The bulk discount is per line: two
 * lines of 5 of the same item get none.
 *
 * Refusals, checked line by line in this order: a 1,002nd line refuses the
 * order before its item is looked up, so an unknown item on lines 1 to 1,001
 * is reported as an unknown item and one further down is never reached. An
 * item not in the catalog refuses with `unknown item <code as given>`.
 *
 * @param {Array<{ sku?: unknown, qty?: unknown }>} lines the order's lines (none is null)
 * @param {Record<string, { price: number, weightKg: number }>} catalog
 * @returns {{ lines: Array<{ sku: string, qty: number, unitPrice: number, lineTotal: number }>, subtotal: number, totalWeightKg: number, linesPriced: number }}
 */
export function priceLines(lines, catalog) {
  const priced = [];
  let subtotal = 0;
  let totalWeightKg = 0;
  for (const [index, line] of lines.entries()) {
    if (index >= MAX_LINES) {
      throw new OrderRefusal(`too many lines: an order may have at most ${MAX_LINES} lines`);
    }
    const sku = line.sku;
    const item = lookUp(catalog, sku);
    if (item === undefined) {
      throw new OrderRefusal(`unknown item ${String(sku)}`);
    }
    const qty = /** @type {number} */ (line.qty);
    const total = lineTotal(qty, item.price);
    subtotal = roundToCent(subtotal + total);
    totalWeightKg = roundToGram(totalWeightKg + qty * item.weightKg);
    priced.push({ sku: /** @type {string} */ (sku), qty, unitPrice: item.price, lineTotal: total });
  }
  return { lines: priced, subtotal, totalWeightKg, linesPriced: priced.length };
}
