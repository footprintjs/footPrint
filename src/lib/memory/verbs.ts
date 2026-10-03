/**
 * verbs.ts — THE VERB LAW (L1): the one place a commit row becomes a value.
 *
 * A row of a commit bundle's `trace` carries one of four verbs —
 * `set | merge | append | delete` — and ONE step turns it into a value:
 * {@link applyVerb}. State is a left fold of that step (the event-sourcing
 * reducer): {@link foldRows} folds one bundle's rows into a state, and
 * {@link foldKey} folds ONE KEY across a log — every row under the key's
 * top-level key, read at the key (the value rule, `keyPaths.ts`). Every reader
 * of the log runs one of the two —
 *
 *   - the live commit and the redacted mirror (`nextGeneration`),
 *   - the public replay (`applySmartMerge`), the read-side folds
 *     (`applySmartMergeInto` — `EventLog.materialise`, `stateAt`) and the
 *     admitted record's comparison (`dryFold`): all {@link foldRows},
 *   - `commitValueAt`, and `arrayProvenance` as an OBSERVER of the same fold:
 *     {@link foldKey}.
 *
 * Three questions that used to be answered once per reader are answered here
 * once: what a verb does to the value before it ({@link applyVerb}), how the
 * result is placed ({@link placeVerb}), and how the log's own values are
 * treated on the way in (the clone discipline — a PARAMETER of the fold, see
 * {@link Discipline} and {@link RecordedPayload}). A new verb is one new arm of
 * `applyVerb` and one row of the traits table; the compiler refuses either
 * missing ({@link isTotal}, {@link recordsTail}, {@link VERBS}).
 *
 * An UNKNOWN verb is refused with {@link UnknownVerbError}, never folded as a
 * `merge` (the old silent default). Engine-written logs carry the four, so
 * every engine run folds byte-for-byte as before.
 */

import type { PathRelation } from './keyPaths.js';
import { deepSmartMerge } from './merge.js';
import { nativeDelete, nativeGet, nativeSet, own, ownedRootOf, ownSpine } from './pathOps.js';
import { DELIM, pathSegments } from './paths.js';
import type { CommitBundle, MemoryPatch, TraceEntry } from './types.js';

// ─── The vocabulary ──────────────────────────────────────────────────────────

/** A commit row's verb — `TraceEntry['verb']`, the union the types file declares. */
export type Verb = TraceEntry['verb'];

/**
 * The vocabulary: each verb with the two traits readers branch on, in the
 * order the contract names them. A `Record` over the union — the compiler
 * refuses a table that misses (or invents) a verb, so a verb cannot be added
 * without saying what it is.
 *
 *   `total` — the row decides the value ALONE; it reads nothing from what came
 *     before it ({@link isTotal}).
 *   `tail`  — the row records ONLY what it adds, not the whole value
 *     ({@link recordsTail}).
 */
const TRAITS: Record<Verb, { readonly total: boolean; readonly tail: boolean }> = {
  set: { total: true, tail: false },
  merge: { total: false, tail: false },
  append: { total: false, tail: true },
  delete: { total: true, tail: false },
};

/** The four verbs, in the order the contract names them. */
export const VERBS: readonly Verb[] = Object.freeze(Object.keys(TRAITS) as Verb[]);

/** Is `value` one of the four? The question every reader of a foreign log asks first. */
export function isVerb(value: unknown): value is Verb {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TRAITS, value);
}

/**
 * Does the verb decide the value ALONE — read nothing from what came before
 * it? `set` and `delete`. A reader that only needs the final value may start
 * at the last such row ({@link foldKey} `anchored`); one that tracks how the
 * value grew (provenance) starts at the first. Pinned against
 * {@link applyVerb} itself, so a new verb cannot misreport it.
 */
export function isTotal(verb: Verb): boolean {
  return TRAITS[verb].total;
}

/**
 * Does the row record ONLY what it adds — a tail — rather than the whole
 * value? `append`. What the row added is then known exactly: a reader that
 * tracks where array elements came from attributes them to this row without
 * comparing arrays, where every other verb has to be inferred from.
 */
export function recordsTail(verb: Verb): boolean {
  return TRAITS[verb].tail;
}

/** Where in a log a refused row sits. */
export interface RowSite {
  /** The row's `path`, DELIM-joined as the trace records it. */
  readonly path: string;
  /** The row's position in its bundle's `trace`. */
  readonly row: number;
  /** The bundle's position in the commit log, when the reader knows it. */
  readonly commit?: number;
}

/**
 * Thrown by the readers of a commit log — {@link foldRows} (behind
 * `applySmartMerge`), `commitValueAt`, `arrayProvenance` — when a row carries a
 * verb outside {@link VERBS}: a foreign or corrupted log fails loudly instead
 * of being replayed as a `merge`. `verb`, `path`, `row` and `commit` name the
 * row (`path` / `row` / `commit` are absent when the caller handed over a
 * bare verb); `path` is the trace's own DELIM-joined form — take it apart with
 * `pathSegments`. The message quotes `verb` and `path`, so a hostile log cannot
 * reshape it.
 */
export class UnknownVerbError extends Error {
  readonly verb: unknown;
  readonly path?: string;
  readonly row?: number;
  readonly commit?: number;

  constructor(verb: unknown, site?: RowSite) {
    const named =
      typeof verb === 'string' ? JSON.stringify(verb) : verb === undefined ? 'undefined' : `of type ${typeof verb}`;
    // The verb and the path come from a log nobody vetted: quoted (JSON), so a
    // control character in either cannot reshape the message.
    const where =
      site === undefined
        ? ''
        : ` on trace row ${site.row} (path ${JSON.stringify(pathSegments(site.path).join(' › '))}${
            site.commit === undefined ? '' : `, commit ${site.commit}`
          })`;
    const one = VERBS.join(' | ');
    super(`unknown verb ${named}${where}: a commit row is one of ${one} — the log is refused, not replayed as a merge`);
    this.name = 'UnknownVerbError';
    this.verb = verb;
    if (site !== undefined) {
      this.path = site.path;
      this.row = site.row;
      if (site.commit !== undefined) this.commit = site.commit;
    }
  }
}

function refuseVerb(verb: never): never {
  throw new UnknownVerbError(verb);
}

// ─── The step ────────────────────────────────────────────────────────────────

/**
 * What a `delete` row leaves behind: the KEY IS GONE — which is not the value
 * `undefined` (a root replay removes the key; a per-path fold reads it as
 * `undefined`). {@link applyVerb} returns it, {@link placeVerb} acts on it.
 */
export const ABSENT: unique symbol = Symbol('footprintjs.verbs.absent');

/**
 * One bundle's recorded payload, read by path under a clone discipline — the
 * values {@link applyVerb} reads out of the log.
 *
 * `detach` — `true` for every fold that keeps its result: a `set` value or an
 * `append` tail is a clone of what the log holds and the merge delta comes from
 * ONE detached copy of `updates`, so the result never aliases the log. `false`
 * only for the comparison fold ({@link dryFold}), which places recorded values
 * as recorded and drops its result.
 *
 * The delta is detached ONCE per bundle, lazily — a bundle with no `merge` row
 * pays nothing. `deepSmartMerge` dedups an array union BY REFERENCE and two
 * `merge` rows of one bundle replay the same accumulated delta, so the rows
 * must keep seeing the same objects; a clone per row duplicated their elements
 * (the differential caught it in the replay; `commitValueAt` carried the bug
 * until it folded through here). `only` narrows the copy to ONE path — a
 * per-path fold reads nothing else, and must not pay for the rest of the
 * bundle.
 */
export class RecordedPayload {
  private deltas: MemoryPatch | undefined;

  constructor(
    private readonly updates: MemoryPatch,
    private readonly overwrite: MemoryPatch,
    private readonly detach: boolean,
    private readonly only?: string[],
  ) {}

  /** What a `set` places and an `append` adds: `overwrite[path]`, cloned when detaching. */
  value(segs: string[]): unknown {
    const recorded = nativeGet(this.overwrite, segs);
    return this.detach ? structuredClone(recorded) : recorded;
  }

  /** The accumulated merge delta at `path`: `updates[path]`, from the bundle's one copy. */
  delta(segs: string[]): unknown {
    if (this.deltas === undefined) {
      const source = this.only === undefined ? this.updates : atPath(this.updates, this.only);
      this.deltas = this.detach ? structuredClone(source) : source;
    }
    return nativeGet(this.deltas, segs);
  }
}

/** `tree` reduced to ONE path: that sub-tree, by reference, under fresh containers. */
function atPath(tree: MemoryPatch, segs: string[]): MemoryPatch {
  const leaf = nativeGet(tree, segs);
  return leaf === undefined ? {} : nativeSet({}, segs, leaf);
}

/**
 * ONE row, ONE step: the value at the row's path AFTER the row, given the
 * value BEFORE it and the bundle's recorded payload. THE verb law — no other
 * function in the library has an arm per verb.
 *
 *   - `'set'`    — the recorded value (`overwrite[path]`, the full final value).
 *   - `'merge'`  — `deepSmartMerge` of the accumulated `updates[path]` delta onto
 *     the value before.
 *   - `'append'` — (delta mode) `overwrite[path]` holds ONLY the tail: concatenate
 *     it onto the value before. When either is not an array (an out-of-order
 *     replay base, or a REDACTED tail — `redactPatch` replaces matched payloads
 *     with the `'REDACTED'` string) the tail BECOMES the value — the same
 *     terminal value a redacted or corrupt `set` produces.
 *   - `'delete'` — {@link ABSENT}: the key is removed. The path stays enumerated
 *     in `overwrite` (value `undefined`) for key-set consumers; the step ignores
 *     that value.
 *
 * Pure: it reads the payload and never writes. `verb` must be a {@link Verb}
 * (the folds check with {@link isVerb} first and name the row); anything else
 * that reaches it is refused with {@link UnknownVerbError}.
 */
export function applyVerb(verb: Verb, before: unknown, at: RecordedPayload, segs: string[]): unknown {
  if (verb === 'set') return at.value(segs);
  if (verb === 'append') {
    const tail = at.value(segs);
    return Array.isArray(before) && Array.isArray(tail) ? [...before, ...tail] : tail;
  }
  if (verb === 'delete') return ABSENT;
  if (verb === 'merge') return deepSmartMerge(before, at.delta(segs));
  return refuseVerb(verb); // `verb` is `never` here — a fifth verb in the union stops compiling
}

/** Put a step's value at its path in `out` — or remove the key, for {@link ABSENT}. */
export function placeVerb(out: any, segs: string[], next: unknown): void {
  if (next === ABSENT) nativeDelete(out, segs);
  else nativeSet(out, segs, next);
}

/**
 * Is row `i` a `set` that the NEXT row sets again — same path, same verb — so
 * that applying it is work the next row redoes?
 *
 * The one skip every replay iterator shares (9.22.1). A `set` row writes a
 * clone of the recorded value at its path; the next row, a `set` of the same
 * path, writes a clone of the SAME recorded value over it (the bundle's patch
 * tree is fixed), and nothing runs in between — so the first write is
 * unobservable, container creation and key order included. Only CONSECUTIVE
 * rows qualify: a row in between (an ancestor `merge`, a sibling `set` that
 * creates a container) can see the intermediate value, and a `merge`,
 * `append` or `delete` next row depends on what is there. Rows are never
 * dropped from the log — the 9.22.0 element-write funnel records N
 * whole-array `set` rows on one path, and this is what makes replaying them
 * O(N) instead of O(N × rows).
 *
 * Asked by {@link foldRows} — live state and the redacted mirror through
 * {@link nextGeneration}, `EventLog.materialise` and `stateAt` through
 * {@link applySmartMergeInto}, the public {@link applySmartMerge}, and the
 * admitted record's {@link dryFold}. {@link foldKey} needs no skip: it
 * anchors at the top-level key's LAST `set`/`delete`, or (provenance) a
 * repeated `set` of the one recorded value changes no birth.
 */
export function supersededByNextSet(rows: readonly { path: string; verb: string }[], i: number): boolean {
  const row = rows[i];
  if (row.verb !== 'set') return false;
  const next = rows[i + 1];
  return next !== undefined && next.verb === 'set' && next.path === row.path;
}

// ─── The fold over one bundle ────────────────────────────────────────────────

/**
 * How {@link foldRows} treats the state it edits and the values it reads out of
 * the log — the clone discipline, a parameter of the ONE loop:
 *
 *   - `'private'` — `out` is a private deep clone, edited in place; every
 *     recorded value is cloned in. The public {@link applySmartMerge}.
 *   - `'pathCopy'` — copy-on-write (9.29.0): before a row that writes THROUGH a
 *     container (a nested path), the containers on its path that this fold did
 *     not create are copied, so no row edits a container another generation
 *     (or the log) holds; each value a row creates is marked owned, so later
 *     rows of the bundle write into it in place. Every recorded value is cloned
 *     in. The live commit ({@link nextGeneration}) and the read-side folds
 *     ({@link applySmartMergeInto}).
 *   - `'byReference'` — `'pathCopy'`, but recorded values are placed AS
 *     RECORDED (no clone) and never marked owned — a later row that writes
 *     through one copies it first, so the payload is never edited. For
 *     COMPARISON only ({@link dryFold}): the result aliases the log.
 */
export type Discipline = 'private' | 'pathCopy' | 'byReference';

/** Does any row write THROUGH a container (a delimited, nested path)? */
function hasNestedRow(rows: readonly TraceEntry[]): boolean {
  for (let i = 0; i < rows.length; i++) if (rows[i].path.indexOf(DELIM) !== -1) return true;
  return false;
}

/**
 * Fold one bundle's rows into `out`, in place: for each row (a `set` the next
 * row sets again is skipped — {@link supersededByNextSet}) take the step
 * ({@link applyVerb}) and put its value where it belongs ({@link placeVerb}).
 * `out` is the caller's — see {@link Discipline} for what it must be.
 *
 * A row whose verb is not one of {@link VERBS} stops the fold with
 * {@link UnknownVerbError} naming the row; the rows before it have been
 * applied, to a state the caller discards (every in-tree caller does).
 */
export function foldRows(
  out: any,
  updates: MemoryPatch,
  overwrite: MemoryPatch,
  rows: readonly TraceEntry[],
  discipline: Discipline,
): any {
  const detach = discipline !== 'byReference';
  const owned = discipline !== 'private' && hasNestedRow(rows) ? new WeakSet<object>() : undefined;
  own(out, owned);
  const at = new RecordedPayload(updates, overwrite, detach);
  for (let i = 0; i < rows.length; i++) {
    if (supersededByNextSet(rows, i)) continue;
    const { path, verb } = rows[i];
    if (!isVerb(verb)) throw new UnknownVerbError(verb, { path, row: i });
    const segs = path.split(DELIM);
    if (owned !== undefined && segs.length > 1) ownSpine(out, segs, owned);
    // A total verb reads nothing from what came before it (isTotal) — so the
    // fold does not look.
    const next = applyVerb(verb, isTotal(verb) ? undefined : nativeGet(out, segs), at, segs);
    // A value this fold CREATED is its own to edit in place; a recorded value
    // placed by reference is the log's.
    if (detach || verb === 'merge') own(next, owned);
    placeVerb(out, segs, next);
  }
  return out;
}

/**
 * Applies a commit bundle to a base state by replaying operations in order.
 * Guarantees "last writer wins" semantics.
 *
 * Returns a FULLY DETACHED result: the base is deep-cloned first and every
 * value the replay writes is its own (`set` / `append` clone the recorded
 * value; the `merge` arm reads a detached copy of `updates`), so the result
 * shares no container with `base`, `updates` or `overwrite`. This is the
 * public (`footprintjs/advanced`) contract, unchanged by copy-on-write
 * (9.29.0) — byte-identical to 9.28.0 for every caller. The engine's own
 * commit does NOT come here: `SharedMemory.applyPatch` builds the next
 * generation with `nextGeneration`, which copies only the written
 * paths. Both run the ONE fold, {@link foldRows}; the verbs are
 * {@link applyVerb}'s.
 *
 * Verb arms — see {@link applyVerb}. A row with any other verb throws
 * {@link UnknownVerbError}.
 *
 * Work, not bytes (9.22.1): a `set` row the NEXT row re-sets is skipped
 * ({@link supersededByNextSet}) — the rows stay in the log, only the clone
 * each would have paid is not. Every consumer inherits the skip from
 * `foldRows`; there is no second replay loop to keep in step.
 */
export function applySmartMerge(base: any, updates: MemoryPatch, overwrite: MemoryPatch, trace: TraceEntry[]): any {
  return foldRows(structuredClone(base), updates, overwrite, trace, 'private');
}

/**
 * The engine's commit (copy-on-write, 9.29.0 — docs/design/2026-10-copy-on-
 * write-commit.md): the NEXT committed generation. A copy of `base`'s ROOT
 * plus a copy of every container on each written path; every other subtree
 * is SHARED with `base`, which is never edited — committed state is
 * immutable-after-swap, so sharing is safe, and a commit costs O(what it
 * wrote), not O(state). `SharedMemory.applyPatch` (live state and the
 * redacted mirror) is its caller. Internal: the public replay is
 * {@link applySmartMerge}.
 */
export function nextGeneration(base: any, updates: MemoryPatch, overwrite: MemoryPatch, trace: TraceEntry[]): any {
  return foldRows(ownedRootOf(base), updates, overwrite, trace, 'pathCopy');
}

/**
 * The same replay, INTO `target` — no clone of its own. For a caller that
 * already holds a private working copy (the read-side folds: `stateAt` in
 * `time-travel/stateAt.ts` and `EventLog.materialise` clone their base ONCE
 * and then apply every bundle here), so a fold over N bundles costs N row
 * applications, not N clones of the whole state. Never hand it committed
 * state: it mutates the ROOT in place. Below the root it follows the live
 * commit's law ({@link nextGeneration}) — a container this call did not
 * create is copied before a write passes through it — so a fold and the live
 * state give the same value at every path, aliased subtrees included.
 * The values it writes are its own, so `target` never aliases the log.
 */
export function applySmartMergeInto(
  target: any,
  updates: MemoryPatch,
  overwrite: MemoryPatch,
  trace: TraceEntry[],
): any {
  return foldRows(target, updates, overwrite, trace, 'pathCopy');
}

/**
 * The fold, for COMPARISON only (9.30.0 — the admitted record): `base` with
 * the bundle replayed by the one verb law, copy-on-write below the root,
 * every recorded value placed BY REFERENCE — no clone, so it costs what the
 * bundle wrote and nothing more. It aliases the payload and every subtree of
 * `base` the bundle did not write, and edits neither. Never hand it out,
 * store it or write through it: `TransactionBuffer` builds one to ask whether
 * a bundle folds back to what the stage read, then drops it.
 */
export function dryFold(base: any, updates: MemoryPatch, overwrite: MemoryPatch, trace: TraceEntry[]): any {
  return foldRows(ownedRootOf(base), updates, overwrite, trace, 'byReference');
}

// ─── The fold over one key ───────────────────────────────────────────────────

/**
 * One row of the log under the folded key's TOP-LEVEL key — what {@link foldKey}
 * applies, in commit order.
 */
export interface Touch {
  readonly verb: Verb;
  readonly bundle: CommitBundle;
  /** The bundle's position in the commit log. */
  readonly commitIdx: number;
  /** The row's own path (DELIM-joined `TraceEntry.path`). */
  readonly path: string;
  /**
   * How the row sits against the folded key (`keyPaths · relation`). ABSENT for a
   * row on another path under the same top-level key: such a row is APPLIED (an
   * array union on a container above the key dedups the whole array, so a sibling
   * changes where it leaves the key) but never observed.
   */
  readonly relation?: PathRelation;
}

/** What a reader asks of {@link foldKey}. */
export interface KeyFold {
  /**
   * Start at the LAST row that sets or deletes the whole TOP-LEVEL key ({@link
   * isTotal}, on the root path itself) — rows before it cannot change anything
   * under that key, so a reader that wants only the value skips them. A `set` of
   * a path below the root is NOT an anchor: an earlier sibling can still move
   * the key through a later union. Off by default: a reader that tracks how the
   * value GREW must see every row.
   */
  readonly anchored?: boolean;
  /**
   * Called after each applied row that has a {@link Touch.relation} — on, inside
   * or around the key — with the value AT THE KEY before it and after it
   * (`undefined` for an absent key). The seam a provenance track and the writer
   * rule hang on: they watch the fold, they never have a verb switch of their
   * own. For a row INSIDE the key, an array `before` is a shallow snapshot: that
   * row edits the fold's own copy in place.
   */
  readonly observe?: (touch: Touch, before: unknown, after: unknown) => void;
}

/**
 * The value of ONE key after `touches` — EVERY row under its top-level key, in
 * commit order, each already checked with {@link isVerb} — folded from an absent
 * key, read at the key (`segs`, its DELIM segments): the value rule of
 * `keyPaths.ts`, the fold `stateAt` does restricted to one top-level key. Top-level
 * keys never interact under the step, so the restriction is exact.
 *
 * The same step ({@link applyVerb}) and the same discipline as {@link foldRows}'s
 * `'pathCopy'`: `set` / `append` values are clones, the merge delta is detached
 * once per BUNDLE (narrowed to the top-level key), so two `merge` rows of one
 * bundle see the same objects, and a row that writes through a container this
 * fold did not create copies it first. Returns `undefined` for an absent key.
 * O(the rows under the key's top-level key), not O(the log).
 */
export function foldKey(touches: readonly Touch[], segs: string[], options: KeyFold = {}): unknown {
  const root = segs[0];
  let from = 0;
  if (options.anchored === true) {
    for (let i = touches.length - 1; i >= 0; i--) {
      if (isTotal(touches[i].verb) && touches[i].path === root) {
        from = i;
        break;
      }
    }
  }
  const state: Record<string, unknown> = {};
  const owned = new WeakSet<object>();
  owned.add(state);
  const observe = options.observe;
  let at: RecordedPayload | undefined;
  let atCommit = -1;
  for (let i = from; i < touches.length; i++) {
    const touch = touches[i];
    if (at === undefined || touch.commitIdx !== atCommit) {
      at = new RecordedPayload(touch.bundle.updates, touch.bundle.overwrite, true, [root]);
      atCommit = touch.commitIdx;
    }
    const rowSegs = touch.path === root ? [root] : touch.path.split(DELIM);
    const watched = observe !== undefined && touch.relation !== undefined;
    let before: unknown;
    if (watched) {
      before = nativeGet(state, segs);
      if (touch.relation === 'inside' && Array.isArray(before)) before = before.slice();
    }
    if (rowSegs.length > 1) ownSpine(state, rowSegs, owned);
    // A total verb reads nothing from what came before it (isTotal).
    const next = applyVerb(touch.verb, isTotal(touch.verb) ? undefined : nativeGet(state, rowSegs), at, rowSegs);
    own(next, owned);
    placeVerb(state, rowSegs, next);
    if (watched) observe(touch, before, nativeGet(state, segs));
  }
  return nativeGet(state, segs);
}
