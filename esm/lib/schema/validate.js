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
import { detectSchema } from './detect.js';
import { extractIssuesFromZodError, InputValidationError } from './errors.js';
/**
 * Validate data against a schema. Returns a result — does not throw.
 *
 * For throwing behavior, use `validateOrThrow()`.
 */
export function validateAgainstSchema(schema, data) {
    const kind = detectSchema(schema);
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
/**
 * Validate data against a schema. Throws InputValidationError on failure.
 */
export function validateOrThrow(schema, data) {
    const result = validateAgainstSchema(schema, data);
    if (!result.success)
        throw result.error;
    return result.data;
}
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
            const issues = extractIssuesFromZodError(result.error);
            const message = formatIssues(issues);
            return {
                success: false,
                error: new InputValidationError(message, issues, result.error),
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
            const issues = extractIssuesFromZodError(err);
            if (issues.length > 0) {
                return {
                    success: false,
                    error: new InputValidationError(formatIssues(issues), issues, err),
                };
            }
            // Non-Zod error from parse()
            const rawMessage = err instanceof Error ? err.message : 'Validation failed';
            const fallbackIssues = [{ path: [], message: rawMessage }];
            return {
                success: false,
                error: new InputValidationError(formatIssues(fallbackIssues), fallbackIssues, err),
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
            error: new InputValidationError('Expected an object', [
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
            error: new InputValidationError(formatIssues(issues), issues),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidmFsaWRhdGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL3NjaGVtYS92YWxpZGF0ZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7O0dBU0c7QUFFSCxPQUFPLEVBQUUsWUFBWSxFQUFFLE1BQU0sYUFBYSxDQUFDO0FBQzNDLE9BQU8sRUFBd0IseUJBQXlCLEVBQUUsb0JBQW9CLEVBQUUsTUFBTSxhQUFhLENBQUM7QUFTcEc7Ozs7R0FJRztBQUNILE1BQU0sVUFBVSxxQkFBcUIsQ0FBQyxNQUFlLEVBQUUsSUFBYTtJQUNsRSxNQUFNLElBQUksR0FBRyxZQUFZLENBQUMsTUFBTSxDQUFDLENBQUM7SUFFbEMsUUFBUSxJQUFJLEVBQUUsQ0FBQztRQUNiLEtBQUssS0FBSyxDQUFDO1FBQ1gsS0FBSyxXQUFXO1lBQ2QsT0FBTyxpQkFBaUIsQ0FBQyxNQUFpQyxFQUFFLElBQUksQ0FBQyxDQUFDO1FBQ3BFLEtBQUssYUFBYTtZQUNoQixPQUFPLGtCQUFrQixDQUFDLE1BQWlDLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFDckUsS0FBSyxNQUFNO1lBQ1QsT0FBTyxFQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLENBQUM7SUFDbkMsQ0FBQztBQUNILENBQUM7QUFFRDs7R0FFRztBQUNILE1BQU0sVUFBVSxlQUFlLENBQUMsTUFBZSxFQUFFLElBQWE7SUFDNUQsTUFBTSxNQUFNLEdBQUcscUJBQXFCLENBQUMsTUFBTSxFQUFFLElBQUksQ0FBQyxDQUFDO0lBQ25ELElBQUksQ0FBQyxNQUFNLENBQUMsT0FBTztRQUFFLE1BQU0sTUFBTSxDQUFDLEtBQUssQ0FBQztJQUN4QyxPQUFPLE1BQU0sQ0FBQyxJQUFJLENBQUM7QUFDckIsQ0FBQztBQUVELDRFQUE0RTtBQUU1RSxTQUFTLGlCQUFpQixDQUFDLE1BQStCLEVBQUUsSUFBYTs7SUFDdkUsa0NBQWtDO0lBQ2xDLElBQUksT0FBTyxNQUFN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Q0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO0FBQ3pHLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIHZhbGlkYXRlLnRzIOKAlCBTaW5nbGUgdmFsaWRhdGlvbiBlbnRyeSBwb2ludCBmb3IgYW55IHNjaGVtYSBraW5kLlxuICpcbiAqIERpc3BhdGNoZXMgYmFzZWQgb24gZGV0ZWN0U2NoZW1hKCk6XG4gKiAtICd6b2QnIC8gJ3BhcnNlYWJsZScg4oaSIGNhbGxzIC5zYWZlUGFyc2UoKSBvciAucGFyc2UoKVxuICogLSAnanNvbi1zY2hlbWEnICAgICAgICDihpIgbGlnaHR3ZWlnaHQgc3RydWN0dXJhbCB2YWxpZGF0aW9uIChyZXF1aXJlZCBmaWVsZHMsIHR5cGUgY2hlY2tzKVxuICogLSAnbm9uZScgICAgICAgICAgICAgICDihpIgcGFzcy10aHJvdWdoXG4gKlxuICogUmV0dXJucyBhIHJlc3VsdCB0eXBlIOKAlCBjYWxsZXJzIGRlY2lkZSB3aGV0aGVyIHRvIHRocm93LlxuICovXG5cbmltcG9ydCB7IGRldGVjdFNjaGVtYSB9IGZyb20gJy4vZGV0ZWN0LmpzJztcbmltcG9ydCB7IHR5cGUgVmFsaWRhdGlvbklzc3VlLCBleHRyYWN0SXNzdWVzRnJvbVpvZEVycm9yLCBJbnB1dFZhbGlkYXRpb25FcnJvciB9IGZyb20gJy4vZXJyb3JzLmpzJztcblxuLyoqIFN1Y2Nlc3NmdWwgdmFsaWRhdGlvbiByZXN1bHQg4oCUIG1heSBjb250YWluIHRyYW5zZm9ybWVkIGRhdGEuICovXG5leHBvcnQgdHlwZSBWYWxpZGF0aW9uU3VjY2VzcyA9IHsgc3VjY2VzczogdHJ1ZTsgZGF0YTogdW5rbm93biB9O1xuLyoqIEZhaWxlZCB2YWxpZGF0aW9uIHJlc3VsdCDigJQgY2FycmllcyBzdHJ1Y3R1cmVkIGlzc3Vlcy4gKi9cbmV4cG9ydCB0eXBlIFZhbGlkYXRpb25GYWlsdXJlID0geyBzdWNjZXNzOiBmYWxzZTsgZXJyb3I6IElucHV0VmFsaWRhdGlvbkVycm9yIH07XG4vKiogVW5pb24gcmVzdWx0IHR5cGUuICovXG5leHBvcnQgdHlwZSBWYWxpZGF0aW9uUmVzdWx0ID0gVmFsaWRhdGlvblN1Y2Nlc3MgfCBWYWxpZGF0aW9uRmFpbHVyZTtcblxuLyoqXG4gKiBWYWxpZGF0ZSBkYXRhIGFnYWluc3QgYSBzY2hlbWEuIFJldHVybnMgYSByZXN1bHQg4oCUIGRvZXMgbm90IHRocm93LlxuICpcbiAqIEZvciB0aHJvd2luZyBiZWhhdmlvciwgdXNlIGB2YWxpZGF0ZU9yVGhyb3coKWAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZUFnYWluc3RTY2hlbWEoc2NoZW1hOiB1bmtub3duLCBkYXRhOiB1bmtub3duKTogVmFsaWRhdGlvblJlc3VsdCB7XG4gIGNvbnN0IGtpbmQgPSBkZXRlY3RTY2hlbWEoc2NoZW1hKTtcblxuICBzd2l0Y2ggKGtpbmQpIHtcbiAgICBjYXNlICd6b2QnOlxuICAgIGNhc2UgJ3BhcnNlYWJsZSc6XG4gICAgICByZXR1cm4gdmFsaWRhdGVQYXJzZWFibGUoc2NoZW1hIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBkYXRhKTtcbiAgICBjYXNlICdqc29uLXNjaGVtYSc6XG4gICAgICByZXR1cm4gdmFsaWRhdGVKc29uU2NoZW1hKHNjaGVtYSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgZGF0YSk7XG4gICAgY2FzZSAnbm9uZSc6XG4gICAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlLCBkYXRhIH07XG4gIH1cbn1cblxuLyoqXG4gKiBWYWxpZGF0ZSBkYXRhIGFnYWluc3QgYSBzY2hlbWEuIFRocm93cyBJbnB1dFZhbGlkYXRpb25FcnJvciBvbiBmYWlsdXJlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVPclRocm93KHNjaGVtYTogdW5rbm93biwgZGF0YTogdW5rbm93bik6IHVua25vd24ge1xuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZUFnYWluc3RTY2hlbWEoc2NoZW1hLCBkYXRhKTtcbiAgaWYgKCFyZXN1bHQuc3VjY2VzcykgdGhyb3cgcmVzdWx0LmVycm9yO1xuICByZXR1cm4gcmVzdWx0LmRhdGE7XG59XG5cbi8vIOKUgOKUgCBQYXJzZWFibGUgKFpvZCwgeXVwLCBzdXBlcnN0cnVjdCwgZXRjLikg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmZ1bmN0aW9uIHZhbGlkYXRlUGFyc2VhYmxlKHNjaGVtYTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIGRhdGE6IHVua25vd24pOiBWYWxpZGF0aW9uUmVzdWx0IHtcbiAgLy8gUHJlZmVyIHNhZmVQYXJzZSAobm9uLXRocm93aW5nKVxuICBpZiAodHlwZW9mIHNjaGVtYS5zYWZlUGFyc2UgPT09ICdmdW5jdGlvbicpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzdWx0ID0gKHNjaGVtYS5zYWZlUGFyc2UgYXMgKHY6IHVua25vd24pID0+IFJlY29yZDxzdHJpbmcsIHVua25vd24+KShkYXRhKTtcbiAgICAgIGlmIChyZXN1bHQuc3VjY2Vzcykge1xuICAgICAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlLCBkYXRhOiByZXN1bHQuZGF0YSA/PyBkYXRhIH07XG4gICAgICB9XG4gICAgICBjb25zdCBpc3N1ZXMgPSBleHRyYWN0SXNzdWVzRnJvbVpvZEVycm9yKHJlc3VsdC5lcnJvcik7XG4gICAgICBjb25zdCBtZXNzYWdlID0gZm9ybWF0SXNzdWVzKGlzc3Vlcyk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IG5ldyBJbnB1dFZhbGlkYXRpb25FcnJvcihtZXNzYWdlLCBpc3N1ZXMsIHJlc3VsdC5lcnJvciksXG4gICAgICB9O1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gc2FmZVBhcnNlIHRocmV3IChiaW5kaW5nIGVycm9yLCBldGMuKSDigJQgZmFsbCB0aHJvdWdoIHRvIHBhcnNlXG4gICAgfVxuICB9XG5cbiAgLy8gRmFsbGJhY2sgdG8gcGFyc2UgKHRocm93aW5nKVxuICBpZiAodHlwZW9mIHNjaGVtYS5wYXJzZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBwYXJzZWQgPSAoc2NoZW1hLnBhcnNlIGFzICh2OiB1bmtub3duKSA9PiB1bmtub3duKShkYXRhKTtcbiAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IHRydWUsIGRhdGE6IHBhcnNlZCA/PyBkYXRhIH07XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBjb25zdCBpc3N1ZXMgPSBleHRyYWN0SXNzdWVzRnJvbVpvZEVycm9yKGVycik7XG4gICAgICBpZiAoaXNzdWVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgICBlcnJvcjogbmV3IElucHV0VmFsaWRhdGlvbkVycm9yKGZvcm1hdElzc3Vlcyhpc3N1ZXMpLCBpc3N1ZXMsIGVyciksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICAvLyBOb24tWm9kIGVycm9yIGZyb20gcGFyc2UoKVxuICAgICAgY29uc3QgcmF3TWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiAnVmFsaWRhdGlvbiBmYWlsZWQnO1xuICAgICAgY29uc3QgZmFsbGJhY2tJc3N1ZXM6IFZhbGlkYXRpb25Jc3N1ZVtdID0gW3sgcGF0aDogW10sIG1lc3NhZ2U6IHJhd01lc3NhZ2UgfV07XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IG5ldyBJbnB1dFZhbGlkYXRpb25FcnJvcihmb3JtYXRJc3N1ZXMoZmFsbGJhY2tJc3N1ZXMpLCBmYWxsYmFja0lzc3VlcywgZXJyKSxcbiAgICAgIH07XG4gICAgfVxuICB9XG5cbiAgLy8gSGFzIG5laXRoZXIgc2FmZVBhcnNlIG5vciBwYXJzZSDigJQgc2hvdWxkbid0IHJlYWNoIGhlcmUgdmlhIGRldGVjdFNjaGVtYSwgYnV0IGJlIHNhZmVcbiAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSwgZGF0YSB9O1xufVxuXG4vLyDilIDilIAgSlNPTiBTY2hlbWEgKGxpZ2h0d2VpZ2h0IOKAlCBubyBhanYgZGVwZW5kZW5jeSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmZ1bmN0aW9uIHZhbGlkYXRlSnNvblNjaGVtYShzY2hlbWE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBkYXRhOiB1bmtub3duKTogVmFsaWRhdGlvblJlc3VsdCB7XG4gIGlmICghZGF0YSB8fCB0eXBlb2YgZGF0YSAhPT0gJ29iamVjdCcpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IElucHV0VmFsaWRhdGlvbkVycm9yKCdFeHBlY3RlZCBhbiBvYmplY3QnLCBbXG4gICAgICAgIHsgcGF0aDogW10sIG1lc3NhZ2U6ICdFeHBlY3RlZCBhbiBvYmplY3QnLCBjb2RlOiAnaW52YWxpZF90eXBlJywgZXhwZWN0ZWQ6ICdvYmplY3QnIH0sXG4gICAgICBdKSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgcmVjb3JkID0gZGF0YSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgY29uc3QgaXNzdWVzOiBWYWxpZGF0aW9uSXNzdWVbXSA9IFtdO1xuXG4gIC8vIENoZWNrIHJlcXVpcmVkIGZpZWxkc1xuICBjb25zdCByZXF1aXJlZCA9IHNjaGVtYS5yZXF1aXJlZDtcbiAgaWYgKEFycmF5LmlzQXJyYXkocmVxdWlyZWQpKSB7XG4gICAgZm9yIChjb25zdCBrZXkgb2YgcmVxdWlyZWQpIHtcbiAgICAgIGlmICh0eXBlb2Yga2V5ID09PSAnc3RyaW5nJyAmJiAhT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHJlY29yZCwga2V5KSkge1xuICAgICAgICBpc3N1ZXMucHVzaCh7IHBhdGg6IFtrZXldLCBtZXNzYWdlOiBgTWlzc2luZyByZXF1aXJlZCBmaWVsZCBcIiR7a2V5fVwiYCwgY29kZTogJ21pc3NpbmdfZmllbGQnIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIENoZWNrIHRvcC1sZXZlbCBwcm9wZXJ0eSB0eXBlc1xuICBjb25zdCBwcm9wZXJ0aWVzID0gc2NoZW1hLnByb3BlcnRpZXM7XG4gIGlmIChwcm9wZXJ0aWVzICYmIHR5cGVvZiBwcm9wZXJ0aWVzID09PSAnb2JqZWN0Jykge1xuICAgIGZvciAoY29uc3QgW2tleSwgcHJvcFNjaGVtYV0gb2YgT2JqZWN0LmVudHJpZXMocHJvcGVydGllcyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcbiAgICAgIGlmICghT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHJlY29yZCwga2V5KSkgY29udGludWU7IC8vIHNraXAgbWlzc2luZyDigJQgcmVxdWlyZWQgY2hlY2sgaGFuZGxlcyB0aGF0XG5cbiAgICAgIGNvbnN0IHZhbHVlID0gcmVjb3JkW2tleV07XG4gICAgICBpZiAocHJvcFNjaGVtYSAmJiB0eXBlb2YgcHJvcFNjaGVtYSA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgY29uc3QgZXhwZWN0ZWRUeXBlID0gKHByb3BTY2hlbWEgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLnR5cGU7XG4gICAgICAgIGlmICh0eXBlb2YgZXhwZWN0ZWRUeXBlID09PSAnc3RyaW5nJyAmJiB2YWx1ZSAhPT0gbnVsbCAmJiB2YWx1ZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgY29uc3QgYWN0dWFsVHlwZSA9IEFycmF5LmlzQXJyYXkodmFsdWUpID8gJ2FycmF5JyA6IHR5cGVvZiB2YWx1ZTtcbiAgICAgICAgICBpZiAoZXhwZWN0ZWRUeXBlICE9PSBhY3R1YWxUeXBlKSB7XG4gICAgICAgICAgICBpc3N1ZXMucHVzaCh7XG4gICAgICAgICAgICAgIHBhdGg6IFtrZXldLFxuICAgICAgICAgICAgICBtZXNzYWdlOiBgRXhwZWN0ZWQgJHtleHBlY3RlZFR5cGV9LCByZWNlaXZlZCAke2FjdHVhbFR5cGV9YCxcbiAgICAgICAgICAgICAgY29kZTogJ2ludmFsaWRfdHlwZScsXG4gICAgICAgICAgICAgIGV4cGVjdGVkOiBleHBlY3RlZFR5cGUsXG4gICAgICAgICAgICAgIHJlY2VpdmVkOiBhY3R1YWxUeXBlLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgaWYgKGlzc3Vlcy5sZW5ndGggPiAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBJbnB1dFZhbGlkYXRpb25FcnJvcihmb3JtYXRJc3N1ZXMoaXNzdWVzKSwgaXNzdWVzKSxcbiAgICB9O1xuICB9XG5cbiAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSwgZGF0YSB9O1xufVxuXG4vLyDilIDilIAgRm9ybWF0dGluZyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuZnVuY3Rpb24gZm9ybWF0SXNzdWVzKGlzc3VlczogVmFsaWRhdGlvbklzc3VlW10pOiBzdHJpbmcge1xuICBpZiAoaXNzdWVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuICdWYWxpZGF0aW9uIGZhaWxlZCc7XG4gIGlmIChpc3N1ZXMubGVuZ3RoID09PSAxKSByZXR1cm4gYElucHV0IHZhbGlkYXRpb24gZmFpbGVkOiAke2lzc3Vlc1swXS5tZXNzYWdlfWA7XG4gIHJldHVybiBgSW5wdXQgdmFsaWRhdGlvbiBmYWlsZWQ6ICR7aXNzdWVzLmxlbmd0aH0gaXNzdWVzIOKAlCAke2lzc3Vlcy5tYXAoKGkpID0+IGkubWVzc2FnZSkuam9pbignOyAnKX1gO1xufVxuIl19