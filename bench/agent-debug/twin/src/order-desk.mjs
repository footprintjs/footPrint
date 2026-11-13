/**
 * The order desk: one order in, one priced and checked outcome out.
 *
 * This module only puts the steps in checkout order (SPEC.md, section 6);
 * each rule lives in its own module. It does no I/O, so it can be tested
 * without the command line.
 */
import { CATALOG } from './data/catalog.mjs';
import { COUPONS } from './data/coupons.mjs';
import { CUSTOMERS } from './data/customers.mjs';
import { STOCK } from './data/stock.mjs';
import { DEFAULT_TAX_RATE, TAX_RATES } from './data/tax-rates.mjs';
import { acceptCustomer, takeOrder } from './accept.mjs';
import { grandTotalOf, shippingCharge, taxOn, taxRateFor } from './charges.mjs';
import { checkCredit, checkStock } from './checks.mjs';
import { couponDiscount, loyaltyDiscount, netAmount } from './discounts.mjs';
import { decideOutcome } from './outcome.mjs';
import { priceLines } from './pricing.mjs';

/** The reference tables the rules read. Tests may pass their own. */
export const DEFAULT_TABLES = Object.freeze({
  catalog: CATALOG,
  coupons: COUPONS,
  customers: CUSTOMERS,
  stock: STOCK,
  taxRates: TAX_RATES,
  defaultTaxRate: DEFAULT_TAX_RATE,
});

/**
 * Runs one order through the desk and returns every figure it works out:
 * the printed ones and the ones it keeps to itself (section 6.12: line
 * prices, weight, net amount, tax rate, stock and credit verdicts, headroom,
 * lines priced). Throws `OrderRefusal` when the order is refused (section 7).
 *
 * @param {unknown} input the parsed input file, `{ order: {...} }`
 * @param {typeof DEFAULT_TABLES} [tables]
 */
export function runOrder(input, tables = DEFAULT_TABLES) {
  const order = takeOrder(input);
  const customer = acceptCustomer(order, tables.customers);
  const priced = priceLines(order.lines, tables.catalog);

  const { subtotal } = priced;
  const discount = couponDiscount(subtotal, order.couponCode, tables.coupons);
  const loyalty = loyaltyDiscount(subtotal, customer.memberYears);
  const net = netAmount(subtotal, discount, loyalty);

  const taxRate = taxRateFor(order.shipRegion, tables.taxRates, tables.defaultTaxRate);
  const tax = taxOn(net, taxRate);
  const shipping = shippingCharge(net, priced.totalWeightKg, order.shipMethod);
  const grandTotal = grandTotalOf(net, tax, shipping);

  const { stockOk, shortItems } = checkStock(priced.lines, tables.stock);
  const { creditOk, headroom } = checkCredit(grandTotal, customer);
  const { status, reasons } = decideOutcome({ shortItems, creditOk, grandTotal });

  return {
    hasOrderId: Object.hasOwn(order, 'orderId'),
    orderId: order.orderId,
    status,
    reasons,
    subtotal,
    discount,
    loyaltyDiscount: loyalty,
    tax,
    shipping,
    grandTotal,
    // Worked out but never printed (section 6.12).
    lines: priced.lines,
    linesPriced: priced.linesPriced,
    totalWeightKg: priced.totalWeightKg,
    netAmount: net,
    taxRate,
    stockOk,
    shortItems,
    creditOk,
    headroom,
  };
}

/**
 * Builds the printed result from the desk's figures: exactly the nine keys of
 * section 3, in order. `orderId` is printed as given (a number stays a number,
 * `null` stays `null`) and left out only when the order has no such field.
 *
 * @param {ReturnType<typeof runOrder>} figures
 */
export function toResult(figures) {
  const result = {};
  if (figures.hasOrderId) result.orderId = figures.orderId;
  result.status = figures.status;
  result.reasons = figures.reasons;
  result.subtotal = figures.subtotal;
  result.discount = figures.discount;
  result.loyaltyDiscount = figures.loyaltyDiscount;
  result.tax = figures.tax;
  result.shipping = figures.shipping;
  result.grandTotal = figures.grandTotal;
  return result;
}

/**
 * Prints a result as section 3 says: two-space JSON, one trailing newline.
 * `JSON.stringify` already writes numbers in their shortest form, writes an
 * empty list as `[]`, and writes −0 as `0`.
 *
 * @param {object} result
 * @returns {string}
 */
export function formatResult(result) {
  return `${JSON.stringify(result, null, 2)}\n`;
}
