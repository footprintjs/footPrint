import { TransactionBuffer } from '../../../../src/lib/memory/TransactionBuffer';

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

  it('deep clones values on set to prevent external mutation', () => {
    const buf = new TransactionBuffer({});
    const obj = { nested: { val: 1 } };
    buf.set(['data'], obj);
    obj.nested.val = 999;
    const result = buf.commit();
    expect(result.overwrite.data.nested.val).toBe(1);
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
