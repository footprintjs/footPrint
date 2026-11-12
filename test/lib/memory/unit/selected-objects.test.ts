/**
 * The objects a stage read under a hidden name, and where it puts them (`memory/selectedObjects.ts`),
 * unit.
 *
 * Two halves. REMEMBER: a selected value is remembered with every object inside it, each with the rule
 * its place gives it. FIND: a value about to be written is searched for remembered objects, and only
 * what is new against the value it replaces is searched. The run-level proof, with the leaks this
 * closed, is `test/lib/engine/security/redaction-follows-a-hidden-object.test.ts`.
 */
import { EventLog, SharedMemory } from 'foottrace/write';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RedactionRule } from '../../../../src/lib/memory/redaction';
import { type SelectedRule, SelectedObjects } from '../../../../src/lib/memory/selectedObjects';
import { StageContext } from '../../../../src/lib/memory/StageContext';

const WHOLE: SelectedRule = { kind: 'whole', key: 'secret' };
const fields = (...paths: string[]): SelectedRule => ({ kind: 'fields', key: 'profile', paths });

/** A fresh memory that holds `value` under `rule`. */
function remembering(value: object, rule: SelectedRule = WHOLE): SelectedObjects {
  const selected = new SelectedObjects();
  selected.remember(value, rule);
  return selected;
}

describe('remember — a selected value, and every object inside it', () => {
  it('hidden whole: every object inside is hidden whole, at any depth, in lists too', () => {
    const secret = { inner: { deep: { token: 't' } }, list: [{ id: 1 }, [{ id: 2 }]] };
    const selected = remembering(secret);
    expect(selected.get(secret)).toEqual(WHOLE);
    expect(selected.get(secret.inner)).toEqual(WHOLE);
    expect(selected.get(secret.inner.deep)).toEqual(WHOLE);
    expect(selected.get(secret.list)).toEqual(WHOLE);
    expect(selected.get(secret.list[0] as object)).toEqual(WHOLE);
    expect(selected.get((secret.list[1] as object[])[0])).toEqual(WHOLE);
  });

  it('hidden fields: a member on a hidden path is whole, a member above one keeps the paths below it, the rest is not remembered', () => {
    const profile = {
      name: 'Ann',
      contact: { email: { address: 'a@x' }, city: { name: 'Oslo' } },
      card: { number: '4242' },
      open: { note: 'n' },
    };
    const selected = remembering(profile, fields('contact.email', 'card'));
    expect(selected.get(profile)).toEqual(fields('contact.email', 'card'));
    expect(selected.get(profile.contact)).toEqual(fields('email')); // above a hidden path
    expect(selected.get(profile.contact.email)).toEqual({ kind: 'whole', key: 'profile' }); // on it
    expect(selected.get(profile.card)).toEqual({ kind: 'whole', key: 'profile' });
    expect(selected.get(profile.contact.city)).toBeUndefined(); // beside it
    expect(selected.get(profile.open)).toBeUndefined();
  });

  it('a Map or a Set hidden whole hides its entries; under a fields rule a path cannot name them', () => {
    const entry = { token: 't' };
    const member = { token: 'u' };
    const whole = { map: new Map([['k', entry]]), set: new Set([member]) };
    const selected = remembering(whole);
    expect(selected.get(entry)).toEqual(WHOLE);
    expect(selected.get(member)).toEqual(WHOLE);

    const other = { token: 'v' };
    const byField = { map: new Map([['k', other]]) };
    const narrow = remembering(byField, fields('map.k'));
    expect(narrow.get(byField.map)).toEqual(fields('k'));
    expect(narrow.get(other)).toBeUndefined();
  });

  it('once for each object: the wider rule wins, and two field rules add up', () => {
    const shared = { a: { v: 1 }, b: { v: 2 } };
    const selected = remembering(shared, fields('a'));
    expect(selected.get(shared.b)).toBeUndefined();
    selected.remember(shared, fields('b'));
    expect(selected.get(shared)).toEqual(fields('a', 'b'));
    expect(selected.get(shared.b)).toEqual({ kind: 'whole', key: 'profile' });
    selected.remember(shared, WHOLE);
    expect(selected.get(shared)).toEqual(WHOLE);
    selected.remember(shared, fields('c')); // narrower than what is known: nothing changes
    expect(selected.get(shared)).toEqual(WHOLE);
  });

  it('a value that holds itself, and a very long chain, are remembered without running out of stack', () => {
    const loop: Record<string, unknown> = { name: 'loop' };
    loop.self = loop;
    expect(() => remembering(loop)).not.toThrow();

    const head: { next?: object } = {};
    let tail = head;
    for (let i = 0; i < 20_000; i++) {
      const link: { next?: object } = {};
      tail.next = link;
      tail = link;
    }
    const selected = remembering(head);
    expect(selected.get(tail)).toEqual(WHOLE);
  });

  it('a view handed out in place of a value carries its rule', () => {
    const value = { token: 't' };
    const view = { token: 't' };
    const selected = remembering(value);
    selected.sameRuleFor(view, value);
    expect(selected.get(view)).toEqual(WHOLE);
    selected.sameRuleFor({}, { unknown: true }); // nothing known: nothing handed on
  });
});

describe('findIn — the remembered objects in a value about to be written', () => {
  const secret = { token: 't' };

  it('the value itself, at the path of nothing', () => {
    expect(remembering(secret).findIn(secret, undefined)).toEqual([{ path: [], rule: WHOLE, whole: true }]);
  });

  it('inside a new object, at any depth: the path of the place', () => {
    const selected = remembering(secret);
    expect(selected.findIn({ x: 1, b: secret }, undefined)).toEqual([{ path: ['b'], rule: WHOLE, whole: true }]);
    expect(selected.findIn({ inner: { p: secret } }, undefined)).toEqual([
      { path: ['inner', 'p'], rule: WHOLE, whole: true },
    ]);
  });

  it('a record with hidden fields keeps the fields, not the whole place', () => {
    const profile = { name: 'Ann', email: 'a@x' };
    const selected = remembering(profile, fields('email'));
    expect(selected.findIn({ owner: profile }, undefined)).toEqual([
      { path: ['owner'], rule: fields('email'), whole: false },
    ]);
  });

  it('in a list, a Map or a Set: the path of that container, to be hidden whole', () => {
    const selected = remembering(secret);
    expect(selected.findIn([secret], undefined)).toEqual([{ path: [], rule: WHOLE, whole: true }]);
    expect(selected.findIn({ items: [{ deep: secret }] }, undefined)).toEqual([
      { path: ['items'], rule: WHOLE, whole: true },
    ]);
    expect(selected.findIn({ m: new Map([['k', secret]]) }, undefined)).toEqual([
      { path: ['m'], rule: WHOLE, whole: true },
    ]);
    expect(selected.findIn({ s: new Set([secret]) }, undefined)).toEqual([{ path: ['s'], rule: WHOLE, whole: true }]);
    // A record with hidden fields in a list: the list still goes whole, because an index moves.
    const profile = { email: 'a@x' };
    expect(remembering(profile, fields('email')).findIn([profile], undefined)).toEqual([
      { path: [], rule: fields('email'), whole: true },
    ]);
  });

  it('nothing remembered, a text, nothing at all: nothing found', () => {
    const selected = remembering(secret);
    expect(selected.findIn({ token: 't' }, undefined)).toEqual([]); // the same text in another object
    expect(selected.findIn('t', undefined)).toEqual([]);
    expect(selected.findIn(undefined, undefined)).toEqual([]);
    expect(selected.findIn(null, undefined)).toEqual([]);
  });

  it('a value that holds itself is searched once', () => {
    const loop: Record<string, unknown> = { p: secret };
    loop.self = loop;
    expect(remembering(secret).findIn(loop, undefined)).toEqual([{ path: ['p'], rule: WHOLE, whole: true }]);
  });
});

describe('findIn — only what is NEW against the value it replaces is searched', () => {
  /** An object that counts how often its members are listed: a search that enters it shows up. */
  function watched(): { node: object; entered: () => number } {
    let listed = 0;
    const node = new Proxy(
      { v: 1 },
      {
        ownKeys(target) {
          listed += 1;
          return Reflect.ownKeys(target);
        },
      },
    );
    return { node, entered: () => listed };
  }
  const secret = { token: 't' };

  it('a part that is the same object as before is not entered', () => {
    const old = watched();
    const base = { kept: old.node, x: 1 };
    const next = { ...base, x: 2 };
    expect(remembering(secret).findIn(next, base)).toEqual([]);
    expect(old.entered()).toBe(0);
    // Without the value it replaces, everything is new.
    remembering(secret).findIn(next, undefined);
    expect(old.entered()).toBe(1);
  });

  it('the same value written again is not searched at all', () => {
    const old = watched();
    const base = { kept: old.node };
    expect(remembering(secret).findIn(base, base)).toEqual([]);
    expect(old.entered()).toBe(0);
  });

  it.each([
    ['added at the end', (items: object[], fresh: object) => [...items, fresh]],
    ['added at the front', (items: object[], fresh: object) => [fresh, ...items]],
    ['put in the middle', (items: object[], fresh: object) => [items[0], fresh, ...items.slice(1)]],
    ['in place of the second', (items: object[], fresh: object) => [items[0], fresh, ...items.slice(2)]],
    ['after the first was taken out', (items: object[], fresh: object) => [...items.slice(1), fresh]],
    ['in a list sorted the other way round', (items: object[], fresh: object) => [...items].reverse().concat(fresh)],
    [
      'at the front of a list that was put in another order as well',
      (items: object[], fresh: object) => [fresh, items[2], items[0], items[1], items[3]],
    ],
  ])('a list with one new item, %s: the old items are not entered, the new one is found', (_how, grow) => {
    const olds = [watched(), watched(), watched(), watched()];
    const base = olds.map((old) => old.node);
    const found = remembering(secret).findIn(grow(base, { p: secret }), base);
    expect(found).toEqual([{ path: [], rule: WHOLE, whole: true }]);
    expect(olds.map((old) => old.entered())).toEqual([0, 0, 0, 0]);
  });

  it('a list item that was changed is a copy: it is searched against the item it replaced', () => {
    const kept = watched();
    const base = [{ id: 1, kept: kept.node }, { id: 2 }];
    const next = [{ ...base[0], p: secret }, base[1]];
    expect(remembering(secret).findIn(next, base)).toEqual([{ path: [], rule: WHOLE, whole: true }]);
    expect(kept.entered()).toBe(0);
  });

  it('texts and numbers in a list keep the two lists in step', () => {
    const old = watched();
    const base = ['a', old.node, 3];
    expect(remembering(secret).findIn(['new', ...base, secret], base)).toEqual([
      { path: [], rule: WHOLE, whole: true },
    ]);
    expect(old.entered()).toBe(0);
  });

  it('a Map entry or a Set member that was there before is not entered', () => {
    const old = watched();
    const map = new Map<string, unknown>([['kept', old.node]]);
    const nextMap = new Map<string, unknown>([...map, ['new', secret]]);
    expect(remembering(secret).findIn({ m: nextMap }, { m: map })).toEqual([{ path: ['m'], rule: WHOLE, whole: true }]);
    const set = new Set<unknown>([old.node]);
    const nextSet = new Set<unknown>([...set, secret]);
    expect(remembering(secret).findIn({ s: nextSet }, { s: set })).toEqual([{ path: ['s'], rule: WHOLE, whole: true }]);
    expect(old.entered()).toBe(0);
  });

  it('a hidden object that was already there is not reported again: this write did not put it there', () => {
    const base = { b: secret, x: 1 };
    expect(remembering(secret).findIn({ ...base, x: 2 }, base)).toEqual([]);
  });
});

describe('the frame — it hands the search what the key holds now', () => {
  afterEach(() => vi.restoreAllMocks());

  function frame(rule: RedactionRule, state: Record<string, unknown>) {
    const heap = new SharedMemory(undefined, state);
    const ctx = new StageContext('', 's', 's', heap, '', new EventLog(heap.getState()));
    ctx.useRedactionRule(rule);
    return ctx;
  }

  it('a write is searched against the value it replaces, so that only what is new costs anything', () => {
    const ctx = frame(new RedactionRule({ keys: ['profile'] }), { profile: { name: 'Ada' }, list: [{ id: 1 }] });
    const findIn = vi.spyOn(SelectedObjects.prototype, 'findIn');
    ctx.getValue([], 'profile'); // a read under a hidden name: from here on the frame searches its writes
    const list = ctx.getValue([], 'list') as object[];
    const next = [...list, { id: 2 }];
    ctx.setObject([], 'list', next);
    expect(findIn).toHaveBeenCalledTimes(1);
    expect(findIn.mock.calls[0][0]).toBe(next);
    expect(findIn.mock.calls[0][1]).toBe(list); // the same object the key holds, not a copy
  });

  it('a frame that read nothing hidden searches nothing', () => {
    const ctx = frame(new RedactionRule({ keys: ['profile'] }), { profile: { name: 'Ada' }, list: [{ id: 1 }] });
    const findIn = vi.spyOn(SelectedObjects.prototype, 'findIn');
    ctx.setObject([], 'list', [{ id: 2 }]);
    expect(findIn).not.toHaveBeenCalled();
  });

  it('a hidden object the frame read is found in what it writes, at a nested path too', () => {
    const rule = new RedactionRule({ keys: ['profile'] });
    const ctx = frame(rule, { profile: { name: 'Ada' }, box: { x: 1 } });
    const profile = ctx.getValue([], 'profile');
    expect(ctx.setObject([], 'box', { x: 1, owner: profile })).toEqual({
      kind: 'fields',
      key: 'box',
      paths: ['owner'],
    });
    expect(ctx.setObject(['card'], 'holder', profile)).toEqual({ kind: 'whole', key: 'card.holder' });
    expect(rule.verdict(['card'])).toEqual({ kind: 'fields', key: 'card', paths: ['holder'] });
  });
});
