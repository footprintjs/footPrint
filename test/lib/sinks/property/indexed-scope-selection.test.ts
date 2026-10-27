import { rmSync } from 'node:fs';

import fc from 'fast-check';
import { expect, it } from 'vitest';

import { indexedAddress, indexedFixture, indexedReady } from '../../../helpers/indexedRecordFile.js';

it('preserves only the exact authorized rows and their order for arbitrary interleaved JSON evidence', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.record({ selected: fc.boolean(), value: fc.jsonValue() }), { minLength: 1, maxLength: 24 }),
      async (values) => {
        const selected = indexedAddress('constructor', ['a/b', 'visit#2']);
        const unrelated = indexedAddress('constructor', ['a', 'b/visit#2']);
        const rows = values.map(({ selected: yes, value }) => ({
          kind: 'note',
          address: yes ? selected : unrelated,
          at: 0,
          data: value,
        }));
        const file = indexedFixture(rows);
        const reader = await indexedReady(file.path, [selected]);
        try {
          const loaded = await reader.readScope(selected);
          const expected = rows.filter((_, index) => values[index].selected);
          if (!expected.length) expect(loaded).toEqual({ status: 'unknown', reason: 'no-match' });
          else {
            expect(loaded.status).toBe('loaded');
            if (loaded.status === 'loaded') expect(loaded.entries).toEqual(expected);
          }
          const before = reader.stats.scopeBytes;
          expect(await reader.readScope(unrelated)).toEqual({ status: 'unknown', reason: 'not-permitted' });
          expect(reader.stats.scopeBytes).toBe(before);
        } finally {
          await reader.close();
          rmSync(file.dir, { force: true, recursive: true });
        }
      },
    ),
    { numRuns: 40, seed: 216 },
  );
});
