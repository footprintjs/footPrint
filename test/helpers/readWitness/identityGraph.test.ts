import { describe, expect, it } from 'vitest';

import { identityGraph } from './identityGraph.js';
describe('actual own-data nested identity graph — inert controls', () => {
  it('distinguishes equal copies, keeps real alias/cycle identity and exact property-name paths', () => {
    const shared = { n: 1 };
    const root: any = { a: shared, b: shared, c: { n: 1 }, list: [shared] };
    root.self = root;
    const map = new WeakMap<object, number>();
    let next = 0;
    const rows = identityGraph(root, (value) => {
      if (!map.has(value)) map.set(value, ++next);
      return map.get(value)!;
    });
    const id = (path: string[]) => rows.find((row) => JSON.stringify(row.path) === JSON.stringify(path))!.object;
    expect(id(['a'])).toBe(id(['b']));
    expect(id(['a'])).toBe(id(['list', '0']));
    expect(id(['a'])).not.toBe(id(['c']));
    expect(id([])).toBe(id(['self']));
  });
  it('never invokes a getter and refuses unsupported/bounded identity proof', () => {
    let gets = 0;
    const value = Object.defineProperty({}, 'hidden', {
      get: () => {
        gets++;
        return {};
      },
    });
    expect(() => identityGraph(value, () => 1)).toThrow();
    expect(gets).toBe(0);
    let root: object = {};
    for (let i = 0; i < 130; i++) root = { next: root };
    expect(() => identityGraph(root, () => 1)).toThrow();
  });
});
