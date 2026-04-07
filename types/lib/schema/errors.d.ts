/**
 * errors.ts — Structured validation errors for the schema library.
 *
 * InputValidationError preserves field-level details from Zod (or any schema)
 * while providing a human-readable .message summary. Consumers can:
 * - Catch and read .message for logging
 * - Iterate .issues for field-level API responses / form errors
 * - Access .cause for the raw original error (Zod error, etc.)
 */
/** A single validation issue — one field, one problem. */
export interface ValidationIssue {
    /** Dot-path to the field (e.g. ['address', 'zip'] or ['amount']). */
    path: (string | number)[];
    /** Human-readable description of the problem. */
    message: string;
    /** Machine-readable error code (e.g. 'invalid_type', 'too_small'). */
    code?: string;
    /** What was expected (e.g. 'number'). */
    expected?: string;
    /** What was received (e.g. 'string'). */
    received?: string;
}
/**
 * Thrown when runtime input fails schema validation.
 * Extends Error for compatibility, but carries structured .issues.
 */
export declare class InputValidationError extends Error {
    readonly issues: ValidationIssue[];
    readonly cause?: unknown;
    constructor(message: string, issues: ValidationIssue[], cause?: unknown);
}
/**
 * Extract ValidationIssues from a Zod error (duck-typed — no Zod import).
 * Works with both ZodError.issues (v3/v4) and ZodError.errors (v3 legacy).
 */
export declare function extractIssuesFromZodError(zodError: unknown): ValidationIssue[];
