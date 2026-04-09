import { MetricRecorder } from '../../../../src/lib/scope/recorders/MetricRecorder';

/** Helper to create event with required RecorderContext fields. */
function ev(stageName: string, runtimeStageId: string, timestamp = 0) {
  return { stageName, stageId: stageName, runtimeStageId, pipelineId: 'p', timestamp };
}

describe('MetricRecorder', () => {
  it('tracks read counts per stage', () => {
    const rec = new MetricRecorder('m1');
    rec.onStageStart(ev('a', 'a#0', 1));
    rec.onRead({ ...ev('a', 'a#0', 2), key: 'x', value: 1 });
    rec.onRead({ ...ev('a', 'a#0', 3), key: 'y', value: 2 });
    rec.onStageEnd(ev('a', 'a#0', 4));

    rec.onStageStart(ev('b', 'b#1', 5));
    rec.onRead({ ...ev('b', 'b#1', 6), key: 'z', value: 3 });
    rec.onStageEnd(ev('b', 'b#1', 7));

    const metrics = rec.getMetrics();
    expect(metrics.totalReads).toBe(3);
    expect(metrics.stageMetrics.get('a')!.readCount).toBe(2);
    expect(metrics.stageMetrics.get('b')!.readCount).toBe(1);
  });

  it('tracks write counts per stage', () => {
    const rec = new MetricRecorder('m1');
    rec.onStageStart(ev('a', 'a#0', 1));
    rec.onWrite({ ...ev('a', 'a#0', 2), key: 'x', value: 1, operation: 'set' });
    rec.onStageEnd(ev('a', 'a#0', 3));
    expect(rec.getMetrics().totalWrites).toBe(1);
  });

  it('tracks commit counts per stage', () => {
    const rec = new MetricRecorder('m1');
    rec.onStageStart(ev('a', 'a#0', 1));
    rec.onCommit({ ...ev('a', 'a#0', 2), mutations: [] });
    rec.onCommit({ ...ev('a', 'a#0', 3), mutations: [] });
    rec.onStageEnd(ev('a', 'a#0', 4));
    expect(rec.getMetrics().totalCommits).toBe(2);
  });

  it('tracks stage duration via onStageStart/End', () => {
    const rec = new MetricRecorder('m1');
    rec.onStageStart(ev('a', 'a#0', 100));
    rec.onStageEnd(ev('a', 'a#0', 150));
    const stage = rec.getStageMetrics('a')!;
    expect(stage.totalDuration).toBe(50);
    expect(stage.invocationCount).toBe(1);
  });

  it('uses event duration if provided', () => {
    const rec = new MetricRecorder('m1');
    rec.onStageStart(ev('a', 'a#0', 100));
    rec.onStageEnd({ ...ev('a', 'a#0', 200), duration: 75 });
    expect(rec.getStageMetrics('a')!.totalDuration).toBe(75);
  });

  it('accumulates duration over multiple invocations (loop)', () => {
    const rec = new MetricRecorder('m1');
    // First invocation
    rec.onStageStart(ev('a', 'a#0', 0));
    rec.onStageEnd(ev('a', 'a#0', 10));
    // Second invocation (loop — different runtimeStageId)
    rec.onStageStart(ev('a', 'a#2', 20));
    rec.onStageEnd(ev('a', 'a#2', 35));

    // Per-step: each has its own duration
    expect(rec.getByKey('a#0')!.duration).toBe(10);
    expect(rec.getByKey('a#2')!.duration).toBe(15);

    // Aggregated by stageName: 10 + 15 = 25
    expect(rec.getStageMetrics('a')!.totalDuration).toBe(25);
    expect(rec.getStageMetrics('a')!.invocationCount).toBe(2);
  });

  it('reset clears all metrics', () => {
    const rec = new MetricRecorder('m1');
    rec.onStageStart(ev('a', 'a#0', 1));
    rec.onRead({ ...ev('a', 'a#0', 2), key: 'x', value: 1 });
    rec.onStageEnd(ev('a', 'a#0', 3));
    rec.reset();
    expect(rec.getMetrics().totalReads).toBe(0);
    expect(rec.getStageMetrics('a')).toBeUndefined();
  });

  it('getStageMetrics returns copy (mutation safe)', () => {
    const rec = new MetricRecorder('m1');
    rec.onStageStart(ev('a', 'a#0', 1));
    rec.onRead({ ...ev('a', 'a#0', 2), key: 'x', value: 1 });
    rec.onStageEnd(ev('a', 'a#0', 3));
    const m1 = rec.getStageMetrics('a')!;
    m1.readCount = 999;
    expect(rec.getStageMetrics('a')!.readCount).toBe(1);
  });

  it('auto-generates unique id if not provided', () => {
    const rec1 = new MetricRecorder();
    const rec2 = new MetricRecorder();
    expect(rec1.id).toMatch(/^metrics-\d+$/);
    expect(rec2.id).toMatch(/^metrics-\d+$/);
    expect(rec1.id).not.toBe(rec2.id);
  });

  it('getByKey returns per-step data for time-travel', () => {
    const rec = new MetricRecorder('m1');
    rec.onStageStart(ev('CallLLM', 'call-llm#5', 100));
    rec.onRead({ ...ev('CallLLM', 'call-llm#5', 101), key: 'messages', value: [] });
    rec.onWrite({ ...ev('CallLLM', 'call-llm#5', 102), key: 'response', value: {}, operation: 'set' });
    rec.onStageEnd(ev('CallLLM', 'call-llm#5', 110));

    const step = rec.getByKey('call-llm#5')!;
    expect(step.stageName).toBe('CallLLM');
    expect(step.readCount).toBe(1);
    expect(step.writeCount).toBe(1);
    expect(step.duration).toBe(10);
  });

  it('progressive accumulate with filterByKeys', () => {
    const rec = new MetricRecorder('m1');
    rec.onStageStart(ev('Seed', 'seed#0', 0));
    rec.onWrite({ ...ev('Seed', 'seed#0', 1), key: 'x', value: 1, operation: 'set' });
    rec.onStageEnd(ev('Seed', 'seed#0', 5));

    rec.onStageStart(ev('CallLLM', 'call-llm#1', 10));
    rec.onRead({ ...ev('CallLLM', 'call-llm#1', 11), key: 'x', value: 1 });
    rec.onWrite({ ...ev('CallLLM', 'call-llm#1', 12), key: 'response', value: {}, operation: 'set' });
    rec.onStageEnd(ev('CallLLM', 'call-llm#1', 20));

    // Progressive: up to seed only
    const atSeed = new Set(['seed#0']);
    expect(rec.accumulate((sum, m) => sum + m.writeCount, 0, atSeed)).toBe(1);
    expect(rec.accumulate((sum, m) => sum + m.duration, 0, atSeed)).toBe(5);

    // Progressive: up to CallLLM
    const atLLM = new Set(['seed#0', 'call-llm#1']);
    expect(rec.accumulate((sum, m) => sum + m.writeCount, 0, atLLM)).toBe(2);
    expect(rec.accumulate((sum, m) => sum + m.duration, 0, atLLM)).toBe(15);
  });

  it('stageFilter skips filtered stages', () => {
    const rec = new MetricRecorder({ stageFilter: (name) => name === 'CallLLM' });
    rec.onStageStart(ev('Seed', 'seed#0', 0));
    rec.onWrite({ ...ev('Seed', 'seed#0', 1), key: 'x', value: 1, operation: 'set' });
    rec.onStageEnd(ev('Seed', 'seed#0', 5));

    rec.onStageStart(ev('CallLLM', 'call-llm#1', 10));
    rec.onRead({ ...ev('CallLLM', 'call-llm#1', 11), key: 'msgs', value: [] });
    rec.onStageEnd(ev('CallLLM', 'call-llm#1', 20));

    // Seed was filtered — only CallLLM recorded
    expect(rec.size).toBe(1);
    expect(rec.getByKey('call-llm#1')).toBeDefined();
    expect(rec.getByKey('seed#0')).toBeUndefined();
    expect(rec.getMetrics().totalReads).toBe(1);
    expect(rec.getMetrics().totalWrites).toBe(0);
  });

  it('stageFilter with loop — filtered stage ignored on all invocations', () => {
    const rec = new MetricRecorder({ stageFilter: (name) => name !== 'Check' });
    rec.onStageStart(ev('Step', 'step#0', 0));
    rec.onStageEnd(ev('Step', 'step#0', 5));
    rec.onStageStart(ev('Check', 'check#1', 10));
    rec.onStageEnd(ev('Check', 'check#1', 15));
    rec.onStageStart(ev('Step', 'step#2', 20));
    rec.onStageEnd(ev('Step', 'step#2', 25));
    rec.onStageStart(ev('Check', 'check#3', 30));
    rec.onStageEnd(ev('Check', 'check#3', 35));

    // Check was filtered — only Step entries
    expect(rec.size).toBe(2);
    expect(rec.getByKey('step#0')).toBeDefined();
    expect(rec.getByKey('step#2')).toBeDefined();
    expect(rec.getByKey('check#1')).toBeUndefined();
    expect(rec.getByKey('check#3')).toBeUndefined();
  });

  it('onPause increments pauseCount', () => {
    const rec = new MetricRecorder('m1');
    rec.onStageStart(ev('Approve', 'approve#0', 0));
    rec.onPause({ ...ev('Approve', 'approve#0', 5) });
    rec.onStageEnd(ev('Approve', 'approve#0', 10));

    const step = rec.getByKey('approve#0')!;
    expect(step.pauseCount).toBe(1);
    expect(rec.getMetrics().totalPauses).toBe(1);
  });
});
