import { EventLog, SharedMemory, StageContext } from '../../../../src/lib/memory';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';
import type { CommitEvent, ErrorEvent, ReadEvent, Recorder, WriteEvent } from '../../../../src/lib/scope/types';

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
      onRead: () => {
        throw new Error('boom');
      },
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

  // ── Redaction tests ──────────────────────────────────────────────────

  it('setValue with shouldRedact sends [REDACTED] to recorder onWrite', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const events: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => events.push(e) });
    scope.setValue('ssn', '123-45-6789', true);
    expect(events).toHaveLength(1);
    expect(events[0].key).toBe('ssn');
    expect(events[0].value).toBe('[REDACTED]');
    expect(events[0].redacted).toBe(true);
  });

  it('getValue of redacted key sends [REDACTED] to recorder onRead', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    scope.setValue('password', 'secret', true);
    ctx.commit();

    const events: ReadEvent[] = [];
    scope.attachRecorder({ id: 'r', onRead: (e) => events.push(e) });
    const value = scope.getValue('password');

    // Runtime gets the real value
    expect(value).toBe('secret');
    // Recorder gets redacted value
    expect(events).toHaveLength(1);
    expect(events[0].value).toBe('[REDACTED]');
    expect(events[0].redacted).toBe(true);
  });

  it('non-redacted keys are not affected', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    const writeEvents: WriteEvent[] = [];
    const readEvents: ReadEvent[] = [];
    scope.attachRecorder({
      id: 'r',
      onWrite: (e) => writeEvents.push(e),
      onRead: (e) => readEvents.push(e),
    });

    scope.setValue('name', 'Alice');
    ctx.commit();
    scope.getValue('name');

    expect(writeEvents[0].value).toBe('Alice');
    expect(writeEvents[0].redacted).toBeUndefined();
    expect(readEvents[0].value).toBe('Alice');
    expect(readEvents[0].redacted).toBeUndefined();
  });

  it('redaction persists across reads after setValue', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    scope.setValue('token', 'bearer-xyz', true);
    ctx.commit();

    const events: ReadEvent[] = [];
    scope.attachRecorder({ id: 'r', onRead: (e) => events.push(e) });

    // Read multiple times — all should be redacted
    scope.getValue('token');
    scope.getValue('token');
    expect(events).toHaveLength(2);
    expect(events[0].value).toBe('[REDACTED]');
    expect(events[1].value).toBe('[REDACTED]');
  });

  it('all recorder types see redacted values', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');

    const narrativeWrites: WriteEvent[] = [];
    const debugWrites: WriteEvent[] = [];
    scope.attachRecorder({ id: 'narrative', onWrite: (e) => narrativeWrites.push(e) });
    scope.attachRecorder({ id: 'debug', onWrite: (e) => debugWrites.push(e) });

    scope.setValue('creditCard', '4111-1111-1111-1111', true);

    expect(narrativeWrites[0].value).toBe('[REDACTED]');
    expect(debugWrites[0].value).toBe('[REDACTED]');
  });

  it('updateValue on a redacted key sends [REDACTED] to recorder', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    const events: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => events.push(e) });

    scope.setValue('config', { apiKey: 'secret' }, true);
    scope.updateValue('config', { apiKey: 'new-secret', retries: 3 });

    expect(events).toHaveLength(2);
    expect(events[0].value).toBe('[REDACTED]');
    expect(events[0].redacted).toBe(true);
    expect(events[1].value).toBe('[REDACTED]');
    expect(events[1].redacted).toBe(true);
    expect(events[1].operation).toBe('update');
  });

  it('deleteValue clears redaction status for the key', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    const readEvents: ReadEvent[] = [];
    scope.attachRecorder({ id: 'r', onRead: (e) => readEvents.push(e) });

    scope.setValue('token', 'secret', true);
    ctx.commit();
    scope.deleteValue('token');
    ctx.commit();
    scope.setValue('token', 'not-secret-anymore');
    ctx.commit();
    scope.getValue('token');

    expect(readEvents).toHaveLength(1);
    expect(readEvents[0].value).toBe('not-secret-anymore');
    expect(readEvents[0].redacted).toBeUndefined();
  });

  // ── Shared redacted keys (cross-stage) ──────────────────────────────

  it('useSharedRedactedKeys shares redaction across scope instances', () => {
    const sharedSet = new Set<string>();
    const ctx1 = makeCtx('p1', 'stage1');
    const scope1 = new ScopeFacade(ctx1, 'stage1');
    scope1.useSharedRedactedKeys(sharedSet);

    // Stage 1 marks 'password' as redacted
    scope1.setValue('password', 'secret123', true);
    ctx1.commit();

    // Stage 2 is a new scope with the same shared set
    const ctx2 = makeCtx('p1', 'stage2');
    const scope2 = new ScopeFacade(ctx2, 'stage2');
    scope2.useSharedRedactedKeys(sharedSet);

    // Pre-populate stage2's context so getValue works
    ctx2.setObject([], 'password', 'secret123');
    ctx2.commit();

    const readEvents: ReadEvent[] = [];
    scope2.attachRecorder({ id: 'r', onRead: (e) => readEvents.push(e) });
    scope2.getValue('password');

    // Stage 2 should see redacted value because shared set has 'password'
    expect(readEvents[0].value).toBe('[REDACTED]');
    expect(readEvents[0].redacted).toBe(true);
  });

  it('getRedactedKeys returns the internal set', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    scope.setValue('secret', 'val', true);
    const keys = scope.getRedactedKeys();
    expect(keys.has('secret')).toBe(true);
    expect(keys.size).toBe(1);
  });
});
