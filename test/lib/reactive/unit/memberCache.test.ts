/**
 * The per-member proxy cache (9.23.2) — `liveView.ts · cachedMember`.
 *
 * Found in the 9.22.0 perf review (finding 4): the nested proxy's get trap
 * built a FRESH array proxy — with its own empty element cache — on every
 * `.arr` access, so `for (i < N) s.k.arr[i]` never hit the element cache and
 * allocated an array proxy per access. The top-level scope already cached
 * its child proxies by key, validated by raw identity; the nested, terminal
 * and element proxies did not.
 *
 * The law under test: within a stage, a repeated read of an UNCHANGED member
 * hands back the SAME proxy (`s.k.arr === s.k.arr`, `s.k.arr[0] === s.k.arr[0]`,
 * `s.k.o === s.k.o`); a write through the proxy rebuilds the containers on
 * its path, so the next read serves a proxy over the NEW value — never a
 * stale one. The cache is keyed by NAME under its parent proxy and validated
 * by identity, never by the raw value alone: a diamond (one array under two
 * keys) must get two proxies, each bound to its own path.
 */

import { describe, expect, it, vi } from 'vitest';

import { flowChart } from '../../../../src/lib/builder';
import { createTypedScope } from '../../../../src/lib/reactive/createTypedScope';
import type { ReactiveTarget } from '../../../../src/lib/reactive/types';
import { FlowChartExecutor } from '../../../../src/lib/runner';

// -- A minimal ReactiveTarget: silent reads, immutable-by-copy writes -----------

function mockTarget(initialState: Record<string, unknown>): ReactiveTarget & { state: Record<string, unknown> } {
  const state = { ...initialState };
  const deepMerge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
      const cur = out[k];
      out[k] =
        v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)
          ? deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>)
          : v;
    }
    return out;
  };
  return {
    state,
    getStateKeys: () => Object.keys(state),
    hasKey: (key: string) => Object.prototype.hasOwnProperty.call(state, key),
    getValue: (key?: string) => (key === undefined ? { ...state } : state[key]),
    getValueSilent: (key?: string) => (key === undefined ? { ...state } : state[key]),
    setValue(key: string, value: unknown) {
      state[key] = value;
    },
    updateValue(key: string, value: unknown) {
      state[key] = deepMerge(state[key] as Record<string, unknown>, value as Record<string, unknown>);
    },
    deleteValue(key: string) {
      delete state[key];
    },
    getArgs: () => ({} as any),
    getEnv: () => ({} as any),
    attachScopeRecorder: vi.fn(),
    detachScopeRecorder: vi.fn(),
    getScopeRecorders: vi.fn(() => []),
    addDebugInfo: vi.fn(),
    addDebugMessage: vi.fn(),
    addErrorInfo: vi.fn(),
    addMetric: vi.fn(),
    addEval: vi.fn(),
  };
}

type S = Record<string, any>;

function scopeOver(initial: Record<string, unknown>) {
  const target = mockTarget(initial);
  return { target, s: createTypedScope<S>(target) };
}

/** How many DISTINCT proxies `read()` hands back over `n` repeated reads — 1 means one allocation. */
function distinct(read: () => unknown, n: number): number {
  const seen = new Set<unknown>();
  for (let i = 0; i < n; i++) seen.add(read());
  return seen.size;
}

// -- Identity within a stage -----------------------------------------------------

describe('member cache -- identity: a repeated read of an unchanged member is the same proxy', () => {
  it('s.k.arr === s.k.arr — N reads of a nested array build ONE array proxy', () => {
    const { s } = scopeOver({ k: { arr: [{ n: 0 }, { n: 1 }] } });
    expect(s.k.arr).toBe(s.k.arr);
    expect(distinct(() => s.k.arr, 1_000)).toBe(1);
  });

  it('s.k.arr[0] === s.k.arr[0] — the element cache is reached through the cached array proxy', () => {
    const { s } = scopeOver({ k: { arr: [{ n: 0 }, { n: 1 }, { n: 2 }] } });
    expect(s.k.arr[0]).toBe(s.k.arr[0]);
    // The naive re-read loop: every index, twice — the second pass allocates nothing.
    const first = [0, 1, 2].map((i) => s.k.arr[i]);
    const second = [0, 1, 2].map((i) => s.k.arr[i]);
    expect(second).toEqual(first);
    second.forEach((p, i) => expect(p).toBe(first[i]));
  });

  it('s.k.o === s.k.o — a nested object proxy is cached too', () => {
    const { s } = scopeOver({ k: { o: { x: 1 } } });
    expect(s.k.o).toBe(s.k.o);
    expect(distinct(() => s.k.o, 1_000)).toBe(1);
    expect(s.k.o.deeper).toBeUndefined();
  });

  it('s.arr[0].o === s.arr[0].o and s.arr[0].sub === s.arr[0].sub — an element proxy caches its members', () => {
    const { s } = scopeOver({ arr: [{ o: { x: 1 }, sub: [1, 2] }] });
    expect(s.arr[0].o).toBe(s.arr[0].o);
    expect(s.arr[0].sub).toBe(s.arr[0].sub);
    expect(distinct(() => s.arr[0].sub, 1_000)).toBe(1);
  });

  it('a held terminal proxy reads the same member twice and gets the same proxy (not the raw object)', () => {
    const cyc: any = { name: 'c', o: { p: 1 } };
    cyc.self = cyc;
    const { s } = scopeOver({ k: cyc });
    const t = s.k.self; // the cycle edge: a terminal proxy
    const a = t.o;
    const b = t.o;
    expect(a).toBe(b);
    expect(a).not.toBe(cyc.o); // a proxy, not the raw value
  });

  it('a Date member is handed back raw every time and never enters the cache', () => {
    const when = new Date(2020, 0, 1);
    const { s } = scopeOver({ k: { when } });
    expect(s.k.when).toBe(when);
    expect(s.k.when).toBe(when);
  });
});

// -- Invalidation by identity ----------------------------------------------------

describe('member cache -- invalidation: a write serves a proxy over the NEW value', () => {
  it('s.k.arr[0].n = 1 → s.k.arr[0].n reads 1 and s.k.arr is a proxy over the rebuilt array', () => {
    const { s, target } = scopeOver({ k: { arr: [{ n: 0 }] } });
    const before = s.k.arr;
    const rawBefore = (target.state.k as any).arr;
    s.k.arr[0].n = 1;
    const rawAfter = (target.state.k as any).arr;
    expect(rawAfter).not.toBe(rawBefore); // the write rebuilt the array (structuralWrite)
    expect(rawBefore[0].n).toBe(0); // and never touched the one it read
    const after = s.k.arr;
    expect(after).not.toBe(before);
    expect(after[0].n).toBe(1);
    expect(s.k.arr[0].n).toBe(1);
    expect(JSON.stringify(after)).toBe('[{"n":1}]');
  });

  it('a HELD nested proxy invalidates by identity too: k.arr after k.arr.push(…) is the new array', () => {
    const { s } = scopeOver({ k: { arr: [1] } });
    const k = s.k;
    const before = k.arr;
    k.arr.push(2);
    const after = k.arr;
    expect(after).not.toBe(before);
    expect([...after]).toEqual([1, 2]);
    expect(after).toBe(k.arr); // and the new one is cached in turn
  });

  it('s.k.o.x = 2 → s.k.o.x reads 2 and "x" in s.k.o', () => {
    const { s } = scopeOver({ k: { o: { x: 1 } } });
    const o = s.k.o;
    s.k.o.x = 2;
    expect(s.k.o.x).toBe(2);
    // eslint-disable-next-line no-restricted-syntax -- the `has` trap is what is under test
    expect('x' in s.k.o).toBe(true);
    expect(o.x).toBe(2); // the held handle reads live (9.22.0)
  });

  it('a stale hit is impossible: replacing the whole key drops every proxy below it', () => {
    const { s } = scopeOver({ k: { arr: [{ n: 0 }] } });
    const before = s.k.arr[0];
    s.k = { arr: [{ n: 9 }] };
    expect(s.k.arr[0]).not.toBe(before);
    expect(s.k.arr[0].n).toBe(9);
  });
});

// -- Keyed by name under the parent, never by raw identity alone ----------------

describe('member cache -- a diamond gets two proxies, each bound to its own path', () => {
  it('k.a and k.b sharing ONE raw array are different proxies, and a push through k.b lands at k.b only', () => {
    const shared = [1];
    const { s, target } = scopeOver({ k: { a: shared, b: shared } });
    expect(s.k.a).not.toBe(s.k.b);
    s.k.b.push(2);
    const k = target.state.k as any;
    expect(k.b).toEqual([1, 2]);
    expect(k.a).toEqual([1]);
    expect(shared).toEqual([1]); // nothing mutated the borrowed read
  });
});

// -- Through the executor: the cache changes nothing the log or the fold can see --

describe('member cache -- executor: identity holds inside a stage and the log is unchanged', () => {
  it('one array proxy per stage for the naive re-read loop; the commit log records exactly the writes', async () => {
    let arrProxies = 0;
    let elementIdentity = false;
    const chart = flowChart<S>(
      'seed',
      (s) => {
        s.k = { arr: Array.from({ length: 50 }, (_, id) => ({ id, n: 0 })) };
      },
      'seed',
    )
      .addFunction(
        'read',
        (s) => {
          arrProxies = distinct(() => s.k.arr, 50);
          const seventh = s.k.arr[7];
          elementIdentity = seventh === s.k.arr[7]; // the SAME proxy on a second read
          s.k.arr[3].n = 3; // one write → one row, over the rebuilt array
          s.k.arr[3].n = 4; // the second write sees the new array (no stale proxy)
        },
        'read',
      )
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(arrProxies).toBe(1);
    expect(elementIdentity).toBe(true);
    const snapshot = executor.getSnapshot();
    const bundle = snapshot.commitLog[1];
    expect(bundle.trace.map((t: any) => `${t.operation ?? t.op}:${t.key ?? t.path}`)).toHaveLength(2);
    expect((snapshot.sharedState as any).k.arr[3].n).toBe(4);
    expect((snapshot.sharedState as any).k.arr[7].n).toBe(0);
  });
});
