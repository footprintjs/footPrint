/**
 * The places a redaction rule hides in a record it serves whole, as paths (`memory/servedPlaces.ts`), unit.
 *
 * What is pinned: the paths are the rule's own answer (a name at any depth, a dotted key, a path pattern,
 * a declared field, an item of a long list); one object served differently at two paths gives both
 * answers; and the answer is kept only for a record that cannot change, and only while the rule's policy
 * and marks are the same. The run-level proof is `test/lib/engine/security/redaction-follows-a-hidden-object.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RedactionRule } from '../../../../src/lib/memory/redaction';
import { placesHiddenIn } from '../../../../src/lib/memory/servedPlaces';

/** Freeze a record and everything in it, as the run's own snapshot of an input is. */
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const held of Object.values(value)) frozen(held);
    Object.freeze(value);
  }
  return value;
}

/** The answer in a fixed order. A copy: the answer itself is frozen. */
const sorted = (places: readonly string[] | undefined): string[] | undefined => places && [...places].sort();

afterEach(() => vi.restoreAllMocks());

describe('placesHiddenIn — the rule’s own answer, read back as paths', () => {
  it('a selected name at any depth, a declared field under a key of its name, and nothing else', () => {
    const rule = new RedactionRule({ keys: ['secret'], fields: { card: ['number'] } });
    const record = {
      secret: { token: 't' },
      order: { secret: 's', card: { number: '4242', owner: 'Ada' }, note: 'plain' },
      open: { note: 'n' },
    };
    expect(sorted(placesHiddenIn(rule, record))).toEqual(['order.card.number', 'order.secret', 'secret']);
    expect(placesHiddenIn(rule, { open: { note: 'n' } })).toEqual([]);
    // Frozen: it becomes a rule's list of paths, and only a list that cannot change is kept for.
    expect(Object.isFrozen(placesHiddenIn(rule, record))).toBe(true);
  });

  it('a policy key with a dot in it, and a pattern over a path', () => {
    expect(placesHiddenIn(new RedactionRule({ keys: ['a.b'] }), { a: { b: { token: 't' }, c: 1 } })).toEqual(['a.b']);
    const byPath = new RedactionRule({ patterns: [/^auth\.token$/] });
    expect(placesHiddenIn(byPath, { auth: { token: 't', user: 'u' }, token: 'shown' })).toEqual(['auth.token']);
  });

  it('the last record of a long list, by its index', () => {
    const rows: unknown[] = Array.from({ length: 200_000 }, (_, i) => ({ i }));
    rows.push({ secret: { token: 't' } });
    expect(placesHiddenIn(new RedactionRule({ keys: ['secret'] }), { rows })).toEqual(['rows.200000.secret']);
  });

  it('one object at two paths, served differently at each: both answers are read', () => {
    // The rule decides for each PATH. `shared` sits at `left.it` and at `right.it`, and a different field
    // of it is hidden at each. Passing over it at the second path, because it was seen at the first, lost one.
    const shared = { a: 'one', b: 'two' };
    const rule = new RedactionRule({ keys: ['left.it.a', 'right.it.b'] });
    const places = placesHiddenIn(rule, { left: { it: shared }, right: { it: shared } });
    expect(sorted(places)).toEqual(['left.it.a', 'right.it.b']);
  });

  it('a record that holds itself ends, and a text equal to the marker is not taken for a hidden place', () => {
    const loop: Record<string, unknown> = { secret: 's', marker: '\u0000hidden\u0000' };
    loop.self = loop;
    const places = placesHiddenIn(new RedactionRule({ keys: ['secret'] }), loop);
    expect(places).toContain('secret');
    expect(places).not.toContain('marker');
  });

  it('a record the rule cannot serve: no answer, so the caller takes the safe side', () => {
    const rule = new RedactionRule({ keys: ['secret'] });
    vi.spyOn(rule, 'retainBoundary').mockImplementation(() => {
      throw new Error('keys that cannot be read');
    });
    expect(placesHiddenIn(rule, { open: 1 })).toBeUndefined();
  });
});

describe('placesHiddenIn — the answer is kept only where it cannot go stale', () => {
  it('a record that cannot change is served once for a rule, and again when its policy or its marks change', () => {
    const rule = new RedactionRule({ keys: ['secret'] });
    const serve = vi.spyOn(rule, 'retainBoundary');
    const record = frozen({ order: { secret: { token: 't' }, late: { pin: 1 } } });
    expect(placesHiddenIn(rule, record)).toEqual(['order.secret']);
    expect(placesHiddenIn(rule, record)).toEqual(['order.secret']);
    expect(serve).toHaveBeenCalledTimes(1);
    rule.mark('late'); // a name marked later hides that key too
    expect(sorted(placesHiddenIn(rule, record))).toEqual(['order.late', 'order.secret']);
    expect(serve).toHaveBeenCalledTimes(2);
    rule.setPolicy({ keys: ['nothing'] }); // a rule can be handed a new policy
    expect(placesHiddenIn(rule, record)).toEqual(['order.late']);
    expect(serve).toHaveBeenCalledTimes(3);
    // Another rule has its own answer for the same record.
    expect(placesHiddenIn(new RedactionRule({ keys: ['late'] }), record)).toEqual(['order.late']);
  });

  it.each([
    ['is not frozen', () => ({ box: { n: 1 } })],
    ['is frozen at the top only', () => Object.freeze({ box: { n: 1 } })],
    ['holds an object that is not a plain record', () => frozen({ box: Object.freeze(new (class Capability {})()) })],
    ['holds a Map', () => Object.freeze({ box: Object.freeze(new Map()) })],
    [
      'holds a key that is read through a getter',
      () =>
        Object.freeze({
          box: Object.freeze(
            Object.defineProperty({}, 'now', { get: () => Date.now(), enumerable: true, configurable: false }),
          ),
        }),
    ],
  ])('a record that %s may change: it is served every time it is asked for', (_what, make) => {
    const rule = new RedactionRule({ keys: ['secret'] });
    const serve = vi.spyOn(rule, 'retainBoundary');
    const record = make();
    placesHiddenIn(rule, record);
    placesHiddenIn(rule, record);
    expect(serve).toHaveBeenCalledTimes(2);
  });

  it('a change inside a record that can change is seen the next time', () => {
    const rule = new RedactionRule({ keys: ['secret'] });
    const record: { box: Record<string, unknown> } = Object.freeze({ box: { n: 1 } });
    expect(placesHiddenIn(rule, record)).toEqual([]);
    record.box.secret = { token: 't' };
    expect(placesHiddenIn(rule, record)).toEqual(['box.secret']);
  });
});
