/**
 * decide/evaluator -- Prisma-style filter evaluator for decision rules.
 *
 * Pure function. Takes a WhereFilter, a value getter, and a redaction checker.
 * Evaluates each condition, records the result, returns matched/conditions.
 *
 * All keys in the filter are ANDed (all must match for the rule to match).
 * Decoupled from ScopeFacade — receives callbacks, not scope.
 */
import type { FilterCondition, WhereFilter } from './types.js';
/**
 * Evaluates a Prisma-style filter against scope values.
 *
 * @param getValueFn - Reads a value from scope by key (raw, for comparison)
 * @param isRedactedFn - Checks if a key is redacted (for evidence display)
 * @param filter - The WhereFilter to evaluate
 * @returns { matched, conditions } — matched = all conditions passed
 */
export declare function evaluateFilter<T extends object>(getValueFn: (key: string) => unknown, isRedactedFn: (key: string) => boolean, filter: WhereFilter<T>): {
    matched: boolean;
    conditions: FilterCondition[];
};
