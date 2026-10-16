/**
 * budget/ — the static time budget: the slowest a built chart can take, from its declared retry policies, and every
 * stage that makes a path unbounded (design docs/design/2026-10-time-and-failure-evidence.md §3.2, packet P5).
 *
 * Public: `timeBudget` and its report types. `budgetRefusal` / `budgetWarning` are the builder's words for
 * `build()`; `warnDeadlineUnderBudget` is the executor's run-start warning.
 */

export type {
  BudgetAssumptions,
  BudgetStep,
  TimeBudgetOptions,
  TimeBudgetReport,
  UnboundedReason,
  UnboundedStage,
} from './timeBudget.js';
export { budgetRefusal, budgetWarning, declaredBudget, timeBudget, warnDeadlineUnderBudget } from './timeBudget.js';
