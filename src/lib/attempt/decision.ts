/**
 * attempt/decision.ts — the ONE retry rule table and the runner's evidence builder (design §3.1, §3.8, law 9).
 *
 * `retryRules(policy)` is the retry-or-stop decision as ordinary `decide()` rules over `AttemptInputs`, first
 * match wins, default `retry` ("retryable"):
 *
 *   1  outcome = ok                    → done  answered
 *   2  outcome = paused                → stop  paused
 *   3  aborted = true                  → stop  aborted        (the run's signal — the attempt's outcome stays its own)
 *   4  attempt ≥ of                    → stop  exhausted
 *   5  retryOn = false                 → stop  declined       (a function rule: it shows the verdict it saw)
 *   6  timeLeftAfterWaitMs ≤ 0         → stop  no-time-left
 *      default                         → retry retryable
 *
 * Each rule's `label` IS the reason it names, so `reason` is a projection of the evidence, never a second
 * vocabulary. The ceiling is `attempt/policy.ts · attemptCeiling`, the one reading the engine and the runner
 * share.
 *
 * `decideAttempt` evaluates that table WITHOUT a scope (the runner has none — `decide()` needs a registered
 * one) on the first-match core `decide()` and `decideFromFacts` share (`filter/firstMatch.ts`): the filter rows come
 * from `decide()`'s own evaluator (`filter/evaluator.ts · evaluateFilter`), the function rows from the core's reading
 * view, with no mask — every input is a number, a name or a flag. A property test pins that the three doors give
 * equal evidence for equal inputs (test/lib/attempt/property).
 *
 * Inputs are READ, one key at a time, only when a rule reaches them — so the user's `retryOn` and `backoffMs`
 * run exactly when a retry needs them, as they did before the record existed.
 */

import type { DecideRule, DecisionEvidence } from '../decide/types.js';
import { firstMatch, ruleOver } from '../filter/firstMatch.js';
import { attemptCeiling } from './policy.js';
import type { AttemptInputs, AttemptNext, AttemptReason, RetryPolicy } from './types.js';

/** The table's default: no rule stopped the series, so it retries. */
export const RETRY_DEFAULT = Object.freeze({ branch: 'retry', label: 'retryable' } as const);

/**
 * The retry rule table for `policy` — six `decide()` rules, then {@link RETRY_DEFAULT}. The ceiling is the
 * whole number of attempts the policy allows, never fewer than one (`attemptCeiling`): a ceiling of `NaN` or
 * `Infinity` cannot make rule 4 unreachable.
 */
export function retryRules(policy: Pick<RetryPolicy, 'attempts'>): DecideRule<AttemptInputs>[] {
  return [
    { when: { outcome: { eq: 'ok' } }, then: 'done', label: 'answered' },
    { when: { outcome: { eq: 'paused' } }, then: 'stop', label: 'paused' },
    { when: { aborted: { eq: true } }, then: 'stop', label: 'aborted' },
    { when: { attempt: { gte: attemptCeiling(policy.attempts) } }, then: 'stop', label: 'exhausted' },
    { when: (inputs) => inputs.retryOn === false, then: 'stop', label: 'declined' },
    { when: { timeLeftAfterWaitMs: { lte: 0 } }, then: 'stop', label: 'no-time-left' },
  ];
}

/** A decision: the evidence, and its compact projection. */
export interface AttemptDecision {
  readonly evidence: DecisionEvidence;
  readonly next: AttemptNext;
  readonly reason: AttemptReason;
}

/**
 * Evaluate `rules` (a `retryRules` table) over `read` — first match wins — and build the evidence `decide()`
 * would record with the default {@link RETRY_DEFAULT}. `read(key)` returns one input; it is called only for the
 * keys the evaluated rules touch, in rule order.
 */
export function decideAttempt(
  rules: readonly DecideRule<AttemptInputs>[],
  read: (key: string) => unknown,
): AttemptDecision {
  const { branch, label, evidence } = firstMatch(rules, ruleOver<AttemptInputs>(read), RETRY_DEFAULT);
  return { evidence, next: branch as AttemptNext, reason: label as AttemptReason };
}
