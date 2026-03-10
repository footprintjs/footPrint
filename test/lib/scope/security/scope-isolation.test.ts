import { EventLog, SharedMemory, StageContext } from '../../../../src/lib/memory';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';

function makeCtx(runId = 'p1', stageName = 's1') {
  return new StageContext(runId, stageName, new SharedMemory(), '', new EventLog());
}

describe('Security: scope isolation', () => {
  it('getArgs returns a frozen shallow copy (not the original reference)', () => {
    const input = { key: 'value' };
    const scope = new ScopeFacade(makeCtx(), 'test', input);

    const args = scope.getArgs<any>();

    // Frozen copy — not the original reference
    expect(args).not.toBe(input);
    expect(args).toEqual(input);
    expect(Object.isFrozen(args)).toBe(true);
  });

  it('getArgs returns the same cached frozen instance (zero-allocation)', () => {
    const scope = new ScopeFacade(makeCtx(), 'test', { key: 'value' });

    const args1 = scope.getArgs<any>();
    const args2 = scope.getArgs<any>();

    expect(args1).toEqual(args2);
    expect(args1).toBe(args2); // same cached frozen object
    expect(Object.isFrozen(args1)).toBe(true);
  });

  it('mutating getArgs result throws in strict mode (frozen)', () => {
    const scope = new ScopeFacade(makeCtx(), 'test', { key: 'value' });
    const args = scope.getArgs<any>();

    // Object.freeze makes property assignment throw in strict mode
    expect(() => {
      args.key = 'mutated';
    }).toThrow();
  });

  it('mutating getArgs result does not affect the original readOnlyValues', () => {
    const input = { key: 'value' };
    const scope = new ScopeFacade(makeCtx(), 'test', input);

    // getArgs returns a copy, so even if freeze were bypassed,
    // the original is untouched
    const args = scope.getArgs<any>();
    try {
      args.newProp = 'test';
    } catch {
      /* frozen */
    }

    expect((scope.getReadOnlyValues() as any).key).toBe('value');
    expect((scope.getReadOnlyValues() as any).newProp).toBeUndefined();
  });

  it('scope instances from different pipelines have independent readonly values', () => {
    const input1 = { tenant: 'A' };
    const input2 = { tenant: 'B' };

    const scope1 = new ScopeFacade(makeCtx('p1', 's1'), 's1', input1);
    const scope2 = new ScopeFacade(makeCtx('p2', 's1'), 's1', input2);

    expect(scope1.getArgs<any>().tenant).toBe('A');
    expect(scope2.getArgs<any>().tenant).toBe('B');

    // Both enforce readonly
    expect(() => scope1.setValue('tenant', 'hacked')).toThrow();
    expect(() => scope2.setValue('tenant', 'hacked')).toThrow();
  });

  it('readonly enforcement does not leak into shared memory writes', () => {
    const mem = new SharedMemory();
    const log = new EventLog();
    const ctx = new StageContext('p1', 's1', mem, '', log);
    const readOnly = { apiKey: 'secret' };

    const scope = new ScopeFacade(ctx, 's1', readOnly);

    // Can't write via setValue
    expect(() => scope.setValue('apiKey', 'hacked')).toThrow();

    // But writing a different key still works
    scope.setValue('result', 'computed');
    ctx.commit();
    expect(ctx.getValue([], 'result')).toBe('computed');
  });

  it('updateValue is blocked for readonly keys', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test', { input: 'readonly' });

    expect(() => scope.updateValue('input', 'hacked')).toThrow('readonly input key "input"');
  });

  it('updateValue allows non-readonly keys', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test', { input: 'readonly' });

    expect(() => scope.updateValue('otherKey', { nested: true })).not.toThrow();
  });

  it('deleteValue is blocked for readonly keys', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test', { input: 'readonly' });

    expect(() => scope.deleteValue('input')).toThrow('readonly input key "input"');
  });

  it('deleteValue allows non-readonly keys', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test', { input: 'readonly' });

    expect(() => scope.deleteValue('otherKey')).not.toThrow();
  });
});
