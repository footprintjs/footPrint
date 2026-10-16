/**
 * attempt/decision.ts — the ONE retry rule table and the runner's evidence builder (design §3.1, §3.8, law 9).
 *
 * `retryRules(policy)` is the retry-or-stop decision as ordinary `decide()` rules over `AttemptInputs`, first
 * match wins, default `retry` ("retryable"):
 *
 *   1  outcome = ok                    → done  succeeded
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
 * one) and builds the evidence `decide()` would build: the filter rows come from `decide()`'s own evaluator
 * (`filter/evaluator.ts · evaluateFilter`), the function rows and the first-match loop mirror
 * `decide/decide.ts` field for field and key for key. A property test pins that both paths give equal evidence
 * for equal inputs (test/lib/attempt/property).
 *
 * Inputs are READ, one key at a time, only when a rule reaches them — so the user's `retryOn` and `backoffMs`
 * run exactly when a retry needs them, as they did before the record existed.
 */

import { summarizeValue } from '../capture/summarize.js';
import type {
  DecideRule,
  DecisionEvidence,
  FilterRuleEvidence,
  FunctionRuleEvidence,
  ReadInput,
  RuleEvidence,
  WhereFilter,
} from '../decide/types.js';
import { evaluateFilter } from '../filter/evaluator.js';
import { attemptCeiling } from './policy.js';
import type { AttemptInputs, AttemptNext, AttemptReason, RetryPolicy } from './types.js';

/** The table's default: no rule stopped the series, so it retries. */
export const RETRY_DEFAULT = Object.freeze({ branch: 'retry', label: 'retryable' } as const);

/** `decide()`'s summary length for an evidence value (filter/evaluator.ts, decide/evidence.ts). */
const MAX_VALUE_LEN = 80;

/**
 * The retry rule table for `policy` — six `decide()` rules, then {@link RETRY_DEFAULT}. The ceiling is the
 * whole number of attempts the policy allows, never fewer than one (`attemptCeiling`): a ceiling of `NaN` or
 * `Infinity` cannot make rule 4 unreachable.
 */
export function retryRules(policy: Pick<RetryPolicy, 'attempts'>): DecideRule<AttemptInputs>[] {
  return [
    { when: { outcome: { eq: 'ok' } }, then: 'done', label: 'succeeded' },
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
  const evaluated: RuleEvidence[] = [];
  for (const [index, rule] of rules.entries()) {
    const evidence = evaluateRule(rule, index, read);
    evaluated.push(evidence);
    if (evidence.matched) return decided(evaluated, rule.then, rule.label);
  }
  return decided(evaluated, RETRY_DEFAULT.branch, RETRY_DEFAULT.label);
}

function decided(rules: RuleEvidence[], chosen: string, label: string | undefined): AttemptDecision {
  // decide()'s key order: rules, chosen, default, defaultLabel.
  const evidence: DecisionEvidence = {
    rules,
    chosen,
    default: RETRY_DEFAULT.branch,
    defaultLabel: RETRY_DEFAULT.label,
  };
  return { evidence, next: chosen as AttemptNext, reason: label as AttemptReason };
}

/** One rule, as `decide/decide.ts · evaluateRule` evaluates it — minus the scope. */
function evaluateRule(rule: DecideRule<AttemptInputs>, index: number, read: (key: string) => unknown): RuleEvidence {
  if (typeof rule.when === 'function') {
    const inputs: ReadInput[] = [];
    let matched: boolean;
    let matchError: string | undefined;
    try {
      matched = rule.when(readingView(read, inputs));
    } catch (error) {
      matched = false;
      matchError = error instanceof Error ? error.message : String(error);
    }
    const evidence: FunctionRuleEvidence = {
      type: 'function',
      ruleIndex: index,
      branch: rule.then,
      matched,
      label: rule.label,
      inputs,
      ...(matchError !== undefined && { matchError }),
    };
    return evidence;
  }
  let matched = false;
  let conditions: FilterRuleEvidence['conditions'] = [];
  let matchError: string | undefined;
  try {
    ({ matched, conditions } = evaluateFilter(read, () => false, rule.when as WhereFilter<AttemptInputs>));
  } catch (error) {
    matchError = error instanceof Error ? error.message : String(error);
  }
  const evidence: FilterRuleEvidence = {
    type: 'filter',
    ruleIndex: index,
    branch: rule.then,
    matched,
    label: rule.label,
    conditions,
    ...(matchError !== undefined && { matchError }),
  };
  return evidence;
}

/**
 * The inputs as a function rule sees them: each string-keyed read is recorded the way `decide()`'s evidence
 * collector records a scope read (key, summary, not redacted — every input is a number, a name or a flag).
 */
function readingView(read: (key: string) => unknown, inputs: ReadInput[]): AttemptInputs {
  return new Proxy({} as AttemptInputs, {
    get(_target, key) {
      if (typeof key !== 'string') return undefined;
      const value = read(key);
      inputs.push({ key, valueSummary: summarizeValue(value, MAX_VALUE_LEN), redacted: false });
      return value;
    },
  });
}
