"use strict";
/**
 * validate.ts — Single validation entry point for any schema kind.
 *
 * Dispatches based on detectSchema():
 * - 'zod' / 'parseable' → calls .safeParse() or .parse()
 * - 'json-schema'        → lightweight structural validation (required fields, type checks)
 * - 'none'               → pass-through
 *
 * Returns a result type — callers decide whether to throw.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateOrThrow = exports.validateAgainstSchema = void 0;
const detect_js_1 = require("./detect.js");
const errors_js_1 = require("./errors.js");
/**
 * Validate data against a schema. Returns a result — does not throw.
 *
 * For throwing behavior, use `validateOrThrow()`.
 */
function validateAgainstSchema(schema, data) {
    const kind = (0, detect_js_1.detectSchema)(schema);
    switch (kind) {
        case 'zod':
        case 'parseable':
            return validateParseable(schema, data);
        case 'json-schema':
            return validateJsonSchema(schema, data);
        case 'none':
            return { success: true, data };
    }
}
exports.validateAgainstSchema = validateAgainstSchema;
/**
 * Validate data against a schema. Throws InputValidationError on failure.
 */
function validateOrThrow(schema, data) {
    const result = validateAgainstSchema(schema, data);
    if (!result.success)
        throw result.error;
    return result.data;
}
exports.validateOrThrow = validateOrThrow;
// ── Parseable (Zod, yup, superstruct, etc.) ──────────────────────────────
function validateParseable(schema, data) {
    var _a;
    // Prefer safeParse (non-throwing)
    if (typeof schema.safeParse === 'function') {
        try {
            const result = schema.safeParse(data);
            if (result.success) {
                return { success: true, data: (_a = result.data) !== null && _a !== void 0 ? _a : data };
            }
            const issues = (0, errors_js_1.extractIssuesFromZodError)(result.error);
            const message = formatIssues(issues);
            return {
                success: false,
                error: new errors_js_1.InputValidationError(message, issues, result.error),
            };
        }
        catch (_b) {
            // safeParse threw (binding error, etc.) — fall through to parse
        }
    }
    // Fallback to parse (throwing)
    if (typeof schema.parse === 'function') {
        try {
            const parsed = schema.parse(data);
            return { success: true, data: parsed !== null && parsed !== void 0 ? parsed : data };
        }
        catch (err) {
            const issues = (0, errors_js_1.extractIssuesFromZodError)(err);
            if (issues.length > 0) {
                return {
                    success: false,
                    error: new errors_js_1.InputValidationError(formatIssues(issues), issues, err),
                };
            }
            // Non-Zod error from parse()
            const rawMessage = err instanceof Error ? err.message : 'Validation failed';
            const fallbackIssues = [{ path: [], message: rawMessage }];
            return {
                success: false,
                error: new errors_js_1.InputValidationError(formatIssues(fallbackIssues), fallbackIssues, err),
            };
        }
    }
    // Has neither safeParse nor parse — shouldn't reach here via detectSchema, but be safe
    return { success: true, data };
}
// ── JSON Schema (lightweight — no ajv dependency) ────────────────────────
function validateJsonSchema(schema, data) {
    if (!data || typeof data !== 'object') {
        return {
            success: false,
            error: new errors_js_1.InputValidationError('Expected an object', [
                { path: [], message: 'Expected an object', code: 'invalid_type', expected: 'object' },
            ]),
        };
    }
    const record = data;
    const issues = [];
    // Check required fields
    const required = schema.required;
    if (Array.isArray(required)) {
        for (const key of required) {
            if (typeof key === 'string' && !Object.prototype.hasOwnProperty.call(record, key)) {
                issues.push({ path: [key], message: `Missing required field "${key}"`, code: 'missing_field' });
            }
        }
    }
    // Check top-level property types
    const properties = schema.properties;
    if (properties && typeof properties === 'object') {
        for (const [key, propSchema] of Object.entries(properties)) {
            if (!Object.prototype.hasOwnProperty.call(record, key))
                continue; // skip missing — required check handles that
            const value = record[key];
            if (propSchema && typeof propSchema === 'object') {
                const expectedType = propSchema.type;
                if (typeof expectedType === 'string' && value !== null && value !== undefined) {
                    const actualType = Array.isArray(value) ? 'array' : typeof value;
                    if (expectedType !== actualType) {
                        issues.push({
                            path: [key],
                            message: `Expected ${expectedType}, received ${actualType}`,
                            code: 'invalid_type',
                            expected: expectedType,
                            received: actualType,
                        });
                    }
                }
            }
        }
    }
    if (issues.length > 0) {
        return {
            success: false,
            error: new errors_js_1.InputValidationError(formatIssues(issues), issues),
        };
    }
    return { success: true, data };
}
// ── Formatting ───────────────────────────────────────────────────────────
function formatIssues(issues) {
    if (issues.length === 0)
        return 'Validation failed';
    if (issues.length === 1)
        return `Input validation failed: ${issues[0].message}`;
    return `Input validation failed: ${issues.length} issues — ${issues.map((i) => i.message).join('; ')}`;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidmFsaWRhdGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvbGliL3NjaGVtYS92YWxpZGF0ZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7Ozs7OztHQVNHOzs7QUFFSCwyQ0FBMkM7QUFDM0MsMkNBQW9HO0FBU3BHOzs7O0dBSUc7QUFDSCxTQUFnQixxQkFBcUIsQ0FBQyxNQUFlLEVBQUUsSUFBYTtJQUNsRSxNQUFNLElBQUksR0FBRyxJQUFBLHdCQUFZLEVBQUMsTUFBTSxDQUFDLENBQUM7SUFFbEMsUUFBUSxJQUFJLEVBQUUsQ0FBQztRQUNiLEtBQUssS0FBSyxDQUFDO1FBQ1gsS0FBSyxXQUFXO1lBQ2QsT0FBTyxpQkFBaUIsQ0FBQyxNQUFpQyxFQUFFLElBQUksQ0FBQyxDQUFDO1FBQ3BFLEtBQUssYUFBYTtZQUNoQixPQUFPLGtCQUFrQixDQUFDLE1BQWlDLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFDckUsS0FBSyxNQUFNO1lBQ1QsT0FBTyxFQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLENBQUM7SUFDbkMsQ0FBQztBQUNILENBQUM7QUFaRCxzREFZQztBQUVEOztHQUVHO0FBQ0gsU0FBZ0IsZUFBZSxDQUFDLE1BQWUsRUFBRSxJQUFhO0lBQzVELE1BQU0sTUFBTSxHQUFHLHFCQUFxQixDQUFDLE1BQU0sRUFBRSxJQUFJLENBQUMsQ0FBQztJQUNuRCxJQUFJLENBQUMsTUFBTSxDQUFDLE9BQU87UUFBRSxNQUFNLE1BQU0sQ0FBQyxLQUFLLENBQUM7SUFDeEMsT0FBTyxNQUFNLENBQUMsSUFBSSxDQUFDO0FBQ3JCLENBQUM7QUFKRCwwQ0FJQztBQUVELDRFQUE0RTtBQUU1RSxTQUFTLGlCQUFpQixDQUFDLE1BQStCLEVBQUUsSUFBYTs7SUFDdkUsa0NBQWtDO0lBQ2xDLElBQUksT0FBTyxNQUFNLENBQUMsU0FBUyxLQUFLLFVBQVUsRUFBRSxDQUFDO1FBQzNDLElBQUksQ0FBQztZQUNI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cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiB2YWxpZGF0ZS50cyDigJQgU2luZ2xlIHZhbGlkYXRpb24gZW50cnkgcG9pbnQgZm9yIGFueSBzY2hlbWEga2luZC5cbiAqXG4gKiBEaXNwYXRjaGVzIGJhc2VkIG9uIGRldGVjdFNjaGVtYSgpOlxuICogLSAnem9kJyAvICdwYXJzZWFibGUnIOKGkiBjYWxscyAuc2FmZVBhcnNlKCkgb3IgLnBhcnNlKClcbiAqIC0gJ2pzb24tc2NoZW1hJyAgICAgICAg4oaSIGxpZ2h0d2VpZ2h0IHN0cnVjdHVyYWwgdmFsaWRhdGlvbiAocmVxdWlyZWQgZmllbGRzLCB0eXBlIGNoZWNrcylcbiAqIC0gJ25vbmUnICAgICAgICAgICAgICAg4oaSIHBhc3MtdGhyb3VnaFxuICpcbiAqIFJldHVybnMgYSByZXN1bHQgdHlwZSDigJQgY2FsbGVycyBkZWNpZGUgd2hldGhlciB0byB0aHJvdy5cbiAqL1xuXG5pbXBvcnQgeyBkZXRlY3RTY2hlbWEgfSBmcm9tICcuL2RldGVjdC5qcyc7XG5pbXBvcnQgeyB0eXBlIFZhbGlkYXRpb25Jc3N1ZSwgZXh0cmFjdElzc3Vlc0Zyb21ab2RFcnJvciwgSW5wdXRWYWxpZGF0aW9uRXJyb3IgfSBmcm9tICcuL2Vycm9ycy5qcyc7XG5cbi8qKiBTdWNjZXNzZnVsIHZhbGlkYXRpb24gcmVzdWx0IOKAlCBtYXkgY29udGFpbiB0cmFuc2Zvcm1lZCBkYXRhLiAqL1xuZXhwb3J0IHR5cGUgVmFsaWRhdGlvblN1Y2Nlc3MgPSB7IHN1Y2Nlc3M6IHRydWU7IGRhdGE6IHVua25vd24gfTtcbi8qKiBGYWlsZWQgdmFsaWRhdGlvbiByZXN1bHQg4oCUIGNhcnJpZXMgc3RydWN0dXJlZCBpc3N1ZXMuICovXG5leHBvcnQgdHlwZSBWYWxpZGF0aW9uRmFpbHVyZSA9IHsgc3VjY2VzczogZmFsc2U7IGVycm9yOiBJbnB1dFZhbGlkYXRpb25FcnJvciB9O1xuLyoqIFVuaW9uIHJlc3VsdCB0eXBlLiAqL1xuZXhwb3J0IHR5cGUgVmFsaWRhdGlvblJlc3VsdCA9IFZhbGlkYXRpb25TdWNjZXNzIHwgVmFsaWRhdGlvbkZhaWx1cmU7XG5cbi8qKlxuICogVmFsaWRhdGUgZGF0YSBhZ2FpbnN0IGEgc2NoZW1hLiBSZXR1cm5zIGEgcmVzdWx0IOKAlCBkb2VzIG5vdCB0aHJvdy5cbiAqXG4gKiBGb3IgdGhyb3dpbmcgYmVoYXZpb3IsIHVzZSBgdmFsaWRhdGVPclRocm93KClgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVBZ2FpbnN0U2NoZW1hKHNjaGVtYTogdW5rbm93biwgZGF0YTogdW5rbm93bik6IFZhbGlkYXRpb25SZXN1bHQge1xuICBjb25zdCBraW5kID0gZGV0ZWN0U2NoZW1hKHNjaGVtYSk7XG5cbiAgc3dpdGNoIChraW5kKSB7XG4gICAgY2FzZSAnem9kJzpcbiAgICBjYXNlICdwYXJzZWFibGUnOlxuICAgICAgcmV0dXJuIHZhbGlkYXRlUGFyc2VhYmxlKHNjaGVtYSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgZGF0YSk7XG4gICAgY2FzZSAnanNvbi1zY2hlbWEnOlxuICAgICAgcmV0dXJuIHZhbGlkYXRlSnNvblNjaGVtYShzY2hlbWEgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIGRhdGEpO1xuICAgIGNhc2UgJ25vbmUnOlxuICAgICAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSwgZGF0YSB9O1xuICB9XG59XG5cbi8qKlxuICogVmFsaWRhdGUgZGF0YSBhZ2FpbnN0IGEgc2NoZW1hLiBUaHJvd3MgSW5wdXRWYWxpZGF0aW9uRXJyb3Igb24gZmFpbHVyZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlT3JUaHJvdyhzY2hlbWE6IHVua25vd24sIGRhdGE6IHVua25vd24pOiB1bmtub3duIHtcbiAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVBZ2FpbnN0U2NoZW1hKHNjaGVtYSwgZGF0YSk7XG4gIGlmICghcmVzdWx0LnN1Y2Nlc3MpIHRocm93IHJlc3VsdC5lcnJvcjtcbiAgcmV0dXJuIHJlc3VsdC5kYXRhO1xufVxuXG4vLyDilIDilIAgUGFyc2VhYmxlIChab2QsIHl1cCwgc3VwZXJzdHJ1Y3QsIGV0Yy4pIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5mdW5jdGlvbiB2YWxpZGF0ZVBhcnNlYWJsZShzY2hlbWE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBkYXRhOiB1bmtub3duKTogVmFsaWRhdGlvblJlc3VsdCB7XG4gIC8vIFByZWZlciBzYWZlUGFyc2UgKG5vbi10aHJvd2luZylcbiAgaWYgKHR5cGVvZiBzY2hlbWEuc2FmZVBhcnNlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IChzY2hlbWEuc2FmZVBhcnNlIGFzICh2OiB1bmtub3duKSA9PiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikoZGF0YSk7XG4gICAgICBpZiAocmVzdWx0LnN1Y2Nlc3MpIHtcbiAgICAgICAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSwgZGF0YTogcmVzdWx0LmRhdGEgPz8gZGF0YSB9O1xuICAgICAgfVxuICAgICAgY29uc3QgaXNzdWVzID0gZXh0cmFjdElzc3Vlc0Zyb21ab2RFcnJvcihyZXN1bHQuZXJyb3IpO1xuICAgICAgY29uc3QgbWVzc2FnZSA9IGZvcm1hdElzc3Vlcyhpc3N1ZXMpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgIGVycm9yOiBuZXcgSW5wdXRWYWxpZGF0aW9uRXJyb3IobWVzc2FnZSwgaXNzdWVzLCByZXN1bHQuZXJyb3IpLFxuICAgICAgfTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIHNhZmVQYXJzZSB0aHJldyAoYmluZGluZyBlcnJvciwgZXRjLikg4oCUIGZhbGwgdGhyb3VnaCB0byBwYXJzZVxuICAgIH1cbiAgfVxuXG4gIC8vIEZhbGxiYWNrIHRvIHBhcnNlICh0aHJvd2luZylcbiAgaWYgKHR5cGVvZiBzY2hlbWEucGFyc2UgPT09ICdmdW5jdGlvbicpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcGFyc2VkID0gKHNjaGVtYS5wYXJzZSBhcyAodjogdW5rbm93bikgPT4gdW5rbm93bikoZGF0YSk7XG4gICAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlLCBkYXRhOiBwYXJzZWQgPz8gZGF0YSB9O1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc3QgaXNzdWVzID0gZXh0cmFjdElzc3Vlc0Zyb21ab2RFcnJvcihlcnIpO1xuICAgICAgaWYgKGlzc3Vlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgICAgZXJyb3I6IG5ldyBJbnB1dFZhbGlkYXRpb25FcnJvcihmb3JtYXRJc3N1ZXMoaXNzdWVzKSwgaXNzdWVzLCBlcnIpLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgLy8gTm9uLVpvZCBlcnJvciBmcm9tIHBhcnNlKClcbiAgICAgIGNvbnN0IHJhd01lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogJ1ZhbGlkYXRpb24gZmFpbGVkJztcbiAgICAgIGNvbnN0IGZhbGxiYWNrSXNzdWVzOiBWYWxpZGF0aW9uSXNzdWVbXSA9IFt7IHBhdGg6IFtdLCBtZXNzYWdlOiByYXdNZXNzYWdlIH1dO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgIGVycm9yOiBuZXcgSW5wdXRWYWxpZGF0aW9uRXJyb3IoZm9ybWF0SXNzdWVzKGZhbGxiYWNrSXNzdWVzKSwgZmFsbGJhY2tJc3N1ZXMsIGVyciksXG4gICAgICB9O1xuICAgIH1cbiAgfVxuXG4gIC8vIEhhcyBuZWl0aGVyIHNhZmVQYXJzZSBub3IgcGFyc2Ug4oCUIHNob3VsZG4ndCByZWFjaCBoZXJlIHZpYSBkZXRlY3RTY2hlbWEsIGJ1dCBiZSBzYWZlXG4gIHJldHVybiB7IHN1Y2Nlc3M6IHRydWUsIGRhdGEgfTtcbn1cblxuLy8g4pSA4pSAIEpTT04gU2NoZW1hIChsaWdodHdlaWdodCDigJQgbm8gYWp2IGRlcGVuZGVuY3kpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5mdW5jdGlvbiB2YWxpZGF0ZUpzb25TY2hlbWEoc2NoZW1hOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgZGF0YTogdW5rbm93bik6IFZhbGlkYXRpb25SZXN1bHQge1xuICBpZiAoIWRhdGEgfHwgdHlwZW9mIGRhdGEgIT09ICdvYmplY3QnKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBJbnB1dFZhbGlkYXRpb25FcnJvcignRXhwZWN0ZWQgYW4gb2JqZWN0JywgW1xuICAgICAgICB7IHBhdGg6IFtdLCBtZXNzYWdlOiAnRXhwZWN0ZWQgYW4gb2JqZWN0JywgY29kZTogJ2ludmFsaWRfdHlwZScsIGV4cGVjdGVkOiAnb2JqZWN0JyB9LFxuICAgICAgXSksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHJlY29yZCA9IGRhdGEgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIGNvbnN0IGlzc3VlczogVmFsaWRhdGlvbklzc3VlW10gPSBbXTtcblxuICAvLyBDaGVjayByZXF1aXJlZCBmaWVsZHNcbiAgY29uc3QgcmVxdWlyZWQgPSBzY2hlbWEucmVxdWlyZWQ7XG4gIGlmIChBcnJheS5pc0FycmF5KHJlcXVpcmVkKSkge1xuICAgIGZvciAoY29uc3Qga2V5IG9mIHJlcXVpcmVkKSB7XG4gICAgICBpZiAodHlwZW9mIGtleSA9PT0gJ3N0cmluZycgJiYgIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChyZWNvcmQsIGtleSkpIHtcbiAgICAgICAgaXNzdWVzLnB1c2goeyBwYXRoOiBba2V5XSwgbWVzc2FnZTogYE1pc3NpbmcgcmVxdWlyZWQgZmllbGQgXCIke2tleX1cImAsIGNvZGU6ICdtaXNzaW5nX2ZpZWxkJyB9KTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBDaGVjayB0b3AtbGV2ZWwgcHJvcGVydHkgdHlwZXNcbiAgY29uc3QgcHJvcGVydGllcyA9IHNjaGVtYS5wcm9wZXJ0aWVzO1xuICBpZiAocHJvcGVydGllcyAmJiB0eXBlb2YgcHJvcGVydGllcyA9PT0gJ29iamVjdCcpIHtcbiAgICBmb3IgKGNvbnN0IFtrZXksIHByb3BTY2hlbWFdIG9mIE9iamVjdC5lbnRyaWVzKHByb3BlcnRpZXMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pKSB7XG4gICAgICBpZiAoIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChyZWNvcmQsIGtleSkpIGNvbnRpbnVlOyAvLyBza2lwIG1pc3Npbmcg4oCUIHJlcXVpcmVkIGNoZWNrIGhhbmRsZXMgdGhhdFxuXG4gICAgICBjb25zdCB2YWx1ZSA9IHJlY29yZFtrZXldO1xuICAgICAgaWYgKHByb3BTY2hlbWEgJiYgdHlwZW9mIHByb3BTY2hlbWEgPT09ICdvYmplY3QnKSB7XG4gICAgICAgIGNvbnN0IGV4cGVjdGVkVHlwZSA9IChwcm9wU2NoZW1hIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KS50eXBlO1xuICAgICAgICBpZiAodHlwZW9mIGV4cGVjdGVkVHlwZSA9PT0gJ3N0cmluZycgJiYgdmFsdWUgIT09IG51bGwgJiYgdmFsdWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIGNvbnN0IGFjdHVhbFR5cGUgPSBBcnJheS5pc0FycmF5KHZhbHVlKSA/ICdhcnJheScgOiB0eXBlb2YgdmFsdWU7XG4gICAgICAgICAgaWYgKGV4cGVjdGVkVHlwZSAhPT0gYWN0dWFsVHlwZSkge1xuICAgICAgICAgICAgaXNzdWVzLnB1c2goe1xuICAgICAgICAgICAgICBwYXRoOiBba2V5XSxcbiAgICAgICAgICAgICAgbWVzc2FnZTogYEV4cGVjdGVkICR7ZXhwZWN0ZWRUeXBlfSwgcmVjZWl2ZWQgJHthY3R1YWxUeXBlfWAsXG4gICAgICAgICAgICAgIGNvZGU6ICdpbnZhbGlkX3R5cGUnLFxuICAgICAgICAgICAgICBleHBlY3RlZDogZXhwZWN0ZWRUeXBlLFxuICAgICAgICAgICAgICByZWNlaXZlZDogYWN0dWFsVHlwZSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGlmIChpc3N1ZXMubGVuZ3RoID4gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgSW5wdXRWYWxpZGF0aW9uRXJyb3IoZm9ybWF0SXNzdWVzKGlzc3VlcyksIGlzc3VlcyksXG4gICAgfTtcbiAgfVxuXG4gIHJldHVybiB7IHN1Y2Nlc3M6IHRydWUsIGRhdGEgfTtcbn1cblxuLy8g4pSA4pSAIEZvcm1hdHRpbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmZ1bmN0aW9uIGZvcm1hdElzc3Vlcyhpc3N1ZXM6IFZhbGlkYXRpb25Jc3N1ZVtdKTogc3RyaW5nIHtcbiAgaWYgKGlzc3Vlcy5sZW5ndGggPT09IDApIHJldHVybiAnVmFsaWRhdGlvbiBmYWlsZWQnO1xuICBpZiAoaXNzdWVzLmxlbmd0aCA9PT0gMSkgcmV0dXJuIGBJbnB1dCB2YWxpZGF0aW9uIGZhaWxlZDogJHtpc3N1ZXNbMF0ubWVzc2FnZX1gO1xuICByZXR1cm4gYElucHV0IHZhbGlkYXRpb24gZmFpbGVkOiAke2lzc3Vlcy5sZW5ndGh9IGlzc3VlcyDigJQgJHtpc3N1ZXMubWFwKChpKSA9PiBpLm1lc3NhZ2UpLmpvaW4oJzsgJyl9YDtcbn1cbiJdfQ==