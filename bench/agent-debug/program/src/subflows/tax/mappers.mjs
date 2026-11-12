/**
 * What crosses into and out of the tax sub-flowchart.
 *
 * Why mappers: the sub-flowchart sees only what it is handed, so it can be
 * tested alone, and the parent sees only what it hands back.
 * Example: parent `shipRegion = 'south'`, `netAmount = 450` → inside
 * `region = 'south'`, `amount = 450`; inside `tax = 27` → parent `tax = 27`.
 */

/**
 * The parent's keys handed to the tax sub-flowchart: tax is owed where the
 * goods are delivered, on the amount after discounts.
 * @param {any} scope the parent's state
 */
export function taxInput(scope) {
  return { region: scope.shipRegion, amount: scope.netAmount };
}

/**
 * The tax sub-flowchart's answers copied back to the parent.
 * @param {any} out the sub-flowchart's final state
 */
export function taxOutput(out) {
  return { tax: out.tax, taxRate: out.rate };
}
