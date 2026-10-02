import { TransactionBuffer } from '../../../../src/lib/memory/TransactionBuffer';
import { applySmartMerge } from '../../../../src/lib/memory/utils';

describe('TransactionBuffer', () => {
  it('stages set operations and reads them back', () => {
    const buf = new TransactionBuffer({});
    buf.set(['user', 'name'], 'Alice');
    expect(buf.get(['user', 'name'])).toBe('Alice');
  });

  it('stages merge operations', () => {
    const buf = new TransactionBuffer({ tags: ['a'] });
    buf.merge(['tags'], ['b']);
    expect(buf.get(['tags'])).toEqual(['a', 'b']);
  });

  it('merges objects deeply', () => {
    const buf = new TransactionBuffer({ config: { a: 1 } });
    buf.merge(['config'], { b: 2 });
    expect(buf.get(['config'])).toEqual({ a: 1, b: 2 });
  });

  it('commit returns patches and trace', () => {
    const buf = new TransactionBuffer({});
    buf.set(['x'], 1);
    buf.merge(['y'], { a: 1 });

    const result = buf.commit();
    expect(result.trace).toHaveLength(2);
    expect(result.trace[0].verb).toBe('set');
    expect(result.trace[1].verb).toBe('merge');
    expect(result.overwrite).toHaveProperty('x', 1);
    expect(result.updates).toHaveProperty('y');
  });

  it('resets after commit — reads return undefined', () => {
    const buf = new TransactionBuffer({ name: 'Alice' });
    buf.set(['name'], 'Bob');
    buf.commit();
    // After commit, working copy is empty so get returns undefined
    expect(buf.get(['name'])).toBeUndefined();
  });

  it('tracks redacted paths', () => {
    const buf = new TransactionBuffer({});
    buf.set(['secret'], 'password', true);
    const result = buf.commit();
    expect(result.redactedPaths.size).toBe(1);
  });

  it('supports default values in get', () => {
    const buf = new TransactionBuffer({});
    expect(buf.get(['missing'], 'fallback')).toBe('fallback');
  });

  it('preserves operation order in trace', () => {
    const buf = new TransactionBuffer({});
    buf.set(['a'], 1);
    buf.merge(['b'], { x: 1 });
    buf.set(['c'], 3);
    buf.merge(['a'], { extra: true });

    const result = buf.commit();
    const paths = result.trace.map((t) => t.path);
    expect(paths).toHaveLength(4);
    expect(result.trace[0]).toEqual({ path: 'a', verb: 'set' });
    expect(result.trace[3]).toEqual({ path: 'a', verb: 'merge' });
  });

  it('holds the reference until commit — a mutation BEFORE commit is what the stage read back (9.23.0)', () => {
    const buf = new TransactionBuffer({});
    const obj = { nested: { val: 1 } };
    buf.set(['data'], obj);
    obj.nested.val = 999;
    expect(buf.get(['data'])).toEqual({ nested: { val: 999 } }); // read-your-writes sees it…
    const result = buf.commit();
    expect(result.overwrite.data.nested.val).toBe(999); // …and so does the record: the two agree
  });

  it('the commit payload is detached — a mutation AFTER commit never reaches it (the law kept)', () => {
    const buf = new TransactionBuffer({});
    const obj = { nested: { val: 1 } };
    buf.set(['data'], obj);
    const result = buf.commit();
    expect(result.overwrite.data).not.toBe(obj);
    obj.nested.val = 999;
    expect(result.overwrite.data.nested.val).toBe(1);
  });

  it('a nested merge under a set path never leaks into the overwrite payload (the held reference is detached first)', () => {
    // `set o` stores the caller's object by reference in BOTH trees; the
    // nested `merge o.deep` writes its RESULT into workingCopy only. Without
    // the detach the shared container would carry `deep` into `overwrite.o`
    // — bytes 9.22.0 never had (pinned end to end by repeated-path-byte-identity).
    const buf = new TransactionBuffer({});
    const o = { p: 6 };
    buf.set(['o'], o);
    buf.merge(['o', 'deep'], { s: 7 });
    expect(buf.get(['o'])).toEqual({ p: 6, deep: { s: 7 } });
    const result = buf.commit();
    expect(result.overwrite.o).toEqual({ p: 6 });
    expect(result.updates.o).toEqual({ deep: { s: 7 } });
  });

  it('unions arrays on merge (no duplicates)', () => {
    const buf = new TransactionBuffer({ items: [1, 2, 3] });
    buf.merge(['items'], [3, 4, 5]);
    expect(buf.get(['items'])).toEqual([1, 2, 3, 4, 5]);
  });

  it('empty-array merge clears the array in working copy (fix: was a silent no-op)', () => {
    const buf = new TransactionBuffer({ tags: ['vip', 'premium'] });
    buf.merge(['tags'], []);
    // [] must clear, not no-op
    expect(buf.get(['tags'])).toEqual([]);
  });

  it('empty-array merge reflects in commit updatePatch', () => {
    const buf = new TransactionBuffer({ tags: ['vip'] });
    buf.merge(['tags'], []);
    const result = buf.commit();
    // The updatePatch must carry [] so applySmartMerge can clear the field
    expect((result.updates as any).tags).toEqual([]);
  });

  it('empty-array merge then non-empty merge: last write wins', () => {
    const buf = new TransactionBuffer({ tags: ['a'] });
    buf.merge(['tags'], []); // clear
    buf.merge(['tags'], ['b']); // then set new items
    expect(buf.get(['tags'])).toEqual(['b']);
  });
});

// ── Change-only commits (commit = net delta, not a write log) ──────────────
// See docs/design/commit-change-semantics.md for the rationale.
describe('TransactionBuffer — change-only commit semantics', () => {
  it('no-op write (same primitive) produces an EMPTY commit', () => {
    const buf = new TransactionBuffer({ count: 1 });
    buf.set(['count'], 1); // writes the value it already holds
    const result = buf.commit();
    expect(result.trace).toHaveLength(0);
    expect(result.overwrite).toEqual({});
    expect(result.updates).toEqual({});
  });

  it('no-op write (equal object, different reference) produces an EMPTY commit', () => {
    const buf = new TransactionBuffer({ user: { name: 'Alice', tags: ['vip'] } });
    // A fresh object with identical content — the slot-re-emit case.
    buf.set(['user'], { name: 'Alice', tags: ['vip'] });
    const result = buf.commit();
    expect(result.trace).toHaveLength(0);
    expect(result.overwrite).toEqual({});
  });

  it('no-op merge (content already present) produces an EMPTY commit', () => {
    const buf = new TransactionBuffer({ config: { a: 1, b: 2 } });
    buf.merge(['config'], { a: 1 }); // merging a value that is already there
    const result = buf.commit();
    expect(result.trace).toHaveLength(0);
    expect(result.updates).toEqual({});
  });

  it('write-then-revert within one stage produces an EMPTY commit', () => {
    const buf = new TransactionBuffer({ k: 1 });
    buf.set(['k'], 2); // change
    buf.set(['k'], 1); // revert to base — net zero
    const result = buf.commit();
    expect(result.trace).toHaveLength(0);
    expect(result.overwrite).toEqual({});
  });

  it('a real change is still recorded', () => {
    const buf = new TransactionBuffer({ k: 1 });
    buf.set(['k'], 2);
    const result = buf.commit();
    expect(result.trace).toEqual([{ path: 'k', verb: 'set' }]);
    expect(result.overwrite).toEqual({ k: 2 });
  });

  it('prunes only the no-op path, keeps the changed one (partial)', () => {
    const buf = new TransactionBuffer({ a: 1, b: 1 });
    buf.set(['a'], 1); // no-op
    buf.set(['b'], 2); // real change
    const result = buf.commit();
    expect(result.trace).toEqual([{ path: 'b', verb: 'set' }]);
    expect(result.overwrite).toEqual({ b: 2 });
    expect(result.overwrite).not.toHaveProperty('a');
  });

  it('nested no-op (deep-equal subtree) is pruned; sibling change survives', () => {
    const buf = new TransactionBuffer({ user: { name: 'Alice', age: 30 } });
    buf.set(['user', 'name'], 'Alice'); // no-op leaf
    buf.set(['user', 'age'], 31); // real change
    const result = buf.commit();
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0].verb).toBe('set');
    expect(result.overwrite).toEqual({ user: { age: 31 } });
  });

  it('array content change is recorded; identical array content is pruned', () => {
    const changed = new TransactionBuffer({ tags: ['a', 'b'] });
    changed.set(['tags'], ['a', 'b', 'c']);
    expect(changed.commit().overwrite).toEqual({ tags: ['a', 'b', 'c'] });

    const same = new TransactionBuffer({ tags: ['a', 'b'] });
    same.set(['tags'], ['a', 'b']); // identical content, new ref
    expect(same.commit().trace).toHaveLength(0);
  });

  it('writing a brand-new key (absent in base) is a change', () => {
    const buf = new TransactionBuffer({});
    buf.set(['fresh'], 5);
    const result = buf.commit();
    expect(result.overwrite).toEqual({ fresh: 5 });
  });

  it('redactedPaths drops a no-op path but keeps a changed redacted path', () => {
    const buf = new TransactionBuffer({ token: 'abc', secret: 'x' });
    buf.set(['token'], 'abc', true); // redacted no-op → dropped
    buf.set(['secret'], 'y', true); // redacted real change → kept
    const result = buf.commit();
    expect([...result.redactedPaths]).toEqual(['secret']);
  });

  it('an all-no-op stage yields a structurally-valid EMPTY bundle (the marker)', () => {
    const buf = new TransactionBuffer({ a: 1, b: 2 });
    buf.set(['a'], 1);
    buf.set(['b'], 2);
    const result = buf.commit();
    expect(result).toEqual({
      overwrite: {},
      updates: {},
      redactedPaths: new Set(),
      trace: [],
    });
  });
});

// ── The admitted record (9.30.0 — docs/design/2026-10-admitted-record.md) ──
// A commit folds back to what the stage read; a family that does not is
// committed as what the stage read. The property behind these cases is
// test/lib/memory/property/record-equals-read-back.property.test.ts.
describe('TransactionBuffer — the admitted record', () => {
  const D = '\u001f';
  const commitOf = (base: Record<string, unknown>, encoding: 'full' | 'delta', ops: (b: TransactionBuffer) => void) => {
    const buf = new TransactionBuffer(structuredClone(base), encoding);
    ops(buf);
    const readBack = structuredClone(buf.peek([]));
    const bundle = buf.commit();
    return { bundle, readBack, folded: applySmartMerge(base, bundle.updates, bundle.overwrite, bundle.trace) };
  };

  for (const encoding of ['full', 'delta'] as const) {
    it(`C5 — a nested delete through an ABSENT parent: the container it made is recorded (${encoding})`, () => {
      // L-1: `delete a.b` changes nothing at `a.b` (absent before and after),
      // so 9.29.0's net-change filter dropped it — and the stage read back an
      // `a` the record never mentioned.
      const { bundle, folded } = commitOf({}, encoding, (b) => b.delete(['a', 'b']));
      expect(bundle.trace).toEqual([{ path: `a${D}b`, verb: 'set' }]);
      expect(Object.keys(bundle.overwrite)).toEqual(['a']);
      expect(folded).toEqual({ a: {} });
    });

    it(`C5 — through a PRIMITIVE parent: the coercion the stage read back is recorded (${encoding})`, () => {
      const { bundle, folded } = commitOf({ a: 5 }, encoding, (b) => b.delete(['a', 'b']));
      expect(bundle.trace).toEqual([{ path: `a${D}b`, verb: 'set' }]);
      expect(folded).toEqual({ a: {} });
    });

    it(`an index past an array's end, deleted: the slot the stage read back is recorded (${encoding})`, () => {
      const { bundle, readBack, folded } = commitOf({ a: [] }, encoding, (b) => b.delete(['a', '0']));
      expect((readBack as { a: unknown[] }).a).toHaveLength(1);
      expect(bundle.trace).toEqual([{ path: `a${D}0`, verb: 'set' }]);
      expect((folded as { a: unknown[] }).a).toHaveLength(1);
    });

    it(`the stage's ADDRESS is not a value it reads: a run-namespace shell records nothing (${encoding})`, () => {
      // A run-namespaced stage writes under runs/<id>. Deleting an absent key
      // there makes `runs` and `runs/r1` in the working copy — where the
      // stage writes, not a value any read of it returns.
      const buf = new TransactionBuffer({}, encoding, undefined, ['runs', 'r1']);
      buf.delete(['runs', 'r1', 'k']);
      expect(buf.commit().trace).toEqual([]);
      // Below the address the same shell IS read back (the stage's key `a`).
      const deep = new TransactionBuffer({}, encoding, undefined, ['runs', 'r1']);
      deep.delete(['runs', 'r1', 'a', 'b']);
      expect(deep.commit().trace).toEqual([{ path: `runs${D}r1${D}a${D}b`, verb: 'set' }]);
    });

    it(`C2 — a re-encoded family: descendants by last touch, the root last, each with its own read prefix (${encoding})`, () => {
      let reads: string[] = [];
      const buf = new TransactionBuffer({ k: { a: 0 } }, encoding, () => [...reads]);
      buf.merge(['k'], { x: 1 }); // read prefix []
      reads = ['r1'];
      buf.set(['k', 'y'], 2); // read prefix ['r1']
      reads = ['r1', 'r2'];
      buf.set(['k'], { b: 1 }); // a hard write between the merges…
      buf.merge(['k'], { z: 3 }); // …the old record replayed {x: 1} here too
      const { trace, overwrite, updates } = buf.commit();
      expect(trace).toEqual([{ path: 'k', verb: 'set', readKeys: ['r1', 'r2'] }]); // k.y did not survive the set
      expect(overwrite).toEqual({ k: { b: 1, z: 3 } });
      expect(updates).toEqual({});
    });
  }

  it('C2 — the re-encoded family takes the slot of its last touch; other families keep theirs, byte for byte', () => {
    const buf = new TransactionBuffer({ k: {}, other: 0 });
    buf.merge(['k'], { x: 1 });
    buf.set(['other'], 1); // another family, between the lying family's ops
    buf.set(['k'], { y: 2 });
    buf.merge(['k'], { z: 3 });
    buf.set(['last'], 1);
    const { trace, overwrite, updates } = buf.commit();
    expect(trace.map((t) => `${t.path}:${t.verb}`)).toEqual(['other:set', 'k:set', 'last:set']);
    expect(overwrite).toEqual({ other: 1, k: { y: 2, z: 3 }, last: 1 });
    expect(updates).toEqual({});
  });

  it('a delta-less merge row an ancestor merge replaces later in the same bundle folds back — admitted as 9.29.0 wrote it', () => {
    // `merge c.y` then a `merge c` that makes `c` an array: the second
    // replaces the container the first's delta sat in, so `c.y`'s row has no
    // delta — a transient wipe the same replay overwrites. The bundle folds
    // back, so it is admitted unchanged.
    const { bundle, readBack, folded } = commitOf({ c: { y: 's' } }, 'full', (b) => {
      b.merge(['c', 'y'], [null]);
      b.merge(['c'], [null]);
    });
    expect(bundle.trace).toEqual([
      { path: `c${D}y`, verb: 'merge' },
      { path: 'c', verb: 'merge' },
    ]);
    expect(bundle.updates).toEqual({ c: [null] });
    expect(folded).toEqual(readBack);
  });

  it('a value a record cannot hold whole (an Error’s own fields) is admitted as 9.29.0 wrote it — no row could hold more', () => {
    // agentfootprint's reliability gate: a nested write turns the check on,
    // and `scope.error = err` stages an Error with a custom field. Every
    // record holds the Error's `structuredClone`, which drops `status` — so
    // the fold can never equal the working copy, and re-encoding would only
    // re-spell the same clone. The check compares against the clone.
    const buf = new TransactionBuffer({ breaker: { a: 0 } });
    buf.merge(['breaker'], { a: 1 });
    buf.set(['error'], undefined);
    buf.set(['error'], Object.assign(new Error('rate limited'), { status: 429 }));
    const { trace, overwrite } = buf.commit();
    expect(trace.map((t) => `${t.path}:${t.verb}`)).toEqual(['breaker:merge', 'error:set', 'error:set']);
    expect((overwrite.error as Error).message).toBe('rate limited');
  });

  it('a bundle that folds back is admitted byte for byte — the key order the replay builds included', () => {
    // merge k {a,c}; set k {b}; merge k {c}; merge k {a}: the stage reads
    // {b, c, a}, the replay builds {b, a, c} — equal, so nothing is
    // re-encoded and the delta row keeps the replay's order, as 9.29.0 did.
    const buf = new TransactionBuffer({}, 'delta');
    buf.merge(['k'], { a: 1, c: 1 });
    buf.set(['k'], { b: 1 });
    buf.merge(['k'], { c: 1 });
    buf.merge(['k'], { a: 1 });
    const { trace, overwrite } = buf.commit();
    expect(trace).toEqual([{ path: 'k', verb: 'set' }]);
    expect(Object.keys(overwrite.k as object)).toEqual(['b', 'a', 'c']);
  });
});
