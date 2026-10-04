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

  it('attributes overlapping reads, writes, commits, pauses and durations by event identity', () => {
    const rec = new MetricRecorder('overlap');
    rec.onStageStart(ev('A', 'a#1', 100));
    rec.onStageStart(ev('B', 'b#2', 110));
    rec.onRead({ ...ev('A', 'a#1'), key: 'seed', value: 1 });
    rec.onWrite({ ...ev('A', 'a#1'), key: 'x', value: 2, operation: 'set' });
    rec.onWrite({ ...ev('B', 'b#2'), key: 'y', value: 3, operation: 'set' });
    rec.onWrite({ ...ev('A', 'a#1'), key: 'z', value: 4, operation: 'set' });
    rec.onRead({ ...ev('B', 'b#2'), key: 'seed', value: 1 });
    rec.onCommit({ ...ev('A', 'a#1'), mutations: [] });
    rec.onPause(ev('A', 'a#1'));
    rec.onStageEnd({ ...ev('B', 'b#2', 150), duration: 7 });
    rec.onStageEnd(ev('A', 'a#1', 160));
    // Settle commits still belong to their own invocation, even after end.
    rec.onCommit({ ...ev('B', 'b#2'), mutations: [] });
    rec.onCommit({ ...ev('A', 'a#1'), mutations: [] });

    expect(rec.getByKey('a#1')).toEqual({
      stageName: 'A',
      readCount: 1,
      writeCount: 2,
      commitCount: 2,
      pauseCount: 1,
      duration: 60,
    });
    expect(rec.getByKey('b#2')).toEqual({
      stageName: 'B',
      readCount: 1,
      writeCount: 1,
      commitCount: 1,
      pauseCount: 0,
      duration: 7,
    });
    expect(rec.getMetrics()).toMatchObject({
      totalReads: 2,
      totalWrites: 3,
      totalCommits: 3,
      totalPauses: 1,
      totalDuration: 67,
    });
    expect(rec.toSnapshot().data.steps['a#1']).toEqual(rec.getByKey('a#1'));
  });

  it('keeps distinct runtime IDs separate even when display names match', () => {
    const rec = new MetricRecorder('names');
    rec.onStageStart(ev('Worker', 'outer/worker#1', 10));
    rec.onStageStart(ev('Worker', 'other/worker#2', 20));
    rec.onWrite({ ...ev('Worker', 'outer/worker#1'), key: 'x', value: 1, operation: 'set' });
    rec.onStageEnd(ev('Worker', 'outer/worker#1', 40));
    rec.onStageEnd(ev('Worker', 'other/worker#2', 60));

    expect(rec.getByKey('outer/worker#1')).toMatchObject({ writeCount: 1, duration: 30 });
    expect(rec.getByKey('other/worker#2')).toMatchObject({ writeCount: 0, duration: 40 });
    expect(rec.getStageMetrics('Worker')).toMatchObject({ writeCount: 1, totalDuration: 70, invocationCount: 2 });
  });

  it('names and counts events without a start under their own ID, never the empty or last-started key', () => {
    const rec = new MetricRecorder('partial');
    rec.onStageStart(ev('Child', 'child#1', 10));
    rec.onCommit({ ...ev('Mount', 'mount#0'), mutations: [] });
    rec.onWrite({ ...ev('Other', 'other#2'), key: 'x', value: 1, operation: 'set' });
    rec.onRead({ ...ev('Other', 'other#2'), key: 'x', value: 1 });
    rec.onPause(ev('Other', 'other#2'));
    rec.onStageEnd(ev('Other', 'other#2', 50));
    rec.onStageEnd({ ...ev('Explicit', 'explicit#3', 70), duration: 0 });

    expect(rec.getByKey('')).toBeUndefined();
    expect(rec.getByKey('child#1')).toMatchObject({ commitCount: 0, writeCount: 0 });
    expect(rec.getByKey('mount#0')).toEqual({
      stageName: 'Mount',
      readCount: 0,
      writeCount: 0,
      commitCount: 1,
      pauseCount: 0,
      duration: 0,
    });
    expect(rec.getByKey('other#2')).toEqual({
      stageName: 'Other',
      readCount: 1,
      writeCount: 1,
      commitCount: 0,
      pauseCount: 1,
      duration: 0,
    });
    expect(rec.getByKey('explicit#3')).toMatchObject({ stageName: 'Explicit', duration: 0 });
    expect(rec.size).toBe(4);
  });

  it('filters each event before creating rows or changing another accepted invocation', () => {
    const rec = new MetricRecorder({ stageFilter: (name) => name !== 'Skip' });
    rec.onStageStart(ev('A', 'a#1', 10));
    rec.onStageStart(ev('B', 'b#2', 20));
    rec.onStageStart(ev('Skip', 'skip#3', 30));
    rec.onRead({ ...ev('Skip', 'skip#3'), key: 'x', value: 1 });
    rec.onWrite({ ...ev('Skip', 'skip#3'), key: 'x', value: 2, operation: 'set' });
    rec.onCommit({ ...ev('Skip', 'skip#3'), mutations: [] });
    rec.onPause(ev('Skip', 'skip#3'));
    rec.onStageEnd(ev('Skip', 'skip#3', 100));
    rec.onWrite({ ...ev('A', 'a#1'), key: 'x', value: 3, operation: 'set' });
    rec.onStageEnd(ev('A', 'a#1', 50));
    rec.onStageEnd(ev('B', 'b#2', 80));

    expect(rec.size).toBe(2);
    expect(rec.getByKey('skip#3')).toBeUndefined();
    expect(rec.getByKey('a#1')).toMatchObject({ writeCount: 1, duration: 40 });
    expect(rec.getByKey('b#2')).toMatchObject({ writeCount: 0, duration: 60 });
    expect(rec.getMetrics()).toMatchObject({ totalReads: 0, totalWrites: 1, totalCommits: 0, totalPauses: 0 });
  });

  it('preserves retry counting and latest-start timing without stealing another active step', () => {
    const rec = new MetricRecorder('retry');
    rec.onStageStart(ev('Retry', 'retry#1', 10));
    rec.onWrite({ ...ev('Retry', 'retry#1'), key: 'x', value: 1, operation: 'set' });
    rec.onStageStart(ev('Sibling', 'sibling#2', 20));
    rec.onStageStart(ev('Retry', 'retry#1', 30));
    rec.onWrite({ ...ev('Retry', 'retry#1'), key: 'x', value: 2, operation: 'set' });
    rec.onStageEnd(ev('Sibling', 'sibling#2', 40));
    rec.onStageEnd(ev('Retry', 'retry#1', 50));

    expect(rec.getByKey('retry#1')).toMatchObject({ writeCount: 2, duration: 20 });
    expect(rec.getByKey('sibling#2')).toMatchObject({ writeCount: 0, duration: 20 });
    expect(rec.getStageMetrics('Retry')).toMatchObject({ invocationCount: 1 });
    rec.clear();
    rec.onStageEnd(ev('Retry', 'retry#1', 70));
    expect(rec.getByKey('retry#1')).toMatchObject({ stageName: 'Retry', writeCount: 0, duration: 0 });
  });

  it('retains counts when start arrives late and clears unfinished start timestamps on reset', () => {
    const rec = new MetricRecorder('late-start');
    rec.onRead({ ...ev('Late', 'late#1', 5), key: 'x', value: 1 });
    rec.onStageEnd(ev('Late', 'late#1', 10));
    rec.onStageStart(ev('Late', 'late#1', 20));
    expect(rec.getByKey('late#1')).toMatchObject({ stageName: 'Late', readCount: 1, duration: 0 });
    rec.onStageEnd({ ...ev('Late', 'late#1', 40), duration: 0 });
    expect(rec.getByKey('late#1')).toMatchObject({ readCount: 1, duration: 0 });
    rec.onStageStart(ev('Unfinished', 'unfinished#2', 50));

    rec.reset();

    expect(rec.size).toBe(0);
    rec.onStageEnd(ev('Unfinished', 'unfinished#2', 100));
    expect(rec.getByKey('unfinished#2')).toEqual({
      stageName: 'Unfinished',
      readCount: 0,
      writeCount: 0,
      commitCount: 0,
      pauseCount: 0,
      duration: 0,
    });
    expect(rec.size).toBe(1);
    expect(rec.getByKey('late#1')).toBeUndefined();
  });
});
