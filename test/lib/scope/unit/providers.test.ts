import { SharedMemory, StageContext, EventLog } from '../../../../src/lib/memory';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';
import {
  toScopeFactory,
  resolveScopeProvider,
  registerScopeResolver,
  __clearScopeResolversForTests,
  looksLikeClassCtor,
  looksLikeFactory,
  isSubclassOfScopeFacade,
  makeFactoryProvider,
  makeClassProvider,
} from '../../../../src/lib/scope/providers';

function makeCtx() {
  return new StageContext('p1', 's1', new SharedMemory(), '', new EventLog());
}

describe('Guards', () => {
  it('looksLikeClassCtor detects classes', () => {
    class Foo { method() {} }
    expect(looksLikeClassCtor(Foo)).toBe(true);
  });

  it('looksLikeClassCtor rejects arrow functions', () => {
    const fn = () => {};
    expect(looksLikeClassCtor(fn)).toBe(false);
  });

  it('looksLikeFactory detects plain functions', () => {
    const fn = () => {};
    expect(looksLikeFactory(fn)).toBe(true);
  });

  it('looksLikeFactory rejects classes', () => {
    class Foo { method() {} }
    expect(looksLikeFactory(Foo)).toBe(false);
  });

  it('isSubclassOfScopeFacade detects ScopeFacade subclasses', () => {
    class MyScope extends ScopeFacade {}
    expect(isSubclassOfScopeFacade(MyScope)).toBe(true);
  });

  it('isSubclassOfScopeFacade rejects unrelated classes', () => {
    class Other { method() {} }
    expect(isSubclassOfScopeFacade(Other)).toBe(false);
  });
});

describe('Provider Factories', () => {
  it('makeFactoryProvider wraps a factory', () => {
    const factory = (ctx: any, name: string) => ({ name });
    const provider = makeFactoryProvider(factory);
    expect(provider.kind).toBe('factory');
    const scope = provider.create({} as any, 'test');
    expect(scope.name).toBe('test');
  });

  it('makeClassProvider wraps a class constructor', () => {
    class MyScope extends ScopeFacade {}
    const provider = makeClassProvider(MyScope);
    expect(provider.kind).toBe('class');
    const scope = provider.create(makeCtx(), 'test');
    expect(scope).toBeInstanceOf(MyScope);
  });
});

describe('Registry', () => {
  beforeEach(() => __clearScopeResolversForTests());

  it('resolveScopeProvider resolves factory functions', () => {
    const factory = (ctx: any, name: string) => ({ name });
    const provider = resolveScopeProvider(factory);
    expect(provider.kind).toBe('factory');
  });

  it('resolveScopeProvider resolves ScopeFacade subclasses', () => {
    class MyScope extends ScopeFacade {}
    const provider = resolveScopeProvider(MyScope);
    expect(provider.kind).toBe('class');
  });

  it('resolveScopeProvider throws for unsupported input', () => {
    expect(() => resolveScopeProvider(42)).toThrow('Unsupported scope input');
  });

  it('registerScopeResolver adds custom resolvers checked first', () => {
    const customProvider = { kind: 'custom' as const, create: () => ({ custom: true }) };
    registerScopeResolver({
      name: 'custom',
      canHandle: (input: unknown) => input === 'CUSTOM',
      makeProvider: () => customProvider,
    });
    const provider = resolveScopeProvider('CUSTOM');
    expect(provider.kind).toBe('custom');
  });
});

describe('toScopeFactory', () => {
  beforeEach(() => __clearScopeResolversForTests());

  it('converts a factory function to ScopeFactory', () => {
    const factory = (ctx: any, name: string) => ({ name });
    const scopeFactory = toScopeFactory(factory);
    const scope = scopeFactory({} as any, 'test') as any;
    expect(scope.name).toBe('test');
  });

  it('converts a class to ScopeFactory', () => {
    class MyScope extends ScopeFacade {}
    const scopeFactory = toScopeFactory(MyScope);
    const scope = scopeFactory(makeCtx(), 'test');
    expect(scope).toBeInstanceOf(MyScope);
  });
});
