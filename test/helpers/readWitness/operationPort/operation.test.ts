import { describe, expect, it } from 'vitest';

import { createOperationPort } from './index.js';
describe('operation observation — inert delegation controls', () => {
  const make = () => {
    let clock = 0;
    return createOperationPort({
      tick: () => ++clock,
      objectId: () => 7,
      snapshot: (v) => (v === undefined ? { kind: 'undefined' } : { kind: 'string', value: JSON.stringify(v) }),
    });
  };
  const stamp = { coordinate: ['writeback', 0, 1], programPath: ['stages', 0, 'ops', 1], path: [] };
  it('calls the original body/edit once, preserving its return and object identity', () => {
    const port = make();
    const input: number[] = [];
    let bodies = 0;
    let edits = 0;
    const output = port.within(stamp, () => {
      bodies++;
      port.edit(input, 9, (v, n) => {
        edits++;
        expect(v).toBe(input);
        (v as number[]).push(n);
      });
      return input;
    });
    expect(output).toBe(input);
    expect(bodies).toBe(1);
    expect(edits).toBe(1);
    expect(port.current()).toBeUndefined();
    expect(port.receipt().spans[0].edits[0].object).toBe(7);
  });
  it('retains actual undefined no-object edit invocation and propagates escaping identity', () => {
    const port = make();
    const error = {};
    let calls = 0;
    let escaped: unknown;
    try {
      port.within(stamp, () => {
        port.edit(undefined, 9, () => {
          calls++;
        });
        throw error;
      });
    } catch (caught) {
      escaped = caught;
    }
    expect(escaped).toBe(error);
    expect(calls).toBe(1);
    expect(port.current()).toBeUndefined();
    expect(port.receipt().spans[0].outcome).toBe('threw');
    expect(port.receipt().spans[0].edits[0].object).toBeUndefined();
  });
});
