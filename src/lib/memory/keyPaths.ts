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

/**
 * One written path in a {@link WriterIndex} — a node of the path TRIE built over a log. A node exists for
 * every written path and every prefix of one.
 */
export interface PathNode {
  /** The DELIM-joined path this node stands for. */
  readonly path: string;
  /** ARRAY positions of the commits with a row exactly on this path — ascending, one per commit. */
  readonly positions: number[];
  /** The subset of {@link positions} whose row here is a `set` or a `delete` (it decides the value alone). */
  readonly totals: number[];
  /** Positions of commits whose row with a non-`delete` verb sits on this path (the rest are deletes only). */
  readonly writes: number[];
  /** The next segment → its node. */
  readonly children: Map<string, PathNode>;
  /** Memo of {@link subtreePositions}. */
  subtree?: readonly number[];
}

/**
 * The positions in a log where each written path was written: a path trie per top-level key. Built in ONE
 * pass (`O(total path segments)`); a key's candidates then cost `O(depth + matches)` — its node, its
 * ancestors, its subtree — never a scan of every path under its top-level key.
 */
export interface WriterIndex {
  /** Every top-level key → the root of its trie. */
  readonly roots: ReadonlyMap<string, PathNode>;
}

function nodeOf(path: string): PathNode {
  return { path, positions: [], totals: [], writes: [], children: new Map() };
}

/** Append `i` to an ascending list unless it is already its last element. */
function pushOnce(list: number[], i: number): void {
  if (list[list.length - 1] !== i) list.push(i);
}

/**
 * One pass over `commitLog`: the path trie of every written path. Build it ONCE when a reader asks about
 * many keys (a causal walk, a forward slice) — or let `commitLogUtils · logModel` memoise it for a frozen log.
 */
export function buildWriterIndex(commitLog: readonly CommitBundle[]): WriterIndex {
  const roots = new Map<string, PathNode>();
  for (let i = 0; i < commitLog.length; i++) {
    const trace = commitLog[i].trace;
    for (let row = 0; row < trace.length; row++) {
      const { path, verb } = trace[row];
      const segs = path.split(DELIM);
      let node: PathNode | undefined = roots.get(segs[0]);
      if (node === undefined) {
        node = nodeOf(segs[0]);
        roots.set(segs[0], node);
      }
      for (let s = 1; s < segs.length; s++) {
        let child: PathNode | undefined = node.children.get(segs[s]);
        if (child === undefined) {
          child = nodeOf(node.path + DELIM + segs[s]);
          node.children.set(segs[s], child);
        }
        node = child;
      }
      pushOnce(node.positions, i);
      if (verb === 'set' || verb === 'delete') pushOnce(node.totals, i);
      if (verb !== 'delete') pushOnce(node.writes, i);
    }
  }
  return { roots };
}

/** Every path a row was written on, in trie order. */
export function pathsWritten(index: WriterIndex): string[] {
  const out: string[] = [];
  const stack = [...index.roots.values()];
  while (stack.length > 0) {
    const node = stack.pop() as PathNode;
    if (node.positions.length > 0) out.push(node.path);
    for (const child of node.children.values()) stack.push(child);
  }
  return out;
}

/** The node for `key`, or undefined when no row was written on it or below it. */
export function nodeAt(index: WriterIndex, key: string): PathNode | undefined {
  const segs = key.split(DELIM);
  let node = index.roots.get(segs[0]);
  for (let s = 1; node !== undefined && s < segs.length; s++) node = node.children.get(segs[s]);
  return node;
}

/** The nodes of `key`'s PROPER ancestors that exist in the index, top-level key first. */
export function ancestorNodes(index: WriterIndex, key: string): PathNode[] {
  const segs = key.split(DELIM);
  const out: PathNode[] = [];
  let node = index.roots.get(segs[0]);
  for (let s = 1; node !== undefined && s < segs.length; s++) {
    out.push(node);
    node = node.children.get(segs[s]);
  }
  return out;
}

/** Every commit with a row on `node`'s path or below it — ascending, memoised on the node. */
export function subtreePositions(node: PathNode): readonly number[] {
  if (node.subtree === undefined) {
    if (node.children.size === 0) node.subtree = node.positions;
    else {
      const lists: (readonly number[])[] = [node.positions];
      for (const child of node.children.values()) lists.push(subtreePositions(child));
      node.subtree = ascendingUnion(lists);
    }
  }
  return node.subtree;
}

/** The first index in an ascending list holding a value >= `value`. */
export function lowerBound(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The last value in an ascending list that is < `before`, or -1. */
export function lastBefore(sorted: readonly number[], before: number): number {
  const at = lowerBound(sorted, before);
  return at > 0 ? sorted[at - 1] : -1;
}

/** The values of an ascending list in the OPEN range (`after`, `before`). */
export function between(sorted: readonly number[], after: number, before: number): readonly number[] {
  return sorted.slice(lowerBound(sorted, after + 1), lowerBound(sorted, before));
}

/** The commits that can have written a key, split by what the writer rule still has to ask. */
export interface WriterCandidates {
  /** Commits with a row `'exact'` or `'inside'` the key — writers by the path alone. Ascending. */
  readonly atOrInside: readonly number[];
  /** Commits with a row `'around'` the key and none at or inside it — writers only if the value at the key changed. Ascending. */
  readonly aroundOnly: readonly number[];
}

/** The path half of the writer rule over an index: every commit that can have written `key`. `O(depth + matches)`. */
export function writerCandidates(index: WriterIndex, key: string): WriterCandidates {
  const node = nodeAt(index, key);
  const written = node === undefined ? [] : subtreePositions(node);
  const ancestors = ancestorNodes(index, key);
  if (ancestors.length === 0) return { atOrInside: written, aroundOnly: [] };
  const already = new Set(written);
  return {
    atOrInside: written,
    aroundOnly: ascendingUnion(ancestors.map((a) => a.positions)).filter((i) => !already.has(i)),
  };
}

/** The ascending, de-duplicated union of ascending position lists. */
export function ascendingUnion(lists: readonly (readonly number[])[]): number[] {
  if (lists.length === 0) return [];
  if (lists.length === 1) return [...lists[0]];
  const all = new Set<number>();
  for (const list of lists) for (const i of list) all.add(i);
  return [...all].sort((a, b) => a - b);
}
