import { describe, expect, it } from 'vitest';

import { RunFrame } from '../../../src/lib/memory/RunFrame.js';

describe('native component ordinal exhaustion', () => {
  it('refuses before creating an entry whose successor is not a safe integer', () => {
    const parent = RunFrame.open({ kind: 'leg', runId: 'native-run', startedAtMs: 0 });
    // Seed native-private data only to reach the otherwise impractical boundary.
    // This is not a public runner option or a second occurrence allocator.
    const leg = Object.getOwnPropertyDescriptor(parent, 'leg')!.value as { nextComponentOrdinal: number };
    leg.nextComponentOrdinal = Number.MAX_SAFE_INTEGER - 1;
    const accepted = parent.mounted({});
    expect(accepted.componentEntry).toEqual({ runId: 'native-run', ordinal: Number.MAX_SAFE_INTEGER - 1 });
    expect(leg.nextComponentOrdinal).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parent.mounted({})).toThrow('ordinal is exhausted');
    expect(leg.nextComponentOrdinal).toBe(Number.MAX_SAFE_INTEGER);
    expect(parent.retired).toBe(false);
    expect(parent.mounted().componentEntry.ordinal).toBe(0);
  });
});
