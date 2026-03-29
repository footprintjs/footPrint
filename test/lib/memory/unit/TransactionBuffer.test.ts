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
