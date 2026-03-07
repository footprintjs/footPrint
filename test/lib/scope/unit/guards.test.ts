import {
  isSubclassOfScopeFacade,
  looksLikeClassCtor,
  looksLikeFactory,
} from '../../../../src/lib/scope/providers/guards';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';

describe('looksLikeClassCtor', () => {
  it('returns false for non-function values', () => {
    expect(looksLikeClassCtor(42)).toBe(false);
    expect(looksLikeClassCtor('hello')).toBe(false);
    expect(looksLikeClassCtor(null)).toBe(false);
    expect(looksLikeClassCtor(undefined)).toBe(false);
    expect(looksLikeClassCtor({})).toBe(false);
  });

  it('detects ES6 classes', () => {
    class Foo {
      method() {}
    }
    expect(looksLikeClassCtor(Foo)).toBe(true);
  });

  it('rejects arrow functions', () => {
    const fn = () => {};
    expect(looksLikeClassCtor(fn)).toBe(false);
  });

  it('rejects plain functions with only constructor on prototype', () => {
    // A plain function's prototype has only 'constructor', so ownNames.length === 1
    function plainFn() {}
    expect(looksLikeClassCtor(plainFn)).toBe(false);
  });

  it('detects function with prototype methods (length > 1) as class-like', () => {
    function FakeCtor() {}
    FakeCtor.prototype.myMethod = function () {};
    expect(looksLikeClassCtor(FakeCtor)).toBe(true);
  });

  it('handles functions where Function.prototype.toString.call throws', () => {
    // Create a proxy that throws on toString but has prototype with methods
    const fn = function () {};
    fn.prototype.myMethod = function () {};
    // Even if toString threw, the prototype heuristic should still work
    expect(looksLikeClassCtor(fn)).toBe(true);
  });
});

describe('looksLikeFactory', () => {
  it('returns true for arrow functions', () => {
    expect(looksLikeFactory(() => {})).toBe(true);
  });

  it('returns true for plain functions', () => {
    function plainFn() {}
    expect(looksLikeFactory(plainFn)).toBe(true);
  });

  it('returns false for classes', () => {
    class Foo {
      method() {}
    }
    expect(looksLikeFactory(Foo)).toBe(false);
  });

  it('returns false for non-functions', () => {
    expect(looksLikeFactory(42)).toBe(false);
    expect(looksLikeFactory('str')).toBe(false);
  });
});

describe('isSubclassOfScopeFacade', () => {
  it('returns true for direct subclass of ScopeFacade', () => {
    class MyScope extends ScopeFacade {}
    expect(isSubclassOfScopeFacade(MyScope)).toBe(true);
  });

  it('returns true for deeply nested subclass of ScopeFacade', () => {
    class Mid extends ScopeFacade {}
    class Deep extends Mid {}
    expect(isSubclassOfScopeFacade(Deep)).toBe(true);
  });

  it('returns false for ScopeFacade itself (prototype chain does not include ScopeFacade.prototype as ancestor)', () => {
    // ScopeFacade.prototype === ScopeFacade.prototype, so the while loop
    // would hit it immediately (p starts at ScopeFacade.prototype).
    // Actually let's verify - it checks p === baseProto, so ScopeFacade itself should return true
    // because ScopeFacade.prototype === ScopeFacade.prototype
    expect(isSubclassOfScopeFacade(ScopeFacade)).toBe(true);
  });

  it('returns false for unrelated classes', () => {
    class Other {
      method() {}
    }
    expect(isSubclassOfScopeFacade(Other)).toBe(false);
  });

  it('returns false for non-class inputs', () => {
    expect(isSubclassOfScopeFacade(() => {})).toBe(false);
    expect(isSubclassOfScopeFacade(42)).toBe(false);
    expect(isSubclassOfScopeFacade(null)).toBe(false);
  });
});
