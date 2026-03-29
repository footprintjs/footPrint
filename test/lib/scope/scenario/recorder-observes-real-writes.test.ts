import { EventLog, SharedMemory, StageContext } from '../../../../src/lib/memory';
import { DebugRecorder } from '../../../../src/lib/scope/recorders/DebugRecorder';
import { MetricRecorder } from '../../../../src/lib/scope/recorders/MetricRecorder';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';

function makeCtx(runId = 'p1', stageName = 's1') {
  return new StageContext(runId, stageName, stageName, new SharedMemory(), '', new EventLog());
}

describe('Scenario: recorder observes real writes', () => {
  it('MetricRecorder tracks reads/writes through ScopeFacade', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'process');
    const metrics = new MetricRecorder('m1');
    scope.attachRecorder(metrics);

    scope.setValue('x', 1);
    scope.setValue('y', 2);
    scope.getValue('x');
    scope.getValue('y');
    scope.getValue('z');

    const m = metrics.getMetrics();
    expect(m.totalWrites).toBe(2);
    expect(m.totalReads).toBe(3);
  });

  it('DebugRecorder captures mutations through ScopeFacade', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'process');
    const debug = new DebugRecorder({ id: 'd1', verbosity: 'verbose' });
    scope.attachRecorder(debug);

    scope.setValue('name', 'Alice');
    scope.updateValue('config', { retries: 3 });
    scope.deleteValue('tmp');

    const entries = debug.getEntries();
    expect(entries).toHaveLength(3);
    expect(entries[0].type).toBe('write');
    expect(entries[1].type).toBe('write');
    expect(entries[2].type).toBe('write');
  });

  it('multiple recorders observe same operations', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'multi');
    const metrics = new MetricRecorder('m1');
    const debug = new DebugRecorder({ id: 'd1' });

    scope.attachRecorder(metrics);
    scope.attachRecorder(debug);

    scope.setValue('key', 'value');
    scope.getValue('key');

    expect(metrics.getMetrics().totalWrites).toBe(1);
    expect(metrics.getMetrics().totalReads).toBe(1);
    expect(debug.getEntries()).toHaveLength(2);
  });

  it('detaching a recorder stops it from receiving events', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    const metrics = new MetricRecorder('m1');
    scope.attachRecorder(metrics);

    scope.setValue('a', 1);
    scope.detachRecorder('m1');
    scope.setValue('b', 2);

    expect(metrics.getMetrics().totalWrites).toBe(1);
  });

  it('stage lifecycle notifications flow through recorders', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'process');
    const metrics = new MetricRecorder('m1');
    scope.attachRecorder(metrics);

    scope.notifyStageStart();
    scope.setValue('x', 1);
    scope.getValue('x');
    scope.notifyStageEnd(50);

    const stage = metrics.getStageMetrics('process')!;
    expect(stage.invocationCount).toBe(1);
    expect(stage.totalDuration).toBe(50);
    expect(stage.writeCount).toBe(1);
    expect(stage.readCount).toBe(1);
  });
});
