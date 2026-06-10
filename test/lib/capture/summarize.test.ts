/**
 * Unit: capture/summarize — the shared, brand-parameterized marker builders
 * (#13c-A extraction of #14's StageContext-local summarizeReadValue).
 *
 * The read-marker shapes here are the SHIPPED public contract — pinned
 * end-to-end by test/lib/memory/scenario/read-tracking.test.ts (untouched by
 * the extraction). This file pins the module surface itself plus the
 * read/write brand parity: one classification path, two brands.
 */
import { describe, expect, it } from 'vitest';

import {
  READ_PREVIEW_LENGTH,
  summarizeReadValue,
  summarizeWriteValue,
  SUMMARY_PREVIEW_LENGTH,
} from '../../../src/lib/capture';

describe('capture/summarize', () => {
  it('read markers keep the shipped shape per value kind (byte-identical extraction)', () => {
    expect(summarizeReadValue(null)).toEqual({ __readSummary: true, type: 'null' });
    expect(summarizeReadValue('hello')).toEqual({ __readSummary: true, type: 'string', size: 5, preview: 'hello' });
    expect(summarizeReadValue([1, 2, 3])).toEqual({ __readSummary: true, type: 'array', size: 3 });
    expect(summarizeReadValue({ a: 1, b: 2 })).toEqual({ __readSummary: true, type: 'object', size: 2 });
    expect(summarizeReadValue(42)).toEqual({ __readSummary: true, type: 'number', preview: '42' });
    expect(summarizeReadValue(true)).toEqual({ __readSummary: true, type: 'boolean', preview: 'true' });
    expect(summarizeReadValue(() => 1)).toEqual({ __readSummary: true, type: 'function' });
  });

  it('Map/Set report their real entry count, not Object.keys (always 0)', () => {
    const lookup = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    expect(summarizeReadValue(lookup)).toEqual({ __readSummary: true, type: 'object', size: 2 });
    expect(summarizeWriteValue(new Set(['x', 'y', 'z']))).toEqual({ __writeSummary: true, type: 'object', size: 3 });
  });

  it('write markers are the read siblings: same fields, distinct brand, one classifier', () => {
    const samples: unknown[] = [null, 'hello', [1, 2, 3], { a: 1 }, 42, true, 'x'.repeat(500)];
    for (const value of samples) {
      const { __readSummary, ...readFields } = summarizeReadValue(value);
      const { __writeSummary, ...writeFields } = summarizeWriteValue(value);
      expect(__readSummary).toBe(true);
      expect(__writeSummary).toBe(true);
      expect(writeFields).toEqual(readFields);
      // Distinct brands — a write marker never carries the read discriminant.
      expect((summarizeWriteValue(value) as Record<string, unknown>).__readSummary).toBeUndefined();
      expect((summarizeReadValue(value) as Record<string, unknown>).__writeSummary).toBeUndefined();
    }
  });

  it('previews are capped at the shared length for both brands', () => {
    const long = 'x'.repeat(500);
    expect(summarizeReadValue(long).preview).toHaveLength(SUMMARY_PREVIEW_LENGTH);
    expect(summarizeWriteValue(long).preview).toHaveLength(SUMMARY_PREVIEW_LENGTH);
    expect(summarizeWriteValue(long).size).toBe(500);
  });

  it('READ_PREVIEW_LENGTH stays exported as the shipped compat alias (80)', () => {
    expect(READ_PREVIEW_LENGTH).toBe(80);
    expect(READ_PREVIEW_LENGTH).toBe(SUMMARY_PREVIEW_LENGTH);
  });

  it('summary cost contract: building a marker never structuredClones the value', () => {
    const realClone = globalThis.structuredClone;
    const cloned: unknown[] = [];
    globalThis.structuredClone = ((v: unknown, o?: StructuredSerializeOptions) => {
      cloned.push(v);
      return realClone(v, o);
    }) as typeof structuredClone;
    try {
      summarizeReadValue({ big: 'payload' });
      summarizeWriteValue(['a', 'b']);
      expect(cloned).toHaveLength(0);
    } finally {
      globalThis.structuredClone = realClone;
    }
  });
});
