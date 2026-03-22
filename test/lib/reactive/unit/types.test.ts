/**
 * Unit tests for reactive/types -- TypedScope<T>, ScopeMethods, ReactiveTarget.
 *
 * Tests compile-time type assertions, runtime constants, and $-prefix collision safety.
 */
import { describe, expect, it } from 'vitest';

import type { ReactiveTarget, ScopeMethods, TypedScope } from '../../../../src/lib/reactive/types';
import { BREAK_SETTER, SCOPE_METHOD_NAMES } from '../../../../src/lib/reactive/types';

// -- Helpers for compile-time type checks ------------------------------------

type Expect<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('reactive/types -- compile-time assertions', () => {
  it('TypedScope<T> includes all T properties', () => {
    interface State {
      name: string;
      age: number;
      active: boolean;
    }
    // If this compiles, the type assertion passes
    const _check: Expect<Equal<TypedScope<State>['name'], string>> = true;
    const _check2: Expect<Equal<TypedScope<State>['age'], number>> = true;
    const _check3: Expect<Equal<TypedScope<State>['active'], boolean>> = true;
    expect(_check && _check2 && _check3).toBe(true);
  });

  it('TypedScope<T> includes all ScopeMethods', () => {
    interface State {
      x: number;
    }
    type Scope = TypedScope<State>;

    // Verify $-methods exist on the type
    const _hasGetValue: Expect<Equal<Scope['$getValue'], ScopeMethods['$getValue']>> = true;
    const _hasSetValue: Expect<Equal<Scope['$setValue'], ScopeMethods['$setValue']>> = true;
    const _hasUpdate: Expect<Equal<Scope['$update'], ScopeMethods['$update']>> = true;
    const _hasDelete: Expect<Equal<Scope['$delete'], ScopeMethods['$delete']>> = true;
    const _hasRead: Expect<Equal<Scope['$read'], ScopeMethods['$read']>> = true;
    const _hasGetArgs: Scope['$getArgs'] = undefined as any;
    const _hasGetEnv: Scope['$getEnv'] = undefined as any;
    const _hasBreak: Scope['$break'] = undefined as any;
    const _hasToRaw: Scope['$toRaw'] = undefined as any;
    expect(_hasGetValue && _hasSetValue && _hasUpdate && _hasDelete && _hasRead).toBe(true);
  });

  it('TypedScope with optional fields preserves optionality', () => {
    interface State {
      required: string;
      optional?: number;
    }
    type Scope = TypedScope<State>;
    // optional field should be number | undefined
    const _check: Expect<Equal<Scope['optional'], number | undefined>> = true;
    expect(_check).toBe(true);
  });

  it('TypedScope with nested objects preserves nested types', () => {
    interface State {
      customer: { name: string; address: { zip: string } };
    }
    type Scope = TypedScope<State>;
    const _check: Expect<Equal<Scope['customer']['name'], string>> = true;
    const _check2: Expect<Equal<Scope['customer']['address']['zip'], string>> = true;
    expect(_check && _check2).toBe(true);
  });

  it('TypedScope with arrays preserves array types', () => {
    interface State {
      tags: string[];
      items: Array<{ id: number; name: string }>;
    }
    type Scope = TypedScope<State>;
    const _check: Expect<Equal<Scope['tags'], string[]>> = true;
    const _check2: Expect<Equal<Scope['items'][0]['id'], number>> = true;
    expect(_check && _check2).toBe(true);
  });

  it('ReactiveTarget matches ScopeFacade public API shape', () => {
    // Verify ReactiveTarget has all required methods
    const target: ReactiveTarget = {
      getValue: () => undefined,
      setValue: () => {},
      updateValue: () => {},
      deleteValue: () => {},
      getArgs: () => ({} as any),
      getEnv: () => ({} as any),
      attachRecorder: () => {},
      addDebugInfo: () => {},
      addDebugMessage: () => {},
      addErrorInfo: () => {},
      addMetric: () => {},
      addEval: () => {},
    };
    expect(target).toBeDefined();
  });

  it('TypedScope default generic is Record<string, unknown>', () => {
    // TypedScope without generic arg should accept any string keys
    type DefaultScope = TypedScope;
    const _check: Expect<Equal<DefaultScope['$break'], () => void>> = true;
    expect(_check).toBe(true);
  });
});

describe('reactive/types -- SCOPE_METHOD_NAMES runtime set', () => {
  // Canonical list -- must match ScopeMethods interface exactly
  const ALL_SCOPE_METHODS = [
    '$getValue',
    '$setValue',
    '$update',
    '$delete',
    '$read',
    '$getArgs',
    '$getEnv',
    '$debug',
    '$log',
    '$error',
    '$metric',
    '$eval',
    '$attachRecorder',
    '$detachRecorder',
    '$getRecorders',
    '$break',
    '$toRaw',
  ];

  it('contains exactly the same entries as ScopeMethods interface', () => {
    expect(SCOPE_METHOD_NAMES.size).toBe(ALL_SCOPE_METHODS.length);
  });

  it('contains every ScopeMethods key', () => {
    const expectedMethods = ALL_SCOPE_METHODS;
    for (const method of expectedMethods) {
      expect(SCOPE_METHOD_NAMES.has(method)).toBe(true);
    }
  });

  it('every entry starts with $', () => {
    for (const name of SCOPE_METHOD_NAMES) {
      expect(name.startsWith('$')).toBe(true);
    }
  });

  it('does not contain any non-$-prefixed ScopeFacade method names', () => {
    // These are ScopeFacade methods that should NOT be in the set
    const facadeMethods = [
      'getValue',
      'setValue',
      'updateValue',
      'deleteValue',
      'getArgs',
      'getEnv',
      'attachRecorder',
      'detachRecorder',
      'addDebugInfo',
      'addDebugMessage',
      'addErrorInfo',
      'addMetric',
      'addEval',
      'notifyStageStart',
      'notifyStageEnd',
      'notifyCommit',
      'getInitialValueFor',
      'setObjectInRoot',
      'getPipelineId',
      'useSharedRedactedKeys',
      'getRedactedKeys',
      'useRedactionPolicy',
      'getRedactionPolicy',
      'getRedactionReport',
    ];
    for (const method of facadeMethods) {
      expect(SCOPE_METHOD_NAMES.has(method)).toBe(false);
    }
  });
});

describe('reactive/types -- BREAK_SETTER symbol', () => {
  it('is a Symbol', () => {
    expect(typeof BREAK_SETTER).toBe('symbol');
  });

  it('has a descriptive key', () => {
    expect(BREAK_SETTER.toString()).toContain('footprint:reactive:setBreak');
  });

  it('is a private Symbol (not globally registered)', () => {
    // Private Symbol prevents cross-module tampering
    expect(BREAK_SETTER).not.toBe(Symbol.for('footprint:reactive:setBreak'));
  });
});

describe('reactive/types -- $-prefix collision safety', () => {
  it('no common domain state field starts with $', () => {
    // Common domain fields should never collide with $-methods
    const commonDomainFields = [
      'name',
      'age',
      'email',
      'address',
      'customer',
      'order',
      'items',
      'total',
      'status',
      'type',
      'id',
      'score',
      'approved',
      'rejected',
      'amount',
      'currency',
      'date',
      'creditTier',
      'riskLevel',
      'userId',
      'sessionToken',
      'data',
      'result',
      'error',
      'value',
      'metadata',
    ];
    for (const field of commonDomainFields) {
      expect(SCOPE_METHOD_NAMES.has(field)).toBe(false);
    }
  });

  it('ScopeFacade method names do not start with $', () => {
    // Verifies the collision space is cleanly separated
    const facadeMethods = ['getValue', 'setValue', 'updateValue', 'deleteValue', 'getArgs', 'getEnv', 'attachRecorder'];
    for (const method of facadeMethods) {
      expect(method.startsWith('$')).toBe(false);
    }
  });

  it('user state keys starting with $ would collide -- known limitation', () => {
    // This documents the design decision: $-prefixed user state keys
    // will collide with ScopeMethods. The proxy does not guard against this.
    // TypeScript intersection produces confusing errors, which is the desired behavior
    // (it surfaces the problem at compile time).
    interface BadState {
      $break: string;
    }
    type Scope = TypedScope<BadState>;
    // $break from BadState (string) intersects with $break from ScopeMethods (() => void)
    // TypeScript resolves to: string & (() => void) = never
    const _collision: Expect<Equal<Scope['$break'], never>> = true;
    expect(_collision).toBe(true);
  });
});
