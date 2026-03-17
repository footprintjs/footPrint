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
import { InputValidationError } from '../../schema/errors.js';

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
export function extractErrorInfo(error: unknown): StructuredErrorInfo {
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
      const info: StructuredErrorInfo = {
        message: error.message,
        name: error.name,
        raw: error,
      };

      // Preserve .code if present (common Node.js pattern, e.g. ENOENT)
      try {
        const maybeCode = (error as unknown as Record<string, unknown>).code;
        if (typeof maybeCode === 'string') {
          info.code = maybeCode;
        }
      } catch {
        /* .code accessor threw — skip it */
      }

      return info;
    } catch {
      // .message or .name getter threw — fall through to string coercion
    }
  }

  // Non-Error thrown value (string, number, object, etc.)
  try {
    return {
      message: String(error),
      raw: error,
    };
  } catch {
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
export function formatErrorInfo(info: StructuredErrorInfo): string {
  if (!info.issues || info.issues.length === 0) {
    return info.message;
  }

  const issueLines = info.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  - ${path}: ${issue.message}`;
  });

  return `${info.message}\n${issueLines.join('\n')}`;
}
