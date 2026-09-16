/**
 * stringifySnapshot — the same bytes as JSON.stringify, without its recursion limit.
 *
 * Test types: Byte-identity (a real run's snapshot; a fast-check property over
 * JSON values; the JSON.stringify edge cases: toJSON, undefined in objects and
 * arrays, non-finite numbers, nested empties) · Capability (a 20 000-deep
 * `next` chain, where JSON.stringify throws, encodes and parses back) ·
 * Contract (a cycle and a BigInt throw as JSON.stringify does).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor, stringifySnapshot } from '../../../src/index.js';

describe('stringifySnapshot', () => {
  it('is byte-identical to JSON.stringify on a real run’s snapshot', async () => {
    let b = flowChart<Record<string, unknown>>(
      'S0',
      async (s) => s.$setValue('k0', { a: [1, 'x', null], d: new Date(0) }),
      's0',
    );
    for (let i = 1; i < 40; i++) {
      const k = `k${i}`;
      b = b.addFunction(
        `S${i}`,
        async (s) => s.$setValue(k, { i, list: [i, i + 0.5], nested: { deep: { er: `v${i}` } } }),
        `s${i}`,
      );
    }
    const ex = new FlowChartExecutor(b.build());
    await ex.run();
    const snapshot = ex.getSnapshot();
    expect(stringifySnapshot(snapshot)).toBe(JSON.stringify(snapshot));
  });

  it('is byte-identical to JSON.stringify on arbitrary JSON values (property)', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(stringifySnapshot(value)).toBe(JSON.stringify(value));
      }),
      { numRuns: 300 },
    );
  });

  it('matches JSON.stringify on its edge cases: toJSON, absent values, non-finite numbers, empties', () => {
    const cases: unknown[] = [
      { a: undefined, b: () => 1, c: Symbol('s'), d: 1 },
      [undefined, () => 1, Symbol('s'), 2],
      { n: [NaN, Infinity, -Infinity, -0, 1e21, 1e-7] },
      { when: new Date(1_700_000_000_000), custom: { toJSON: () => ({ replaced: true }) } },
      { empty: {}, none: [], nested: { a: { b: { c: [] } } } },
      'a "quoted" \n string \u2028',
      null,
      [[], [[]], [{}, { x: [{}] }]],
    ];
    for (const value of cases) expect(stringifySnapshot(value)).toBe(JSON.stringify(value));
    expect(stringifySnapshot(undefined)).toBe(JSON.stringify(undefined));
  });

  it('encodes a 20 000-deep `next` chain that JSON.stringify cannot, and JSON.parse reads it back', () => {
    let chain: Record<string, unknown> = { id: 'last', next: null };
    for (let i = 19_999; i >= 0; i--) chain = { id: `s${i}`, next: chain };
    const record = { executionTree: chain, commitLog: [] };
    expect(() => JSON.stringify(record)).toThrow(RangeError);
    const text = stringifySnapshot(record);
    const back = JSON.parse(text) as { executionTree: { id: string; next: unknown } };
    expect(back.executionTree.id).toBe('s0');
    let depth = 0;
    let node: unknown = back.executionTree;
    while (node !== null && typeof node === 'object') {
      depth += 1;
      node = (node as { next: unknown }).next;
    }
    expect(depth).toBe(20_001);
  });

  it('throws as JSON.stringify does on a cycle and on a BigInt', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => stringifySnapshot(cyclic)).toThrow(TypeError);
    expect(() => stringifySnapshot({ big: 10n })).toThrow(TypeError);
  });
});
