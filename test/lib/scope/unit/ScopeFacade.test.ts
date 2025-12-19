import { SharedMemory, StageContext, EventLog } from '../../../../src/lib/memory';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';
import type { Recorder, ReadEvent, WriteEvent, CommitEvent, ErrorEvent } from '../../../../src/lib/scope/types';

function makeCtx(runId = 'p1', stageName = 's1') {
  const mem = new SharedMemory();
  const log = new EventLog();
  return new StageContext(runId, stageName, mem, '', log);
}

describe('ScopeFacade', () => {
  it('has a static BRAND symbol', () => {
    expect(ScopeFacade.BRAND).toBe(Symbol.for('ScopeFacade@v1'));
  });

  it('constructor sets context, stageName, and readOnlyValues', () => {
    const ctx = makeCtx();
    const ro = { foo: 'bar' };
    const scope = new ScopeFacade(ctx, 'myStage', ro);
    expect(scope.getPipelineId()).toBe('p1');
    expect(scope.getReadOnlyValues()).toBe(ro);
  });

  it('getValue reads from StageContext', () => {
    const ctx = makeCtx();
    ctx.setObject([], 'name', 'Alice');
    ctx.commit();
    const scope = new ScopeFacade(ctx, 'test');
    expect(scope.getValue('name')).toBe('Alice');
  });

  it('setValue writes to StageContext', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    scope.setValue('color', 'blue');
    ctx.commit();
    expect(ctx.getValue([], 'color')).toBe('blue');
  });

  it('updateValue merges into StageContext', () => {
    const ctx = makeCtx();
    ctx.setObject([], 'config', { a: 1 });
    ctx.commit();
    const scope = new ScopeFacade(ctx, 'test');
    scope.updateValue('config', { b: 2 });
    ctx.commit();
    const result = ctx.getValue([], 'config') as any;
    expect(result.a).toBe(1);
    expect(result.b).toBe(2);
  });

  it('deleteValue sets key to undefined', () => {
    const ctx = makeCtx();
    ctx.setObject([], 'tmp', 'data');
    ctx.commit();
    const scope = new ScopeFacade(ctx, 'test');
    scope.deleteValue('tmp');
    ctx.commit();
    expect(ctx.getValue([], 'tmp')).toBeUndefined();
  });

  it('getInitialValueFor reads from global context', () => {
    const ctx = makeCtx();
    // Set a global value (empty runId namespace)
    ctx.setGlobal('apiKey', 'secret123');
    ctx.commit();
    const scope = new ScopeFacade(ctx, 'test');
    expect(scope.getInitialValueFor('apiKey')).toBe('secret123');
  });

  it('addDebugInfo delegates to StageContext', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    scope.addDebugInfo('info', 'hello');
    expect(ctx.debug.logContext).toBeDefined();
  });

  it('addMetric delegates to StageContext', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    scope.addMetric('latency', 42);
    expect(ctx.debug.metricContext).toBeDefined();
  });

  it('addEval delegates to StageContext', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    scope.addEval('accuracy', 0.95);
    expect(ctx.debug.evalContext).toBeDefined();
  });

  it('addErrorInfo delegates to StageContext', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    scope.addErrorInfo('err', 'something failed');
    expect(ctx.debug.errorContext).toBeDefined();
  });

  // ── Recorder tests ──────────────────────────────────────────────────

  it('attachRecorder and getRecorders', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const rec: Recorder = { id: 'r1' };
    scope.attachRecorder(rec);
    expect(scope.getRecorders()).toHaveLength(1);
    expect(scope.getRecorders()[0].id).toBe('r1');
  });

  it('detachRecorder removes by id', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    scope.attachRecorder({ id: 'r1' });
    scope.attachRecorder({ id: 'r2' });
    scope.detachRecorder('r1');
    expect(scope.getRecorders()).toHaveLength(1);
    expect(scope.getRecorders()[0].id).toBe('r2');
  });

  it('getValue fires onRead on attached recorders', () => {
    const ctx = makeCtx();
    ctx.setObject([], 'x', 42);
    ctx.commit();
    const scope = new ScopeFacade(ctx, 'test');
    const events: ReadEvent[] = [];
    scope.attachRecorder({ id: 'r', onRead: (e) => events.push(e) });
    scope.getValue('x');
    expect(events).toHaveLength(1);
    expect(events[0].key).toBe('x');
    expect(events[0].value).toBe(42);
  });

  it('setValue fires onWrite on attached recorders', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const events: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => events.push(e) });
    scope.setValue('y', 'hello');
    expect(events).toHaveLength(1);
    expect(events[0].key).toBe('y');
    expect(events[0].operation).toBe('set');
  });

  it('deleteValue fires onWrite with operation delete', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const events: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => events.push(e) });
    scope.deleteValue('z');
    expect(events).toHaveLength(1);
    expect(events[0].operation).toBe('delete');
  });

  it('notifyCommit fires onCommit on recorders', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const events: CommitEvent[] = [];
    scope.attachRecorder({ id: 'r', onCommit: (e) => events.push(e) });
    scope.notifyCommit([{ key: 'a', value: 1, operation: 'set' }]);
    expect(events).toHaveLength(1);
    expect(events[0].mutations).toHaveLength(1);
  });

  it('notifyStageStart/End fires onStageStart/End', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const starts: any[] = [];
    const ends: any[] = [];
    scope.attachRecorder({
      id: 'r',
      onStageStart: (e) => starts.push(e),
      onStageEnd: (e) => ends.push(e),
    });
    scope.notifyStageStart();
    scope.notifyStageEnd(100);
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(ends[0].duration).toBe(100);
  });

  it('recorder errors are caught and forwarded to onError', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const errors: ErrorEvent[] = [];
    scope.attachRecorder({
      id: 'bad',
      onRead: () => { throw new Error('boom'); },
    });
    scope.attachRecorder({
      id: 'catcher',
      onError: (e) => errors.push(e),
    });
    // Should not throw
    scope.getValue('x');
    expect(errors).toHaveLength(1);
    expect(errors[0].error.message).toBe('boom');
    expect(errors[0].operation).toBe('read');
  });

  it('subclass is detected by BRAND', () => {
    class MyScope extends ScopeFacade {}
    expect((MyScope as any).BRAND).toBe(Symbol.for('ScopeFacade@v1'));
  });

  it('getRecorders returns a copy', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    scope.attachRecorder({ id: 'r1' });
    const list = scope.getRecorders();
    list.push({ id: 'r2' });
    expect(scope.getRecorders()).toHaveLength(1);
  });

  // ── Uncovered line 82: addDebugMessage ──────────────────────────────

  it('addDebugMessage delegates to StageContext.addLog with messages key', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    scope.addDebugMessage('hello world');
    // addLog('messages', [value]) should have been called
    expect(ctx.debug.logContext).toBeDefined();
  });

  // ── Uncovered lines 171-179: setGlobal, getGlobal, setObjectInRoot ──

  it('setGlobal delegates to StageContext.setGlobal', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    scope.setGlobal('apiKey', 'secret123');
    ctx.commit();
    expect(ctx.getGlobal('apiKey')).toBe('secret123');
  });

  it('getGlobal delegates to StageContext.getGlobal', () => {
    const ctx = makeCtx();
    ctx.setGlobal('token', 'abc');
    ctx.commit();
    const scope = new ScopeFacade(ctx, 'test');
    expect(scope.getGlobal('token')).toBe('abc');
  });

  it('setObjectInRoot delegates to StageContext.setRoot', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    // setObjectInRoot calls ctx.setRoot which sets on the root of the shared memory
    expect(() => scope.setObjectInRoot('rootKey', { nested: true })).not.toThrow();
  });

  it('setGlobal with description parameter', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    scope.setGlobal('setting', 42, 'set the setting');
    ctx.commit();
    expect(ctx.getGlobal('setting')).toBe(42);
  });
});
