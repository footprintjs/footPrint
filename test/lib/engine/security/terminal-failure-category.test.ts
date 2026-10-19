import { describe, expect, it } from 'vitest';

import { terminalCategory } from '../../../../src/lib/attempt/category.js';

describe('terminal unknown-effect declarations across module copies', () => {
  it('admits only the own data declaration and only reduces certainty', () => {
    const foreign = Object.assign(new Error('synthetic private'), {
      name: 'UnknownEffectError',
      cause: { code: 'ECONNRESET' },
    });
    expect(terminalCategory(foreign, 'network')).toBe('unknown');
    expect(terminalCategory(foreign)).toBe('unknown');
  });

  it('does not invoke a name accessor to classify an already known error', () => {
    let reads = 0;
    const error = Object.defineProperty(Object.assign(new Error('synthetic'), { status: 503 }), 'name', {
      get() {
        reads++;
        throw new Error('synthetic private getter');
      },
    });
    expect(terminalCategory(error, 'server')).toBe('server');
    expect(terminalCategory(error)).toBe('server');
    expect(reads).toBe(0);
  });

  it('does not treat an inherited declaration as an own data fact', () => {
    const error = Object.assign(Object.create({ name: 'UnknownEffectError' }), { code: 'ECONNRESET' });
    expect(terminalCategory(error, 'network')).toBe('network');
  });

  it('remains total when a proxy refuses the descriptor boundary', () => {
    const error = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('synthetic private descriptor');
        },
      },
    );
    expect(terminalCategory(error, 'server')).toBe('server');
    expect(terminalCategory(error)).toBe('unknown');
  });
});
