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

// ─── WindowedNarrativeFlowRecorder ──────────────────────────────────────────

describe('WindowedNarrativeFlowRecorder', () => {
  it('emits all iterations when count <= head + tail', () => {
    const recorder = new WindowedNarrativeFlowRecorder(3, 2);
    emitLoops(recorder, 4);
    const sentences = recorder.getSentences();
    // 4 <= 3+2, so all iterations emitted, no compression
    expect(sentences.filter((s) => s.includes('pass'))).toHaveLength(4);
    expect(sentences.some((s) => s.includes('omitted'))).toBe(false);
  });

  it('compresses middle iterations when count > head + tail', () => {
    const recorder = new WindowedNarrativeFlowRecorder(3, 2);
    emitLoops(recorder, 50);
    const sentences = recorder.getSentences();
    // Should have: 3 head + 1 skip message + 2 tail = 6 loop-related sentences
    const loopSentences = sentences.filter((s) => s.includes('pass') || s.includes('omitted'));
    expect(loopSentences.length).toBeLessThan(50);
    expect(sentences.some((s) => s.includes('omitted'))).toBe(true);
    expect(sentences.some((s) => s.includes('pass 49'))).toBe(true);
    expect(sentences.some((s) => s.includes('pass 50'))).toBe(true);
  });

  it('getSuppressedCount returns correct value', () => {
    const recorder = new WindowedNarrativeFlowRecorder(3, 2);
    emitLoops(recorder, 50);
    expect(recorder.getSuppressedCount()).toBe(45);
  });

  it('clears state', () => {
    const recorder = new WindowedNarrativeFlowRecorder(3, 2);
    emitLoops(recorder, 10);
    recorder.clear();
    expect(recorder.getSentences()).toEqual([]);
    expect(recorder.getSuppressedCount()).toBe(0);
  });

  it('formats loop sentences with description', () => {
    const recorder = new WindowedNarrativeFlowRecorder(2, 1);
    recorder.onLoop({ target: 'Retry', iteration: 1, description: 'retrying the request' });
    recorder.onLoop({ target: 'Retry', iteration: 2 });
    const sentences = recorder.getSentences();
    expect(sentences[0]).toContain('retrying the request');
    expect(sentences[0]).toContain('again');
    expect(sentences[1]).toContain('pass 2 through Retry');
  });

  it('accepts custom id', () => {
    const recorder = new WindowedNarrativeFlowRecorder(3, 2, 'my-windowed');
    expect(recorder.id).toBe('my-windowed');
  });
});

// ─── AdaptiveNarrativeFlowRecorder ──────────────────────────────────────────

describe('AdaptiveNarrativeFlowRecorder', () => {
  it('emits all iterations up to threshold', () => {
    const recorder = new AdaptiveNarrativeFlowRecorder(5, 10);
    emitLoops(recorder, 5);
    const sentences = recorder.getSentences();
    expect(sentences.filter((s) => s.includes('pass'))).toHaveLength(5);
  });

  it('samples every Nth after threshold', () => {
    const recorder = new AdaptiveNarrativeFlowRecorder(5, 10);
    emitLoops(recorder, 55);
    const sentences = recorder.getSentences();
    const loopSentences = sentences.filter((s) => s.includes('pass'));
    // 5 threshold + 5 samples (at 15, 25, 35, 45, 55) = 10
    expect(loopSentences).toHaveLength(10);
  });

  it('tracks suppressed count', () => {
    const recorder = new AdaptiveNarrativeFlowRecorder(5, 10);
    emitLoops(recorder, 55);
    // 55 total - 5 threshold - 5 samples (at 15,25,35,45,55) = 45 suppressed
    expect(recorder.getSuppressedCount()).toBe(45);
  });

  it('clears state including per-target counts', () => {
    const recorder = new AdaptiveNarrativeFlowRecorder(5, 10);
    emitLoops(recorder, 20);
    recorder.clear();
    expect(recorder.getSentences()).toEqual([]);
    expect(recorder.getSuppressedCount()).toBe(0);
  });

  it('accepts custom id', () => {
    const recorder = new AdaptiveNarrativeFlowRecorder(3, 5, 'my-adaptive');
    expect(recorder.id).toBe('my-adaptive');
  });

  it('uses custom threshold and sample rate', () => {
    const recorder = new AdaptiveNarrativeFlowRecorder(3, 5);
    emitLoops(recorder, 18);
    const sentences = recorder.getSentences();
    const loopSentences = sentences.filter((s) => s.includes('pass'));
    // 3 threshold + 3 samples (at 8, 13, 18) = 6
    expect(loopSentences).toHaveLength(6);
  });
});

// ─── MilestoneNarrativeFlowRecorder ─────────────────────────────────────────

describe('MilestoneNarrativeFlowRecorder', () => {
  it('emits first iteration and every Nth', () => {
    const recorder = new MilestoneNarrativeFlowRecorder(10);
    emitLoops(recorder, 30);
    const sentences = recorder.getSentences();
    const loopSentences = sentences.filter((s) => s.includes('pass'));
    // Iteration 1, 10, 20, 30 = 4
    expect(loopSentences).toHaveLength(4);
  });

  it('can skip first iteration', () => {
    const recorder = new MilestoneNarrativeFlowRecorder(10, false);
    emitLoops(recorder, 30);
    const sentences = recorder.getSentences();
    const loopSentences = sentences.filter((s) => s.includes('pass'));
    // 10, 20, 30 = 3
    expect(loopSentences).toHaveLength(3);
  });

  it('tracks suppressed count', () => {
    const recorder = new MilestoneNarrativeFlowRecorder(10);
    emitLoops(recorder, 30);
    expect(recorder.getSuppressedCount()).toBe(26);
  });

  it('clears state including suppressed count', () => {
    const recorder = new MilestoneNarrativeFlowRecorder(10);
    emitLoops(recorder, 30);
    recorder.clear();
    expect(recorder.getSentences()).toEqual([]);
    expect(recorder.getSuppressedCount()).toBe(0);
  });

  it('accepts custom id', () => {
    const recorder = new MilestoneNarrativeFlowRecorder(10, true, 'my-milestone');
    expect(recorder.id).toBe('my-milestone');
  });
});

// ─── SilentNarrativeFlowRecorder ────────────────────────────────────────────

describe('SilentNarrativeFlowRecorder', () => {
  it('emits no per-iteration sentences', () => {
    const recorder = new SilentNarrativeFlowRecorder();
    recorder.onStageExecuted({ stageName: 'Init' });
    emitLoops(recorder, 100);
    const sentences = recorder.getSentences();
    // Should have 1 stage + 1 summary only
    expect(sentences.filter((s) => s.includes('pass'))).toHaveLength(0);
    expect(sentences.some((s) => s.includes('Looped 100 times'))).toBe(true);
  });

  it('handles multiple loop targets', () => {
    const recorder = new SilentNarrativeFlowRecorder();
    emitLoops(recorder, 5, 'A');
    emitLoops(recorder, 3, 'B');
    const sentences = recorder.getSentences();
    expect(sentences.some((s) => s.includes('5 times through A'))).toBe(true);
    expect(sentences.some((s) => s.includes('3 times through B'))).toBe(true);
  });

  it('getLoopCounts returns per-target counts', () => {
    const recorder = new SilentNarrativeFlowRecorder();
    emitLoops(recorder, 5, 'A');
    emitLoops(recorder, 3, 'B');
    const counts = recorder.getLoopCounts();
    expect(counts.get('A')).toBe(5);
    expect(counts.get('B')).toBe(3);
  });

  it('singular "time" for count of 1', () => {
    const recorder = new SilentNarrativeFlowRecorder();
    emitLoops(recorder, 1, 'X');
    const sentences = recorder.getSentences();
    expect(sentences.some((s) => s.includes('1 time through X'))).toBe(true);
  });

  it('clears state including loop counts and order', () => {
    const recorder = new SilentNarrativeFlowRecorder();
    emitLoops(recorder, 5, 'A');
    emitLoops(recorder, 3, 'B');
    recorder.clear();
    expect(recorder.getSentences()).toEqual([]);
    expect(recorder.getLoopCounts().size).toBe(0);
  });

  it('accepts custom id', () => {
    const recorder = new SilentNarrativeFlowRecorder('my-silent');
    expect(recorder.id).toBe('my-silent');
  });
});

// ─── RLENarrativeFlowRecorder ───────────────────────────────────────────────

describe('RLENarrativeFlowRecorder', () => {
  it('collapses consecutive same-target loops', () => {
    const recorder = new RLENarrativeFlowRecorder();
    emitLoops(recorder, 50);
    const sentences = recorder.getSentences();
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toContain('50 times');
    expect(sentences[0]).toContain('passes 1–50');
  });

  it('emits normal sentence for single iteration', () => {
    const recorder = new RLENarrativeFlowRecorder();
    emitLoops(recorder, 1);
    const sentences = recorder.getSentences();
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toContain('pass 1');
  });

  it('emits single iteration with description', () => {
    const recorder = new RLENarrativeFlowRecorder();
    recorder.onLoop({ target: 'Retry', iteration: 1, description: 'retrying the request' });
    const sentences = recorder.getSentences();
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toContain('retrying the request');
    expect(sentences[0]).toContain('again');
  });

  it('handles interleaved targets as separate runs', () => {
    const recorder = new RLENarrativeFlowRecorder();
    recorder.onLoop({ target: 'A', iteration: 1 });
    recorder.onLoop({ target: 'A', iteration: 2 });
    recorder.onLoop({ target: 'B', iteration: 1 });
    recorder.onLoop({ target: 'A', iteration: 3 });
    const sentences = recorder.getSentences();
    // Run 1: A x2, Run 2: B x1, Run 3: A x1
    expect(sentences).toHaveLength(3);
  });

  it('preserves non-loop sentences', () => {
    const recorder = new RLENarrativeFlowRecorder();
    recorder.onStageExecuted({ stageName: 'Init' });
    emitLoops(recorder, 5);
    const sentences = recorder.getSentences();
    expect(sentences[0]).toContain('Init');
    expect(sentences[1]).toContain('5 times');
  });

  it('clears state including runs', () => {
    const recorder = new RLENarrativeFlowRecorder();
    emitLoops(recorder, 10);
    recorder.clear();
    expect(recorder.getSentences()).toEqual([]);
  });

  it('accepts custom id', () => {
    const recorder = new RLENarrativeFlowRecorder('my-rle');
    expect(recorder.id).toBe('my-rle');
  });
});

// ─── ProgressiveNarrativeFlowRecorder ───────────────────────────────────────

describe('ProgressiveNarrativeFlowRecorder', () => {
  it('emits at powers of 2 by default', () => {
    const recorder = new ProgressiveNarrativeFlowRecorder();
    emitLoops(recorder, 64);
    const sentences = recorder.getSentences();
    const loopSentences = sentences.filter((s) => s.includes('pass'));
    // Should emit: 1, 2, 4, 8, 16, 32, 64 = 7
    expect(loopSentences).toHaveLength(7);
  });

  it('always emits iteration 1', () => {
    const recorder = new ProgressiveNarrativeFlowRecorder();
    emitLoops(recorder, 1);
    expect(recorder.getSentences().filter((s) => s.includes('pass'))).toHaveLength(1);
  });

  it('supports custom base', () => {
    const recorder = new ProgressiveNarrativeFlowRecorder(3);
    emitLoops(recorder, 27);
    const sentences = recorder.getSentences();
    const loopSentences = sentences.filter((s) => s.includes('pass'));
    // Powers of 3: 1, 3, 9, 27 = 4
    expect(loopSentences).toHaveLength(4);
  });

  it('tracks suppressed count', () => {
    const recorder = new ProgressiveNarrativeFlowRecorder();
    emitLoops(recorder, 64);
    expect(recorder.getSuppressedCount()).toBe(57); // 64 - 7
  });

  it('clears state including suppressed count', () => {
    const recorder = new ProgressiveNarrativeFlowRecorder();
    emitLoops(recorder, 64);
    recorder.clear();
    expect(recorder.getSentences()).toEqual([]);
    expect(recorder.getSuppressedCount()).toBe(0);
  });

  it('accepts custom id', () => {
    const recorder = new ProgressiveNarrativeFlowRecorder(2, 'my-progressive');
    expect(recorder.id).toBe('my-progressive');
  });
});

// ─── SeparateNarrativeFlowRecorder ──────────────────────────────────────────

describe('SeparateNarrativeFlowRecorder', () => {
  it('keeps main narrative clean of loop sentences', () => {
    const recorder = new SeparateNarrativeFlowRecorder();
    recorder.onStageExecuted({ stageName: 'Init' });
    emitLoops(recorder, 20);
    recorder.onNext({ from: 'Init', to: 'Done' });

    const mainSentences = recorder.getSentences();
    expect(mainSentences.some((s) => s.includes('pass'))).toBe(false);
    expect(mainSentences).toHaveLength(2); // stage + next
  });

  it('captures full loop detail in separate channel', () => {
    const recorder = new SeparateNarrativeFlowRecorder();
    emitLoops(recorder, 20);

    const loopSentences = recorder.getLoopSentences();
    expect(loopSentences).toHaveLength(20);
    expect(loopSentences[0]).toContain('pass 1');
    expect(loopSentences[19]).toContain('pass 20');
  });

  it('tracks per-target loop counts', () => {
    const recorder = new SeparateNarrativeFlowRecorder();
    emitLoops(recorder, 5, 'A');
    emitLoops(recorder, 3, 'B');

    const counts = recorder.getLoopCounts();
    expect(counts.get('A')).toBe(5);
    expect(counts.get('B')).toBe(3);
  });

  it('clears both channels', () => {
    const recorder = new SeparateNarrativeFlowRecorder();
    recorder.onStageExecuted({ stageName: 'Init' });
    emitLoops(recorder, 5);
    recorder.clear();
    expect(recorder.getSentences()).toEqual([]);
    expect(recorder.getLoopSentences()).toEqual([]);
    expect(recorder.getLoopCounts().size).toBe(0);
  });

  it('formats loop sentences with description in separate channel', () => {
    const recorder = new SeparateNarrativeFlowRecorder();
    recorder.onLoop({ target: 'Retry', iteration: 1, description: 'retrying the request' });
    recorder.onLoop({ target: 'Retry', iteration: 2 });
    const loopSentences = recorder.getLoopSentences();
    expect(loopSentences[0]).toContain('retrying the request');
    expect(loopSentences[0]).toContain('again');
    expect(loopSentences[1]).toContain('pass 2 through Retry');
  });

  it('accepts custom id', () => {
    const recorder = new SeparateNarrativeFlowRecorder('my-separate');
    expect(recorder.id).toBe('my-separate');
  });
});
