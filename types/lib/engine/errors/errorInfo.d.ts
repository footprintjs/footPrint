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
import type { ValidationIssue } from '../../schema/errors.js';
/** Structured representation of any error caught during stage execution. */
export interface StructuredErrorInfo {
    /** Human-readable error message (always present). */
    message: string;
    /** Error class name when available (e.g. 'InputValidationError', 'TypeError'). */
    name?: string;
    /** Field-level validation issues (present for InputValidationError). */
    issues?: ValidationIssue[];
    /** Machine-readable error code if the error carries one. */
    code?: string;
    /**
     * The original error object, for consumers that need full access.
     * Not safe to serialize directly — may contain circular references,
     * stack traces, or sensitive internals. Use `formatErrorInfo()` for
     * safe string output.
     */
    raw: unknown;
}
/**
 * Extract structured error info from any thrown value.
 *
 * - InputValidationError → preserves .issues array
 * - Standard Error → preserves .name, .message
 * - Non-Error thrown values → coerces to string
 */
export declare function extractErrorInfo(error: unknown): StructuredErrorInfo;
/**
 * Format a StructuredErrorInfo back to a human-readable string.
 * Use this at rendering boundaries (narrative output, log lines).
 * Includes field-level details when issues are present.
 */
export declare function formatErrorInfo(info: StructuredErrorInfo): string;
