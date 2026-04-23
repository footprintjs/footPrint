/**
 * Feature: $break() — Early Pipeline Termination
 *
 * Call scope.$break() to stop the pipeline after the current stage completes.
 * The stage's writes are committed, but no further stages execute.
 *
 * Use cases:
 * - Validation gates (stop if input is invalid)
 * - Early exits (goal already reached, skip remaining work)
 * - Safety limits (cost/token budget exceeded)
 *
 * Run:  npm run feature:break
 * Try it: https://footprintjs.github.io/footprint-playground/samples/break-fn
 */

import {
  flowChart,
  FlowChartExecutor,
} from 'footprintjs';

// ── Scenario 1: Validation gate — stop pipeline on bad input ────────────

interface PaymentState {
  amount: number;
  currency: string;
  rejected?: boolean;
  reason?: string;
  processed?: boolean;
  transactionId?: string;
  emailSent?: boolean;
}

(async () => {

console.log('=== Scenario 1: Validation Gate ===\n');

const validationChart = flowChart<PaymentState>(
  'ValidateInput',
  async (scope) => {
    scope.amount = 75_000;
    scope.currency = 'USD';

    if (scope.amount > 50_000) {
      scope.rejected = true;
      scope.reason = `Amount $${scope.amount.toLocaleString()} exceeds $50,000 limit`;
      scope.$break(); // stop here, don't process further
    }
  },
  'validate-input',
)

  .addFunction('ProcessPayment', async (scope) => {
    // This never runs when $break() is called
    scope.processed = true;
    scope.transactionId = 'TXN-' + Date.now();
  }, 'process-payment')
  .addFunction('SendConfirmation', async (scope) => {
    // This never runs either
    scope.emailSent = true;
  }, 'send-confirmation')
  .build();

const executor1 = new FlowChartExecutor(validationChart);
executor1.enableNarrative();
await executor1.run();

executor1.getNarrativeEntries().map(e => e.text).forEach((line) => console.log(`  ${line}`));
console.log('\n  ProcessPayment and SendConfirmation never ran.\n');

// ── Scenario 2: Budget limit — stop when cost threshold is reached ──────

interface BudgetState {
  budget: number;
  spent: number;
  items: string[];
  budgetExhausted?: boolean;
}

console.log('=== Scenario 2: Budget Limit ===\n');

const budgetChart = flowChart<BudgetState>(
  'Init',
  async (scope) => {
    scope.budget = 100;
    scope.spent = 0;
    scope.items = [];
  },
  'init',
)

  .addFunction('BuyItem1', async (scope) => {
    scope.spent = scope.spent + 30;
    scope.items = [...scope.items, 'Widget A ($30)'];
    if (scope.spent >= scope.budget) {
      scope.budgetExhausted = true;
      scope.$break();
    }
  }, 'buy-item-1')
  .addFunction('BuyItem2', async (scope) => {
    scope.spent = scope.spent + 45;
    scope.items = [...scope.items, 'Widget B ($45)'];
    if (scope.spent >= scope.budget) {
      scope.budgetExhausted = true;
      scope.$break();
    }
  }, 'buy-item-2')
  .addFunction('BuyItem3', async (scope) => {
    scope.spent = scope.spent + 50;
    scope.items = [...scope.items, 'Widget C ($50)'];
    if (scope.spent >= scope.budget) {
      scope.budgetExhausted = true;
      scope.$break();
    }
  }, 'buy-item-3')
  .addFunction('BuyItem4', async (scope) => {
    // Won't run — budget exhausted at Item 3
    scope.items = [...scope.items, 'Widget D ($25)'];
  }, 'buy-item-4')
  .build();

const executor2 = new FlowChartExecutor(budgetChart);
executor2.enableNarrative();
await executor2.run();

executor2.getNarrativeEntries().map(e => e.text).forEach((line) => console.log(`  ${line}`));
console.log('\n  BuyItem4 never ran — budget of $100 reached at $125.\n');

})().catch(console.error);
