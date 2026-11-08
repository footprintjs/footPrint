import { describe, expect, it } from 'vitest';

import { detachKey } from './spawn.js';

describe('detach refusal name', () => {
  it('uses only the chart root id, never input or root data', () => {
    expect(detachKey({ root: { id: 'child', input: 'not a name' } })).toBe('detach:child');
  });

  it('keeps the fixed fallback for missing or non-string root ids', () => {
    expect(detachKey(undefined)).toBe('detach');
    expect(detachKey({})).toBe('detach');
    expect(detachKey({ root: { id: 12 } })).toBe('detach');
  });
});
