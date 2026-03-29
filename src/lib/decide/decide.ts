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

import { isDevMode } from '../scope/detectCircular.js';
import type { Recorder } from '../scope/types.js';
import { evaluateFilter } from './evaluator.js';
import { EvidenceCollector } from './evidence.js';
import type {
  DecideRule,
  DecisionEvidence,
  DecisionResult,
  FilterCondition,
  FilterRuleEvidence,
  FunctionRuleEvidence,
  RuleEvidence,
  SelectionEvidence,
  SelectionResult,
  WhereFilter,
} from './types.js';
import { DECISION_RESULT } from './types.js';

// -- Scope accessor helpers --------------------------------------------------

function getAttachFn(scope: unknown): ((r: Recorder) => void) | undefined {
  const s = scope as Record<string, unknown>;
  if (typeof s.$attachRecorder === 'function') return s.$attachRecorder.bind(s);
  if (typeof s.attachRecorder === 'function') return s.attachRecorder.bind(s);
  return undefined;
}

function getDetachFn(scope: unknown): ((id: string) => void) | undefined {
  const s = scope as Record<string, unknown>;
  if (typeof s.$detachRecorder === 'function') return s.$detachRecorder.bind(s);
  if (typeof s.detachRecorder === 'function') return s.detachRecorder.bind(s);
  return undefined;
}

function getValueFn(scope: unknown): (key: string) => unknown {
  const s = scope as Record<string, unknown>;
  // Check $getValue first: on TypedScope, accessing .getValue triggers a spurious
  // onRead for key "getValue" via the Proxy get trap. $getValue routes through
  // SCOPE_METHOD_NAMES and avoids the state-read path.
  if (typeof s.$getValue === 'function') return s.$getValue.bind(s);
  if (typeof s.getValue === 'function') return s.getValue.bind(s);
  return () => undefined;
}

function getRedactedFn(scope: unknown): (key: string) => boolean {
  const s = scope as Record<string, unknown>;
  // Try $toRaw() first (TypedScope), then direct
  const raw = typeof s.$toRaw === 'function' ? s.$toRaw() : s;
  const r = raw as Record<string, unknown>;
  if (typeof r.getRedactedKeys === 'function') {
    const keys = r.getRedactedKeys() as Set<string>;
    return (key: string) => keys.has(key);
  }
  return () => false;
}

// -- evaluate a single rule --------------------------------------------------

function evaluateRule<S extends object>(
  scope: S,
  rule: DecideRule<S>,
  index: number,
  attachFn?: (r: Recorder) => void,
  detachFn?: (id: string) => void,
  valueFn?: (key: string) => unknown,
  redactedFn?: (key: string) => boolean,
): RuleEvidence {
  if (typeof rule.when === 'function') {
    // FUNCTION PATH: temp recorder captures reads (lazy — skip if no recorder support)
    const hasRecorderSupport = Boolean(attachFn);
    const collector = hasRecorderSupport ? new EvidenceCollector() : undefined;
    if (collector && attachFn) attachFn(collector);

    let matched: boolean;
    let matchError: string | undefined;
    try {
      matched = rule.when(scope);
    } catch (e) {
      matched = false;
      // Capture the error for debugging — surface it in evidence instead of swallowing silently
      matchError = e instanceof Error ? e.message : String(e);
      if (isDevMode()) {
        const label = rule.label ? ` ('${rule.label}')` : '';
        // eslint-disable-next-line no-console
        console.warn(`[footprint] decide() rule ${index}${label} threw during evaluation: ${matchError}`);
      }
    } finally {
      if (collector && detachFn) detachFn(collector.id);
    }

    const evidence: FunctionRuleEvidence = {
      type: 'function',
      ruleIndex: index,
      branch: rule.then,
      matched,
      label: rule.label,
      // Partial reads: if rule threw after some getValue() calls, collector holds reads up to the throw point
      inputs: collector?.getInputs() ?? [],
      ...(matchError !== undefined && { matchError }),
    };
    return evidence;
  } else {
    // FILTER PATH: reads values directly via callbacks (no recorder); exceptions treated as non-match
    const resolvedValueFn = valueFn ?? (() => undefined);
    const resolvedRedactedFn = redactedFn ?? (() => false);
    let filterMatched = false;
    let filterConditions: FilterCondition[] = [];
    let matchError: string | undefined;
    try {
      const result = evaluateFilter(resolvedValueFn, resolvedRedactedFn, rule.when as WhereFilter<S>);
      filterMatched = result.matched;
      filterConditions = result.conditions;
    } catch (e) {
      filterMatched = false;
      filterConditions = [];
      // Capture the error for debugging — surface it in evidence instead of swallowing silently
      matchError = e instanceof Error ? e.message : String(e);
      if (isDevMode()) {
        const label = rule.label ? ` ('${rule.label}')` : '';
        // eslint-disable-next-line no-console
        console.warn(`[footprint] decide() filter rule ${index}${label} threw during evaluation: ${matchError}`);
      }
    }

    const evidence: FilterRuleEvidence = {
      type: 'filter',
      ruleIndex: index,
      branch: rule.then,
      matched: filterMatched,
      label: rule.label,
      conditions: filterConditions,
      ...(matchError !== undefined && { matchError }),
    };
    return evidence;
  }
}

// -- decide() ----------------------------------------------------------------

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
export function decide<S extends object>(scope: S, rules: DecideRule<S>[], defaultBranch: string): DecisionResult {
  const attachFn = getAttachFn(scope);
  const detachFn = getDetachFn(scope);
  const valueFn = getValueFn(scope);
  const redactedFn = getRedactedFn(scope);

  const evaluatedRules: RuleEvidence[] = [];

  for (const [index, rule] of rules.entries()) {
    const ruleEvidence = evaluateRule(scope, rule, index, attachFn, detachFn, valueFn, redactedFn);
    evaluatedRules.push(ruleEvidence);

    if (ruleEvidence.matched) {
      const evidence: DecisionEvidence = {
        rules: evaluatedRules,
        chosen: rule.then,
        default: defaultBranch,
      };
      return { branch: rule.then, [DECISION_RESULT]: true, evidence };
    }
  }

  // Default: no rule matched
  const evidence: DecisionEvidence = {
    rules: evaluatedRules,
    chosen: defaultBranch,
    default: defaultBranch,
  };
  return { branch: defaultBranch, [DECISION_RESULT]: true, evidence };
}

// -- select() ----------------------------------------------------------------

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
export function select<S extends object>(scope: S, rules: DecideRule<S>[]): SelectionResult {
  const attachFn = getAttachFn(scope);
  const detachFn = getDetachFn(scope);
  const valueFn = getValueFn(scope);
  const redactedFn = getRedactedFn(scope);

  const evaluatedRules: RuleEvidence[] = [];
  const selectedBranches: string[] = [];

  for (const [index, rule] of rules.entries()) {
    const ruleEvidence = evaluateRule(scope, rule, index, attachFn, detachFn, valueFn, redactedFn);
    evaluatedRules.push(ruleEvidence);

    if (ruleEvidence.matched) {
      selectedBranches.push(rule.then);
    }
  }

  const evidence: SelectionEvidence = {
    rules: evaluatedRules,
    selected: selectedBranches,
  };
  return { branches: selectedBranches, [DECISION_RESULT]: true, evidence };
}
