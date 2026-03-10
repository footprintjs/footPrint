import { EventLog, SharedMemory, StageContext } from '../../../../src/lib/memory';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';

function makeCtx(runId = 'p1', stageName = 's1') {
  return new StageContext(runId, stageName, new SharedMemory(), '', new EventLog());
}

describe('Boundary: readonly edge cases', () => {
  it('readOnlyValues as undefined — no enforcement', () => {
    const scope = new ScopeFacade(makeCtx(), 'test', undefined);
    expect(() => scope.setValue('key', 'value')).not.toThrow();
    expect(scope.getArgs()).toEqual({});
  });

  it('readOnlyValues with undefined value for a key still blocks writes', () => {
    const scope = new ScopeFacade(makeCtx(), 'test', { undef: undefined });
    expect(() => scope.setValue('undef', 'hacked')).toThrow('readonly input key "undef"');
  });

  it('readOnlyValues with symbol keys are ignored (only string keys checked)', () => {
    const sym = Symbol('test');
    const readOnly = { [sym]: 'value', strKey: 'data' } as any;
    const scope = new ScopeFacade(makeCtx(), 'test', readOnly);

    // String key is blocked
    expect(() => scope.setValue('strKey', 'hacked')).toThrow();

    // Symbol key doesn't affect string setValue (setValue takes string key)
    expect(() => scope.setValue('otherKey', 'value')).not.toThrow();
  });

  it('getArgs with no readOnlyValues always returns empty object', () => {
    const scope1 = new ScopeFacade(makeCtx(), 'test');
    const scope2 = new ScopeFacade(makeCtx(), 'test', undefined);
    const scope3 = new ScopeFacade(makeCtx(), 'test', null);

    expect(scope1.getArgs()).toEqual({});
    expect(scope2.getArgs()).toEqual({});
    // null is falsy, so getArgs returns {}
    expect(scope3.getArgs()).toEqual({});
  });

  it('getReadOnlyValues still returns raw value (backward compatibility)', () => {
    const scope1 = new ScopeFacade(makeCtx(), 'test');
    const scope2 = new ScopeFacade(makeCtx(), 'test', { key: 'value' });
    const scope3 = new ScopeFacade(makeCtx(), 'test', null);

    expect(scope1.getReadOnlyValues()).toBeUndefined();
    expect(scope2.getReadOnlyValues()).toEqual({ key: 'value' });
    expect(scope3.getReadOnlyValues()).toBeNull();
  });

  it('readonly enforcement with redaction policy — both can coexist', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test', { apiKey: 'secret' });
    scope.useRedactionPolicy({ keys: ['password'] });

    // Readonly key blocked
    expect(() => scope.setValue('apiKey', 'hacked')).toThrow();

    // Redaction policy key auto-redacted but writable
    const events: any[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => events.push(e) });
    scope.setValue('password', 'secret123');

    expect(events[0].value).toBe('[REDACTED]');
    expect(events[0].redacted).toBe(true);
  });
});
