import { describe, expect, it } from 'vitest';

import { copyCaptureEvidence } from '../absentEntries.js';
import { copyHistoryData, HistoryDataError } from '../historyData.js';
import { copyEvidenceInput, MAX_CAPTURE_INPUT_BYTES } from './index.js';

describe('inert evidence input before privacy', () => {
  it('preserves own undefined object values without reporting omissions', () => {
    const omitted = [];
    const input = { missing: undefined, child: { missing: undefined, value: 1 } };
    const copied = copyHistoryData(input, 1000, {
      preserveObjectUndefined: true,
      onOmitted: (path) => omitted.push(path),
    });
    expect(Object.hasOwn(copied, 'missing')).toBe(true);
    expect(Object.hasOwn(copied.child, 'missing')).toBe(true);
    expect(copied.missing).toBeUndefined();
    expect(copied.child.missing).toBeUndefined();
    expect(Object.isFrozen(copied)).toBe(true);
    expect(Object.isFrozen(copied.child)).toBe(true);
    expect(omitted).toEqual([]);
  });

  it('keeps default JSON omission and original absent-event normalization', () => {
    const omitted = [];
    const input = { optional: undefined, child: { optional: undefined, value: 1 }, values: [null, 2] };
    expect(copyHistoryData(input, 1000)).toEqual(JSON.parse(JSON.stringify(input)));
    expect(copyHistoryData(input, 1000, { onOmitted: (path) => omitted.push(path) })).toEqual({
      child: { value: 1 },
      values: [null, 2],
    });
    expect(omitted).toEqual([['optional'], ['child', 'optional']]);
    const event = { executionTree: { stageReads: { count: undefined }, stageWrites: { total: undefined } } };
    expect(copyCaptureEvidence(copyEvidenceInput(event), 1000)).toEqual({
      executionTree: { stageReads: {}, stageWrites: {} },
      absent: [
        ['executionTree', 'stageReads', 'count'],
        ['executionTree', 'stageWrites', 'total'],
      ],
    });
    expect(copyHistoryData({ missing: undefined }, 2)).toEqual({});
  });

  it.each([
    ['root', () => undefined],
    ['array slot', () => [undefined]],
    ['nested array slot', () => ({ values: [undefined] })],
    ['array hole', () => Array(1)],
  ])('still refuses undefined at %s', (_name, input) => {
    expect(() => copyEvidenceInput(input())).toThrow(HistoryDataError);
    expect(() => copyHistoryData(input(), 1000)).toThrow(HistoryDataError);
  });

  it.each(['top', 'nested', 'array'])('refuses a %s accessor without executing it', (location) => {
    let calls = 0;
    const record = Object.defineProperty({}, 'payload', {
      enumerable: true,
      get() {
        calls++;
        return 'private';
      },
    });
    const input = location === 'top' ? record : location === 'nested' ? { child: record } : [record];
    expect(() => copyEvidenceInput(input)).toThrow(HistoryDataError);
    expect(calls).toBe(0);
  });

  it('does not invoke toJSON or coercion while refusing unsupported properties', () => {
    let calls = 0;
    const input = {
      missing: undefined,
      toJSON() {
        calls++;
        return {};
      },
      valueOf() {
        calls++;
        return 1;
      },
      toString() {
        calls++;
        return 'private';
      },
    };
    expect(() => copyEvidenceInput(input)).toThrow(HistoryDataError);
    expect(calls).toBe(0);
    const nonEnumerableHook = Object.defineProperty({ value: 1 }, 'toJSON', {
      value() {
        calls++;
        return {};
      },
    });
    expect(copyEvidenceInput(nonEnumerableHook)).toEqual({ value: 1 });
    expect(calls).toBe(0);
  });

  it('charges undefined as a conservative null slot, including Unicode keys', () => {
    expect(copyEvidenceInput({ missing: undefined }, 16)).toEqual({ missing: undefined });
    expect(() => copyEvidenceInput({ missing: undefined }, 15)).toThrow(HistoryDataError);
    const bytes = new TextEncoder().encode('{"🎈":null}').length;
    expect(copyEvidenceInput({ '🎈': undefined }, bytes)).toEqual({ '🎈': undefined });
    expect(() => copyEvidenceInput({ '🎈': undefined }, bytes - 1)).toThrow(HistoryDataError);
  });

  it('bounds raw preparation independently of any later privacy reduction', () => {
    expect(MAX_CAPTURE_INPUT_BYTES).toBe(1024 * 1024);
    expect(() => copyEvidenceInput({ selected: 'x'.repeat(MAX_CAPTURE_INPUT_BYTES) })).toThrow(HistoryDataError);
    expect(() => copyEvidenceInput({ selected: 'private' }, 4)).toThrow(HistoryDataError);
  });

  it('counts preserved slots toward node and depth admission', () => {
    const wide = Object.fromEntries(Array.from({ length: 100_000 }, (_, index) => [String(index), undefined]));
    expect(() => copyEvidenceInput(wide, 10_000_000)).toThrow(HistoryDataError);
    const values = { list: Array.from({ length: 50_000 }, () => ({ missing: undefined })) };
    expect(() => copyEvidenceInput(values, 2_000_000)).toThrow(HistoryDataError);
    expect(() => copyHistoryData(values, 2_000_000)).not.toThrow();
    let deep = { missing: undefined };
    for (let i = 0; i < 256; i++) deep = { next: deep };
    expect(() => copyEvidenceInput(deep, 10_000)).toThrow(HistoryDataError);
    // Ordinary omission does not introduce a new child node or change the historical depth rule.
    expect(() => copyHistoryData(deep, 10_000)).not.toThrow();
  });

  it('detaches aliases and safely preserves an own __proto__ property', () => {
    const shared = { missing: undefined, values: [1, { value: 2 }] };
    const input = Object.defineProperty({ left: shared, right: shared }, '__proto__', {
      enumerable: true,
      value: { missing: undefined },
    });
    const copied = copyEvidenceInput(input);
    shared.values[1].value = 3;
    expect(copied.left.values[1].value).toBe(2);
    expect(copied.right.values[1].value).toBe(2);
    expect(copied.left).not.toBe(shared);
    expect(copied.left).not.toBe(copied.right);
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
    expect(Object.hasOwn(copied, '__proto__')).toBe(true);
    expect(Object.hasOwn(copied.__proto__, 'missing')).toBe(true);
    expect(Object.isFrozen(copied.left.values)).toBe(true);
    expect(Object.isFrozen(copied.left.values[1])).toBe(true);
  });

  it.each([NaN, Infinity, -0, () => undefined, new Date(), new Map(), 1n])(
    'keeps strict scalar/object refusal for %s',
    (value) => {
      expect(() => copyEvidenceInput({ value })).toThrow(HistoryDataError);
    },
  );
});
