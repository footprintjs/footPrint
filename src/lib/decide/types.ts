/**
 * decide/types -- Type definitions for the decide()/select() decision reasoning system.
 *
 * Two `when` formats in one API:
 * - Function: (s) => s.creditScore > 700   (auto-captures reads via temp recorder)
 * - Filter:   { creditScore: { gt: 700 } } (captures reads + operators + thresholds)
 */

// -- Filter Operators (Prisma naming, 8 operators) ---------------------------

export type FilterOps<V> = {
  /** Equal: value === threshold */
  eq?: V;
  /** Not equal: value !== threshold */
  ne?: V;
  /** Greater than: value > threshold */
  gt?: V;
  /** Greater than or equal: value >= threshold */
  gte?: V;
  /** Less than: value < threshold */
  lt?: V;
  /** Less than or equal: value <= threshold */
  lte?: V;
  /** Value is in array */
  in?: V[];
  /** Value is NOT in array */
  notIn?: V[];
};

// -- WhereFilter (flat keys only, no nested v1) ------------------------------

export type WhereFilter<T extends Record<string, unknown> = Record<string, unknown>> = {
  [K in keyof T]?: FilterOps<T[K]>;
};

// -- Rule Definition ---------------------------------------------------------

export type WhenClause<T extends Record<string, unknown> = Record<string, unknown>> =
  | ((s: T) => boolean)
  | WhereFilter<T>;

export interface DecideRule<T extends Record<string, unknown> = Record<string, unknown>> {
  when: WhenClause<T>;
  then: string;
  /** Human-readable rule name for narrative: "Good credit" */
  label?: string;
}

// -- Symbol Brand (duck-type safety) -----------------------------------------

export const DECISION_RESULT = Symbol('footprint:decide:result');

// -- Decision Result (from decide()) ----------------------------------------

export interface DecisionResult {
  branch: string;
  [DECISION_RESULT]: true;
  evidence: DecisionEvidence;
}

// -- Selection Result (from select()) ----------------------------------------

export interface SelectionResult {
  branches: string[];
  [DECISION_RESULT]: true;
  evidence: SelectionEvidence;
}

// -- Evidence Types ----------------------------------------------------------

export interface FunctionRuleEvidence {
  type: 'function';
  ruleIndex: number;
  matched: boolean;
  label?: string;
  inputs: ReadInput[];
}

export interface FilterRuleEvidence {
  type: 'filter';
  ruleIndex: number;
  matched: boolean;
  label?: string;
  conditions: FilterCondition[];
}

export type RuleEvidence = FunctionRuleEvidence | FilterRuleEvidence;

export interface ReadInput {
  key: string;
  valueSummary: string;
  redacted: boolean;
}

export interface FilterCondition {
  key: string;
  op: string;
  /** Kept raw for audit accuracy; engine/serializer must handle safely. */
  threshold: unknown;
  actualSummary: string;
  result: boolean;
  redacted: boolean;
}

export interface DecisionEvidence {
  rules: RuleEvidence[];
  chosen: string;
  default: string;
}

export interface SelectionEvidence {
  rules: RuleEvidence[];
  selected: string[];
}
