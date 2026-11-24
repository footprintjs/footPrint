/**
 * Orders the answer functions build to watch a rule at work, and the small
 * helpers they share. A probe order is INPUT only: what the desk does with
 * it is read from F's run (observe.mjs), never typed here.
 *
 * Why probes: a question about the program (no fixture) asks for a rule,
 * and a rule is seen by running orders that differ in one thing. Example:
 * the shipping charge's fee per kilogram is the difference between the
 * charges of a 12 kg and a 24 kg order, divided by 12.
 * Example: `order('C-500', [['CABLE-USB', 1]], { shipMethod: 'pickup' })`.
 */
import { toCent } from '../harness/shapes.mjs';

/**
 * A probe order: a customer, lines as [item, quantity], delivered and billed
 * to `south` by standard delivery unless `extra` says otherwise.
 * @param {string} customerId @param {[string, number][]} lines @param {Record<string, unknown>} [extra]
 */
export function order(customerId, lines, extra = {}) {
  return {
    orderId: 'Q-PROBE', customerId, shipRegion: 'south', billingRegion: 'south', shipMethod: 'standard',
    lines: lines.map(([sku, qty]) => ({ sku, qty })), ...extra,
  };
}

/** Throws when a premise an answer function relies on does not hold. */
export function expect(condition, what) {
  if (!condition) throw new Error(`a probe premise failed: ${what}`);
}

/**
 * The shipping charge of an order that does not ship free, read as a fixed
 * fee plus a fee per kilogram, times a factor for express, from three
 * standard runs (12, 24 and 36 kg of paper) and one express run (12 kg).
 * The third weight checks that the charge is that straight line.
 * @param {Awaited<ReturnType<import('./observe.mjs').makeContext>>} ctx
 */
export async function shippingModel(ctx) {
  const paper = (n, extra) => ctx.run(order('C-500', [['PAPER-BOX', n]], extra));
  const [a, b, c, x] = await Promise.all([paper(1), paper(2), paper(3), paper(1, { shipMethod: 'express' })]);
  for (const v of [a, b, c, x]) expect(v.freeShippingBy === null && v.result.shipping > 0, 'each paper probe pays shipping');
  const perKg = toCent((b.result.shipping - a.result.shipping) / (b.weightKg - a.weightKg));
  const baseFee = toCent(a.result.shipping - perKg * a.weightKg);
  expect(toCent(baseFee + perKg * c.weightKg) === c.result.shipping, 'the charge is a fixed fee plus a fee per kilogram');
  return { baseFee, perKg, expressFactor: toCent(x.result.shipping / a.result.shipping) };
}

/** The first member of `options` for which `test` holds, refusing none or more than one. */
export function onlyOption(options, test, what) {
  const hits = options.filter(test);
  expect(hits.length === 1, `exactly one option fits ${what} (found ${hits.length})`);
  return hits[0];
}
