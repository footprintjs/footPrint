import { DebugRecorder } from '../../../../src/lib/scope/recorders/DebugRecorder';

describe('DebugRecorder', () => {
  it('records errors regardless of verbosity', () => {
    const rec = new DebugRecorder({ verbosity: 'minimal' });
    rec.onError({ stageName: 'a', pipelineId: 'p', timestamp: 1, error: new Error('fail'), operation: 'write' });
    expect(rec.getErrors()).toHaveLength(1);
  });

  it('records reads only in verbose mode', () => {
    const rec = new DebugRecorder({ verbosity: 'verbose' });
    rec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 1, key: 'x', value: 42 });
    expect(rec.getEntries()).toHaveLength(1);

    const minRec = new DebugRecorder({ verbosity: 'minimal' });
    minRec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 1, key: 'x', value: 42 });
    expect(minRec.getEntries()).toHaveLength(0);
  });

  it('records writes only in verbose mode', () => {
    const rec = new DebugRecorder({ verbosity: 'verbose' });
    rec.onWrite({ stageName: 'a', pipelineId: 'p', timestamp: 1, key: 'x', value: 1, operation: 'set' });
    expect(rec.getEntries()).toHaveLength(1);
    expect(rec.getEntries()[0].type).toBe('write');
  });

  it('records stage lifecycle in verbose mode', () => {
    const rec = new DebugRecorder({ verbosity: 'verbose' });
    rec.onStageStart({ stageName: 'a', pipelineId: 'p', timestamp: 1 });
    rec.onStageEnd({ stageName: 'a', pipelineId: 'p', timestamp: 2, duration: 1 });
    expect(rec.getEntries()).toHaveLength(2);
    expect(rec.getEntries()[0].type).toBe('stageStart');
    expect(rec.getEntries()[1].type).toBe('stageEnd');
  });

  it('getEntriesForStage filters by stage', () => {
    const rec = new DebugRecorder({ verbosity: 'verbose' });
    rec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 1, key: 'x', value: 1 });
    rec.onRead({ stageName: 'b', pipelineId: 'p', timestamp: 2, key: 'y', value: 2 });
    expect(rec.getEntriesForStage('a')).toHaveLength(1);
    expect(rec.getEntriesForStage('b')).toHaveLength(1);
    expect(rec.getEntriesForStage('c')).toHaveLength(0);
  });

  it('setVerbosity changes recording behavior', () => {
    const rec = new DebugRecorder({ verbosity: 'verbose' });
    rec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 1, key: 'x', value: 1 });
    rec.setVerbosity('minimal');
    rec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 2, key: 'y', value: 2 });
    expect(rec.getEntries()).toHaveLength(1);
  });

  it('clear removes all entries', () => {
    const rec = new DebugRecorder({ verbosity: 'verbose' });
    rec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 1, key: 'x', value: 1 });
    rec.clear();
    expect(rec.getEntries()).toHaveLength(0);
  });

  it('getVerbosity returns current level', () => {
    const rec = new DebugRecorder({ verbosity: 'minimal' });
    expect(rec.getVerbosity()).toBe('minimal');
    rec.setVerbosity('verbose');
    expect(rec.getVerbosity()).toBe('verbose');
  });

  it('getEntries returns a copy', () => {
    const rec = new DebugRecorder({ verbosity: 'verbose' });
    rec.onRead({ stageName: 'a', pipelineId: 'p', timestamp: 1, key: 'x', value: 1 });
    const entries = rec.getEntries();
    entries.push({ type: 'read', stageName: 'fake', timestamp: 0, data: {} });
    expect(rec.getEntries()).toHaveLength(1);
  });
});
