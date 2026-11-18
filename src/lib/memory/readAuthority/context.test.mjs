import { SharedMemory } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import { RedactionRule } from '../redaction.js';
import { derivePolicy, runPolicy } from '../runPolicy.js';
import * as owner from '../StageContext.js';

const context = () => new owner.StageContext('run', 'stage', 'stage', new SharedMemory());
const observe = (ctx) => owner.observeOwnedContext?.(ctx);

describe('private current native policy-carrier authority', () => {
  it('observes DEFAULT and follows actual replacement rather than a constructor mirror', () => {
    const ctx = context();
    const keys = Reflect.ownKeys(ctx);
    expect(observe(ctx)).toBe(true);
    const rule = new RedactionRule({ keys: ['private'] });
    const policy = runPolicy({}, rule);
    ctx.usePolicy(policy);
    expect(observe(ctx)).toBe(false);
    rule.setPolicy(undefined);
    expect(observe(ctx)).toBe(true);
    ctx.useRedactionRule(new RedactionRule({ fields: { data: ['secret'] } }));
    expect(observe(ctx)).toBe(false);
    ctx.usePolicy(derivePolicy(policy, { redaction: undefined }));
    expect(observe(ctx)).toBe(true);
    expect(Reflect.ownKeys(ctx)).toEqual(keys);
    expect(Object.isFrozen(ctx.getPolicy())).toBe(true);
  });

  it('propagates actual policy references through native child and next contexts', () => {
    const ctx = context();
    const rule = new RedactionRule();
    const policy = runPolicy({}, rule);
    ctx.usePolicy(policy);
    const next = ctx.createNext('', 'next', 'next');
    const child = ctx.createChild('', 'branch', 'child', 'child');
    expect(observe(next)).toBe(true);
    expect(observe(child)).toBe(true);
    rule.mark('secret');
    expect(observe(next)).toBe(false);
    expect(observe(child)).toBe(false);
    expect(child.getPolicy()).toBe(policy);
  });

  for (const inherited of ['data', 'accessor']) {
    it(`does not certify missing own policy state over inherited ${inherited} authority`, () => {
      const bare = context();
      const generated = context();
      const derived = context();
      const active = context();
      const explicit = context();
      const rule = new RedactionRule({ keys: ['private'] });
      generated.usePolicy(runPolicy());
      derived.usePolicy(derivePolicy(runPolicy(), { readTracking: 'summary' }));
      active.usePolicy(runPolicy({}, rule));
      explicit.usePolicy(derivePolicy(runPolicy(), { redaction: undefined }));
      const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'redaction');
      let calls = 0;
      let facts;
      try {
        Object.defineProperty(
          Object.prototype,
          'redaction',
          inherited === 'data'
            ? { configurable: true, value: rule }
            : {
                configurable: true,
                get() {
                  calls++;
                  return rule;
                },
              },
        );
        const actualPublicRule = bare.getRedactionRule();
        const publicActive = actualPublicRule.isInert() === false;
        const publicGetterCalls = calls;
        calls = 0;
        facts = {
          publicActive,
          publicGetterCalls,
          bare: observe(bare),
          generated: observe(generated),
          derived: observe(derived),
          active: observe(active),
          explicit: observe(explicit),
          extraGetterCalls: calls,
        };
      } finally {
        if (previous) Object.defineProperty(Object.prototype, 'redaction', previous);
        else delete Object.prototype.redaction;
      }
      expect(facts.publicActive).toBe(true);
      expect(facts.publicGetterCalls).toBe(inherited === 'accessor' ? 1 : 0);
      expect(facts.active).toBe(false);
      expect(facts.explicit).toBe(true);
      expect(facts.extraGetterCalls).toBe(0);
      expect(facts.bare).toBeUndefined();
      expect(facts.generated).toBeUndefined();
      expect(facts.derived).toBeUndefined();
    });
  }

  it('does not mint a lookalike policy or probe an unadmitted carrier', () => {
    const ctx = context();
    const rule = new RedactionRule();
    ctx.usePolicy(Object.freeze({ ...runPolicy({}, rule) }));
    expect(observe(ctx)).toBeUndefined();
    ctx.setObject([], 'public', 9);
    expect(ctx.getValue([], 'public')).toBe(9); // Structural policies retain their old value-only contract.
    let calls = 0;
    const proxy = new Proxy(runPolicy({}, rule), {
      get() {
        calls++;
        throw new Error('get');
      },
      getOwnPropertyDescriptor() {
        calls++;
        throw new Error('descriptor');
      },
      getPrototypeOf() {
        calls++;
        throw new Error('prototype');
      },
    });
    Object.defineProperty(ctx, 'policy', { value: proxy });
    expect(observe(ctx)).toBeUndefined();
    expect(calls).toBe(0);
  });

  it('never calls public Rule/policy getters or probes custom context identities', () => {
    let calls = 0;
    const ctx = context();
    for (const key of ['getPolicy', 'getRedactionRule'])
      Object.defineProperty(ctx, key, {
        get() {
          calls++;
          throw new Error(key);
        },
      });
    expect(observe(ctx)).toBeUndefined();
    const accessor = context();
    Object.defineProperty(accessor, 'policy', {
      get() {
        calls++;
        throw new Error('policy');
      },
    });
    expect(observe(accessor)).toBeUndefined();
    const proxy = new Proxy(context(), {
      getPrototypeOf() {
        calls++;
        throw new Error('prototype');
      },
      getOwnPropertyDescriptor() {
        calls++;
        throw new Error('descriptor');
      },
    });
    expect(observe(proxy)).toBeUndefined();
    class CustomContext extends owner.StageContext {}
    expect(observe(new CustomContext('r', 's', 's', new SharedMemory()))).toBeUndefined();
    const changedSubclass = new CustomContext('r', 's', 's', new SharedMemory());
    Object.setPrototypeOf(changedSubclass, owner.StageContext.prototype);
    expect(observe(changedSubclass)).toBeUndefined();
    expect(calls).toBe(0);
  });

  it('public/default: preserves borrowed reads as value-only operations', () => {
    const ctx = context();
    const rule = new RedactionRule({ keys: ['private'] });
    ctx.usePolicy(runPolicy({ readTracking: 'off' }, rule));
    const value = { count: 1 };
    ctx.setObject([], 'public', value);
    expect(ctx.getValue([], 'public')).toBe(value);
    expect(ctx.getValue([], 'public')).toBe(value);
    expect(Object.isFrozen(value)).toBe(false);
    expect(Object.hasOwn(ctx, 'path')).toBe(false);
  });
});
