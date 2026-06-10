/**
 * decide/evaluator -- Prisma-style filter evaluator for decision rules.
 *
 * Pure function. Takes a WhereFilter, a value getter, and a redaction checker.
 * Evaluates each condition, records the result, returns matched/conditions.
 *
 * All keys in the filter are ANDed (all must match for the rule to match).
 * Decoupled from ScopeFacade — receives callbacks, not scope.
 */

import { isDevMode } from '../scope/detectCircular.js';
import { summarizeValue } from '../scope/recorders/summarizeValue.js';
import type { FilterCondition, WhereFilter } from './types.js';

// -- Operator dispatch table -------------------------------------------------

type OperatorFn = (actual: unknown, threshold: unknown) => boolean;

const OPERATOR_HANDLERS: Record<string, OperatorFn> = {
  eq: (a, t) => a === t,
  ne: (a, t) => a !== t,
  gt: (a, t) => (a as number) > (t as number),
  gte: (a, t) => (a as number) >= (t as number),
  lt: (a, t) => (a as number) < (t as number),
  lte: (a, t) => (a as number) <= (t as number),
  in: (a, t) => {
    if (!Array.isArray(t)) return false;
    if (t.length > MAX_IN_ARRAY_SIZE) {
      throw new Error(`in/notIn array exceeds maximum size of ${MAX_IN_ARRAY_SIZE}`);
    }
    return t.includes(a);
  },
  notIn: (a, t) => {
    if (!Array.isArray(t)) return true; // not in a non-array = vacuously true
    if (t.length > MAX_IN_ARRAY_SIZE) {
      throw new Error(`in/notIn array exceeds maximum size of ${MAX_IN_ARRAY_SIZE}`);
    }
    return !t.includes(a);
  },
};

// -- Security: prototype pollution denylist ----------------------------------

const DENIED_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

// -- Constants ---------------------------------------------------------------

const MAX_IN_ARRAY_SIZE = 1000;
const MAX_VALUE_LEN = 80;

// -- Evaluator ---------------------------------------------------------------

/**
 * Evaluates a Prisma-style filter against scope values.
 *
 * ## Empty filter → NO match (anti-vacuous-truth — inverts Prisma/SQL)
 *
 * A filter with no evaluable conditions (`{}`, or only denied/non-object
 * keys) returns `matched: false`. This deliberately INVERTS the Prisma/SQL
 * intuition where `where: {}` matches everything: in a decision rule, a rule
 * that asserts nothing should never win a branch — "all zero conditions
 * passed" is vacuous truth, and silently routing on it would fabricate
 * decision evidence. Want a catch-all? Use the explicit `defaultBranch`
 * argument of `decide()` instead of an empty `when`.
 *
 * ## Unknown operators → condition fails (+ dev-mode warning)
 *
 * An operator outside the supported set (`eq, ne, gt, gte, lt, lte, in,
 * notIn`) records a failed condition — the rule can never spuriously match
 * through a typo (`gte` misspelled `gle`). With dev mode enabled
 * (`enableDevMode()`), a console warning names the unknown operator and key.
 *
 * @param getValueFn - Reads a value from scope by key (raw, for comparison)
 * @param isRedactedFn - Checks if a key is redacted (for evidence display)
 * @param filter - The WhereFilter to evaluate
 * @returns { matched, conditions } — matched = all conditions passed
 */
export function evaluateFilter<T extends object>(
  getValueFn: (key: string) => unknown,
  isRedactedFn: (key: string) => boolean,
  filter: WhereFilter<T>,
): { matched: boolean; conditions: FilterCondition[] } {
  const conditions: FilterCondition[] = [];
  let allMatched = true;

  for (const [key, ops] of Object.entries(filter)) {
    // Security: denied keys cause rule to fail (consistent with unknown operator behavior)
    if (DENIED_KEYS.has(key)) {
      allMatched = false;
      continue;
    }
    if (!ops || typeof ops !== 'object') continue;

    const actual = getValueFn(key);
    const redacted = isRedactedFn(key);
    const displayValue = redacted ? '[REDACTED]' : summarizeValue(actual, MAX_VALUE_LEN);

    // Evaluate each operator in the FilterOps for this key
    for (const [op, threshold] of Object.entries(ops as Record<string, unknown>)) {
      const handler = OPERATOR_HANDLERS[op];
      if (!handler) {
        // Unknown operator: treat as failed condition so rule doesn't spuriously match
        if (isDevMode()) {
          // eslint-disable-next-line no-console
          console.warn(
            `[footprint] decide()/select() filter: unknown operator "${op}" on key "${key}" — ` +
              `condition never matches (valid operators: ${Object.keys(OPERATOR_HANDLERS).join(', ')})`,
          );
        }
        conditions.push({ key, op, threshold, actualSummary: displayValue, result: false, redacted });
        allMatched = false;
        continue;
      }

      const result = handler(actual, threshold);
      conditions.push({
        key,
        op,
        threshold,
        actualSummary: displayValue,
        result,
        redacted,
      });

      if (!result) allMatched = false;
    }
  }

  // Empty filter (no evaluable conditions) should NOT match — prevents vacuous
  // truth. NOTE: this deliberately inverts Prisma/SQL `where: {}` ("match
  // everything") — see the function JSDoc. Catch-alls belong in decide()'s
  // explicit defaultBranch, not in an empty rule.
  if (conditions.length === 0) return { matched: false, conditions };

  return { matched: allMatched, conditions };
}
