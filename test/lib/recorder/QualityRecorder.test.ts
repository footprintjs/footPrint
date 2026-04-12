import { describe, expect, it } from 'vitest';

import { QualityRecorder } from '../../../src/lib/recorder/QualityRecorder.js';
import type { ReadEvent, StageEvent, WriteEvent } from '../../../src/lib/scope/types.js';

function ev(stageName: string, runtimeStageId: string, duration?: number): StageEvent {
  return { stageName, stageId: stageName, runtimeStageId, pipelineId: 'p', timestamp: 0, duration };
}

function readEv(stageName: string, runtimeStageId: string, key: string): ReadEvent {
  return { stageName, stageId: stageName, runtimeStageId, pipelineId: 'p', timestamp: 0, key, value: undefined };
}

function writeEv(stageName: string, runtimeStageId: string, key: string): WriteEvent {
  return {
    stageName,
    stageId: stageName,
    runtimeStageId,
    pipelineId: 'p',
    timestamp: 0,
    key,
    value: 'v',
    operation: 'set',
  };
}

describe('QualityRecorder', () => {
  it('stores per-step quality entries via scoring function', () => {
    const rec = new QualityRecorder(() => ({ score: 0.8, factors: ['good'] }));

    rec.onStageStart(ev('Seed', 'seed#0'));
    rec.onStageEnd(ev('Seed', 'seed#0'));

    rec.onStageStart(ev('Process', 'process#1'));
    rec.onStageEnd(ev('Process', 'process#1'));

    expect(rec.size).toBe(2);
    expect(rec.getByKey('seed#0')?.score).toBe(0.8);
    expect(rec.getByKey('process#1')?.factors).toEqual(['good']);
  });

  it('tracks keys read and written', () => {
    const rec = new QualityRecorder((_, ctx) => ({
      score: ctx.keysWritten.length > 0 ? 0.9 : 0.5,
    }));

    rec.onStageStart(ev('Seed', 'seed#0'));
    rec.onRead(readEv('Seed', 'seed#0', 'input'));
    rec.onWrite(writeEv('Seed', 'seed#0', 'output'));
    rec.onWrite(writeEv('Seed', 'seed#0', 'status'));
    rec.onStageEnd(ev('Seed', 'seed#0'));

    const entry = rec.getByKey('seed#0')!;
    expect(entry.keysRead).toEqual(['input']);
    expect(entry.keysWritten).toEqual(['output', 'status']);
    expect(entry.score).toBe(0.9);
  });

  it('clamps score to 0.0–1.0', () => {
    const rec = new QualityRecorder(() => ({ score: 1.5 }));
    rec.onStageStart(ev('A', 'a#0'));
    rec.onStageEnd(ev('A', 'a#0'));
    expect(rec.getByKey('a#0')?.score).toBe(1.0);

    const rec2 = new QualityRecorder(() => ({ score: -0.3 }));
    rec2.onStageStart(ev('B', 'b#0'));
    rec2.onStageEnd(ev('B', 'b#0'));
    expect(rec2.getByKey('b#0')?.score).toBe(0.0);
  });

  it('getOverallScore averages all steps', () => {
    const scores = [1.0, 0.8, 0.6];
    let i = 0;
    const rec = new QualityRecorder(() => ({ score: scores[i++] }));

    rec.onStageStart(ev('A', 'a#0'));
    rec.onStageEnd(ev('A', 'a#0'));
    rec.onStageStart(ev('B', 'b#1'));
    rec.onStageEnd(ev('B', 'b#1'));
    rec.onStageStart(ev('C', 'c#2'));
    rec.onStageEnd(ev('C', 'c#2'));

    expect(rec.getOverallScore()).toBeCloseTo(0.8);
  });

  it('getOverallScore returns 1.0 when empty', () => {
    const rec = new QualityRecorder(() => ({ score: 0.5 }));
    expect(rec.getOverallScore()).toBe(1.0);
  });

  it('getLowest finds the lowest-scoring step', () => {
    const scores = [0.9, 0.3, 0.7];
    let i = 0;
    const rec = new QualityRecorder(() => ({ score: scores[i++] }));

    rec.onStageStart(ev('A', 'a#0'));
    rec.onStageEnd(ev('A', 'a#0'));
    rec.onStageStart(ev('B', 'b#1'));
    rec.onStageEnd(ev('B', 'b#1'));
    rec.onStageStart(ev('C', 'c#2'));
    rec.onStageEnd(ev('C', 'c#2'));

    const lowest = rec.getLowest()!;
    expect(lowest.runtimeStageId).toBe('b#1');
    expect(lowest.entry.score).toBe(0.3);
  });

  it('getScoreUpTo computes progressive quality', () => {
    const scores = [1.0, 0.6, 0.2];
    let i = 0;
    const rec = new QualityRecorder(() => ({ score: scores[i++] }));

    rec.onStageStart(ev('A', 'a#0'));
    rec.onStageEnd(ev('A', 'a#0'));
    rec.onStageStart(ev('B', 'b#1'));
    rec.onStageEnd(ev('B', 'b#1'));
    rec.onStageStart(ev('C', 'c#2'));
    rec.onStageEnd(ev('C', 'c#2'));

    expect(rec.getScoreUpTo(new Set(['a#0']))).toBe(1.0);
    expect(rec.getScoreUpTo(new Set(['a#0', 'b#1']))).toBeCloseTo(0.8);
    expect(rec.getScoreUpTo(new Set(['a#0', 'b#1', 'c#2']))).toBeCloseTo(0.6);
  });

  it('toSnapshot includes overall score and lowest step', () => {
    const scores = [1.0, 0.4];
    let i = 0;
    const rec = new QualityRecorder(() => ({ score: scores[i++] }));

    rec.onStageStart(ev('A', 'a#0'));
    rec.onStageEnd(ev('A', 'a#0'));
    rec.onStageStart(ev('B', 'b#1'));
    rec.onStageEnd(ev('B', 'b#1'));

    const snap = rec.toSnapshot();
    expect(snap.name).toBe('Quality');
    expect(snap.preferredOperation).toBe('accumulate');
    expect((snap.data as any).overallScore).toBeCloseTo(0.7);
    expect((snap.data as any).lowestStep).toBe('b#1');
  });

  it('clear resets all state', () => {
    const rec = new QualityRecorder(() => ({ score: 0.5 }));
    rec.onStageStart(ev('A', 'a#0'));
    rec.onStageEnd(ev('A', 'a#0'));
    expect(rec.size).toBe(1);

    rec.clear();
    expect(rec.size).toBe(0);
    expect(rec.getOverallScore()).toBe(1.0);
  });

  it('passes duration to scoring function', () => {
    let capturedDuration: number | undefined;
    const rec = new QualityRecorder((_, ctx) => {
      capturedDuration = ctx.duration;
      return { score: 1.0 };
    });

    rec.onStageStart(ev('A', 'a#0'));
    rec.onStageEnd(ev('A', 'a#0', 42));

    expect(capturedDuration).toBe(42);
  });

  it('supports custom id via options', () => {
    const rec = new QualityRecorder(() => ({ score: 1 }), { id: 'my-quality' });
    expect(rec.id).toBe('my-quality');
  });
});
