import { BaseState } from '../../../src/scope/core/BaseState';
import { isSubclassOfStateScope, looksLikeClassCtor, looksLikeFactory } from '../../../src/scope/core/guards';

describe('guards', () => {
  test('looksLikeClassCtor / looksLikeFactory', () => {
    class C {}
    function f() {}
    const g = () => {};
    expect(looksLikeClassCtor(C)).toBe(true);
    expect(looksLikeFactory(C)).toBe(false);

    expect(looksLikeClassCtor(f)).toBe(false);
    expect(looksLikeFactory(f)).toBe(true);

    expect(looksLikeClassCtor(g)).toBe(false);
    expect(looksLikeFactory(g)).toBe(true);
  });

  test('isSubclassOfStateScope', () => {
    class MyScope extends BaseState {
      constructor(c: any, s: string, ro?: unknown) {
        super(c, s, ro);
      }
    }
    class NotASubclass {
      constructor(_: any, __: string, ___?: unknown) {}
    }
    expect(isSubclassOfStateScope(MyScope)).toBe(true);
    expect(isSubclassOfStateScope(NotASubclass)).toBe(false);
    expect(isSubclassOfStateScope(() => {})).toBe(false);
  });
});
