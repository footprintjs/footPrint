/**
 * Flowchart: Decider (Conditional Branching)
 *
 * Uses decide() for automatic decision reasoning capture.
 * The narrative shows which values were read and why the branch was chosen.
 *
 *                   +-- "premium"  -> ApplyLoyaltyDiscount
 *   LoadCustomer -> ClassifyTier --+-- "standard" -> SuggestUpgrade
 *                   +-- "trial"    -> ShowOnboarding    (default)
 *                                           |
 *                                      CalculateTotal
 * Try it: https://footprintjs.github.io/footprint-playground/samples/decider
 */

import {
  flowChart,
  FlowChartExecutor,
  decide,
} from 'footprintjs';

interface Customer {
  name: string;
  plan: string;
  totalSpend: number;
  since: string;
}

interface DeciderState {
  customer: Customer;
  cartAmount: number;
  discountPct: number;
  message: string;
  finalAmount: number;
}

(async () => {

const customerDB = new Map([
  ['C-42', { name: 'Charlie', plan: 'premium', totalSpend: 4_200, since: '2022-03-01' }],
  ['C-77', { name: 'Dana', plan: 'standard', totalSpend: 320, since: '2024-11-15' }],
  ['C-99', { name: 'Eve', plan: 'trial', totalSpend: 0, since: '2025-02-28' }],
]);

const chart = flowChart<DeciderState>('LoadCustomer', async (scope) => {
  scope.customer = customerDB.get('C-42')!;
  scope.cartAmount = 150;
}, 'load-customer')

  .addDeciderFunction('ClassifyTier', (scope) => {
    // decide() auto-captures which values were read and their values.
    // Use filter syntax for flat keys, function syntax for nested/complex logic.
    return decide(scope, [
      {
        when: (s) => s.customer.plan === 'premium' && s.customer.totalSpend > 1000,
        then: 'premium',
        label: 'Premium with high spend',
      },
      {
        when: (s) => s.customer.plan === 'standard',
        then: 'standard',
        label: 'Standard plan',
      },
    ], 'trial');
  }, 'classify-tier', 'Classify customer into premium, standard, or trial tier')
    .addFunctionBranch('premium', 'ApplyLoyaltyDiscount', async (scope) => {
      const years = new Date().getFullYear() - new Date(scope.customer.since).getFullYear();
      scope.discountPct = Math.min(years * 5, 25);
      scope.message = `Thank you for ${years} years! ${scope.discountPct}% loyalty discount.`;
    }, 'Apply loyalty discount')
    .addFunctionBranch('standard', 'SuggestUpgrade', async (scope) => {
      scope.discountPct = 5;
      scope.message = 'Upgrade to Premium for up to 25% off every order.';
    }, 'Offer 5% and suggest upgrade')
    .addFunctionBranch('trial', 'ShowOnboarding', async (scope) => {
      scope.discountPct = 10;
      scope.message = 'Welcome! Enjoy 10% off your first order.';
    }, 'Welcome onboarding with 10% off')
    .setDefault('trial')
    .end()
  .addFunction('CalculateTotal', async (scope) => {
    scope.finalAmount = Math.round(scope.cartAmount * (1 - scope.discountPct / 100) * 100) / 100;
    console.log(`  Total: $${scope.cartAmount} -> $${scope.finalAmount} (${scope.discountPct}% off)`);
  }, 'calculate-total', 'Calculate final amount after discount')
  .build();

const executor = new FlowChartExecutor(chart);
executor.enableNarrative();
await executor.run();

console.log('=== Decider with decide() ===\n');
executor.getNarrativeEntries().map(e => e.text).forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
