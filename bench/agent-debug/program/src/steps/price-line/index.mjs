/**
 * price-line: prices the current line and adds it to the running totals.
 *
 * The rule: ten or more of one item take 5% off that line. A line's total is
 * rounded to the cent once, after the discount.
 * Example: 11 × NOTE-A5 at 3.33 → 11 × 3.33 × 0.95 = 34.7985 → `lineTotal = 34.8`.
 */
import { CATALOG } from '../../data/catalog.mjs';
import { roundCents, roundGrams } from '../../money.mjs';

export const purpose = 'Price the current line (bulk discount) and add it to the totals.';

/** Quantity from which a line gets the bulk discount. */
const BULK_QTY = 10;
/** The bulk discount, as a share of the line. */
const BULK_RATE = 0.05;

/** @param {any} scope */
export function run(scope) {
  const line = scope.lines[scope.lineIndex];
  const item = CATALOG[line.sku];
  if (!item) throw new Error(`unknown item ${line.sku}`);
  const rate = line.qty >= BULK_QTY ? BULK_RATE : 0;
  const lineTotal = roundCents(line.qty * item.price * (1 - rate));
  scope.pricedLines = [...scope.pricedLines, { sku: line.sku, qty: line.qty, unitPrice: item.price, lineTotal }];
  scope.subtotal = roundCents(scope.subtotal + lineTotal);
  scope.totalWeight = roundGrams(scope.totalWeight + line.qty * item.weightKg);
  scope.linesLeft = scope.lineCount - scope.lineIndex - 1;
}
