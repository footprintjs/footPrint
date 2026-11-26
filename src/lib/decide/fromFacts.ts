/**
 * decide/fromFacts -- `decide()`'s evaluation without a scope: a rule table over a plain record of named facts.
 *
 * One law, two doors. `decide()` evaluates a table over a stage's scope; `decideFromFacts` evaluates the same table
 * over a record a caller built, on the same first-match core (`filter/firstMatch.ts`), and returns the same
 * `DecisionEvidence`. A property test pins that the two give equal evidence for equal rules and inputs
 * (test/lib/decide/property/decide-from-facts.property.test.ts).
 *
 * The difference is the mask. A scope brings its run's redaction rule; a record brings none, so this door keeps no
 * value unless its caller says which rule applies.
 */

import { firstMatch, keepingOf, normalizeDefaultBranch, ruleOver } from '../filter/firstMatch.js';
import type { EvidenceRule } from '../memory/redaction.js';
import type { DecideRule, DecisionEvidence, DefaultBranch } from './types.js';

/** @category Decision Branching */
export interface DecideFromFactsOptions {
  /**
   * What the evidence keeps of the facts' values.
   *
   * - `'all'` (the default): names and operators only. Every `actualSummary`, `valueSummary` and `threshold` is the
   *   placeholder `'[REDACTED]'` with `redacted: true` (a threshold also says `thresholdRedacted: true`), and a rule
   *   that threw says `matchError: '[REDACTED]'`; the thrown value is never turned into text.
   * - An `EvidenceRule`: the answers `decide()` asks of a run's redaction rule, so the evidence is what `decide()`
   *   records in that run. `new RedactionRule(policy).evidenceRule(() => ({}))` (both from `footprintjs/advanced`)
   *   gives one; with no policy it keeps every value. A rule selects by NAME: it knows nothing of what a fact was
   *   computed from.
   */
  readonly mask?: 'all' | EvidenceRule;
}

/**
 * What {@link decideFromFacts} returns. Not a decider's return value: inside a decider stage, use `decide()`.
 *
 * @category Decision Branching
 */
export interface DecisionFromFacts {
  /** The branch chosen: the first matching rule's `then`, or the default. */
  readonly branch: string;
  /** The same evidence `decide()` records. {@link decisionRecord} projects it to a decision record. */
  readonly evidence: DecisionEvidence;
}

/**
 * Evaluates `rules` in order over `facts` — first match wins — exactly as `decide()` evaluates them over a scope,
 * and returns the branch and its `DecisionEvidence`. For a "which strategy, and why" chosen outside a stage.
 *
 * - `rules` take `decide()`'s shapes: a filter (`{ express: { eq: true } }`, every key ANDed) or a function
 *   (`(f) => f.weightKg > 30`). A rule's `label` is its reason. A filter with no evaluable condition never matches: the
 *   catch-all is `defaultBranch`.
 * - `facts` is a plain record of FLAT names. A rule key is a name, never a path, and only an own property is read.
 *   A function rule reads facts by property access; each read is recorded by name.
 * - `defaultBranch` is `decide()`'s: `'rejected'`, or `{ branch: 'rejected', label: 'No rule fired' }`.
 *
 * A rule that throws does not match and does not throw out: its row says `matched: false` and carries `matchError`,
 * as in `decide()`. The function throws only for a call it cannot read: `facts` not an object, or a malformed `mask`.
 *
 * @example
 * ```ts
 * const { branch, evidence } = decideFromFacts(
 *   [{ when: { express: { eq: true } }, then: 'courier', label: 'Express delivery was asked for' }],
 *   { express: true },
 *   { branch: 'post', label: 'No rule fired' },
 * );
 * // branch === 'courier'; decisionRecord(evidence) →
 * // { strategy: 'courier', by: 'rule', rule: 0, label: 'Express delivery was asked for', reads: ['express'] }
 * ```
 *
 * @category Decision Branching
 */
export function decideFromFacts<F extends object>(
  rules: readonly DecideRule<F>[],
  facts: F,
  defaultBranch: DefaultBranch,
  options?: DecideFromFactsOptions,
): DecisionFromFacts {
  if (typeof facts !== 'object' || facts === null) {
    throw new TypeError('decideFromFacts: facts must be an object of named values');
  }
  const named = facts as Record<string, unknown>;
  const read = (key: string): unknown => (Object.hasOwn(named, key) ? named[key] : undefined);
  const { branch, evidence } = firstMatch(
    rules,
    ruleOver<F>(read, keepingOf(options?.mask ?? 'all')),
    normalizeDefaultBranch(defaultBranch),
  );
  return { branch, evidence };
}
