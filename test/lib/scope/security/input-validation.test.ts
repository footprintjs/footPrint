import { EventLog, SharedMemory, StageContext } from '../../../../src/lib/memory';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';

function makeCtx(runId = 'p1', stageName = 's1') {
  return new StageContext(runId, stageName, stageName, new SharedMemory(), '', new EventLog());
}

describe('Security: input validation', () => {
  it('getArgs with deeply nested input returns full structure', () => {
    const input = {
      user: {
        profile: {
          address: { city: 'NYC', zip: '10001' },
        },
      },
    };
    const scope = new ScopeFacade(makeCtx(), 'test', input);
    const args = scope.getArgs<typeof input>();

    expect(args.user.profile.address.city).toBe('NYC');
  });

  it('readonly blocks only own properties, not inherited', () => {
    const ctx = makeCtx();
    // Object with inherited properties
    const proto = { inherited: 'from-proto' };
    const input = Object.create(proto);
    input.own = 'direct';

    const scope = new ScopeFacade(ctx, 'test', input);

    // Own property should be blocked
    expect(() => scope.setValue('own', 'hacked')).toThrow();

    // Inherited property should NOT be blocked (hasOwnProperty check)
    expect(() => scope.setValue('inherited', 'value')).not.toThrow();
  });

  it('readOnlyValues with array does not block numeric-string keys', () => {
    const ctx = makeCtx();
    const input = [10, 20, 30]; // Arrays have own numeric keys
    const scope = new ScopeFacade(ctx, 'test', input);

    // Array indices are own properties — blocked
    expect(() => scope.setValue('0', 'hacked')).toThrow();
  });

  it('readOnlyValues with empty object does not block any writes', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test', {});

    expect(() => scope.setValue('anything', 'value')).not.toThrow();
  });

  it('large readOnlyValues object still enforces all keys', () => {
    const ctx = makeCtx();
    const input: Record<string, number> = {};
    for (let i = 0; i < 100; i++) {
      input[`key_${i}`] = i;
    }

    const scope = new ScopeFacade(ctx, 'test', input);

    // All 100 keys should be blocked
    for (let i = 0; i < 100; i++) {
      expect(() => scope.setValue(`key_${i}`, 'hacked')).toThrow();
    }

    // A non-readonly key should still work
    expect(() => scope.setValue('output', 'result')).not.toThrow();
  });

  it('readonly enforcement error message includes key name', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test', { sensitiveField: 'data' });

    expect(() => scope.setValue('sensitiveField', 'hacked')).toThrow(/sensitiveField/);
  });

  it('readonly enforcement error message suggests getArgs()', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test', { input: 'data' });

    expect(() => scope.setValue('input', 'hacked')).toThrow(/getArgs\(\)/);
  });
});
