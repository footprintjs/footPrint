/**
 * schema/ — Unified schema detection and validation library.
 *
 * Single source of truth for:
 * - Detecting schema kind (Zod, parseable, JSON Schema)
 * - Validating data against any schema
 * - Structured validation errors with field-level details
 */

export type { SchemaKind } from './detect';
export { detectSchema, isValidatable, isZod } from './detect';
export type { ValidationIssue } from './errors';
export { extractIssuesFromZodError, InputValidationError } from './errors';
export type { ValidationFailure, ValidationResult, ValidationSuccess } from './validate';
export { validateAgainstSchema, validateOrThrow } from './validate';
