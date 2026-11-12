/**
 * A path rule is decided per PATH, never per object (review finding: a shared
 * reference bypassed a path rule).
 *
 * The boundary walk (`retainBoundary`, `retainDiagnostic`, a thrown value) and
 * the field scrub used to remember VISITED OBJECTS: an object reachable at two
 * paths was skipped on its second visit, so a dotted rule naming the second
 * path never fired — and a scrub made in place on a shared node masked the
 * other path too, or missed it, by visit order. Now each path is decided on
 * its own, copy-on-write per path; the visited set is only a cycle guard on
 * the current path. Over-masking a shared node is acceptable for a key-NAME
 * rule (the name is the same at every path); a path rule is exact.
 */
import { describe, expect, it } from 'vitest';

import { RedactionRule } from '../../../../src/lib/memory/redaction.js';

const MASK = '[REDACTED]';

function sharedRecord() {
  const shared = { token: 'S', label: 'L' };
  return { shared, record: { root: { a: { x: shared }, b: { x: shared } } } };
}

describe('a path rule is exact under shared references', () => {
  it.each([
    ['a dotted key', { keys: ['root.b.x.token'] }],
    ['a dotted pattern', { patterns: [/^root\.b\.x\.token$/] }],
    ['a field path', { fields: { root: ['b.x.token'] } }],
  ])('%s masks the protected path even when the object is reached first at another path', (_label, policy) => {
    const { shared, record } = sharedRecord();
    const served = new RedactionRule(policy).retainBoundary(record) as any;
    expect(served.root.b.x.token).toBe(MASK);
    expect(served.root.b.x.label).toBe('L');
    expect(served.root.a.x.token).toBe('S'); // exact: the unprotected path stays visible
    expect(shared.token).toBe('S'); // the live value is never edited
  });

  it.each([
    ['a dotted key', { keys: ['root.a.x.token'] }],
    ['a field path', { fields: { root: ['a.x.token'] } }],
  ])('%s on the FIRST path does not mask the second', (_label, policy) => {
    const { record } = sharedRecord();
    const served = new RedactionRule(policy).retainBoundary(record) as any;
    expect(served.root.a.x.token).toBe(MASK);
    expect(served.root.b.x.token).toBe('S');
  });

  it('a key-NAME rule masks the shared object at every path (over-masking a shared node is fine for a name)', () => {
    const { record } = sharedRecord();
    const served = new RedactionRule({ keys: ['token'] }).retainBoundary(record) as any;
    expect(served.root.a.x.token).toBe(MASK);
    expect(served.root.b.x.token).toBe(MASK);
  });

  it('a diagnostic entry and a field scrub of state decide per path too', () => {
    const { record } = sharedRecord();
    const rule = new RedactionRule({ keys: ['report.root.b.x.token'], fields: { state: ['root.b.x.token'] } });
    const logged = rule.retainDiagnostic(['logs', 'report'], record) as any;
    expect(logged.root.b.x.token).toBe(MASK);
    expect(logged.root.a.x.token).toBe('S');
    const kept = rule.retain(['state'], record) as any;
    expect(kept.root.b.x.token).toBe(MASK);
    expect(kept.root.a.x.token).toBe('S');
  });

  it('a thrown value is served masked when a protected path inside it holds a value, by any route', () => {
    const { record } = sharedRecord();
    const rule = new RedactionRule({ keys: ['root.b.x.token'] });
    const error = Object.assign(new Error('rejected'), record);
    const served = rule.retainStageError(error, String(error), String(error));
    expect(served.structuredError.raw).toBeUndefined();
  });

  it('a cycle never leads back to an unscrubbed original', () => {
    const node: any = { token: 'S', child: { note: 'n' } };
    node.child.parent = node;
    for (const policy of [{ keys: ['node.token'] }, { keys: ['token'] }]) {
      const served = new RedactionRule(policy).retainBoundary({ node }) as any;
      expect(served.node.token).toBe(MASK);
      expect(served.node.child.parent.token).toBe(MASK);
      expect(served.node.child.parent).toBe(served.node); // the copy closes its own cycle
      expect(node.token).toBe('S');
    }
  });

  it('nothing selected keeps every identity — shared and cyclic values included', () => {
    const { record } = sharedRecord();
    const cyclic: any = { a: 1 };
    cyclic.self = cyclic;
    const rule = new RedactionRule({ keys: ['elsewhere.token'] });
    expect(rule.retainBoundary(record)).toBe(record);
    const wrapped = { cyclic };
    expect(rule.retainBoundary(wrapped)).toBe(wrapped);
  });
});

describe('a key with very many fields is served like one with a few', () => {
  // WHY these exist: a node's targets are asked once for the node, grouped by first key when there
  // are many (`memory/pathTargets.ts`). A policy seldom names thousands of fields, but a key takes one
  // field for each hidden object a stage puts below it, so the number comes from data.
  const N = 3_000;
  const paths = Array.from({ length: N }, (_, i) => `f${i}`);
  const profileOf = (): Record<string, unknown> =>
    Object.fromEntries([...paths.map((path, i) => [path, { v: i }]), ['open', { v: -1 }]]);

  it.each([
    ['as a top key', (profile: object) => ({ profile }), (served: any) => served.profile],
    ['below another key', (profile: object) => ({ wrapper: { profile } }), (served: any) => served.wrapper.profile],
  ])('every field is masked and a neighbour is not (%s)', (_where, wrap, unwrap) => {
    const record = wrap(profileOf());
    const served = unwrap(new RedactionRule({ fields: { profile: paths } }).retainBoundary(record));
    expect(served.open).toEqual({ v: -1 });
    expect(Object.keys(served)).toHaveLength(N + 1);
    expect(Object.values(served).filter((value) => value === MASK)).toHaveLength(N);
    expect(unwrap(record).f0).toEqual({ v: 0 }); // the live value is never edited
  });

  it('fields that go on below a member are handed to it, each without the member', () => {
    const dotted = Array.from({ length: N }, (_, i) => `r${i}.secret`);
    const box = Object.fromEntries(dotted.map((_, i) => [`r${i}`, { secret: 's', open: i }]));
    const served = new RedactionRule({ fields: { box: dotted } }).retainBoundary({ box }) as any;
    expect(served.box.r0).toEqual({ secret: MASK, open: 0 });
    expect(served.box[`r${N - 1}`]).toEqual({ secret: MASK, open: N - 1 });
  });

  it('a key reached by a field path from above that also declares fields by its own name is masked at both', () => {
    // At the key `profile`, three levels down, one target comes from above (`root` declares
    // `wrapper.profile.x`) and one from its own name (`profile` declares `y`). Neither may push the
    // other out.
    const rule = new RedactionRule({ fields: { root: ['wrapper.profile.x'], profile: ['y'] } });
    const record = { outer: { root: { wrapper: { profile: { x: 'X', y: 'Y', z: 'Z' } } } } };
    const served = rule.retainBoundary(record) as any;
    expect(served.outer.root.wrapper.profile).toEqual({ x: MASK, y: MASK, z: 'Z' });
  });

  it('a key with more fields than a call takes arguments is served, not refused', () => {
    // Its targets were spread into one `push` call, which throws from about 125,000 arguments on:
    // 80,000 dotted paths are 160,000 targets.
    const many = Array.from({ length: 80_000 }, (_, i) => `r${i}.secret`);
    const rule = new RedactionRule();
    rule.inheritFields('box', many);
    const record = { wrapper: { box: { r0: { secret: 's', open: 1 }, r79999: { secret: 's' } } } };
    const served = rule.retainBoundary(record) as any;
    expect(served.wrapper.box).toEqual({ r0: { secret: MASK, open: 1 }, r79999: { secret: MASK } });
  });
});
