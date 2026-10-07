/**
 * `redaction.ts · needsPath` reads a redaction pattern's source in LINEAR time
 * (CodeQL js/polynomial-redos). Its character-class scan used to be the regex
 * `/\[((?:\\[\s\S]|[^\]\\])*)\]/g`: after a `[` that never closed it retried at
 * every later `[`, each retry rescanning to the end, so `\[` repeated n times
 * cost O(n²) — and `RedactionRule.setPolicy` runs it for every pattern, on
 * every stage's scope. `redaction.ts · classBodies` is one forward pass.
 *
 *   1. scaling — ten times the source costs about ten times the time, never
 *      about a hundred. A RATIO of two timings on the same machine, never
 *      absolute milliseconds, so machine load cancels out. FAILED before the
 *      fix (measured ~95x);
 *   2. differential — the same class bodies and the same answer as the
 *      implementation it replaced, kept below as the CONTROL, for every string
 *      over the characters the scan turns on (fast-check);
 *   3. examples — what a pattern's source decides, one line each.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { classBodies, needsPath, RedactionRule } from '../../../../src/lib/memory/redaction.js';

// ── The CONTROL: the implementation before the fix (quadratic — short strings only) ──

const CONTROL_CLASS = /\[((?:\\[\s\S]|[^\]\\])*)\]/g;

function controlBodies(source: string): string[] {
  return [...source.matchAll(CONTROL_CLASS)].map((match) => match[1]);
}

function controlNeedsPath(source: string): boolean {
  if (/\.|\\[WSDBpPuxc0-9]|\[\^|\(\?[=!<]/.test(source)) return true;
  for (const body of controlBodies(source)) {
    for (const [, low, high] of body.matchAll(/(\\?[\s\S])-(\\?[\s\S])/g)) {
      if (low.length > 1 || high.length > 1 || (low <= '.' && high >= '.')) return true;
    }
  }
  return false;
}

/** `needsPath` reads only `source`, so a bare object feeds it strings no `RegExp` would accept too. */
const decide = (source: string): boolean => needsPath({ source } as RegExp);

// ── 1. scaling ────────────────────────────────────────────────────────────────

/** Mean milliseconds per call of `needsPath` on `source`, over enough calls to fill `windowMs`. */
function msPerCall(source: string, windowMs = 30): number {
  let calls = 0;
  let elapsed = 0;
  const start = performance.now();
  do {
    decide(source);
    calls += 1;
    elapsed = performance.now() - start;
  } while (elapsed < windowMs);
  return elapsed / calls;
}

describe('1 — scaling: the source is read once', () => {
  it('ten times a source of unclosed `\\[` costs about ten times the time, never about a hundred', () => {
    const unclosed = (n: number) => '\\['.repeat(n);
    msPerCall(unclosed(1_000)); // JIT warm-up, so the baseline does not absorb compilation
    const base = msPerCall(unclosed(1_000));
    const tenfold = msPerCall(unclosed(10_000));
    // Linear lands near 10x; the old quadratic scan lands near 100x.
    expect(tenfold / base).toBeLessThan(25);
  });

  it('a policy whose generated pattern repeats `\\[` installs, and still decides by name', () => {
    const generated = new RegExp(`^(?:${'\\['.repeat(20_000)})$`);
    const rule = new RedactionRule({ patterns: [generated] });
    expect(rule.isKeyRedacted('password')).toBe(false);
    expect(needsPath(generated)).toBe(false);
  });
});

// ── 2. differential ───────────────────────────────────────────────────────────

/** The characters the scan turns on, plus a few on either side of `.` (a range can span it). */
const TURNING = ['[', ']', '\\', '-', '^', '(', '?', '=', '!', '+', '/', '.', 'a', 'z', 'W', '0', '~'];
const sources = fc.string({ unit: fc.constantFrom(...TURNING), maxLength: 40 });

describe('2 — differential: the same answer as the regex scan it replaced', () => {
  it('the same class bodies, for every string', () => {
    fc.assert(
      fc.property(sources, (source) => {
        expect(classBodies(source)).toEqual(controlBodies(source));
      }),
      { numRuns: 3000 },
    );
  });

  it('the same verdict, for every string', () => {
    fc.assert(
      fc.property(sources, (source) => {
        expect(decide(source)).toBe(controlNeedsPath(source));
      }),
      { numRuns: 3000 },
    );
  });

  it('the same verdict for real regex sources built from the same characters', () => {
    const valid = sources.filter((source) => {
      try {
        new RegExp(source);
        return true;
      } catch {
        return false;
      }
    });
    fc.assert(
      fc.property(valid, (source) => {
        const pattern = new RegExp(source);
        expect(needsPath(pattern)).toBe(controlNeedsPath(pattern.source));
      }),
      { numRuns: 1000 },
    );
  });
});

// ── 3. examples ───────────────────────────────────────────────────────────────

describe('3 — examples: what a source decides', () => {
  it.each([
    [/password/i, false, 'a name pattern — the key name decides'],
    [/^user\.ssn$/, true, 'a dotted path'],
    [/[a-z]+_token/, false, 'a class that cannot match `.`'],
    [/[+-/]/, true, 'a class range that spans `.`'],
    [/[^_]/, true, 'a negated class'],
    [/api\wKey/, false, '`\\w` cannot stand for `.`'],
    [/a\Wb/, true, '`\\W` can'],
    [/(?=secret)/, true, 'a lookaround'],
    [/\[a-z\]/, false, 'escaped brackets are literal text, not a class'],
    [/\[\[\[\[/, false, 'unclosed escaped brackets open no class'],
  ])('%s → %s (%s)', (pattern, expected) => {
    expect(needsPath(pattern)).toBe(expected);
    expect(controlNeedsPath(pattern.source)).toBe(expected);
  });

  it('class bodies: an escaped `]` does not close a class; a lone trailing `\\` closes nothing', () => {
    expect(classBodies('[a\\]b]c[d]')).toEqual(['a\\]b', 'd']);
    expect(classBodies('[ab\\')).toEqual([]);
    expect(classBodies('x[a]y[b')).toEqual(['a']);
  });
});
