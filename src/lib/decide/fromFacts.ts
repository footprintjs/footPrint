/**
 * decide/fromFacts -- `decide()`'s evaluation without a scope: a rule table over a plain record of named facts.
 *
 * One law, two doors. `decide()` evaluates a table over a stage's scope; `decideFromFacts` evaluates the same table
 * over a record a caller built, on the same first-match core and the same row assembler (`filter/firstMatch.ts`), and
 * returns the same `DecisionEvidence` shape. A property test pins that its evidence equals what `decide()` records in a
 * run whose redaction policy selects every key, apart from a thrown rule's text, which this door never quotes
 * (test/lib/decide/property/decide-from-facts.property.test.ts).
 *
 * A scope brings its run's redaction rule; a record brings none. So this door keeps no value, ever: names and operators
 * only. There is no option that keeps values here. A caller inside a run that wants the run's own evidence calls
 * `decide()` with its scope.
 */

import { firstMatch, KEEP_NO_VALUE, normalizeDefaultBranch, ruleOver } from '../filter/firstMatch.js';
import type { DecideRule, DecisionEvidence, DefaultBranch } from './types.js';

/**
 * What {@link decideFromFacts} returns. Not a decider's return value: inside a decider stage, use `decide()`.
 *
 * @category Decision Branching
 */
export interface DecisionFromFacts {
  /** The branch chosen: the first matching rule's `then`, or the default. */
  readonly branch: string;
  /** The `DecisionEvidence` of the decision, names and operators only. {@link decisionRecord} projects it to a record. */
  readonly evidence: DecisionEvidence;
}

/**
 * Evaluates `rules` in order over `facts` — first match wins — exactly as `decide()` evaluates them over a scope,
 * and returns the branch and its `DecisionEvidence`. For a "which strategy, and why" chosen outside a stage.
 *
 * - `rules` take `decide()`'s shapes: a filter (`{ express: { eq: true } }`, every key ANDed) or a function
 *   (`(f) => f.weightKg > 30`). A rule's `label` is its reason. A filter with no evaluable condition never matches: the
 *   catch-all is `defaultBranch`.
 * - `facts` is a plain record of FLAT names. A rule key is a name, never a path. A fact is read as an own DATA
 *   property, its descriptor once per name for the whole call: no getter runs, and an accessor property answers
 *   `undefined`, as a missing fact does. A `Proxy` as facts has its `getOwnPropertyDescriptor` trap asked once per name
 *   and its `get` trap never. Inherited and symbol-keyed properties are not facts.
 * - `defaultBranch` is `decide()`'s: `'rejected'`, or `{ branch: 'rejected', label: 'No rule fired' }`.
 *
 * **The evidence keeps names and operators only.** Every `actualSummary`, `valueSummary` and `threshold` is the
 * placeholder `'[REDACTED]'` with `redacted: true` (a threshold also says `thresholdRedacted: true`), a function rule's
 * `matched` is `true` or `false` whatever the rule returned, and a rule that threw says `matchError: '[REDACTED]'`: the
 * thrown value is never turned into text. The rules still decide on the real values. One limit no door can close: a
 * NAME is recorded as written, so a value a rule uses as a property key (`(f) => f[f.token]`), or a key that is itself
 * the secret, is recorded as a fact name.
 *
 * A function rule reads facts by property access (`f.weightKg`); each string-keyed read is recorded by name. Its view
 * closes when the rule returns: a view the rule kept reads nothing afterwards.
 *
 * A rule that throws does not match and does not throw out: its row says `matched: false` and carries `matchError`, as
 * in `decide()`. Unlike `decide()`, and like the retry table's own evaluation, this door prints no dev-mode warning for
 * a rule that threw: the row is the report. It throws a `TypeError` when `facts` is not an object; `rules` that are not
 * an array of rules fail with the language's own `TypeError`.
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
): DecisionFromFacts {
  if (typeof facts !== 'object' || facts === null) {
    throw new TypeError('decideFromFacts: facts must be an object of named values');
  }
  const { branch, evidence } = firstMatch(
    rules,
    ruleOver<F>(factReader(facts), KEEP_NO_VALUE),
    normalizeDefaultBranch(defaultBranch),
  );
  return { branch, evidence };
}

/** Each fact's own DATA value, its descriptor read once per name: no getter runs, an accessor answers `undefined`. */
function factReader(facts: object): (key: string) => unknown {
  const read = new Map<string, unknown>();
  return (key) => {
    if (read.has(key)) return read.get(key);
    const descriptor = Object.getOwnPropertyDescriptor(facts, key);
    const value = descriptor !== undefined && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    read.set(key, value);
    return value;
  };
}
