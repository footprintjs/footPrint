/**
 * The tax sub-flowchart: wiring only. Rate first, then the tax.
 *
 *   find-rate → compute-tax
 */
import { flowChart } from 'footprintjs';

import * as computeTax from './steps/compute-tax/index.mjs';
import * as findRate from './steps/find-rate/index.mjs';

export const purpose = 'Work out the sales tax for the region the order ships to.';

/** Builds the tax sub-flowchart. */
export function buildTaxChart() {
  return flowChart('Find rate', findRate.run, 'find-rate', { description: findRate.purpose })
    .addFunction('Compute tax', computeTax.run, 'compute-tax', computeTax.purpose)
    .build();
}
