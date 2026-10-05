import { describe, expect, it, vi } from 'vitest';

import { resolveText } from '../../../../../src/lib/engine/narrative/formatting/resolveText.js';

describe('nullable narrative formatter results', () => {
  it.each(['custom', '', null])('preserves %j without evaluating the default', (custom) => {
    const fallback = vi.fn(() => {
      throw new Error('default must stay lazy');
    });
    expect(resolveText(custom, fallback)).toBe(custom);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('evaluates an unhandled result default exactly once', () => {
    const fallback = vi.fn(() => 'default');
    expect(resolveText(undefined, fallback)).toBe('default');
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('does not hide a default formatter failure from the recorder boundary', () => {
    const error = new Error('default failed');
    expect(() =>
      resolveText(undefined, () => {
        throw error;
      }),
    ).toThrow(error);
  });
});
