/**
 * A replaced value commits a row — for every kind a record can hold (9.44.2).
 *
 * The net-change filter drops a write that leaves a path as it was, and asks `deepEqual`
 * (`memory/equality.ts`, the one owner of "what counts as a change") whether it did. Until 9.44.2
 * `deepEqual` knew three kinds — Date, Map, Set — and compared every other object by its own
 * enumerable keys. A RegExp, an Error, a boxed primitive, an ArrayBuffer, a DataView or a Blob has
 * none, so any two of a kind were "equal": the stage wrote, no row was committed,
 * and live state kept the OLD value. A typed array against another typed array type with the same
 * elements was "equal" too.
 *
 *   scenario  per kind, and nested inside an object, an array, a Map and an error's cause: the
 *             replacing stage commits a row, and live state and the record hold the new value
 *   boundary  a replacement with the same content commits no row — the filter still drops a no-op
 *
 * Public doors only — the two stages are written through footprintjs/write (test/helpers/recordRun.ts:
 * the frame a `$setValue` stages on) and read through footprintjs/trace — so the file runs unchanged
 * against any build that has the write door (9.47.0 on).
 */
import { commitValueAt } from '../../../../src/trace';
import { recordRun } from '../../../helpers/recordRun';
import { recordKey } from '../../../helpers/valueKinds';

/** Seed writes `before`, Replace writes `after` — each a stage's `$setValue`, the value as given. */
async function replace(before: unknown, after: unknown) {
  const run = recordRun();
  run.step('seed', (s) => s.set('v', before), { name: 'Seed' });
  run.step('replace', (s) => s.set('v', after), { name: 'Replace' });
  const { commitLog } = run.snapshot();
  return {
    rows: commitLog[1].trace.map((row) => row.path),
    live: run.state.getState().v,
    recorded: commitValueAt(commitLog, 1, 'v'),
  };
}

/** Two values built at ONE call site, so an error's stack differs only where its content does. */
const twoErrors = (make: (n: number) => Error) => [0, 1].map(make) as [Error, Error];
const bytes = (...b: number[]) => new Uint8Array(b).buffer;

const CHANGED: Array<[string, () => [unknown, unknown]]> = [
  ['RegExp: another source', () => [/x/g, /y/g]],
  ['RegExp: other flags', () => [/x/g, /x/i]],
  ['Error: another message', () => twoErrors((n) => new Error(n ? 'b' : 'a'))],
  ['Error: another kind', () => twoErrors((n) => new (n ? RangeError : TypeError)('m'))],
  ['Error: another cause', () => twoErrors((n) => new Error('m', { cause: { n } }))],
  ['boxed Number', () => [Object(1), Object(2)]],
  ['boxed Boolean', () => [Object(true), Object(false)]],
  ['boxed String', () => [Object('a'), Object('b')]],
  ['boxed BigInt', () => [Object(1n), Object(2n)]],
  ['boxed: another wrapper type', () => [Object(1), Object('1')]],
  ['ArrayBuffer: other bytes', () => [bytes(1), bytes(2)]],
  [
    'ArrayBuffer: resizable vs fixed',
    () => [
      bytes(1),
      new (ArrayBuffer as unknown as new (n: number, o: object) => ArrayBuffer)(1, { maxByteLength: 4 }),
    ],
  ],
  ['DataView: other bytes', () => [new DataView(bytes(1)), new DataView(bytes(2))]],
  ['DataView: another offset', () => [new DataView(bytes(1, 1), 0), new DataView(bytes(1, 1), 1)]],
  ['typed array: another type, same elements', () => [new Uint8Array([1]), new Int8Array([1])]],
  ['Blob: another blob', () => [new Blob(['a']), new Blob(['a'])]],
  ['nested in an object', () => [{ re: /x/ }, { re: /y/ }]],
  ['nested in an array', () => [[Object(1)], [Object(2)]]],
  ['nested in a Map', () => [new Map([['k', /x/]]), new Map([['k', /y/]])]],
  ['nested in an error cause', () => twoErrors((n) => new Error('m', { cause: n ? /y/ : /x/ }))],
];

describe('a replaced value commits a row — every kind (9.44.2)', () => {
  it.each(CHANGED)('%s', async (_name, make) => {
    const [before, after] = make();
    const { rows, live, recorded } = await replace(before, after);
    expect(rows).toEqual(['v']);
    expect(recordKey(live, 'kind')).toBe(recordKey(after, 'kind'));
    expect(recordKey(recorded, 'kind')).toBe(recordKey(after, 'kind'));
  });
});

const SAME: Array<[string, () => [unknown, unknown]]> = [
  [
    'a view: the same bytes, wherever they sit in its buffer',
    () => [new Uint8Array(bytes(9, 1, 2), 1, 1), new Uint8Array(bytes(1, 3), 0, 1)],
  ],
  ['a Node Buffer: the same bytes, another slice of the pool', () => [Buffer.from('hi'), Buffer.from('hi')]],
  ['Date', () => [new Date(1), new Date(1)]],
  ['RegExp', () => [/x/g, /x/g]],
  [
    'Error and its clone',
    () => {
      const error = new Error('m', { cause: { n: 1 } });
      return [error, structuredClone(error)];
    },
  ],
  ['boxed Number', () => [Object(1), Object(1)]],
  ['ArrayBuffer', () => [bytes(1, 2), bytes(1, 2)]],
  ['typed array', () => [new Float64Array([1.5]), new Float64Array([1.5])]],
  ['DataView', () => [new DataView(bytes(3)), new DataView(bytes(3))]],
  [
    'nested',
    () => [
      { at: new Date(1), tags: new Set(['a']) },
      { at: new Date(1), tags: new Set(['a']) },
    ],
  ],
];

describe('a replacement with the same content commits no row (the filter still drops a no-op)', () => {
  it.each(SAME)('%s', async (_name, make) => {
    const [before, after] = make();
    expect((await replace(before, after)).rows).toEqual([]);
  });
});

/**
 * A built-in is known by its BRAND, never its prototype (9.44.2, `capture/valueKinds.ts · kindOf`).
 * `Object.create(RegExp.prototype)` has RegExp's prototype and none of its slots: reading `source`
 * from it throws, and its clone is `{}`. Classified by prototype, writing one over a real RegExp threw
 * a TypeError at commit (main committed no row). Now it is what its clone is — a plain object — so the
 * replacement commits a row and live state holds `{}`, as the record does.
 */
const FAKES: Array<[string, () => object, () => object]> = [
  ['Date', () => new Date(1), () => Object.create(Date.prototype)],
  ['RegExp', () => /x/g, () => Object.create(RegExp.prototype)],
  ['Map', () => new Map([['k', 1]]), () => Object.create(Map.prototype)],
  ['Set', () => new Set([1]), () => Object.create(Set.prototype)],
  ['Error', () => new Error('e'), () => Object.create(Error.prototype)],
  ['Number', () => Object(1), () => Object.create(Number.prototype)],
  ['BigInt', () => Object(1n), () => Object.create(BigInt.prototype)],
  ['ArrayBuffer', () => bytes(1), () => Object.create(ArrayBuffer.prototype)],
  ['Uint8Array', () => new Uint8Array([1]), () => Object.create(Uint8Array.prototype)],
  ['DataView', () => new DataView(bytes(1)), () => Object.create(DataView.prototype)],
];

describe('a value with a built-in’s prototype but not its brand is what its clone is (9.44.2)', () => {
  it.each(FAKES)('%s: a fake over a real one commits a row and holds {}', async (_kind, real, fake) => {
    const { rows, live } = await replace(real(), fake());
    expect(rows).toEqual(['v']);
    expect(Object.getPrototypeOf(live)).toBe(Object.prototype);
    expect(Object.keys(live as object)).toEqual([]);
  });

  it.each(FAKES)('%s: a real one over a fake commits a row and holds the real one', async (_kind, real, fake) => {
    const value = real();
    const { rows, live } = await replace(fake(), value);
    expect(rows).toEqual(['v']);
    expect(recordKey(live, 'kind')).toBe(recordKey(value, 'kind'));
  });
});
