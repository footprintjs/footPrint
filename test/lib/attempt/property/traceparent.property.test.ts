/**
 * The `traceparent` codec — PROPERTY tests over malformed headers (design §3.4, packet P4).
 *
 * The header comes from an untrusted caller, so the parser is checked against an independent oracle (a regex
 * transcription of the W3C grammar) over arbitrary strings, single-character mutations of valid headers, and
 * random lengths. Four laws:
 *
 *   1. Accepted ⇔ the oracle says the header is a W3C traceparent; every refusal is a `TraceparentError` with one
 *      of the named reasons.
 *   2. A refusal never carries the header: not in the message, not on any own property.
 *   3. Format ∘ parse is the canonical header (version 00, lowercase), and parse ∘ format is the identity.
 *   4. The run's correlation holds no byte of the header beyond its canonical form.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { formatTraceparent, parseTraceparent, TraceparentError } from '../../../../src/index.js';
import { resolveCorrelation } from '../../../../src/lib/attempt/correlation.js';

const REASONS = ['not-a-string', 'length', 'version', 'characters', 'zero-trace-id', 'zero-parent-id'];

/** The W3C grammar, transcribed independently of the implementation. */
function oracle(header: string): boolean {
  if (header.length > 256) return false;
  const m = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(.*)$/s.exec(header);
  if (!m) return false;
  const [, version, traceId, parentId, , tail] = m;
  if (version === 'ff') return false;
  if (version === '00' && tail !== '') return false;
  if (tail !== '' && !tail.startsWith('-')) return false;
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return false;
  return true;
}

const hex = (n: number) =>
  fc.array(fc.constantFrom(...'0123456789abcdef'), { minLength: n, maxLength: n }).map((a) => a.join(''));
const validHeader = fc
  .tuple(hex(32), hex(16), hex(2))
  .filter(([t, p]) => /[1-9a-f]/.test(t) && /[1-9a-f]/.test(p))
  .map(([t, p, f]) => `00-${t}-${p}-${f}`);

/** A valid header with one character replaced. */
const mutated = fc
  .tuple(validHeader, fc.nat(54), fc.string({ minLength: 1, maxLength: 1, unit: 'binary' }))
  .map(([h, i, c]) => h.slice(0, i) + c + h.slice(i + 1));
/** A valid header with a run of characters inserted or removed. */
const resized = fc
  .tuple(validHeader, fc.nat(55), fc.string({ maxLength: 8 }), fc.boolean())
  .map(([h, i, s, cut]) => (cut ? h.slice(0, i) + h.slice(i + 1) : h.slice(0, i) + s + h.slice(i)));

const anyHeader = fc.oneof(
  fc.string({ maxLength: 80 }),
  fc.string({ maxLength: 80, unit: 'binary' }),
  mutated,
  resized,
  validHeader,
);

function outcome(header: unknown): { accepted: true } | { accepted: false; error: TraceparentError } {
  try {
    parseTraceparent(header);
    return { accepted: true };
  } catch (error) {
    return { accepted: false, error: error as TraceparentError };
  }
}

describe('parseTraceparent — property', () => {
  it('accepts exactly what the W3C grammar accepts; every refusal is named', () => {
    fc.assert(
      fc.property(anyHeader, (header) => {
        const result = outcome(header);
        expect(result.accepted).toBe(oracle(header));
        if (!result.accepted) {
          expect(result.error).toBeInstanceOf(TraceparentError);
          expect(REASONS).toContain(result.error.reason);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('a refusal never carries the header back', () => {
    fc.assert(
      fc.property(
        anyHeader.filter((h) => h.length >= 12 && !oracle(h)),
        (header) => {
          const result = outcome(header);
          if (result.accepted) return;
          const { error } = result;
          expect(error.message.includes(header)).toBe(false);
          for (const value of Object.values(error)) expect(value).not.toBe(header);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('non-strings are refused as not-a-string', () => {
    fc.assert(
      fc.property(
        fc.anything().filter((v) => typeof v !== 'string'),
        (value) => {
          const result = outcome(value);
          expect(result.accepted).toBe(false);
          if (!result.accepted) expect(result.error.reason).toBe('not-a-string');
        },
      ),
    );
  });

  it('format ∘ parse is the canonical header; parse ∘ format is the identity', () => {
    fc.assert(
      fc.property(validHeader, (header) => {
        const parsed = parseTraceparent(header);
        const canonical = formatTraceparent(parsed);
        expect(parseTraceparent(canonical)).toEqual(parsed);
        // Only the sampled bit is carried, so the canonical flags are 00 or 01.
        expect(canonical.slice(0, 53)).toBe(header.slice(0, 53));
        expect(['00', '01']).toContain(canonical.slice(53));
      }),
    );
  });

  it('the run correlation holds no byte of a future-version tail', () => {
    fc.assert(
      fc.property(validHeader, fc.string({ minLength: 1, maxLength: 40 }), (header, tail) => {
        const future = `cc${header.slice(2)}-${tail}`;
        if (!oracle(future)) return;
        const correlation = resolveCorrelation({ traceparent: future })!;
        expect(correlation.traceparent).toBe(formatTraceparent(parseTraceparent(future)));
        expect(JSON.stringify(correlation).includes(`-${tail}`)).toBe(
          // A tail that happens to be a substring of the canonical header is not a leak.
          correlation.traceparent!.includes(`-${tail}`),
        );
      }),
    );
  });
});
