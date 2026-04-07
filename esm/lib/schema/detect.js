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
/**
 * Detect what kind of schema an unknown value is.
 *
 * Detection order (most specific → least specific):
 * 1. Zod v3/v4 — has `._def.type` or `.def.type` string
 * 2. Parseable — has `.safeParse()` or `.parse()` (Zod-like, yup, superstruct, etc.)
 * 3. JSON Schema — has `.type` string or `.properties` object (structural markers)
 * 4. None — not a recognized schema
 */
export function detectSchema(input) {
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
/**
 * Returns true if the input is a Zod schema (v3 or v4).
 * Convenience wrapper — prefer detectSchema() when you need the full kind.
 */
export function isZod(input) {
    return detectSchema(input) === 'zod';
}
/**
 * Returns true if the input can be used for runtime validation
 * (has .safeParse()/.parse(), or is a Zod schema).
 */
export function isValidatable(input) {
    const kind = detectSchema(input);
    return kind === 'zod' || kind === 'parseable';
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGV0ZWN0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9zY2hlbWEvZGV0ZWN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7R0FTRztBQUtIOzs7Ozs7OztHQVFHO0FBQ0gsTUFBTSxVQUFVLFlBQVksQ0FBQyxLQUFjO0lBQ3pDLElBQUksQ0FBQyxLQUFLLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUTtRQUFFLE9BQU8sTUFBTSxDQUFDO0lBRXZELE1BQU0sR0FBRyxHQUFHLEtBQWdDLENBQUM7SUFFN0MscURBQXFEO0lBQ3JELElBQUksR0FBRyxDQUFDLEdBQUcsSUFBSSxPQUFPLEdBQUcsQ0FBQyxHQUFHLEtBQUssUUFBUSxFQUFFLENBQUM7UUFDM0MsSUFBSSxPQUFRLEdBQUcsQ0FBQyxHQUErQixDQUFDLElBQUksS0FBSyxRQUFRLEVBQUUsQ0FBQztZQUNsRSxPQUFPLEtBQUssQ0FBQztRQUNmLENBQUM7SUFDSCxDQUFDO0lBRUQsMkRBQTJEO0lBQzNELElBQUksR0FBRyxDQUFDLElBQUksSUFBSSxPQUFPLEdBQUcsQ0FBQyxJQUFJLEtBQUssUUFBUSxFQUFFLENBQUM7UUFDN0MsTUFBTSxHQUFHLEdBQUcsR0FBRyxDQUFDLElBQStCLENBQUM7UUFDaEQsSUFBSSxPQUFPLEdBQUcsQ0FBQyxJQUFJLEtBQUssUUFBUSxJQUFJLE9BQU8sR0FBRyxDQUFDLFFBQVEsS0FBSyxRQUFRLEVBQUUsQ0FBQztZQUNyRSxPQUFPLEtBQUssQ0FBQztRQUNmLENBQUM7SUFDSCxDQUFDO0lBRUQsZ0RBQWdEO0lBQ2hELElBQUksT0FBTyxHQUFHLENBQUMsU0FBUyxLQUFLLFVBQVUsSUFBSSxPQUFPLEdBQUcsQ0FBQyxLQUFLLEtBQUssVUFBVSxFQUFFLENBQUM7UUFDM0UsT0FBTyxXQUFXLENBQUM7SUFDckIsQ0FBQztJQUVELHdDQUF3QztJQUN4QyxJQUFJLE9BQU8sR0FBRyxDQUFDLElBQUksS0FBSyxRQUFRLElBQUksQ0FBQyxPQUFPLEdBQUcsQ0FBQyxVQUFVLEtBQUssUUFBUSxJQUFJLEdBQUcsQ0FBQyxVQUFVLEtBQUssSUFBSSxDQUFDLEVBQUUsQ0FBQztRQUNwRyxPQUFPLGFBQWEsQ0FBQztJQUN2QixDQUFDO0lBRUQsT0FBTyxNQUFNLENBQUM7QUFDaEIsQ0FBQztBQUVEOzs7R0FHRztBQUNILE1BQU0sVUFBVSxLQUFLLENBQUMsS0FBYztJQUNsQyxPQUFPLFlBQVksQ0FBQyxLQUFLLENBQUMsS0FBSyxLQUFLLENBQUM7QUFDdkMsQ0FBQztBQUVEOzs7R0FHRztBQUNILE1BQU0sVUFBVSxhQUFhLENBQUMsS0FBYztJQUMxQyxNQUFNLElBQUksR0FBRyxZQUFZLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDakMsT0FBTyxJQUFJLEtBQUssS0FBSyxJQUFJLElBQUksS0FBSyxXQUFXLENBQUM7QUFDaEQsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogZGV0ZWN0LnRzIOKAlCBTaW5nbGUgc291cmNlIG9mIHRydXRoIGZvciBzY2hlbWEgZGV0ZWN0aW9uLlxuICpcbiAqIFJlcGxhY2VzIHRocmVlIHNlcGFyYXRlIGRldGVjdGlvbiBzdHJhdGVnaWVzOlxuICogLSBjb250cmFjdC9zY2hlbWEudHMgIGlzWm9kU2NoZW1hKCkgICAgKHN0cnVjdHVyYWw6IC5kZWYvLnR5cGUpXG4gKiAtIHNjb3BlL3pvZC91dGlscyAgICAgIGlzWm9kTm9kZSgpICAgICAgKHBlcm1pc3NpdmU6IC5fZGVmIE9SIC5wYXJzZSlcbiAqIC0gcnVubmVyL3ZhbGlkYXRlSW5wdXQgIGlubGluZSBjaGVja3MgICAgKGJlaGF2aW9yYWw6IC5zYWZlUGFyc2UpXG4gKlxuICogT25lIGZ1bmN0aW9uLCBvbmUgZGVjaXNpb24uIEV2ZXJ5IG1vZHVsZSBpbXBvcnRzIHRoaXMgaW5zdGVhZC5cbiAqL1xuXG4vKiogVGhlIGtpbmQgb2Ygc2NoZW1hIGRldGVjdGVkLiAqL1xuZXhwb3J0IHR5cGUgU2NoZW1hS2luZCA9ICd6b2QnIHwgJ3BhcnNlYWJsZScgfCAnanNvbi1zY2hlbWEnIHwgJ25vbmUnO1xuXG4vKipcbiAqIERldGVjdCB3aGF0IGtpbmQgb2Ygc2NoZW1hIGFuIHVua25vd24gdmFsdWUgaXMuXG4gKlxuICogRGV0ZWN0aW9uIG9yZGVyIChtb3N0IHNwZWNpZmljIOKGkiBsZWFzdCBzcGVjaWZpYyk6XG4gKiAxLiBab2QgdjMvdjQg4oCUIGhhcyBgLl9kZWYudHlwZWAgb3IgYC5kZWYudHlwZWAgc3RyaW5nXG4gKiAyLiBQYXJzZWFibGUg4oCUIGhhcyBgLnNhZmVQYXJzZSgpYCBvciBgLnBhcnNlKClgIChab2QtbGlrZSwgeXVwLCBzdXBlcnN0cnVjdCwgZXRjLilcbiAqIDMuIEpTT04gU2NoZW1hIOKAlCBoYXMgYC50eXBlYCBzdHJpbmcgb3IgYC5wcm9wZXJ0aWVzYCBvYmplY3QgKHN0cnVjdHVyYWwgbWFya2VycylcbiAqIDQuIE5vbmUg4oCUIG5vdCBhIHJlY29nbml6ZWQgc2NoZW1hXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXRlY3RTY2hlbWEoaW5wdXQ6IHVua25vd24pOiBTY2hlbWFLaW5kIHtcbiAgaWYgKCFpbnB1dCB8fCB0eXBlb2YgaW5wdXQgIT09ICdvYmplY3QnKSByZXR1cm4gJ25vbmUnO1xuXG4gIGNvbnN0IG9iaiA9IGlucHV0IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuXG4gIC8vIOKUgOKUgCBab2QgdjQ6IHRvcC1sZXZlbCBgLmRlZmAgd2l0aCBgLnR5cGVgIHN0cmluZyDilIDilIBcbiAgaWYgKG9iai5kZWYgJiYgdHlwZW9mIG9iai5kZWYgPT09ICdvYmplY3QnKSB7XG4gICAgaWYgKHR5cGVvZiAob2JqLmRlZiBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikudHlwZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgIHJldHVybiAnem9kJztcbiAgICB9XG4gIH1cblxuICAvLyDilIDilIAgWm9kIHYzOiBgLl9kZWZgIHdpdGggYC50eXBlYCBvciBgLnR5cGVOYW1lYCBzdHJpbmcg4pSA4pSAXG4gIGlmIChvYmouX2RlZiAmJiB0eXBlb2Ygb2JqLl9kZWYgPT09ICdvYmplY3QnKSB7XG4gICAgY29uc3QgZGVmID0gb2JqLl9kZWYgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgaWYgKHR5cGVvZiBkZWYudHlwZSA9PT0gJ3N0cmluZycgfHwgdHlwZW9mIGRlZi50eXBlTmFtZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgIHJldHVybiAnem9kJztcbiAgICB9XG4gIH1cblxuICAvLyDilIDilIAgUGFyc2VhYmxlOiBoYXMgLnNhZmVQYXJzZSgpIG9yIC5wYXJzZSgpIOKUgOKUgFxuICBpZiAodHlwZW9mIG9iai5zYWZlUGFyc2UgPT09ICdmdW5jdGlvbicgfHwgdHlwZW9mIG9iai5wYXJzZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIHJldHVybiAncGFyc2VhYmxlJztcbiAgfVxuXG4gIC8vIOKUgOKUgCBKU09OIFNjaGVtYTogc3RydWN0dXJhbCBtYXJrZXJzIOKUgOKUgFxuICBpZiAodHlwZW9mIG9iai50eXBlID09PSAnc3RyaW5nJyB8fCAodHlwZW9mIG9iai5wcm9wZXJ0aWVzID09PSAnb2JqZWN0JyAmJiBvYmoucHJvcGVydGllcyAhPT0gbnVsbCkpIHtcbiAgICByZXR1cm4gJ2pzb24tc2NoZW1hJztcbiAgfVxuXG4gIHJldHVybiAnbm9uZSc7XG59XG5cbi8qKlxuICogUmV0dXJucyB0cnVlIGlmIHRoZSBpbnB1dCBpcyBhIFpvZCBzY2hlbWEgKHYzIG9yIHY0KS5cbiAqIENvbnZlbmllbmNlIHdyYXBwZXIg4oCUIHByZWZlciBkZXRlY3RTY2hlbWEoKSB3aGVuIHlvdSBuZWVkIHRoZSBmdWxsIGtpbmQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1pvZChpbnB1dDogdW5rbm93bik6IGJvb2xlYW4ge1xuICByZXR1cm4gZGV0ZWN0U2NoZW1hKGlucHV0KSA9PT0gJ3pvZCc7XG59XG5cbi8qKlxuICogUmV0dXJucyB0cnVlIGlmIHRoZSBpbnB1dCBjYW4gYmUgdXNlZCBmb3IgcnVudGltZSB2YWxpZGF0aW9uXG4gKiAoaGFzIC5zYWZlUGFyc2UoKS8ucGFyc2UoKSwgb3IgaXMgYSBab2Qgc2NoZW1hKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzVmFsaWRhdGFibGUoaW5wdXQ6IHVua25vd24pOiBib29sZWFuIHtcbiAgY29uc3Qga2luZCA9IGRldGVjdFNjaGVtYShpbnB1dCk7XG4gIHJldHVybiBraW5kID09PSAnem9kJyB8fCBraW5kID09PSAncGFyc2VhYmxlJztcbn1cbiJdfQ==