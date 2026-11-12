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

import { CLEAR, RedactionRule } from '../../../../src/lib/memory/redaction';
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

  it('the late search follows only what came from committed state, and still looks inside the rest', () => {
    const own = { made: 'by the stage' };
    const fromState = { token: 't' };
    const selected = new SelectedObjects();
    selected.remember(own, WHOLE); // the stage wrote it under a hidden name itself, and read it back
    selected.remember(fromState, WHOLE, true);
    const value = { a: own, b: fromState, c: { ...own, inner: fromState } };
    expect(selected.findIn(value, undefined)).toHaveLength(3);
    expect(selected.findIn(value, undefined, true)).toEqual([
      { path: ['c', 'inner'], rule: WHOLE, whole: true },
      { path: ['b'], rule: WHOLE, whole: true },
    ]);
    // A copy the scope made carries where its original came from.
    const copy = { token: 't' };
    selected.copyOf(copy, fromState);
    expect(selected.findIn({ x: copy }, undefined, true)).toHaveLength(1);
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

  it('a value that holds itself is searched once', () => {
    const loop: Record<string, unknown> = { p: secret };
    loop.self = loop;
    expect(remembering(secret).findIn(loop, undefined)).toEqual([{ path: ['p'], rule: WHOLE, whole: true }]);
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

  it('the key’s whole old value, nested under its new one, is not entered: it was there before', () => {
    const old = watched();
    const base = { kept: old.node, depth: 1 };
    // `history = { prev: history }`: the old value sits one level down, where nothing was before.
    expect(remembering(secret).findIn({ prev: base, depth: 2 }, base)).toEqual([]);
    expect(remembering(secret).findIn({ list: [base], p: secret }, base)).toEqual([
      { path: ['p'], rule: WHOLE, whole: true },
    ]);
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

  it('the SAME object written back is searched whole: a stage does that after changing it in place', () => {
    const ctx = frame(new RedactionRule({ keys: ['profile'] }), { profile: { name: 'Ada' } });
    const profile = ctx.getValue([], 'profile');
    const box: Record<string, unknown> = { x: 1 };
    expect(ctx.setObject([], 'box', box)).toBe(CLEAR);
    box.owner = profile; // in place
    const findIn = vi.spyOn(SelectedObjects.prototype, 'findIn');
    expect(ctx.setObject([], 'box', box)).toEqual({ kind: 'fields', key: 'box', paths: ['owner'] });
    expect(findIn.mock.calls[0][1]).toBeUndefined(); // nothing to compare against: all of it is searched
  });

  it('what a stage puts into an object AFTER writing it is found at commit, and the record hides it', () => {
    const rule = new RedactionRule({ keys: ['profile'] });
    const heap = new SharedMemory(undefined, { profile: { name: 'Ada' } });
    const log = new EventLog(heap.getState());
    const ctx = new StageContext('', 's', 's', heap, '', log);
    ctx.useRedactionRule(rule);
    const profile = ctx.getValue([], 'profile');
    const box: Record<string, unknown> = { x: 1 };
    ctx.setObject([], 'box', box);
    box.owner = profile; // no write shows this
    ctx.commit();
    expect(rule.verdict(['box'])).toEqual({ kind: 'fields', key: 'box', paths: ['owner'] });
    const bundle = log.recorded().at(-1);
    expect(JSON.stringify(bundle)).not.toContain('Ada');
    expect((heap.getState().box as { owner: unknown }).owner).toEqual({ name: 'Ada' }); // live state is real
  });

  it('a commit that finds nothing new leaves the record as the writes made it', () => {
    const rule = new RedactionRule({ keys: ['profile'] });
    const heap = new SharedMemory(undefined, { profile: { name: 'Ada' }, box: { x: 1 } });
    const log = new EventLog(heap.getState());
    const ctx = new StageContext('', 's', 's', heap, '', log);
    ctx.useRedactionRule(rule);
    const profile = ctx.getValue([], 'profile');
    ctx.updateObject([], 'box', { owner: profile }); // a merge, found when it was written
    ctx.commit();
    const bundle = log.recorded().at(-1) as { trace: { path: string; verb: string }[] };
    expect(bundle.trace.map((row) => row.verb)).toEqual(['merge']); // not staged again as a set
  });

  it('one object the stage itself put under a public name and a hidden name is not followed back in time', () => {
    // `b` is hidden by the policy, `hist` is not. The stage writes the same object under both and reads
    // it back under the hidden name. It was public where it already sat: `hist` stays as it is.
    const rule = new RedactionRule({ keys: ['b'] });
    const heap = new SharedMemory();
    const log = new EventLog(heap.getState());
    const ctx = new StageContext('', 's', 's', heap, '', log);
    ctx.useRedactionRule(rule);
    const shared = { note: 'public' };
    ctx.setObject([], 'hist', shared);
    ctx.setObject([], 'b', shared);
    ctx.getValue([], 'b');
    ctx.commit();
    expect(rule.verdict(['hist'])).toBe(CLEAR);
    expect((log.recorded().at(-1) as { overwrite: Record<string, unknown> }).overwrite.hist).toEqual({
      note: 'public',
    });
    // What the stage writes AFTER reading it back is followed as any hidden object is.
    const next = new StageContext('', 't', 't', heap, '', log);
    next.useRedactionRule(rule);
    const read = next.getValue([], 'b');
    expect(next.setObject([], 'copy', { held: read })).toEqual({ kind: 'fields', key: 'copy', paths: ['held'] });
  });

  it('a read with no key hands the stage everything: each selected value in it is remembered', () => {
    const rule = new RedactionRule({ keys: ['profile'], fields: { card: ['number'] } });
    const heap = new SharedMemory(undefined, {
      profile: { name: 'Ada' },
      card: { number: '4242', owner: { name: 'Ada' } },
      open: { note: 'n' },
      runs: { b1: { profile: { name: 'Bea' } } },
    });
    const ctx = new StageContext('', 's', 's', heap, '', new EventLog(heap.getState()));
    ctx.useRedactionRule(rule);
    const state = ctx.getValue([]) as Record<string, any>; // the whole state
    expect(ctx.setObject([], 'a', { held: state.profile })).toEqual({ kind: 'fields', key: 'a', paths: ['held'] });
    expect(ctx.setObject([], 'b', { held: state.card })).toEqual({ kind: 'fields', key: 'b', paths: ['held.number'] });
    expect(ctx.setObject([], 'c', { held: state.runs.b1.profile })).toEqual({
      kind: 'fields',
      key: 'c',
      paths: ['held'],
    });
    expect(ctx.setObject([], 'd', { held: state.open })).toBe(CLEAR);

    // And a read of a path with no key: the value at a selected path.
    const other = new StageContext('', 't', 't', heap, '', new EventLog(heap.getState()));
    other.useRedactionRule(rule);
    const profile = other.getValue(['profile']);
    expect(other.setObject([], 'e', [profile])).toEqual({ kind: 'whole', key: 'e' });
  });

  it('a place the record cannot name is cut back to the keys above it, and everything there is hidden', () => {
    const rule = new RedactionRule({ keys: ['profile'], fields: { card: ['number'] } });
    const ctx = frame(rule, { profile: { name: 'Ada' }, card: { number: '4242' } });
    const profile = ctx.getValue([], 'profile');
    const card = ctx.getValue([], 'card');
    // A key the record's scrub refuses to reach: the place above it.
    expect(ctx.setObject([], 'a', { inner: { constructor: profile, x: 1 } })).toEqual({
      kind: 'fields',
      key: 'a',
      paths: ['inner'],
    });
    expect(ctx.setObject([], 'b', { prototype: profile })).toEqual({ kind: 'whole', key: 'b' });
    expect(ctx.setObject([], 'c', JSON.parse('{"__proto__":{"deep":1}}'))).toBe(CLEAR); // nothing hidden in it
    // One key with a dot in it is a field of its own. Below it, or above it, a dotted key cannot be spelled.
    expect(ctx.setObject([], 'd', { 'x.y': profile, z: 1 })).toEqual({ kind: 'fields', key: 'd', paths: ['x.y'] });
    expect(ctx.setObject([], 'e', { 'x.y': { deep: profile } })).toEqual({ kind: 'whole', key: 'e' });
    expect(ctx.setObject([], 'f', { up: { 'x.y': profile } })).toEqual({ kind: 'fields', key: 'f', paths: ['up'] });
    // A record hidden by its fields, under a dotted key: its fields cannot be spelled there, so all of it.
    expect(ctx.setObject([], 'g', { 'x.y': card })).toEqual({ kind: 'fields', key: 'g', paths: ['x.y'] });
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
