/**
 * `redaction.ts · needsPath` reads a redaction pattern's source in LINEAR time
 * (CodeQL js/polynomial-redos). Its character-class scan used to be the regex
 * `/\[((?:\\[\s\S]|[^\]\\])*)\]/g`: after a `[` that never closed it retried at
 * every later `[`, each retry rescanning to the end, so `\[` repeated n times
 * cost O(n²) — and `RedactionRule.setPolicy` runs it for every pattern, on
 * every stage's scope. `redaction.ts · classBodies` is one forward pass.
 *
 *   1. scaling — ten times the source costs about ten times the time, never
 *      about a hundred. A RATIO of two timings on the same machine, each the
 *      fastest of many short batches, so a pause from preemption or GC drops
 *      out instead of landing in one side. FAILED before the fix (94-109x measured);
 *   2. differential — the same class bodies and the same verdict as the
 *      implementation it replaced, kept below as the CONTROL: exhaustively
 *      for every string of up to nine characters, and by fast-check for
 *      longer ones;
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

/**
 * Milliseconds per call of `needsPath` on `source`: the fastest of up to 100
 * batches of `calls` calls, within a `budgetMs` time budget (so the quadratic
 * scan, at ~75 ms a call, still fails in well under a second).
 */
function fastestPerCall(source: string, calls: number, budgetMs = 250): number {
  let best = Number.POSITIVE_INFINITY;
  const started = performance.now();
  for (let batch = 0; batch < 100 && performance.now() - started < budgetMs; batch++) {
    const start = performance.now();
    for (let i = 0; i < calls; i++) decide(source);
    best = Math.min(best, (performance.now() - start) / calls);
  }
  return best;
}

describe('1 — scaling: the source is read once', () => {
  it('ten times a source of unclosed `\\[` costs about ten times the time, never about a hundred', () => {
    const unclosed = (n: number) => '\\['.repeat(n);
    fastestPerCall(unclosed(1_000), 10); // JIT warm-up, so the baseline does not absorb compilation
    const base = fastestPerCall(unclosed(1_000), 10);
    const tenfold = fastestPerCall(unclosed(10_000), 1);
    // Linear lands near 10x; the old quadratic scan lands near 100x.
    expect(tenfold / base).toBeLessThan(25);
  });
});

// ── 2. differential ───────────────────────────────────────────────────────────

describe('2 — differential: the same answer as the regex scan it replaced', () => {
  it('the same class bodies for EVERY string of up to nine characters', () => {
    // Both scans treat every character other than `[`, `]` and `\` alike (the
    // regex's `[^\]\\]` and `[\s\S]` take any code unit), so four symbols
    // cover every string of each length — 349,525 strings, the empty one too.
    // The fourth symbol is a different letter at each position (`a` at 0, `b`
    // at 1, …), so equal bodies also mean bodies taken from the same places.
    const mismatches: string[] = [];
    let checked = 0;
    let level = [''];
    for (let length = 0; length <= 9; length++) {
      for (const source of level) {
        checked += 1;
        const got = classBodies(source);
        const want = controlBodies(source);
        if (got.length !== want.length || got.some((body, i) => body !== want[i])) mismatches.push(source);
      }
      const filler = String.fromCharCode(97 + length);
      level = level.flatMap((prefix) => ['[', ']', '\\', filler].map((char) => prefix + char));
    }
    expect(checked).toBe(349_525);
    expect(mismatches).toEqual([]);
  });

  /** The characters the verdict turns on, plus a few on either side of `.` (a range can span it). */
  const TURNING = ['[', ']', '\\', '-', '^', '(', '?', '=', '!', '+', '/', '.', 'a', 'z', 'W', '0', '~'];
  const longer = fc.string({ unit: fc.constantFrom(...TURNING), maxLength: 80, size: 'max' });

  it('the same class bodies and verdict for longer strings', () => {
    fc.assert(
      fc.property(longer, (source) => {
        expect(classBodies(source)).toEqual(controlBodies(source));
        expect(decide(source)).toBe(controlNeedsPath(source));
      }),
      { numRuns: 3000 },
    );
  });

  it('the same verdict for real regex sources built from the same characters', () => {
    const valid = longer.filter((source) => {
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
    [/\[a-z\]/, false, 'the `\\]` never closes what the `\\[` opened, so no body is read'],
    [/\[\[\[\[/, false, 'a `[` that never closes gives no body'],
    [/\[+-\/]/, true, 'an escaped `[` still opens a body a later `]` closes — conservative'],
  ])('%s → %s (%s)', (pattern, expected) => {
    expect(needsPath(pattern)).toBe(expected);
    expect(controlNeedsPath(pattern.source)).toBe(expected);
  });

  it('class bodies: an escaped `]` does not close a class; a lone trailing `\\` closes nothing', () => {
    expect(classBodies('[a\\]b]c[d]')).toEqual(['a\\]b', 'd']);
    expect(classBodies('[ab\\')).toEqual([]);
    expect(classBodies('x[a]y[b')).toEqual(['a']);
  });

  it('a policy whose generated pattern repeats `\\[` 20,000 times installs and decides by name', () => {
    const generated = new RegExp(`^(?:${'\\['.repeat(20_000)})$`);
    const rule = new RedactionRule({ patterns: [generated] });
    expect(rule.isKeyRedacted('password')).toBe(false);
    expect(needsPath(generated)).toBe(false);
  });
});
