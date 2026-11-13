/**
 * The stock and credit checks.
 *
 * Both are always made, after the grand total is known, whatever the other
 * finds; neither changes any figure.
 */
import { lookUp } from './lookup.mjs';
import { roundToCent } from './rounding.mjs';

/**
 * Checks each line against the shelf.
 *
 * The check is per LINE, not per item: two lines of 3 lamps with 4 on the
 * shelf are each fine. A line is short only when the shelf holds FEWER units
 * than its quantity (equal is fine). An item the stock table does not list
 * counts as 0 units. Short items are listed in line order, once per short
 * line, so an item short on two lines appears twice.
 *
 * @param {Array<{ sku: string, qty: number }>} lines
 * @param {Record<string, number>} stock units on the shelf per item
 * @returns {{ stockOk: boolean, shortItems: string[] }}
 */
export function checkStock(lines, stock) {
  const shortItems = [];
  for (const line of lines) {
    const onShelf = lookUp(stock, line.sku) ?? 0;
    if (onShelf < line.qty) shortItems.push(line.sku);
  }
  return { stockOk: shortItems.length === 0, shortItems };
}

/**
 * Checks the grand total against the customer's two limits.
 *
 * Both must hold, and equal is within: open balance + grand total ≤ credit
 * limit, and grand total ≤ order limit. The comparisons use the amounts as
 * they are, with no rounding of the sum. Headroom (rounded) looks only at the
 * credit limit, is negative when the order goes over it, and changes nothing.
 *
 * @param {number} grandTotal
 * @param {{ creditLimit: number, orderLimit: number, openBalance: number }} customer
 * @returns {{ creditOk: boolean, headroom: number }}
 */
export function checkCredit(grandTotal, customer) {
  const withinCredit = customer.openBalance + grandTotal <= customer.creditLimit;
  const withinOrder = grandTotal <= customer.orderLimit;
  const headroom = roundToCent(customer.creditLimit - customer.openBalance - grandTotal);
  return { creditOk: withinCredit && withinOrder, headroom };
}
