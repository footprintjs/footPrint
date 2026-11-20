/**
 * What the question proof sees of the ordinary twin: the same view as
 * observe.mjs gives of the flowchart program, built from what the twin
 * computes and prints, so that every answer function can run unchanged on
 * the twin (RULE-2.md: the script that computes the answers from F "proves
 * each of them against P by running P with prints").
 *
 * How, without editing the twin: the twin's `src/` is copied to a temporary
 * folder, a few `console.log` lines are added to the COPY (as an agent with
 * prints would add them), and the copy is imported. Nothing else of the copy
 * changes; each added print is one exact text found once and kept in
 * `PRINTS`, with what it prints. The twin's own files are never touched.
 *
 * | View field | From the twin |
 * |---|---|
 * | `result` | `toResult(runOrder({ order }))`, its printed result (harness/scoring-child/result-of.mjs) |
 * | `lines`, `weightKg`, `netAmount`, `stockOk`, `shortItems`, `creditOk`, `headroom` | the figures `runOrder` returns: `lines`, `totalWeightKg`, `netAmount`, `stockOk`, `shortItems`, `creditOk`, `headroom` |
 * | `taxRatePercent` | `taxRate` × 100 |
 * | `customer` | a print of the customer's row where the order is accepted (its four facts) |
 * | `freeShippingBy` | a print in each free-shipping `return 0` of the shipping charge: collected or amount; neither printed → `null` |
 * | `reviewAbove` | a print of the review amount where the outcome compares the grand total with it |
 * | `failure` | the refusal's message, when the twin refused the order |
 *
 * Tables: `run(order, { stock, customers })` adds or changes rows of the
 * COPY's stock and customer tables for that one run and puts them back after
 * it: the twin's default tables are those very objects, so this is the row
 * an agent would add to the copy's table file, without a file write per run.
 * It is the same mechanism observe.mjs uses on F.
 * Example: `(await ctx.run(ctx.fixture('clinic-monitors'))).taxRatePercent` → `6`.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { countOccurrences } from '../faults/apply.mjs';
import { PROGRAMS } from '../harness/programs.mjs';
import { RESULT_OF } from '../harness/scoring-child/result-of.mjs';
import { toCent } from '../harness/shapes.mjs';

const MARK = 'PRINT ';

/**
 * The prints added to the copy: in `file`, `find` (found exactly once) is
 * replaced by `replace`, which is `find` with one `console.log` beside it.
 */
export const PRINTS = Object.freeze([
  {
    file: 'src/order-desk.mjs',
    find: '  const customer = acceptCustomer(order, tables.customers);\n',
    replace: `  const customer = acceptCustomer(order, tables.customers);\n  console.log('${MARK}customer ' + JSON.stringify(customer));\n`,
  },
  {
    file: 'src/charges.mjs',
    find: "  if (shipMethod === 'pickup') return 0;\n",
    replace: `  if (shipMethod === 'pickup') { console.log('${MARK}free collected'); return 0; }\n`,
  },
  {
    file: 'src/charges.mjs',
    find: '  if (net >= FREE_SHIPPING_FROM) return 0;\n',
    replace: `  if (net >= FREE_SHIPPING_FROM) { console.log('${MARK}free amount'); return 0; }\n`,
  },
  {
    file: 'src/outcome.mjs',
    find: '  if (grandTotal > LARGE_ORDER_ABOVE)',
    replace: `  console.log('${MARK}review-above ' + LARGE_ORDER_ABOVE);\n  if (grandTotal > LARGE_ORDER_ABOVE)`,
  },
]);

/** Copies the twin's src/ to a new folder and adds the prints. @returns {string} the copy's root */
export function printingCopy(twinDir = PROGRAMS.P.dir) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-debug-twin-prints-'));
  cpSync(join(twinDir, 'src'), join(dir, 'src'), { recursive: true });
  for (const p of PRINTS) {
    const path = join(dir, p.file);
    const text = readFileSync(path, 'utf8');
    const count = countOccurrences(text, p.find);
    if (count !== 1) throw new Error(`the print for ${p.file} finds its place ${count} times, expected once`);
    writeFileSync(path, text.replace(p.find, () => p.replace));
  }
  return dir;
}

/** The view of one run of the twin, from its figures and its prints. @returns {import('./observe.mjs').View} */
function viewOf(order, figures, result, failure, printedLines) {
  const said = (word) => printedLines.filter((l) => l.startsWith(`${MARK}${word}`)).map((l) => l.slice(MARK.length + word.length).trim());
  const customer = said('customer ').map((t) => JSON.parse(t)).at(-1);
  const free = said('free ');
  const reviewAbove = said('review-above ').map(Number).at(-1);
  return {
    order,
    result,
    failure,
    lines: (figures?.lines ?? []).map((l) => ({ item: l.sku, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal })),
    weightKg: figures?.totalWeightKg,
    netAmount: figures?.netAmount,
    taxRatePercent: figures?.taxRate === undefined ? undefined : toCent(figures.taxRate * 100),
    stockOk: figures?.stockOk,
    shortItems: figures?.shortItems,
    creditOk: figures?.creditOk,
    headroom: figures?.headroom,
    customer: customer && { creditLimit: customer.creditLimit, orderLimit: customer.orderLimit, openBalance: customer.openBalance, memberYears: customer.memberYears },
    freeShippingBy: figures === undefined ? undefined : free.length === 0 ? null : free.at(-1) === 'collected' ? 'collected' : 'amount',
    reviewAbove,
  };
}

/**
 * The question proof's context on the twin, with the interface of
 * observe.mjs · makeContext, plus `close()` to remove the copy.
 * @param {string} [twinDir]
 */
export async function makeTwinContext(twinDir = PROGRAMS.P.dir) {
  const dir = printingCopy(twinDir);
  const load = (/** @type {string} */ rel) => import(pathToFileURL(join(dir, rel)).href);
  const desk = await load('src/order-desk.mjs');
  const { STOCK } = await load('src/data/stock.mjs');
  const { CUSTOMERS } = await load('src/data/customers.mjs');
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
    const printedLines = [];
    const log = console.log;
    console.log = (...args) => printedLines.push(args.join(' '));
    try {
      const input = structuredClone(order);
      let figures;
      let failure;
      try {
        figures = desk.runOrder({ order: input });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      // The printed result, by the one rule the harness uses for the twin (a second call, as `run_order` would print it).
      const result = figures === undefined ? {} : await RESULT_OF.P(desk, structuredClone(order));
      return viewOf(order, figures, result, failure, printedLines);
    } finally {
      console.log = log;
      for (const [table, k, had, v] of saved.reverse()) {
        if (had) table[k] = v;
        else delete table[k];
      }
    }
  };
  let queue = Promise.resolve();
  return {
    fixture: (name) => JSON.parse(readFileSync(join(twinDir, 'fixtures', `${name}.json`), 'utf8')).order,
    run: (order, tables) => {
      const next = queue.then(() => runOne(order, tables));
      queue = next.catch(() => {});
      return next;
    },
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}
