/**
 * paths.ts — the path codec: how a path of segments is written into a
 * `TraceEntry.path` and read back. A leaf (L0, imports nothing): the commit
 * log's address format, one owner. Re-exported from `utils.ts`, so no importer
 * moved.
 */

/**
 * The separator that joins path SEGMENTS into a `TraceEntry.path`.
 *
 * WHY NOT `'.'` — the ambiguity this exists to prevent: a state key may itself
 * CONTAIN a dot, and this library creates such keys routinely. `$setValue`
 * takes a KEY, not a path, so `$setValue('a.b', v)` makes one top-level key
 * literally named `a.b`. With a dot separator that key's path and the nested
 * path `['a', 'b']` would both encode as `"a.b"`, and every reader of the
 * commit log — `applySmartMerge`, `commitValueAt`, `scrubPatch`,
 * `findLastWriter`, the slice layer — would have to guess which one a bundle
 * meant. Splitting the wrong way writes into (or reads from) the wrong place.
 *
 * ASCII Unit-Separator is the choice because it cannot appear in a JS
 * identifier and is vanishingly unlikely in a hand-written key, so the
 * encoding stays unambiguous. It is NOT a display character: a path rendered
 * straight to a UI or a log looks like one broken word. Split it with
 * {@link pathSegments} — that, not this constant, is the contract consumers
 * should hold.
 */
export const DELIM = '\u001F';

/**
 * Normalises an array path into a stable string key using DELIM.
 */
export function normalisePath(path: (string | number)[]): string {
  return path.map(String).join(DELIM);
}

/**
 * The inverse of {@link normalisePath}: the SEGMENTS of a `TraceEntry.path`.
 *
 * A path in the commit log is DELIM-joined (see {@link DELIM}), which is not a
 * display encoding — printing one verbatim shows a single broken-looking word,
 * as a consumer rendering a path discovered. This is the supported way to take
 * it apart; the delimiter itself stays an implementation detail, so a path can
 * be read, rendered or re-joined without anyone hard-coding a control
 * character.
 *
 * A single-segment path (the common case — a top-level state key) returns a
 * one-element array, so callers need no special case.
 *
 * ```ts
 * import { pathSegments } from 'footprintjs/trace';
 *
 * for (const entry of bundle.trace) {
 *   console.log(pathSegments(entry.path).join(' › ')); // 'order › lines'
 * }
 * ```
 */
export function pathSegments(path: string): string[] {
  return path.split(DELIM);
}
