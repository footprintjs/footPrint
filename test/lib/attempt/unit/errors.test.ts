/**
 * `attempt/errors.ts` — the two errors the attempt contract throws (design §3.3): `AttemptTimeoutError` (our own
 * timer ended an attempt) and `UnknownEffectError` (a side-effecting target's last attempt ended with no answer —
 * "reconcile, do not retry blindly" is on the error, not in prose).
 *
 * Test types: Unit (fields, names, `instanceof`, `cause`) · Security (the idempotency key is a VALUE: it rides the
 * error as a field a redaction rule can select by name, never in the message text).
 */
import { describe, expect, it } from 'vitest';

import { AttemptTimeoutError, UnknownEffectError } from '../../../../src/lib/attempt/errors.js';
import { extractErrorInfo } from '../../../../src/lib/errors/errorInfo.js';

describe('AttemptTimeoutError', () => {
  it('names the attempt and the cap it ran out of', () => {
    const error = new AttemptTimeoutError(2, 40_000);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AttemptTimeoutError);
    expect(error.name).toBe('AttemptTimeoutError');
    expect(error.attempt).toBe(2);
    expect(error.timeoutMs).toBe(40_000);
    expect(error.message).toContain('attempt 2');
    expect(error.message).toContain('40000ms');
    expect(Object.hasOwn(error, 'cause')).toBe(false);
  });

  it('carries a cause when given one', () => {
    const cause = new Error('socket hung');
    expect(new AttemptTimeoutError(1, 10, { cause }).cause).toBe(cause);
  });
});

describe('UnknownEffectError', () => {
  it('carries the system, the key, the attempt count and the cause', () => {
    const cause = new Error('timed out');
    const error = new UnknownEffectError({ system: 'stripe', idempotencyKey: 'order-42', attempts: 3, cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('UnknownEffectError');
    expect(error.system).toBe('stripe');
    expect(error.idempotencyKey).toBe('order-42');
    expect(error.attempts).toBe(3);
    expect(error.cause).toBe(cause);
    expect(error.message).toContain('stripe');
    expect(error.message).toContain('reconcile');
  });

  it('never spells the idempotency key in its message — a value is retained, a name rides the text', () => {
    const error = new UnknownEffectError({ system: 'stripe', idempotencyKey: 'order-secret-42', attempts: 1 });
    expect(error.message).not.toContain('order-secret-42');
    expect(extractErrorInfo(error).message).not.toContain('order-secret-42');
  });
});
