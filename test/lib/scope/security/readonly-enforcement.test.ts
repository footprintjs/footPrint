import { EventLog, SharedMemory, StageContext } from '../../../../src/lib/memory';
import { attachScopeMethods } from '../../../../src/lib/scope/providers/baseStateCompatible';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';

function makeCtx(runId = 'p1', stageName = 's1') {
  return new StageContext(runId, stageName, stageName, new SharedMemory(), '', new EventLog());
}

describe('Security: readonly enforcement', () => {
  // ── setValue blocks writes to readonly keys ──────────────────────────

  it('setValue throws when writing to a key that exists in readOnlyValues', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test', { apiKey: 'secret', userId: 42 });

    expect(() => scope.setValue('apiKey', 'hacked')).toThrow('Cannot write to readonly input key "apiKey"');
    expect(() => scope.setValue('userId', 99)).toThrow('Cannot write to readonly input key "userId"');
  });

  it('setValue allows writes to keys NOT in readOnlyValues', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test', { apiKey: 'secret' });

    expect(() => scope.setValue('otherKey', 'value')).not.toThrow();
    ctx.commit();
    expect(ctx.getValue([], 'otherKey')).toBe('value');
  });

  it('setValue works normally when no readOnlyValues provided', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');

    expect(() => scope.setValue('anything', 'value')).not.toThrow();
  });

  it('readonly enforcement works with falsy values in readOnlyValues', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test', { count: 0, flag: false, name: '' });

    expect(() => scope.setValue('count', 1)).toThrow('readonly input key "count"');
    expect(() => scope.setValue('flag', true)).toThrow('readonly input key "flag"');
    expect(() => scope.setValue('name', 'test')).toThrow('readonly input key "name"');
  });

  it('readonly enforcement applies to null values in readOnlyValues', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test', { nullField: null });

    expect(() => scope.setValue('nullField', 'value')).toThrow('readonly input key "nullField"');
  });

  // ── getArgs returns readonly values ──────────────────────────────────

  it('getArgs returns readonly values with correct type', () => {
    const ctx = makeCtx();
    const input = { name: 'Alice', age: 30 };
    const scope = new ScopeFacade(ctx, 'test', input);

    const args = scope.getArgs<{ name: string; age: number }>();
    expect(args.name).toBe('Alice');
    expect(args.age).toBe(30);
  });

  it('getArgs returns empty object when no readOnlyValues', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');

    const args = scope.getArgs();
    expect(args).toEqual({});
  });

  // ── Cross-stage readonly isolation ───────────────────────────────────

  it('readonly enforcement persists across multiple setValue attempts', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test', { locked: 'value' });

    expect(() => scope.setValue('locked', 'attempt1')).toThrow();
    expect(() => scope.setValue('locked', 'attempt2')).toThrow();
    expect(() => scope.setValue('locked', 'attempt3')).toThrow();

    // The readonly value is still accessible via getArgs
    expect(scope.getArgs<any>().locked).toBe('value');
  });

  it('different stages with same readOnlyContext all enforce readonly', () => {
    const readOnly = { sharedInput: 'protected' };
    const mem = new SharedMemory();
    const log = new EventLog();

    const ctx1 = new StageContext('p1', 's1', 's1', mem, '', log);
    const ctx2 = new StageContext('p1', 's2', 's2', mem, '', log);

    const scope1 = new ScopeFacade(ctx1, 's1', readOnly);
    const scope2 = new ScopeFacade(ctx2, 's2', readOnly);

    expect(() => scope1.setValue('sharedInput', 'hacked')).toThrow();
    expect(() => scope2.setValue('sharedInput', 'hacked')).toThrow();

    // Both can read via getArgs
    expect(scope1.getArgs<any>().sharedInput).toBe('protected');
    expect(scope2.getArgs<any>().sharedInput).toBe('protected');
  });

  // ── attachScopeMethods readonly enforcement ──────────────────────────

  it('attachScopeMethods enforces readonly on setValue', () => {
    const ctx = makeCtx();
    const readOnly = { secret: 'protected' };
    const target = attachScopeMethods({}, ctx, 'test', readOnly);

    expect(() => target.setValue('secret', 'hacked')).toThrow('Cannot write to readonly input key "secret"');
  });

  it('attachScopeMethods allows writes to non-readonly keys', () => {
    const ctx = makeCtx();
    const readOnly = { secret: 'protected' };
    const target = attachScopeMethods({}, ctx, 'test', readOnly);

    expect(() => target.setValue('otherKey', 'value')).not.toThrow();
  });

  it('attachScopeMethods getArgs returns readonly values', () => {
    const ctx = makeCtx();
    const readOnly = { name: 'Alice', role: 'admin' };
    const target = attachScopeMethods({}, ctx, 'test', readOnly);

    const args = target.getArgs<{ name: string; role: string }>();
    expect(args.name).toBe('Alice');
    expect(args.role).toBe('admin');
  });

  it('attachScopeMethods getArgs returns empty object when no readonly', () => {
    const ctx = makeCtx();
    const target = attachScopeMethods({}, ctx, 'test');

    expect(target.getArgs()).toEqual({});
  });

  // ── Prototype pollution protection ───────────────────────────────────

  it('readOnlyValues with __proto__ key does not pollute prototype', () => {
    const ctx = makeCtx();
    // Use Object.create(null) to safely test dangerous keys
    const readOnly = Object.create(null);
    readOnly.__proto__ = 'malicious';

    const scope = new ScopeFacade(ctx, 'test', readOnly);

    // getArgs should return the value without prototype pollution
    const args = scope.getArgs<any>();
    expect(args.__proto__).toBe('malicious');

    // But Object prototype should be unaffected
    expect(({} as any).__proto__).not.toBe('malicious');
  });

  it('readOnlyValues with constructor key blocks writes safely', () => {
    const ctx = makeCtx();
    const readOnly = { constructor: 'value' };
    const scope = new ScopeFacade(ctx, 'test', readOnly);

    // hasOwnProperty check means inherited keys don't trigger false positives
    expect(() => scope.setValue('constructor', 'hacked')).toThrow('readonly input key "constructor"');
  });

  it('readOnlyValues with toString key blocks writes safely', () => {
    const ctx = makeCtx();
    const readOnly = { toString: 'value' };
    const scope = new ScopeFacade(ctx, 'test', readOnly);

    expect(() => scope.setValue('toString', 'hacked')).toThrow('readonly input key "toString"');
  });

  // ── Non-object readOnlyValues edge cases ─────────────────────────────

  it('non-object readOnlyValues (string) does not block setValue', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test', 'just a string');

    // String has no own properties via hasOwnProperty
    expect(() => scope.setValue('length', 5)).not.toThrow();
  });

  it('non-object readOnlyValues (number) does not block setValue', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test', 42);

    expect(() => scope.setValue('anyKey', 'value')).not.toThrow();
  });

  it('non-object readOnlyValues (null) does not block setValue', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test', null);

    expect(() => scope.setValue('anyKey', 'value')).not.toThrow();
  });

  // ── updateValue / deleteValue enforcement ──────────────────────────

  it('updateValue throws when key exists in readOnlyValues', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test', { apiKey: 'secret' });

    expect(() => scope.updateValue('apiKey', 'hacked')).toThrow('Cannot write to readonly input key "apiKey"');
  });

  it('deleteValue throws when key exists in readOnlyValues', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test', { apiKey: 'secret' });

    expect(() => scope.deleteValue('apiKey')).toThrow('Cannot delete readonly input key "apiKey"');
  });

  it('updateValue allows non-readonly keys', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test', { locked: 'value' });

    expect(() => scope.updateValue('other', { data: true })).not.toThrow();
  });

  it('deleteValue allows non-readonly keys', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test', { locked: 'value' });

    expect(() => scope.deleteValue('other')).not.toThrow();
  });

  // ── getArgs returns frozen copy ───────────────────────────────────────

  it('getArgs returns a frozen shallow copy', () => {
    const input = { name: 'Alice', age: 30 };
    const scope = new ScopeFacade(makeCtx(), 'test', input);

    const args = scope.getArgs<any>();
    expect(Object.isFrozen(args)).toBe(true);
    expect(args).not.toBe(input); // copy, not reference
    expect(args).toEqual(input);
  });

  it('mutating getArgs result throws', () => {
    const scope = new ScopeFacade(makeCtx(), 'test', { key: 'value' });
    const args = scope.getArgs<any>();

    expect(() => {
      args.key = 'mutated';
    }).toThrow();
  });

  // ── Recorder sees the error, not leaked data ─────────────────────────

  it('blocked setValue does not fire onWrite to recorders', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test', { secret: 'protected' });
    const events: any[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => events.push(e) });

    expect(() => scope.setValue('secret', 'hacked')).toThrow();

    // No write event should have been emitted
    expect(events).toHaveLength(0);
  });

  it('blocked updateValue does not fire onWrite to recorders', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test', { secret: 'protected' });
    const events: any[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => events.push(e) });

    expect(() => scope.updateValue('secret', 'hacked')).toThrow();
    expect(events).toHaveLength(0);
  });

  it('blocked deleteValue does not fire onWrite to recorders', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test', { secret: 'protected' });
    const events: any[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => events.push(e) });

    expect(() => scope.deleteValue('secret')).toThrow();
    expect(events).toHaveLength(0);
  });
});
