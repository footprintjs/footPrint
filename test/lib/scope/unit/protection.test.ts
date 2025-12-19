import { createProtectedScope, createErrorMessage } from '../../../../src/lib/scope/protection';

describe('createProtectedScope', () => {
  it('blocks direct property assignment in error mode', () => {
    const scope = createProtectedScope({ setValue: () => {} } as any, {
      mode: 'error',
      stageName: 'test',
    });
    expect(() => { (scope as any).foo = 'bar'; }).toThrow('Scope Access Error');
  });

  it('allows assignment in warn mode (but logs)', () => {
    const warnings: string[] = [];
    const scope = createProtectedScope({ setValue: () => {} } as any, {
      mode: 'warn',
      stageName: 'test',
      logger: (msg) => warnings.push(msg),
    });
    (scope as any).foo = 'bar';
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Scope Access Error');
  });

  it('allows assignment in off mode', () => {
    const scope = createProtectedScope({} as any, { mode: 'off' });
    (scope as any).foo = 'bar';
    expect((scope as any).foo).toBe('bar');
  });

  it('allows internal properties', () => {
    const scope = createProtectedScope({} as any, {
      mode: 'error',
      stageName: 'test',
      allowedInternalProperties: ['writeBuffer'],
    });
    (scope as any).writeBuffer = {};
    expect((scope as any).writeBuffer).toBeDefined();
  });

  it('reads pass through normally', () => {
    const obj = { getValue: () => 42 };
    const scope = createProtectedScope(obj, { mode: 'error', stageName: 'test' });
    expect(scope.getValue()).toBe(42);
  });

  it('createErrorMessage includes property name and stage', () => {
    const msg = createErrorMessage('myProp', 'myStage');
    expect(msg).toContain('myProp');
    expect(msg).toContain('myStage');
    expect(msg).toContain('setValue');
  });
});
