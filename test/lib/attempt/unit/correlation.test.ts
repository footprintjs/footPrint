/**
 * Correlation — UNIT tests for the W3C `traceparent` codec and the run's correlation (design §3.4, packet P4).
 *
 * WHY: a `traceparent` arrives from an untrusted caller. The codec reads exactly the W3C Trace Context shape
 * (`00-<32 hex>-<16 hex>-<2 hex>`, lowercase) and refuses anything else BY NAME — a bad version, length or
 * character, or an all-zero id — without ever repeating the header back. The run's correlation is resolved once
 * from the env: explicit `traceId` / `operationId` win over the header's.
 *
 * Test types: Unit (valid, every refusal by name, mixed with explicit ids, format round trip, the admitted env) · Boundary (the
 * exact length, `ff`, a future version with and without a tail, empty and non-string input).
 */
import { describe, expect, it } from 'vitest';

import { formatTraceparent, parseTraceparent, TraceparentError } from '../../../../src/index.js';
import { admitRunEnv, resolveCorrelation } from '../../../../src/lib/attempt/correlation.js';

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
  it('reads the trace id, the parent id as operationId, the sampled flag and the flags byte', () => {
    expect(parseTraceparent(HEADER)).toEqual({ traceId: TRACE, operationId: PARENT, sampled: true, flags: '01' });
    expect(parseTraceparent(`00-${TRACE}-${PARENT}-00`).sampled).toBe(false);
    // "sampled" is bit 0; the whole byte is kept (W3C level 2's random bit is 0x02).
    expect(parseTraceparent(`00-${TRACE}-${PARENT}-02`)).toMatchObject({ sampled: false, flags: '02' });
    expect(parseTraceparent(`00-${TRACE}-${PARENT}-03`)).toMatchObject({ sampled: true, flags: '03' });
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(parseTraceparent(HEADER))).toBe(true);
  });

  it('reads a future version by its first four fields, and ignores a tail only after a dash', () => {
    expect(parseTraceparent(`01-${TRACE}-${PARENT}-01`)).toEqual({
      traceId: TRACE,
      operationId: PARENT,
      sampled: true,
      flags: '01',
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

  it('keeps every flag bit; sampled, when given, sets or clears bit 0 only', () => {
    expect(formatTraceparent(parseTraceparent(`00-${TRACE}-${PARENT}-03`))).toBe(`00-${TRACE}-${PARENT}-03`);
    expect(formatTraceparent({ traceId: TRACE, operationId: PARENT, flags: '03', sampled: false })).toBe(
      `00-${TRACE}-${PARENT}-02`,
    );
    expect(formatTraceparent({ traceId: TRACE, operationId: PARENT, flags: 'fe', sampled: true })).toBe(
      `00-${TRACE}-${PARENT}-ff`,
    );
    expect(() => formatTraceparent({ traceId: TRACE, operationId: PARENT, flags: 'G1' })).toThrow(/characters/);
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

  it('mixed: explicit ids win; the header’s sampled and traceparent ride only while the trace IS the header’s', () => {
    // Another trace: nothing of the header survives — not its parent-id filed under another trace, not its
    // flag, not a header to propagate the caller's trace while the record names another.
    expect(resolveCorrelation({ traceparent: HEADER, traceId: 'req-123' })).toEqual({ traceId: 'req-123' });
    expect(resolveCorrelation({ traceparent: HEADER, traceId: 'req-123', operationId: 'op' })).toEqual({
      traceId: 'req-123',
      operationId: 'op',
    });
    // The same trace, another operation that is no W3C parent-id: sampled stays, no header can be written.
    expect(resolveCorrelation({ traceparent: HEADER, operationId: 'checkout' })).toEqual({
      traceId: TRACE,
      operationId: 'checkout',
      sampled: true,
    });
    // The same trace, a W3C operation: the header is rebuilt from the EFFECTIVE ids.
    expect(resolveCorrelation({ traceparent: HEADER, operationId: 'b7ad6b7169203331' })).toEqual({
      traceId: TRACE,
      operationId: 'b7ad6b7169203331',
      sampled: true,
      traceparent: `00-${TRACE}-b7ad6b7169203331-01`,
    });
    // An explicit trace equal to the header's is the header's trace; the rebuilt header keeps its flags byte.
    expect(resolveCorrelation({ traceparent: HEADER, traceId: TRACE })?.traceparent).toBe(HEADER);
    expect(
      resolveCorrelation({ traceparent: `00-${TRACE}-${PARENT}-03`, operationId: 'b7ad6b7169203331' })?.traceparent,
    ).toBe(`00-${TRACE}-b7ad6b7169203331-03`);
  });

  it('is one frozen object, keys in a fixed order', () => {
    const c = resolveCorrelation({ traceparent: HEADER, operationId: PARENT, traceId: TRACE })!;
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.keys(c)).toEqual(['traceId', 'operationId', 'sampled', 'traceparent']);
  });

  it('refuses an explicit id that is not 1–256 printable ASCII characters, by field, without echoing it', () => {
    for (const bad of ['a\nb', 'has space', 'x'.repeat(257), 'naïve', '\u0000']) {
      let message = '';
      try {
        resolveCorrelation({ traceId: bad });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/env\.traceId refused/);
      expect(message.includes(bad)).toBe(false);
    }
    expect(() => resolveCorrelation({ traceId: 't', operationId: 'a\tb' })).toThrow(/env\.operationId refused/);
    expect(resolveCorrelation({ traceId: 'x'.repeat(256) })?.traceId).toHaveLength(256);
  });

  it('reads only OWN fields, each once', () => {
    const polluted = Object.create({ traceparent: HEADER, traceId: 'inherited' }) as Record<string, unknown>;
    expect(resolveCorrelation(polluted)).toBeUndefined();
    let reads = 0;
    const env = {
      get traceparent() {
        reads += 1;
        return reads === 1 ? HEADER : 'x';
      },
    };
    expect(resolveCorrelation(env)?.traceparent).toBe(HEADER);
    expect(reads).toBe(1);
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

describe('admitRunEnv — the env a leg runs with', () => {
  it('is undefined without an env, and one own-field snapshot with one', () => {
    expect(admitRunEnv(undefined)).toEqual({ env: undefined, correlation: undefined });
    const signal = new AbortController().signal;
    const given = { signal, timeoutMs: 5 };
    const { env, correlation } = admitRunEnv(given);
    expect(env).toEqual(given);
    expect(env).not.toBe(given);
    expect(env!.signal).toBe(signal);
    expect(correlation).toBeUndefined();
  });

  it('hands the stages the canonical header, never the received bytes', () => {
    const { env, correlation } = admitRunEnv({ traceparent: `cc-${TRACE}-${PARENT}-01-tail-bytes` });
    expect(env!.traceparent).toBe(HEADER);
    expect(correlation?.traceparent).toBe(HEADER);
  });

  it('the stages see exactly correlation.traceparent — no header naming another trace than the record', () => {
    expect(admitRunEnv({ traceparent: HEADER, operationId: 'b7ad6b7169203331' }).env!.traceparent).toBe(
      `00-${TRACE}-b7ad6b7169203331-01`,
    );
    const other = admitRunEnv({ traceparent: HEADER, traceId: 'req-1' }).env!;
    expect(Object.prototype.hasOwnProperty.call(other, 'traceparent')).toBe(false);
    // An explicitly undefined field stays as given (its key is the caller's).
    const given = admitRunEnv({ traceparent: undefined, timeoutMs: 1 }).env!;
    expect(Object.keys(given)).toEqual(['traceparent', 'timeoutMs']);
  });

  it('resolves from the same snapshot the stages see — a getter runs once', () => {
    let reads = 0;
    const given = {
      get traceparent() {
        reads += 1;
        return reads === 1 ? HEADER : `00-${'b'.repeat(32)}-${PARENT}-01`;
      },
    };
    const { env, correlation } = admitRunEnv(given);
    expect(reads).toBe(1);
    expect(env!.traceparent).toBe(HEADER);
    expect(correlation?.traceId).toBe(TRACE);
  });
});
