/**
 * decide/ -- Decision reasoning capture for footprintjs.
 *
 * decide() and select() auto-capture evidence from decider/selector functions:
 * - Function when: (s) => s.creditScore > 700  (auto-captures reads)
 * - Filter when:  { creditScore: { gt: 700 } }  (captures reads + operators + thresholds)
 */
export type { DecideRule, DecisionEvidence, DecisionResult, FilterCondition, FilterOps, FilterRuleEvidence, FunctionRuleEvidence, ReadInput, RuleEvidence, SelectionEvidence, SelectionResult, WhenClause, WhereFilter, } from './types.js';
export { DECISION_RESULT } from './types.js';
export { decide, select } from './decide.js';
export { evaluateFilter } from './evaluator.js';
export { EvidenceCollector } from './evidence.js';
