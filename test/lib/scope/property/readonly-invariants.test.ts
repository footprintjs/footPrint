import * as fc from 'fast-check';

import { EventLog, SharedMemory, StageContext } from '../../../../src/lib/memory';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';

function makeCtx() {
  return new StageContext('p1', 's1', 's1', new SharedMemory(), '', new EventLog());
}

const safeKey = fc.string({ minLength: 1 }).filter((s) => !['__proto__', 'constructor', 'prototype'].includes(s));

describe('Property: readonly invariants', () => {
  it('setValue always throws for any key present in readOnlyValues', () => {
    fc.assert(
      fc.property(
        safeKey,
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
        fc.oneof(fc.string(), fc.integer()),
        (key, readOnlyValue, writeValue) => {
          const readOnly = { [key]: readOnlyValue };
          const scope = new ScopeFacade(makeCtx(), 'test', readOnly);

          let threw = false;
          try {
            scope.setValue(key, writeValue);
          } catch (e: any) {
            threw = true;
            // Error message must contain the key name
            if (!e.message.includes(key)) return false;
          }
          return threw;
        },
      ),
      { numRuns: 50 },
    );
  });

  it('setValue never throws for keys NOT in readOnlyValues', () => {
    fc.assert(
      fc.property(safeKey, safeKey, fc.oneof(fc.string(), fc.integer()), (readOnlyKey, writeKey, writeValue) => {
        // Ensure keys are different
        if (readOnlyKey === writeKey) return true;

        const readOnly = { [readOnlyKey]: 'protected' };
        const scope = new ScopeFacade(makeCtx(), 'test', readOnly);

        let threw = false;
        try {
          scope.setValue(writeKey, writeValue);
        } catch {
          threw = true;
        }
        return !threw;
      }),
      { numRuns: 50 },
    );
  });

  it('getArgs always returns an object (never undefined or null)', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(undefined), fc.constant(null), fc.constant({}), fc.dictionary(safeKey, fc.string())),
        (readOnly) => {
          const scope = new ScopeFacade(makeCtx(), 'test', readOnly as any);
          const args = scope.getArgs();
          return args !== undefined && args !== null && typeof args === 'object';
        },
      ),
      { numRuns: 50 },
    );
  });

  it('getArgs value matches getReadOnlyValues for non-null/undefined inputs', () => {
    fc.assert(
      fc.property(fc.dictionary(safeKey, fc.oneof(fc.string(), fc.integer(), fc.boolean())), (readOnly) => {
        const scope = new ScopeFacade(makeCtx(), 'test', readOnly);
        const args = scope.getArgs<Record<string, unknown>>();
        const raw = scope.getReadOnlyValues() as Record<string, unknown>;

        // Both should have the same keys and values
        for (const key of Object.keys(readOnly)) {
          if (args[key] !== raw[key]) return false;
        }
        return true;
      }),
      { numRuns: 50 },
    );
  });

  it('blocked setValue never emits a write event to recorders', () => {
    fc.assert(
      fc.property(safeKey, fc.oneof(fc.string(), fc.integer()), (key, value) => {
        const scope = new ScopeFacade(makeCtx(), 'test', { [key]: 'protected' });
        const events: any[] = [];
        scope.attachRecorder({ id: 'r', onWrite: (e) => events.push(e) });

        try {
          scope.setValue(key, value);
        } catch {
          // expected
        }

        return events.length === 0;
      }),
      { numRuns: 50 },
    );
  });
});
