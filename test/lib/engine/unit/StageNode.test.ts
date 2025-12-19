import { isStageNodeReturn } from '../../../../src/lib/engine/graph/StageNode';

describe('isStageNodeReturn', () => {
  it('returns false for null/undefined/primitives', () => {
    expect(isStageNodeReturn(null)).toBe(false);
    expect(isStageNodeReturn(undefined)).toBe(false);
    expect(isStageNodeReturn(42)).toBe(false);
    expect(isStageNodeReturn('hello')).toBe(false);
    expect(isStageNodeReturn(true)).toBe(false);
  });

  it('returns false for objects without name', () => {
    expect(isStageNodeReturn({ children: [{ name: 'a' }] })).toBe(false);
    expect(isStageNodeReturn({ next: { name: 'b' } })).toBe(false);
  });

  it('returns false for objects with name but no continuation', () => {
    expect(isStageNodeReturn({ name: 'stage1' })).toBe(false);
    expect(isStageNodeReturn({ name: 'stage1', id: '1' })).toBe(false);
  });

  it('returns false for empty children array', () => {
    expect(isStageNodeReturn({ name: 'stage1', children: [] })).toBe(false);
  });

  it('returns true for node with non-empty children', () => {
    expect(isStageNodeReturn({ name: 'stage1', children: [{ name: 'a' }] })).toBe(true);
  });

  it('returns true for node with next', () => {
    expect(isStageNodeReturn({ name: 'stage1', next: { name: 'b' } })).toBe(true);
  });

  it('returns true for node with nextNodeSelector function', () => {
    expect(isStageNodeReturn({ name: 'stage1', nextNodeSelector: () => ['a'] })).toBe(true);
  });

  it('returns false when property access throws (proxy safety)', () => {
    const proxy = new Proxy({}, {
      get() { throw new Error('proxy trap'); },
    });
    expect(isStageNodeReturn(proxy)).toBe(false);
  });

  it('excludes deciderFn from continuation detection', () => {
    // deciderFn is a boolean flag, not a continuation property
    expect(isStageNodeReturn({ name: 'stage1', deciderFn: true })).toBe(false);
  });
});
