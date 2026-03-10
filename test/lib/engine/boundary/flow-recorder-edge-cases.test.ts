/**
 * Boundary test: FlowRecorder edge cases and extremes.
 *
 * Tests behavior at limits: zero iterations, very high iteration counts,
 * empty recorders, rapid attach/detach, and unusual parameter values.
 */

import { extractErrorInfo } from '../../../../src/lib/engine/errors/errorInfo';
import { FlowRecorderDispatcher } from '../../../../src/lib/engine/narrative/FlowRecorderDispatcher';
import { NarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/NarrativeFlowRecorder';
import { AdaptiveNarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/recorders/AdaptiveNarrativeFlowRecorder';
import { MilestoneNarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/recorders/MilestoneNarrativeFlowRecorder';
import { ProgressiveNarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/recorders/ProgressiveNarrativeFlowRecorder';
import { RLENarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/recorders/RLENarrativeFlowRecorder';
import { SeparateNarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/recorders/SeparateNarrativeFlowRecorder';
import { SilentNarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/recorders/SilentNarrativeFlowRecorder';
import { WindowedNarrativeFlowRecorder } from '../../../../src/lib/engine/narrative/recorders/WindowedNarrativeFlowRecorder';

function emitLoops(recorder: any, count: number, target = 'Retry') {
  for (let i = 1; i <= count; i++) {
    recorder.onLoop({ target, iteration: i });
  }
}

describe('Boundary: FlowRecorder Edge Cases', () => {
  // ── Zero iterations ──────────────────────────────────────────────────

  describe('zero iterations (no loops)', () => {
    it('WindowedNarrativeFlowRecorder returns empty for no loops', () => {
      const recorder = new WindowedNarrativeFlowRecorder(3, 2);
      expect(recorder.getSentences()).toEqual([]);
      expect(recorder.getSuppressedCount()).toBe(0);
    });

    it('SilentNarrativeFlowRecorder returns empty for no loops', () => {
      const recorder = new SilentNarrativeFlowRecorder();
      expect(recorder.getSentences()).toEqual([]);
      expect(recorder.getLoopCounts().size).toBe(0);
    });

    it('RLENarrativeFlowRecorder returns empty for no loops', () => {
      const recorder = new RLENarrativeFlowRecorder();
      expect(recorder.getSentences()).toEqual([]);
    });

    it('AdaptiveNarrativeFlowRecorder returns empty for no loops', () => {
      const recorder = new AdaptiveNarrativeFlowRecorder();
      expect(recorder.getSentences()).toEqual([]);
      expect(recorder.getSuppressedCount()).toBe(0);
    });

    it('ProgressiveNarrativeFlowRecorder returns empty for no loops', () => {
      const recorder = new ProgressiveNarrativeFlowRecorder();
      expect(recorder.getSentences()).toEqual([]);
      expect(recorder.getSuppressedCount()).toBe(0);
    });

    it('SeparateNarrativeFlowRecorder returns empty for no loops', () => {
      const recorder = new SeparateNarrativeFlowRecorder();
      expect(recorder.getSentences()).toEqual([]);
      expect(recorder.getLoopSentences()).toEqual([]);
    });

    it('MilestoneNarrativeFlowRecorder returns empty for no loops', () => {
      const recorder = new MilestoneNarrativeFlowRecorder();
      expect(recorder.getSentences()).toEqual([]);
      expect(recorder.getSuppressedCount()).toBe(0);
    });
  });

  // ── Single iteration ─────────────────────────────────────────────────

  describe('single iteration', () => {
    it('WindowedNarrativeFlowRecorder emits the single iteration', () => {
      const recorder = new WindowedNarrativeFlowRecorder(3, 2);
      emitLoops(recorder, 1);
      expect(recorder.getSentences()).toHaveLength(1);
      expect(recorder.getSuppressedCount()).toBe(0);
    });

    it('ProgressiveNarrativeFlowRecorder always emits iteration 1', () => {
      const recorder = new ProgressiveNarrativeFlowRecorder();
      emitLoops(recorder, 1);
      expect(recorder.getSentences()).toHaveLength(1);
      expect(recorder.getSuppressedCount()).toBe(0);
    });

    it('MilestoneNarrativeFlowRecorder emits first iteration when alwaysEmitFirst=true', () => {
      const recorder = new MilestoneNarrativeFlowRecorder(10, true);
      emitLoops(recorder, 1);
      expect(recorder.getSentences()).toHaveLength(1);
    });

    it('MilestoneNarrativeFlowRecorder suppresses first when alwaysEmitFirst=false and not on interval', () => {
      const recorder = new MilestoneNarrativeFlowRecorder(10, false);
      emitLoops(recorder, 1);
      expect(recorder.getSentences()).toEqual([]);
      expect(recorder.getSuppressedCount()).toBe(1);
    });
  });

  // ── High iteration counts ────────────────────────────────────────────

  describe('high iteration counts', () => {
    it('WindowedNarrativeFlowRecorder handles 10K iterations', () => {
      const recorder = new WindowedNarrativeFlowRecorder(3, 2);
      emitLoops(recorder, 10_000);
      const sentences = recorder.getSentences();
      // 3 head + 1 omitted + 2 tail = 6
      expect(sentences.filter((s) => s.includes('pass') || s.includes('omitted'))).toHaveLength(6);
      expect(recorder.getSuppressedCount()).toBe(9_995);
    });

    it('SilentNarrativeFlowRecorder handles 10K iterations with minimal output', () => {
      const recorder = new SilentNarrativeFlowRecorder();
      emitLoops(recorder, 10_000);
      const sentences = recorder.getSentences();
      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toContain('10000 times');
    });

    it('RLENarrativeFlowRecorder collapses 10K same-target iterations into 1', () => {
      const recorder = new RLENarrativeFlowRecorder();
      emitLoops(recorder, 10_000);
      const sentences = recorder.getSentences();
      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toContain('10000 times');
    });

    it('ProgressiveNarrativeFlowRecorder emits O(log n) for 10K iterations', () => {
      const recorder = new ProgressiveNarrativeFlowRecorder();
      emitLoops(recorder, 10_000);
      const loopSentences = recorder.getSentences().filter((s) => s.includes('pass'));
      // Powers of 2 up to 8192: 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192 = 14
      expect(loopSentences.length).toBeLessThan(20);
      expect(loopSentences.length).toBeGreaterThan(10);
    });
  });

  // ── Exact boundary: count === head + tail ────────────────────────────

  describe('exact boundary conditions', () => {
    it('WindowedNarrativeFlowRecorder: count equals exactly head + tail', () => {
      const recorder = new WindowedNarrativeFlowRecorder(3, 2);
      emitLoops(recorder, 5); // exactly 3 + 2
      const sentences = recorder.getSentences();
      expect(sentences.filter((s) => s.includes('pass'))).toHaveLength(5);
      expect(sentences.some((s) => s.includes('omitted'))).toBe(false);
    });

    it('WindowedNarrativeFlowRecorder: count is head + tail + 1 starts compressing', () => {
      const recorder = new WindowedNarrativeFlowRecorder(3, 2);
      emitLoops(recorder, 6); // 3 + 2 + 1
      const sentences = recorder.getSentences();
      expect(sentences.some((s) => s.includes('omitted'))).toBe(true);
      expect(recorder.getSuppressedCount()).toBe(1);
    });

    it('AdaptiveNarrativeFlowRecorder: exactly at threshold emits all', () => {
      const recorder = new AdaptiveNarrativeFlowRecorder(5, 10);
      emitLoops(recorder, 5);
      const loopSentences = recorder.getSentences().filter((s) => s.includes('pass'));
      expect(loopSentences).toHaveLength(5);
      expect(recorder.getSuppressedCount()).toBe(0);
    });

    it('AdaptiveNarrativeFlowRecorder: threshold + 1 starts sampling', () => {
      const recorder = new AdaptiveNarrativeFlowRecorder(5, 10);
      emitLoops(recorder, 6);
      expect(recorder.getSuppressedCount()).toBe(1);
    });
  });

  // ── Dispatcher edge cases ────────────────────────────────────────────

  describe('dispatcher edge cases', () => {
    it('detaching all recorders results in no-op behavior', () => {
      const dispatcher = new FlowRecorderDispatcher();
      const narrator = new NarrativeFlowRecorder();
      dispatcher.attach(narrator);
      dispatcher.detach('narrative');
      dispatcher.onStageExecuted('Init');
      expect(dispatcher.getSentences()).toEqual([]);
    });

    it('rapid attach/detach cycles work correctly', () => {
      const dispatcher = new FlowRecorderDispatcher();
      for (let i = 0; i < 100; i++) {
        dispatcher.attach({ id: `r${i}` });
      }
      for (let i = 0; i < 100; i++) {
        dispatcher.detach(`r${i}`);
      }
      expect(dispatcher.getRecorders()).toEqual([]);
    });

    it('attaching same id multiple times creates duplicates', () => {
      const dispatcher = new FlowRecorderDispatcher();
      dispatcher.attach({ id: 'dup' });
      dispatcher.attach({ id: 'dup' });
      expect(dispatcher.getRecorders()).toHaveLength(2);
      // Detach removes all with that id
      dispatcher.detach('dup');
      expect(dispatcher.getRecorders()).toEqual([]);
    });

    it('getRecorders returns defensive copy', () => {
      const dispatcher = new FlowRecorderDispatcher();
      dispatcher.attach({ id: 'a' });
      const copy = dispatcher.getRecorders();
      copy.push({ id: 'b' });
      expect(dispatcher.getRecorders()).toHaveLength(1);
    });
  });

  // ── NarrativeFlowRecorder edge cases ─────────────────────────────────

  describe('NarrativeFlowRecorder edge cases', () => {
    it('only first stage triggers "process began" sentence', () => {
      const recorder = new NarrativeFlowRecorder();
      recorder.onStageExecuted({ stageName: 'A' });
      recorder.onStageExecuted({ stageName: 'B' });
      recorder.onStageExecuted({ stageName: 'C' });
      const sentences = recorder.getSentences();
      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toContain('A');
    });

    it('clear resets first-stage tracking', () => {
      const recorder = new NarrativeFlowRecorder();
      recorder.onStageExecuted({ stageName: 'A' });
      recorder.clear();
      recorder.onStageExecuted({ stageName: 'B' });
      const sentences = recorder.getSentences();
      expect(sentences).toHaveLength(1);
      expect(sentences[0]).toContain('B');
    });

    it('all event types produce output', () => {
      const recorder = new NarrativeFlowRecorder();
      recorder.onStageExecuted({ stageName: 'Init' });
      recorder.onNext({ from: 'Init', to: 'Process' });
      recorder.onDecision({ decider: 'Check', chosen: 'Yes' });
      recorder.onFork({ parent: 'Fan', children: ['A', 'B'] });
      recorder.onSelected({ parent: 'Sel', selected: ['X'], total: 3 });
      recorder.onSubflowEntry({ name: 'Sub' });
      recorder.onSubflowExit({ name: 'Sub' });
      recorder.onLoop({ target: 'Retry', iteration: 1 });
      recorder.onBreak({ stageName: 'Stop' });
      recorder.onError({ stageName: 'Fail', message: 'boom', structuredError: extractErrorInfo(new Error('boom')) });
      expect(recorder.getSentences()).toHaveLength(10);
    });
  });

  // ── Multiple targets in strategies ───────────────────────────────────

  describe('multiple loop targets', () => {
    it('WindowedNarrativeFlowRecorder tracks targets independently', () => {
      const recorder = new WindowedNarrativeFlowRecorder(2, 1);
      emitLoops(recorder, 10, 'A');
      emitLoops(recorder, 10, 'B');
      const sentences = recorder.getSentences();
      expect(sentences.some((s) => s.includes('A'))).toBe(true);
      expect(sentences.some((s) => s.includes('B'))).toBe(true);
    });

    it('RLENarrativeFlowRecorder creates separate runs per target switch', () => {
      const recorder = new RLENarrativeFlowRecorder();
      // A x 3, B x 2, A x 4 = 3 runs
      for (let i = 1; i <= 3; i++) recorder.onLoop({ target: 'A', iteration: i });
      for (let i = 1; i <= 2; i++) recorder.onLoop({ target: 'B', iteration: i });
      for (let i = 4; i <= 7; i++) recorder.onLoop({ target: 'A', iteration: i });
      const sentences = recorder.getSentences();
      expect(sentences).toHaveLength(3);
      expect(sentences[0]).toContain('3 times');
      expect(sentences[1]).toContain('2 times');
      expect(sentences[2]).toContain('4 times');
    });

    it('AdaptiveNarrativeFlowRecorder applies threshold per-target', () => {
      const recorder = new AdaptiveNarrativeFlowRecorder(3, 5);
      emitLoops(recorder, 3, 'A'); // all below threshold
      emitLoops(recorder, 3, 'B'); // all below threshold
      // Both targets' iterations should be fully emitted
      const loopSentences = recorder.getSentences().filter((s) => s.includes('pass'));
      expect(loopSentences).toHaveLength(6);
      expect(recorder.getSuppressedCount()).toBe(0);
    });
  });
});
