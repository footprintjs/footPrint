/**
 * How to get the result of one order from a program's entry module, in
 * process: the ONE owner of each program's calling convention.
 *
 * Why it is needed: the two programs do not share an entry point, and the
 * twin may not be edited (RULE-2.md: it was written by someone who never saw
 * the flowchart program, so any edit by us would end that). The flowchart
 * program exports `async runOrder(order)` giving the nine printed keys. The
 * twin exports `runOrder({ order })` giving every figure it works out and
 * `toResult(figures)` giving the nine printed keys, both synchronous (its
 * own visible tests call them that way). So the difference is solved here,
 * on the harness's side, as data the program table points at.
 *
 * Why in this folder: the scoring child runs confined to its copy and the
 * runtime folder (harness/runtime.mjs copies this folder there), so it can
 * import this file and nothing else of the harness. The parent's in-process
 * callers (harness/programs.mjs · PROGRAMS, the question proof against the
 * twin, the fault-pair test) import the same file, so there is no second copy
 * of the rule.
 *
 * Both answer with the result object a program prints; printed, both are
 * `JSON.stringify(result, null, 2)` and a newline (`printed`). A refused
 * order rejects, with the program's own message.
 * Example: `await RESULT_OF.P(await import('<twin>/src/order-desk.mjs'), order)`
 * → `{ orderId: 'A-1001', status: 'approved', … }`.
 */

/** @typedef {(entry: any, order: object) => Promise<Record<string, unknown>>} ResultOf */

/** @type {Readonly<Record<'F' | 'P', ResultOf>>} */
export const RESULT_OF = Object.freeze({
  F: async (entry, order) => entry.runOrder(order),
  P: async (entry, order) => entry.toResult(entry.runOrder({ order })),
});

/**
 * A result as the command line prints it.
 * @param {Record<string, unknown>} result
 */
export function printed(result) {
  return `${JSON.stringify(result, null, 2)}\n`;
}
