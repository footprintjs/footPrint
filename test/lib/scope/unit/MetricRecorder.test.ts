import { MetricRecorder } from '../../../../src/lib/scope/recorders/MetricRecorder';

describe('MetricRecorder', () => {
  it('tracks read counts per stage', () => {
    const rec = new MetricRecorder('m1');
    rec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 1, key: 'x', value: 1 });
    rec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 2, key: 'y', value: 2 });
    rec.onRead({ stageName: 'b', pipelineId: 'p', timestamp: 3, key: 'z', value: 3 });
    const metrics = rec.getMetrics();
    expect(metrics.totalReads).toBe(3);
    expect(metrics.stageMetrics.get('a')!.readCount).toBe(2);
    expect(metrics.stageMetrics.get('b')!.readCount).toBe(1);
  });

  it('tracks write counts per stage', () => {
    const rec = new MetricRecorder('m1');
    rec.onWrite({ stageName: 'a', pipelineId: 'p', timestamp: 1, key: 'x', value: 1, operation: 'set' });
    const metrics = rec.getMetrics();
    expect(metrics.totalWrites).toBe(1);
  });

  it('tracks commit counts per stage', () => {
    const rec = new MetricRecorder('m1');
    rec.onCommit({ stageName: 'a', pipelineId: 'p', timestamp: 1, mutations: [] });
    rec.onCommit({ stageName: 'a', pipelineId: 'p', timestamp: 2, mutations: [] });
    expect(rec.getMetrics().totalCommits).toBe(2);
  });

  it('tracks stage duration via onStageStart/End', () => {
    const rec = new MetricRecorder('m1');
    rec.onStageStart({ stageName: 'a', pipelineId: 'p', timestamp: 100 });
    rec.onStageEnd({ stageName: 'a', pipelineId: 'p', timestamp: 150 });
    const stage = rec.getStageMetrics('a')!;
    expect(stage.totalDuration).toBe(50);
    expect(stage.invocationCount).toBe(1);
  });

  it('uses event duration if provided', () => {
    const rec = new MetricRecorder('m1');
    rec.onStageStart({ stageName: 'a', pipelineId: 'p', timestamp: 100 });
    rec.onStageEnd({ stageName: 'a', pipelineId: 'p', timestamp: 200, duration: 75 });
    expect(rec.getStageMetrics('a')!.totalDuration).toBe(75);
  });

  it('accumulates duration over multiple invocations', () => {
    const rec = new MetricRecorder('m1');
    rec.onStageStart({ stageName: 'a', pipelineId: 'p', timestamp: 0 });
    rec.onStageEnd({ stageName: 'a', pipelineId: 'p', timestamp: 10 });
    rec.onStageStart({ stageName: 'a', pipelineId: 'p', timestamp: 20 });
    rec.onStageEnd({ stageName: 'a', pipelineId: 'p', timestamp: 35 });
    expect(rec.getStageMetrics('a')!.totalDuration).toBe(25);
    expect(rec.getStageMetrics('a')!.invocationCount).toBe(2);
  });

  it('reset clears all metrics', () => {
    const rec = new MetricRecorder('m1');
    rec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 1, key: 'x', value: 1 });
    rec.reset();
    expect(rec.getMetrics().totalReads).toBe(0);
    expect(rec.getStageMetrics('a')).toBeUndefined();
  });

  it('getStageMetrics returns copy', () => {
    const rec = new MetricRecorder('m1');
    rec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 1, key: 'x', value: 1 });
    const m1 = rec.getStageMetrics('a')!;
    m1.readCount = 999;
    expect(rec.getStageMetrics('a')!.readCount).toBe(1);
  });

  it('defaults id to "metrics" if not provided', () => {
    const rec = new MetricRecorder();
    expect(rec.id).toBe('metrics');
  });
});
