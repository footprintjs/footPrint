import fc from 'fast-check';
import { SharedMemory } from '../../../../src/lib/memory/SharedMemory';
import { StageContext } from '../../../../src/lib/memory/StageContext';
import { EventLog } from '../../../../src/lib/memory/EventLog';

describe('Property: commit determinism', () => {
  it('replaying N commits always produces the same state', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            key: fc.string({ minLength: 1, maxLength: 10 }),
            value: fc.oneof(fc.integer(), fc.string(), fc.boolean()),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        (writes) => {
          // Execute twice with identical inputs
          const run = () => {
            const mem = new SharedMemory();
            const log = new EventLog(mem.getState());
            let ctx = new StageContext('p1', 'root', mem, '', log);

            for (let i = 0; i < writes.length; i++) {
              const stage = i === 0 ? ctx : ctx.createNext('p1', `s${i}`);
              if (i > 0) ctx = stage;
              stage.setObject([], writes[i].key, writes[i].value);
              stage.commit();
            }

            return log.materialise();
          };

          const first = run();
          const second = run();
          expect(first).toEqual(second);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('materialise at step K is independent of later commits', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }),
        fc.integer({ min: 1, max: 9 }),
        (totalSteps, stepK) => {
          const k = Math.min(stepK, totalSteps - 1);
          const mem = new SharedMemory();
          const log = new EventLog(mem.getState());
          let ctx = new StageContext('p1', 'root', mem, '', log);

          for (let i = 0; i < totalSteps; i++) {
            const stage = i === 0 ? ctx : ctx.createNext('p1', `s${i}`);
            if (i > 0) ctx = stage;
            stage.setObject([], `key${i}`, i);
            stage.commit();
          }

          const atK = log.materialise(k);
          // Key at index k should NOT exist (materialise is exclusive)
          expect(atK.runs?.p1?.[`key${k}`]).toBeUndefined();
          // Key at index k-1 should exist
          if (k > 0) {
            expect(atK.runs?.p1?.[`key${k - 1}`]).toBe(k - 1);
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
