import { describe, expect, it, vi } from 'vitest';

import { decide, select } from '../../../../src/lib/decide/decide';
import { createTypedScope } from '../../../../src/lib/reactive/createTypedScope';
import type { ReactiveTarget } from '../../../../src/lib/reactive/types';
import { createProtectedScope } from '../../../../src/lib/scope/protection/createProtectedScope';
import { registerScopeRuntime, requireScopeRuntime, scopeRuntimeFor } from '../../../../src/lib/scope/runtime';

describe('scope runtime identity and capability ownership', () => {
  it('registers and resolves without invoking any user-proxy trap', () => {
    const fail = () => {
      throw new Error('proxy was inspected');
    };
    const scope = new Proxy({}, { get: fail, set: fail, ownKeys: fail, getOwnPropertyDescriptor: fail });
    const target = {};
    expect(registerScopeRuntime(scope, { target, handlesAssignments: true })).toBe(scope);
    expect(requireScopeRuntime(scope).target).toBe(target);
  });

  it('rejects an unregistered strict proxy without probing its user fields', () => {
    const scope = new Proxy(
      {},
      {
        get: () => {
          throw new Error('field probe');
        },
      },
    );
    expect(() => requireScopeRuntime(scope)).toThrow(/registerScopeRuntime/);
  });

  it('names decide()/select() — not custom scope factories — when a plain object reaches them', () => {
    const plain = { score: 1 };
    const rules = [{ when: { score: { gt: 0 } }, then: 'yes' }] as any;
    expect(() => decide(plain, rules, 'no')).toThrow(/decide\(\)\/select\(\) needs the stage's scope/);
    expect(() => select(plain, rules)).toThrow(/decide\(\)\/select\(\) needs the stage's scope/);
    expect(() => decide(plain, rules, 'no')).not.toThrow(/Custom scope factories/);
  });

  it('copies the descriptor but retains the provider-owned target', () => {
    const scope = {};
    const target = {
      value: 1,
      getValue() {
        return this.value;
      },
    };
    const options = { target, handlesAssignments: false };
    registerScopeRuntime(scope, options);
    options.handlesAssignments = true;
    target.value = 2;
    const runtime = requireScopeRuntime(scope);
    expect(runtime.handlesAssignments).toBe(false);
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(runtime.target.getValue?.()).toBe(2);
    expect(Object.isFrozen(target)).toBe(false);
  });

  it('an explicit second registration replaces only that scope binding', () => {
    const a = {};
    const b = {};
    const first = {};
    const second = {};
    registerScopeRuntime(a, { target: first, handlesAssignments: false });
    registerScopeRuntime(b, { target: first, handlesAssignments: false });
    registerScopeRuntime(a, { target: second, handlesAssignments: true });
    expect(requireScopeRuntime(a).target).toBe(second);
    expect(requireScopeRuntime(b).target).toBe(first);
  });

  it.each([null, undefined, 1, 'scope'])('refuses a non-object scope %s', (scope) => {
    expect(() => registerScopeRuntime(scope as any, { target: {}, handlesAssignments: false })).toThrow(
      /scope must be an object/,
    );
    expect(scopeRuntimeFor(scope)).toBeUndefined();
  });

  it('refuses invalid descriptor capabilities at registration', () => {
    expect(() => registerScopeRuntime({}, {} as any)).toThrow(/target port/);
    expect(() => registerScopeRuntime({}, { target: {}, handlesAssignments: false, setBreak: 1 } as any)).toThrow(
      /setBreak/,
    );
  });

  it('copies the same port through assignment protection without altering its provider', () => {
    const scope = {};
    const target = {};
    registerScopeRuntime(scope, { target, handlesAssignments: false });
    const guarded = createProtectedScope(scope);
    expect(guarded).not.toBe(scope);
    expect(requireScopeRuntime(guarded).target).toBe(target);
    expect(() => {
      (guarded as any).lost = true;
    }).toThrow(/Direct property assignment/);
    expect(createProtectedScope(scope, { mode: 'off' })).toBe(scope);
  });

  it('does not require registration for standalone protection of an ordinary object', () => {
    const guarded = createProtectedScope({ value: 1 });
    expect(guarded.value).toBe(1);
    expect(scopeRuntimeFor(guarded)).toBeUndefined();
  });

  it('typed scopes register the real target and receive break injection through the port', () => {
    const getValue = vi.fn();
    const target = { getValue } as unknown as ReactiveTarget;
    const scope = createTypedScope(target);
    const runtime = requireScopeRuntime(scope);
    const stop = vi.fn();
    expect(runtime.target).toBe(target);
    expect(runtime.handlesAssignments).toBe(true);
    runtime.setBreak?.(stop);
    scope.$break('done');
    expect(stop).toHaveBeenCalledWith('done');
    expect(getValue).not.toHaveBeenCalled();
  });
});
