/**
 * `attempt/category.ts · errorCategory` — the ONE failure classifier (design §3.9): seven fixed values, so every
 * recorder breaks failures down the same way. Category is evidence, never policy: nothing here decides a retry.
 *
 * Test types: Unit (every row of the §3.9 table, by status, code, declared field, the attempt's own timer and the
 * run's signal) · Boundary (precedence between rows; values that are not errors; a hostile Proxy — total, never
 * throws).
 */
import { describe, expect, it } from 'vitest';

import { errorCategory } from '../../../../src/lib/attempt/category.js';
import { AttemptTimeoutError } from '../../../../src/lib/attempt/errors.js';
import { InputValidationError } from '../../../../src/lib/schema/errors.js';

const withFields = (fields: Record<string, unknown>) => Object.assign(new Error('boom'), fields);

describe('errorCategory — one row per category', () => {
  it('timeout: the attempt’s own timer fired (the outcome says so), or our own timeout error', () => {
    expect(errorCategory(new Error('slow'), 'timeout')).toBe('timeout');
    expect(errorCategory(new AttemptTimeoutError(2, 500), 'failed')).toBe('timeout');
    expect(errorCategory(new AttemptTimeoutError(1, 10))).toBe('timeout');
  });

  it('rate-limited: status 429, or the error declares a retry-after', () => {
    expect(errorCategory(withFields({ status: 429 }))).toBe('rate-limited');
    expect(errorCategory(withFields({ statusCode: 429 }))).toBe('rate-limited');
    expect(errorCategory(withFields({ retryAfterMs: 1_000 }))).toBe('rate-limited');
    expect(errorCategory(withFields({ retryAfterSeconds: 0 }))).toBe('rate-limited');
  });

  it('server: any 5xx', () => {
    for (const status of [500, 502, 503, 599]) expect(errorCategory(withFields({ status }))).toBe('server');
    expect(errorCategory(withFields({ statusCode: 504 }))).toBe('server');
  });

  it('auth: 401 and 403', () => {
    expect(errorCategory(withFields({ status: 401 }))).toBe('auth');
    expect(errorCategory(withFields({ statusCode: 403 }))).toBe('auth');
  });

  it('permanent: any other 4xx, a validation error, or an error that declares retryable: false', () => {
    for (const status of [400, 404, 409, 422]) expect(errorCategory(withFields({ status }))).toBe('permanent');
    expect(errorCategory(withFields({ retryable: false }))).toBe('permanent');
    expect(errorCategory(new InputValidationError('bad input', []))).toBe('permanent');
    expect(errorCategory(Object.assign(new Error('x'), { name: 'ZodError' }))).toBe('permanent');
    expect(errorCategory(Object.assign(new Error('x'), { name: 'ValidationError' }))).toBe('permanent');
  });

  it('network: a transport code (on the error or its cause), a fetch TypeError, or an abort that was not the run’s', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE']) {
      expect(errorCategory(withFields({ code })), code).toBe('network');
    }
    // Node's fetch: TypeError('fetch failed') with the socket error as its cause.
    expect(errorCategory(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe(
      'network',
    );
    expect(errorCategory(new TypeError('fetch failed'))).toBe('network');
    expect(errorCategory(new TypeError('Failed to fetch'))).toBe('network');
    expect(errorCategory(new TypeError('NetworkError when attempting to fetch resource.'))).toBe('network');
    expect(errorCategory(new TypeError('Load failed'))).toBe('network');
    expect(errorCategory(Object.assign(new Error('aborted'), { name: 'AbortError' }), 'failed')).toBe('network');
    expect(errorCategory(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))).toBe('network');
  });

  it('unknown: anything else — and every attempt the run’s signal ended', () => {
    expect(errorCategory(new Error('boom'))).toBe('unknown');
    expect(errorCategory(new TypeError('x is not a function'))).toBe('unknown');
    expect(errorCategory(withFields({ status: 429 }), 'aborted')).toBe('unknown');
    expect(errorCategory(withFields({ status: 200 }))).toBe('unknown');
  });
});

describe('errorCategory — precedence and boundaries', () => {
  it('what the failure LOOKED like wins over what it declares: 429 with retryable: false is rate-limited', () => {
    expect(errorCategory(withFields({ status: 429, retryable: false }))).toBe('rate-limited');
    expect(errorCategory(withFields({ status: 503, retryAfterMs: 5 }))).toBe('rate-limited');
    expect(errorCategory(withFields({ status: 401, code: 'ECONNRESET' }))).toBe('auth');
    expect(errorCategory(withFields({ status: 500, retryable: false }))).toBe('server');
  });

  it('a status is a number: a numeric string is not read as one', () => {
    expect(errorCategory(withFields({ status: '429' }))).toBe('unknown');
    expect(errorCategory(withFields({ retryAfterMs: 'soon' }))).toBe('unknown');
    expect(errorCategory(withFields({ retryAfterMs: -1 }))).toBe('unknown');
  });

  it('values that are not errors classify too', () => {
    expect(errorCategory(null)).toBe('unknown');
    expect(errorCategory(undefined)).toBe('unknown');
    expect(errorCategory('a thrown string')).toBe('unknown');
    expect(errorCategory(42)).toBe('unknown');
    expect(errorCategory({ status: 404 })).toBe('permanent');
    expect(errorCategory(Object.assign(Object.create(null), { code: 'EPIPE' }))).toBe('network');
  });

  it('is total: a value whose every read throws is unknown, never a second throw', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
        getPrototypeOf() {
          throw new Error('trap');
        },
      },
    );
    expect(errorCategory(hostile)).toBe('unknown');
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(errorCategory(proxy)).toBe('unknown');
  });
});
