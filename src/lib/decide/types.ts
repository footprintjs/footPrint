/**
 * decide/types -- Type definitions for the decide()/select() decision reasoning system.
 *
 * Two `when` formats in one API:
 * - Function: (s) => s.creditScore > 700   (auto-captures reads via temp recorder)
 * - Filter:   { creditScore: { gt: 700 } } (captures reads + operators + thresholds)
 */

// -- Filter Operators (Prisma naming, 8 operators) ---------------------------

/** Multiple operators on the same key are ANDed (e.g., { gt: 5, lt: 10 } means 5 < value < 10). */
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

export type WhereFilter<T extends object = Record<string, unknown>> = {
  [K in keyof T]?: FilterOps<T[K]>;
};

// -- Rule Definition ---------------------------------------------------------

export type WhenClause<T extends object = Record<string, unknown>> = ((s: T) => boolean) | WhereFilter<T>;

export interface DecideRule<T extends object = Record<string, unknown>> {
  when: WhenClause<T>;
  then: string;
  /** Human-readable rule name for narrative: "Good credit" */
  label?: string;
}

// -- Default Branch ----------------------------------------------------------

/**
 * The fallback branch of a `decide()` — taken when NO rule matched.
 *
 * Two forms, and the bare string is the original one:
 * - `'protected'` — just the branch id. Behaves exactly as it always has.
 * - `{ branch: 'protected', label: 'No rule fired — asset stays protected' }`
 *   — the branch id PLUS what that branch means.
 *
 * **Why the object form exists.** Every other branch of a decider is named by
 * the rule that chose it: the rule carries a `label`, and that label travels
 * out through `DecisionEvidence.rules[].label` for narratives, audits and
 * downstream harvesters. The default branch is chosen by no rule, so there is
 * no rule to carry its label — it is the one branch evidence could not name.
 * Declaring the label here puts the default's meaning beside the rules that it
 * competes with, and sends it out through the same evidence channel.
 *
 * @example
 * ```ts
 * decide(scope, rules, { branch: 'protected', label: 'Nothing matched — leave it protected' });
 * ```
 */
export type DefaultBranch =
  | string
  | {
      /** The branch id to fall back to. */
      readonly branch: string;
      /** What falling back to this branch MEANS. Lands on `DecisionEvidence.defaultLabel`. */
      readonly label?: string;
    };

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
  /** The branch ID this rule maps to. Self-describing — no index correlation needed. */
  branch: string;
  matched: boolean;
  label?: string;
  inputs: ReadInput[];
  /**
   * Error message if the `when` function threw during evaluation.
   * Present only when an exception occurred; `matched` is `false` in that case.
   * Surfaces the error for debugging rather than swallowing it silently.
   *
   * **Security note:** Error messages from user-provided `when` functions are captured
   * as-is and are NOT filtered through the redaction policy. Avoid including sensitive
   * scope values in thrown error messages.
   */
  matchError?: string;
}

export interface FilterRuleEvidence {
  type: 'filter';
  ruleIndex: number;
  /** The branch ID this rule maps to. Self-describing — no index correlation needed. */
  branch: string;
  matched: boolean;
  label?: string;
  conditions: FilterCondition[];
  /**
   * Error message if the filter evaluator threw during evaluation.
   * Present only when an exception occurred; `matched` is `false` in that case.
   * Surfaces the error for debugging rather than swallowing it silently.
   *
   * **Security note:** Error messages from user-provided `when` functions are captured
   * as-is and are NOT filtered through the redaction policy. Avoid including sensitive
   * scope values in thrown error messages.
   */
  matchError?: string;
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
  /** The branch selected. Equals `default` when no rule matched. */
  chosen: string;
  /** The fallback branch passed as defaultBranch. Always set. */
  default: string;
  /**
   * What the DEFAULT branch means — present only when the caller declared it
   * via the object form of {@link DefaultBranch}.
   *
   * The default branch is chosen by no rule, so no `rules[].label` describes
   * it: it is the one branch evidence cannot otherwise name. This field is that
   * name, and it is recorded on EVERY decision — the run where a rule won as
   * well as the run that fell through — so a consumer harvesting meanings sees
   * the same set of branch meanings regardless of which way the data went.
   */
  defaultLabel?: string;
}

export interface SelectionEvidence {
  rules: RuleEvidence[];
  selected: string[];
}
