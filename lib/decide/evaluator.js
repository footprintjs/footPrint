"use strict";
/**
 * decide/evaluator -- Prisma-style filter evaluator for decision rules.
 *
 * Pure function. Takes a WhereFilter, a value getter, and a redaction checker.
 * Evaluates each condition, records the result, returns matched/conditions.
 *
 * All keys in the filter are ANDed (all must match for the rule to match).
 * Decoupled from ScopeFacade — receives callbacks, not scope.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateFilter = void 0;
const summarizeValue_js_1 = require("../scope/recorders/summarizeValue.js");
const OPERATOR_HANDLERS = {
    eq: (a, t) => a === t,
    ne: (a, t) => a !== t,
    gt: (a, t) => a > t,
    gte: (a, t) => a >= t,
    lt: (a, t) => a < t,
    lte: (a, t) => a <= t,
    in: (a, t) => {
        if (!Array.isArray(t))
            return false;
        if (t.length > MAX_IN_ARRAY_SIZE) {
            throw new Error(`in/notIn array exceeds maximum size of ${MAX_IN_ARRAY_SIZE}`);
        }
        return t.includes(a);
    },
    notIn: (a, t) => {
        if (!Array.isArray(t))
            return true; // not in a non-array = vacuously true
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
function evaluateFilter(getValueFn, isRedactedFn, filter) {
    const conditions = [];
    let allMatched = true;
    for (const [key, ops] of Object.entries(filter)) {
        // Security: denied keys cause rule to fail (consistent with unknown operator behavior)
        if (DENIED_KEYS.has(key)) {
            allMatched = false;
            continue;
        }
        if (!ops || typeof ops !== 'object')
            continue;
        const actual = getValueFn(key);
        const redacted = isRedactedFn(key);
        const displayValue = redacted ? '[REDACTED]' : (0, summarizeValue_js_1.summarizeValue)(actual, MAX_VALUE_LEN);
        // Evaluate each operator in the FilterOps for this key
        for (const [op, threshold] of Object.entries(ops)) {
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
            if (!result)
                allMatched = false;
        }
    }
    // Empty filter (no evaluable conditions) should NOT match — prevents vacuous truth
    if (conditions.length === 0)
        return { matched: false, conditions };
    return { matched: allMatched, conditions };
}
exports.evaluateFilter = evaluateFilter;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXZhbHVhdG9yLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vc3JjL2xpYi9kZWNpZGUvZXZhbHVhdG9yLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7R0FRRzs7O0FBRUgsNEVBQXNFO0FBT3RFLE1BQU0saUJBQWlCLEdBQStCO0lBQ3BELEVBQUUsRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsS0FBSyxDQUFDO0lBQ3JCLEVBQUUsRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsS0FBSyxDQUFDO0lBQ3JCLEVBQUUsRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFFLENBQVksR0FBSSxDQUFZO0lBQzNDLEdBQUcsRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFFLENBQVksSUFBSyxDQUFZO0lBQzdDLEVBQUUsRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFFLENBQVksR0FBSSxDQUFZO0lBQzNDLEdBQUcsRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFFLENBQVksSUFBSyxDQUFZO0lBQzdDLEVBQUUsRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsRUFBRTtRQUNYLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztZQUFFLE9BQU8sS0FBSyxDQUFDO1FBQ3BDLElBQUksQ0FBQyxDQUFDLE1BQU0sR0FBRyxpQkFBaUIsRUFBRSxDQUFDO1lBQ2pDLE1BQU0sSUFBSSxLQUFLLENBQUMsMENBQTBDLGlCQUFpQixFQUFFLENBQUMsQ0FBQztRQUNqRixDQUFDO1FBQ0QsT0FBTyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ3ZCLENBQUM7SUFDRCxLQUFLLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVB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T0FBTyxFQUFFLEtBQUssRUFBRSxVQUFVLEVBQUUsQ0FBQztJQUVuRSxPQUFPLEVBQUUsT0FBTyxFQUFFLFVBQVUsRUFBRSxVQUFVLEVBQUUsQ0FBQztBQUM3QyxDQUFDO0FBaERELHdDQWdEQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogZGVjaWRlL2V2YWx1YXRvciAtLSBQcmlzbWEtc3R5bGUgZmlsdGVyIGV2YWx1YXRvciBmb3IgZGVjaXNpb24gcnVsZXMuXG4gKlxuICogUHVyZSBmdW5jdGlvbi4gVGFrZXMgYSBXaGVyZUZpbHRlciwgYSB2YWx1ZSBnZXR0ZXIsIGFuZCBhIHJlZGFjdGlvbiBjaGVja2VyLlxuICogRXZhbHVhdGVzIGVhY2ggY29uZGl0aW9uLCByZWNvcmRzIHRoZSByZXN1bHQsIHJldHVybnMgbWF0Y2hlZC9jb25kaXRpb25zLlxuICpcbiAqIEFsbCBrZXlzIGluIHRoZSBmaWx0ZXIgYXJlIEFORGVkIChhbGwgbXVzdCBtYXRjaCBmb3IgdGhlIHJ1bGUgdG8gbWF0Y2gpLlxuICogRGVjb3VwbGVkIGZyb20gU2NvcGVGYWNhZGUg4oCUIHJlY2VpdmVzIGNhbGxiYWNrcywgbm90IHNjb3BlLlxuICovXG5cbmltcG9ydCB7IHN1bW1hcml6ZVZhbHVlIH0gZnJvbSAnLi4vc2NvcGUvcmVjb3JkZXJzL3N1bW1hcml6ZVZhbHVlLmpzJztcbmltcG9ydCB0eXBlIHsgRmlsdGVyQ29uZGl0aW9uLCBXaGVyZUZpbHRlciB9IGZyb20gJy4vdHlwZXMuanMnO1xuXG4vLyAtLSBPcGVyYXRvciBkaXNwYXRjaCB0YWJsZSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbnR5cGUgT3BlcmF0b3JGbiA9IChhY3R1YWw6IHVua25vd24sIHRocmVzaG9sZDogdW5rbm93bikgPT4gYm9vbGVhbjtcblxuY29uc3QgT1BFUkFUT1JfSEFORExFUlM6IFJlY29yZDxzdHJpbmcsIE9wZXJhdG9yRm4+ID0ge1xuICBlcTogKGEsIHQpID0+IGEgPT09IHQsXG4gIG5lOiAoYSwgdCkgPT4gYSAhPT0gdCxcbiAgZ3Q6IChhLCB0KSA9PiAoYSBhcyBudW1iZXIpID4gKHQgYXMgbnVtYmVyKSxcbiAgZ3RlOiAoYSwgdCkgPT4gKGEgYXMgbnVtYmVyKSA+PSAodCBhcyBudW1iZXIpLFxuICBsdDogKGEsIHQpID0+IChhIGFzIG51bWJlcikgPCAodCBhcyBudW1iZXIpLFxuICBsdGU6IChhLCB0KSA9PiAoYSBhcyBudW1iZXIpIDw9ICh0IGFzIG51bWJlciksXG4gIGluOiAoYSwgdCkgPT4ge1xuICAgIGlmICghQXJyYXkuaXNBcnJheSh0KSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmICh0Lmxlbmd0aCA+IE1BWF9JTl9BUlJBWV9TSVpFKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYGluL25vdEluIGFycmF5IGV4Y2VlZHMgbWF4aW11bSBzaXplIG9mICR7TUFYX0lOX0FSUkFZX1NJWkV9YCk7XG4gICAgfVxuICAgIHJldHVybiB0LmluY2x1ZGVzKGEpO1xuICB9LFxuICBub3RJbjogKGEsIHQpID0+IHtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkodCkpIHJldHVybiB0cnVlOyAvLyBub3QgaW4gYSBub24tYXJyYXkgPSB2YWN1b3VzbHkgdHJ1ZVxuICAgIGlmICh0Lmxlbmd0aCA+IE1BWF9JTl9BUlJBWV9TSVpFKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYGluL25vdEluIGFycmF5IGV4Y2VlZHMgbWF4aW11bSBzaXplIG9mICR7TUFYX0lOX0FSUkFZX1NJWkV9YCk7XG4gICAgfVxuICAgIHJldHVybiAhdC5pbmNsdWRlcyhhKTtcbiAgfSxcbn07XG5cbi8vIC0tIFNlY3VyaXR5OiBwcm90b3R5cGUgcG9sbHV0aW9uIGRlbnlsaXN0IC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuY29uc3QgREVOSUVEX0tFWVMgPSBuZXcgU2V0KFtcbiAgJ19fcHJvdG9fXycsXG4gICdjb25zdHJ1Y3RvcicsXG4gICdwcm90b3R5cGUnLFxuICAndG9TdHJpbmcnLFxuICAndmFsdWVPZicsXG4gICdoYXNPd25Qcm9wZXJ0eScsXG4gICdpc1Byb3RvdHlwZU9mJyxcbiAgJ3Byb3BlcnR5SXNFbnVtZXJhYmxlJyxcbiAgJ19fZGVmaW5lR2V0dGVyX18nLFxuICAnX19kZWZpbmVTZXR0ZXJfXycsXG4gICdfX2xvb2t1cEdldHRlcl9fJyxcbiAgJ19fbG9va3VwU2V0dGVyX18nLFxuXSk7XG5cbi8vIC0tIENvbnN0YW50cyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuY29uc3QgTUFYX0lOX0FSUkFZX1NJWkUgPSAxMDAwO1xuY29uc3QgTUFYX1ZBTFVFX0xFTiA9IDgwO1xuXG4vLyAtLSBFdmFsdWF0b3IgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogRXZhbHVhdGVzIGEgUHJpc21hLXN0eWxlIGZpbHRlciBhZ2FpbnN0IHNjb3BlIHZhbHVlcy5cbiAqXG4gKiBAcGFyYW0gZ2V0VmFsdWVGbiAtIFJlYWRzIGEgdmFsdWUgZnJvbSBzY29wZSBieSBrZXkgKHJhdywgZm9yIGNvbXBhcmlzb24pXG4gKiBAcGFyYW0gaXNSZWRhY3RlZEZuIC0gQ2hlY2tzIGlmIGEga2V5IGlzIHJlZGFjdGVkIChmb3IgZXZpZGVuY2UgZGlzcGxheSlcbiAqIEBwYXJhbSBmaWx0ZXIgLSBUaGUgV2hlcmVGaWx0ZXIgdG8gZXZhbHVhdGVcbiAqIEByZXR1cm5zIHsgbWF0Y2hlZCwgY29uZGl0aW9ucyB9IOKAlCBtYXRjaGVkID0gYWxsIGNvbmRpdGlvbnMgcGFzc2VkXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBldmFsdWF0ZUZpbHRlcjxUIGV4dGVuZHMgb2JqZWN0PihcbiAgZ2V0VmFsdWVGbjogKGtleTogc3RyaW5nKSA9PiB1bmtub3duLFxuICBpc1JlZGFjdGVkRm46IChrZXk6IHN0cmluZykgPT4gYm9vbGVhbixcbiAgZmlsdGVyOiBXaGVyZUZpbHRlcjxUPixcbik6IHsgbWF0Y2hlZDogYm9vbGVhbjsgY29uZGl0aW9uczogRmlsdGVyQ29uZGl0aW9uW10gfSB7XG4gIGNvbnN0IGNvbmRpdGlvbnM6IEZpbHRlckNvbmRpdGlvbltdID0gW107XG4gIGxldCBhbGxNYXRjaGVkID0gdHJ1ZTtcblxuICBmb3IgKGNvbnN0IFtrZXksIG9wc10gb2YgT2JqZWN0LmVudHJpZXMoZmlsdGVyKSkge1xuICAgIC8vIFNlY3VyaXR5OiBkZW5pZWQga2V5cyBjYXVzZSBydWxlIHRvIGZhaWwgKGNvbnNpc3RlbnQgd2l0aCB1bmtub3duIG9wZXJhdG9yIGJlaGF2aW9yKVxuICAgIGlmIChERU5JRURfS0VZUy5oYXMoa2V5KSkge1xuICAgICAgYWxsTWF0Y2hlZCA9IGZhbHNlO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICghb3BzIHx8IHR5cGVvZiBvcHMgIT09ICdvYmplY3QnKSBjb250aW51ZTtcblxuICAgIGNvbnN0IGFjdHVhbCA9IGdldFZhbHVlRm4oa2V5KTtcbiAgICBjb25zdCByZWRhY3RlZCA9IGlzUmVkYWN0ZWRGbihrZXkpO1xuICAgIGNvbnN0IGRpc3BsYXlWYWx1ZSA9IHJlZGFjdGVkID8gJ1tSRURBQ1RFRF0nIDogc3VtbWFyaXplVmFsdWUoYWN0dWFsLCBNQVhfVkFMVUVfTEVOKTtcblxuICAgIC8vIEV2YWx1YXRlIGVhY2ggb3BlcmF0b3IgaW4gdGhlIEZpbHRlck9wcyBmb3IgdGhpcyBrZXlcbiAgICBmb3IgKGNvbnN0IFtvcCwgdGhyZXNob2xkXSBvZiBPYmplY3QuZW50cmllcyhvcHMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pKSB7XG4gICAgICBjb25zdCBoYW5kbGVyID0gT1BFUkFUT1JfSEFORExFUlNbb3BdO1xuICAgICAgaWYgKCFoYW5kbGVyKSB7XG4gICAgICAgIC8vIFVua25vd24gb3BlcmF0b3I6IHRyZWF0IGFzIGZhaWxlZCBjb25kaXRpb24gc28gcnVsZSBkb2Vzbid0IHNwdXJpb3VzbHkgbWF0Y2hcbiAgICAgICAgY29uZGl0aW9ucy5wdXNoKHsga2V5LCBvcCwgdGhyZXNob2xkLCBhY3R1YWxTdW1tYXJ5OiBkaXNwbGF5VmFsdWUsIHJlc3VsdDogZmFsc2UsIHJlZGFjdGVkIH0pO1xuICAgICAgICBhbGxNYXRjaGVkID0gZmFsc2U7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICBjb25zdCByZXN1bHQgPSBoYW5kbGVyKGFjdHVhbCwgdGhyZXNob2xkKTtcbiAgICAgIGNvbmRpdGlvbnMucHVzaCh7XG4gICAgICAgIGtleSxcbiAgICAgICAgb3AsXG4gICAgICAgIHRocmVzaG9sZCxcbiAgICAgICAgYWN0dWFsU3VtbWFyeTogZGlzcGxheVZhbHVlLFxuICAgICAgICByZXN1bHQsXG4gICAgICAgIHJlZGFjdGVkLFxuICAgICAgfSk7XG5cbiAgICAgIGlmICghcmVzdWx0KSBhbGxNYXRjaGVkID0gZmFsc2U7XG4gICAgfVxuICB9XG5cbiAgLy8gRW1wdHkgZmlsdGVyIChubyBldmFsdWFibGUgY29uZGl0aW9ucykgc2hvdWxkIE5PVCBtYXRjaCDigJQgcHJldmVudHMgdmFjdW91cyB0cnV0aFxuICBpZiAoY29uZGl0aW9ucy5sZW5ndGggPT09IDApIHJldHVybiB7IG1hdGNoZWQ6IGZhbHNlLCBjb25kaXRpb25zIH07XG5cbiAgcmV0dXJuIHsgbWF0Y2hlZDogYWxsTWF0Y2hlZCwgY29uZGl0aW9ucyB9O1xufVxuIl19