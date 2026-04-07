"use strict";
/**
 * errorInfo.ts — Extract structured information from any error type.
 *
 * The engine's error catch blocks currently call error.toString(), destroying
 * structured data (e.g. InputValidationError.issues). This module provides
 * a single extraction point that preserves structured details while still
 * producing a human-readable message.
 *
 * Consumers (narrative recorders, extractors, diagnostic collectors) receive
 * StructuredErrorInfo instead of a flat string, and can decide how to render it.
 * String-ification happens only at the final rendering boundary.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatErrorInfo = exports.extractErrorInfo = void 0;
const errors_js_1 = require("../../schema/errors.js");
/**
 * Extract structured error info from any thrown value.
 *
 * - InputValidationError → preserves .issues array
 * - Standard Error → preserves .name, .message
 * - Non-Error thrown values → coerces to string
 */
function extractErrorInfo(error) {
    if (error instanceof errors_js_1.InputValidationError) {
        return {
            message: error.message,
            name: error.name,
            issues: error.issues.map((issue) => ({ ...issue, path: [...issue.path] })),
            code: 'INPUT_VALIDATION_ERROR',
            raw: error,
        };
    }
    if (error instanceof Error) {
        // Guard against adversarial errors with throwing getters on .message/.name/.code
        try {
            const info = {
                message: error.message,
                name: error.name,
                raw: error,
            };
            // Preserve .code if present (common Node.js pattern, e.g. ENOENT)
            try {
                const maybeCode = error.code;
                if (typeof maybeCode === 'string') {
                    info.code = maybeCode;
                }
            }
            catch (_a) {
                /* .code accessor threw — skip it */
            }
            return info;
        }
        catch (_b) {
            // .message or .name getter threw — fall through to string coercion
        }
    }
    // Non-Error thrown value (string, number, object, etc.)
    try {
        return {
            message: String(error),
            raw: error,
        };
    }
    catch (_c) {
        // String() failed (e.g. null-prototype object, throwing .toString())
        return {
            message: '[unserializable error]',
            raw: error,
        };
    }
}
exports.extractErrorInfo = extractErrorInfo;
/**
 * Format a StructuredErrorInfo back to a human-readable string.
 * Use this at rendering boundaries (narrative output, log lines).
 * Includes field-level details when issues are present.
 */
function formatErrorInfo(info) {
    if (!info.issues || info.issues.length === 0) {
        return info.message;
    }
    const issueLines = info.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `  - ${path}: ${issue.message}`;
    });
    return `${info.message}\n${issueLines.join('\n')}`;
}
exports.formatErrorInfo = formatErrorInfo;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXJyb3JJbmZvLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9lbmdpbmUvZXJyb3JzL2Vycm9ySW5mby50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7Ozs7Ozs7O0dBV0c7OztBQUdILHNEQUE4RDtBQXFCOUQ7Ozs7OztHQU1HO0FBQ0gsU0FBZ0IsZ0JBQWdCLENBQUMsS0FBYztJQUM3QyxJQUFJLEtBQUssWUFBWSxnQ0FBb0IsRUFBRSxDQUFDO1FBQzFDLE9BQU87WUFDTCxPQUFPLEVBQUUsS0FBSyxDQUFDLE9BQU87WUFDdEIsSUFBSSxFQUFFLEtBQUssQ0FBQyxJQUFJO1lBQ2hCLE1BQU0sRUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQyxFQUFFLEdBQUcsS0FBSyxFQUFFLElBQUksRUFBRSxDQUFDLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztZQUMxRSxJQUFJLEVBQUUsd0JBQXdCO1lBQzlCLEdBQUcsRUFBRSxLQUFLO1NBQ1gsQ0FBQztJQUNKLENBQUM7SUFFRCxJQUFJLEtBQUssWUFBWSxLQUFLLEVBQUUsQ0FBQztRQUMzQixpRkFBaUY7UUFDakYsSUFBSSxDQUFDO1lBQ0gsTUFBTSxJQUFJLEdBQXdCO2dCQUNoQyxPQUFPLEVBQUUsS0FBSyxDQUFDLE9BQU87Z0JBQ3RCLElBQUksRUFBRSxLQUFLLENBQUMsSUFBSTtnQkFDaEIsR0FBRyxFQUFFLEtBQUs7YUFDWCxDQUFDO1lBRUYsa0VBQWtFO1lBQ2xFLElBQUksQ0FBQztnQkFDSCxNQUFNLFNBQVMsR0FBSSxLQUE0QyxDQUFDLElBQUksQ0FBQztnQkFDckUsSUFBSSxPQUFPLFNBQVMsS0FBSyxRQUFRLEVBQUUsQ0FBQztvQkFDbEMsSUFBSSxDQUFDLElBQUksR0FBRyxTQUFTLENBQUM7Z0JBQ3hCLENBQUM7WUFDSCxDQUFDO1lBQUMsV0FBTSxDQUFDO2dCQUNQLG9DQUFvQztZQUN0QyxDQUFDO1lBRUQsT0FBTyxJQUFJLENBQUM7UUFDZCxDQUFDO1FBQUMsV0FBTSxDQUFDO1lBQ1AsbUVBQW1FO1FBQ3JFLENBQUM7SUFDSCxDQUFDO0lBRUQsd0RBQXdEO0lBQ3hELElBQUksQ0FBQztRQUNILE9BQU87WUFDTCxPQUFPLEVBQUUsTUFBTSxDQUFDLEtBQUssQ0FBQztZQUN0QixHQUFHLEVBQUUsS0FBSztTQUNYLENBQUM7SUFDSixDQUFDO0lBQUMsV0FBTSxDQUFDO1FBQ1AscUVBQXFFO1FBQ3JFLE9BQU87WUFDTCxPQUFPLEVBQUUsd0JBQXdCO1lBQ2pDLEdBQUcsRUFBRSxLQUFLO1NBQ1gsQ0FBQztJQUNKLENBQUM7QUFDSCxDQUFDO0FBakRELDRDQWlEQztBQUVEOzs7O0dBSUc7QUFDSCxTQUFnQixlQUFlLENBQUMsSUFBeUI7SUFDdkQsSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLElBQUksSUFBSSxDQUFDLE1BQU0sQ0FBQyxNQUFNLEtBQUssQ0FBQyxFQUFFLENBQUM7UUFDN0MsT0FBTyxJQUFJLENBQUMsT0FBTyxDQUFDO0lBQ3RCLENBQUM7SUFFRCxNQUFNLFVBQVUsR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFO1FBQzNDLE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQztRQUNyRSxPQUFPLE9BQU8sSUFBSSxLQUFLLEtBQUssQ0FBQyxPQUFPLEVBQUUsQ0FBQztJQUN6QyxDQUFDLENBQUMsQ0FBQztJQUVILE9BQU8sR0FBRyxJQUFJLENBQUMsT0FBTyxLQUFLLFVBQVUsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztBQUNyRCxDQUFDO0FBWEQsMENBV0MiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIGVycm9ySW5mby50cyDigJQgRXh0cmFjdCBzdHJ1Y3R1cmVkIGluZm9ybWF0aW9uIGZyb20gYW55IGVycm9yIHR5cGUuXG4gKlxuICogVGhlIGVuZ2luZSdzIGVycm9yIGNhdGNoIGJsb2NrcyBjdXJyZW50bHkgY2FsbCBlcnJvci50b1N0cmluZygpLCBkZXN0cm95aW5nXG4gKiBzdHJ1Y3R1cmVkIGRhdGEgKGUuZy4gSW5wdXRWYWxpZGF0aW9uRXJyb3IuaXNzdWVzKS4gVGhpcyBtb2R1bGUgcHJvdmlkZXNcbiAqIGEgc2luZ2xlIGV4dHJhY3Rpb24gcG9pbnQgdGhhdCBwcmVzZXJ2ZXMgc3RydWN0dXJlZCBkZXRhaWxzIHdoaWxlIHN0aWxsXG4gKiBwcm9kdWNpbmcgYSBodW1hbi1yZWFkYWJsZSBtZXNzYWdlLlxuICpcbiAqIENvbnN1bWVycyAobmFycmF0aXZlIHJlY29yZGVycywgZXh0cmFjdG9ycywgZGlhZ25vc3RpYyBjb2xsZWN0b3JzKSByZWNlaXZlXG4gKiBTdHJ1Y3R1cmVkRXJyb3JJbmZvIGluc3RlYWQgb2YgYSBmbGF0IHN0cmluZywgYW5kIGNhbiBkZWNpZGUgaG93IHRvIHJlbmRlciBpdC5cbiAqIFN0cmluZy1pZmljYXRpb24gaGFwcGVucyBvbmx5IGF0IHRoZSBmaW5hbCByZW5kZXJpbmcgYm91bmRhcnkuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBWYWxpZGF0aW9uSXNzdWUgfSBmcm9tICcuLi8uLi9zY2hlbWEvZXJyb3JzLmpzJztcbmltcG9ydCB7IElucHV0VmFsaWRhdGlvbkVycm9yIH0gZnJvbSAnLi4vLi4vc2NoZW1hL2Vycm9ycy5qcyc7XG5cbi8qKiBTdHJ1Y3R1cmVkIHJlcHJlc2VudGF0aW9uIG9mIGFueSBlcnJvciBjYXVnaHQgZHVyaW5nIHN0YWdlIGV4ZWN1dGlvbi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgU3RydWN0dXJlZEVycm9ySW5mbyB7XG4gIC8qKiBIdW1hbi1yZWFkYWJsZSBlcnJvciBtZXNzYWdlIChhbHdheXMgcHJlc2VudCkuICovXG4gIG1lc3NhZ2U6IHN0cmluZztcbiAgLyoqIEVycm9yIGNsYXNzIG5hbWUgd2hlbiBhdmFpbGFibGUgKGUuZy4gJ0lucHV0VmFsaWRhdGlvbkVycm9yJywgJ1R5cGVFcnJvcicpLiAqL1xuICBuYW1lPzogc3RyaW5nO1xuICAvKiogRmllbGQtbGV2ZWwgdmFsaWRhdGlvbiBpc3N1ZXMgKHByZXNlbnQgZm9yIElucHV0VmFsaWRhdGlvbkVycm9yKS4gKi9cbiAgaXNzdWVzPzogVmFsaWRhdGlvbklzc3VlW107XG4gIC8qKiBNYWNoaW5lLXJlYWRhYmxlIGVycm9yIGNvZGUgaWYgdGhlIGVycm9yIGNhcnJpZXMgb25lLiAqL1xuICBjb2RlPzogc3RyaW5nO1xuICAvKipcbiAgICogVGhlIG9yaWdpbmFsIGVycm9yIG9iamVjdCwgZm9yIGNvbnN1bWVycyB0aGF0IG5lZWQgZnVsbCBhY2Nlc3MuXG4gICAqIE5vdCBzYWZlIHRvIHNlcmlhbGl6ZSBkaXJlY3RseSDigJQgbWF5IGNvbnRhaW4gY2lyY3VsYXIgcmVmZXJlbmNlcyxcbiAgICogc3RhY2sgdHJhY2VzLCBvciBzZW5zaXRpdmUgaW50ZXJuYWxzLiBVc2UgYGZvcm1hdEVycm9ySW5mbygpYCBmb3JcbiAgICogc2FmZSBzdHJpbmcgb3V0cHV0LlxuICAgKi9cbiAgcmF3OiB1bmtub3duO1xufVxuXG4vKipcbiAqIEV4dHJhY3Qgc3RydWN0dXJlZCBlcnJvciBpbmZvIGZyb20gYW55IHRocm93biB2YWx1ZS5cbiAqXG4gKiAtIElucHV0VmFsaWRhdGlvbkVycm9yIOKGkiBwcmVzZXJ2ZXMgLmlzc3VlcyBhcnJheVxuICogLSBTdGFuZGFyZCBFcnJvciDihpIgcHJlc2VydmVzIC5uYW1lLCAubWVzc2FnZVxuICogLSBOb24tRXJyb3IgdGhyb3duIHZhbHVlcyDihpIgY29lcmNlcyB0byBzdHJpbmdcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RFcnJvckluZm8oZXJyb3I6IHVua25vd24pOiBTdHJ1Y3R1cmVkRXJyb3JJbmZvIHtcbiAgaWYgKGVycm9yIGluc3RhbmNlb2YgSW5wdXRWYWxpZGF0aW9uRXJyb3IpIHtcbiAgICByZXR1cm4ge1xuICAgICAgbWVzc2FnZTogZXJyb3IubWVzc2FnZSxcbiAgICAgIG5hbWU6IGVycm9yLm5hbWUsXG4gICAgICBpc3N1ZXM6IGVycm9yLmlzc3Vlcy5tYXAoKGlzc3VlKSA9PiAoeyAuLi5pc3N1ZSwgcGF0aDogWy4uLmlzc3VlLnBhdGhdIH0pKSxcbiAgICAgIGNvZGU6ICdJTlBVVF9WQUxJREFUSU9OX0VSUk9SJyxcbiAgICAgIHJhdzogZXJyb3IsXG4gICAgfTtcbiAgfVxuXG4gIGlmIChlcnJvciBpbnN0YW5jZW9mIEVycm9yKSB7XG4gICAgLy8gR3VhcmQgYWdhaW5zdCBhZHZlcnNhcmlhbCBlcnJvcnMgd2l0aCB0aHJvd2luZyBnZXR0ZXJzIG9uIC5tZXNzYWdlLy5uYW1lLy5jb2RlXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGluZm86IFN0cnVjdHVyZWRFcnJvckluZm8gPSB7XG4gICAgICAgIG1lc3NhZ2U6IGVycm9yLm1lc3NhZ2UsXG4gICAgICAgIG5hbWU6IGVycm9yLm5hbWUsXG4gICAgICAgIHJhdzogZXJyb3IsXG4gICAgICB9O1xuXG4gICAgICAvLyBQcmVzZXJ2ZSAuY29kZSBpZiBwcmVzZW50IChjb21tb24gTm9kZS5qcyBwYXR0ZXJuLCBlLmcuIEVOT0VOVClcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IG1heWJlQ29kZSA9IChlcnJvciBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KS5jb2RlO1xuICAgICAgICBpZiAodHlwZW9mIG1heWJlQ29kZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICBpbmZvLmNvZGUgPSBtYXliZUNvZGU7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiAuY29kZSBhY2Nlc3NvciB0aHJldyDigJQgc2tpcCBpdCAqL1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gaW5mbztcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIC5tZXNzYWdlIG9yIC5uYW1lIGdldHRlciB0aHJldyDigJQgZmFsbCB0aHJvdWdoIHRvIHN0cmluZyBjb2VyY2lvblxuICAgIH1cbiAgfVxuXG4gIC8vIE5vbi1FcnJvciB0aHJvd24gdmFsdWUgKHN0cmluZywgbnVtYmVyLCBvYmplY3QsIGV0Yy4pXG4gIHRyeSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG1lc3NhZ2U6IFN0cmluZyhlcnJvciksXG4gICAgICByYXc6IGVycm9yLFxuICAgIH07XG4gIH0gY2F0Y2gge1xuICAgIC8vIFN0cmluZygpIGZhaWxlZCAoZS5nLiBudWxsLXByb3RvdHlwZSBvYmplY3QsIHRocm93aW5nIC50b1N0cmluZygpKVxuICAgIHJldHVybiB7XG4gICAgICBtZXNzYWdlOiAnW3Vuc2VyaWFsaXphYmxlIGVycm9yXScsXG4gICAgICByYXc6IGVycm9yLFxuICAgIH07XG4gIH1cbn1cblxuLyoqXG4gKiBGb3JtYXQgYSBTdHJ1Y3R1cmVkRXJyb3JJbmZvIGJhY2sgdG8gYSBodW1hbi1yZWFkYWJsZSBzdHJpbmcuXG4gKiBVc2UgdGhpcyBhdCByZW5kZXJpbmcgYm91bmRhcmllcyAobmFycmF0aXZlIG91dHB1dCwgbG9nIGxpbmVzKS5cbiAqIEluY2x1ZGVzIGZpZWxkLWxldmVsIGRldGFpbHMgd2hlbiBpc3N1ZXMgYXJlIHByZXNlbnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRFcnJvckluZm8oaW5mbzogU3RydWN0dXJlZEVycm9ySW5mbyk6IHN0cmluZyB7XG4gIGlmICghaW5mby5pc3N1ZXMgfHwgaW5mby5pc3N1ZXMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIGluZm8ubWVzc2FnZTtcbiAgfVxuXG4gIGNvbnN0IGlzc3VlTGluZXMgPSBpbmZvLmlzc3Vlcy5tYXAoKGlzc3VlKSA9PiB7XG4gICAgY29uc3QgcGF0aCA9IGlzc3VlLnBhdGgubGVuZ3RoID4gMCA/IGlzc3VlLnBhdGguam9pbignLicpIDogJyhyb290KSc7XG4gICAgcmV0dXJuIGAgIC0gJHtwYXRofTogJHtpc3N1ZS5tZXNzYWdlfWA7XG4gIH0pO1xuXG4gIHJldHVybiBgJHtpbmZvLm1lc3NhZ2V9XFxuJHtpc3N1ZUxpbmVzLmpvaW4oJ1xcbicpfWA7XG59XG4iXX0=