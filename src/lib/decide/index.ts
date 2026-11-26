/**
 * decide/ -- Decision reasoning capture for footprintjs.
 *
 * decide() and select() auto-capture evidence from decider/selector functions; decideFromFacts() evaluates the
 * same rules over a plain record, and decisionRecord() / fixedRecord() give the record of a decision:
 * - Function when: (s) => s.creditScore > 700  (auto-captures reads)
 * - Filter when:  { creditScore: { gt: 700 } }  (captures reads + operators + thresholds)
 */

// Types
export type {
  DecideRule,
  DecisionEvidence,
  DecisionResult,
  DefaultBranch,
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

// The scope-free door and the decision record
export type { DecisionFromFacts } from './fromFacts.js';
export { decideFromFacts } from './fromFacts.js';
export type { DecisionRecord, DecisionVoucher } from './record.js';
export { decisionRecord, fixedRecord } from './record.js';

// Evaluator (for advanced use)
export { evaluateFilter } from '../filter/evaluator.js';

// Evidence collector (for advanced use)
export { EvidenceCollector } from './evidence.js';
