import { describe, expect, it, vi } from 'vitest';

import { errorCategory, terminalCategory } from '../../../../src/lib/attempt/category.js';
import { AttemptTimeoutError } from '../../../../src/lib/attempt/errors.js';
import type { AttemptCategory } from '../../../../src/lib/attempt/types.js';
import { InputValidationError } from '../../../../src/lib/schema/errors.js';

const fields: readonly [string, unknown, AttemptCategory][] = [
  ['status', 401, 'auth'],
  ['statusCode', 503, 'server'],
  ['retryAfterMs', 0, 'rate-limited'],
  ['retryAfterSeconds', 0, 'rate-limited'],
  ['retryable', false, 'permanent'],
  ['name', 'ValidationError', 'permanent'],
  ['code', 'EPIPE', 'network'],
  ['cause', { code: 'EPIPE' }, 'network'],
  ['message', 'fetch failed', 'network'],
];

function base(key: string): Error {
  return key === 'message' ? new TypeError('ordinary failure') : new Error('ordinary failure');
}

function inherited(error: Error, key: string, descriptor: PropertyDescriptor): Error {
  Reflect.deleteProperty(error, key);
  Object.setPrototypeOf(error, Object.create(Object.getPrototypeOf(error), { [key]: descriptor }));
  return error;
}

describe('failure categories use data without executing metadata accessors', () => {
  for (const [key, value, category] of fields) {
    it.each(['own', 'inherited'])(`${key}: an %s accessor is never called`, (placement) => {
      const getter = vi.fn(() => value);
      const error = base(key);
      if (placement === 'own') Object.defineProperty(error, key, { get: getter });
      else inherited(error, key, { get: getter });
      expect(errorCategory(error)).toBe('unknown');
      expect(getter).not.toHaveBeenCalled();
    });

    it(`${key}: inherited data keeps its existing category`, () => {
      expect(errorCategory(inherited(base(key), key, { value }))).toBe(category);
    });
  }

  it('never calls a throwing accessor, including cause.code', () => {
    const getter = vi.fn(() => {
      throw new Error('synthetic private getter detail');
    });
    for (const [key] of fields) {
      expect(errorCategory(Object.defineProperty(base(key), key, { get: getter }))).toBe('unknown');
    }
    const cause = Object.defineProperty({}, 'code', { get: getter });
    expect(errorCategory(Object.assign(new Error('ordinary failure'), { cause }))).toBe('unknown');
    expect(getter).not.toHaveBeenCalled();
  });

  it('does not call an inherited cause.code accessor but retains inherited data', () => {
    const getter = vi.fn(() => 'EPIPE');
    expect(errorCategory({ cause: Object.create(Object.create(null, { code: { get: getter } })) })).toBe('unknown');
    expect(errorCategory({ cause: Object.create({ code: 'EPIPE' }) })).toBe('network');
    expect(errorCategory({ cause: { cause: { code: 'EPIPE' } } })).toBe('unknown');
    expect(getter).not.toHaveBeenCalled();
  });

  it('an accessor shadows prototype data without hiding an independent statusCode', () => {
    const getter = vi.fn(() => undefined);
    const error = Object.defineProperty(Object.create({ status: 401 }), 'status', { get: getter });
    expect(errorCategory(error)).toBe('unknown');
    Object.defineProperty(error, 'statusCode', { value: 503 });
    expect(errorCategory(error)).toBe('server');
    expect(getter).not.toHaveBeenCalled();
  });

  it('invalid own data still shadows farther data and preserves status precedence', () => {
    const error = Object.defineProperty(Object.create({ status: 401 }), 'status', { value: '401' });
    expect(errorCategory(error)).toBe('unknown');
    expect(errorCategory({ status: 200, code: 'EPIPE' })).toBe('unknown');
    expect(errorCategory({ status: '401', statusCode: 503, code: 'EPIPE' })).toBe('server');
    expect(errorCategory({ status: NaN, code: 'EPIPE' })).toBe('network');
  });

  it('preserves real class identity even when its name is shadowed by an accessor', () => {
    const getter = vi.fn(() => 'synthetic misleading name');
    expect(errorCategory(Object.defineProperty(new AttemptTimeoutError(1, 1), 'name', { get: getter }))).toBe(
      'timeout',
    );
    expect(
      errorCategory(Object.defineProperty(new InputValidationError('ordinary failure', []), 'name', { get: getter })),
    ).toBe('permanent');
    expect(errorCategory({ name: 'AttemptTimeoutError' })).toBe('unknown');
    expect(getter).not.toHaveBeenCalled();
  });

  it('supports callable/null-prototype data and bounds inherited field depth', () => {
    expect(errorCategory(Object.assign(() => {}, { status: 401 }))).toBe('auth');
    expect(errorCategory(Object.assign(Object.create(null), { code: 'EPIPE' }))).toBe('network');
    let deep: object = { status: 401 };
    for (let index = 0; index < 40; index++) deep = Object.create(deep);
    expect(errorCategory(deep)).toBe('unknown');
  });

  it('keeps the cross-format uncertainty declaration own-data only', () => {
    const error = Object.assign(Object.create({ name: 'UnknownEffectError' }), { code: 'EPIPE' });
    expect(terminalCategory(error, 'network')).toBe('network');
    Object.defineProperty(error, 'name', { value: 'UnknownEffectError' });
    expect(terminalCategory(error, 'network')).toBe('unknown');
  });
});
