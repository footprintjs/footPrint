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
import { InputValidationError } from './errors.js';
/** Successful validation result — may contain transformed data. */
export type ValidationSuccess = {
    success: true;
    data: unknown;
};
/** Failed validation result — carries structured issues. */
export type ValidationFailure = {
    success: false;
    error: InputValidationError;
};
/** Union result type. */
export type ValidationResult = ValidationSuccess | ValidationFailure;
/**
 * Validate data against a schema. Returns a result — does not throw.
 *
 * For throwing behavior, use `validateOrThrow()`.
 */
export declare function validateAgainstSchema(schema: unknown, data: unknown): ValidationResult;
/**
 * Validate data against a schema. Throws InputValidationError on failure.
 */
export declare function validateOrThrow(schema: unknown, data: unknown): unknown;
