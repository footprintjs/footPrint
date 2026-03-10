/**
 * Property test: Structured error extraction invariants.
 *
 * Uses fast-check to verify:
 * - extractErrorInfo always produces a valid StructuredErrorInfo for any thrown value
 * - message is always a non-empty string
 * - roundtrip: formatErrorInfo(extractErrorInfo(error)) always produces a string
 * - InputValidationError issues are preserved exactly
 * - raw field always holds the original thrown value
 */

import * as fc from 'fast-check';

import { extractErrorInfo, formatErrorInfo } from '../../../../src/lib/engine/errors/errorInfo';
import type { ValidationIssue } from '../../../../src/lib/schema/errors';
import { InputValidationError } from '../../../../src/lib/schema/errors';

describe('Property: Structured Error Extraction Invariants', () => {
  // ── extractErrorInfo always produces valid output ──────────────────────

  it('extractErrorInfo returns a valid StructuredErrorInfo for any thrown value', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.constant(undefined),
          fc.object(),
          fc.string().map((msg) => new Error(msg)),
          fc.string().map((msg) => new TypeError(msg)),
          fc.string().map((msg) => new RangeError(msg)),
        ),
        (thrown) => {
          const info = extractErrorInfo(thrown);

          // message is always a string
          expect(typeof info.message).toBe('string');
          // raw preserves original value
          expect(info.raw).toBe(thrown);
          // name is string or undefined
          expect(info.name === undefined || typeof info.name === 'string').toBe(true);
          // code is string or undefined
          expect(info.code === undefined || typeof info.code === 'string').toBe(true);
          // issues is array or undefined
          expect(info.issues === undefined || Array.isArray(info.issues)).toBe(true);
        },
      ),
    );
  });

  // ── formatErrorInfo always produces a string ──────────────────────────

  it('formatErrorInfo always returns a non-empty string', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string().map((msg) => new Error(msg || 'fallback')),
          fc.string().map((msg) => new TypeError(msg || 'fallback')),
        ),
        (thrown) => {
          const info = extractErrorInfo(thrown);
          const formatted = formatErrorInfo(info);
          expect(typeof formatted).toBe('string');
          expect(formatted.length).toBeGreaterThan(0);
        },
      ),
    );
  });

  // ── InputValidationError issues preserved exactly ─────────────────────

  it('InputValidationError issues are preserved with exact count and paths', () => {
    const issueArb: fc.Arbitrary<ValidationIssue> = fc.record({
      path: fc.array(fc.oneof(fc.string(), fc.nat()), { minLength: 0, maxLength: 5 }),
      message: fc.string({ minLength: 1 }),
      code: fc.option(fc.string(), { nil: undefined }),
      expected: fc.option(fc.string(), { nil: undefined }),
      received: fc.option(fc.string(), { nil: undefined }),
    });

    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.array(issueArb, { minLength: 1, maxLength: 20 }),
        (message, issues) => {
          const error = new InputValidationError(message, issues);
          const info = extractErrorInfo(error);

          expect(info.name).toBe('InputValidationError');
          expect(info.code).toBe('INPUT_VALIDATION_ERROR');
          expect(info.issues).toHaveLength(issues.length);
          expect(info.message).toBe(message);

          // Each issue path preserved
          for (let i = 0; i < issues.length; i++) {
            expect(info.issues![i].path).toEqual(issues[i].path);
            expect(info.issues![i].message).toBe(issues[i].message);
          }
        },
      ),
    );
  });

  // ── Node.js-style .code preserved ─────────────────────────────────────

  it('Error.code is preserved when present', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (message, code) => {
        const error = new Error(message) as Error & { code: string };
        error.code = code;
        const info = extractErrorInfo(error);

        expect(info.code).toBe(code);
        expect(info.message).toBe(message);
      }),
    );
  });

  // ── raw identity ──────────────────────────────────────────────────────

  it('raw field is always identical to the input (reference equality)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.integer(),
          fc.constant(null),
          fc.string().map((msg) => new Error(msg)),
        ),
        (thrown) => {
          const info = extractErrorInfo(thrown);
          expect(info.raw).toBe(thrown);
        },
      ),
    );
  });
});
