/**
 * time-travel/types.ts — the shapes of the reader's cursor.
 *
 * WHY THIS MODULE EXISTS (context for future readers, human or LLM):
 * Time travel in footprintjs is a READER'S cursor over a FINISHED trace, with
 * a fold at each stop. It is not the Walker — the engine's traversal — and it
 * must never become a second live cursor: nothing here can move, re-run or
 * mutate an execution. Every consumer (a why-panel, a flow view, a chart
 * dashboard) was writing the same commit-index arithmetic by hand, from the
 * same commit log, and disagreeing about the answers. This is that arithmetic,
 * once, in the library that owns the substrate.
 *
 * DAG position: memory ← time-travel. This module may import ONLY from
 * memory/ plus `engine/runtimeStageId` — the zero-dependency id grammar that
 * defines what a `runtimeStageId` means, and therefore the one piece of
 * engine/ a reader of ids cannot honestly re-implement. Recorders, traversal
 * and runner must never be imported here; the
 * snapshot arrives as a plain structural shape ({@link FoldSource},
 * {@link TimeTravelSource}) so a stored JSON trace works exactly like a live
 * `getSnapshot()`.
 */

import type { CommitBundle, StageSnapshot } from '../memory/types.js';

// ── Sources ────────────────────────────────────────────────────────────────

/**
 * Anything that carries a commit log and (ideally) its fold base.
 *
 * Two field spellings, because the library already has two: the run's log is
 * `commitLog` (`getSnapshot()`), a subflow's is `history`
 * (`getSubtreeSnapshot()` / `subflowResults[...].treeContext`). Both are
 * accepted so a caller never has to reshape a snapshot to ask a question.
 *
 * BOTH SPELLINGS TAKE `readonly unknown[]` (9.18.0). A live snapshot hands
 * over real {@link CommitBundle}s and is assignable exactly as before; a
 * STORED recording is parsed JSON, and a careful consumer will not claim that
 * what came back off disk is a `CommitBundle`. The narrowing therefore happens
 * HERE, per bundle, where the fold actually reads one — the only place that
 * can honestly do it. An entry that is not a bundle becomes a GAP: it keeps
 * its index (so every `commitIdx` still addresses the same position), it
 * contributes no state, it gets no stop, and any fold that crosses it reports
 * it in {@link FoldedState.skipped} with the index and the reason.
 *
 * EVERY FIELD IS OPTIONAL, deliberately the same shape {@link TimeTravelSource}
 * has: a consumer's stored-recording type (`commitLog?: readonly unknown[]`)
 * drives `stateAt` and `timeTravel` alike, with no cast at either. A source
 * with neither spelling present folds to its base and reports
 * `throughCommitIdx: -1` — the truthful answer for a log that was not there.
 *
 * THIS IS AN INPUT SHAPE. Nothing typed as a `FoldSource` promises that its
 * rows are bundles; code that wants to read `CommitBundle` fields back OUT of
 * one must narrow each row with `isCommitBundle` first.
 */
export type FoldSource = {
  /** The run's commit log. May be ABSENT (a stored recording's optional field): an absent log folds to the base. */
  readonly commitLog?: readonly unknown[];
  /** A subflow subtree's own log — the same thing under its other name. */
  readonly history?: readonly unknown[];
  readonly initialState?: Record<string, unknown>;
};

/**
 * A snapshot-shaped source for {@link timeTravel}.
 *
 * Every field is optional and the structural ones are `unknown` (9.18.0), so
 * a live `getSnapshot()` is assignable exactly as it was AND so is a stored
 * recording a consumer typed honestly — `commitLog: readonly unknown[]`,
 * `executionTree: unknown` — because parsed JSON is not a `StageSnapshot`
 * until something says so. The narrowing happens inside: rows per bundle
 * (see {@link FoldSource}), the tree and the subflow results as plain
 * objects, anything else read as absent.
 */
export interface TimeTravelSource {
  /** The run's commit log. See {@link FoldSource} on why this is `unknown[]`. */
  readonly commitLog?: readonly unknown[];
  /** A subflow subtree's own log — the same thing under its other name. */
  readonly history?: readonly unknown[];
  readonly initialState?: Record<string, unknown>;
  /**
   * The run's execution tree (`getSnapshot().executionTree`) — what makes a
   * mount stop say `kind: 'mount'` authoritatively instead of by shape. A live
   * snapshot hands a {@link StageSnapshot}; a stored one hands parsed JSON,
   * which is read as a tree when it is a plain object and ignored otherwise.
   */
  readonly executionTree?: StageSnapshot | unknown;
  /**
   * Dual-keyed subflow results (`getSnapshot().subflowResults`) — what
   * {@link TimeTravel.drill} navigates. Absent, or not a plain object ⇒
   * `drill` always returns `undefined`, which is the honest answer for a run
   * with no subflows.
   */
  readonly subflowResults?: Record<string, unknown> | unknown;
}

/**
 * One entry of a source's log that could not be read as a {@link CommitBundle}.
 *
 * Reported rather than thrown: a stored recording with one corrupt row is
 * still worth reading, and a reader that is told WHICH index it lost can say
 * so on screen. `index` is the position in that source's own log.
 */
export interface LogGap {
  /** ARRAY INDEX in the source's log — the address the gap occupies. */
  readonly index: number;
  /** Why it is not a bundle, in words a UI can print. */
  readonly reason: string;
}

// ── Stops ──────────────────────────────────────────────────────────────────

/**
 * What kind of position a stop is.
 *
 * - `'commit'` — one executed stage.
 * - `'mount'`  — a subflow mount: the boundary whose inner stages live in the
 *   subflow's OWN log (drill into it with {@link TimeTravel.drill}).
 * - `'start'`  — the bookend BEFORE the first stop of THIS axis. What it folds
 *   depends on the strategy, and the difference is load-bearing:
 *   - on a strategy that keeps every stage (`commitStops`, the one shipped)
 *     it is the run's fold BASE — the state no commit index can reach — plus
 *     any id-less leading commit, which is how a subflow's `inputMapper` seed
 *     reaches the log. So on a drilled cursor it is exactly "the input this
 *     subflow began with".
 *   - on a strategy that FILTERS stages out, the commits of the dropped
 *     stages that ran BEFORE the first surviving stop have to fold somewhere,
 *     and `'start'` is the only place they can go without orphaning them. Its
 *     fold is then the base PLUS that prologue — the state the first stop
 *     READ, not the run's raw base. Such a start MUST say so by setting
 *     {@link Stop.prologue}; a renderer that means "the run's raw base" reads
 *     `kind === 'start' && !stop.prologue`, and gets a true answer on every
 *     axis instead of one that is true only on the library's own.
 * - `'end'`    — the bookend after the last commit: "the run is over". Its
 *   fold equals the final stage's by construction; the two are different
 *   questions, not a duplicated answer.
 *
 * NOT WIDENED, DELIBERATELY. A filtering strategy's start could have been a
 * fifth kind (`'prologue'`), but adding a member to this union breaks every
 * consumer with an exhaustive `switch` over it — a compile error handed to
 * readers who did nothing wrong. A flag on the stop says the same thing and
 * costs an existing reader nothing.
 */
export type StopKind = 'commit' | 'mount' | 'start' | 'end';

/**
 * One position a reader's cursor can rest at.
 *
 * @typeParam TMeta the STRATEGY'S own vocabulary, carried opaquely in
 *   {@link Stop.meta}. Defaults to `unknown`, so every pre-9.18 `Stop` still
 *   means what it meant.
 */
export interface Stop<TMeta = unknown> {
  /** Position in `TimeTravel.stops` — 0-based, the cursor's step number. */
  readonly step: number;
  /**
   * The stage this stop is: `[subflowPath/]stageId#executionIndex`.
   * `''` for the `'start'` / `'end'` bookends, which are not stages.
   */
  readonly runtimeStageId: string;
  /**
   * ARRAY INDEX of this stop's FIRST commit bundle; `-1` at `'start'`.
   * This is the stop's address on the commit axis.
   *
   * Indices are SOURCE-LOCAL. On a chained cursor (see
   * {@link timeTravel}) they index the log of {@link Stop.sourceIdx}, never a
   * concatenation — commit indices are run-local and the library will not
   * invent a global one.
   */
  readonly commitIdx: number;
  /**
   * ARRAY INDEX of the LAST commit bundle folded at this stop — the end of
   * this stop's slice of the log. Stops PARTITION the log, so this is the
   * index just before the next stop begins; it is greater than
   * {@link commitIdx} whenever a stage committed more than one bundle (a
   * subflow mount's output-mapping + exit pair, a fork child's empty repeat),
   * and greater again on a filtering strategy, which absorbs the commits of
   * the stages it dropped. Folding through this index — not through
   * `commitIdx` — is what makes `stateAt(stop)` equal the state the next
   * stage started from.
   */
  readonly lastCommitIdx: number;
  /** Stable stage id from the builder (the post-mount, prefixed form). */
  readonly stageId: string;
  /** Subflow path this stage ran under, when it ran inside one. */
  readonly subflowPath?: string;
  /** Human-readable stage name — what a UI puts on the axis tick. */
  readonly label: string;
  readonly kind: StopKind;
  /**
   * THE STRATEGY'S OWN VOCABULARY, carried verbatim. The port assigns it NO
   * meaning: it never reads it, never validates it, never branches on it, and
   * passes it through `timeTravel`, `jumpTo`, `drill` and marks BY REFERENCE
   * — never cloned, never frozen. The stop holds the very object the strategy
   * put there, so a mutation through one holder is visible to every other.
   *
   * WHY IT EXISTS. {@link kind} is the PORT's vocabulary — the four positions
   * the substrate itself knows. A domain strategy classifies stages in its own
   * terms (a milestone, a turn, a tool call, a beat) and had nowhere to put
   * that, so the answer travelled by re-deriving it from `runtimeStageId` at
   * every read: a second run of the classifier that just ran, and a second
   * chance to disagree with it. A stop now carries what its strategy knew.
   *
   * Absent on every stop `commitStops` produces — the shipped strategy has no
   * vocabulary beyond `kind`, and says so by omission rather than by `null`.
   */
  readonly meta?: TMeta;
  /**
   * Only meaningful on `kind: 'start'`. `true` when this start folds the
   * commits of STAGES THIS AXIS DOES NOT SHOW — the prologue a filtering
   * strategy must put somewhere. Absent (never `false`) on an axis whose start
   * is the run's raw fold base.
   *
   * A reader that wants "the state before anything ran" checks
   * `kind === 'start' && !prologue`; one that wants "the state the first stop
   * read" just folds the start. See {@link StopKind}.
   */
  readonly prologue?: true;
  /**
   * Which SOURCE this stop's commit indices belong to, on a chained cursor —
   * the position in the array handed to {@link timeTravel}. Absent on a cursor
   * over a single source, which is every cursor built before 9.18.0.
   */
  readonly sourceIdx?: number;
}

/**
 * The `[start, …stages, end]` shape `commitStops` returns for a NON-EMPTY log
 * — split out, so a strategy that composes it stops writing its own guard.
 *
 * See {@link splitAxis}.
 */
export interface BookendedAxis<TMeta = unknown> {
  /** The `'start'` bookend — the only stop that may open at `commitIdx: -1`. */
  readonly start: Stop<TMeta>;
  /** Everything between the bookends, in execution order. May be empty. */
  readonly stages: readonly Stop<TMeta>[];
  /** The `'end'` bookend — the only stop that folds the whole log. */
  readonly end: Stop<TMeta>;
}

/**
 * What {@link splitAxis} answers when there is no bookended axis to split.
 *
 * - `'empty'` — no stops at all. The log itself was empty; a truthful axis
 *   with nowhere to stand, NOT a broken one.
 * - `'not-bookended'` — stops exist but the first is not a `'start'` or the
 *   last is not an `'end'`. Only a strategy can cause this; a run cannot.
 */
export type AxisRefusal = 'empty' | 'not-bookended';

/** The result of {@link splitAxis}: the axis, or why there is none. */
export type AxisSplit<TMeta = unknown> =
  | ({ readonly ok: true } & BookendedAxis<TMeta>)
  | {
      readonly ok: false;
      readonly reason: AxisRefusal;
      /** The kinds that were actually there — what to print in the refusal. */
      readonly kinds: readonly StopKind[];
    };

// ── The fold result ────────────────────────────────────────────────────────

/**
 * How a folded state was derived — the honesty field.
 *
 * - `'initial+log'` — folded from the run's real fold base. Complete.
 * - `'log-only'` — no `initialState` travelled with this log (a snapshot
 *   stored before 9.17, or a hand-built log), so the fold started from `{}`.
 *   Anything seeded before the run and only ever MERGED afterwards is missing.
 *   A partial answer that says it is partial, never a silent one.
 */
export type FoldBasis = 'initial+log' | 'log-only';

/** A detached fold of the log up to one stop. */
export interface FoldedState {
  /** The state, deeply frozen and fully detached from the engine. */
  readonly state: Record<string, unknown>;
  /** How it was derived — see {@link FoldBasis}. */
  readonly basis: FoldBasis;
  /**
   * `true` when any commit folded in declared redacted paths, so this state
   * carries `'REDACTED'` placeholders where the engine scrubbed values at
   * write time. The log is redacted where it was written; a fold must SAY so
   * rather than present a scrubbed value as the real one.
   */
  readonly redacted: boolean;
  /** The redacted paths seen across the folded prefix — sorted, deduped. */
  readonly redactedPaths: readonly string[];
  /** The last commit index folded in; `-1` when nothing was folded. */
  readonly throughCommitIdx: number;
  /**
   * Entries of the folded prefix that were not commit bundles, with the index
   * and the reason. ABSENT when nothing was skipped, which is every fold over
   * a live snapshot — a clean fold's shape is byte-identical to 9.17.0's.
   *
   * A gap contributes no state, so a fold that reports one is INCOMPLETE at
   * exactly the places it names.
   */
  readonly skipped?: readonly LogGap[];
  /**
   * Which source of a CHAIN this fold ended in — `throughCommitIdx` indexes
   * that source's log. Absent on a single-source cursor.
   */
  readonly sourceIdx?: number;
}

// ── Movement ───────────────────────────────────────────────────────────────

/**
 * Why a move did not happen.
 *
 * - `'clamped'` — the move would land OUTSIDE the axis (`prev()` at the first
 *   stop, `next()` at the last, a step number below 0 or past the end), or on
 *   the very stop the cursor already stands on. Either way nothing moved. When
 *   the target was out of range, `nearest` names the end that was hit — the
 *   cursor itself may be nowhere near it.
 * - `'miss'` — the target does not exist on this axis.
 * - `'empty'` — this cursor has no stops at all (an empty log).
 */
export type MoveRefusal = 'clamped' | 'miss' | 'empty';

/**
 * The result of asking the cursor to move.
 *
 * A refused move NEVER moves the cursor. That is the law a reader's UI rests
 * on: a mistyped id or a step past the end leaves the panel showing exactly
 * what it showed before, with a reason to display — never a silent jump to
 * somewhere the user did not ask for.
 */
export type Move<TMeta = unknown> =
  | { readonly moved: true; readonly from: Stop<TMeta> | undefined; readonly to: Stop<TMeta> }
  | {
      readonly moved: false;
      readonly reason: MoveRefusal;
      /** Where the cursor still is (absent only when there are no stops). */
      readonly at?: Stop<TMeta>;
      /** The closest stop to what was asked for, when one can be named. */
      readonly nearest?: Stop<TMeta>;
    };

// ── Marks ──────────────────────────────────────────────────────────────────

/**
 * A reader's bookmark. Lives BESIDE the log, in the {@link TimeTravel}
 * instance — never written into the commit log or the snapshot, which are the
 * run's record and not the reader's notes.
 *
 * A mark names its stop by `runtimeStageId`, not by step number: step numbers
 * belong to one strategy's axis, `runtimeStageId` is the same stage on every
 * axis, so a mark survives a change of strategy and a re-derivation of stops.
 */
export interface Mark {
  readonly name: string;
  readonly runtimeStageId: string;
  /** The step the mark was placed at, on the axis in force at the time. */
  readonly step: number;
}

// ── The strategy seam ──────────────────────────────────────────────────────

/**
 * How stops are DERIVED from a recorded log. The seam.
 *
 * footprintjs ships one strategy — `commitStops`, one stop per executed stage
 * — because that is the only stop grammar the substrate itself knows. A
 * consumer with a richer vocabulary (milestones, tool calls, turns) supplies
 * its own and gets the same cursor over it, and puts that vocabulary on
 * {@link Stop.meta} rather than re-deriving it at every read.
 *
 * The law a strategy must keep: stops are DERIVED FROM THE RECORDED LOG.
 * A strategy may group, filter, label and order what was recorded. It may not
 * re-walk the execution tree to synthesize a stop for something that was never
 * committed — a cursor that stops where no evidence exists is telling a story,
 * not reading one.
 *
 * ON A CHAIN, `stopsFor` is called ONCE PER SOURCE with that source's own log
 * and tree, and the cursor re-steps the results into one axis. So a strategy
 * never has to know it is part of a chain, and its `commitIdx`/`lastCommitIdx`
 * stay source-local — which is what they always were.
 */
export interface TimeTravelStrategy<TMeta = unknown> {
  stopsFor(commitLog: readonly CommitBundle[], executionTree?: StageSnapshot): Stop<TMeta>[];
}

// ── The cursor ─────────────────────────────────────────────────────────────

/**
 * A reader's cursor over one finished log, with a fold at each stop.
 *
 * ONE cursor: this object holds the only position. Every question a reader
 * asks — what changed here, what did state look like, what is inside this
 * mount — is answered relative to it. `drill()` returns a SEPARATE cursor over
 * a separate log (a subflow's own), never a second position on this one.
 */
export interface TimeTravel<TMeta = unknown> {
  /** The axis, in execution order. Empty when the log is empty. */
  readonly stops: readonly Stop<TMeta>[];
  /** The subflow path this cursor covers; `undefined` for the run itself. */
  readonly path: string | undefined;
  /**
   * The mount this cursor was drilled out of — `[subflowPath/]stageId#idx`.
   * `undefined` on a run's own cursor.
   *
   * WHY BOTH: a subflow mounted inside a loop runs several times, and every
   * iteration shares one {@link path}. This is the iteration that was actually
   * opened, so three drill panels over `sfx#2`, `sfx#8` and `sfx#14` can be
   * labelled and keyed apart instead of all reading `sfx`.
   */
  readonly mountRuntimeStageId: string | undefined;
  /** The cursor this one was drilled out of, if any. */
  readonly parent: TimeTravel<TMeta> | undefined;
  /**
   * How many SOURCES this cursor reads — `1` for a normal cursor, more for a
   * chained one (a pause/resume read as one axis). Every stop of a chained
   * cursor carries the {@link Stop.sourceIdx} its indices belong to.
   */
  readonly sourceCount: number;

  /** Where the cursor is; `undefined` only when there are no stops. */
  at(): Stop<TMeta> | undefined;

  first(): Move<TMeta>;
  last(): Move<TMeta>;
  prev(): Move<TMeta>;
  next(): Move<TMeta>;

  /**
   * Move to a step number or to a `runtimeStageId`.
   * A miss refuses and names the `nearest` stop it could find.
   */
  jumpTo(target: number | string): Move<TMeta>;

  /**
   * Fold of the log through `stop` (default: the current stop). Detached.
   *
   * `stop` must come from THIS cursor's axis: its `lastCommitIdx` and
   * `sourceIdx` are read as addresses into this cursor's own legs, so a stop
   * from another cursor is folded at whatever those numbers mean here — on a
   * chain, a foreign stop with no `sourceIdx` folds leg 0.
   */
  stateAt(stop?: Stop<TMeta>): FoldedState;

  /**
   * The state keys written between two stops — read straight off the bundles'
   * traces, so it costs no fold at all.
   *
   * With no argument: what the CURRENT stop changed (i.e. since the stop
   * before it). With a `from` stop: everything written after `from` up to and
   * including the current stop. Backwards or equal ranges give `[]`. On a
   * chained cursor a range that crosses the seam is walked source by source.
   */
  changedSince(from?: Stop<TMeta>): readonly string[];

  /** Bookmark a stop (default: the current one). Returns the mark, or
   *  `undefined` when there is no stop to name. */
  mark(name: string, stop?: Stop<TMeta>): Mark | undefined;
  /** A detached copy of this cursor's marks, in the order they were placed. */
  marks(): readonly Mark[];
  /** Move to a mark's stop. A mark whose stage is not on this axis misses. */
  jumpToMark(name: string): Move<TMeta>;

  /**
   * A cursor over the subflow mounted at `mountRuntimeStageId` — the same
   * interface, its own log, its own fold base. `undefined` when that mount is
   * not in this run's subflow results.
   *
   * A stop inside a subflow is NOT a stop of this cursor: subflows run in
   * isolated runtimes and commit to their own log, so the outer axis holds
   * only the mount boundary. Drilling is how you get inside; there is no way
   * to be in two places at once.
   */
  drill(mountRuntimeStageId: string): TimeTravel<TMeta> | undefined;
}

/** Options for {@link timeTravel}. */
export interface TimeTravelOptions<TMeta = unknown> {
  /** How stops are derived. Default: `commitStops`. */
  readonly strategy?: TimeTravelStrategy<TMeta>;
  /** Marks to seed the cursor with — e.g. restored from a saved session. */
  readonly marks?: readonly Mark[];
}
