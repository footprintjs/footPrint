import { EventLog, SharedMemory, StageContext } from '../../../../src/lib/memory';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';
import type { ReadEvent, WriteEvent } from '../../../../src/lib/scope/types';

function makeCtx(runId = 'p1', stageName = 's1') {
  return new StageContext(runId, stageName, stageName, new SharedMemory(), '', new EventLog());
}

describe('Boundary: redaction edge cases', () => {
  it('redacting the same key multiple times does not duplicate tracking', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    const events: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => events.push(e) });

    scope.setValue('secret', 'v1', true);
    scope.setValue('secret', 'v2', true);
    scope.setValue('secret', 'v3', true);

    expect(events).toHaveLength(3);
    expect(events.every((e) => e.value === '[REDACTED]')).toBe(true);
    expect(events.every((e) => e.redacted === true)).toBe(true);
  });

  it('redacting with undefined value still marks as redacted', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const events: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => events.push(e) });

    scope.setValue('empty', undefined, true);

    expect(events[0].value).toBe('[REDACTED]');
    expect(events[0].redacted).toBe(true);
  });

  it('redacting with null value still marks as redacted', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const events: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => events.push(e) });

    scope.setValue('nullable', null, true);

    expect(events[0].value).toBe('[REDACTED]');
    expect(events[0].redacted).toBe(true);
  });

  it('redacting with complex object value still shows [REDACTED]', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const events: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => events.push(e) });

    scope.setValue('credentials', { user: 'admin', pass: 'p@ss', tokens: [1, 2, 3] }, true);

    expect(events[0].value).toBe('[REDACTED]');
  });

  it('getValue without key does not trigger redaction', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    const events: ReadEvent[] = [];
    scope.attachRecorder({ id: 'r', onRead: (e) => events.push(e) });

    scope.setValue('secret', 'hidden', true);
    ctx.commit();

    // getValue() without key reads the entire context — should not be redacted
    scope.getValue();

    expect(events).toHaveLength(1);
    expect(events[0].redacted).toBeUndefined();
  });

  it('empty string key can be redacted', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    const writeEvents: WriteEvent[] = [];
    const readEvents: ReadEvent[] = [];
    scope.attachRecorder({
      id: 'r',
      onWrite: (e) => writeEvents.push(e),
      onRead: (e) => readEvents.push(e),
    });

    scope.setValue('', 'secret-empty-key', true);
    ctx.commit();
    scope.getValue('');

    expect(writeEvents[0].value).toBe('[REDACTED]');
    expect(readEvents[0].value).toBe('[REDACTED]');
  });

  it('many redacted keys (100) all tracked correctly', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    const readEvents: ReadEvent[] = [];
    scope.attachRecorder({ id: 'r', onRead: (e) => readEvents.push(e) });

    for (let i = 0; i < 100; i++) {
      scope.setValue(`secret-${i}`, `value-${i}`, true);
    }
    ctx.commit();

    for (let i = 0; i < 100; i++) {
      scope.getValue(`secret-${i}`);
    }

    expect(readEvents).toHaveLength(100);
    expect(readEvents.every((e) => e.value === '[REDACTED]')).toBe(true);
    expect(readEvents.every((e) => e.redacted === true)).toBe(true);
  });

  it('mixed redacted and non-redacted keys are isolated', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    const readEvents: ReadEvent[] = [];
    scope.attachRecorder({ id: 'r', onRead: (e) => readEvents.push(e) });

    scope.setValue('public', 'visible');
    scope.setValue('private', 'hidden', true);
    scope.setValue('also-public', 'also-visible');
    ctx.commit();

    scope.getValue('public');
    scope.getValue('private');
    scope.getValue('also-public');

    expect(readEvents[0].value).toBe('visible');
    expect(readEvents[0].redacted).toBeUndefined();
    expect(readEvents[1].value).toBe('[REDACTED]');
    expect(readEvents[1].redacted).toBe(true);
    expect(readEvents[2].value).toBe('also-visible');
    expect(readEvents[2].redacted).toBeUndefined();
  });

  it('redaction survives recorder detach/reattach cycle', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');

    scope.setValue('apiKey', 'sk-secret', true);
    ctx.commit();

    // Attach, detach, reattach a new recorder
    scope.attachRecorder({ id: 'r1' });
    scope.detachRecorder('r1');

    const readEvents: ReadEvent[] = [];
    scope.attachRecorder({ id: 'r2', onRead: (e) => readEvents.push(e) });
    scope.getValue('apiKey');

    expect(readEvents[0].value).toBe('[REDACTED]');
    expect(readEvents[0].redacted).toBe(true);
  });

  it('setValue with shouldRedact=false does not add to redacted keys', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    const readEvents: ReadEvent[] = [];
    scope.attachRecorder({ id: 'r', onRead: (e) => readEvents.push(e) });

    scope.setValue('key', 'value', false);
    ctx.commit();
    scope.getValue('key');

    expect(readEvents[0].value).toBe('value');
    expect(readEvents[0].redacted).toBeUndefined();
  });

  it('re-setting a key as redacted after it was non-redacted upgrades to redacted', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    const readEvents: ReadEvent[] = [];
    scope.attachRecorder({ id: 'r', onRead: (e) => readEvents.push(e) });

    // First set as non-redacted
    scope.setValue('token', 'public-token');
    ctx.commit();
    scope.getValue('token');
    expect(readEvents[0].value).toBe('public-token');

    // Now upgrade to redacted
    scope.setValue('token', 'secret-token', true);
    ctx.commit();
    scope.getValue('token');
    expect(readEvents[1].value).toBe('[REDACTED]');
    expect(readEvents[1].redacted).toBe(true);
  });
});
