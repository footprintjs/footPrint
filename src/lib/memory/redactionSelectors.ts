/** Selector operations used by the serving rule and its disclosure evidence. */
/**
 * Maximum key length (characters) that will be tested against regex redaction
 * patterns. A dotted PATH past it, under a path-dependent pattern, is not
 * skipped but masked (`RedactionRule` · `maskPastPathCap`).
 * Keys longer than this are skipped for pattern matching to prevent
 * ReDoS: a pathological regex tested against an unboundedly long key string
 * can cause catastrophic backtracking. 256 characters comfortably exceeds any
 * realistic scope-state key name.
 */
export const MAX_PATTERN_KEY_LEN = 256;

/** Policy patterns are predicates, not cursors over successive keys/events. */
export function matchesPattern(value: string, patterns: readonly RegExp[] | undefined): boolean {
  if (!patterns) return false;
  for (const pattern of patterns) {
    // Only these flags consume lastIndex. Ordinary (including frozen)
    // regexes need no writable cursor to match. Keep all original flags.
    if (pattern.global || pattern.sticky) pattern.lastIndex = 0;
    if (pattern.test(value)) return true;
  }
  return false;
}

/**
 * Can `pattern` match a dotted PATH where it matches none of the path's
 * segment NAMES? Only through a construct that can match or test the `.`
 * between segments: `.` itself, an escape that can stand for it (`\W \S \D
 * \B \p \P \u \x \c`, a digit escape), a negated class, a class range that
 * spans `.`, a lookaround or a named group. Anything else matches a path only
 * inside one segment — and an ancestor whose NAME matches is masked whole
 * before the walk goes below it, so the name decides. Conservative: `true`
 * whenever in doubt.
 *
 * Linear in the length of `pattern.source`: every scan here is one forward
 * pass ({@link classBodies}) or a regex that does constant work per position.
 */
export function needsPath(pattern: RegExp): boolean {
  const source = pattern.source;
  if (/\.|\\[WSDBpPuxc0-9]|\[\^|\(\?[=!<]/.test(source)) return true;
  for (const body of classBodies(source)) {
    for (const [, low, high] of body.matchAll(/(\\?[\s\S])-(\\?[\s\S])/g)) {
      if (low.length > 1 || high.length > 1 || (low <= '.' && high >= '.')) return true;
    }
  }
  return false;
}

/**
 * The body of each character class in `source`, left to right: the text
 * between a `[` and the first `]` after it that no `\` escapes (a `\` takes
 * the character after it along). ONE forward pass.
 *
 * It replaces `source.matchAll(/\[((?:\\[\s\S]|[^\]\\])*)\]/g)` and gives the
 * same bodies for every string (pinned against that regex as the control,
 * test/lib/memory/security/needs-path-linear.security.test.ts). The regex was
 * quadratic: after a `[` that never closed it retried at every later `[`,
 * each retry rescanning to the end — `\[` repeated 32,000 times took 0.7 s,
 * and `setPolicy` runs once per stage's scope (CodeQL js/polynomial-redos).
 * The pass stops at the first `[` that never closes instead: a later `[`
 * starts its body where the failed scan was also between two tokens, so it
 * reads the same tail the same way and closes nowhere either.
 *
 * @internal Exported for that test only — not on any public door.
 */
export function classBodies(source: string): string[] {
  const bodies: string[] = [];
  let open = source.indexOf('[');
  while (open !== -1) {
    const close = closingBracket(source, open + 1);
    if (close === -1) break;
    bodies.push(source.slice(open + 1, close));
    open = source.indexOf('[', close + 1);
  }
  return bodies;
}

/** The index of the first `]` at or after `from` that no `\` escapes, else -1 (a trailing lone `\` escapes nothing and closes nothing). */
function closingBracket(source: string, from: number): number {
  let at = from;
  while (at < source.length) {
    const char = source[at];
    if (char === ']') return at;
    at += char === '\\' ? 2 : 1;
  }
  return -1;
}
