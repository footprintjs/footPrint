/**
 * find-rate (inside the tax sub-flowchart): the tax rate of the region.
 *
 * Example: `region = 'south'` → `rate = 0.06`; an unlisted region → the default rate.
 */
import { DEFAULT_TAX_RATE, TAX_RATES } from '../../../../data/tax-rates.mjs';

export const purpose = 'Find the tax rate of the region.';

/** @param {any} scope */
export function run(scope) {
  scope.rate = TAX_RATES[scope.region] ?? DEFAULT_TAX_RATE;
}
