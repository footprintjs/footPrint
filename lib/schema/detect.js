"use strict";
/**
 * detect.ts — Single source of truth for schema detection.
 *
 * Replaces three separate detection strategies:
 * - contract/schema.ts  isZodSchema()    (structural: .def/.type)
 * - scope/zod/utils      isZodNode()      (permissive: ._def OR .parse)
 * - runner/validateInput  inline checks    (behavioral: .safeParse)
 *
 * One function, one decision. Every module imports this instead.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidatable = exports.isZod = exports.detectSchema = void 0;
/**
 * Detect what kind of schema an unknown value is.
 *
 * Detection order (most specific → least specific):
 * 1. Zod v3/v4 — has `._def.type` or `.def.type` string
 * 2. Parseable — has `.safeParse()` or `.parse()` (Zod-like, yup, superstruct, etc.)
 * 3. JSON Schema — has `.type` string or `.properties` object (structural markers)
 * 4. None — not a recognized schema
 */
function detectSchema(input) {
    if (!input || typeof input !== 'object')
        return 'none';
    const obj = input;
    // ── Zod v4: top-level `.def` with `.type` string ──
    if (obj.def && typeof obj.def === 'object') {
        if (typeof obj.def.type === 'string') {
            return 'zod';
        }
    }
    // ── Zod v3: `._def` with `.type` or `.typeName` string ──
    if (obj._def && typeof obj._def === 'object') {
        const def = obj._def;
        if (typeof def.type === 'string' || typeof def.typeName === 'string') {
            return 'zod';
        }
    }
    // ── Parseable: has .safeParse() or .parse() ──
    if (typeof obj.safeParse === 'function' || typeof obj.parse === 'function') {
        return 'parseable';
    }
    // ── JSON Schema: structural markers ──
    if (typeof obj.type === 'string' || (typeof obj.properties === 'object' && obj.properties !== null)) {
        return 'json-schema';
    }
    return 'none';
}
exports.detectSchema = detectSchema;
/**
 * Returns true if the input is a Zod schema (v3 or v4).
 * Convenience wrapper — prefer detectSchema() when you need the full kind.
 */
function isZod(input) {
    return detectSchema(input) === 'zod';
}
exports.isZod = isZod;
/**
 * Returns true if the input can be used for runtime validation
 * (has .safeParse()/.parse(), or is a Zod schema).
 */
function isValidatable(input) {
    const kind = detectSchema(input);
    return kind === 'zod' || kind === 'parseable';
}
exports.isValidatable = isValidatable;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGV0ZWN0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vc3JjL2xpYi9zY2hlbWEvZGV0ZWN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7O0dBU0c7OztBQUtIOzs7Ozs7OztHQVFHO0FBQ0gsU0FBZ0IsWUFBWSxDQUFDLEtBQWM7SUFDekMsSUFBSSxDQUFDLEtBQUssSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRO1FBQUUsT0FBTyxNQUFNLENBQUM7SUFFdkQsTUFBTSxHQUFHLEdBQUcsS0FBZ0MsQ0FBQztJQUU3QyxxREFBcUQ7SUFDckQsSUFBSSxHQUFHLENBQUMsR0FBRyxJQUFJLE9BQU8sR0FBRyxDQUFDLEdBQUcsS0FBSyxRQUFRLEVBQUUsQ0FBQztRQUMzQyxJQUFJLE9BQVEsR0FBRyxDQUFDLEdBQStCLENBQUMsSUFBSSxLQUFLLFFBQVEsRUFBRSxDQUFDO1lBQ2xFLE9BQU8sS0FBSyxDQUFDO1FBQ2YsQ0FBQztJQUNILENBQUM7SUFFRCwyREFBMkQ7SUFDM0QsSUFBSSxHQUFHLENBQUMsSUFBSSxJQUFJLE9BQU8sR0FBRyxDQUFDLElBQUksS0FBSyxRQUFRLEVBQUUsQ0FBQztRQUM3QyxNQUFNLEdBQUcsR0FBRyxHQUFHLENBQUMsSUFBK0IsQ0FBQztRQUNoRCxJQUFJLE9BQU8sR0FBRyxDQUFDLElBQUksS0FBSyxRQUFRLElBQUksT0FBTyxHQUFHLENBQUMsUUFBUSxLQUFLLFFBQVEsRUFBRSxDQUFDO1lBQ3JFLE9BQU8sS0FBSyxDQUFDO1FBQ2YsQ0FBQztJQUNILENBQUM7SUFFRCxnREFBZ0Q7SUFDaEQsSUFBSSxPQUFPLEdBQUcsQ0FBQyxTQUFTLEtBQUssVUFBVSxJQUFJLE9BQU8sR0FBRyxDQUFDLEtBQUssS0FBSyxVQUFVLEVBQUUsQ0FBQztRQUMzRSxPQUFPLFdBQVcsQ0FBQztJQUNyQixDQUFDO0lBRUQsd0NBQXdDO0lBQ3hDLElBQUksT0FBTyxHQUFHLENBQUMsSUFBSSxLQUFLLFFBQVEsSUFBSSxDQUFDLE9BQU8sR0FBRyxDQUFDLFVBQVUsS0FBSyxRQUFRLElBQUksR0FBRyxDQUFDLFVBQVUsS0FBSyxJQUFJLENBQUMsRUFBRSxDQUFDO1FBQ3BHLE9BQU8sYUFBYSxDQUFDO0lBQ3ZCLENBQUM7SUFFRCxPQUFPLE1BQU0sQ0FBQztBQUNoQixDQUFDO0FBL0JELG9DQStCQztBQUVEOzs7R0FHRztBQUNILFNBQWdCLEtBQUssQ0FBQyxLQUFjO0lBQ2xDLE9BQU8sWUFBWSxDQUFDLEtBQUssQ0FBQyxLQUFLLEtBQUssQ0FBQztBQUN2QyxDQUFDO0FBRkQsc0JBRUM7QUFFRDs7O0dBR0c7QUFDSCxTQUFnQixhQUFhLENBQUMsS0FBYztJQUMxQyxNQUFNLElBQUksR0FBRyxZQUFZLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDakMsT0FBTyxJQUFJLEtBQUssS0FBSyxJQUFJLElBQUksS0FBSyxXQUFXLENBQUM7QUFDaEQsQ0FBQztBQUhELHNDQUdDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBkZXRlY3QudHMg4oCUIFNpbmdsZSBzb3VyY2Ugb2YgdHJ1dGggZm9yIHNjaGVtYSBkZXRlY3Rpb24uXG4gKlxuICogUmVwbGFjZXMgdGhyZWUgc2VwYXJhdGUgZGV0ZWN0aW9uIHN0cmF0ZWdpZXM6XG4gKiAtIGNvbnRyYWN0L3NjaGVtYS50cyAgaXNab2RTY2hlbWEoKSAgICAoc3RydWN0dXJhbDogLmRlZi8udHlwZSlcbiAqIC0gc2NvcGUvem9kL3V0aWxzICAgICAgaXNab2ROb2RlKCkgICAgICAocGVybWlzc2l2ZTogLl9kZWYgT1IgLnBhcnNlKVxuICogLSBydW5uZXIvdmFsaWRhdGVJbnB1dCAgaW5saW5lIGNoZWNrcyAgICAoYmVoYXZpb3JhbDogLnNhZmVQYXJzZSlcbiAqXG4gKiBPbmUgZnVuY3Rpb24sIG9uZSBkZWNpc2lvbi4gRXZlcnkgbW9kdWxlIGltcG9ydHMgdGhpcyBpbnN0ZWFkLlxuICovXG5cbi8qKiBUaGUga2luZCBvZiBzY2hlbWEgZGV0ZWN0ZWQuICovXG5leHBvcnQgdHlwZSBTY2hlbWFLaW5kID0gJ3pvZCcgfCAncGFyc2VhYmxlJyB8ICdqc29uLXNjaGVtYScgfCAnbm9uZSc7XG5cbi8qKlxuICogRGV0ZWN0IHdoYXQga2luZCBvZiBzY2hlbWEgYW4gdW5rbm93biB2YWx1ZSBpcy5cbiAqXG4gKiBEZXRlY3Rpb24gb3JkZXIgKG1vc3Qgc3BlY2lmaWMg4oaSIGxlYXN0IHNwZWNpZmljKTpcbiAqIDEuIFpvZCB2My92NCDigJQgaGFzIGAuX2RlZi50eXBlYCBvciBgLmRlZi50eXBlYCBzdHJpbmdcbiAqIDIuIFBhcnNlYWJsZSDigJQgaGFzIGAuc2FmZVBhcnNlKClgIG9yIGAucGFyc2UoKWAgKFpvZC1saWtlLCB5dXAsIHN1cGVyc3RydWN0LCBldGMuKVxuICogMy4gSlNPTiBTY2hlbWEg4oCUIGhhcyBgLnR5cGVgIHN0cmluZyBvciBgLnByb3BlcnRpZXNgIG9iamVjdCAoc3RydWN0dXJhbCBtYXJrZXJzKVxuICogNC4gTm9uZSDigJQgbm90IGEgcmVjb2duaXplZCBzY2hlbWFcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRldGVjdFNjaGVtYShpbnB1dDogdW5rbm93bik6IFNjaGVtYUtpbmQge1xuICBpZiAoIWlucHV0IHx8IHR5cGVvZiBpbnB1dCAhPT0gJ29iamVjdCcpIHJldHVybiAnbm9uZSc7XG5cbiAgY29uc3Qgb2JqID0gaW5wdXQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cbiAgLy8g4pSA4pSAIFpvZCB2NDogdG9wLWxldmVsIGAuZGVmYCB3aXRoIGAudHlwZWAgc3RyaW5nIOKUgOKUgFxuICBpZiAob2JqLmRlZiAmJiB0eXBlb2Ygb2JqLmRlZiA9PT0gJ29iamVjdCcpIHtcbiAgICBpZiAodHlwZW9mIChvYmouZGVmIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KS50eXBlID09PSAnc3RyaW5nJykge1xuICAgICAgcmV0dXJuICd6b2QnO1xuICAgIH1cbiAgfVxuXG4gIC8vIOKUgOKUgCBab2QgdjM6IGAuX2RlZmAgd2l0aCBgLnR5cGVgIG9yIGAudHlwZU5hbWVgIHN0cmluZyDilIDilIBcbiAgaWYgKG9iai5fZGVmICYmIHR5cGVvZiBvYmouX2RlZiA9PT0gJ29iamVjdCcpIHtcbiAgICBjb25zdCBkZWYgPSBvYmouX2RlZiBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBpZiAodHlwZW9mIGRlZi50eXBlID09PSAnc3RyaW5nJyB8fCB0eXBlb2YgZGVmLnR5cGVOYW1lID09PSAnc3RyaW5nJykge1xuICAgICAgcmV0dXJuICd6b2QnO1xuICAgIH1cbiAgfVxuXG4gIC8vIOKUgOKUgCBQYXJzZWFibGU6IGhhcyAuc2FmZVBhcnNlKCkgb3IgLnBhcnNlKCkg4pSA4pSAXG4gIGlmICh0eXBlb2Ygb2JqLnNhZmVQYXJzZSA9PT0gJ2Z1bmN0aW9uJyB8fCB0eXBlb2Ygb2JqLnBhcnNlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgcmV0dXJuICdwYXJzZWFibGUnO1xuICB9XG5cbiAgLy8g4pSA4pSAIEpTT04gU2NoZW1hOiBzdHJ1Y3R1cmFsIG1hcmtlcnMg4pSA4pSAXG4gIGlmICh0eXBlb2Ygb2JqLnR5cGUgPT09ICdzdHJpbmcnIHx8ICh0eXBlb2Ygb2JqLnByb3BlcnRpZXMgPT09ICdvYmplY3QnICYmIG9iai5wcm9wZXJ0aWVzICE9PSBudWxsKSkge1xuICAgIHJldHVybiAnanNvbi1zY2hlbWEnO1xuICB9XG5cbiAgcmV0dXJuICdub25lJztcbn1cblxuLyoqXG4gKiBSZXR1cm5zIHRydWUgaWYgdGhlIGlucHV0IGlzIGEgWm9kIHNjaGVtYSAodjMgb3IgdjQpLlxuICogQ29udmVuaWVuY2Ugd3JhcHBlciDigJQgcHJlZmVyIGRldGVjdFNjaGVtYSgpIHdoZW4geW91IG5lZWQgdGhlIGZ1bGwga2luZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzWm9kKGlucHV0OiB1bmtub3duKTogYm9vbGVhbiB7XG4gIHJldHVybiBkZXRlY3RTY2hlbWEoaW5wdXQpID09PSAnem9kJztcbn1cblxuLyoqXG4gKiBSZXR1cm5zIHRydWUgaWYgdGhlIGlucHV0IGNhbiBiZSB1c2VkIGZvciBydW50aW1lIHZhbGlkYXRpb25cbiAqIChoYXMgLnNhZmVQYXJzZSgpLy5wYXJzZSgpLCBvciBpcyBhIFpvZCBzY2hlbWEpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNWYWxpZGF0YWJsZShpbnB1dDogdW5rbm93bik6IGJvb2xlYW4ge1xuICBjb25zdCBraW5kID0gZGV0ZWN0U2NoZW1hKGlucHV0KTtcbiAgcmV0dXJuIGtpbmQgPT09ICd6b2QnIHx8IGtpbmQgPT09ICdwYXJzZWFibGUnO1xufVxuIl19