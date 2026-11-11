/**
 * filter/evaluator -- Prisma-style filter evaluator for decision rules.
 *
 * Pure function. Takes a WhereFilter, a value getter, and a redaction checker.
 * Evaluates each condition, records the result, returns matched/conditions.
 *
 * All keys in the filter are ANDed (all must match for the rule to match).
 * Decoupled from ScopeFacade — receives callbacks, not scope.
 *
 * A LEAF module of its own (P2, 10.1): `decide()` (decide/) and the attempt rule table (attempt/decision.ts) share
 * this one law, and neither may reach the other's dependencies through it. In decide/ it made `attempt/` reach
 * `scope/` (decide.ts imports the scope runtime), so a `scope → attempt` edge — `scope.$call` — closed a module
 * cycle.
 */

import { summarizeValue } from '../capture/summarize.js';
import type { FilterCondition, WhereFilter } from '../decide/types.js';
import { isDevMode } from '../devMode.js';
import { type ServedThreshold, SCOPE_PLACEHOLDER, THRESHOLD_HOLE } from '../memory/redaction.js';

type OperatorFn = (actual: unknown, threshold: unknown) => boolean;

// -- The two comparison laws -------------------------------------------------

/**
 * SAME VALUE — the one equality `eq`, `ne`, `in` and `notIn` share: `===`, plus the two cases where `===`
 * says "different" about the same value. `NaN` is the same value as `NaN`, and two Dates are the same value
 * when their times are (a Date in state is never the rule's own Date object, so identity could never match).
 * Any other object is the same value only as itself.
 */
function sameValue(actual: unknown, threshold: unknown): boolean {
  if (actual instanceof Date && threshold instanceof Date) return sameValue(actual.getTime(), threshold.getTime());
  return actual === threshold || (Number.isNaN(actual) && Number.isNaN(threshold));
}

/** The kinds that have an order. A bigint is a number here: JavaScript compares the two exactly. */
type OrderedKind = 'number' | 'string' | 'date';

function orderedKind(value: unknown): OrderedKind | undefined {
  if (typeof value === 'number' || typeof value === 'bigint') return 'number';
  if (typeof value === 'string') return 'string';
  if (value instanceof Date) return 'date';
  return undefined;
}

/**
 * ORDER — the one rule `gt`, `gte`, `lt` and `lte` share: an order holds only between two values of the same
 * ordered kind — two numbers, two strings, or two Dates (by their time). Anything else is not an order, and
 * the condition does not hold, in either direction.
 *
 * JavaScript's own `<` would coerce instead: a missing score (`null`) counts as 0, and so do `''`, `[]` and
 * `false`, so `{ score: { lt: 600 } }` would route a missing score as a low one. `undefined` never did
 * (it coerces to `NaN`); a missing value now never does, whichever way it is spelled.
 */
function inOrder(holds: (actual: never, threshold: never) => boolean): OperatorFn {
  return (actual, threshold) => {
    const kind = orderedKind(actual);
    return kind !== undefined && kind === orderedKind(threshold) && holds(actual as never, threshold as never);
  };
}

/**
 * Whether `list` holds the SAME VALUE as `actual`. One `includes` answers for everything but a Date (it is
 * `===` plus `NaN`); a Date is then looked for by its time.
 */
function holdsSameValue(list: readonly unknown[], actual: unknown): boolean {
  return list.includes(actual) || (actual instanceof Date && list.some((member) => sameValue(actual, member)));
}

/** `in` / `notIn` read a bounded list. */
function boundedList(threshold: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(threshold)) return undefined;
  if (threshold.length > MAX_IN_ARRAY_SIZE) {
    throw new Error(`in/notIn array exceeds maximum size of ${MAX_IN_ARRAY_SIZE}`);
  }
  return threshold;
}

// -- Operator dispatch table -------------------------------------------------

const OPERATOR_HANDLERS: Record<string, OperatorFn> = {
  eq: sameValue,
  ne: (a, t) => !sameValue(a, t),
  gt: inOrder((a: number, t: number) => a > t),
  gte: inOrder((a: number, t: number) => a >= t),
  lt: inOrder((a: number, t: number) => a < t),
  lte: inOrder((a: number, t: number) => a <= t),
  in: (a, t) => {
    const list = boundedList(t);
    return list !== undefined && holdsSameValue(list, a);
  },
  notIn: (a, t) => {
    const list = boundedList(t);
    return list === undefined || !holdsSameValue(list, a); // not in a non-array = vacuously true
  },
};

const ORDERED_OPERATORS = new Set(['gt', 'gte', 'lt', 'lte']);

/**
 * Dev mode: an ordered operator met two values that are both PRESENT and have no order between them (a string
 * with a number, say). A missing value is an ordinary state and is not reported.
 */
function warnIfNoOrder(op: string, key: string, actual: unknown, threshold: unknown): void {
  if (!ORDERED_OPERATORS.has(op) || actual === null || actual === undefined) return;
  if (threshold === null || threshold === undefined) return;
  const [a, t] = [orderedKind(actual), orderedKind(threshold)];
  if (a !== undefined && a === t) return;
  // eslint-disable-next-line no-console
  console.warn(
    `[footprint] decide()/select() filter: "${op}" on key "${key}" compares ${kindName(actual)} with ` +
      `${kindName(threshold)} — not an order, so the condition does not hold ` +
      '(ordered operators compare two numbers, two strings or two Dates)',
  );
}

/** A value's kind for the warning above. Never the value: it may be one the run redacts. */
function kindName(value: unknown): string {
  if (value instanceof Date) return 'a Date';
  if (Array.isArray(value)) return 'an array';
  const type = typeof value === 'bigint' ? 'number' : typeof value;
  return `${type === 'object' ? 'an' : 'a'} ${type}`;
}

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
 * ## Two comparison laws, no coercion
 *
 * `eq` / `ne` / `in` / `notIn` ask for the SAME VALUE (`sameValue`); `gt` / `gte` / `lt` / `lte` ask for an
 * ORDER, which holds only between two numbers, two strings or two Dates (`inOrder`). A missing value
 * (`null`, `undefined`) is in no order with anything, so an ordered condition on it does not hold.
 *
 * @param getValueFn - Reads a value from scope by key (raw, for comparison)
 * @param isRedactedFn - Checks if a key's ACTUAL value is masked (for evidence display)
 * @param filter - The WhereFilter to evaluate
 * @param serveThreshold - What the row keeps of this threshold, the run's answer as data
 *   (`RedactionRule · serveThreshold`), asked once per condition AFTER that key's read, because that read can be the
 *   selected one, and after the rule ran on the real value. Default: the value itself, or a hole when its key is masked.
 * @returns { matched, conditions } — matched = all conditions passed
 */
export function evaluateFilter<T extends object>(
  getValueFn: (key: string) => unknown,
  isRedactedFn: (key: string) => boolean,
  filter: WhereFilter<T>,
  serveThreshold: (key: string, threshold: unknown) => ServedThreshold = (key, threshold) =>
    isRedactedFn(key) ? THRESHOLD_HOLE : { threshold },
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
    const displayValue = redacted ? SCOPE_PLACEHOLDER : summarizeValue(actual, MAX_VALUE_LEN);

    // Evaluate each operator in the FilterOps for this key
    for (const [op, threshold] of Object.entries(ops as Record<string, unknown>)) {
      // An OWN entry only: a name such as `constructor` or `toString` must not reach Object.prototype's method.
      const handler = Object.hasOwn(OPERATOR_HANDLERS, op) ? OPERATOR_HANDLERS[op] : undefined;
      // Unknown operator: treat as failed condition so rule doesn't spuriously match
      if (!handler && isDevMode()) {
        // eslint-disable-next-line no-console
        console.warn(
          `[footprint] decide()/select() filter: unknown operator "${op}" on key "${key}" — ` +
            `condition never matches (valid operators: ${Object.keys(OPERATOR_HANDLERS).join(', ')})`,
        );
      }
      if (handler && isDevMode()) warnIfNoOrder(op, key, actual, threshold);
      const result = handler ? handler(actual, threshold) : false;
      const served = serveThreshold(key, threshold);
      conditions.push({
        key,
        op,
        threshold: served.threshold,
        actualSummary: displayValue,
        result,
        redacted,
        ...(served.thresholdRedacted && { thresholdRedacted: true as const }),
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
