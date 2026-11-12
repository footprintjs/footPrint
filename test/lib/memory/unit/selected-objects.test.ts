/**
 * The objects a stage read under a hidden name, and where it puts them (`memory/selectedObjects.ts`),
 * unit.
 *
 * Three parts. REMEMBER: a selected value is remembered with every object inside it, each with the rule
 * its place gives it. FIND, at a write: a value about to be written is searched for remembered objects,
 * only what is new against the value it replaces, and only where it adds to what the key's name hides.
 * FIND, at commit: what the stage put in after the write, and nothing else. The frame's side is
 * `hidden-object-trail.test.ts`; the run-level proof, with the leaks this closed, is
 * `test/lib/engine/security/redaction-follows-a-hidden-object.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { type SelectedRule, SelectedObjects, ShownObjects } from '../../../../src/lib/memory/selectedObjects';

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

/** A container that counts how often its members are listed: a search that enters it shows up. */
function watchedContainer(): { node: object; entered: () => number } {
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

  it('as the KEY of a Map, and as the cause or among the errors of an Error: that container, whole', () => {
    const selected = remembering(secret);
    expect(selected.findIn({ m: new Map([[secret, 1]]) }, undefined)).toEqual([
      { path: ['m'], rule: WHOLE, whole: true },
    ]);
    expect(selected.findIn({ e: new Error('refused', { cause: secret }) }, undefined)).toEqual([
      { path: ['e'], rule: WHOLE, whole: true },
    ]);
    expect(selected.findIn({ e: new AggregateError([{ deep: secret }], 'all refused') }, undefined)).toEqual([
      { path: ['e'], rule: WHOLE, whole: true },
    ]);
  });

  it('bytes hold no objects: a buffer or a view is not entered', () => {
    const view = new Uint8Array(4);
    const listed = vi.spyOn(Object, 'keys');
    expect(remembering(secret).findIn({ bytes: view, buffer: view.buffer, p: secret }, undefined)).toEqual([
      { path: ['p'], rule: WHOLE, whole: true },
    ]);
    expect(listed.mock.calls.some(([asked]) => asked === view || asked === view.buffer)).toBe(false);
    listed.mockRestore();
    expect(() => remembering({ bytes: new Uint8Array(1_000_000) })).not.toThrow();
  });

  it('a record hidden by its fields is still searched: it may hold another remembered object', () => {
    const profile = { name: 'Ann', email: 'a@x', pal: secret };
    const selected = remembering(secret);
    selected.remember(profile, fields('email'));
    expect(selected.findIn({ owner: profile }, undefined)).toEqual([
      { path: ['owner'], rule: fields('email'), whole: false },
      { path: ['owner', 'pal'], rule: WHOLE, whole: true },
    ]);
    // Written as the whole value: its own fields, and the place of the other one.
    expect(selected.findIn(profile, undefined)).toEqual([
      { path: [], rule: fields('email'), whole: false },
      { path: ['pal'], rule: WHOLE, whole: true },
    ]);
  });

  it('one new container at two places: found at both, the second place whole', () => {
    const part = { p: secret, note: 'n' };
    const found = remembering(secret).findIn({ first: part, second: part }, undefined);
    expect(found).toHaveLength(2);
    expect(found).toContainEqual({ path: ['second', 'p'], rule: WHOLE, whole: true });
    expect(found).toContainEqual({ path: ['first'], rule: WHOLE, whole: true });
    // And when the second place is a list: the list.
    const listed = remembering(secret).findIn({ first: part, listed: [part] }, undefined);
    expect(listed).toContainEqual({ path: ['listed'], rule: WHOLE, whole: true });
    expect(listed.some((one) => one.path[0] === 'first')).toBe(true);
  });

  it('a container that holds nothing remembered costs one search, however many places it is at', () => {
    const shared = watchedContainer();
    expect(remembering(secret).findIn({ a: shared.node, b: shared.node, c: [shared.node] }, undefined)).toEqual([]);
    expect(shared.entered()).toBe(1);
  });

  it('a deep chain and a value with very many paths to one object are searched without running out', () => {
    const selected = remembering(secret);
    const head: { next?: object; p?: object } = {};
    let tail = head;
    for (let i = 0; i < 20_000; i++) {
      const link: { next?: object; p?: object } = {};
      tail.next = link;
      tail = link;
    }
    tail.p = secret;
    expect(selected.findIn(head, undefined)).toHaveLength(1);

    // 2^40 paths lead to the bottom of this one. Each container is entered once.
    let diamond: object = { p: secret };
    for (let i = 0; i < 40; i++) diamond = { left: diamond, right: diamond };
    const found = selected.findIn(diamond, undefined);
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThan(200);
  });

  it('a list whose fields are named by index: handed on, the list goes whole', () => {
    const users = [{ name: 'Ann', ssn: '1' }, { name: 'Bob' }];
    const selected = remembering(users, fields('0.ssn'));
    expect(selected.findIn(users, undefined)).toEqual([{ path: [], rule: fields('0.ssn'), whole: true }]);
    expect(selected.findIn({ copy: users }, undefined)).toEqual([
      { path: ['copy'], rule: fields('0.ssn'), whole: true },
    ]);
    // A list whose rule names no index keeps its fields, as any record does (they name nothing in it).
    const plain = [1, 2];
    expect(remembering(plain, fields('y')).findIn(plain, undefined)).toEqual([
      { path: [], rule: fields('y'), whole: false },
    ]);
  });

  it('nothing remembered, a text, nothing at all: nothing found', () => {
    const selected = remembering(secret);
    expect(selected.findIn({ token: 't' }, undefined)).toEqual([]); // the same text in another object
    expect(selected.findIn('t', undefined)).toEqual([]);
    expect(selected.findIn(undefined, undefined)).toEqual([]);
    expect(selected.findIn(null, undefined)).toEqual([]);
  });

  it('a value that holds itself is searched once, and hidden whole when it holds a remembered object', () => {
    // A field is hidden in a copy of the value, and the edge back leads to the value the copy was made
    // of: the field alone would still show through `self`. So the place of the container is hidden.
    const loop: Record<string, unknown> = { p: secret };
    loop.self = loop;
    expect(remembering(secret).findIn(loop, undefined)).toEqual([
      { path: ['p'], rule: WHOLE, whole: true },
      { path: [], rule: WHOLE, whole: true },
    ]);
    // Below a key: the place of the container, not the key.
    const inner: Record<string, unknown> = { p: secret };
    inner.self = inner;
    expect(remembering(secret).findIn({ box: inner, x: 1 }, undefined)).toContainEqual({
      path: ['box'],
      rule: WHOLE,
      whole: true,
    });
    // The edge may come back from further down.
    const top: Record<string, any> = { mid: { p: secret } };
    top.mid.back = top;
    expect(remembering(secret).findIn({ at: top }, undefined)).toContainEqual({
      path: ['at'],
      rule: WHOLE,
      whole: true,
    });
    // One that holds itself and nothing remembered is left alone.
    const plain: Record<string, unknown> = { x: 1 };
    plain.self = plain;
    expect(remembering(secret).findIn({ box: plain }, undefined)).toEqual([]);
  });
});

describe('findIn — only what is NEW against the value it replaces is searched', () => {
  const watched = watchedContainer;
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

  it('a Map, a Set and an Error are small and rare in state: a new one is searched whole', () => {
    const old = watched();
    const map = new Map<string, unknown>([['kept', old.node]]);
    const nextMap = new Map<string, unknown>([...map, ['new', secret]]);
    expect(remembering(secret).findIn({ m: nextMap }, { m: map })).toEqual([{ path: ['m'], rule: WHOLE, whole: true }]);
    expect(old.entered()).toBe(1);
    // The same Map as before is not entered at all.
    expect(remembering(secret).findIn({ m: map, x: 2 }, { m: map, x: 1 })).toEqual([]);
    expect(old.entered()).toBe(1);
  });

  it('a new container at an old place and at a new place: the new place is searched whole, whichever comes first', () => {
    // `copy` is the old `a` with one field changed: `child` is the same object as before, and at `a` it
    // would be passed over. The same copy is ALSO put at `b`, where everything in it is new.
    const child = { p: secret };
    const base = { a: { child, x: 1 } };
    const copy = { ...base.a, x: 2 };
    for (const next of [
      { a: copy, b: copy },
      { b: copy, a: copy },
    ]) {
      const found = remembering(secret).findIn(next, base);
      expect(found.some((one) => one.path[0] === 'b')).toBe(true);
      // `a` may come out hidden whole as well (the careful answer once the copy is known to hold one).
      expect(found.every((one) => one.path[0] === 'b' || (one.path.join() === 'a' && one.whole))).toBe(true);
    }
  });

  it('a value that holds itself is searched against a value that holds itself, and ends', () => {
    const was: Record<string, unknown> = { x: 1 };
    was.self = was;
    const now: Record<string, unknown> = { x: 2, p: secret };
    now.self = now;
    expect(remembering(secret).findIn(now, was)).toContainEqual({ path: ['p'], rule: WHOLE, whole: true });
  });

  it('the key’s whole old value, moved below its new one, is not walked: the place it moved to is hidden whole', () => {
    const old = watched();
    const base = { kept: old.node, ssn: '1', depth: 1 };
    const nested = { prev: base, depth: 2 }; // `history = { prev: history }`
    // The key's name hides `ssn`, and the old value has one. Under `prev` no name covers it any more.
    expect(remembering(secret).findIn(nested, base, { named: fields('ssn') })).toEqual([
      { path: ['prev'], rule: fields('ssn'), whole: true },
    ]);
    expect(old.entered()).toBe(0); // however long the chain, the old value costs one step
    // Moved into a list: the list.
    expect(remembering(secret).findIn({ all: [base] }, base, { named: fields('ssn') })).toEqual([
      { path: ['all'], rule: fields('ssn'), whole: true },
    ]);
    // Nothing to hide: a key whose name hides nothing, and an old value that holds none of what it hides
    // (as one key with a dot in it, or as a path).
    expect(remembering(secret).findIn(nested, base)).toEqual([]);
    expect(remembering(secret).findIn(nested, base, { named: fields('card', 'a.b') })).toEqual([]);
    const dotted = { 'a.b': 1 };
    expect(remembering(secret).findIn({ prev: dotted }, dotted, { named: fields('a.b') })).toHaveLength(1);
    const pathed = { a: { b: 1 }, list: [{ ssn: '2' }] };
    expect(remembering(secret).findIn({ prev: pathed }, pathed, { named: fields('a.b') })).toHaveLength(1);
    expect(remembering(secret).findIn({ prev: pathed }, pathed, { named: fields('list.0.ssn') })).toHaveLength(1);
    expect(remembering(secret).findIn({ prev: pathed }, pathed, { named: fields('list.1.ssn') })).toEqual([]);
    // Once the place is hidden, the next move finds it hidden: nothing is reported again, and no
    // field path grows with the chain.
    expect(remembering(secret).findIn({ prev: nested, depth: 3 }, nested, { named: fields('ssn', 'prev') })).toEqual(
      [],
    );
    // The search at commit does the same against the committed value.
    expect(remembering(secret).findPlanted(nested, base, { named: fields('ssn') }, () => false)).toEqual([
      { path: ['prev'], rule: fields('ssn'), whole: true },
    ]);
  });

  it('a hidden object that was already there is not reported again: this write did not put it there', () => {
    const base = { b: secret, x: 1 };
    expect(remembering(secret).findIn({ ...base, x: 2 }, base)).toEqual([]);
  });
});

describe('findIn — what the name of the place hides already (`named`)', () => {
  const secret = { token: 't' };
  const profile = { name: 'Ada', ssn: { digits: '1' }, pal: { name: 'Bea' } };

  it('nothing is searched below a place its name hides whole', () => {
    const selected = remembering(secret);
    expect(selected.findIn({ ssn: { deep: secret }, open: 1 }, undefined, { named: fields('ssn') })).toEqual([]);
    // Beside it, the object is found as anywhere.
    expect(selected.findIn({ ssn: 1, open: secret }, undefined, { named: fields('ssn') })).toEqual([
      { path: ['open'], rule: WHOLE, whole: true },
    ]);
  });

  it('a record written back to its own key reports nothing: its fields are the name’s already', () => {
    const selected = remembering(profile, fields('ssn'));
    expect(selected.findIn(profile, undefined, { named: fields('ssn') })).toEqual([]);
    expect(selected.findIn({ ...profile, n: 2 }, undefined, { named: fields('ssn') })).toEqual([]);
    // At another place of the same key the name does not cover it: reported there, by its fields (and
    // the hidden member inside it once more, at its own place).
    expect(selected.findIn({ ssn: 1, copy: profile }, undefined, { named: fields('ssn') })).toEqual([
      { path: ['copy'], rule: fields('ssn'), whole: false },
      { path: ['copy', 'ssn'], rule: { kind: 'whole', key: 'profile' }, whole: true },
    ]);
    // An object hidden WHOLE is never covered by a name that hides only a field below its place:
    // all of it is hidden there, not that one field.
    expect(remembering(secret).findIn({ holder: secret }, undefined, { named: fields('holder.name') })).toEqual([
      { path: ['holder'], rule: WHOLE, whole: true },
    ]);
    // A name that hides a place ABOVE one of its fields hides that field too.
    expect(remembering(profile, fields('ssn.digits')).findIn(profile, undefined, { named: fields('ssn') })).toEqual([]);
    expect(
      remembering(profile, fields('ssn.digits')).findIn(profile, undefined, { named: fields('pal') }),
    ).toContainEqual({ path: [], rule: fields('ssn.digits'), whole: false });
    // A name that covers a place ABOVE its fields covers them too.
    expect(selected.findIn({ copy: profile }, undefined, { named: fields('copy.ssn') })).toEqual([]);
  });

  it('an item of a list is named by its index, so a field the policy names by index covers that item only', () => {
    const ann = { name: 'Ann', ssn: '1' };
    const list = [ann];
    const selected = remembering(list, fields('0.ssn')); // read as `users`, policy field `users.0.ssn`
    // Written back as it was: the list, and its item, sit where their names hide them.
    expect(selected.findIn({ users: list }, undefined, { named: fields('users.0.ssn') })).toEqual([]);
    expect(selected.findIn({ users: [ann] }, undefined, { named: fields('users.0.ssn') })).toEqual([]);
    // The record that holds the list, written under ANOTHER key: its fields are handed on, and the list
    // is found in it all the same, and goes whole (an index would hide the wrong item after an `unshift`).
    const record = { users: list };
    const whole = remembering(record, fields('users.0.ssn'));
    expect(whole.findIn(record, undefined)).toEqual([
      { path: [], rule: fields('users.0.ssn'), whole: false },
      { path: ['users'], rule: fields('0.ssn'), whole: true },
    ]);
    // The item at another index: no name covers it there, and the list goes whole.
    expect(selected.findIn({ users: [{ name: 'new' }, ann] }, undefined, { named: fields('users.0.ssn') })).toEqual([
      { path: ['users'], rule: fields('ssn'), whole: true },
    ]);
  });

  it('in a merge patch a list is added to the one there: its indexes name no place', () => {
    const ann = { name: 'Ann', ssn: '1' };
    const selected = remembering(ann, fields('ssn'));
    const patch = { users: [ann] };
    expect(selected.findIn(patch, undefined, { named: fields('users.0.ssn') })).toEqual([]);
    expect(selected.findIn(patch, undefined, { named: fields('users.0.ssn'), patch: true })).toEqual([
      { path: ['users'], rule: fields('ssn'), whole: true },
    ]);
  });

  it('a container at a second place is searched again when the name hid a part of it at the first', () => {
    // `x` sits at `p` and at `q`. The name hides `q.s`, so at `q` the hidden object is passed over.
    // At `p` no name hides it. Found there whichever place the search reaches first.
    const x = { k: 1, s: secret };
    const found = remembering(secret).findIn({ p: x, q: x }, undefined, { named: fields('q.s') });
    expect(found).toEqual([{ path: ['p', 's'], rule: WHOLE, whole: true }]);
    const other = remembering(secret).findIn({ q: x, p: x }, undefined, { named: fields('q.s') });
    expect(other).toEqual([{ path: ['p', 's'], rule: WHOLE, whole: true }]);
  });
});

describe('what a key showed when it was written (`shown`)', () => {
  const secret = { token: 't' };
  const own = { made: 'by the stage', inner: { deep: 1 } };

  it('a search at a write notes every new object at a public place that is not remembered', () => {
    const shown = new ShownObjects();
    const value = { a: own, b: secret, list: [{ id: 1 }] };
    remembering(secret).findIn(value, undefined, { shown });
    expect(shown.has(value)).toBe(true);
    expect(shown.has(own)).toBe(true);
    expect(shown.has(own.inner)).toBe(true);
    expect(shown.has(value.list)).toBe(true);
    expect(shown.has(value.list[0])).toBe(true);
    expect(shown.has(secret)).toBe(false); // a hidden object is never shown
  });

  it('a place whose name hides something, at it or below it, shows nothing', () => {
    const shown = new ShownObjects();
    const value = { contact: { email: { address: 'a@x' }, city: { name: 'Oslo' } }, open: { note: 'n' } };
    new SelectedObjects().findIn(value, undefined, { shown, named: fields('contact.email') });
    expect(shown.has(value)).toBe(false); // holds a hidden field
    expect(shown.has(value.contact)).toBe(false); // above one
    expect(shown.has(value.contact.email)).toBe(false); // hidden
    expect(shown.has(value.contact.city)).toBe(true); // beside it
    expect(shown.has(value.open)).toBe(true);
    // An entry of a Map below such a place: a path cannot name it, so what its name hides is not known.
    const entry = { in: 'a map' };
    const free = { in: 'another' };
    new SelectedObjects().findIn({ m: new Map([['k', entry]]), n: new Map([['k', free]]) }, undefined, {
      shown,
      named: fields('m.k'),
    });
    expect(shown.has(entry)).toBe(false);
    expect(shown.has(free)).toBe(true); // nothing is hidden below `n`
  });

  it('a part kept from the old value keeps what was shown; a whole new value starts over', () => {
    const shown = new ShownObjects();
    const selected = new SelectedObjects();
    const first = { a: own };
    selected.findIn(first, undefined, { shown, replaces: true });
    // The next value keeps `own` in place: it is passed over, and it still counts as shown.
    const second = { a: own, b: { added: true } };
    selected.findIn(second, first, { shown, replaces: true });
    expect(shown.has(own)).toBe(true);
    expect(shown.has(second.b)).toBe(true);
    // A value that keeps nothing: what the key showed before is not in it any more.
    const third = { c: { fresh: true } };
    selected.findIn(third, second, { shown, replaces: true });
    expect(shown.has(own)).toBe(false);
    expect(shown.has(third.c)).toBe(true);
    // A write below the key (not its whole value) only ever adds.
    selected.findIn({ d: { below: true } }, undefined, { shown });
    expect(shown.has(third.c)).toBe(true);
    // The old value moved below the new one is kept too, with everything it showed.
    selected.findIn({ prev: third }, third, { shown, replaces: true });
    expect(shown.has(third.c)).toBe(true);
  });

  it('a kept item of a list counts as kept, wherever the stepping finds it', () => {
    const selected = new SelectedObjects();
    const one = { id: 1 };
    const two = { id: 2 };
    for (const next of [[one, { id: 3 }], [{ id: 0 }, one, two], [two, one], [two]]) {
      const shown = new ShownObjects();
      shown.add([one, two]);
      selected.findIn(next, [one, two], { shown, replaces: true });
      expect(shown.has(two)).toBe(true); // something was kept, so nothing was dropped
    }
    const shown = new ShownObjects();
    shown.add([one, two]);
    selected.findIn([{ id: 9 }], [one, two], { shown, replaces: true });
    expect(shown.has(one)).toBe(false);
  });

  it('noteShown reports nothing and notes what a value shows, against what was there before', () => {
    const shown = new ShownObjects();
    const kept = { old: true };
    const made = { by: 'a merge' };
    const selected = remembering(secret);
    selected.noteShown({ kept, made, hidden: secret }, { kept }, { shown });
    expect(shown.has(made)).toBe(true);
    expect(shown.has(kept)).toBe(false); // not new
    expect(shown.has(secret)).toBe(false);
  });
});

describe('findPlanted — at commit: what the stage put in after the write, and nothing else', () => {
  const secret = { token: 't' };
  const never = () => false;

  it('a remembered object that was not there when the stage began is found', () => {
    const box = { x: 1, p: secret };
    expect(remembering(secret).findPlanted(box, { x: 1 }, {}, never)).toEqual([
      { path: ['p'], rule: WHOLE, whole: true },
    ]);
  });

  it('an object the key showed when it was written is passed over, and searched like a plain container', () => {
    // `s.public = h; s.hidden = h`: one object at two places of the stage's own making.
    const h = { made: 'by the stage', later: undefined as unknown };
    const shown = new ShownObjects();
    shown.add([h]);
    const selected = remembering(h);
    expect(selected.findPlanted({ kept: h }, undefined, { shown }, never)).toEqual([]);
    // What was put INTO it afterwards is found all the same.
    h.later = secret;
    selected.remember(secret, WHOLE);
    expect(selected.findPlanted({ kept: h }, undefined, { shown }, never)).toEqual([
      { path: ['kept', 'later'], rule: WHOLE, whole: true },
    ]);
    // Without the note it is a hidden object like any other.
    expect(selected.findPlanted({ kept: h }, undefined, {}, never)).toEqual([
      { path: ['kept'], rule: WHOLE, whole: true },
    ]);
  });

  it('a place that holds what the committed state held there is passed over: nothing new shows', () => {
    // A read after the stage's first write hands out a private copy: a new object, the same content.
    const committed = { backup: { v: 'shared' }, n: 1 };
    const copy = { v: 'shared' };
    const selected = remembering(copy); // the same object also sat under a hidden field
    const same = (now: object, before: object) => JSON.stringify(now) === JSON.stringify(before);
    expect(selected.findPlanted({ backup: copy, n: 2 }, committed, {}, same)).toEqual([]);
    // Moved to a place that held something else, it is found.
    expect(selected.findPlanted({ backup: { v: 'x' }, other: copy }, committed, {}, same)).toEqual([
      { path: ['other'], rule: WHOLE, whole: true },
    ]);
    // In a list too: a private copy of a list is new objects all through, each at the index it had.
    const first = { v: 'one' };
    const second = { v: 'two' };
    const inList = remembering(second);
    const before = { all: [{ v: 'one' }, { v: 'two' }] };
    expect(inList.findPlanted({ all: [first, second] }, before, {}, same)).toEqual([]);
    expect(inList.findPlanted({ all: [second, first] }, before, {}, same)).toEqual([
      { path: ['all'], rule: WHOLE, whole: true },
    ]);
    // `same` is asked only of a remembered object that adds something, never of every container.
    let asked = 0;
    const counting = (now: object, before: object) => {
      asked += 1;
      return same(now, before);
    };
    new SelectedObjects().findPlanted({ a: { b: { c: 1 } } }, { a: { b: { c: 1 } } }, {}, counting);
    expect(asked).toBe(0);
  });

  it('a place its name hides already is passed over, and nothing is noted at commit', () => {
    const profile = { name: 'Ada', ssn: { digits: '1' } };
    const selected = remembering(profile, fields('ssn'));
    const shown = new ShownObjects();
    expect(selected.findPlanted({ ...profile }, undefined, { named: fields('ssn'), shown }, never)).toEqual([]);
    expect(shown.has(profile.ssn)).toBe(false);
  });
});

describe('a rule with very many paths is read once, not once for each member it is asked about', () => {
  // Found by the second reader: 20,000 records with one hidden field each took 2.6 s to remember,
  // because every member scanned every path. Counted here, not timed: a count does not flake.
  const N = 2_000;

  /** A list of paths that counts how often one of them is read. */
  function counted(paths: string[]): { paths: string[]; reads: () => number } {
    let reads = 0;
    const watched = new Proxy(paths, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    return { paths: watched, reads: () => reads };
  }

  it('remember: a list of N records, each hidden at one field named by its index', () => {
    const rows = Array.from({ length: N }, (_, i) => ({ i, secret: { token: `t${i}` } }));
    const rule = counted(rows.map((_, i) => `${i}.secret`));
    const selected = new SelectedObjects();
    selected.remember(rows, { kind: 'fields', key: 'input', paths: rule.paths });
    expect(selected.get(rows[N - 1].secret)).toEqual({ kind: 'whole', key: 'input' });
    expect(selected.get(rows[0])).toEqual({ kind: 'fields', key: 'input', paths: ['secret'] });
    expect(rule.reads()).toBeLessThan(5 * N); // N × N before
  });

  it('findIn: a list of N new items under a name that hides one field of each, by index', () => {
    const rows = Array.from({ length: N }, (_, i) => ({ i, secret: `t${i}` }));
    const named = counted(rows.map((_, i) => `${i}.secret`));
    const shown = new ShownObjects();
    new SelectedObjects().findIn(rows, undefined, {
      named: { kind: 'fields', key: 'copy', paths: named.paths },
      shown,
    });
    expect(shown.has(rows[0])).toBe(false); // each item holds a hidden field
    expect(named.reads()).toBeLessThan(5 * N); // each item asked the name for its own index: N × N before
  });

  it('findIn: a remembered record with N hidden fields at a place whose name hides the same N', () => {
    const record: Record<string, string> = {};
    const paths = Array.from({ length: N }, (_, i) => `k${i}`);
    for (const path of paths) record[path] = 'v';
    const named = counted([...paths]);
    const selected = remembering(record, { kind: 'fields', key: 'profile', paths });
    expect(selected.findIn(record, undefined, { named: { kind: 'fields', key: 'copy', paths: named.paths } })).toEqual(
      [],
    );
    expect(named.reads()).toBeLessThan(5 * N);
  });

  it('two rule objects over ONE frozen list of paths read the list once', () => {
    // A key's verdict is a new rule object every time it is asked for, over the same list, and so is
    // the rule of a run's input in every stage. Kept for the rule object only, the list was read each
    // time. (300, not N: asking a Proxy whether it is frozen walks its keys, which a real list does not.)
    const few = 300;
    const rows = () => Array.from({ length: few }, (_, i) => ({ i, secret: { token: `t${i}` } }));
    const list = counted(Object.freeze(Array.from({ length: few }, (_, i) => `${i}.secret`)) as string[]);
    new SelectedObjects().remember(rows(), { kind: 'fields', key: 'input', paths: list.paths });
    const once = list.reads();
    expect(once).toBeGreaterThan(0);
    const later = new SelectedObjects();
    const again = rows();
    later.remember(again, { kind: 'fields', key: 'input', paths: list.paths });
    expect(later.get(again[few - 1].secret)).toEqual({ kind: 'whole', key: 'input' });
    expect(list.reads()).toBe(once);
  });

  it('a list that can change is read again for each rule object: a field added to it later is seen', () => {
    // A policy's own list is the caller's. A caller who adds a field to it between two runs must see
    // it followed in the next run, so what such a list says is never kept for the list.
    const paths = ['a'];
    const record = { a: { x: 1 }, b: { y: 1 } };
    const first = new SelectedObjects();
    first.remember(record, { kind: 'fields', key: 'profile', paths });
    expect(first.get(record.a)).toEqual({ kind: 'whole', key: 'profile' });
    expect(first.get(record.b)).toBeUndefined();
    paths.push('b');
    const second = new SelectedObjects();
    second.remember(record, { kind: 'fields', key: 'profile', paths });
    expect(second.get(record.b)).toEqual({ kind: 'whole', key: 'profile' });
  });

  it('the same frozen list under another key is read for that key: the rules of the members carry it', () => {
    const paths = Object.freeze(['a', 'b.c']);
    const record = { a: { x: 1 }, b: { c: { y: 1 } } };
    const first = new SelectedObjects();
    first.remember(record, { kind: 'fields', key: 'first', paths });
    expect(first.get(record.a)).toEqual({ kind: 'whole', key: 'first' });
    const second = new SelectedObjects();
    second.remember(record, { kind: 'fields', key: 'second', paths });
    expect(second.get(record.a)).toEqual({ kind: 'whole', key: 'second' });
    expect(second.get(record.b)).toEqual({ kind: 'fields', key: 'second', paths: ['c'] });
    expect(second.get(record.b.c)).toEqual({ kind: 'whole', key: 'second' });
  });

  it('remember: the same record under two rules of N paths adds them up without a scan for each', () => {
    const record: Record<string, string> = { a: 'v' };
    const first = counted(Array.from({ length: N }, (_, i) => `a${i}`));
    const selected = new SelectedObjects();
    selected.remember(record, { kind: 'fields', key: 'one', paths: first.paths });
    selected.remember(record, { kind: 'fields', key: 'two', paths: Array.from({ length: N }, (_, i) => `b${i}`) });
    expect((selected.get(record) as { paths: string[] }).paths).toHaveLength(2 * N);
    expect(first.reads()).toBeLessThan(8 * N);
  });
});
