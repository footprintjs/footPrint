/**
 * Unit tests for summarizeValue — shared narrative value formatter.
 *
 * Covers: primitives, strings (truncation boundary), arrays, objects
 * (4-key preview boundary, overflow), edge cases.
 */
import { describe, expect, it } from 'vitest';

import { summarizeValue } from '../../../../src/lib/scope/recorders/summarizeValue';

describe('summarizeValue', () => {
  // -- Primitives --

  it('undefined', () => {
    expect(summarizeValue(undefined, 80)).toBe('undefined');
  });

  it('null', () => {
    expect(summarizeValue(null, 80)).toBe('null');
  });

  it('number', () => {
    expect(summarizeValue(42, 80)).toBe('42');
    expect(summarizeValue(3.14, 80)).toBe('3.14');
    expect(summarizeValue(0, 80)).toBe('0');
    expect(summarizeValue(-1, 80)).toBe('-1');
  });

  it('boolean', () => {
    expect(summarizeValue(true, 80)).toBe('true');
    expect(summarizeValue(false, 80)).toBe('false');
  });

  // -- Strings --

  it('short string (under maxLen)', () => {
    expect(summarizeValue('hello', 80)).toBe('"hello"');
  });

  it('string exactly at maxLen boundary', () => {
    const s = 'a'.repeat(80);
    expect(summarizeValue(s, 80)).toBe(`"${s}"`);
  });

  it('string exceeding maxLen is truncated', () => {
    const s = 'a'.repeat(81);
    const result = summarizeValue(s, 80);
    expect(result.startsWith('"')).toBe(true);
    expect(result.endsWith('..."')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(80 + 2); // quotes
  });

  it('empty string', () => {
    expect(summarizeValue('', 80)).toBe('""');
  });

  it('string with small maxLen', () => {
    expect(summarizeValue('hello world', 5)).toBe('"he..."');
  });

  // -- Arrays --

  it('empty array', () => {
    expect(summarizeValue([], 80)).toBe('[]');
  });

  it('single element array', () => {
    expect(summarizeValue([1], 80)).toBe('(1 item)');
  });

  it('multi element array', () => {
    expect(summarizeValue([1, 2, 3], 80)).toBe('(3 items)');
  });

  it('large array', () => {
    expect(summarizeValue(new Array(1000), 80)).toBe('(1000 items)');
  });

  // -- Objects --

  it('empty object', () => {
    expect(summarizeValue({}, 80)).toBe('{}');
  });

  it('object with 1 key', () => {
    expect(summarizeValue({ name: 'Alice' }, 80)).toBe('{name}');
  });

  it('object with 4 keys (boundary — all shown)', () => {
    expect(summarizeValue({ a: 1, b: 2, c: 3, d: 4 }, 80)).toBe('{a, b, c, d}');
  });

  it('object with 5 keys (truncated — shows count)', () => {
    const result = summarizeValue({ a: 1, b: 2, c: 3, d: 4, e: 5 }, 80);
    expect(result).toBe('{a, b, c, d, ... (5 keys)}');
  });

  it('object with many keys', () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 20; i++) obj[`key${i}`] = i;
    const result = summarizeValue(obj, 80);
    expect(result).toContain('20 keys');
  });

  it('object preview exceeding maxLen falls back to key count', () => {
    const obj = {
      veryLongKeyName1: 1,
      veryLongKeyName2: 2,
      veryLongKeyName3: 3,
      veryLongKeyName4: 4,
      veryLongKeyName5: 5,
    };
    const result = summarizeValue(obj, 20);
    expect(result).toBe('{5 keys}');
  });

  // -- Fallback --

  it('symbol falls back to String()', () => {
    expect(summarizeValue(Symbol('test'), 80)).toBe('Symbol(test)');
  });

  it('function falls back to String()', () => {
    const result = summarizeValue(() => {}, 80);
    expect(result).toContain('=>');
  });
});
