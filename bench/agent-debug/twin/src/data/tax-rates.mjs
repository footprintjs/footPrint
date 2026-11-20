/**
 * Sales tax by the region the order ships to.
 *
 * Why by shipping region: tax is owed where the goods are delivered, not
 * where the invoice goes. Example: `TAX_RATES.north` → `0.08`.
 *
 * @type {Record<string, number>}
 */
export const TAX_RATES = {
  north: 0.08,
  south: 0.06,
  east: 0.0725,
  west: 0.05,
  export: 0,
};

/** The rate for a region the table does not list. */
export const DEFAULT_TAX_RATE = 0.08;
