import { z } from 'zod';
import { SharedMemory, StageContext, EventLog } from '../../../../src/lib/memory';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';
import { createProtectedScope } from '../../../../src/lib/scope/protection';
import { createScopeProxyFromZod } from '../../../../src/lib/scope/state/zod/scopeFactory';
import {
  resolveScopeProvider,
  __clearScopeResolversForTests,
} from '../../../../src/lib/scope/providers';

describe('Boundary: error conditions', () => {
  beforeEach(() => __clearScopeResolversForTests());

  it('resolveScopeProvider throws for non-function input', () => {
    expect(() => resolveScopeProvider(42)).toThrow('Unsupported scope input');
    expect(() => resolveScopeProvider('string')).toThrow('Unsupported scope input');
    expect(() => resolveScopeProvider(null)).toThrow('Unsupported scope input');
  });

  it('createProtectedScope error mode blocks all unknown props', () => {
    const scope = createProtectedScope({} as any, {
      mode: 'error',
      stageName: 'test',
      allowedInternalProperties: [],
    });
    expect(() => { (scope as any).anything = 'value'; }).toThrow('Scope Access Error');
  });

  it('createScopeProxyFromZod rejects non-Zod input', () => {
    expect(() => createScopeProxyFromZod({} as any, {} as any)).toThrow(TypeError);
  });

  it('Zod proxy throws on unknown fields', () => {
    const schema = z.object({ known: z.string() });
    const ctx = {
      getValue: () => undefined,
      setObject: () => {},
      updateObject: () => {},
    };
    const proxy = createScopeProxyFromZod(ctx, schema);
    expect(() => (proxy as any).unknown).toThrow(/Unknown field/);
  });

  it('detaching non-existent recorder is a no-op', () => {
    const ctx = new StageContext('p1', 's1', new SharedMemory(), '', new EventLog());
    const scope = new ScopeFacade(ctx, 'test');
    scope.detachRecorder('non-existent');
    expect(scope.getRecorders()).toHaveLength(0);
  });

  it('onError does not cause infinite recursion when onError throws', () => {
    const ctx = new StageContext('p1', 's1', new SharedMemory(), '', new EventLog());
    const scope = new ScopeFacade(ctx, 'test');

    scope.attachRecorder({
      id: 'bad-read',
      onRead: () => { throw new Error('read crash'); },
    });
    scope.attachRecorder({
      id: 'bad-error',
      onError: () => { throw new Error('error crash'); },
    });

    // Should not infinite loop
    expect(() => scope.getValue('x')).not.toThrow();
  });
});
