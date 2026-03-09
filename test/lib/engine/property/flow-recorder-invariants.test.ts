/**
 * Property test: FlowRecorder invariants hold for arbitrary inputs.
 *
 * Uses fast-check to verify core invariants:
 * - suppressed + emitted = total (conservation)
 * - strategies never emit more than total iterations
 * - clear() always resets to empty state
 * - dispatcher fan-out count equals recorder count
 */

import * as fc from 'fast-check';

import { FlowRecorderDispatcher } from '../../../../src/lib/engine/narrative/FlowRecorderDispatcher';
import { NarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/NarrativeFlowRecorder';
import { AdaptiveNarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/recorders/AdaptiveNarrativeFlowRecorder';
import { MilestoneNarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/recorders/MilestoneNarrativeFlowRecorder';
import { ProgressiveNarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/recorders/ProgressiveNarrativeFlowRecorder';
import { SilentNarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/recorders/SilentNarrativeFlowRecorder';
import { WindowedNarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/recorders/WindowedNarrativeFlowRecorder';

function emitLoops(recorder: any, count: number, target = 'Retry') {
  for (let i = 1; i <= count; i++) {
    recorder.onLoop({ target, iteration: i });
  }
}

describe('Property: FlowRecorder Invariants', () => {
  // ── Conservation: suppressed + emitted = total ───────────────────────

  it('WindowedNarrativeFlowRecorder: suppressed + emitted = total', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }), // head
        fc.integer({ min: 1, max: 10 }), // tail
        fc.integer({ min: 1, max: 500 }), // total iterations
        (head, tail, total) => {
          const recorder = new WindowedNarrativeFlowRecorder(head, tail);
          emitLoops(recorder, total);
          const emitted = recorder.getSentences().filter((s) => s.includes('pass')).length;
          const suppressed = recorder.getSuppressedCount();
          expect(emitted + suppressed).toBe(total);
        },
      ),
    );
  });

  it('AdaptiveNarrativeFlowRecorder: suppressed + emitted = total', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }), // threshold
        fc.integer({ min: 2, max: 20 }), // sampleRate
        fc.integer({ min: 1, max: 500 }), // total iterations
        (threshold, sampleRate, total) => {
          const recorder = new AdaptiveNarrativeFlowRecorder(threshold, sampleRate);
          emitLoops(recorder, total);
          const emitted = recorder.getSentences().filter((s) => s.includes('pass')).length;
          const suppressed = recorder.getSuppressedCount();
          expect(emitted + suppressed).toBe(total);
        },
      ),
    );
  });

  it('MilestoneNarrativeFlowRecorder: suppressed + emitted = total', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 50 }), // interval
        fc.boolean(), // alwaysEmitFirst
        fc.integer({ min: 1, max: 500 }), // total iterations
        (interval, alwaysEmitFirst, total) => {
          const recorder = new MilestoneNarrativeFlowRecorder(interval, alwaysEmitFirst);
          emitLoops(recorder, total);
          const emitted = recorder.getSentences().filter((s) => s.includes('pass')).length;
          const suppressed = recorder.getSuppressedCount();
          expect(emitted + suppressed).toBe(total);
        },
      ),
    );
  });

  it('ProgressiveNarrativeFlowRecorder: suppressed + emitted = total', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }), // base
        fc.integer({ min: 1, max: 500 }), // total iterations
        (base, total) => {
          const recorder = new ProgressiveNarrativeFlowRecorder(base);
          emitLoops(recorder, total);
          const emitted = recorder.getSentences().filter((s) => s.includes('pass')).length;
          const suppressed = recorder.getSuppressedCount();
          expect(emitted + suppressed).toBe(total);
        },
      ),
    );
  });

  // ── Emitted count never exceeds total ────────────────────────────────

  it('no strategy emits more sentences than total iterations', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), (total) => {
        const strategies = [
          new WindowedNarrativeFlowRecorder(3, 2),
          new AdaptiveNarrativeFlowRecorder(5, 10),
          new MilestoneNarrativeFlowRecorder(10),
          new ProgressiveNarrativeFlowRecorder(),
          new SilentNarrativeFlowRecorder(),
        ];
        for (const recorder of strategies) {
          emitLoops(recorder, total);
          const loopSentences = recorder.getSentences().filter((s) => s.includes('pass') || s.includes('Looped'));
          expect(loopSentences.length).toBeLessThanOrEqual(total);
        }
      }),
    );
  });

  // ── Clear always resets to clean state ───────────────────────────────

  it('all strategies return empty after clear()', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (total) => {
        const strategies = [
          new WindowedNarrativeFlowRecorder(3, 2),
          new AdaptiveNarrativeFlowRecorder(5, 10),
          new MilestoneNarrativeFlowRecorder(10),
          new ProgressiveNarrativeFlowRecorder(),
          new SilentNarrativeFlowRecorder(),
          new NarrativeFlowRecorder(),
        ];
        for (const recorder of strategies) {
          emitLoops(recorder, total);
          recorder.clear();
          expect(recorder.getSentences()).toEqual([]);
        }
      }),
    );
  });

  // ── Dispatcher fan-out count ─────────────────────────────────────────

  it('dispatcher calls every attached recorder exactly once per event', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }), // number of recorders
        (count) => {
          const dispatcher = new FlowRecorderDispatcher();
          const calls: string[] = [];

          for (let i = 0; i < count; i++) {
            dispatcher.attach({
              id: `r${i}`,
              onLoop: () => calls.push(`r${i}`),
            });
          }

          dispatcher.onLoop('target', 1);
          expect(calls).toHaveLength(count);
        },
      ),
    );
  });

  // ── SilentNarrativeFlowRecorder: loop count accuracy ─────────────────

  it('SilentNarrativeFlowRecorder tracks exact loop count for arbitrary inputs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }), // count A
        fc.integer({ min: 1, max: 500 }), // count B
        (countA, countB) => {
          const recorder = new SilentNarrativeFlowRecorder();
          emitLoops(recorder, countA, 'A');
          emitLoops(recorder, countB, 'B');
          const counts = recorder.getLoopCounts();
          expect(counts.get('A')).toBe(countA);
          expect(counts.get('B')).toBe(countB);
        },
      ),
    );
  });

  // ── WindowedNarrativeFlowRecorder: window bounds ─────────────────────

  it('WindowedNarrativeFlowRecorder always shows first head and last tail iterations', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }), // head
        fc.integer({ min: 1, max: 5 }), // tail
        fc.integer({ min: 1, max: 200 }), // total
        (head, tail, total) => {
          if (total <= head + tail) return; // skip trivial case

          const recorder = new WindowedNarrativeFlowRecorder(head, tail);
          emitLoops(recorder, total);
          const sentences = recorder.getSentences();

          // First head iterations should appear
          for (let i = 1; i <= head; i++) {
            expect(sentences.some((s) => s.includes(`pass ${i}`))).toBe(true);
          }
          // Last tail iterations should appear
          for (let i = total - tail + 1; i <= total; i++) {
            expect(sentences.some((s) => s.includes(`pass ${i}`))).toBe(true);
          }
        },
      ),
    );
  });
});
