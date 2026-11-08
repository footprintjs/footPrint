import { afterEach, describe, expect, it, vi } from 'vitest';

import { autoFlushMs, disposeOnThrow } from './index.js';

afterEach(() => vi.restoreAllMocks());

describe('run cleanup helpers', () => {
  it('keeps the thirty-second default, one-second floor and deadline ceiling', () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    expect(autoFlushMs(undefined)).toBe(30_000);
    expect(autoFlushMs(90_000)).toBe(30_000);
    expect(autoFlushMs(15_000)).toBe(5_000);
    expect(autoFlushMs(10_000)).toBe(1_000);
  });

  it('does not dispose a successful build', () => {
    const dispose = vi.fn();
    const result = {};
    expect(disposeOnThrow({ dispose }, () => result)).toBe(result);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('disposes synchronously before rethrowing the exact failed value', () => {
    const error = {};
    const order = [];
    let escaped;
    try {
      disposeOnThrow({ dispose: () => order.push('dispose') }, () => {
        order.push('build');
        throw error;
      });
    } catch (value) {
      order.push('catch');
      escaped = value;
    }
    expect(escaped).toBe(error);
    expect(order).toEqual(['build', 'dispose', 'catch']);
  });
});
