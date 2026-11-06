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

import { isDevMode } from '../devMode.js';
import { evaluateFilter } from '../filter/evaluator.js';
import type { EvidenceRule } from '../memory/redaction.js';
import { valueBehind } from '../reactive/handles.js';
import { requireDecisionScopeRuntime } from '../scope/runtime.js';
import type { ScopeRecorder } from '../scope/types.js';
import { EvidenceCollector } from './evidence.js';
import type {
  DecideRule,
  DecisionEvidence,
  DecisionResult,
  DefaultBranch,
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

/** What one decide()/select() asks of its scope, read once per call. */
interface ScopeAccessors {
  readonly attachFn?: (r: ScopeRecorder) => void;
  readonly detachFn?: (id: string) => void;
  readonly valueFn: (key: string) => unknown;
  readonly redactedFn: (key: string) => boolean;
  /** Absent: `evaluateFilter`'s default, the value itself, or a hole when its key is masked. */
  readonly serveThreshold?: EvidenceRule['serveThreshold'];
  readonly servedMatchError: (text: string) => string;
}

function scopeAccessors(scope: unknown): ScopeAccessors {
  const { target } = requireDecisionScopeRuntime(scope);
  // The run's rule, as answers passed in as data. A custom port without it names only its marked keys.
  const rule = target.decisionEvidenceRule?.(valueBehind);
  const keys = rule ? undefined : target.getRedactedKeys?.();
  return {
    attachFn: target.attachScopeRecorder?.bind(target),
    detachFn: target.detachScopeRecorder?.bind(target),
    valueFn: target.getValue?.bind(target) ?? (() => undefined),
    redactedFn: rule?.masksActual ?? ((key: string) => keys?.has(key) ?? false),
    serveThreshold: rule?.serveThreshold,
    servedMatchError: rule?.servedMatchError ?? ((text: string) => text),
  };
}

/** A rule's thrown value as evidence quotes it: asked after the rule ran, because its own reads count. */
function matchErrorOf(e: unknown, accessors: ScopeAccessors): string {
  return accessors.servedMatchError(e instanceof Error ? e.message : String(e));
}

// -- evaluate a single rule --------------------------------------------------

function evaluateRule<S extends object>(
  scope: S,
  rule: DecideRule<S>,
  index: number,
  accessors: ScopeAccessors,
): RuleEvidence {
  const { attachFn, detachFn, valueFn, redactedFn, serveThreshold } = accessors;
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
      matchError = matchErrorOf(e, accessors);
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
    let filterMatched = false;
    let filterConditions: FilterCondition[] = [];
    let matchError: string | undefined;
    try {
      const result = evaluateFilter(valueFn, redactedFn, rule.when as WhereFilter<S>, serveThreshold);
      filterMatched = result.matched;
      filterConditions = result.conditions;
    } catch (e) {
      filterMatched = false;
      filterConditions = [];
      // Capture the error for debugging — surface it in evidence instead of swallowing silently
      matchError = matchErrorOf(e, accessors);
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

// -- default branch normalization --------------------------------------------

/**
 * Collapses both {@link DefaultBranch} forms to one shape, once, at the top of
 * `decide()`. A bare string yields `label: undefined`, which every downstream
 * spread then omits — so the string call site produces exactly the evidence it
 * produced before this parameter was widened.
 *
 * ONLY the object form is unwrapped; every other value passes through as the
 * branch, untouched. That is deliberate: JavaScript callers reach `decide()`
 * with the third argument MISSING (a rule set that covers every case never
 * consults a default), and before the parameter widened that `undefined`
 * simply landed on `evidence.default`. It still does — a normalization that
 * only understood strings would turn those call sites into a TypeError.
 */
function normalizeDefaultBranch(defaultBranch: DefaultBranch): { branch: string; label?: string } {
  return typeof defaultBranch === 'object' && defaultBranch !== null
    ? defaultBranch
    : { branch: defaultBranch as string };
}

// -- decide() ----------------------------------------------------------------

/**
 * Evaluates rules in order (first-match). Returns a branded DecisionResult.
 *
 * @param scope - TypedScope or ScopeFacade
 * @param rules - Array of DecideRule (function or filter when clauses)
 * @param defaultBranch - Branch taken when no rule matches. Either the branch
 *   id (`'rejected'`) or the id plus what falling back to it MEANS
 *   (`{ branch: 'rejected', label: 'No rule fired' }`). The label lands on
 *   `evidence.defaultLabel` — the default is chosen by no rule, so it is the
 *   one branch that `rules[].label` can never describe.
 *
 * **Error behavior:** If a `when` function throws during evaluation, the rule is
 * treated as non-matching (`matched: false`) and the error message is captured in
 * `matchError` on that rule's `RuleEvidence` entry. Execution continues with
 * subsequent rules; errors do not propagate to the caller.
 *
 * **Under a redaction policy** the evidence is served where it is built, so one form reaches every
 * observer and the returned result: a threshold is a detached copy read once, or a hole
 * (`thresholdRedacted`), and `matchError` may be masked. The rules still evaluate on the real values. A
 * rule's `label` and the default's label are author text and are served as written: do not build one
 * from a selected value.
 *
 * **Empty-filter behavior (anti-vacuous-truth):** a filter rule whose `when` is
 * `{}` (no evaluable conditions) NEVER matches. This deliberately inverts the
 * Prisma/SQL `where: {}` intuition ("match everything") — a rule that asserts
 * nothing must not win a branch on vacuous truth. Use `defaultBranch` for the
 * catch-all instead. Unknown filter operators also never match (dev mode warns).
 */
export function decide<S extends object>(
  scope: S,
  rules: DecideRule<S>[],
  defaultBranch: DefaultBranch,
): DecisionResult {
  const accessors = scopeAccessors(scope);

  const { branch: defaultBranchId, label: defaultLabel } = normalizeDefaultBranch(defaultBranch);
  // Declared once, spread into BOTH exits below — deliberately. A default's
  // meaning is a property of the DECIDER, not of the run: it must be in the
  // evidence of the run where a rule won just as much as in the run that fell
  // through. Emit it only on the fallthrough and any consumer harvesting branch
  // meanings would watch them appear and disappear with the data.
  const defaultMeaning = defaultLabel !== undefined ? { defaultLabel } : undefined;

  const evaluatedRules: RuleEvidence[] = [];

  for (const [index, rule] of rules.entries()) {
    const ruleEvidence = evaluateRule(scope, rule, index, accessors);
    evaluatedRules.push(ruleEvidence);

    if (ruleEvidence.matched) {
      const evidence: DecisionEvidence = {
        rules: evaluatedRules,
        chosen: rule.then,
        default: defaultBranchId,
        ...defaultMeaning,
      };
      return { branch: rule.then, [DECISION_RESULT]: true, evidence };
    }
  }

  // Default: no rule matched
  const evidence: DecisionEvidence = {
    rules: evaluatedRules,
    chosen: defaultBranchId,
    default: defaultBranchId,
    ...defaultMeaning,
  };
  return { branch: defaultBranchId, [DECISION_RESULT]: true, evidence };
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
 *
 * **Empty-filter behavior (anti-vacuous-truth):** a filter rule whose `when` is
 * `{}` (no evaluable conditions) NEVER matches — same rule as `decide()`; an
 * always-selected branch must be expressed explicitly, not via an empty filter.
 * Unknown filter operators also never match (dev mode warns).
 */
export function select<S extends object>(scope: S, rules: DecideRule<S>[]): SelectionResult {
  const accessors = scopeAccessors(scope);

  const evaluatedRules: RuleEvidence[] = [];
  const selectedBranches: string[] = [];

  for (const [index, rule] of rules.entries()) {
    const ruleEvidence = evaluateRule(scope, rule, index, accessors);
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
