/**
 * The watch over ONE mapper call (`engine/handlers/mapperEdits.ts`): what it copies, when it judges,
 * and what it leaves alone. The engine's side (which call is watched, when it ends) is in
 * `test/lib/engine/scenario/mapper-reads.test.ts`.
 *
 * Test types: unit (the watch by itself), boundary (values a copy changes, values nothing can copy,
 * a second report), regression (outside development mode nothing is built).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { disableDevMode, enableDevMode } from '../../../../src';
import { type MapperRole, watchForEdits } from '../../../../src/lib/engine/handlers/mapperEdits';

/** A mount as the watch sees it: a name, and the run's redaction rule (none, one that selects nothing, or one that does). */
const mountWith = (rule?: 'inert' | 'active') => ({
  stageName: 'Mount',
  getPolicy: () => ({ redaction: rule === undefined ? undefined : { isInert: () => rule === 'inert' } }),
});

/** The watch of one call, in development mode (where there always is one). */
function watching(mapper: MapperRole, rule?: 'inert' | 'active') {
  const watch = watchForEdits(mountWith(rule), mapper);
  if (watch === undefined) throw new Error('development mode is off: no watch was built');
  return watch;
}

describe('the watch over one mapper call', () => {
  let said: string[];
  beforeEach(() => {
    enableDevMode();
    said = [];
    vi.spyOn(console, 'warn').mockImplementation((text) => {
      said.push(String(text));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    disableDevMode();
  });

  it('builds nothing outside development mode', () => {
    disableDevMode();
    expect(watchForEdits(mountWith(), 'inputMapper')).toBeUndefined();
  });

  it('says nothing for a value the call left as it was', () => {
    const watch = watching('inputMapper');
    watch.saw('profile', { name: 'ann', tags: ['a'] });
    watch.report();
    expect(said).toEqual([]);
  });

  it('names the mount, the mapper, the key and the path of a change', () => {
    const profile = { name: 'ann', deep: { x: [{ q: 1 }, { q: 2 }] } };
    const watch = watching('outputMapper');
    watch.saw('profile', profile);
    profile.deep.x[1].q = 9;
    watch.report();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('Subflow mount "Mount": its outputMapper changed `profile.deep.x[1].q` IN PLACE');
  });

  it('holds on to the FIRST copy of a key: a read after the edit must not hide it', () => {
    const list = [1];
    const watch = watching('inputMapper');
    watch.saw('list', list);
    list.push(2);
    watch.saw('list', list);
    watch.report();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('changed `list');
  });

  it('judges each key by itself, and reports every one that changed', () => {
    const a = { n: 1 };
    const b = { n: 1 };
    const c = [1];
    const watch = watching('inputMapper');
    watch.saw('a', a);
    watch.saw('b', b);
    watch.saw('c', c);
    b.n = 2;
    c.push(2);
    watch.report();
    // Both, not only the first one found (a wrong engine that stopped after one passed the first tests).
    expect(said).toHaveLength(2);
    expect(said[0]).toContain('changed `b.n`');
    expect(said[1]).toContain('changed `c');
  });

  it.each([
    ['a Map', () => new Map([['a', 1]]), (v: Map<string, number>) => v.set('b', 2)],
    ['a Set', () => new Set([1]), (v: Set<number>) => v.add(2)],
    ['a Date', () => new Date(5), (v: Date) => v.setTime(6)],
    [
      'a class instance',
      () =>
        new (class Point {
          x = 1;
        })(),
      (v: { x: number }) => (v.x = 2),
    ],
  ] as const)(
    'tells %s that it is replaced, not merged: the merge-back merges a plain object only',
    (_name, make, edit) => {
      const value = make();
      const watch = watching('inputMapper');
      watch.saw('v', value);
      (edit as (v: unknown) => unknown)(value);
      watch.report();
      expect(said).toHaveLength(1);
      expect(said[0]).toContain('A value of this kind (a Map, a Set, a Date, a class instance) is not merged');
      expect(said[0]).not.toContain('An object handed back');
      expect(said[0]).not.toContain('A list handed back');
    },
  );

  it('gives the advice for a list to a list, and the advice for an object to an object', () => {
    const list = [1];
    const box = { n: 1 };
    const watch = watching('inputMapper');
    watch.saw('list', list);
    watch.saw('box', box);
    list.push(2);
    box.n = 2;
    watch.report();
    expect(said[0]).toContain('A list handed back is ADDED');
    expect(said[0]).not.toContain('An object handed back');
    expect(said[1]).toContain('An object handed back is MERGED');
    expect(said[1]).not.toContain('A list handed back');
  });

  it('reports once, and takes nothing in after the call is over', () => {
    const profile = { name: 'ann' };
    const watch = watching('inputMapper');
    watch.saw('profile', profile);
    profile.name = 'changed';
    watch.report();
    watch.report();
    expect(said).toHaveLength(1);
    // A read made after the call ended (the engine taking the mapper's result) starts no new watch.
    const late = { n: 1 };
    watch.saw('late', late);
    late.n = 2;
    watch.report();
    expect(said).toHaveLength(1);
  });

  it.each([
    ['a text', 'ann'],
    ['a number', 7],
    ['null', null],
    ['undefined', undefined],
  ])('takes no copy of %s: only an object can be changed in place', (_name, value) => {
    const clone = vi.spyOn(globalThis, 'structuredClone');
    const watch = watching('inputMapper');
    watch.saw('k', value);
    watch.report();
    expect(clone).not.toHaveBeenCalled();
    expect(said).toEqual([]);
  });

  it.each([
    ['a Date', () => new Date(5)],
    ['a Map', () => new Map([[1, { a: 1 }]])],
    ['a Set', () => new Set([1, 2])],
    ['a typed array', () => new Uint8Array([1, 2])],
    ['an object with an undefined field', () => ({ a: undefined, b: 1 })],
    [
      'a class instance with a getter',
      () =>
        new (class Point {
          x = 1;
          get y() {
            return 2;
          }
        })(),
    ],
    ['a list with a hole', () => [1, , 3]], // eslint-disable-line no-sparse-arrays
  ])('says nothing for %s that was only read (a copy of it is not the same thing, but it is equal)', (_name, make) => {
    const watch = watching('inputMapper');
    watch.saw('v', make());
    watch.report();
    expect(said).toEqual([]);
  });

  it('names the key and not the place inside it when the run has a redaction rule', () => {
    // A path is made of the value's own field names. Here one of them is an e-mail address.
    const contacts: Record<string, { phone: string }> = { 'ann@example.com': { phone: '1' } };
    const watch = watching('inputMapper', 'active');
    watch.saw('contacts', contacts);
    contacts['ann@example.com'].phone = '2';
    watch.report();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('its inputMapper changed `contacts` IN PLACE (where inside it is not shown');
    expect(said[0]).not.toContain('ann@example.com');
    expect(said[0]).not.toContain('phone');
  });

  it('names the place when the rule selects nothing', () => {
    const profile = { name: 'ann' };
    const watch = watching('inputMapper', 'inert');
    watch.saw('profile', profile);
    profile.name = 'changed';
    watch.report();
    expect(said[0]).toContain('changed `profile.name` IN PLACE,');
  });

  it('asks for the rule when the call is over, not when it starts', () => {
    // A key can be marked as private while a run goes on; what counts is the rule at the report.
    let selects = false;
    const mount = { stageName: 'Mount', getPolicy: () => ({ redaction: { isInert: () => !selects } }) };
    const watch = watchForEdits(mount, 'inputMapper');
    const profile = { name: 'ann' };
    watch?.saw('profile', profile);
    profile.name = 'changed';
    selects = true;
    watch?.report();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('changed `profile` IN PLACE (where inside it is not shown');
  });

  it('leaves out a value that cannot be copied, and still judges the others', () => {
    const uncopyable = { run: () => 1, n: 1 };
    const plain = { n: 1 };
    const watch = watching('inputMapper');
    expect(() => watch.saw('uncopyable', uncopyable)).not.toThrow();
    watch.saw('plain', plain);
    uncopyable.n = 2;
    plain.n = 2;
    watch.report();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('changed `plain.n`');
  });
});
