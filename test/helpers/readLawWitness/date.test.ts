import { describe, expect, it } from 'vitest';

import { bytes } from '../../lib/memory/property/copy-on-write-fixture.js';
import { projectSite } from './retained.js';
import type { CheckedRead } from './types.js';

describe('closed read delivery uses the actual fixture Date bytes', () => {
  it.each([0, 1700000000000, NaN])('Date %s matches the real serializer', (ms) => {
    const date = new Date(ms);
    const proof = { read: { result: { kind: 'date', value: ms } } } as CheckedRead;
    expect(projectSite(bytes(date), 'build', { kind: 'read-line', line: 0 }, proof).text).toBe(bytes(date));
  });
});
