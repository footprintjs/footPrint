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
import { InputValidationError } from '../../schema/errors.js';
/**
 * Extract structured error info from any thrown value.
 *
 * - InputValidationError → preserves .issues array
 * - Standard Error → preserves .name, .message
 * - Non-Error thrown values → coerces to string
 */
export function extractErrorInfo(error) {
    if (error instanceof InputValidationError) {
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
/**
 * Format a StructuredErrorInfo back to a human-readable string.
 * Use this at rendering boundaries (narrative output, log lines).
 * Includes field-level details when issues are present.
 */
export function formatErrorInfo(info) {
    if (!info.issues || info.issues.length === 0) {
        return info.message;
    }
    const issueLines = info.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `  - ${path}: ${issue.message}`;
    });
    return `${info.message}\n${issueLines.join('\n')}`;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXJyb3JJbmZvLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9lbmdpbmUvZXJyb3JzL2Vycm9ySW5mby50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7R0FXRztBQUdILE9BQU8sRUFBRSxvQkFBb0IsRUFBRSxNQUFNLHdCQUF3QixDQUFDO0FBcUI5RDs7Ozs7O0dBTUc7QUFDSCxNQUFNLFVBQVUsZ0JBQWdCLENBQUMsS0FBYztJQUM3QyxJQUFJLEtBQUssWUFBWSxvQkFBb0IsRUFBRSxDQUFDO1FBQzFDLE9BQU87WUFDTCxPQUFPLEVBQUUsS0FBSyxDQUFDLE9BQU87WUFDdEIsSUFBSSxFQUFFLEtBQUssQ0FBQyxJQUFJO1lBQ2hCLE1BQU0sRUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQyxFQUFFLEdBQUcsS0FBSyxFQUFFLElBQUksRUFBRSxDQUFDLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztZQUMxRSxJQUFJLEVBQUUsd0JBQXdCO1lBQzlCLEdBQUcsRUFBRSxLQUFLO1NBQ1gsQ0FBQztJQUNKLENBQUM7SUFFRCxJQUFJLEtBQUssWUFBWSxLQUFLLEVBQUUsQ0FBQztRQUMzQixpRkFBaUY7UUFDakYsSUFBSSxDQUFDO1lBQ0gsTUFBTSxJQUFJLEdBQXdCO2dCQUNoQyxPQUFPLEVBQUUsS0FBSyxDQUFDLE9BQU87Z0JBQ3RCLElBQUksRUFBRSxLQUFLLENBQUMsSUFBSTtnQkFDaEIsR0FBRyxFQUFFLEtBQUs7YUFDWCxDQUFDO1lBRUYsa0VBQWtFO1lBQ2xFLElBQUksQ0FBQztnQkFDSCxNQUFNLFNBQVMsR0FBSSxLQUE0QyxDQUFDLElBQUksQ0FBQztnQkFDckUsSUFBSSxPQUFPLFNBQVMsS0FBSyxRQUFRLEVBQUUsQ0FBQztvQkFDbEMsSUFBSSxDQUFDLElBQUksR0FBRyxTQUFTLENBQUM7Z0JBQ3hCLENBQUM7WUFDSCxDQUFDO1lBQUMsV0FBTSxDQUFDO2dCQUNQLG9DQUFvQztZQUN0QyxDQUFDO1lBRUQsT0FBTyxJQUFJLENBQUM7UUFDZCxDQUFDO1FBQUMsV0FBTSxDQUFDO1lBQ1AsbUVBQW1FO1FBQ3JFLENBQUM7SUFDSCxDQUFDO0lBRUQsd0RBQXdEO0lBQ3hELElBQUksQ0FBQztRQUNILE9BQU87WUFDTCxPQUFPLEVBQUUsTUFBTSxDQUFDLEtBQUssQ0FBQztZQUN0QixHQUFHLEVBQUUsS0FBSztTQUNYLENBQUM7SUFDSixDQUFDO0lBQUMsV0FBTSxDQUFDO1FBQ1AscUVBQXFFO1FBQ3JFLE9BQU87WUFDTCxPQUFPLEVBQUUsd0JBQXdCO1lBQ2pDLEdBQUcsRUFBRSxLQUFLO1NBQ1gsQ0FBQztJQUNKLENBQUM7QUFDSCxDQUFDO0FBRUQ7Ozs7R0FJRztBQUNILE1BQU0sVUFBVSxlQUFlLENBQUMsSUFBeUI7SUFDdkQsSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLElBQUksSUFBSSxDQUFDLE1BQU0sQ0FBQyxNQUFNLEtBQUssQ0FBQyxFQUFFLENBQUM7UUFDN0MsT0FBTyxJQUFJLENBQUMsT0FBTyxDQUFDO0lBQ3RCLENBQUM7SUFFRCxNQUFNLFVBQVUsR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFO1FBQzNDLE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQztRQUNyRSxPQUFPLE9BQU8sSUFBSSxLQUFLLEtBQUssQ0FBQyxPQUFPLEVBQUUsQ0FBQztJQUN6QyxDQUFDLENBQUMsQ0FBQztJQUVILE9BQU8sR0FBRyxJQUFJLENBQUMsT0FBTyxLQUFLLFVBQVUsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztBQUNyRCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBlcnJvckluZm8udHMg4oCUIEV4dHJhY3Qgc3RydWN0dXJlZCBpbmZvcm1hdGlvbiBmcm9tIGFueSBlcnJvciB0eXBlLlxuICpcbiAqIFRoZSBlbmdpbmUncyBlcnJvciBjYXRjaCBibG9ja3MgY3VycmVudGx5IGNhbGwgZXJyb3IudG9TdHJpbmcoKSwgZGVzdHJveWluZ1xuICogc3RydWN0dXJlZCBkYXRhIChlLmcuIElucHV0VmFsaWRhdGlvbkVycm9yLmlzc3VlcykuIFRoaXMgbW9kdWxlIHByb3ZpZGVzXG4gKiBhIHNpbmdsZSBleHRyYWN0aW9uIHBvaW50IHRoYXQgcHJlc2VydmVzIHN0cnVjdHVyZWQgZGV0YWlscyB3aGlsZSBzdGlsbFxuICogcHJvZHVjaW5nIGEgaHVtYW4tcmVhZGFibGUgbWVzc2FnZS5cbiAqXG4gKiBDb25zdW1lcnMgKG5hcnJhdGl2ZSByZWNvcmRlcnMsIGV4dHJhY3RvcnMsIGRpYWdub3N0aWMgY29sbGVjdG9ycykgcmVjZWl2ZVxuICogU3RydWN0dXJlZEVycm9ySW5mbyBpbnN0ZWFkIG9mIGEgZmxhdCBzdHJpbmcsIGFuZCBjYW4gZGVjaWRlIGhvdyB0byByZW5kZXIgaXQuXG4gKiBTdHJpbmctaWZpY2F0aW9uIGhhcHBlbnMgb25seSBhdCB0aGUgZmluYWwgcmVuZGVyaW5nIGJvdW5kYXJ5LlxuICovXG5cbmltcG9ydCB0eXBlIHsgVmFsaWRhdGlvbklzc3VlIH0gZnJvbSAnLi4vLi4vc2NoZW1hL2Vycm9ycy5qcyc7XG5pbXBvcnQgeyBJbnB1dFZhbGlkYXRpb25FcnJvciB9IGZyb20gJy4uLy4uL3NjaGVtYS9lcnJvcnMuanMnO1xuXG4vKiogU3RydWN0dXJlZCByZXByZXNlbnRhdGlvbiBvZiBhbnkgZXJyb3IgY2F1Z2h0IGR1cmluZyBzdGFnZSBleGVjdXRpb24uICovXG5leHBvcnQgaW50ZXJmYWNlIFN0cnVjdHVyZWRFcnJvckluZm8ge1xuICAvKiogSHVtYW4tcmVhZGFibGUgZXJyb3IgbWVzc2FnZSAoYWx3YXlzIHByZXNlbnQpLiAqL1xuICBtZXNzYWdlOiBzdHJpbmc7XG4gIC8qKiBFcnJvciBjbGFzcyBuYW1lIHdoZW4gYXZhaWxhYmxlIChlLmcuICdJbnB1dFZhbGlkYXRpb25FcnJvcicsICdUeXBlRXJyb3InKS4gKi9cbiAgbmFtZT86IHN0cmluZztcbiAgLyoqIEZpZWxkLWxldmVsIHZhbGlkYXRpb24gaXNzdWVzIChwcmVzZW50IGZvciBJbnB1dFZhbGlkYXRpb25FcnJvcikuICovXG4gIGlzc3Vlcz86IFZhbGlkYXRpb25Jc3N1ZVtdO1xuICAvKiogTWFjaGluZS1yZWFkYWJsZSBlcnJvciBjb2RlIGlmIHRoZSBlcnJvciBjYXJyaWVzIG9uZS4gKi9cbiAgY29kZT86IHN0cmluZztcbiAgLyoqXG4gICAqIFRoZSBvcmlnaW5hbCBlcnJvciBvYmplY3QsIGZvciBjb25zdW1lcnMgdGhhdCBuZWVkIGZ1bGwgYWNjZXNzLlxuICAgKiBOb3Qgc2FmZSB0byBzZXJpYWxpemUgZGlyZWN0bHkg4oCUIG1heSBjb250YWluIGNpcmN1bGFyIHJlZmVyZW5jZXMsXG4gICAqIHN0YWNrIHRyYWNlcywgb3Igc2Vuc2l0aXZlIGludGVybmFscy4gVXNlIGBmb3JtYXRFcnJvckluZm8oKWAgZm9yXG4gICAqIHNhZmUgc3RyaW5nIG91dHB1dC5cbiAgICovXG4gIHJhdzogdW5rbm93bjtcbn1cblxuLyoqXG4gKiBFeHRyYWN0IHN0cnVjdHVyZWQgZXJyb3IgaW5mbyBmcm9tIGFueSB0aHJvd24gdmFsdWUuXG4gKlxuICogLSBJbnB1dFZhbGlkYXRpb25FcnJvciDihpIgcHJlc2VydmVzIC5pc3N1ZXMgYXJyYXlcbiAqIC0gU3RhbmRhcmQgRXJyb3Ig4oaSIHByZXNlcnZlcyAubmFtZSwgLm1lc3NhZ2VcbiAqIC0gTm9uLUVycm9yIHRocm93biB2YWx1ZXMg4oaSIGNvZXJjZXMgdG8gc3RyaW5nXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0RXJyb3JJbmZvKGVycm9yOiB1bmtub3duKTogU3RydWN0dXJlZEVycm9ySW5mbyB7XG4gIGlmIChlcnJvciBpbnN0YW5jZW9mIElucHV0VmFsaWRhdGlvbkVycm9yKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG1lc3NhZ2U6IGVycm9yLm1lc3NhZ2UsXG4gICAgICBuYW1lOiBlcnJvci5uYW1lLFxuICAgICAgaXNzdWVzOiBlcnJvci5pc3N1ZXMubWFwKChpc3N1ZSkgPT4gKHsgLi4uaXNzdWUsIHBhdGg6IFsuLi5pc3N1ZS5wYXRoXSB9KSksXG4gICAgICBjb2RlOiAnSU5QVVRfVkFMSURBVElPTl9FUlJPUicsXG4gICAgICByYXc6IGVycm9yLFxuICAgIH07XG4gIH1cblxuICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBFcnJvcikge1xuICAgIC8vIEd1YXJkIGFnYWluc3QgYWR2ZXJzYXJpYWwgZXJyb3JzIHdpdGggdGhyb3dpbmcgZ2V0dGVycyBvbiAubWVzc2FnZS8ubmFtZS8uY29kZVxuICAgIHRyeSB7XG4gICAgICBjb25zdCBpbmZvOiBTdHJ1Y3R1cmVkRXJyb3JJbmZvID0ge1xuICAgICAgICBtZXNzYWdlOiBlcnJvci5tZXNzYWdlLFxuICAgICAgICBuYW1lOiBlcnJvci5uYW1lLFxuICAgICAgICByYXc6IGVycm9yLFxuICAgICAgfTtcblxuICAgICAgLy8gUHJlc2VydmUgLmNvZGUgaWYgcHJlc2VudCAoY29tbW9uIE5vZGUuanMgcGF0dGVybiwgZS5nLiBFTk9FTlQpXG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBtYXliZUNvZGUgPSAoZXJyb3IgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikuY29kZTtcbiAgICAgICAgaWYgKHR5cGVvZiBtYXliZUNvZGUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgaW5mby5jb2RlID0gbWF5YmVDb2RlO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogLmNvZGUgYWNjZXNzb3IgdGhyZXcg4oCUIHNraXAgaXQgKi9cbiAgICAgIH1cblxuICAgICAgcmV0dXJuIGluZm87XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyAubWVzc2FnZSBvciAubmFtZSBnZXR0ZXIgdGhyZXcg4oCUIGZhbGwgdGhyb3VnaCB0byBzdHJpbmcgY29lcmNpb25cbiAgICB9XG4gIH1cblxuICAvLyBOb24tRXJyb3IgdGhyb3duIHZhbHVlIChzdHJpbmcsIG51bWJlciwgb2JqZWN0LCBldGMuKVxuICB0cnkge1xuICAgIHJldHVybiB7XG4gICAgICBtZXNzYWdlOiBTdHJpbmcoZXJyb3IpLFxuICAgICAgcmF3OiBlcnJvcixcbiAgICB9O1xuICB9IGNhdGNoIHtcbiAgICAvLyBTdHJpbmcoKSBmYWlsZWQgKGUuZy4gbnVsbC1wcm90b3R5cGUgb2JqZWN0LCB0aHJvd2luZyAudG9TdHJpbmcoKSlcbiAgICByZXR1cm4ge1xuICAgICAgbWVzc2FnZTogJ1t1bnNlcmlhbGl6YWJsZSBlcnJvcl0nLFxuICAgICAgcmF3OiBlcnJvcixcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogRm9ybWF0IGEgU3RydWN0dXJlZEVycm9ySW5mbyBiYWNrIHRvIGEgaHVtYW4tcmVhZGFibGUgc3RyaW5nLlxuICogVXNlIHRoaXMgYXQgcmVuZGVyaW5nIGJvdW5kYXJpZXMgKG5hcnJhdGl2ZSBvdXRwdXQsIGxvZyBsaW5lcykuXG4gKiBJbmNsdWRlcyBmaWVsZC1sZXZlbCBkZXRhaWxzIHdoZW4gaXNzdWVzIGFyZSBwcmVzZW50LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0RXJyb3JJbmZvKGluZm86IFN0cnVjdHVyZWRFcnJvckluZm8pOiBzdHJpbmcge1xuICBpZiAoIWluZm8uaXNzdWVzIHx8IGluZm8uaXNzdWVzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiBpbmZvLm1lc3NhZ2U7XG4gIH1cblxuICBjb25zdCBpc3N1ZUxpbmVzID0gaW5mby5pc3N1ZXMubWFwKChpc3N1ZSkgPT4ge1xuICAgIGNvbnN0IHBhdGggPSBpc3N1ZS5wYXRoLmxlbmd0aCA+IDAgPyBpc3N1ZS5wYXRoLmpvaW4oJy4nKSA6ICcocm9vdCknO1xuICAgIHJldHVybiBgICAtICR7cGF0aH06ICR7aXNzdWUubWVzc2FnZX1gO1xuICB9KTtcblxuICByZXR1cm4gYCR7aW5mby5tZXNzYWdlfVxcbiR7aXNzdWVMaW5lcy5qb2luKCdcXG4nKX1gO1xufVxuIl19