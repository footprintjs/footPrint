import { describe, expect, it } from 'vitest';

import * as owner from '../redaction.js';

const { RedactionRule } = owner;
const observe = (rule) => owner.observeOwnedRule?.(rule);

describe('private original Rule state authority', () => {
  it('observes complete current state without changing the rule or shared marks', () => {
    const marks = new Set();
    const rule = new RedactionRule(undefined, marks);
    const keys = Reflect.ownKeys(rule);
    expect(observe(rule)).toBe(true);
    marks.add('secret');
    expect(observe(rule)).toBe(false);
    marks.clear();
    expect(observe(rule)).toBe(true);
    rule.inheritFields('copy', ['secret']);
    expect(observe(rule)).toBe(false);
    rule.unmark('copy');
    expect(observe(rule)).toBe(true);
    rule.setPolicy({ keys: ['unrelated'] });
    expect(observe(rule)).toBe(false);
    expect(rule.verdictOfKey('public').kind).toBe('clear');
    rule.setPolicy(undefined);
    expect(observe(rule)).toBe(true);
    expect(rule.markedKeys()).toBe(marks);
    expect(Reflect.ownKeys(rule)).toEqual(keys);
  });

  it('admits a replacement shared Set, with event-time rather than interval semantics', () => {
    const rule = new RedactionRule();
    const shared = new Set(['hidden']);
    rule.useMarkedKeys(shared);
    expect(observe(rule)).toBe(false);
    shared.clear();
    shared.add('transient');
    shared.delete('transient');
    expect(observe(rule)).toBe(true); // No unseen-history certificate.
    expect(rule.markedKeys()).toBe(shared);
  });

  it('refuses unregistered, subclass and Proxy identities before any reflection', () => {
    let calls = 0;
    const traps = {
      get() {
        calls++;
        throw new Error('get');
      },
      getPrototypeOf() {
        calls++;
        throw new Error('prototype');
      },
      getOwnPropertyDescriptor() {
        calls++;
        throw new Error('descriptor');
      },
    };
    const proxy = new Proxy(new RedactionRule(), traps);
    const revoked = Proxy.revocable(new RedactionRule(), traps);
    revoked.revoke();
    class CustomRule extends RedactionRule {}
    const changedSubclass = new CustomRule();
    Object.setPrototypeOf(changedSubclass, RedactionRule.prototype);
    for (const value of [
      proxy,
      revoked.proxy,
      new CustomRule(),
      changedSubclass,
      Object.create(RedactionRule.prototype),
      null,
      3,
    ]) {
      let result;
      expect(() => {
        result = observe(value);
      }).not.toThrow();
      expect(result).toBeUndefined();
    }
    expect(calls).toBe(0);
  });

  it('does not invoke own isInert, private-state accessors or overridden prototype authority', () => {
    let calls = 0;
    const rule = new RedactionRule();
    Object.defineProperty(rule, 'isInert', {
      get() {
        calls++;
        return () => true;
      },
    });
    expect(observe(rule)).toBeUndefined();
    const accessor = new RedactionRule();
    Object.defineProperty(accessor, 'marked', {
      get() {
        calls++;
        return new Set();
      },
    });
    expect(observe(accessor)).toBeUndefined();
    const descriptor = Object.getOwnPropertyDescriptor(RedactionRule.prototype, 'isInert');
    try {
      Object.defineProperty(RedactionRule.prototype, 'isInert', {
        ...descriptor,
        value() {
          calls++;
          return true;
        },
      });
      expect(observe(new RedactionRule())).toBeUndefined();
    } finally {
      Object.defineProperty(RedactionRule.prototype, 'isInert', descriptor);
    }
    expect(calls).toBe(0);
  });

  it('brands Sets before probing and refuses custom size authority without calling it', () => {
    let calls = 0;
    const rule = new RedactionRule();
    const proxy = new Proxy(new Set(), {
      getPrototypeOf() {
        calls++;
        throw new Error('prototype');
      },
      getOwnPropertyDescriptor() {
        calls++;
        throw new Error('descriptor');
      },
      get() {
        calls++;
        throw new Error('get');
      },
    });
    rule.useMarkedKeys(proxy);
    expect(observe(rule)).toBeUndefined();
    class CustomSet extends Set {
      get size() {
        calls++;
        return 0;
      }
    }
    rule.useMarkedKeys(new CustomSet());
    expect(observe(rule)).toBeUndefined();
    const marks = new Set();
    Object.defineProperty(marks, 'size', {
      get() {
        calls++;
        return 0;
      },
    });
    rule.useMarkedKeys(marks);
    expect(observe(rule)).toBeUndefined();
    const descriptor = Object.getOwnPropertyDescriptor(Set.prototype, 'size');
    rule.useMarkedKeys(new Set());
    try {
      Object.defineProperty(Set.prototype, 'size', {
        ...descriptor,
        get() {
          calls++;
          return 0;
        },
      });
      expect(observe(rule)).toBeUndefined();
    } finally {
      Object.defineProperty(Set.prototype, 'size', descriptor);
    }
    expect(calls).toBe(0);
  });

  it('treats malformed state and changed original-owner prototypes as unknown', () => {
    for (const [key, value] of [
      ['policyActive', 0],
      ['marked', {}],
    ]) {
      const rule = new RedactionRule();
      Object.defineProperty(rule, key, { value });
      expect(observe(rule)).toBeUndefined();
    }
    const rule = new RedactionRule();
    Object.setPrototypeOf(rule, {});
    expect(observe(rule)).toBeUndefined();
  });
});
