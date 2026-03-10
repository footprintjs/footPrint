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

import { detectSchema } from './detect';
import { type ValidationIssue, extractIssuesFromZodError, InputValidationError } from './errors';

/** Successful validation result — may contain transformed data. */
export type ValidationSuccess = { success: true; data: unknown };
/** Failed validation result — carries structured issues. */
export type ValidationFailure = { success: false; error: InputValidationError };
/** Union result type. */
export type ValidationResult = ValidationSuccess | ValidationFailure;

/**
 * Validate data against a schema. Returns a result — does not throw.
 *
 * For throwing behavior, use `validateOrThrow()`.
 */
export function validateAgainstSchema(schema: unknown, data: unknown): ValidationResult {
  const kind = detectSchema(schema);

  switch (kind) {
    case 'zod':
    case 'parseable':
      return validateParseable(schema as Record<string, unknown>, data);
    case 'json-schema':
      return validateJsonSchema(schema as Record<string, unknown>, data);
    case 'none':
      return { success: true, data };
  }
}

/**
 * Validate data against a schema. Throws InputValidationError on failure.
 */
export function validateOrThrow(schema: unknown, data: unknown): unknown {
  const result = validateAgainstSchema(schema, data);
  if (!result.success) throw result.error;
  return result.data;
}

// ── Parseable (Zod, yup, superstruct, etc.) ──────────────────────────────

function validateParseable(schema: Record<string, unknown>, data: unknown): ValidationResult {
  // Prefer safeParse (non-throwing)
  if (typeof schema.safeParse === 'function') {
    try {
      const result = (schema.safeParse as (v: unknown) => Record<string, unknown>)(data);
      if (result.success) {
        return { success: true, data: result.data ?? data };
      }
      const issues = extractIssuesFromZodError(result.error);
      const message = formatIssues(issues);
      return {
        success: false,
        error: new InputValidationError(message, issues, result.error),
      };
    } catch {
      // safeParse threw (binding error, etc.) — fall through to parse
    }
  }

  // Fallback to parse (throwing)
  if (typeof schema.parse === 'function') {
    try {
      const parsed = (schema.parse as (v: unknown) => unknown)(data);
      return { success: true, data: parsed ?? data };
    } catch (err) {
      const issues = extractIssuesFromZodError(err);
      if (issues.length > 0) {
        return {
          success: false,
          error: new InputValidationError(formatIssues(issues), issues, err),
        };
      }
      // Non-Zod error from parse()
      const rawMessage = err instanceof Error ? err.message : 'Validation failed';
      const fallbackIssues: ValidationIssue[] = [{ path: [], message: rawMessage }];
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

function validateJsonSchema(schema: Record<string, unknown>, data: unknown): ValidationResult {
  if (!data || typeof data !== 'object') {
    return {
      success: false,
      error: new InputValidationError('Expected an object', [
        { path: [], message: 'Expected an object', code: 'invalid_type', expected: 'object' },
      ]),
    };
  }

  const record = data as Record<string, unknown>;
  const issues: ValidationIssue[] = [];

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
    for (const [key, propSchema] of Object.entries(properties as Record<string, unknown>)) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue; // skip missing — required check handles that

      const value = record[key];
      if (propSchema && typeof propSchema === 'object') {
        const expectedType = (propSchema as Record<string, unknown>).type;
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

function formatIssues(issues: ValidationIssue[]): string {
  if (issues.length === 0) return 'Validation failed';
  if (issues.length === 1) return `Input validation failed: ${issues[0].message}`;
  return `Input validation failed: ${issues.length} issues — ${issues.map((i) => i.message).join('; ')}`;
}
