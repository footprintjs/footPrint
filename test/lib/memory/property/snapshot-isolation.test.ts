import fc from 'fast-check';

import { TransactionBuffer } from '../../../../src/lib/memory/TransactionBuffer';

describe('Property: snapshot isolation', () => {
  it('committed patches never mutate the original base object', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.oneof(fc.integer(), fc.string(), fc.boolean())),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.oneof(fc.integer(), fc.string(), fc.boolean())),
        (base, writes) => {
          const baseCopy = structuredClone(base);
          const buf = new TransactionBuffer(base);

          for (const [key, value] of Object.entries(writes)) {
            buf.set([key], value);
          }
          buf.commit();

          // Original base must not be mutated
          expect(base).toEqual(baseCopy);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('read-after-write is consistent within a buffer', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.string({ minLength: 1, maxLength: 8 }), fc.oneof(fc.integer(), fc.string())), {
          minLength: 1,
          maxLength: 20,
        }),
        (ops) => {
          const buf = new TransactionBuffer({});
          const expected: Record<string, any> = {};

          for (const [key, value] of ops) {
            buf.set([key], value);
            expected[key] = value;
          }

          // Every written key should be readable
          for (const [key, value] of Object.entries(expected)) {
            expect(buf.get([key])).toEqual(value);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('after commit, buffer reads return undefined (empty working copy)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.string({ minLength: 1, maxLength: 8 }), fc.integer()), { minLength: 1, maxLength: 10 }),
        (ops) => {
          // Filter out keys that collide with Object.prototype (e.g. "toString")
          const protoKeys = new Set(Object.getOwnPropertyNames(Object.prototype));
          const safeOps = ops.filter(([key]) => !protoKeys.has(key));
          if (safeOps.length === 0) return;

          const buf = new TransactionBuffer({});
          for (const [key, value] of safeOps) {
            buf.set([key], value);
          }
          buf.commit();

          for (const [key] of safeOps) {
            expect(buf.get([key])).toBeUndefined();
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
