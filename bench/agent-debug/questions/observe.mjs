/**
 * What the question generator sees of the flowchart program: it runs F's
 * real chart on an order, keeps the run record (tools/record/run-record.mjs
 * · recordOrder, the same record the record tools read) and hands each
 * answer function a VIEW in business words.
 *
 * Why business words: an answer function must not depend on F's key names,
 * so that the same function can be fed a view of the twin built from its
 * prints (the later proof against P, RULE-2.md). This file is the one place
 * where F's vocabulary is turned into the view's:
 *
 * | View field | From F's run |
 * |---|---|
 * | `result` | the printed result (order-desk.mjs · RESULT_KEYS of the final state) |
 * | `lines` | `pricedLines` (item, qty, unit price, line total) |
 * | `weightKg`, `netAmount`, `stockOk`, `shortItems`, `creditOk` | `totalWeight`, `netAmount`, `stockOk`, `shortSkus`, `creditOk` |
 * | `taxRatePercent` | `taxRate` × 100 |
 * | `headroom` | the credit check's own `headroom` |
 * | `customer` | the four facts the desk keeps (`customer`) |
 * | `freeShippingBy` | the shipping decision's matched rule: a rule on `shipMethod` → `'collected'`, on `netAmount` → `'amount'`, the default → `null` |
 * | `reviewAbove` | the outcome decision's rule on `grandTotal`: its threshold |
 * | `failure` | the run's error message, when the desk refused the order |
 *
 * Tables: `run(order, { stock, customers })` adds or changes rows of the
 * program's own stock and customer tables for that one run (the imported
 * table objects are the ones the steps read) and puts them back after it.
 * Used where a rule cannot be seen with the rows the tables hold (no
 * customer has 3 or 4 years, so the loyalty threshold needs one).
 * Example: `(await ctx.run(ctx.fixture('clinic-monitors'))).taxRatePercent` → `6`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROGRAMS } from '../harness/programs.mjs';
import { toCent } from '../harness/shapes.mjs';
import { addressOf, recordOrder } from '../tools/record/run-record.mjs';
import { loadChart } from '../tools/record/structure.mjs';

const F = PROGRAMS.F.dir;
const load = (/** @type {string} */ rel) => import(pathToFileURL(join(F, rel)).href);

/**
 * @typedef {object} View
 * @property {object} order
 * @property {Record<string, any>} result
 * @property {string | undefined} failure
 * @property {{ item: string, qty: number, unitPrice: number, lineTotal: number }[]} lines
 * @property {number} weightKg
 * @property {number} netAmount
 * @property {number} taxRatePercent
 * @property {boolean} stockOk
 * @property {string[]} shortItems
 * @property {boolean} creditOk
 * @property {number} headroom
 * @property {{ creditLimit: number, orderLimit: number, openBalance: number, memberYears: number }} customer
 * @property {'collected' | 'amount' | null} freeShippingBy
 * @property {number | undefined} reviewAbove
 */

/** The last decision event of a step, by its address. */
function lastDecision(record, address) {
  let found;
  for (const [id, event] of record.decisions) if (addressOf(id) === address) found = event;
  return found;
}

/** The view of one record. @returns {View} */
function viewOf(record, order, resultKeys) {
  const s = record.snapshot.sharedState;
  const shipping = lastDecision(record, 'shipping-rule')?.evidence;
  const matched = shipping?.rules?.find((r) => r.matched);
  const byKey = { shipMethod: 'collected', netAmount: 'amount' };
  const approval = lastDecision(record, 'approval')?.evidence;
  const reviewRule = approval?.rules?.find((r) => r.conditions?.some((c) => c.key === 'grandTotal'));
  return {
    order,
    result: Object.fromEntries(resultKeys.map((k) => [k, s[k]])),
    failure: record.failure,
    lines: (s.pricedLines ?? []).map((l) => ({ item: l.sku, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal })),
    weightKg: s.totalWeight,
    netAmount: s.netAmount,
    taxRatePercent: s.taxRate === undefined ? undefined : toCent(s.taxRate * 100),
    stockOk: s.stockOk,
    shortItems: s.shortSkus,
    creditOk: s.creditOk,
    headroom: s.runs?.['check-credit']?.headroom,
    customer: s.customer,
    freeShippingBy: matched ? (byKey[matched.conditions?.[0]?.key] ?? 'unknown') : shipping ? null : undefined,
    reviewAbove: reviewRule?.conditions?.find((c) => c.key === 'grandTotal')?.threshold,
  };
}

/**
 * The generator's context: fixtures by name and runs of F.
 * @returns {Promise<{ fixture: (name: string) => any, run: (order: object, tables?: { stock?: Record<string, number>, customers?: Record<string, object> }) => Promise<View> }>}
 */
export async function makeContext() {
  const chart = await loadChart(F);
  const { RESULT_KEYS } = await load('src/order-desk.mjs');
  const { STOCK } = await load('src/data/stock.mjs');
  const { CUSTOMERS } = await load('src/data/customers.mjs');
  // Runs one at a time, even when an answer function starts several at once:
  // a table row added for one run must never be seen by another.
  let queue = Promise.resolve();
  const runOne = async (order, tables = {}) => {
      const saved = [];
      const put = (table, rows) => {
        for (const [k, v] of Object.entries(rows ?? {})) {
          saved.push([table, k, Object.hasOwn(table, k), table[k]]);
          table[k] = v;
        }
      };
      put(STOCK, tables.stock);
      put(CUSTOMERS, tables.customers);
      // The engine reports a refused order on console.error; the view keeps
      // the refusal as `failure`, so the generator's output stays quiet.
      const error = console.error;
      console.error = () => {};
      try {
        return viewOf(await recordOrder(chart, structuredClone(order)), order, RESULT_KEYS);
      } finally {
        console.error = error;
        for (const [table, k, had, v] of saved.reverse()) {
          if (had) table[k] = v;
          else delete table[k];
        }
      }
  };
  return {
    fixture: (name) => JSON.parse(readFileSync(join(F, 'fixtures', `${name}.json`), 'utf8')).order,
    run: (order, tables) => {
      const next = queue.then(() => runOne(order, tables));
      queue = next.catch(() => {});
      return next;
    },
  };
}
