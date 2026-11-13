/**
 * Accepting an order: the checks made before any line is priced
 * (SPEC.md, sections 6.1 and 7, refusals 1 to 3).
 *
 * The order of the checks is part of the rules: a malformed order is reported
 * before an unknown customer, and an unknown customer before an empty order.
 * The per-line refusals (unknown item, too many lines) are made while pricing,
 * in `pricing.mjs`.
 */
import { lookUp } from './lookup.mjs';
import { OrderRefusal } from './refusal.mjs';

/**
 * Takes the order out of the parsed input file and refuses it when its shape
 * is wrong (refusal 1). The message wording is not specified.
 *
 * "Not an object" covers `null` and a list as well as a string or number: a
 * list has no `lines` member in practice, so treating it as malformed here
 * only names the reason earlier.
 *
 * @param {unknown} input the whole parsed file
 * @returns {Record<string, unknown> & { lines: unknown[] }} the order
 */
export function takeOrder(input) {
  if (!isPlainObject(input) || !Object.hasOwn(input, 'order')) {
    throw new OrderRefusal('malformed order: the file has no "order" member');
  }
  const order = input.order;
  if (!isPlainObject(order)) {
    throw new OrderRefusal('malformed order: "order" is not an object');
  }
  if (!Array.isArray(order.lines)) {
    throw new OrderRefusal('malformed order: "lines" is missing or is not a list');
  }
  // Only `null` is malformed. Any other value as a line (a number, a string)
  // is priced like a line without a `sku`, so it is refused as an unknown item.
  const nullAt = order.lines.indexOf(null);
  if (nullAt !== -1) {
    throw new OrderRefusal(`malformed order: line ${nullAt + 1} is null`);
  }
  return /** @type {any} */ (order);
}

/**
 * Finds the order's customer (refusal 2), then refuses an order with no lines
 * (refusal 3). The customer is checked first, so an empty order from an
 * unknown customer reports the customer.
 *
 * @template C
 * @param {{ customerId?: unknown, lines: unknown[] }} order an order that passed `takeOrder`
 * @param {Record<string, C>} customers the customer table
 * @returns {C} the customer's row
 */
export function acceptCustomer(order, customers) {
  const customer = lookUp(customers, order.customerId);
  if (customer === undefined) {
    // The code is printed as given: a missing field prints `undefined`.
    throw new OrderRefusal(`unknown customer ${String(order.customerId)}`);
  }
  if (order.lines.length === 0) {
    throw new OrderRefusal('empty order: "lines" has no lines');
  }
  return customer;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
