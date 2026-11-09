import { describe, expect, it } from 'vitest';

import { RedactionRule, SCOPE_PLACEHOLDER } from '../redaction.js';
import { activeRule, retainedForm } from './index.js';

describe('retained value policy', () => {
  it('whole-value redaction precedes all cloning and summarization', () => {
    const uncloneable = () => 'private';
    for (const mode of ['full', 'summary', 'off']) {
      expect(
        retainedForm({ kind: 'whole' }, uncloneable, mode, () => {
          throw new Error('must not summarize');
        }),
      ).toBe(SCOPE_PLACEHOLDER);
    }
  });

  it('scrubs fields before a summary sees them and leaves the caller value intact', () => {
    const value = { public: 'visible', secret: 'private', nested: { token: 'private' } };
    const verdict = { kind: 'fields', key: 'record', paths: ['secret', 'nested.token'] };
    let observed;
    const result = retainedForm(verdict, value, 'summary', (served) => {
      observed = served;
      return 'summary';
    });
    expect(result).toBe('summary');
    expect(observed).toEqual({ public: 'visible', secret: SCOPE_PLACEHOLDER, nested: { token: SCOPE_PLACEHOLDER } });
    expect(value).toEqual({ public: 'visible', secret: 'private', nested: { token: 'private' } });
    expect(observed).not.toBe(value);
  });

  it('full retention clones clear values and uses the already scrubbed copy for fields', () => {
    const value = { count: 3, nested: { token: 'private' } };
    const clear = retainedForm({ kind: 'clear' }, value, 'full', () => {
      throw new Error('must not summarize');
    });
    expect(clear).toEqual(value);
    expect(clear).not.toBe(value);
    expect(clear.nested).not.toBe(value.nested);
    const fields = retainedForm({ kind: 'fields', key: 'record', paths: ['nested.token'] }, value, 'full', () => {
      throw new Error('must not summarize');
    });
    expect(fields).toEqual({ count: 3, nested: { token: SCOPE_PLACEHOLDER } });
  });

  it('preserves the primitive field-scrub fallback and original clone failure', () => {
    const verdict = { kind: 'fields', key: 'count', paths: ['missing'] };
    expect(retainedForm(verdict, 0, 'summary', (value) => value)).toBe(0);
    expect(retainedForm(verdict, false, 'full', () => 'wrong')).toBe(false);
    expect(() =>
      retainedForm(
        { kind: 'clear' },
        () => 'uncloneable',
        'full',
        () => 'wrong',
      ),
    ).toThrow();
  });

  it('checks an installed rule exactly once and short-circuits an absent rule', () => {
    expect(activeRule(undefined)).toBeUndefined();
    let calls = 0;
    const inert = {
      isInert() {
        calls++;
        return true;
      },
    };
    const active = {
      isInert() {
        calls++;
        return false;
      },
    };
    expect(activeRule(inert)).toBeUndefined();
    expect(calls).toBe(1);
    expect(activeRule(active)).toBe(active);
    expect(calls).toBe(2);
    let reads = 0;
    const observed = {
      get isInert() {
        reads++;
        return () => false;
      },
    };
    expect(activeRule(observed)).toBe(observed);
    expect(reads).toBe(1);
    const rule = new RedactionRule({ keys: ['secret'] });
    expect(activeRule(rule)).toBe(rule);
  });
});
