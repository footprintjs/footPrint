import { describe, expect, it } from 'vitest';

import type { CommitBundle } from '../../../src/lib/memory/types.js';
import { QualityRecorder } from '../../../src/lib/recorder/QualityRecorder.js';
import { formatQualityTrace, qualityTrace } from '../../../src/lib/recorder/qualityTrace.js';

function makeCommit(stageId: string, runtimeStageId: string, keysWritten: string[], idx: number): CommitBundle {
  return {
    idx,
    stage: stageId,
    stageId,
    runtimeStageId,
    trace: keysWritten.map((k) => ({ path: k, verb: 'set' as const })),
    redactedPaths: [],
    overwrite: Object.fromEntries(keysWritten.map((k) => [k, 'value'])),
    updates: {},
  };
}

function buildRecorder(
  entries: Array<{
    id: string;
    name: string;
    score: number;
    factors?: string[];
    keysRead?: string[];
    keysWritten?: string[];
  }>,
) {
  const rec = new QualityRecorder(() => ({ score: 0 })); // dummy scorer, we'll inject directly
  for (const e of entries) {
    // Manually trigger the lifecycle to populate the recorder
    rec.onStageStart({ stageName: e.name, stageId: e.name, runtimeStageId: e.id, pipelineId: 'p', timestamp: 0 });
    for (const k of e.keysRead ?? []) {
      rec.onRead({
        stageName: e.name,
        stageId: e.name,
        runtimeStageId: e.id,
        pipelineId: 'p',
        timestamp: 0,
        key: k,
        value: undefined,
      });
    }
    for (const k of e.keysWritten ?? []) {
      rec.onWrite({
        stageName: e.name,
        stageId: e.name,
        runtimeStageId: e.id,
        pipelineId: 'p',
        timestamp: 0,
        key: k,
        value: 'v',
        operation: 'set',
      });
    }
    rec.onStageEnd({ stageName: e.name, stageId: e.name, runtimeStageId: e.id, pipelineId: 'p', timestamp: 0 });
  }

  // Override scores (the dummy scorer gives 0, we want specific scores)
  // We'll rebuild with a proper scorer instead
  return rec;
}

function buildRecorderWithScores(
  entries: Array<{
    id: string;
    name: string;
    score: number;
    factors?: string[];
    keysRead?: string[];
    keysWritten?: string[];
  }>,
) {
  const idx = 0;
  const rec = new QualityRecorder((runtimeStageId, ctx) => {
    const entry = entries.find((e) => e.id === runtimeStageId);
    return { score: entry?.score ?? 1.0, factors: entry?.factors };
  });

  for (const e of entries) {
    rec.onStageStart({ stageName: e.name, stageId: e.name, runtimeStageId: e.id, pipelineId: 'p', timestamp: 0 });
    for (const k of e.keysRead ?? []) {
      rec.onRead({
        stageName: e.name,
        stageId: e.name,
        runtimeStageId: e.id,
        pipelineId: 'p',
        timestamp: 0,
        key: k,
        value: undefined,
      });
    }
    for (const k of e.keysWritten ?? []) {
      rec.onWrite({
        stageName: e.name,
        stageId: e.name,
        runtimeStageId: e.id,
        pipelineId: 'p',
        timestamp: 0,
        key: k,
        value: 'v',
        operation: 'set',
      });
    }
    rec.onStageEnd({ stageName: e.name, stageId: e.name, runtimeStageId: e.id, pipelineId: 'p', timestamp: 0 });
  }

  return rec;
}

describe('qualityTrace', () => {
  it('backtracks from a low-scoring step through the commit log', () => {
    // Pipeline: seed#0 writes creditScore → classify#1 reads creditScore, writes riskTier → decide#2 reads riskTier
    const commitLog: CommitBundle[] = [
      makeCommit('seed', 'seed#0', ['creditScore', 'dti'], 0),
      makeCommit('classify', 'classify#1', ['riskTier'], 1),
      makeCommit('decide', 'decide#2', ['decision'], 2),
    ];

    const rec = buildRecorderWithScores([
      { id: 'seed#0', name: 'Seed', score: 1.0, keysRead: [], keysWritten: ['creditScore', 'dti'] },
      { id: 'classify#1', name: 'Classify', score: 0.8, keysRead: ['creditScore', 'dti'], keysWritten: ['riskTier'] },
      {
        id: 'decide#2',
        name: 'Decide',
        score: 0.3,
        factors: ['response hallucinated'],
        keysRead: ['riskTier'],
        keysWritten: ['decision'],
      },
    ]);

    const trace = qualityTrace(commitLog, rec, 'decide#2');

    expect(trace.startId).toBe('decide#2');
    expect(trace.startScore).toBe(0.3);
    expect(trace.frames).toHaveLength(3);

    // Frame 0: decide#2 (starting point)
    expect(trace.frames[0].runtimeStageId).toBe('decide#2');
    expect(trace.frames[0].score).toBe(0.3);

    // Frame 1: classify#1 (wrote riskTier that decide read)
    expect(trace.frames[1].runtimeStageId).toBe('classify#1');
    expect(trace.frames[1].score).toBe(0.8);
    expect(trace.frames[1].linkedBy).toBe('riskTier');

    // Frame 2: seed#0 (wrote creditScore that classify read)
    expect(trace.frames[2].runtimeStageId).toBe('seed#0');
    expect(trace.frames[2].score).toBe(1.0);

    // Root cause: biggest drop is at decide#2 (0.8 → 0.3)
    expect(trace.rootCause).toBeDefined();
    expect(trace.rootCause!.frame.runtimeStageId).toBe('decide#2');
    expect(trace.rootCause!.previousFrame.runtimeStageId).toBe('classify#1');
    expect(trace.rootCause!.drop).toBeCloseTo(0.5);
  });

  it('returns empty frames for unknown startId', () => {
    const trace = qualityTrace([], new QualityRecorder(() => ({ score: 1 })), 'unknown#99');
    expect(trace.frames).toHaveLength(0);
    expect(trace.startScore).toBe(-1);
  });

  it('handles single-step pipeline', () => {
    const commitLog = [makeCommit('seed', 'seed#0', ['output'], 0)];
    const rec = buildRecorderWithScores([
      { id: 'seed#0', name: 'Seed', score: 0.9, keysRead: [], keysWritten: ['output'] },
    ]);

    const trace = qualityTrace(commitLog, rec, 'seed#0');
    expect(trace.frames).toHaveLength(1);
    expect(trace.rootCause).toBeUndefined();
  });

  it('stops when no more writers found', () => {
    const commitLog = [makeCommit('seed', 'seed#0', ['data'], 0), makeCommit('process', 'process#1', ['result'], 1)];

    const rec = buildRecorderWithScores([
      { id: 'seed#0', name: 'Seed', score: 1.0, keysRead: [], keysWritten: ['data'] },
      { id: 'process#1', name: 'Process', score: 0.5, keysRead: ['data'], keysWritten: ['result'] },
    ]);

    const trace = qualityTrace(commitLog, rec, 'process#1');
    expect(trace.frames).toHaveLength(2);
    // Stops at seed#0 because it has no keysRead
  });

  it('respects maxHops', () => {
    // Create a long chain
    const commitLog: CommitBundle[] = [];
    const entries: Array<{ id: string; name: string; score: number; keysRead: string[]; keysWritten: string[] }> = [];

    for (let i = 0; i < 10; i++) {
      const readKey = i > 0 ? `key${i - 1}` : undefined;
      const writeKey = `key${i}`;
      commitLog.push(makeCommit(`s${i}`, `s${i}#${i}`, [writeKey], i));
      entries.push({
        id: `s${i}#${i}`,
        name: `Stage${i}`,
        score: 1.0 - i * 0.1,
        keysRead: readKey ? [readKey] : [],
        keysWritten: [writeKey],
      });
    }

    const rec = buildRecorderWithScores(entries);
    const trace = qualityTrace(commitLog, rec, 's9#9', 3);

    // Should stop after 3 hops + starting frame = 4 frames
    expect(trace.frames.length).toBeLessThanOrEqual(4);
  });
});

describe('formatQualityTrace', () => {
  it('formats a trace as human-readable text', () => {
    const commitLog = [makeCommit('seed', 'seed#0', ['input'], 0), makeCommit('llm', 'llm#1', ['response'], 1)];

    const rec = buildRecorderWithScores([
      { id: 'seed#0', name: 'Seed', score: 1.0, keysRead: [], keysWritten: ['input'] },
      {
        id: 'llm#1',
        name: 'CallLLM',
        score: 0.3,
        factors: ['hallucinated'],
        keysRead: ['input'],
        keysWritten: ['response'],
      },
    ]);

    const trace = qualityTrace(commitLog, rec, 'llm#1');
    const text = formatQualityTrace(trace);

    expect(text).toContain('Quality Trace');
    expect(text).toContain('score=0.30');
    expect(text).toContain('llm#1');
    expect(text).toContain('seed#0');
    expect(text).toContain('Root cause');
    expect(text).toContain('hallucinated');
  });

  it('handles empty trace', () => {
    const trace = qualityTrace([], new QualityRecorder(() => ({ score: 1 })), 'x#0');
    const text = formatQualityTrace(trace);
    expect(text).toContain('no data');
  });
});
