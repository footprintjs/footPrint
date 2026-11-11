/**
 * A read is retained ONCE for each object a key holds, and the record must not notice.
 *
 * `memory/keptReads.ts` does not retain a read again when the root key still holds the object it held
 * at the last retained read and the frame has not written under that root. The judge here is the rule it
 * replaced, rebuilt beside it: retain at EVERY read. Each call of `keepOnce` is seen first by a wrapper
 * that keeps what the old rule would have kept (the same retained form, taken there and then). At the end
 * of a run every frame's reads must equal that, key for key and in the same order.
 *
 * The programs use the typed scope the way an app does. Reads of every kind: a key, an element by index,
 * a field, a walk over a list, `find`, a spread, `JSON.stringify`, the raw read. Writes of every kind: a
 * new value, a nested field, an element, `push`, `$update`, `delete`, one key assigned to another, and an
 * object the program keeps and changes afterwards (`s.k = o; o.n += 1`, which is allowed). A stage may
 * fail its first attempt and run again.
 *
 * What the programs never do is change in place a value they only read. That is outside the contract,
 * and it is the one case in which the two rules differ (`test/lib/memory/scenario/read-kept-once.test.ts`).
 */
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { summarizeReadValue } from '../../../../src/lib/capture/summarize.js';
import { userKeyOf } from '../../../../src/lib/memory/redaction.js';
import { retainedForm } from '../../../../src/lib/memory/retainedValue/index.js';
import { StageContext } from '../../../../src/lib/memory/StageContext';

type Json = Record<string, any>;

/** What "retain at every read" keeps, per frame, for the run in progress. */
const everyRead = new Map<object, Json>();
/** How often the rule under test kept what was there, over the whole file: the property must exercise it. */
let keptAsItWas = 0;

const frames = StageContext.prototype as unknown as Json;
const real = { keepOnce: frames.keepOnce, discardStaged: frames.discardStaged };
beforeAll(() => {
  frames.keepOnce = function (this: Json, path: string[], key: string, value: unknown, verdict: unknown) {
    const expected = everyRead.get(this) ?? {};
    everyRead.set(this, expected);
    const userKey = userKeyOf(path, key);
    expected[userKey] =
      value === undefined
        ? undefined
        : retainedForm(verdict as never, value, this.policy.readTracking, summarizeReadValue);
    const before = this._stageReads[userKey];
    real.keepOnce.call(this, path, key, value, verdict);
    if (before !== undefined && this._stageReads[userKey] === before && typeof before === 'object') keptAsItWas += 1;
  };
  // A failed attempt's reads are dropped with its writes.
  frames.discardStaged = function (this: Json) {
    everyRead.delete(this);
    return real.discardStaged.call(this);
  };
});
afterAll(() => {
  frames.keepOnce = real.keepOnce;
  frames.discardStaged = real.discardStaged;
});

const KEYS = ['a', 'b', 'c'] as const;
type Key = (typeof KEYS)[number];
const FIELDS = ['n', 'inner', 'list', 'extra'] as const;

type Op =
  | { op: 'read' | 'walk' | 'find' | 'spread' | 'json' | 'raw' | 'delete'; key: Key }
  | { op: 'index'; key: Key; at: number }
  | { op: 'field'; key: Key; name: (typeof FIELDS)[number] }
  | { op: 'set'; key: Key; shape: number }
  | { op: 'hold'; key: Key; held: number }
  | { op: 'change'; held: number }
  | { op: 'alias'; from: Key; to: Key }
  | { op: 'nested'; key: Key; name: (typeof FIELDS)[number]; value: number }
  | { op: 'element'; key: Key; at: number; value: number }
  | { op: 'push' | 'update'; key: Key; value: number };

interface Prog {
  readTracking: 'full' | 'summary';
  policy: boolean;
  stages: { ops: Op[]; failsOnce: boolean }[];
}

const key = fc.constantFrom(...KEYS);
const field = fc.constantFrom(...FIELDS);
const small = fc.integer({ min: 0, max: 6 });
const op: fc.Arbitrary<Op> = fc.oneof(
  // Reads carry more weight: the rule under test is about a key read again and again.
  { weight: 6, arbitrary: fc.record({ op: fc.constantFrom('read', 'walk', 'find', 'spread', 'json', 'raw'), key }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant('index' as const), key, at: small }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant('field' as const), key, name: field }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('set' as const), key, shape: fc.integer({ min: 0, max: 4 }) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('hold' as const), key, held: fc.integer({ min: 0, max: 2 }) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('change' as const), held: fc.integer({ min: 0, max: 2 }) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('alias' as const), from: key, to: key }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('nested' as const), key, name: field, value: small }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('element' as const), key, at: small, value: small }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constantFrom('push', 'update'), key, value: small }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('delete' as const), key }) },
) as fc.Arbitrary<Op>;
const prog: fc.Arbitrary<Prog> = fc.record({
  readTracking: fc.constantFrom('full' as const, 'summary' as const),
  policy: fc.boolean(),
  stages: fc.array(fc.record({ ops: fc.array(op, { minLength: 3, maxLength: 16 }), failsOnce: fc.boolean() }), {
    minLength: 2,
    maxLength: 4,
  }),
});

/** A new value of one of the shapes a state holds. */
function fresh(shape: number): unknown {
  if (shape === 0) return Array.from({ length: 5 }, (_, id) => ({ id, tag: `t${id}`, n: id }));
  if (shape === 1) return { n: 1, inner: { m: 2, list: [1, 2] }, list: [{ id: 0 }, { id: 1 }] };
  if (shape === 2) return 7;
  if (shape === 3) return 'some text';
  return null;
}

/** The objects a program keeps and may change after it has written them. */
const heldObjects = (): Json[] => [{ n: 0, list: [0] }, [{ n: 0 }], { inner: { n: 0 }, list: [] }];

/** Change `held` in place, whatever it is. */
function change(held: Json): void {
  if (Array.isArray(held)) held.push({ n: held.length });
  else {
    held.n = ((held.n as number) ?? 0) + 1;
    if (held.inner) held.inner.n += 1;
    (held.list as unknown[]).push(held.list.length);
  }
}

const isRecord = (value: unknown): value is Json => value !== null && typeof value === 'object';
/** A read whose value the program does not use: the read itself is the point. */
const read = (_value: unknown): void => undefined;

/** One op on the typed scope. A read that does not fit the value it finds is still a read. */
function apply(s: Json, o: Op, held: Json[]): void {
  switch (o.op) {
    case 'read':
      read(s[o.key]);
      return;
    case 'raw':
      read(s.$getValue(o.key));
      return;
    case 'index':
      read(s[o.key]?.[o.at]?.id);
      return;
    case 'field':
      read(s[o.key]?.[o.name]);
      return;
    case 'walk': {
      const length = Array.isArray(s[o.key]) ? s[o.key].length : 0;
      for (let i = 0; i < length; i++) read(s[o.key][i]);
      return;
    }
    case 'find':
      if (Array.isArray(s[o.key])) read(s[o.key].find((item: Json) => item?.id === 1));
      return;
    case 'spread':
      if (isRecord(s[o.key])) read({ ...s[o.key] });
      return;
    case 'json':
      read(JSON.stringify(s[o.key]));
      return;
    case 'set':
      s[o.key] = fresh(o.shape);
      return;
    case 'hold':
      s[o.key] = held[o.held];
      return;
    case 'change':
      change(held[o.held]);
      return;
    case 'alias':
      if (s[o.from] !== undefined) s[o.to] = s[o.from];
      return;
    case 'nested':
      if (isRecord(s[o.key]) && !Array.isArray(s[o.key])) s[o.key][o.name] = { v: o.value };
      return;
    case 'element':
      if (Array.isArray(s[o.key]) && o.at < s[o.key].length) s[o.key][o.at] = { id: o.at, v: o.value };
      return;
    case 'push':
      if (Array.isArray(s[o.key])) s[o.key].push({ id: 100 + o.value });
      return;
    case 'update':
      if (isRecord(s[o.key]) && !Array.isArray(s[o.key])) s.$update(o.key, { extra: { v: o.value } });
      return;
    case 'delete':
      delete s[o.key];
  }
}

const quiet = { info() {}, log() {}, debug() {}, error() {}, warn() {} };

async function run(p: Prog): Promise<{ frames: [Json, Json][]; state: Json }> {
  everyRead.clear();
  const held = heldObjects();
  const failed = new Set<number>();
  const stageFn = (index: number) => (s: Json) => {
    const { ops, failsOnce } = p.stages[index];
    for (const o of ops) apply(s, o, held);
    if (failsOnce && !failed.has(index)) {
      failed.add(index);
      throw new Error('first attempt fails');
    }
  };
  let builder: any = flowChart<Json>(
    'Seed',
    (s) => {
      s.a = fresh(0);
      s.b = fresh(1);
      s.c = fresh(1);
    },
    'seed',
  );
  p.stages.forEach((_, index) => {
    builder = builder.addFunction(`Stage ${index}`, stageFn(index), `stage${index}`).retry({ attempts: 2 });
  });
  const executor = new FlowChartExecutor(builder.setLogger(quiet).build(), { readTracking: p.readTracking });
  if (p.policy) executor.setRedactionPolicy({ keys: ['b'], fields: { c: ['n', 'inner.m'] } });
  await executor.run();
  return {
    frames: [...everyRead].map(([frame, expected]) => [(frame as Json)._stageReads as Json, expected]),
    state: executor.getSnapshot().sharedState as Json,
  };
}

/** Every object reachable from `root`. */
function objectsOf(root: unknown, seen = new Set<object>()): Set<object> {
  if (!isRecord(root) || seen.has(root)) return seen;
  seen.add(root);
  for (const value of Object.values(root)) objectsOf(value, seen);
  return seen;
}

describe('a read kept once per object leaves the record a read kept every time would', () => {
  it('every frame keeps the same reads, in the same order, and never the state object itself', async () => {
    await fc.assert(
      fc.asyncProperty(prog, async (p) => {
        const { frames: ran, state } = await run(p);
        const live = objectsOf(state);
        for (const [kept, expected] of ran) {
          expect(Object.keys(kept)).toEqual(Object.keys(expected));
          expect(kept).toStrictEqual(expected);
          if (p.readTracking !== 'full') continue;
          for (const value of Object.values(kept)) if (isRecord(value)) expect(live.has(value)).toBe(false);
        }
      }),
      { numRuns: 300 },
    );
    // The programs did read the same object again: the rule was exercised, not just passed by.
    expect(keptAsItWas).toBeGreaterThan(300);
  });
});
