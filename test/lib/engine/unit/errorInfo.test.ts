/**
 * Unit tests for errorInfo.ts — structured error extraction.
 */

import { describe, expect, it } from 'vitest';

import { extractErrorInfo, formatErrorInfo } from '../../../../src/lib/engine/errors/errorInfo';
import { InputValidationError } from '../../../../src/lib/schema/errors';

describe('extractErrorInfo', () => {
  it('extracts structured info from InputValidationError', () => {
    const issues = [
      { path: ['email'], message: 'Required', code: 'invalid_type', expected: 'string', received: 'undefined' },
      { path: ['age'], message: 'Expected number, received string', code: 'invalid_type' },
    ];
    const error = new InputValidationError('Validation failed', issues);

    const info = extractErrorInfo(error);

    expect(info.message).toBe('Validation failed');
    expect(info.name).toBe('InputValidationError');
    expect(info.code).toBe('INPUT_VALIDATION_ERROR');
    expect(info.issues).toEqual(issues);
    expect(info.raw).toBe(error);
  });

  it('extracts info from standard Error', () => {
    const error = new TypeError('Cannot read property of undefined');

    const info = extractErrorInfo(error);

    expect(info.message).toBe('Cannot read property of undefined');
    expect(info.name).toBe('TypeError');
    expect(info.issues).toBeUndefined();
    expect(info.raw).toBe(error);
  });

  it('preserves .code from Node.js-style errors', () => {
    const error = new Error('File not found') as Error & { code: string };
    error.code = 'ENOENT';

    const info = extractErrorInfo(error);

    expect(info.code).toBe('ENOENT');
    expect(info.message).toBe('File not found');
  });

  it('handles non-Error thrown values (string)', () => {
    const info = extractErrorInfo('something went wrong');

    expect(info.message).toBe('something went wrong');
    expect(info.name).toBeUndefined();
    expect(info.issues).toBeUndefined();
    expect(info.raw).toBe('something went wrong');
  });

  it('handles non-Error thrown values (number)', () => {
    const info = extractErrorInfo(42);
    expect(info.message).toBe('42');
    expect(info.raw).toBe(42);
  });

  it('handles null/undefined thrown values', () => {
    expect(extractErrorInfo(null).message).toBe('null');
    expect(extractErrorInfo(undefined).message).toBe('undefined');
  });
});

describe('formatErrorInfo', () => {
  it('formats plain error (no issues) as message only', () => {
    const info = extractErrorInfo(new Error('simple error'));
    expect(formatErrorInfo(info)).toBe('simple error');
  });

  it('formats InputValidationError with field-level details', () => {
    const issues = [
      { path: ['email'], message: 'Required' },
      { path: ['address', 'zip'], message: 'Expected 5 digits' },
    ];
    const error = new InputValidationError('Validation failed', issues);
    const info = extractErrorInfo(error);

    const formatted = formatErrorInfo(info);

    expect(formatted).toContain('Validation failed');
    expect(formatted).toContain('email: Required');
    expect(formatted).toContain('address.zip: Expected 5 digits');
  });

  it('uses (root) for empty path', () => {
    const issues = [{ path: [], message: 'Invalid input' }];
    const error = new InputValidationError('Bad input', issues);
    const info = extractErrorInfo(error);

    expect(formatErrorInfo(info)).toContain('(root): Invalid input');
  });
});
