import { z } from 'zod';

import { extractIssuesFromZodError, InputValidationError } from '../../../../src/lib/schema/errors';

describe('InputValidationError', () => {
  it('extends Error', () => {
    const err = new InputValidationError('test', []);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(InputValidationError);
  });

  it('has name InputValidationError', () => {
    const err = new InputValidationError('test', []);
    expect(err.name).toBe('InputValidationError');
  });

  it('carries structured issues', () => {
    const issues = [
      { path: ['name'], message: 'Required', code: 'missing_field' },
      { path: ['age'], message: 'Expected number', code: 'invalid_type' },
    ];
    const err = new InputValidationError('2 issues', issues);

    expect(err.issues).toHaveLength(2);
    expect(err.issues[0].path).toEqual(['name']);
    expect(err.issues[1].code).toBe('invalid_type');
  });

  it('preserves cause when provided', () => {
    const cause = new Error('original');
    const err = new InputValidationError('wrapped', [], cause);
    expect(err.cause).toBe(cause);
  });

  it('has no cause when not provided', () => {
    const err = new InputValidationError('no cause', []);
    expect(err.cause).toBeUndefined();
  });

  it('message is human-readable', () => {
    const err = new InputValidationError('Input validation failed: Expected number', []);
    expect(err.message).toBe('Input validation failed: Expected number');
  });
});

describe('extractIssuesFromZodError', () => {
  it('extracts issues from a real ZodError', () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const result = schema.safeParse({ name: 123, age: 'bad' });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = extractIssuesFromZodError(result.error);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.every((i) => Array.isArray(i.path))).toBe(true);
      expect(issues.every((i) => typeof i.message === 'string')).toBe(true);
    }
  });

  it('extracts from duck-typed error with .issues array', () => {
    const fakeError = {
      issues: [
        { path: ['x'], message: 'bad', code: 'custom' },
        { path: ['y', 'z'], message: 'missing', code: 'missing_field' },
      ],
    };
    const issues = extractIssuesFromZodError(fakeError);

    expect(issues).toHaveLength(2);
    expect(issues[0]).toEqual({
      path: ['x'],
      message: 'bad',
      code: 'custom',
      expected: undefined,
      received: undefined,
    });
    expect(issues[1].path).toEqual(['y', 'z']);
  });

  it('extracts from legacy .errors array', () => {
    const fakeError = {
      errors: [{ path: ['a'], message: 'fail', code: 'err' }],
    };
    const issues = extractIssuesFromZodError(fakeError);
    expect(issues).toHaveLength(1);
  });

  it('returns empty array for null', () => {
    expect(extractIssuesFromZodError(null)).toEqual([]);
  });

  it('returns empty array for non-object', () => {
    expect(extractIssuesFromZodError('string')).toEqual([]);
  });

  it('returns empty array for object without issues', () => {
    expect(extractIssuesFromZodError({ message: 'error' })).toEqual([]);
  });
});
