import fc from 'fast-check';

import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';

describe('Property: namespace no collision', () => {
  it('N runs writing the same key never interfere', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 8 }),
            value: fc.oneof(fc.integer(), fc.string()),
          }),
          { minLength: 2, maxLength: 20 },
        ),
        (runs) => {
          const mem = new SharedMemory();
          const key = 'sharedKey';

          // Deduplicate run IDs
          const unique = new Map<string, any>();
          for (const p of runs) {
            unique.set(p.id, p.value);
          }

          for (const [id, value] of unique) {
            mem.setValue(id, [], key, value);
          }

          // Each run should see its own value
          for (const [id, value] of unique) {
            expect(mem.getValue(id, [], key)).toEqual(value);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('run writes never corrupt global state', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 8 }), fc.integer(), (runId, value) => {
        const globalDefault = { immutable: 'global' };
        const mem = new SharedMemory(globalDefault);

        mem.setValue(runId, [], 'data', value);

        // Global should still be intact
        expect(mem.getValue('', [], 'immutable')).toBe('global');
        // Run-specific write
        expect(mem.getValue(runId, [], 'data')).toBe(value);
      }),
      { numRuns: 50 },
    );
  });
});
