/**
 * The order desk's chart: wiring only. Every rule lives in a step.
 *
 *   receive-order → load-customer → start-lines
 *     → price-line → more-lines ─ next-line ─┐ (back to price-line)
 *                               └ lines-priced
 *     → apply-coupon → loyalty-discount → net-amount
 *     → [tax: find-rate → compute-tax]
 *     → shipping-rule ─ free-shipping | standard-shipping
 *     → grand-total
 *     → check-stock ∥ check-credit → combine-checks
 *     → approval ─ hold | reject | review | approve
 */
import { flowChart } from 'footprintjs';

import * as applyCoupon from './steps/apply-coupon/index.mjs';
import * as approval from './steps/approval/index.mjs';
import * as approve from './steps/approve/index.mjs';
import * as checkCredit from './steps/check-credit/index.mjs';
import * as checkStock from './steps/check-stock/index.mjs';
import * as combineChecks from './steps/combine-checks/index.mjs';
import * as freeShipping from './steps/free-shipping/index.mjs';
import * as grandTotal from './steps/grand-total/index.mjs';
import * as hold from './steps/hold/index.mjs';
import * as linesPriced from './steps/lines-priced/index.mjs';
import * as loadCustomer from './steps/load-customer/index.mjs';
import * as loyaltyDiscount from './steps/loyalty-discount/index.mjs';
import * as moreLines from './steps/more-lines/index.mjs';
import * as netAmount from './steps/net-amount/index.mjs';
import * as nextLine from './steps/next-line/index.mjs';
import * as priceLine from './steps/price-line/index.mjs';
import * as receiveOrder from './steps/receive-order/index.mjs';
import * as reject from './steps/reject/index.mjs';
import * as review from './steps/review/index.mjs';
import * as shippingRule from './steps/shipping-rule/index.mjs';
import * as standardShipping from './steps/standard-shipping/index.mjs';
import * as startLines from './steps/start-lines/index.mjs';
import { buildTaxChart } from './subflows/tax/chart.mjs';
import { taxInput, taxOutput } from './subflows/tax/mappers.mjs';

/** Builds the order desk chart. */
export function buildChart() {
  return flowChart('Receive order', receiveOrder.run, 'receive-order', { description: receiveOrder.purpose })
    .addFunction('Load customer', loadCustomer.run, 'load-customer', loadCustomer.purpose)
    .addFunction('Start lines', startLines.run, 'start-lines', startLines.purpose)
    .addFunction('Price line', priceLine.run, 'price-line', priceLine.purpose)
    .addDeciderFunction('More lines', moreLines.run, 'more-lines', moreLines.purpose)
    .addFunctionBranch('next-line', 'Next line', nextLine.run, nextLine.purpose, { loopTo: 'price-line' })
    .addFunctionBranch('lines-priced', 'Lines priced', linesPriced.run, linesPriced.purpose)
    .end()
    .addFunction('Apply coupon', applyCoupon.run, 'apply-coupon', applyCoupon.purpose)
    .addFunction('Loyalty discount', loyaltyDiscount.run, 'loyalty-discount', loyaltyDiscount.purpose)
    .addFunction('Net amount', netAmount.run, 'net-amount', netAmount.purpose)
    .addSubFlowChartNext('tax', buildTaxChart(), 'Tax', { inputMapper: taxInput, outputMapper: taxOutput })
    .addDeciderFunction('Shipping rule', shippingRule.run, 'shipping-rule', shippingRule.purpose)
    .addFunctionBranch('free-shipping', 'Free shipping', freeShipping.run, freeShipping.purpose)
    .addFunctionBranch('standard-shipping', 'Standard shipping', standardShipping.run, standardShipping.purpose)
    .end()
    .addFunction('Grand total', grandTotal.run, 'grand-total', grandTotal.purpose)
    .addListOfFunction([
      { id: 'check-stock', name: 'Check stock', fn: checkStock.run },
      { id: 'check-credit', name: 'Check credit', fn: checkCredit.run },
    ])
    .addFunction('Combine checks', combineChecks.run, 'combine-checks', combineChecks.purpose)
    .addDeciderFunction('Approval', approval.run, 'approval', approval.purpose)
    .addFunctionBranch('hold', 'Hold', hold.run, hold.purpose)
    .addFunctionBranch('reject', 'Reject', reject.run, reject.purpose)
    .addFunctionBranch('review', 'Review', review.run, review.purpose)
    .addFunctionBranch('approve', 'Approve', approve.run, approve.purpose)
    .end()
    .build();
}
