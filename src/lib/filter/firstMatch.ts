/**
 * filter/firstMatch -- the ONE first-match law over a `decide()` rule table, the ONE row assembler, and one rule's
 * evaluation without a scope.
 *
 * `firstMatch(rules, evaluate, defaultBranch)` asks `evaluate` for each rule in order until one matches, and builds the
 * `DecisionEvidence`: the rows evaluated so far, the branch chosen, the default and its label, in that key order.
 * Three doors call it, each with its own way of evaluating one rule:
 *
 * | Door | One rule is evaluated over |
 * |---|---|
 * | `decide()` (decide/decide.ts) | the stage's scope: its recorders, its run's redaction rule |
 * | `decideAttempt` (attempt/decision.ts) | an attempt's inputs, every value kept (`ruleOver(read)`) |
 * | `decideFromFacts` (decide/fromFacts.ts) | a plain record of facts, no value kept (`ruleOver(read, KEEP_NO_VALUE)`) |
 *
 * `functionRow` and `filterRow` build every row, for these three and for `select()`. A function rule's `matched` is
 * whether its return was truthy, which is what routes the decision, and never the return itself: a rule over `any`
 * facts can return a value (`(f) => f.token`), and the row must not carry it.
 *
 * `ruleOver(read, keeping?)` is one rule as `decide()` evaluates it, minus the scope: a filter rule's rows come from
 * `evaluateFilter`, a function rule reads through a view that records each read and closes when the rule returns.
 * `keeping` is what a row keeps of a value it read: every value (`KEEP_EVERY_VALUE`, the default), or none
 * (`KEEP_NO_VALUE`: names and operators only, the placeholder for every value and threshold and for a thrown rule's
 * text).
 *
 * A leaf beside `evaluator.ts`, not in decide/: attempt/ calls it, and decide/decide.ts imports the scope runtime, so an
 * attempt → decide edge would close the attempt ⇄ decide ⇄ scope module cycle that moved the evaluator here (P2).
 */

import { summarizeValue } from '../capture/summarize.js';
import type {
  DecideRule,
  DecisionEvidence,
  DefaultBranch,
  FilterCondition,
  FilterRuleEvidence,
  FunctionRuleEvidence,
  ReadInput,
  RuleEvidence,
  WhereFilter,
} from '../decide/types.js';
import { SCOPE_PLACEHOLDER } from '../memory/redactionValues.js';
import { evaluateFilter } from './evaluator.js';

/** `decide()`'s summary length for an evidence value (filter/evaluator.ts, decide/evidence.ts). */
const MAX_VALUE_LEN = 80;

/** One rule's evaluation, as the first-match loop asks for it. */
export type RuleEvaluator<R> = (rule: R, index: number) => RuleEvidence;

/** A first-match pass: the branch, the label of what chose it (the rule's, or the default's), and the evidence. */
export interface FirstMatch {
  readonly branch: string;
  readonly label: string | undefined;
  readonly evidence: DecisionEvidence;
}

/**
 * Collapses both {@link DefaultBranch} forms to one shape, once. A bare string yields `label: undefined`, which the
 * evidence then omits — so the string call site produces exactly the evidence it produced before the parameter was
 * widened.
 *
 * ONLY the object form is unwrapped; every other value passes through as the branch, untouched. That is deliberate:
 * JavaScript callers reach `decide()` with the third argument MISSING (a rule set that covers every case never consults
 * a default), and before the parameter widened that `undefined` simply landed on `evidence.default`. It still does — a
 * normalization that only understood strings would turn those call sites into a TypeError.
 */
export function normalizeDefaultBranch(defaultBranch: DefaultBranch): { branch: string; label?: string } {
  return typeof defaultBranch === 'object' && defaultBranch !== null
    ? defaultBranch
    : { branch: defaultBranch as string };
}

/**
 * Evaluates `rules` in order — first match wins — and builds the evidence. A rule whose `then` equals the default is
 * still a rule's choice: what chose a branch is read from the rows, never from the branch.
 */
export function firstMatch<R extends { readonly then: string; readonly label?: string }>(
  rules: readonly R[],
  evaluate: RuleEvaluator<R>,
  defaultBranch: { readonly branch: string; readonly label?: string },
): FirstMatch {
  const { branch: defaultId, label: defaultLabel } = defaultBranch;
  // Declared once, spread into BOTH exits below — deliberately. A default's meaning is a property of the DECIDER, not
  // of the run: it must be in the evidence of the run where a rule won just as much as in the run that fell through.
  // Emit it only on the fallthrough and any consumer harvesting branch meanings would watch them appear and disappear
  // with the data.
  const defaultMeaning = defaultLabel !== undefined ? { defaultLabel } : undefined;
  const evaluated: RuleEvidence[] = [];
  for (const [index, rule] of rules.entries()) {
    const row = evaluate(rule, index);
    evaluated.push(row);
    if (row.matched) {
      const evidence: DecisionEvidence = { rules: evaluated, chosen: rule.then, default: defaultId, ...defaultMeaning };
      return { branch: rule.then, label: rule.label, evidence };
    }
  }
  const evidence: DecisionEvidence = { rules: evaluated, chosen: defaultId, default: defaultId, ...defaultMeaning };
  return { branch: defaultId, label: defaultLabel, evidence };
}

/** What a rule's row needs of the rule: its branch and its label. */
interface RuleHead {
  readonly then: string;
  readonly label?: string;
}

/**
 * A function rule's row. `matched` is `!!returned`: whether the rule's return was truthy, which is all that routes a
 * decision. The return itself is never stored, so a rule that returns a value (`(f) => f.token`) leaves no value here.
 */
export function functionRow(
  rule: RuleHead,
  index: number,
  returned: unknown,
  inputs: ReadInput[],
  matchError: string | undefined,
): FunctionRuleEvidence {
  return {
    type: 'function',
    ruleIndex: index,
    branch: rule.then,
    matched: !!returned,
    label: rule.label,
    inputs,
    ...(matchError !== undefined && { matchError }),
  };
}

/** A filter rule's row. */
export function filterRow(
  rule: RuleHead,
  index: number,
  matched: boolean,
  conditions: FilterCondition[],
  matchError: string | undefined,
): FilterRuleEvidence {
  return {
    type: 'filter',
    ruleIndex: index,
    branch: rule.then,
    matched,
    label: rule.label,
    conditions,
    ...(matchError !== undefined && { matchError }),
  };
}

/** What a row keeps of the values a rule read. */
export interface ValueKeeping {
  /** Is the value under `key` masked? What `redacted` says on a row. */
  readonly masked: (key: string) => boolean;
  /** A thrown rule's text, as the row keeps it. */
  readonly matchError: (error: unknown) => string;
}

/** No mask: every value, threshold and thrown text as it is. What `decideAttempt` keeps. */
export const KEEP_EVERY_VALUE: ValueKeeping = {
  masked: () => false,
  matchError: (error) => (error instanceof Error ? error.message : String(error)),
};

/**
 * No value: names and operators only. Every value and threshold is the placeholder (`evaluateFilter`'s own hole for a
 * masked key), and a thrown rule's text is the placeholder: the thrown value is never turned into text, so none of its
 * code runs. What `decideFromFacts` keeps.
 */
export const KEEP_NO_VALUE: ValueKeeping = { masked: () => true, matchError: () => SCOPE_PLACEHOLDER };

/**
 * One rule's evaluation over `read`, without a scope: `read(key)` returns one value and is called only for the keys
 * the rule touches, in the order it touches them. `keeping` is what each row keeps of a value (default: every value).
 *
 * As in `decide()`: a rule that throws does not match, and its row says why (`matchError`); a filter rule that throws
 * records no conditions; a function rule that throws keeps the reads it made before the throw. A function rule's view
 * closes when the rule returns or throws: a view it kept reads nothing afterwards and adds nothing to its row.
 */
export function ruleOver<S extends object>(
  read: (key: string) => unknown,
  keeping: ValueKeeping = KEEP_EVERY_VALUE,
): RuleEvaluator<DecideRule<S>> {
  return (rule, index) => evaluateRule(rule, index, read, keeping);
}

function evaluateRule<S extends object>(
  rule: DecideRule<S>,
  index: number,
  read: (key: string) => unknown,
  keeping: ValueKeeping,
): RuleEvidence {
  if (typeof rule.when === 'function') {
    const inputs: ReadInput[] = [];
    const view = readingView<S>(read, inputs, keeping.masked);
    let returned: unknown;
    let matchError: string | undefined;
    try {
      returned = rule.when(view.facts);
    } catch (error) {
      returned = false;
      matchError = keeping.matchError(error);
    } finally {
      view.close();
    }
    return functionRow(rule, index, returned, inputs, matchError);
  }
  let matched = false;
  let conditions: FilterCondition[] = [];
  let matchError: string | undefined;
  try {
    ({ matched, conditions } = evaluateFilter(read, keeping.masked, rule.when as WhereFilter<S>));
  } catch (error) {
    matchError = keeping.matchError(error);
  }
  return filterRow(rule, index, matched, conditions, matchError);
}

/**
 * The values as a function rule sees them: each string-keyed read is recorded the way `decide()`'s evidence collector
 * records a scope read — its key, its summary or the placeholder when `masked` says so, and the flag. A symbol-keyed
 * read answers `undefined` and is not recorded. Once closed, the view answers `undefined` and records nothing.
 */
function readingView<S extends object>(
  read: (key: string) => unknown,
  inputs: ReadInput[],
  masked: (key: string) => boolean,
): { readonly facts: S; close(): void } {
  let open = true;
  const facts = new Proxy({} as S, {
    get(_target, key) {
      if (!open || typeof key !== 'string') return undefined;
      const value = read(key);
      const redacted = masked(key);
      // A masked value is never summarised: a summary shows the value, or an object's first keys.
      inputs.push({ key, valueSummary: redacted ? SCOPE_PLACEHOLDER : summarizeValue(value, MAX_VALUE_LEN), redacted });
      return value;
    },
  });
  return {
    facts,
    close: () => {
      open = false;
    },
  };
}
