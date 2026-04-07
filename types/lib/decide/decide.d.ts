/**
 * decide/decide -- Core decide() and select() helper functions.
 *
 * decide() evaluates rules in order (first-match) and returns a DecisionResult.
 * select() evaluates ALL rules and returns a SelectionResult with all matches.
 *
 * Each rule's `when` can be:
 * - A function: (s) => s.creditScore > 700  (auto-captures reads via temp recorder)
 * - A filter:   { creditScore: { gt: 700 } } (captures reads + operators + thresholds)
 */
import type { DecideRule, DecisionResult, SelectionResult } from './types.js';
/**
 * Evaluates rules in order (first-match). Returns a branded DecisionResult.
 *
 * @param scope - TypedScope or ScopeFacade
 * @param rules - Array of DecideRule (function or filter when clauses)
 * @param defaultBranch - Branch ID if no rule matches
 *
 * **Error behavior:** If a `when` function throws during evaluation, the rule is
 * treated as non-matching (`matched: false`) and the error message is captured in
 * `matchError` on that rule's `RuleEvidence` entry. Execution continues with
 * subsequent rules; errors do not propagate to the caller.
 */
export declare function decide<S extends object>(scope: S, rules: DecideRule<S>[], defaultBranch: string): DecisionResult;
/**
 * Evaluates ALL rules (not first-match). Returns a branded SelectionResult.
 *
 * @param scope - TypedScope or ScopeFacade
 * @param rules - Array of DecideRule (function or filter when clauses)
 *
 * **Error behavior:** If a `when` function throws during evaluation, the rule is
 * treated as non-matching (`matched: false`) and the error message is captured in
 * `matchError` on that rule's `RuleEvidence` entry. Evaluation continues with
 * remaining rules; errors do not propagate to the caller.
 */
export declare function select<S extends object>(scope: S, rules: DecideRule<S>[]): SelectionResult;
