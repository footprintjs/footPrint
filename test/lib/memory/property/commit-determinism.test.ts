/**
 * Property: commit determinism — a chain of stage frames (`RecordFrame`, footprintjs/write) at a run's
 * address, one commit each: the same writes give the same log, and a fold at step K ignores later commits.
 */
import fc from 'fast-check';

import { EventLog, RecordFrame, SharedMemory } from '../../../../src/write';

/** Stage `s<i>`: a fresh frame at run `p1`, one `set` of `key`, committed and released. */
function writeStage(mem: SharedMemory, log: EventLog, i: number, key: string, value: unknown): void {
  const frame = new RecordFrame(mem, log, ['runs', 'p1']);
  frame.write(frame.at([], key), value, 'set');
  frame.commit(() => ({ stage: `s${i}`, stageId: `s${i}`, runtimeStageId: `s${i}#${i}` }));
  frame.release();
}

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

            for (let i = 0; i < writes.length; i++) {
              writeStage(mem, log, i, writes[i].key, writes[i].value);
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
      fc.property(fc.integer({ min: 2, max: 10 }), fc.integer({ min: 1, max: 9 }), (totalSteps, stepK) => {
        const k = Math.min(stepK, totalSteps - 1);
        const mem = new SharedMemory();
        const log = new EventLog(mem.getState());

        for (let i = 0; i < totalSteps; i++) {
          writeStage(mem, log, i, `key${i}`, i);
        }

        const atK = log.materialise(k);
        // Key at index k should NOT exist (materialise is exclusive)
        expect(atK.runs?.p1?.[`key${k}`]).toBeUndefined();
        // Key at index k-1 should exist
        if (k > 0) {
          expect(atK.runs?.p1?.[`key${k - 1}`]).toBe(k - 1);
        }
      }),
      { numRuns: 30 },
    );
  });
});
