/**
 * Unit tests — `memory/verbs.ts`, the one verb law.
 *
 * The step (`applyVerb`) arm by arm, `placeVerb`, the vocabulary and its two
 * traits (pinned AGAINST the step, so a verb cannot misreport them),
 * `RecordedPayload` (the clone discipline: the merge delta detached once),
 * `foldRows` under its three disciplines, `foldKey` with and without the anchor,
 * and the shape of `UnknownVerbError`. The old replicas are compared against
 * this module in property/verb-law-differential.property.test.ts.
 */
import { DELIM } from '../../../../src/lib/memory/paths';
import type { CommitBundle, MemoryPatch, TraceEntry } from '../../../../src/lib/memory/types';
import {
  type Touch,
  type Verb,
  ABSENT,
  applyVerb,
  foldKey,
  foldRows,
  isTotal,
  isVerb,
  placeVerb,
  RecordedPayload,
  recordsTail,
  UnknownVerbError,
  VERBS,
} from '../../../../src/lib/memory/verbs';

const payload = (updates: MemoryPatch = {}, overwrite: MemoryPatch = {}, detach = true, only?: string[]) =>
  new RecordedPayload(updates, overwrite, detach, only);

/** Every node a `structuredClone` inside `run` is handed — the work the clone does. */
function clonedNodes(run: () => unknown): number {
  const count = (v: unknown, seen = new WeakSet<object>()): number => {
    if (v === null || typeof v !== 'object' || seen.has(v)) return 1;
    seen.add(v);
    return 1 + Object.values(v).reduce<number>((n, c) => n + count(c, seen), 0);
  };
  let nodes = 0;
  const real = globalThis.structuredClone;
  globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
    nodes += count(value);
    return real(value, options);
  }) as typeof structuredClone;
  try {
    run();
  } finally {
    globalThis.structuredClone = real;
  }
  return nodes;
}

describe('the vocabulary', () => {
  it('VERBS is the contract, in order, and frozen', () => {
    expect([...VERBS]).toEqual(['set', 'merge', 'append', 'delete']);
    expect(Object.isFrozen(VERBS)).toBe(true);
  });

  it('isVerb accepts exactly the four', () => {
    for (const verb of VERBS) expect(isVerb(verb)).toBe(true);
    for (const not of ['', 'SET', 'Set', ' set', 'upsert', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(isVerb(not)).toBe(false);
    }
    for (const not of [undefined, null, 0, 1, true, {}, [], ['set'], Symbol('set')]) expect(isVerb(not)).toBe(false);
  });
});

describe('applyVerb — one row, one step', () => {
  it("'set' is the recorded value, as a clone", () => {
    const recorded = { list: [1, { n: 2 }] };
    const out = applyVerb('set', 'whatever was there', payload({}, { k: recorded }), ['k']);
    expect(out).toEqual(recorded);
    expect(out).not.toBe(recorded);
  });

  it("'append' concatenates onto an array — and otherwise the tail BECOMES the value", () => {
    expect(applyVerb('append', [1, 2], payload({}, { k: [3] }), ['k'])).toEqual([1, 2, 3]);
    expect(applyVerb('append', undefined, payload({}, { k: [3] }), ['k'])).toEqual([3]);
    expect(applyVerb('append', 'not an array', payload({}, { k: [3] }), ['k'])).toEqual([3]);
    expect(applyVerb('append', [1], payload({}, { k: 'REDACTED' }), ['k'])).toBe('REDACTED'); // a redacted tail
  });

  it("'delete' is ABSENT — the key is gone, which is not the value undefined", () => {
    expect(applyVerb('delete', [1], payload({}, { k: undefined }), ['k'])).toBe(ABSENT);
    expect(ABSENT).not.toBeUndefined();
  });

  it("'merge' unions arrays, merges objects, and lets a primitive replace", () => {
    expect(applyVerb('merge', [1, 2], payload({ k: [2, 3] }), ['k'])).toEqual([1, 2, 3]);
    expect(applyVerb('merge', { a: 1, n: { x: 1 } }, payload({ k: { b: 2, n: { y: 2 } } }), ['k'])).toEqual({
      a: 1,
      b: 2,
      n: { x: 1, y: 2 },
    });
    expect(applyVerb('merge', 1, payload({ k: 2 }), ['k'])).toBe(2);
    expect(applyVerb('merge', undefined, payload({ k: { a: 1 } }), ['k'])).toEqual({ a: 1 });
  });

  it('a verb that got past the types is refused, not folded as a merge', () => {
    expect(() => applyVerb('upsert' as unknown as Verb, 1, payload(), ['k'])).toThrow(UnknownVerbError);
  });
});

describe('placeVerb', () => {
  it('sets at a path, creating the containers on the way', () => {
    const out: Record<string, unknown> = {};
    placeVerb(out, ['a', 'b', 'c'], 1);
    expect(out).toEqual({ a: { b: { c: 1 } } });
  });

  it('ABSENT removes the key — and removing an absent key is a no-op', () => {
    const out = { a: { b: 1, keep: 2 } };
    placeVerb(out, ['a', 'b'], ABSENT);
    expect(out).toEqual({ a: { keep: 2 } });
    expect(() => placeVerb(out, ['x', 'y'], ABSENT)).not.toThrow();
    expect(out).toEqual({ a: { keep: 2 } });
  });

  it('a prototype-pollution segment is inert', () => {
    placeVerb({}, ['__proto__', 'polluted'], 1);
    placeVerb({}, ['__proto__', 'polluted'], ABSENT);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('the traits are pinned against the step', () => {
  const BEFORES: unknown[] = [undefined, null, 0, 'x', [], [1], {}, { a: 1 }, [{ n: 1 }]];
  const show = (v: unknown) => (v === ABSENT ? '<absent>' : JSON.stringify(v) ?? 'undefined');

  it('isTotal(verb) holds exactly when the step ignores the value before it', () => {
    for (const verb of VERBS) {
      const answers = BEFORES.map((before) =>
        show(applyVerb(verb, before, payload({ k: { z: 1 } }, { k: [9] }), ['k'])),
      );
      expect(isTotal(verb), `${verb}: ${[...new Set(answers)].join(' | ')}`).toBe(new Set(answers).size === 1);
    }
    expect(VERBS.filter(isTotal)).toEqual(['set', 'delete']);
  });

  it('recordsTail names the one verb whose payload is a tail, and that verb extends the array', () => {
    expect(VERBS.filter(recordsTail)).toEqual(['append']);
    expect(applyVerb('append', [1], payload({}, { k: [2] }), ['k'])).toEqual([1, 2]);
  });
});

describe('RecordedPayload — the clone discipline', () => {
  it('detaches the merge delta ONCE: every read of a bundle sees the same objects', () => {
    const updates = { k: [{ n: 1 }] };
    const at = payload(updates);
    const first = at.delta(['k']) as unknown[];
    expect(at.delta(['k'])).toBe(first);
    expect(first).toEqual(updates.k);
    expect(first).not.toBe(updates.k);
    expect(first[0]).not.toBe(updates.k[0]);
  });

  it('hands out a fresh clone of a recorded value per read — or, not detaching, the recorded reference', () => {
    const overwrite = { k: { v: 1 } };
    const detached = payload({}, overwrite);
    expect(detached.value(['k'])).toEqual({ v: 1 });
    expect(detached.value(['k'])).not.toBe(detached.value(['k']));
    expect(payload({}, overwrite, false).value(['k'])).toBe(overwrite.k);
    expect(payload({ k: { z: 1 } }, {}, false).delta(['k'])).toEqual({ z: 1 });
  });

  it('pays for the delta only when a `merge` row asks — and `only` clones the one path, not the rest of the bundle', () => {
    const big = { rows: Array.from({ length: 200 }, (_, i) => ({ i })) };
    const updates = { big, small: [{ n: 1 }] };
    // no merge row: no delta clone (`value` of an absent path clones `undefined` — one node)
    expect(clonedNodes(() => payload(updates).value(['small']))).toBe(1);
    const whole = clonedNodes(() => payload(updates).delta(['small']));
    const narrowed = clonedNodes(() => payload(updates, {}, true, ['small']).delta(['small']));
    expect(whole).toBeGreaterThan(400);
    expect(narrowed).toBeLessThan(10);
    expect(payload(updates, {}, true, ['small']).delta(['small'])).toEqual([{ n: 1 }]);
  });

  it('an absent delta reads as undefined, never throws', () => {
    expect(payload({}, {}, true, ['gone']).delta(['gone'])).toBeUndefined();
    expect(payload({ a: 1 }).delta(['a', 'b', 'c'])).toBeUndefined();
  });
});

describe('foldRows — one loop, three disciplines', () => {
  const rows = (...spec: Array<[string, Verb]>): TraceEntry[] => spec.map(([path, verb]) => ({ path, verb }));

  it("'private' edits `out` in place and returns it", () => {
    const out = { a: 1 };
    const result = foldRows(out, {}, { b: 2 }, rows(['b', 'set']), 'private');
    expect(result).toBe(out);
    expect(out).toEqual({ a: 1, b: 2 });
  });

  it("'byReference' places a recorded value AS recorded; the others clone it", () => {
    const overwrite = { k: { v: 1 } };
    const trace = rows(['k', 'set']);
    expect(foldRows({}, {}, overwrite, trace, 'byReference').k).toBe(overwrite.k);
    for (const discipline of ['private', 'pathCopy'] as const) {
      const out = foldRows({}, {}, overwrite, trace, discipline);
      expect(out.k).toEqual(overwrite.k);
      expect(out.k).not.toBe(overwrite.k);
    }
  });

  it("'byReference' never edits the log: a later row that writes through a placed value copies it first", () => {
    const overwrite = { a: { x: 1, y: 2 } };
    const result = foldRows({}, {}, overwrite, rows(['a', 'set'], ['a' + DELIM + 'y', 'set']), 'byReference');
    expect(result.a).toEqual({ x: 1, y: 2 });
    expect(result.a).not.toBe(overwrite.a); // written through, so copied
    expect(overwrite).toEqual({ a: { x: 1, y: 2 } });
  });

  it("'pathCopy' copies a container it did not create before writing through it", () => {
    const shared = { x: 1 };
    const base = { a: shared, other: { keep: true } };
    const result = foldRows({ ...base }, {}, { a: { x: 2 } }, rows(['a' + DELIM + 'x', 'set']), 'pathCopy');
    expect(result.a).toEqual({ x: 2 });
    expect(shared).toEqual({ x: 1 }); // the generation before is intact
    expect(result.other).toBe(base.other); // and untouched subtrees are shared
  });

  it('skips a set the next row sets again — and only that', () => {
    const overwrite = { k: [1] };
    const consecutive = clonedNodes(() =>
      foldRows({}, {}, overwrite, rows(['k', 'set'], ['k', 'set'], ['k', 'set']), 'private'),
    );
    expect(consecutive).toBe(clonedNodes(() => foldRows({}, {}, overwrite, rows(['k', 'set']), 'private')));
  });

  it('refuses an unknown verb, naming the row it stopped at', () => {
    const trace = [
      { path: 'a', verb: 'set' },
      { path: 'b', verb: 'upsert' },
    ] as TraceEntry[];
    let thrown: unknown;
    try {
      foldRows({}, {}, { a: 1, b: 2 }, trace, 'private');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnknownVerbError);
    expect(thrown).toMatchObject({ verb: 'upsert', path: 'b', row: 1 });
    expect((thrown as UnknownVerbError).commit).toBeUndefined();
  });
});

describe('foldKey — one path across a log', () => {
  const bundle = (overwrite: MemoryPatch, updates: MemoryPatch = {}): CommitBundle => ({
    stage: 'S',
    stageId: 's',
    runtimeStageId: 's#0',
    trace: [],
    redactedPaths: [],
    overwrite,
    updates,
  });
  const touch = (verb: Verb, b: CommitBundle, commitIdx: number): Touch => ({ verb, bundle: b, commitIdx });

  it('folds from an absent key: set, append, merge, delete', () => {
    const b0 = bundle({ k: [1] });
    const b1 = bundle({ k: [2] });
    const b2 = bundle({}, { k: [3] });
    expect(foldKey([], ['k'])).toBeUndefined();
    expect(foldKey([touch('set', b0, 0), touch('append', b1, 1), touch('merge', b2, 2)], ['k'])).toEqual([1, 2, 3]);
    expect(foldKey([touch('set', b0, 0), touch('delete', bundle({ k: undefined }), 1)], ['k'])).toBeUndefined();
    // a merge onto a deleted key builds from absent
    expect(foldKey([touch('delete', bundle({ k: undefined }), 0), touch('merge', b2, 1)], ['k'])).toEqual([3]);
  });

  it('anchored starts at the last row that decides the value alone — the same answer, fewer rows', () => {
    const touches = [
      touch('set', bundle({ k: [0] }), 0),
      touch('append', bundle({ k: [1] }), 1),
      touch('set', bundle({ k: ['z'] }), 2),
      touch('append', bundle({ k: ['y'] }), 3),
    ];
    const seen = (anchored: boolean) => {
      const rowsSeen: number[] = [];
      const value = foldKey(touches, ['k'], { anchored, observe: (t) => rowsSeen.push(t.commitIdx) });
      return { value, rowsSeen };
    };
    expect(seen(false)).toEqual({ value: ['z', 'y'], rowsSeen: [0, 1, 2, 3] });
    expect(seen(true)).toEqual({ value: ['z', 'y'], rowsSeen: [2, 3] });
  });

  it('tells an observer the value before and after each applied row', () => {
    const steps: Array<[Verb, unknown, unknown]> = [];
    foldKey([touch('set', bundle({ k: [1] }), 0), touch('append', bundle({ k: [2] }), 1)], ['k'], {
      observe: (t, before, after) => steps.push([t.verb, before, after]),
    });
    expect(steps).toEqual([
      ['set', undefined, [1]],
      ['append', [1], [1, 2]],
    ]);
  });

  it('detaches a bundle’s merge delta once: two merges of one bundle see one copy; two bundles, one each', () => {
    const delta = { k: [{ n: 1 }, { n: 2 }] };
    const same = bundle({ k: [] }, delta);
    const one = foldKey([touch('set', same, 0), touch('merge', same, 0), touch('merge', same, 0)], ['k']);
    expect(one).toEqual([{ n: 1 }, { n: 2 }]);
    const other = bundle({}, delta);
    const two = foldKey([touch('set', same, 0), touch('merge', same, 0), touch('merge', other, 1)], ['k']);
    expect(two).toHaveLength(4);
  });
});

describe('UnknownVerbError', () => {
  it('names the row, and quotes what it was handed', () => {
    const error = new UnknownVerbError('up\nsert', { path: ['a', 'b'].join(DELIM), row: 3, commit: 5 });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('UnknownVerbError');
    expect(error.message).toBe(
      'unknown verb "up\\nsert" on trace row 3 (path "a › b", commit 5): a commit row is one of set | merge | append | delete — the log is refused, not replayed as a merge',
    );
    expect([error.verb, error.path, error.row, error.commit]).toEqual(['up\nsert', 'a' + DELIM + 'b', 3, 5]);
  });

  it('a reader that does not know the commit leaves it out', () => {
    const error = new UnknownVerbError('x', { path: 'k', row: 0 });
    expect(error.message).toContain('on trace row 0 (path "k"):');
    expect(error.commit).toBeUndefined();
  });

  it('a bare verb carries only the verb; a non-string verb is described by its type', () => {
    const bare = new UnknownVerbError(undefined);
    expect(bare.message.startsWith('unknown verb undefined: a commit row is one of')).toBe(true);
    expect([bare.path, bare.row, bare.commit]).toEqual([undefined, undefined, undefined]);
    expect(new UnknownVerbError(5).message.startsWith('unknown verb of type number:')).toBe(true);
    expect(new UnknownVerbError({}).message.startsWith('unknown verb of type object:')).toBe(true);
  });
});
