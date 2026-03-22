/**
 * Tests for reactive/arrayTraps -- createArrayProxy.
 *
 * Covers: unit (all 9 mutating methods), boundary, scenario, property,
 * performance, security (copy-on-write).
 */
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { createArrayProxy } from '../../../../src/lib/reactive/arrayTraps';

function makeProxy(initial: unknown[] = []) {
  let current = [...initial];
  const commits: unknown[][] = [];
  const commit = (newArr: unknown[]) => {
    current = newArr;
    commits.push([...newArr]);
  };
  const proxy = createArrayProxy(() => current, commit);
  return { proxy, commits, getCurrent: () => current, original: initial };
}

// -- Unit: mutating methods --------------------------------------------------

describe('arrayTraps -- unit: push', () => {
  it('appends item and commits', () => {
    const { proxy, commits, getCurrent } = makeProxy([1, 2]);
    const len = proxy.push(3);
    expect(len).toBe(3);
    expect(getCurrent()).toEqual([1, 2, 3]);
    expect(commits).toHaveLength(1);
  });

  it('push multiple items', () => {
    const { proxy, getCurrent } = makeProxy([]);
    proxy.push('a', 'b', 'c');
    expect(getCurrent()).toEqual(['a', 'b', 'c']);
  });
});

describe('arrayTraps -- unit: pop', () => {
  it('removes last item and commits', () => {
    const { proxy, commits, getCurrent } = makeProxy([1, 2, 3]);
    const popped = proxy.pop();
    expect(popped).toBe(3);
    expect(getCurrent()).toEqual([1, 2]);
    expect(commits).toHaveLength(1);
  });

  it('pop on empty array returns undefined', () => {
    const { proxy } = makeProxy([]);
    expect(proxy.pop()).toBeUndefined();
  });
});

describe('arrayTraps -- unit: shift', () => {
  it('removes first item and commits', () => {
    const { proxy, getCurrent } = makeProxy([1, 2, 3]);
    const shifted = proxy.shift();
    expect(shifted).toBe(1);
    expect(getCurrent()).toEqual([2, 3]);
  });
});

describe('arrayTraps -- unit: unshift', () => {
  it('prepends items and commits', () => {
    const { proxy, getCurrent } = makeProxy([3]);
    const len = proxy.unshift(1, 2);
    expect(len).toBe(3);
    expect(getCurrent()).toEqual([1, 2, 3]);
  });
});

describe('arrayTraps -- unit: splice', () => {
  it('removes items', () => {
    const { proxy, getCurrent } = makeProxy([1, 2, 3, 4]);
    const removed = proxy.splice(1, 2);
    expect(removed).toEqual([2, 3]);
    expect(getCurrent()).toEqual([1, 4]);
  });

  it('removes and inserts items', () => {
    const { proxy, getCurrent } = makeProxy([1, 2, 3]);
    proxy.splice(1, 1, 'a', 'b');
    expect(getCurrent()).toEqual([1, 'a', 'b', 3]);
  });
});

describe('arrayTraps -- unit: sort', () => {
  it('sorts and commits', () => {
    const { proxy, getCurrent } = makeProxy([3, 1, 2]);
    proxy.sort();
    expect(getCurrent()).toEqual([1, 2, 3]);
  });

  it('sort with comparator', () => {
    const { proxy, getCurrent } = makeProxy([3, 1, 2]);
    proxy.sort((a: any, b: any) => b - a);
    expect(getCurrent()).toEqual([3, 2, 1]);
  });
});

describe('arrayTraps -- unit: reverse', () => {
  it('reverses and commits', () => {
    const { proxy, getCurrent } = makeProxy([1, 2, 3]);
    proxy.reverse();
    expect(getCurrent()).toEqual([3, 2, 1]);
  });
});

describe('arrayTraps -- unit: fill', () => {
  it('fills and commits', () => {
    const { proxy, getCurrent } = makeProxy([1, 2, 3]);
    proxy.fill(0 as any);
    expect(getCurrent()).toEqual([0, 0, 0]);
  });

  it('fill with range', () => {
    const { proxy, getCurrent } = makeProxy([1, 2, 3, 4]);
    proxy.fill(0 as any, 1, 3);
    expect(getCurrent()).toEqual([1, 0, 0, 4]);
  });
});

describe('arrayTraps -- unit: copyWithin', () => {
  it('copies within and commits', () => {
    const { proxy, getCurrent } = makeProxy([1, 2, 3, 4, 5]);
    proxy.copyWithin(0, 3);
    expect(getCurrent()).toEqual([4, 5, 3, 4, 5]);
  });
});

// -- Unit: non-mutating (pass-through) ---------------------------------------

describe('arrayTraps -- unit: non-mutating methods pass through', () => {
  it('map returns plain array, no commit', () => {
    const { proxy, commits } = makeProxy([1, 2, 3]);
    const result = proxy.map((x: any) => x * 2);
    expect(result).toEqual([2, 4, 6]);
    expect(commits).toHaveLength(0);
  });

  it('filter returns plain array, no commit', () => {
    const { proxy, commits } = makeProxy([1, 2, 3, 4]);
    const result = proxy.filter((x: any) => x > 2);
    expect(result).toEqual([3, 4]);
    expect(commits).toHaveLength(0);
  });

  it('forEach does not commit', () => {
    const { proxy, commits } = makeProxy([1, 2, 3]);
    const seen: number[] = [];
    proxy.forEach((x: any) => seen.push(x));
    expect(seen).toEqual([1, 2, 3]);
    expect(commits).toHaveLength(0);
  });

  it('find returns correct element', () => {
    const { proxy } = makeProxy([{ id: 1 }, { id: 2 }]);
    const found = proxy.find((x: any) => x.id === 2);
    expect(found).toEqual({ id: 2 });
  });

  it('includes works', () => {
    const { proxy } = makeProxy([1, 2, 3]);
    expect(proxy.includes(2)).toBe(true);
    expect(proxy.includes(4)).toBe(false);
  });

  it('indexOf works', () => {
    const { proxy } = makeProxy(['a', 'b', 'c']);
    expect(proxy.indexOf('b')).toBe(1);
    expect(proxy.indexOf('z')).toBe(-1);
  });

  it('slice returns plain array, no commit', () => {
    const { proxy, commits } = makeProxy([1, 2, 3, 4]);
    expect(proxy.slice(1, 3)).toEqual([2, 3]);
    expect(commits).toHaveLength(0);
  });

  it('length access, no commit', () => {
    const { proxy, commits } = makeProxy([1, 2, 3]);
    expect(proxy.length).toBe(3);
    expect(commits).toHaveLength(0);
  });

  it('index access, no commit', () => {
    const { proxy, commits } = makeProxy(['a', 'b', 'c']);
    expect(proxy[0]).toBe('a');
    expect(proxy[2]).toBe('c');
    expect(commits).toHaveLength(0);
  });
});

// -- Unit: index assignment --------------------------------------------------

describe('arrayTraps -- unit: index assignment', () => {
  it('scope.items[2] = "updated" commits', () => {
    const { proxy, commits, getCurrent } = makeProxy([1, 2, 3]);
    proxy[2] = 99 as any;
    expect(getCurrent()).toEqual([1, 2, 99]);
    expect(commits).toHaveLength(1);
  });
});

// -- Unit: Array.isArray -----------------------------------------------------

describe('arrayTraps -- unit: Array.isArray', () => {
  it('Array.isArray returns true for proxied array', () => {
    const { proxy } = makeProxy([1, 2, 3]);
    expect(Array.isArray(proxy)).toBe(true);
  });
});

// -- Unit: iteration ---------------------------------------------------------

describe('arrayTraps -- unit: iteration', () => {
  it('for...of works', () => {
    const { proxy } = makeProxy([10, 20, 30]);
    const result: number[] = [];
    for (const item of proxy) {
      result.push(item as number);
    }
    expect(result).toEqual([10, 20, 30]);
  });

  it('spread works', () => {
    const { proxy } = makeProxy([1, 2, 3]);
    expect([...proxy]).toEqual([1, 2, 3]);
  });
});

// -- Boundary: edge cases ----------------------------------------------------

describe('arrayTraps -- boundary', () => {
  it('empty array -- push then pop', () => {
    const { proxy, getCurrent } = makeProxy([]);
    proxy.push('a');
    expect(getCurrent()).toEqual(['a']);
    proxy.pop();
    expect(getCurrent()).toEqual([]);
  });

  it('single element array operations', () => {
    const { proxy, getCurrent } = makeProxy(['only']);
    expect(proxy.shift()).toBe('only');
    expect(getCurrent()).toEqual([]);
  });

  it('clear array via length = 0', () => {
    const { proxy, getCurrent } = makeProxy([1, 2, 3, 4, 5]);
    proxy.length = 0;
    expect(getCurrent()).toEqual([]);
  });
});

// -- Scenario: multi-mutation sequence ---------------------------------------

describe('arrayTraps -- scenario: mutation sequences', () => {
  it('push, push, pop, splice sequence', () => {
    const { proxy, commits, getCurrent } = makeProxy(['a']);
    proxy.push('b'); // ['a', 'b']
    proxy.push('c'); // ['a', 'b', 'c']
    proxy.pop(); // ['a', 'b']
    proxy.splice(0, 1); // ['b']
    expect(getCurrent()).toEqual(['b']);
    expect(commits).toHaveLength(4); // one commit per mutation
  });

  it('sort then reverse', () => {
    const { proxy, getCurrent } = makeProxy([3, 1, 2]);
    proxy.sort();
    proxy.reverse();
    expect(getCurrent()).toEqual([3, 2, 1]);
  });
});

// -- Property: fast-check invariants -----------------------------------------

describe('arrayTraps -- property: push/pop length invariant', () => {
  it('push increases length by 1, pop decreases by 1', () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { minLength: 0, maxLength: 20 }), (initial) => {
        const { proxy, getCurrent } = makeProxy([...initial]);
        const lenBefore = getCurrent().length;

        proxy.push(42);
        expect(getCurrent().length).toBe(lenBefore + 1);

        proxy.pop();
        expect(getCurrent().length).toBe(lenBefore);
      }),
      { numRuns: 50 },
    );
  });
});

// -- Performance: benchmark --------------------------------------------------

describe('arrayTraps -- performance', () => {
  it('1K pushes complete in under 50ms', () => {
    const { proxy } = makeProxy([]);
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      proxy.push(i);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});

// -- Security: copy-on-write -------------------------------------------------

describe('arrayTraps -- security: copy-on-write', () => {
  it('original array is NEVER mutated by push', () => {
    const original = [1, 2, 3];
    const { proxy } = makeProxy(original);
    proxy.push(4);
    expect(original).toEqual([1, 2, 3]); // untouched
  });

  it('original array is NEVER mutated by sort', () => {
    const original = [3, 1, 2];
    const { proxy } = makeProxy(original);
    proxy.sort();
    expect(original).toEqual([3, 1, 2]); // untouched
  });

  it('original array is NEVER mutated by splice', () => {
    const original = [1, 2, 3];
    const { proxy } = makeProxy(original);
    proxy.splice(1, 1);
    expect(original).toEqual([1, 2, 3]); // untouched
  });

  it('original array is NEVER mutated by index assignment', () => {
    const original = [1, 2, 3];
    const { proxy } = makeProxy(original);
    proxy[0] = 99 as any;
    expect(original).toEqual([1, 2, 3]); // untouched
  });
});
