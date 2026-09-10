/**
 * RedactionRule — the ONE owner of the verdict (memory/redaction.ts), unit.
 *
 * What a verdict says for a top-level key, for a nested path (a subflow seed
 * writes `['profile', 'auth']`), and for a `fields` policy re-based onto the
 * written path; what `retain` hands back (placeholder / scrubbed CLONE / the
 * same reference); marks; the report; the ReDoS cap.
 */

import { CLEAR, REDACTED, RedactionRule } from '../../../../src/lib/memory/redaction.js';

describe('RedactionRule — verdict', () => {
  const rule = new RedactionRule({
    keys: ['ssn'],
    patterns: [/token/i],
    fields: { profile: ['auth.secret', 'dob'], nested: ['innerKey'] },
  });

  it('is clear without a policy, and for an empty path', () => {
    expect(new RedactionRule().verdict(['anything'])).toBe(CLEAR);
    expect(rule.verdict([])).toBe(CLEAR);
  });

  it('a policy key or pattern makes the whole value secret, and names the key', () => {
    expect(rule.verdict(['ssn'])).toEqual({ kind: 'whole', key: 'ssn' });
    expect(rule.verdict(['apiToken'])).toEqual({ kind: 'whole', key: 'apiToken' });
    expect(rule.verdict(['name'])).toBe(CLEAR);
  });

  it('a nested path under a secret key is secret — the ancestor decided it', () => {
    expect(rule.verdict(['ssn', 'last4'])).toEqual({ kind: 'whole', key: 'ssn' });
    // a pattern hit on the dotted path itself
    expect(rule.verdict(['creds', 'token'])).toEqual({ kind: 'whole', key: 'creds.token' });
  });

  it('fields are relative to the top key and re-based onto a nested write', () => {
    expect(rule.verdict(['profile'])).toEqual({ kind: 'fields', key: 'profile', paths: ['auth.secret', 'dob'] });
    expect(rule.verdict(['profile', 'auth'])).toEqual({ kind: 'fields', key: 'profile', paths: ['secret'] });
    expect(rule.verdict(['profile', 'name'])).toBe(CLEAR);
  });

  it('a nested write that IS a secret field is whole — and marks that dotted path, not the top key', () => {
    expect(rule.verdict(['nested', 'innerKey'])).toEqual({ kind: 'whole', key: 'nested.innerKey' });
    expect(rule.verdict(['nested', 'ok'])).toBe(CLEAR);
  });

  it('marks are per-run declarations; unmark clears a mark but never a policy verdict', () => {
    const r = new RedactionRule({ keys: ['ssn'] });
    r.mark('card');
    expect(r.verdict(['card'])).toEqual({ kind: 'whole', key: 'card' });
    r.unmark('card');
    expect(r.verdict(['card'])).toBe(CLEAR);
    r.unmark('ssn');
    expect(r.verdict(['ssn'])).toEqual({ kind: 'whole', key: 'ssn' });
  });

  it('the marked set can be shared and swapped (the @internal sharing protocol)', () => {
    const shared = new Set<string>(['x']);
    const r = new RedactionRule(undefined, shared);
    expect(r.markedKeys()).toBe(shared);
    r.mark('y');
    expect(shared.has('y')).toBe(true);
    const other = new Set<string>();
    r.useMarkedKeys(other);
    r.mark('z');
    expect(other.has('z')).toBe(true);
    expect(shared.has('z')).toBe(false);
  });
});

describe('RedactionRule — retain', () => {
  const rule = new RedactionRule({ keys: ['ssn'], fields: { profile: ['auth.secret', 'flat.key'] } });

  it('hands back the placeholder for a whole verdict, the same reference for a clear one', () => {
    const value = { a: 1 };
    expect(rule.retain(['ssn'], '123')).toBe(REDACTED);
    expect(rule.retain(['name'], value)).toBe(value);
  });

  it('hands back a scrubbed CLONE for a fields verdict, siblings intact, source untouched', () => {
    const value = { auth: { secret: 's', scheme: 'b' }, 'flat.key': 'literal', name: 'n' };
    const kept = rule.retain(['profile'], value) as typeof value;
    expect(kept).not.toBe(value);
    expect(kept).toEqual({ auth: { secret: REDACTED, scheme: 'b' }, 'flat.key': REDACTED, name: 'n' });
    expect(value.auth.secret).toBe('s');
  });

  it('a fields verdict on a scalar keeps the scalar; a missing field is never invented', () => {
    expect(rule.retain(['profile'], 'just a string')).toBe('just a string');
    expect(rule.retain(['profile'], { name: 'n' })).toEqual({ name: 'n' });
  });

  it('retainRecord returns the same object when nothing is redacted, a shallow copy otherwise', () => {
    const clean = { name: 'n', count: 1 };
    expect(rule.retainRecord(clean)).toBe(clean);
    const mixed = { ssn: '123', name: 'n' };
    const kept = rule.retainRecord(mixed);
    expect(kept).not.toBe(mixed);
    expect(kept).toEqual({ ssn: REDACTED, name: 'n' });
    expect(mixed.ssn).toBe('123');
    expect(rule.retainRecord(null)).toBeNull();
    expect(rule.retainRecord([1, 2])).toEqual([1, 2]);
  });

  it('apply is idempotent on an already-retained value', () => {
    const verdict = rule.verdict(['profile']);
    const once = RedactionRule.apply(verdict, { auth: { secret: 's' } });
    expect(RedactionRule.apply(verdict, once)).toEqual(once);
    expect(RedactionRule.apply(rule.verdict(['ssn']), REDACTED)).toBe(REDACTED);
  });
});

describe('RedactionRule — the no-policy fast path and the mirror seed', () => {
  it('isInert: no policy entries and no marks; a mark ends it; an empty policy is inert', () => {
    expect(new RedactionRule().isInert()).toBe(true);
    expect(new RedactionRule({}).isInert()).toBe(true);
    expect(new RedactionRule({ emitPatterns: [/x/] }).isInert()).toBe(true);
    expect(new RedactionRule({ keys: ['a'] }).isInert()).toBe(false);
    expect(new RedactionRule({ fields: { a: ['b'] } }).isInert()).toBe(false);
    const r = new RedactionRule();
    r.mark('card');
    expect(r.isInert()).toBe(false);
    r.unmark('card');
    expect(r.isInert()).toBe(true);
  });

  it('verdictAt agrees with verdict for a single key and for a nested path', () => {
    const r = new RedactionRule({ keys: ['ssn'], fields: { profile: ['auth.token'] } });
    expect(r.verdictAt([], 'ssn')).toEqual(r.verdict(['ssn']));
    expect(r.verdictAt([], 'profile')).toEqual(r.verdict(['profile']));
    expect(r.verdictAt(['profile'], 'auth')).toEqual(r.verdict(['profile', 'auth']));
    expect(r.verdictAt([], 'name')).toBe(CLEAR);
  });

  it('retainState scrubs the root keys AND every run namespace, with the placeholder asked for', () => {
    const r = new RedactionRule({ keys: ['apiKey'], fields: { profile: ['auth.token'] } });
    const state = {
      apiKey: 's',
      profile: { auth: { token: 't' }, name: 'n' },
      runs: { child1: { apiKey: 'c', ok: 1 }, child2: { ok: 2 } },
    };
    const kept = r.retainState(state, 'REDACTED') as typeof state;
    expect(kept).toEqual({
      apiKey: 'REDACTED',
      profile: { auth: { token: 'REDACTED' }, name: 'n' },
      runs: { child1: { apiKey: 'REDACTED', ok: 1 }, child2: { ok: 2 } },
    });
    expect(state.apiKey).toBe('s');
    expect(state.runs.child1.apiKey).toBe('c');
    const clean = { name: 'n', runs: { c: { ok: 1 } } };
    expect(r.retainState(clean)).toBe(clean);
    expect(r.retainState(undefined)).toBeUndefined();
  });
});

describe('RedactionRule — report and guards', () => {
  it('reports marked keys, field redactions and pattern sources — never values', () => {
    const r = new RedactionRule({ keys: ['ssn'], patterns: [/pass/i], fields: { patient: ['dob'] } });
    r.mark('ssn');
    r.mark('manual');
    expect(r.report()).toEqual({
      redactedKeys: ['ssn', 'manual'],
      fieldRedactions: { patient: ['dob'] },
      patterns: ['pass'],
    });
    expect(new RedactionRule().report()).toEqual({ redactedKeys: [], fieldRedactions: {}, patterns: [] });
  });

  it('skips pattern matching past the key-length cap (ReDoS guard) but still matches exact keys', () => {
    const long = 'k'.repeat(300);
    const r = new RedactionRule({ keys: [long], patterns: [/k+$/] });
    expect(r.isKeyRedacted(long)).toBe(true);
    const r2 = new RedactionRule({ patterns: [/k+$/] });
    expect(r2.isKeyRedacted(long)).toBe(false);
    expect(r2.isKeyRedacted('kkk')).toBe(true);
  });

  it('resets a stateful global regex between tests', () => {
    const r = new RedactionRule({ patterns: [/secret/g] });
    expect(r.isKeyRedacted('secret')).toBe(true);
    expect(r.isKeyRedacted('secret')).toBe(true);
  });
});
