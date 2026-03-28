/**
 * decide/evaluator -- Prisma-style filter evaluator for decision rules.
 *
 * Pure function. Takes a WhereFilter, a value getter, and a redaction checker.
 * Evaluates each condition, records the result, returns matched/conditions.
 *
 * All keys in the filter are ANDed (all must match for the rule to match).
 * Decoupled from ScopeFacade — receives callbacks, not scope.
 */

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

  // Empty filter (no evaluable conditions) should NOT match — prevents vacuous truth
  if (conditions.length === 0) return { matched: false, conditions };

  return { matched: allMatched, conditions };
}
