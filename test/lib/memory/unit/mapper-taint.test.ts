/**
 * MapperTaint — the restored redaction law at a subflow mapper boundary
 * (owner ruling (a), gap 3). A key a mapper writes inherits the redaction of
 * the SELECTED value it copied: EXACT for an object passed by reference,
 * CONSERVATIVE (whole) for anything computed after a selected read. Never by
 * value equality.
 */
import { describe, expect, it } from 'vitest';

import { MapperTaint, RedactionRule } from '../../../../src/lib/memory/redaction.js';

const MASK = '[REDACTED]';

function map(rule: RedactionRule, record: Record<string, unknown>, mapper: (p: any) => unknown) {
  const taint = MapperTaint.of(rule)!;
  return taint.inherit(mapper(taint.watch(record)));
}

describe('MapperTaint', () => {
  it('is absent while the rule is inert — the mapper gets the record itself', () => {
    expect(MapperTaint.of(undefined)).toBeUndefined();
    expect(MapperTaint.of(new RedactionRule())).toBeUndefined();
    expect(MapperTaint.of(new RedactionRule({ diagnostics: { keys: ['logs.x'] } }))).toBeUndefined();
  });

  it('CONSERVATIVE: anything computed after reading a selected key is selected whole', () => {
    const rule = new RedactionRule({ keys: ['token'] });
    map(rule, { token: 'sk', n: 1, cfg: { a: 1 } }, (p) => ({ tok: p.token, n: p.n, len: String(p.token).length }));
    for (const key of ['tok', 'n', 'len']) expect(rule.retain([key], 'v')).toBe(MASK);
  });

  it('EXACT: an object passed by reference keeps its own verdict — clear stays clear, whole stays whole', () => {
    const rule = new RedactionRule({ keys: ['secretCfg'] });
    const cfg = { a: 1 };
    const secretCfg = { b: 2 };
    const out = map(rule, { cfg, secretCfg, token: 'x' }, (p) => ({ c: p.cfg, s: p.secretCfg })) as any;
    expect(out.c).toBe(cfg);
    expect(rule.retain(['c'], cfg)).toBe(cfg);
    expect(rule.retain(['s'], secretCfg)).toBe(MASK);
  });

  it('reads nothing selected → inherits nothing (equal values are never matched)', () => {
    const rule = new RedactionRule({ keys: ['token'] });
    map(rule, { token: 'same', other: 'same' }, (p) => ({ copy: p.other }));
    expect(rule.retain(['copy'], 'same')).toBe('same');
    expect(rule.isInert()).toBe(false);
  });

  it('a `fields` record passed by reference hands its fields to the new key; the view is swapped back', () => {
    const rule = new RedactionRule({ fields: { profile: ['ssn'] } });
    const profile = { name: 'Ada', ssn: '123' };
    const out = map(rule, { profile, n: 1 }, (p) => ({ person: p.profile, n: p.n })) as any;
    expect(out.person).toBe(profile); // the record itself, not the view
    expect(rule.retain(['person'], profile)).toEqual({ name: 'Ada', ssn: MASK });
    expect(rule.verdict(['person', 'ssn'])).toEqual({ kind: 'whole', key: 'person.ssn' });
    // Reading the record (to pass it on) is not reading its secret field: `n` stays clear.
    expect(rule.retain(['n'], 1)).toBe(1);
    expect(rule.report().fieldRedactions).toEqual({ profile: ['ssn'], person: ['ssn'] });
  });

  it('reading a selected FIELD makes every computed key whole; a type check does not', () => {
    const rule = new RedactionRule({ fields: { profile: ['ssn'] } });
    map(rule, { profile: { ssn: '1', name: 'A' } }, (p) => ({
      ok: typeof p.profile === 'object',
      name: p.profile.name,
    }));
    expect(rule.retain(['ok'], true)).toBe(true);
    expect(rule.retain(['name'], 'A')).toBe('A');
    map(rule, { profile: { ssn: '1', name: 'A' } }, (p) => ({ last4: p.profile.ssn.slice(-4) }));
    expect(rule.retain(['last4'], '1')).toBe(MASK);
  });

  it('a built value that embeds a selected record by reference is selected whole', () => {
    const rule = new RedactionRule({ fields: { profile: ['ssn'] } });
    map(rule, { profile: { ssn: '1' } }, (p) => ({ wrap: { inner: [p.profile] } }));
    expect(rule.retain(['wrap'], {})).toBe(MASK);
  });

  it('a record holding none of its selected fields carries no secret', () => {
    const rule = new RedactionRule({ fields: { profile: ['ssn'] } });
    map(rule, { profile: { name: 'A' } }, (p) => ({ name: p.profile.name }));
    expect(rule.retain(['name'], 'A')).toBe('A');
  });

  it('reading `runs` reads every namespaced key', () => {
    const rule = new RedactionRule({ keys: ['token'] });
    map(rule, { runs: { c1: { token: 'sk' } } }, (p) => ({ t: p.runs.c1.token }));
    expect(rule.retain(['t'], 'sk')).toBe(MASK);
  });

  it('the view is spreadable and cloneable; an assignment never reaches the live record; recording stops at return', () => {
    const rule = new RedactionRule({ keys: ['token'] });
    const live = { a: 1, token: 'sk' };
    const taint = MapperTaint.of(rule)!;
    const view = taint.watch(live) as any;
    view.a = 2;
    expect(live.a).toBe(1);
    expect(view.a).toBe(2);
    expect(structuredClone(view)).toEqual({ a: 2, token: 'sk' });
    const out = taint.inherit({ copy: 'x' });
    expect(rule.retain(['copy'], 'x')).toBe(MASK); // the spread/clone read `token`
    expect(out).toEqual({ copy: 'x' });
    const after = new RedactionRule({ keys: ['token'] });
    const closed = MapperTaint.of(after)!;
    const v2 = closed.watch(live) as any;
    closed.inherit({ x: 1 }); // the mapper read nothing selected before it returned
    expect(after.retain(['x'], 1)).toBe(1);
    expect(v2.token).toBe('sk'); // a view read after the return still serves the value
  });

  it('deleting a tainted key clears its mark and its inherited fields', () => {
    const rule = new RedactionRule({ keys: ['token'], fields: { profile: ['ssn'] } });
    map(rule, { token: 'sk', profile: { ssn: '1' } }, (p) => ({ tok: p.token, person: p.profile }));
    expect(rule.retain(['tok'], 'sk')).toBe(MASK);
    rule.unmark('tok');
    rule.unmark('person');
    expect(rule.retain(['tok'], 'sk')).toBe('sk');
    expect(rule.retain(['person'], { ssn: '1' })).toEqual({ ssn: '1' });
  });
});
