/**
 * logModel.ts — the read model of ONE commit log: the writer rule and the value rule of `keyPaths.ts`,
 * answered at a cost proportional to the answer, not to the log (F3, 9.33.0).
 *
 * WHY THIS FILE EXISTS. The rules are simple to state and expensive to apply naively: a key's writers
 * include the commits AROUND it whose change reached it, and deciding that needs the value at the key
 * before and after such a commit — a fold of its top-level key. Folding once per KEY made a causal walk
 * over nested keys cubic in the log (every key re-scanned the log and re-folded its root). Here:
 *
 *   - the log is indexed ONCE (`keyPaths · buildWriterIndex`, a path trie): a key's candidates cost
 *     O(depth + matches) — its node, its ancestors, its subtree — and the rows under a top-level key are
 *     reached through the index, never a scan;
 *   - each top-level key is folded ONCE (`verbs · foldKey`, copy-on-write), keeping its value before and
 *     after every commit a verdict can ask about: a commit with a row on a path that has written paths
 *     below it (it can be AROUND a written key), and a commit that writes THROUGH a string-valued
 *     container (`nativeSet` replaces the string, and the characters a key read from it vanish — the one
 *     way a row BESIDE a key moves it). A key's verdict is then two `nativeGet`s and a `deepEqual`;
 *   - the last writer before a point is found LAZILY: the last write on or inside the key, then only the
 *     around-candidates after it — most questions need no verdict at all.
 *
 * One shape keeps a per-key fold (memoised per key): a key that was never written, under a container that
 * was only ever written WHOLE (its node has no written children, so no generation is kept there).
 *
 * A model of a FROZEN log (every engine log since F3: `EventLog · record` freezes each bundle and
 * `getSnapshot` freezes the array) is memoised on the log — the record cannot change under it. A log that
 * is not frozen (hand-built, parsed from JSON) gets a fresh model per question.
 */

import { deepEqual } from './equality.js';
import {
  type PathNode,
  type WriterIndex,
  ancestorNodes,
  ascendingUnion,
  between,
  buildWriterIndex,
  lastBefore,
  nodeAt,
  relation,
  rootOf,
  subtreePositions,
} from './keyPaths.js';
import { nativeGet } from './pathOps.js';
import { DELIM } from './paths.js';
import type { CommitBundle } from './types.js';
import { type Touch, foldKey, isVerb, UnknownVerbError } from './verbs.js';

/** The rows under one top-level key, in commit order — up to the first row the verb law refuses. */
interface RootRows {
  readonly rows: Touch[];
  /** The first row under the key whose verb is none of the four — every answer that reaches it is refused. */
  readonly refused?: UnknownVerbError;
  readonly refusedAt: number;
}

/** One top-level key folded once: its value before and after every commit a verdict can ask about. */
interface RootHistory {
  readonly kept: Map<number, { readonly before: unknown; readonly after: unknown }>;
  /** The kept commits, ascending. */
  readonly keptAt: readonly number[];
  /** Commits that wrote THROUGH a string-valued container, by the node of that container. */
  readonly replaced: Map<PathNode, number[]>;
}

const MODELS = new WeakMap<readonly CommitBundle[], LogModel>();

/** Is the log immutable — the array and every bundle and trace frozen (an engine snapshot's log)? */
function isFrozenLog(log: readonly CommitBundle[]): boolean {
  if (!Object.isFrozen(log)) return false;
  // The shape `EventLog · record` leaves: the bundle, its payloads and its rows. A hand-built log
  // frozen less deeply than that could change after a query, so it is never memoised.
  for (const bundle of log) {
    if (!Object.isFrozen(bundle) || !Object.isFrozen(bundle.trace)) return false;
    if (!Object.isFrozen(bundle.overwrite) || !Object.isFrozen(bundle.updates)) return false;
    if (!bundle.trace.every((row) => Object.isFrozen(row))) return false;
  }
  return true;
}

/** The read model of `log` — memoised when the log is frozen, fresh otherwise. */
export function logModel(log: readonly CommitBundle[]): LogModel {
  const memo = MODELS.get(log);
  if (memo !== undefined) return memo;
  const model = new LogModel(log);
  if (isFrozenLog(log)) MODELS.set(log, model);
  return model;
}

/** The memoised model of a frozen log (built on first ask), or undefined for a log that is not frozen. */
export function memoisedModel(log: readonly CommitBundle[]): LogModel | undefined {
  return MODELS.get(log) ?? (isFrozenLog(log) ? logModel(log) : undefined);
}

/** Does the commit hold a non-`delete` row on `key` or inside it? (A `delete` cannot replace a string container.) */
export function writesAtOrInside(bundle: CommitBundle, key: string): boolean {
  for (const t of bundle.trace) {
    if (t.verb === 'delete') continue;
    const r = relation(t.path, key);
    if (r === 'exact' || r === 'inside') return true;
  }
  return false;
}

/**
 * Can this commit leave a STRING-valued container above `key` — a row around the key whose recorded value
 * holds a string at the row's path or anywhere between it and the key? Only then can a later write beside the
 * key move it (`nativeSet` replaces the string). A conservative, payload-only check: no fold.
 */
export function leavesStringAbove(bundle: CommitBundle, key: string): boolean {
  const keySegs = key.split(DELIM);
  for (const t of bundle.trace) {
    if (t.verb === 'delete' || relation(t.path, key) !== 'around') continue;
    const segs = t.path.split(DELIM);
    let value: unknown = nativeGet(t.verb === 'merge' ? bundle.updates : bundle.overwrite, segs);
    for (let depth = segs.length; depth < keySegs.length; depth++) {
      if (typeof value === 'string') return true;
      if (value === null || typeof value !== 'object') break;
      value = nativeGet(value, [keySegs[depth]]);
    }
  }
  return false;
}

export class LogModel {
  readonly index: WriterIndex;
  private readonly roots = new Map<string, RootRows>();
  private readonly histories = new Map<string, RootHistory>();
  private readonly changesByKey = new Map<string, number[]>();
  private readonly writersByKey = new Map<string, number[]>();

  constructor(readonly log: readonly CommitBundle[]) {
    this.index = buildWriterIndex(log);
  }

  // ── rows ─────────────────────────────────────────────────────────────────

  private rootRows(root: string): RootRows {
    let entry = this.roots.get(root);
    if (entry !== undefined) return entry;
    const node = this.index.roots.get(root);
    const rows: Touch[] = [];
    let refused: UnknownVerbError | undefined;
    let refusedAt = Number.POSITIVE_INFINITY;
    if (node !== undefined) {
      for (const c of subtreePositions(node)) {
        const trace = this.log[c].trace;
        for (let row = 0; row < trace.length && refused === undefined; row++) {
          const { path, verb } = trace[row];
          if (path !== root && relation(path, root) !== 'inside') continue;
          if (!isVerb(verb)) {
            refused = new UnknownVerbError(verb, { path, row, commit: c });
            refusedAt = c;
            // the refused commit and everything after it are left out: an answer that reaches them is refused
            while (rows.length > 0 && rows[rows.length - 1].commitIdx === c) rows.pop();
          } else rows.push({ verb, bundle: this.log[c], commitIdx: c, path });
        }
        if (refused !== undefined) break;
      }
    }
    entry = { rows, ...(refused !== undefined && { refused }), refusedAt };
    this.roots.set(root, entry);
    return entry;
  }

  /** Refuse an answer that reaches a row whose verb the law does not know (one in commits `after` < c ≤ `end`). */
  private refuseThrough(root: string, end: number, after = -1): RootRows {
    const rr = this.rootRows(root);
    if (rr.refused !== undefined && rr.refusedAt <= end && rr.refusedAt > after) throw rr.refused;
    return rr;
  }

  /** Every row under `key`'s top-level key up to `end`, with its relation to `key` — through the index. */
  rowsUnderRoot(key: string, end: number): Touch[] {
    const rr = this.refuseThrough(rootOf(key), end);
    const out: Touch[] = [];
    for (const t of rr.rows) {
      if (t.commitIdx > end) break;
      const r = relation(t.path, key);
      out.push(r === undefined ? t : { ...t, relation: r });
    }
    return out;
  }

  // ── the root fold, once per top-level key ───────────────────────────────

  private history(root: string): RootHistory {
    let h = this.histories.get(root);
    if (h !== undefined) return h;
    const kept = new Map<number, { before: unknown; after: unknown }>();
    const replaced = new Map<PathNode, number[]>();
    const rr = this.rootRows(root);
    foldKey(rr.rows, [root], {
      generations: {
        at: (c, state) => {
          let keep = false;
          for (const t of this.log[c].trace) {
            if (t.path !== root && relation(t.path, root) !== 'inside') continue;
            if ((nodeAt(this.index, t.path)?.children.size ?? 0) > 0) keep = true;
            const segs = t.path.split(DELIM);
            for (let j = 1; j < segs.length; j++) {
              if (typeof nativeGet(state, segs.slice(0, j)) !== 'string') continue;
              const container = nodeAt(this.index, segs.slice(0, j).join(DELIM));
              if (container !== undefined) {
                const list = replaced.get(container) ?? [];
                if (list[list.length - 1] !== c) list.push(c);
                replaced.set(container, list);
              }
              keep = true;
            }
          }
          return keep;
        },
        keep: (c, before, after) => {
          kept.set(c, { before, after });
        },
      },
    });
    h = { kept, keptAt: [...kept.keys()].sort((a, b) => a - b), replaced };
    this.histories.set(root, h);
    return h;
  }

  /** A key never written, under a container only ever written whole: no generation is kept for it. */
  private needsOwnFold(key: string, ancestors: readonly PathNode[]): boolean {
    return nodeAt(this.index, key) === undefined && ancestors[ancestors.length - 1].children.size === 0;
  }

  /** Every commit across which the value at `key` changed — one fold for this key (the fallback shape). */
  private ownChanges(key: string): number[] {
    let changes = this.changesByKey.get(key);
    if (changes !== undefined) return changes;
    const segs = key.split(DELIM);
    const verdict = new Map<number, boolean>();
    let commit = -1;
    let start: unknown;
    foldKey(this.rootRows(segs[0]).rows, segs, {
      everyRow: true,
      observe: (touch, before, after) => {
        if (touch.commitIdx !== commit) {
          commit = touch.commitIdx;
          start = before;
        }
        verdict.set(commit, !deepEqual(start, after));
      },
    });
    changes = [...verdict].filter(([, changed]) => changed).map(([c]) => c);
    this.changesByKey.set(key, changes);
    return changes;
  }

  /**
   * The commits in the OPEN range (`after`, `before`) with no row on or inside `key` across which the value
   * at `key` changed — the AROUND half of the writer rule (and the string-container case beside it).
   */
  private changedAround(key: string, after: number, before: number): readonly number[] {
    const ancestors = ancestorNodes(this.index, key);
    if (ancestors.length === 0 || ancestors.every((a) => a.positions.length === 0)) return [];
    const root = ancestors[0].path;
    // The answer reads the rows of the window: refuse it when one of them is a verb the law does not know.
    this.refuseThrough(root, before - 1, after);
    if (this.needsOwnFold(key, ancestors)) return between(this.ownChanges(key), after, before);
    const h = this.history(root);
    const candidates = ascendingUnion([
      ...ancestors.map((a) => between(a.positions, after, before)),
      ...ancestors.map((a) => between(h.replaced.get(a) ?? [], after, before)),
    ]);
    const rest = key.split(DELIM).slice(1);
    return candidates.filter((c) => {
      const g = h.kept.get(c);
      return g !== undefined && !deepEqual(nativeGet(g.before, rest), nativeGet(g.after, rest));
    });
  }

  // ── the writer rule ──────────────────────────────────────────────────────

  /** Every commit that WROTE `key`, ascending (memoised per key). */
  writersOf(key: string): readonly number[] {
    let writers = this.writersByKey.get(key);
    if (writers !== undefined) return writers;
    const node = nodeAt(this.index, key);
    const atOrInside = node === undefined ? [] : subtreePositions(node);
    const around = this.changedAround(key, -1, Number.POSITIVE_INFINITY);
    writers = around.length === 0 ? atOrInside.slice() : ascendingUnion([atOrInside, around]);
    this.writersByKey.set(key, writers);
    return writers;
  }

  /** The ARRAY position of the last commit before `before` that wrote `key`, or -1. */
  lastWriterBefore(key: string, before: number): number {
    const node = nodeAt(this.index, key);
    const lastAI = node === undefined ? -1 : lastBefore(subtreePositions(node), before);
    const ancestors = ancestorNodes(this.index, key);
    if (ancestors.length === 0) return lastAI;
    // A row around the key in the last write's OWN commit counts when it can leave a string container above
    // the key (a later write beside the key then replaces it).
    const aroundInWindow =
      ancestors.some((a) => between(a.positions, lastAI, before).length > 0) ||
      (lastAI !== -1 && leavesStringAbove(this.log[lastAI], key));
    // A `delete` cannot replace a string container, so a character read through one can still move after it.
    const deleteOnly = lastAI !== -1 && !writesAtOrInside(this.log[lastAI], key);
    if (!aroundInWindow && !(deleteOnly && ancestors.some((a) => a.positions.length > 0))) return lastAI;
    const changed = this.changedAround(key, lastAI, before);
    return changed.length > 0 ? changed[changed.length - 1] : lastAI;
  }

  // ── the value rule ───────────────────────────────────────────────────────

  /**
   * The value of `key` after commit `idx` (inclusive). The fold of the rows under its top-level key — but
   * when its last total row up to `idx` is a `set` ON the key and nothing around it was written since, only
   * the rows on and inside the key from that `set` on can move it, and only they are folded.
   */
  valueAt(key: string, idx: number): unknown {
    const segs = key.split(DELIM);
    this.refuseThrough(segs[0], idx);
    const node = nodeAt(this.index, key);
    const ancestors = ancestorNodes(this.index, key);
    if (node === undefined && ancestors.length === 0) return undefined;
    if (node !== undefined) {
      const anchor = lastBefore(node.totals, idx + 1);
      if (
        anchor !== -1 &&
        lastTotalIsSet(this.log[anchor], key) &&
        ancestors.every((a) => between(a.positions, anchor - 1, idx + 1).length === 0)
      ) {
        const rows: Touch[] = [];
        for (const c of between(subtreePositions(node), anchor - 1, idx + 1)) {
          const trace = this.log[c].trace;
          for (let row = 0; row < trace.length; row++) {
            const r = relation(trace[row].path, key);
            if (r === 'exact' || r === 'inside') {
              rows.push({
                verb: trace[row].verb as Touch['verb'],
                bundle: this.log[c],
                commitIdx: c,
                path: trace[row].path,
                relation: r,
              });
            }
          }
        }
        return foldKey(rows, segs);
      }
    }
    const rows = this.rowsUnderRoot(key, idx);
    if (!rows.some((row) => row.relation !== undefined)) return undefined;
    // A memoised model folds from the last generation it keeps at or before `idx` — the rows after it only.
    if (MODELS.get(this.log) === this) {
      const h = this.history(segs[0]);
      const kept = lastBefore(h.keptAt, idx + 1);
      if (kept !== -1) {
        const after = rows.filter((row) => row.commitIdx > kept);
        return foldKey(after, segs, { anchored: true, start: h.kept.get(kept)?.after });
      }
    }
    return foldKey(rows, segs, { anchored: true });
  }
}

/** Is the last `set` / `delete` row ON `key` in this commit a `set`? */
function lastTotalIsSet(bundle: CommitBundle, key: string): boolean {
  for (let i = bundle.trace.length - 1; i >= 0; i--) {
    const t = bundle.trace[i];
    if (t.path === key && (t.verb === 'set' || t.verb === 'delete')) return t.verb === 'set';
  }
  return false;
}
