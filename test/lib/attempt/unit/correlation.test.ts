/**
 * Correlation — UNIT tests for the W3C `traceparent` codec and the run's correlation (design §3.4, packet P4).
 *
 * WHY: a `traceparent` arrives from an untrusted caller. The codec reads exactly the W3C Trace Context shape
 * (`00-<32 hex>-<16 hex>-<2 hex>`, lowercase) and refuses anything else BY NAME — a bad version, length or
 * character, or an all-zero id — without ever repeating the header back. The run's correlation is resolved once
 * from the env: explicit `traceId` / `operationId` win over the header's.
 *
 * Test types: Unit (valid, every refusal by name, mixed with explicit ids, format round trip) · Boundary (the
 * exact length, `ff`, a future version with and without a tail, empty and non-string input).
 */
import { describe, expect, it } from 'vitest';

import { formatTraceparent, parseTraceparent, TraceparentError } from '../../../../src/index.js';
import { resolveCorrelation } from '../../../../src/lib/attempt/correlation.js';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';
const HEADER = `00-${TRACE}-${PARENT}-01`;

/** The refusal's reason, or `'accepted'`. */
function reasonOf(header: unknown): string {
  try {
    parseTraceparent(header);
    return 'accepted';
  } catch (error) {
    expect(error).toBeInstanceOf(TraceparentError);
    return (error as TraceparentError).reason;
  }
}

describe('parseTraceparent — a valid header', () => {
  it('reads the trace id, the parent id as operationId, and the sampled flag', () => {
    expect(parseTraceparent(HEADER)).toEqual({ traceId: TRACE, operationId: PARENT, sampled: true });
    expect(parseTraceparent(`00-${TRACE}-${PARENT}-00`).sampled).toBe(false);
    // Only bit 0 is "sampled"; other flag bits are read but not carried.
    expect(parseTraceparent(`00-${TRACE}-${PARENT}-02`).sampled).toBe(false);
    expect(parseTraceparent(`00-${TRACE}-${PARENT}-03`).sampled).toBe(true);
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(parseTraceparent(HEADER))).toBe(true);
  });

  it('reads a future version by its first four fields, and ignores a tail only after a dash', () => {
    expect(parseTraceparent(`01-${TRACE}-${PARENT}-01`)).toEqual({
      traceId: TRACE,
      operationId: PARENT,
      sampled: true,
    });
    expect(parseTraceparent(`cc-${TRACE}-${PARENT}-01-what-the-future-holds`).traceId).toBe(TRACE);
    expect(reasonOf(`cc-${TRACE}-${PARENT}-01x`)).toBe('characters');
  });
});

describe('parseTraceparent — every refusal, by name', () => {
  it.each([
    ['not a string', 42, 'not-a-string'],
    ['undefined', undefined, 'not-a-string'],
    ['empty', '', 'length'],
    ['one short', HEADER.slice(0, -1), 'length'],
    ['version 00 with a tail', `${HEADER}-extra`, 'length'],
    ['absurdly long', `01-${TRACE}-${PARENT}-01-${'a'.repeat(1000)}`, 'length'],
    ['version ff', `ff-${TRACE}-${PARENT}-01`, 'version'],
    ['version not hex', `0g-${TRACE}-${PARENT}-01`, 'version'],
    ['uppercase version', `0A-${TRACE}-${PARENT}-01`, 'version'],
    ['uppercase trace id', `00-${TRACE.toUpperCase()}-${PARENT}-01`, 'characters'],
    ['a space', `00-${TRACE.slice(0, -1)} -${PARENT}-01`, 'characters'],
    ['missing dash', `00_${TRACE}-${PARENT}-01`, 'characters'],
    ['bad flags', `00-${TRACE}-${PARENT}-0z`, 'characters'],
    ['leading whitespace', ` ${HEADER.slice(1)}`, 'version'],
    ['all-zero trace id', `00-${'0'.repeat(32)}-${PARENT}-01`, 'zero-trace-id'],
    ['all-zero parent id', `00-${TRACE}-${'0'.repeat(16)}-01`, 'zero-parent-id'],
  ])('%s → %s', (_label, header, reason) => {
    expect(reasonOf(header)).toBe(reason);
  });

  it('never repeats the header in its message', () => {
    const hostile = `00-${'a'.repeat(31)}<script>-${PARENT}-01`.slice(0, 55);
    try {
      parseTraceparent(hostile);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('<script');
      expect((error as Error).message).not.toContain('aaaa');
      expect((error as Error).name).toBe('TraceparentError');
      expect(Object.keys(error as object)).not.toContain('header');
    }
  });
});

describe('formatTraceparent', () => {
  it('writes version 00 and round-trips a parsed header', () => {
    expect(formatTraceparent(parseTraceparent(HEADER))).toBe(HEADER);
    expect(formatTraceparent({ traceId: TRACE, operationId: PARENT })).toBe(`00-${TRACE}-${PARENT}-00`);
    expect(formatTraceparent({ traceId: TRACE, operationId: PARENT, sampled: true })).toBe(HEADER);
  });

  it('writes the canonical form of a future version (the tail never survives)', () => {
    expect(formatTraceparent(parseTraceparent(`cc-${TRACE}-${PARENT}-01-tail`))).toBe(HEADER);
  });

  it('refuses ids that are not W3C ids, by name', () => {
    expect(() => formatTraceparent({ traceId: 'req-123', operationId: PARENT })).toThrow(TraceparentError);
    expect(() => formatTraceparent({ traceId: TRACE, operationId: 'op' })).toThrow(TraceparentError);
    expect(() => formatTraceparent({ traceId: '0'.repeat(32), operationId: PARENT })).toThrow(/zero-trace-id/);
    expect(() => formatTraceparent({ traceId: TRACE, operationId: '0'.repeat(16) })).toThrow(/zero-parent-id/);
  });
});

describe('resolveCorrelation — the run correlation from the env', () => {
  it('is absent with no env, an empty env, or an env with no correlation field', () => {
    expect(resolveCorrelation(undefined)).toBeUndefined();
    expect(resolveCorrelation({})).toBeUndefined();
    expect(resolveCorrelation({ timeoutMs: 5 })).toBeUndefined();
    expect(resolveCorrelation({ traceId: '' })).toBeUndefined();
  });

  it('from a header: the trace id, the operation, sampled, and the canonical header', () => {
    expect(resolveCorrelation({ traceparent: HEADER })).toEqual({
      traceId: TRACE,
      operationId: PARENT,
      sampled: true,
      traceparent: HEADER,
    });
  });

  it('from explicit ids: only what was given', () => {
    expect(resolveCorrelation({ traceId: 'req-123' })).toEqual({ traceId: 'req-123' });
    expect(resolveCorrelation({ traceId: 'req-123', operationId: 'checkout' })).toEqual({
      traceId: 'req-123',
      operationId: 'checkout',
    });
  });

  it('mixed: explicit ids win over the header’s; the header stays as received (canonical)', () => {
    expect(resolveCorrelation({ traceparent: HEADER, traceId: 'req-123' })).toEqual({
      traceId: 'req-123',
      operationId: PARENT,
      sampled: true,
      traceparent: HEADER,
    });
    expect(resolveCorrelation({ traceparent: HEADER, operationId: 'checkout' })).toEqual({
      traceId: TRACE,
      operationId: 'checkout',
      sampled: true,
      traceparent: HEADER,
    });
  });

  it('is one frozen object, keys in a fixed order', () => {
    const c = resolveCorrelation({ operationId: 'op', traceparent: HEADER, traceId: 't' })!;
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.keys(c)).toEqual(['traceId', 'operationId', 'sampled', 'traceparent']);
  });

  it('refuses a bad header (the run does not start on it)', () => {
    expect(() => resolveCorrelation({ traceparent: 'nonsense' })).toThrow(TraceparentError);
    // Explicit ids do not rescue a bad header: a refusal is never silently ignored.
    expect(() => resolveCorrelation({ traceparent: 'nonsense', traceId: 't' })).toThrow(TraceparentError);
  });

  it('refuses a non-string id, and an operation with no trace, by name', () => {
    expect(() => resolveCorrelation({ traceId: 42 as unknown as string })).toThrow(/env\.traceId/);
    expect(() => resolveCorrelation({ operationId: 42 as unknown as string, traceId: 't' })).toThrow(
      /env\.operationId/,
    );
    expect(() => resolveCorrelation({ operationId: 'op' })).toThrow(/env\.operationId/);
  });
});
