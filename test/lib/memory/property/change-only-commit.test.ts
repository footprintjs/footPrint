/**
 * Property tests for change-only commit semantics.
 *
 * The load-bearing invariant: pruning no-op / write-then-revert paths from the
 * commit bundle MUST NOT change the materialised final state. Replaying the
 * (pruned) bundle has to reproduce exactly what the stage actually left behind.
 *
 * See docs/design/commit-change-semantics.md.
 */
import fc from 'fast-check';

import { TransactionBuffer } from '../../../../src/lib/memory/TransactionBuffer';
import { applySmartMerge } from '../../../../src/lib/memory/utils';

// A small key space → lots of overlapping writes (no-ops + reverts) per stage,
// which is exactly the interesting case. Avoids DENIED keys and DELIM chars.
const keyArb = fc.constantFrom('a', 'b', 'c', 'd');
const scalarArb = fc.oneof(fc.integer({ min: -5, max: 5 }), fc.string({ maxLength: 3 }), fc.boolean());

describe('Property: change-only commits preserve replay', () => {
  it('replaying the pruned bundle reproduces the true final state', () => {
    fc.assert(
      fc.property(
        fc.dictionary(keyArb, scalarArb),
        fc.array(fc.record({ key: keyArb, value: scalarArb }), { maxLength: 25 }),
        (base, writes) => {
          const buf = new TransactionBuffer(base);
          const groundTruth: Record<string, unknown> = structuredClone(base);
          for (const w of writes) {
            buf.set([w.key], w.value);
            groundTruth[w.key] = w.value; // last set wins — the true final state
          }
          const bundle = buf.commit();
          const replayed = applySmartMerge(base, bundle.updates, bundle.overwrite, bundle.trace);
          expect(replayed).toEqual(groundTruth);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('re-writing every key with its existing value yields an EMPTY commit', () => {
    fc.assert(
      fc.property(fc.dictionary(keyArb, scalarArb), (base) => {
        const keys = Object.keys(base);
        fc.pre(keys.length > 0);
        const buf = new TransactionBuffer(base);
        for (const k of keys) buf.set([k], structuredClone(base[k])); // fresh ref, equal content
        const bundle = buf.commit();
        expect(bundle.trace).toHaveLength(0);
        expect(bundle.overwrite).toEqual({});
        expect(bundle.updates).toEqual({});
      }),
      { numRuns: 200 },
    );
  });

  it('write-then-revert within one stage nets to no change', () => {
    fc.assert(
      fc.property(keyArb, scalarArb, scalarArb, (key, original, temp) => {
        fc.pre(JSON.stringify(original) !== JSON.stringify(temp));
        const buf = new TransactionBuffer({ [key]: original });
        buf.set([key], temp); // change
        buf.set([key], structuredClone(original)); // revert
        const bundle = buf.commit();
        expect(bundle.trace).toHaveLength(0);
      }),
      { numRuns: 200 },
    );
  });

  it('only genuinely-changed keys appear in the commit', () => {
    fc.assert(
      fc.property(fc.dictionary(keyArb, scalarArb), fc.dictionary(keyArb, scalarArb), (base, next) => {
        const buf = new TransactionBuffer(base);
        for (const [k, v] of Object.entries(next)) buf.set([k], v);
        const bundle = buf.commit();
        const committedKeys = new Set(Object.keys(bundle.overwrite));
        for (const [k, v] of Object.entries(next)) {
          const changed = JSON.stringify(base[k]) !== JSON.stringify(v);
          expect(committedKeys.has(k)).toBe(changed);
        }
      }),
      { numRuns: 200 },
    );
  });
});
