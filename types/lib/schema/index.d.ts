/**
 * schema/ — Unified schema detection and validation library.
 *
 * Single source of truth for:
 * - Detecting schema kind (Zod, parseable, JSON Schema)
 * - Validating data against any schema
 * - Structured validation errors with field-level details
 */
export type { SchemaKind } from './detect.js';
export { detectSchema, isValidatable, isZod } from './detect.js';
export type { ValidationIssue } from './errors.js';
export { extractIssuesFromZodError, InputValidationError } from './errors.js';
export type { ValidationFailure, ValidationResult, ValidationSuccess } from './validate.js';
export { validateAgainstSchema, validateOrThrow } from './validate.js';
