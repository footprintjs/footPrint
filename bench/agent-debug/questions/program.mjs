/**
 * Ten questions about the program (RULE-2.md, "The tasks"): no run is
 * named; each asks for a rule in business words. Each answer function runs
 * probe orders through F (observe.mjs, probes.mjs) and reads the rule off
 * what the desk did; nothing is typed but the probe orders and the wording.
 */
import { toCent } from '../harness/shapes.mjs';
import { expect, onlyOption, order, shippingModel } from './probes.mjs';
import { choose, sorted } from './wording.mjs';

const FREE = sorted([
  'the amount after discounts is 100 or more',
  'the customer collects the order at the store',
  'the customer has been a member for five years or more',
  'the order is delivered to the export region',
  'the order is sent by express',
  'the order weighs less than 1 kg',
  'the subtotal before discounts is 100 or more',
]);

const STATUSES = sorted(['approved', 'on-hold', 'rejected', 'review']);

const TAX_FROM = sorted([
  'one rate for every order, whatever the region',
  'the rate of the region the customer is registered in',
  'the rate of the region the invoice is sent to',
  'the rate of the region the order is delivered to',
]);

const LOYALTY_ON = sorted([
  'the amount after the coupon discount',
  'the grand total',
  'the subtotal before any discount',
  'the subtotal plus tax',
]);

const UNKNOWN_ITEM = sorted([
  'it holds the order as out of stock',
  'it leaves that line out and prices the rest',
  'it prices that line at zero and goes on',
  'it refuses the order with an error and gives no outcome',
]);

const REJECTS = sorted([
  'the customer has been a member for less than a year',
  'the grand total is more than 2000',
  "the grand total is more than the customer's order limit",
  'the order is delivered to a region the tax rate table does not list',
  'the shelf holds fewer units of an item than the order asks for',
  "what the customer already owes plus the grand total is more than the customer's credit limit",
]);

const CAP = sorted([
  'half of the subtotal',
  'no discount: the coupon is refused',
  "the coupon's full amount",
  'the whole subtotal, and no more',
]);

/** A customer row for one probe, only the years differing. */
const member = (years) => ({ name: 'Probe', creditLimit: 100000, orderLimit: 100000, openBalance: 0, memberYears: years });

export const PROGRAM_QUESTIONS = [
  {
    id: 'program-free-shipping',
    text: `Which of these conditions, each one on its own, makes an order ship free of charge? Choose every condition that does. ${choose(FREE)}`,
    shape: { type: 'set', options: FREE },
    rules: ['free-shipping'],
    howWithPrints: 'Read the shipping rule; or print the shipping charge after it is set, for orders that differ in one condition.',
    derive: async (ctx) => {
      const base = order('C-500', [['CABLE-USB', 1]]);
      const probes = {
        'the amount after discounts is 100 or more': order('C-500', [['MONITOR-27', 1]]),
        'the customer collects the order at the store': { ...base, shipMethod: 'pickup' },
        'the customer has been a member for five years or more': order('C-300', [['CABLE-USB', 1]], { shipRegion: 'west', billingRegion: 'west' }),
        'the order is delivered to the export region': { ...base, shipRegion: 'export' },
        'the order is sent by express': { ...base, shipMethod: 'express' },
        'the order weighs less than 1 kg': base,
        'the subtotal before discounts is 100 or more': order('C-500', [['DESK-LAMP', 3]], { couponCode: 'BULK50' }),
      };
      const plain = await ctx.run(base);
      expect(plain.result.shipping > 0 && plain.weightKg < 1, 'the plain probe pays shipping and weighs under 1 kg');
      const sub = await ctx.run(probes['the subtotal before discounts is 100 or more']);
      expect(sub.result.subtotal >= 100 && sub.netAmount < 100, 'the subtotal probe is 100 or more only before discounts');
      const free = [];
      for (const option of FREE) if ((await ctx.run(probes[option])).result.shipping === 0) free.push(option);
      return free;
    },
  },
  {
    id: 'program-bulk-discount',
    text: 'From how many units of one item on a single order line does that line get a quantity discount, and how many percent of the line\'s price does that discount take off? Answer with fromUnits (a number of units) and percentOff (a percentage, for example 12.5).',
    shape: { type: 'object', fields: { fromUnits: { type: 'number' }, percentOff: { type: 'number' } } },
    rules: ['line-price'],
    howWithPrints: 'Read the line pricing; or print each line total after a line is priced, for one-line orders of 9, 10 and 20 units.',
    derive: async (ctx) => {
      const discounted = [];
      for (let qty = 1; qty <= 30; qty++) {
        const [line] = (await ctx.run(order('C-500', [['PEN-BLUE', qty]], { shipMethod: 'pickup' }))).lines;
        discounted.push({ qty, line, off: line.lineTotal < toCent(qty * line.unitPrice) });
      }
      const from = discounted.find((d) => d.off).qty;
      expect(discounted.every((d) => d.off === d.qty >= from), 'every line from that quantity on, and none below, is discounted');
      const percent = (d) => toCent((1 - d.line.lineTotal / (d.qty * d.line.unitPrice)) * 100);
      expect(percent(discounted[19]) === percent(discounted[29]), 'the share is the same at 20 and 30 units');
      return { fromUnits: from, percentOff: percent(discounted[19]) };
    },
  },
  {
    id: 'program-outcome-order',
    text: `An order ends with one of four statuses: approved, on-hold, rejected or review. When an order meets the conditions of more than one, one status wins. List all four statuses in order: first the one that wins over every other, last the one given only when no other applies. ${choose(STATUSES)}`,
    shape: { type: 'list', options: STATUSES },
    rules: ['outcome', 'stock-check', 'credit-check'],
    howWithPrints: 'Read the outcome rules in the order they are tried; or print the status for an order short on the shelf, over a limit and over 2000, then drop one condition at a time.',
    derive: async (ctx) => {
      const allThree = await ctx.run(order('C-500', [['CHAIR-ERGO', 9]])); // short on the shelf, over both limits, over 2000
      const twoLeft = await ctx.run(order('C-500', [['CHAIR-ERGO', 8]])); // over both limits, over 2000
      const oneLeft = await ctx.run(order('C-200', [['CHAIR-ERGO', 6]])); // over 2000 only
      const none = await ctx.run(order('C-200', [['CABLE-USB', 1]]));
      expect(!allThree.stockOk && !allThree.creditOk && allThree.result.grandTotal > 2000, 'the first probe meets all three');
      expect(twoLeft.stockOk && !twoLeft.creditOk && twoLeft.result.grandTotal > 2000, 'the second meets two');
      expect(oneLeft.stockOk && oneLeft.creditOk && oneLeft.result.grandTotal > 2000, 'the third meets one');
      const list = [allThree, twoLeft, oneLeft, none].map((v) => v.result.status);
      expect(new Set(list).size === 4 && list.every((s) => STATUSES.includes(s)), 'four different statuses');
      return list;
    },
  },
  {
    id: 'program-tax-region',
    text: `Which rate of the tax rate table is applied to an order? ${choose(TAX_FROM)}`,
    shape: { type: 'enum', options: TAX_FROM },
    rules: ['tax-rate'],
    howWithPrints: 'Read where the tax rate is looked up; or print the rate used for orders that differ only in the delivery or the billing region.',
    derive: async (ctx) => {
      const rate = async (ship, bill) => (await ctx.run(order('C-500', [['CABLE-USB', 1]], { shipRegion: ship, billingRegion: bill }))).taxRatePercent;
      const southNorth = await rate('south', 'north');
      const northNorth = await rate('north', 'north');
      const southSouth = await rate('south', 'south');
      if (southNorth === southSouth && southNorth !== northNorth) return 'the rate of the region the order is delivered to';
      if (southNorth === northNorth && southNorth !== southSouth) return 'the rate of the region the invoice is sent to';
      if (southNorth === northNorth && northNorth === southSouth) return 'one rate for every order, whatever the region';
      throw new Error('the tax rate follows neither region');
    },
  },
  {
    id: 'program-default-tax-rate',
    text: 'What tax rate, in percent, is applied to an order delivered to a region that the tax rate table does not list?',
    shape: { type: 'number' },
    rules: ['tax-rate', 'tax'],
    howWithPrints: 'Read the tax rate lookup; or copy a fixture with an unknown delivery region and print the rate used.',
    derive: async (ctx) => (await ctx.run(order('C-500', [['CABLE-USB', 1]], { shipRegion: 'nowhere', billingRegion: 'nowhere' }))).taxRatePercent,
  },
  {
    id: 'program-loyalty',
    text: `From how many whole years of membership does a customer get the loyalty discount, how many percent does it take off, and on which amount is it worked out? Answer with fromYears (a number of years), percentOff (a percentage) and appliedTo, one of: ${LOYALTY_ON.map((o) => `"${o}"`).join(', ')}.`,
    shape: { type: 'object', fields: { fromYears: { type: 'number' }, percentOff: { type: 'number' }, appliedTo: { type: 'enum', options: LOYALTY_ON } } },
    rules: ['loyalty', 'coupon'],
    howWithPrints: 'Read the loyalty rule; or print the loyalty discount with the subtotal and the coupon discount for customers of different years.',
    derive: async (ctx) => {
      const lamps = (years, extra) => ctx.run(order('Q-YEARS', [['DESK-LAMP', 2]], extra), { customers: { 'Q-YEARS': member(years) } });
      const byYears = [];
      for (let years = 0; years <= 10; years++) byYears.push((await lamps(years)).result.loyaltyDiscount);
      const fromYears = byYears.findIndex((d) => d > 0);
      expect(fromYears > 0 && byYears.every((d, y) => (d > 0) === (y >= fromYears)), 'every customer from that year on, and none below, gets it');
      const loyal = await lamps(10);
      const percentOff = toCent((loyal.result.loyaltyDiscount / loyal.result.subtotal) * 100);
      const coupon = (await lamps(10, { couponCode: 'SPRING10' })).result;
      expect(coupon.discount > 0, 'the coupon probe has a coupon discount');
      const bases = {
        'the amount after the coupon discount': coupon.subtotal - coupon.discount,
        'the grand total': coupon.grandTotal,
        'the subtotal before any discount': coupon.subtotal,
        'the subtotal plus tax': coupon.subtotal + coupon.tax,
      };
      const appliedTo = onlyOption(LOYALTY_ON, (o) => toCent((bases[o] * percentOff) / 100) === coupon.loyaltyDiscount, 'the loyalty discount with a coupon');
      return { fromYears, percentOff, appliedTo };
    },
  },
  {
    id: 'program-unknown-item',
    text: `What does the desk do with an order that has a line whose item is not in the catalog? ${choose(UNKNOWN_ITEM)}`,
    shape: { type: 'enum', options: UNKNOWN_ITEM },
    rules: ['refusal'],
    howWithPrints: 'Read the line pricing; or copy a fixture with an unknown item and run it.',
    derive: async (ctx) => {
      const v = await ctx.run(order('C-500', [['CABLE-USB', 1], ['NO-SUCH-ITEM', 1]]));
      if (v.failure !== undefined && v.result.status === undefined) return 'it refuses the order with an error and gives no outcome';
      if (v.result.status === 'on-hold') return 'it holds the order as out of stock';
      return v.lines.length === 1 ? 'it leaves that line out and prices the rest' : 'it prices that line at zero and goes on';
    },
  },
  {
    id: 'program-shipping-charge',
    text: 'When shipping is charged, the charge is a fixed fee plus a fee per kilogram of the order\'s weight, and express delivery multiplies that charge. Answer with baseFee (the fixed fee), perKg (the fee per kilogram) and expressFactor (what express multiplies the charge by).',
    shape: { type: 'object', fields: { baseFee: { type: 'number' }, perKg: { type: 'number' }, expressFactor: { type: 'number' } } },
    rules: ['shipping-charge', 'weight'],
    howWithPrints: 'Read the shipping charge; or print the charge with the weight for standard and express orders of different weights.',
    derive: shippingModel,
  },
  {
    id: 'program-rejection-checks',
    text: `Which of these, each one on its own, makes the desk reject an order (status rejected)? Choose every one that does. ${choose(REJECTS)}`,
    shape: { type: 'set', options: REJECTS },
    rules: ['credit-check', 'outcome'],
    howWithPrints: 'Read the credit check and the outcome rules; or print the status for orders that each break one condition.',
    derive: async (ctx) => {
      const probes = {
        'the customer has been a member for less than a year': order('C-500', [['CABLE-USB', 1]]),
        'the grand total is more than 2000': order('C-200', [['CHAIR-ERGO', 6]]),
        "the grand total is more than the customer's order limit": order('C-400', [['CHAIR-ERGO', 7]]),
        'the order is delivered to a region the tax rate table does not list': order('C-500', [['CABLE-USB', 1]], { shipRegion: 'nowhere', billingRegion: 'nowhere' }),
        'the shelf holds fewer units of an item than the order asks for': order('C-200', [['DESK-LAMP', 6]]),
        "what the customer already owes plus the grand total is more than the customer's credit limit": order('C-300', [['MONITOR-27', 3]], { shipRegion: 'west', billingRegion: 'west' }),
      };
      const views = {};
      for (const option of REJECTS) views[option] = await ctx.run(probes[option]);
      const orderOnly = views["the grand total is more than the customer's order limit"];
      expect(orderOnly.result.grandTotal > orderOnly.customer.orderLimit && orderOnly.customer.openBalance + orderOnly.result.grandTotal <= orderOnly.customer.creditLimit && orderOnly.stockOk, 'the order-limit probe breaks only the order limit');
      const creditOnly = views["what the customer already owes plus the grand total is more than the customer's credit limit"];
      expect(creditOnly.customer.openBalance + creditOnly.result.grandTotal > creditOnly.customer.creditLimit && creditOnly.result.grandTotal <= creditOnly.customer.orderLimit && creditOnly.stockOk, 'the credit-limit probe breaks only the credit limit');
      return REJECTS.filter((o) => views[o].result.status === 'rejected');
    },
  },
  {
    id: 'program-fixed-coupon-cap',
    text: `An order uses a coupon worth a fixed amount, and its subtotal is smaller than that amount. What coupon discount does the order get? ${choose(CAP)}`,
    shape: { type: 'enum', options: CAP },
    rules: ['coupon'],
    howWithPrints: 'Read the coupon rule; or copy a small fixture with a fixed-amount coupon and print the coupon discount with the subtotal.',
    derive: async (ctx) => {
      const full = (await ctx.run(order('C-500', [['MONITOR-27', 1]], { couponCode: 'BULK50' }))).result.discount;
      const small = (await ctx.run(order('C-500', [['CABLE-USB', 3]], { couponCode: 'BULK50' }))).result;
      expect(full > small.subtotal, 'the coupon is worth more than the small subtotal');
      if (small.discount === small.subtotal) return 'the whole subtotal, and no more';
      if (small.discount === full) return "the coupon's full amount";
      if (small.discount === 0) return 'no discount: the coupon is refused';
      if (small.discount === toCent(small.subtotal / 2)) return 'half of the subtotal';
      throw new Error(`no option fits a discount of ${small.discount}`);
    },
  },
];
