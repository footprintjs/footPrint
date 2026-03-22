/**
 * decide/ -- Decision reasoning capture for footprintjs.
 *
 * decide() and select() auto-capture evidence from decider/selector functions:
 * - Function when: (s) => s.creditScore > 700  (auto-captures reads)
 * - Filter when:  { creditScore: { gt: 700 } }  (captures reads + operators + thresholds)
 */

// Types
export type {
  DecideRule,
  DecisionEvidence,
  DecisionResult,
  FilterCondition,
  FilterOps,
  FilterRuleEvidence,
  FunctionRuleEvidence,
  ReadInput,
  RuleEvidence,
  SelectionEvidence,
  SelectionResult,
  WhenClause,
  WhereFilter,
} from './types.js';

// Runtime constants
export { DECISION_RESULT } from './types.js';

// Core functions
export { decide, select } from './decide.js';

// Evaluator (for advanced use)
export { evaluateFilter } from './evaluator.js';

// Evidence collector (for advanced use)
export { EvidenceCollector } from './evidence.js';
