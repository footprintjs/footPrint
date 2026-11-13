/**
 * Ten questions about why one run ended as it did (RULE-2.md, "The tasks"):
 * a named fixture and the reason for its outcome. Together they cover every
 * outcome (approved, review, rejected, on-hold) and both shipping cases
 * (free, for each of its two reasons, and charged). Each answer function
 * first checks the premise its text states ("was rejected") on F's run, then
 * reads the reason from that run, or reruns the fixture with one thing
 * changed when the question asks what would have happened.
 * `outcome` / `shipping` name what each question covers (a test counts them).
 */
import { toCent } from '../harness/shapes.mjs';
import { expect, shippingModel } from './probes.mjs';
import { choose, sorted } from './wording.mjs';

const of = (ctx, fixture) => ctx.run(ctx.fixture(fixture));
const premise = (v, status) => expect(v.result.status === status, `the fixture's status is ${status}`);

const CHECKS = sorted(['the credit limit', 'the order limit', 'the stock on the shelf']);
const ELSE = sorted(['approved', 'rejected', 'review']);
const FREE_BY = sorted([
  'its amount after discounts was 100 or more',
  'its subtotal before discounts was 100 or more',
  'the customer collected it at the store',
  'the customer has been a member for five years or more',
]);
/** The view's reason for free shipping, in the options' words. */
const FREE_WORDS = { amount: 'its amount after discounts was 100 or more', collected: 'the customer collected it at the store' };

export const WHY_QUESTIONS = [
  {
    id: 'why-rejected-limits',
    fixture: 'cafe-chairs',
    outcome: 'rejected',
    text: `Order fixture \`cafe-chairs\` was rejected. Which checks did it fail, and by how much did the customer's open balance plus this order's grand total go over the customer's credit limit? Answer with failed, every check it failed (${CHECKS.map((o) => `"${o}"`).join(', ')}), and overCreditLimitBy (an amount).`,
    shape: { type: 'object', fields: { failed: { type: 'set', options: CHECKS }, overCreditLimitBy: { type: 'number' } } },
    rules: ['credit-check', 'stock-check'],
    intermediate: true,
    howWithPrints: 'Print the credit limit, the order limit, the open balance, the grand total and the stock result in the checks, then run cafe-chairs.',
    derive: async (ctx) => {
      const v = await of(ctx, 'cafe-chairs');
      premise(v, 'rejected');
      const { creditLimit, orderLimit, openBalance } = v.customer;
      const total = v.result.grandTotal;
      const failed = [];
      if (openBalance + total > creditLimit) failed.push('the credit limit');
      if (total > orderLimit) failed.push('the order limit');
      if (!v.stockOk) failed.push('the stock on the shelf');
      return { failed: failed.sort(), overCreditLimitBy: toCent(-v.headroom) };
    },
  },
  {
    id: 'why-review-not-rejected',
    fixture: 'clinic-monitors',
    outcome: 'review',
    text: 'Order fixture `clinic-monitors` was sent for review, not rejected. By how much was its grand total below the customer\'s order limit?',
    shape: { type: 'number' },
    rules: ['credit-check', 'outcome'],
    intermediate: true,
    howWithPrints: 'Print the order limit and the grand total in the credit check, then run clinic-monitors.',
    derive: async (ctx) => {
      const v = await of(ctx, 'clinic-monitors');
      premise(v, 'review');
      return toCent(v.customer.orderLimit - v.result.grandTotal);
    },
  },
  {
    id: 'why-review-amount',
    fixture: 'school-chairs',
    outcome: 'review',
    text: 'Order fixture `school-chairs` was sent for review. By how much did its grand total go over the amount above which an order is sent for review?',
    shape: { type: 'number' },
    rules: ['outcome', 'grand-total'],
    intermediate: false,
    howWithPrints: 'Read the review amount in the outcome rules and the grand total in the result of school-chairs.',
    derive: async (ctx) => {
      const v = await of(ctx, 'school-chairs');
      premise(v, 'review');
      return toCent(v.result.grandTotal - v.reviewAbove);
    },
  },
  {
    id: 'why-held-otherwise',
    fixture: 'out-of-stock',
    outcome: 'on-hold',
    text: `Order fixture \`out-of-stock\` was put on hold. Had the shelf held enough of every item, with nothing else changed, which status would the order have ended with? ${choose(ELSE)}`,
    shape: { type: 'enum', options: ELSE },
    rules: ['outcome', 'credit-check', 'stock-check'],
    intermediate: true,
    howWithPrints: 'Print the credit check\'s result and the grand total, then run out-of-stock; or raise that item\'s stock in the stock table (src/) and run it.',
    derive: async (ctx) => {
      const order = ctx.fixture('out-of-stock');
      premise(await ctx.run(order), 'on-hold');
      const stock = Object.fromEntries(order.lines.map((l) => [l.sku, 1_000_000]));
      return (await ctx.run(order, { stock })).result.status;
    },
  },
  {
    id: 'why-approved-credit',
    fixture: 'studio-lamps',
    outcome: 'approved',
    text: 'Order fixture `studio-lamps` was approved. In its credit check, what did the customer\'s open balance plus this order\'s grand total come to?',
    shape: { type: 'number' },
    rules: ['credit-check'],
    intermediate: true,
    howWithPrints: 'Print the open balance and the grand total in the credit check, then run studio-lamps.',
    derive: async (ctx) => {
      const v = await of(ctx, 'studio-lamps');
      premise(v, 'approved');
      return toCent(v.customer.openBalance + v.result.grandTotal);
    },
  },
  {
    id: 'why-free-by-amount',
    fixture: 'studio-lamps',
    shipping: 'free',
    text: `Order fixture \`studio-lamps\` shipped free of charge. Which condition made it free? ${choose(FREE_BY)}`,
    shape: { type: 'enum', options: FREE_BY },
    rules: ['free-shipping', 'net-amount'],
    intermediate: true,
    howWithPrints: 'Print the delivery method and the amount after discounts where shipping is decided, then run studio-lamps.',
    derive: async (ctx) => {
      const v = await of(ctx, 'studio-lamps');
      expect(v.result.shipping === 0, 'it shipped free');
      return FREE_WORDS[/** @type {'amount'|'collected'} */ (v.freeShippingBy)];
    },
  },
  {
    id: 'why-free-by-pickup',
    fixture: 'harbour-cables',
    shipping: 'free',
    text: `Order fixture \`harbour-cables\` shipped free of charge. Which condition made it free? ${choose(FREE_BY)}`,
    shape: { type: 'enum', options: FREE_BY },
    rules: ['free-shipping'],
    intermediate: true,
    howWithPrints: 'Print the delivery method and the amount after discounts where shipping is decided, then run harbour-cables.',
    derive: async (ctx) => {
      const v = await of(ctx, 'harbour-cables');
      expect(v.result.shipping === 0, 'it shipped free');
      return FREE_WORDS[/** @type {'amount'|'collected'} */ (v.freeShippingBy)];
    },
  },
  {
    id: 'why-charged-weight',
    fixture: 'school-paper',
    shipping: 'charged',
    text: 'Order fixture `school-paper` paid for shipping. How much of its shipping charge comes from its weight (the fee per kilogram times the kilograms it weighs)?',
    shape: { type: 'number' },
    rules: ['shipping-charge', 'weight'],
    intermediate: true,
    howWithPrints: 'Print the weight and the fee per kilogram where the shipping charge is worked out, then run school-paper.',
    derive: async (ctx) => {
      const v = await of(ctx, 'school-paper');
      expect(v.result.shipping > 0 && v.order.shipMethod === 'standard', 'it paid standard shipping');
      const { perKg } = await shippingModel(ctx);
      return toCent(perKg * v.weightKg);
    },
  },
  {
    id: 'why-express-standard',
    fixture: 'harbour-express-lamp',
    shipping: 'charged',
    text: 'Order fixture `harbour-express-lamp` was sent by express and paid for shipping. What would its shipping charge have been by standard delivery, with nothing else changed?',
    shape: { type: 'number' },
    rules: ['shipping-charge'],
    intermediate: true,
    howWithPrints: 'Print the charge before express multiplies it, then run harbour-express-lamp; or set standard delivery in the run script and run it.',
    howWithPrintsTwin: 'Print the charge before express multiplies it, then run harbour-express-lamp; or set standard delivery where src/cli.mjs reads the order and run it.',
    derive: async (ctx) => {
      const order = ctx.fixture('harbour-express-lamp');
      expect(order.shipMethod === 'express' && (await ctx.run(order)).result.shipping > 0, 'it paid for express shipping');
      return (await ctx.run({ ...order, shipMethod: 'standard' })).result.shipping;
    },
  },
  {
    id: 'why-free-with-coupon',
    fixture: 'studio-lamps',
    shipping: 'free',
    text: 'Order fixture `studio-lamps` shipped free of charge. Would it still have shipped free if it had also used the coupon WELCOME5, with nothing else changed?',
    shape: { type: 'boolean' },
    rules: ['free-shipping', 'coupon', 'loyalty', 'net-amount'],
    intermediate: true,
    howWithPrints: 'Set the coupon WELCOME5 on the order in the run script, run studio-lamps and print the amount after discounts and the shipping charge.',
    howWithPrintsTwin: 'Set the coupon WELCOME5 on the order where src/cli.mjs reads it, run studio-lamps and print the amount after discounts and the shipping charge.',
    derive: async (ctx) => {
      const order = ctx.fixture('studio-lamps');
      expect((await ctx.run(order)).result.shipping === 0, 'it shipped free');
      return (await ctx.run({ ...order, couponCode: 'WELCOME5' })).result.shipping === 0;
    },
  },
];
