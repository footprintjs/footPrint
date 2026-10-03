/**
 * keyPaths.ts — which rows of a commit log touch a state key. ONE answer (F3, 9.33.0).
 *
 * WHY THIS FILE EXISTS. A key query (`commitValueAt`, `findLastWriter`, `causalChain`, the slice
 * layer) asks "which rows wrote `key`?". Each reader used to answer with its own `row.path === key`,
 * so a row written INSIDE the key — `cfg␟b`, which every subflow seed of an object, every
 * outputMapper merge-back and every fork child's namespace produces — was invisible to all of
 * them, while the fold (`stateAt`, the live commit) applied it. The fold said `{a:1,b:2}`; the key
 * queries said "never written". Every reader now asks here.
 *
 * THE PATH HALF (this file, L0 — it imports only the path codec and types):
 *   - {@link relation} — how a row's path sits against a key's path. A segment prefix on the
 *     DELIM-joined path, the way RFC 6901 prefixes a JSON Pointer: `cfg` is a prefix of `cfg␟a`,
 *     never of `cfgX`. A row is `'exact'` (on the key), `'inside'` (below it — it wrote part of the
 *     key's value) or `'around'` (above it — it wrote a container that holds the key).
 *   - {@link buildWriterIndex} / {@link writerCandidates} — one pass over a log, then the rows that
 *     can have written a key, found through its top-level key instead of a scan.
 *
 * THE RULES (defined here; the fold is L1 and the log readers L3, so `commitLogUtils.ts` applies
 * them — `writersOf`, `findLastWriter`, `commitValueAt`):
 *   - THE WRITER RULE — commit `c` WRITES key `K` iff `c` has a row `'exact'` or `'inside'` `K`,
 *     or a row `'around'` `K` across which the value at `K` differs (compared over the whole commit,
 *     not row by row: a value that changes and changes back inside one commit was not written).
 *     A top-level key has no `'around'` rows, so for it the rule is the path check alone.
 *     Why not every `'around'` row: `$update('cfg', { list: [3] })` is a `merge` row on `cfg`, but
 *     it never reaches `cfg␟a` — counting it named the wrong writer of `cfg␟a`.
 *   - THE VALUE RULE — the value of `K` at commit `i` is the fold of EVERY row under `K`'s top-level
 *     key up to `i`, anchored at that key's last `set`/`delete`, read at `K`: the fold `stateAt`
 *     does, restricted to one top-level key. Top-level keys never interact under the step, so the
 *     restriction is exact. Folding only the rows that touch `K` is NOT: an array union
 *     (`deepSmartMerge`) dedups the whole array, so a sibling element written beside `a␟1` changes
 *     where a later merge on `a` leaves `a[1]`.
 *
 * @example
 * ```typescript
 * relation('cfg\u001Fb', 'cfg'); // 'inside' — the row wrote part of cfg
 * relation('cfg', 'cfg\u001Fa'); // 'around' — the row wrote the container cfg.a lives in
 * relation('cfgX', 'cfg');       // undefined — a different key, not a prefix match
 * ```
 */

import { DELIM } from './paths.js';
import type { CommitBundle } from './types.js';

/** How a row's path sits against a key's path. `undefined` from {@link relation} means disjoint. */
export type PathRelation = 'exact' | 'inside' | 'around';

const DELIM_CODE = DELIM.charCodeAt(0);

/**
 * How the row path `rowPath` sits against the key `key` — both DELIM-joined `TraceEntry.path`
 * strings (a top-level key is a one-segment path). `'exact'` when they are equal, `'inside'` when
 * the row is below the key, `'around'` when the row is above it, `undefined` when neither is a
 * segment prefix of the other.
 */
export function relation(rowPath: string, key: string): PathRelation | undefined {
  if (rowPath === key) return 'exact';
  if (rowPath.length > key.length) {
    return rowPath.charCodeAt(key.length) === DELIM_CODE && rowPath.startsWith(key) ? 'inside' : undefined;
  }
  return key.charCodeAt(rowPath.length) === DELIM_CODE && key.startsWith(rowPath) ? 'around' : undefined;
}

/** The top-level key a DELIM-joined path belongs to — its first segment. */
export function rootOf(path: string): string {
  const cut = path.indexOf(DELIM);
  return cut === -1 ? path : path.slice(0, cut);
}

/** The positions in a log where each written path was written — see {@link buildWriterIndex}. */
export interface WriterIndex {
  /** Every distinct written path → the ascending ARRAY positions of the commits with a row on it, one per commit. */
  readonly byPath: ReadonlyMap<string, readonly number[]>;
  /** Every top-level key → the distinct written paths under it (itself included), in first-write order. */
  readonly byRoot: ReadonlyMap<string, readonly string[]>;
}

/**
 * One pass over `commitLog`: where every path was written. Build it ONCE when a reader asks about
 * many keys (a causal walk, a forward slice); a single question needs no index.
 */
export function buildWriterIndex(commitLog: readonly CommitBundle[]): WriterIndex {
  const byPath = new Map<string, number[]>();
  const byRoot = new Map<string, string[]>();
  for (let i = 0; i < commitLog.length; i++) {
    const trace = commitLog[i].trace;
    for (let row = 0; row < trace.length; row++) {
      const path = trace[row].path;
      const positions = byPath.get(path);
      if (positions !== undefined) {
        // Several rows on one path in one commit are one write of it.
        if (positions[positions.length - 1] !== i) positions.push(i);
        continue;
      }
      byPath.set(path, [i]);
      const root = rootOf(path);
      const paths = byRoot.get(root);
      if (paths !== undefined) paths.push(path);
      else byRoot.set(root, [path]);
    }
  }
  return { byPath, byRoot };
}

/** The commits that can have written a key, split by what the writer rule still has to ask. */
export interface WriterCandidates {
  /** Commits with a row `'exact'` or `'inside'` the key — writers by the path alone. Ascending. */
  readonly atOrInside: readonly number[];
  /** Commits with a row `'around'` the key and none at or inside it — writers only if the value at the key changed. Ascending. */
  readonly aroundOnly: readonly number[];
}

/** The path half of the writer rule over an index: every commit that can have written `key`. */
export function writerCandidates(index: WriterIndex, key: string): WriterCandidates {
  const paths = index.byRoot.get(rootOf(key));
  if (paths === undefined) return { atOrInside: [], aroundOnly: [] };
  const atOrInside: (readonly number[])[] = [];
  const around: (readonly number[])[] = [];
  for (const path of paths) {
    const r = relation(path, key);
    if (r === undefined) continue;
    (r === 'around' ? around : atOrInside).push(index.byPath.get(path) as readonly number[]);
  }
  const written = ascendingUnion(atOrInside);
  if (around.length === 0) return { atOrInside: written, aroundOnly: [] };
  const already = new Set(written);
  return { atOrInside: written, aroundOnly: ascendingUnion(around).filter((i) => !already.has(i)) };
}

/** The ascending, de-duplicated union of ascending position lists. */
export function ascendingUnion(lists: readonly (readonly number[])[]): number[] {
  if (lists.length === 0) return [];
  if (lists.length === 1) return [...lists[0]];
  const all = new Set<number>();
  for (const list of lists) for (const i of list) all.add(i);
  return [...all].sort((a, b) => a - b);
}
