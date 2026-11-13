/**
 * Ten questions about what one run did (RULE-2.md, "The tasks"): a named
 * fixture of the working folder and a value that run worked out. Each
 * answer function reads it from F's run of that fixture (observe.mjs).
 * `intermediate: true` marks a value the printed result does not show: an
 * agent without the record must work it out or add a print.
 * No fixture value here is one the visible tests already state.
 */
import { toCent } from '../harness/shapes.mjs';
import { expect, order } from './probes.mjs';

const of = (ctx, fixture) => ctx.run(ctx.fixture(fixture));

export const RUN_QUESTIONS = [
  {
    id: 'run-tax-rate',
    fixture: 'clinic-monitors',
    text: 'For order fixture `clinic-monitors`, what tax rate was applied, in percent?',
    shape: { type: 'number' },
    rules: ['tax-rate'],
    intermediate: true,
    howWithPrints: 'Print the tax rate where the tax is worked out, then run clinic-monitors.',
    derive: async (ctx) => (await of(ctx, 'clinic-monitors')).taxRatePercent,
  },
  {
    id: 'run-weight',
    fixture: 'harbour-three-items',
    text: 'For order fixture `harbour-three-items`, how many kilograms does the order weigh in total?',
    shape: { type: 'number' },
    rules: ['weight'],
    intermediate: true,
    howWithPrints: 'Print the total weight after the lines are priced, then run harbour-three-items.',
    derive: async (ctx) => (await of(ctx, 'harbour-three-items')).weightKg,
  },
  {
    id: 'run-line-total',
    fixture: 'harbour-chairs',
    text: 'For order fixture `harbour-chairs`, what did its line of office chairs come to, after any quantity discount?',
    shape: { type: 'number' },
    rules: ['line-price'],
    intermediate: true,
    howWithPrints: 'Print each line total after a line is priced, then run harbour-chairs.',
    derive: async (ctx) => {
      const lines = (await of(ctx, 'harbour-chairs')).lines.filter((l) => l.item === 'CHAIR-ERGO');
      expect(lines.length === 1, 'one line of office chairs');
      return lines[0].lineTotal;
    },
  },
  {
    id: 'run-net-amount',
    fixture: 'school-chairs',
    text: 'For order fixture `school-chairs`, what was the amount after discounts on which its tax was worked out?',
    shape: { type: 'number' },
    rules: ['subtotal', 'net-amount', 'loyalty', 'tax'],
    intermediate: true,
    howWithPrints: 'Print the amount after discounts before the tax is worked out, then run school-chairs.',
    derive: async (ctx) => (await of(ctx, 'school-chairs')).netAmount,
  },
  {
    id: 'run-loyalty',
    fixture: 'studio-lamps',
    text: 'For order fixture `studio-lamps`, how much loyalty discount did the customer get?',
    shape: { type: 'number' },
    rules: ['loyalty'],
    intermediate: false,
    howWithPrints: 'Run studio-lamps and read the loyalty discount in the result.',
    derive: async (ctx) => (await of(ctx, 'studio-lamps')).result.loyaltyDiscount,
  },
  {
    id: 'run-coupon',
    fixture: 'harbour-cables',
    text: 'For order fixture `harbour-cables`, how much did the coupon take off?',
    shape: { type: 'number' },
    rules: ['coupon'],
    intermediate: false,
    howWithPrints: 'Run harbour-cables and read the coupon discount in the result.',
    derive: async (ctx) => (await of(ctx, 'harbour-cables')).result.discount,
  },
  {
    id: 'run-shipping',
    fixture: 'school-paper',
    text: 'For order fixture `school-paper`, what shipping charge was made?',
    shape: { type: 'number' },
    rules: ['shipping-charge'],
    intermediate: false,
    howWithPrints: 'Run school-paper and read the shipping charge in the result.',
    derive: async (ctx) => (await of(ctx, 'school-paper')).result.shipping,
  },
  {
    id: 'run-grand-total',
    fixture: 'harbour-express-lamp',
    text: 'For order fixture `harbour-express-lamp`, what was the grand total?',
    shape: { type: 'number' },
    rules: ['grand-total', 'shipping-charge', 'tax'],
    intermediate: false,
    howWithPrints: 'Run harbour-express-lamp and read the grand total in the result.',
    derive: async (ctx) => (await of(ctx, 'harbour-express-lamp')).result.grandTotal,
  },
  {
    id: 'run-short-units',
    fixture: 'out-of-stock',
    text: 'For order fixture `out-of-stock`, how many more units of the item it was short of would the shelf have needed to hold to fill the order?',
    shape: { type: 'number' },
    rules: ['stock-check'],
    intermediate: true,
    howWithPrints: 'Print the units on the shelf and the units ordered in the stock check, then run out-of-stock.',
    derive: async (ctx) => {
      const v = await of(ctx, 'out-of-stock');
      expect(v.shortItems.length === 1 && v.order.lines.length === 1, 'one line, short');
      const [line] = v.order.lines;
      // The shelf's count is not in the run: find the largest quantity of that item the stock check passes.
      let shelf = 0;
      for (let qty = 1; qty <= line.qty; qty++) {
        if ((await ctx.run(order('C-200', [[line.sku, qty]]))).stockOk) shelf = qty;
      }
      return line.qty - shelf;
    },
  },
  {
    id: 'run-headroom',
    fixture: 'harbour-chairs',
    text: 'For order fixture `harbour-chairs`, how much more could the customer owe after this order before reaching their credit limit (the credit limit, minus what they owed before, minus this order\'s grand total)?',
    shape: { type: 'number' },
    rules: ['credit-check'],
    intermediate: true,
    howWithPrints: 'Print the credit limit, the open balance and the grand total in the credit check, then run harbour-chairs.',
    derive: async (ctx) => toCent((await of(ctx, 'harbour-chairs')).headroom),
  },
];
