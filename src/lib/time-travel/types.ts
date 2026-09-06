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
 */
export type FoldSource =
  | {
      readonly commitLog: readonly CommitBundle[];
      readonly initialState?: Record<string, unknown>;
    }
  | {
      readonly history?: readonly unknown[];
      readonly initialState?: Record<string, unknown>;
    };

/** A snapshot-shaped source for {@link timeTravel}. */
export interface TimeTravelSource {
  readonly commitLog?: readonly CommitBundle[];
  readonly history?: readonly unknown[];
  readonly initialState?: Record<string, unknown>;
  readonly executionTree?: StageSnapshot;
  /**
   * Dual-keyed subflow results (`getSnapshot().subflowResults`) — what
   * {@link TimeTravel.drill} navigates. Absent ⇒ `drill` always returns
   * `undefined`, which is the honest answer for a run with no subflows.
   */
  readonly subflowResults?: Record<string, unknown>;
}

// ── Stops ──────────────────────────────────────────────────────────────────

/**
 * What kind of position a stop is.
 *
 * - `'commit'` — one executed stage.
 * - `'mount'`  — a subflow mount: the boundary whose inner stages live in the
 *   subflow's OWN log (drill into it with {@link TimeTravel.drill}).
 * - `'start'`  — the bookend BEFORE the first stage ran. Its state is the fold
 *   base, which no commit index can otherwise reach — plus any id-less
 *   leading commit, which is how a subflow's `inputMapper` seed reaches the
 *   log. So on a drilled cursor, `'start'` is exactly "the input this subflow
 *   began with".
 * - `'end'`    — the bookend after the last commit: "the run is over". Its
 *   fold equals the final stage's by construction; the two are different
 *   questions, not a duplicated answer.
 */
export type StopKind = 'commit' | 'mount' | 'start' | 'end';

/** One position a reader's cursor can rest at. */
export interface Stop {
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
   */
  readonly commitIdx: number;
  /**
   * ARRAY INDEX of the LAST commit bundle folded at this stop — the end of
   * this stop's slice of the log. Stops PARTITION the log, so this is the
   * index just before the next stop begins; it is greater than
   * {@link commitIdx} whenever a stage committed more than one bundle (a
   * subflow mount's output-mapping + exit pair, a fork child's empty repeat).
   * Folding through this index — not through `commitIdx` — is what makes
   * `stateAt(stop)` equal the state the next stage started from.
   */
  readonly lastCommitIdx: number;
  /** Stable stage id from the builder (the post-mount, prefixed form). */
  readonly stageId: string;
  /** Subflow path this stage ran under, when it ran inside one. */
  readonly subflowPath?: string;
  /** Human-readable stage name — what a UI puts on the axis tick. */
  readonly label: string;
  readonly kind: StopKind;
}

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
export type Move =
  | { readonly moved: true; readonly from: Stop | undefined; readonly to: Stop }
  | {
      readonly moved: false;
      readonly reason: MoveRefusal;
      /** Where the cursor still is (absent only when there are no stops). */
      readonly at?: Stop;
      /** The closest stop to what was asked for, when one can be named. */
      readonly nearest?: Stop;
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
 * its own and gets the same cursor over it.
 *
 * The law a strategy must keep: stops are DERIVED FROM THE RECORDED LOG.
 * A strategy may group, filter, label and order what was recorded. It may not
 * re-walk the execution tree to synthesize a stop for something that was never
 * committed — a cursor that stops where no evidence exists is telling a story,
 * not reading one.
 */
export interface TimeTravelStrategy {
  stopsFor(commitLog: readonly CommitBundle[], executionTree?: StageSnapshot): Stop[];
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
export interface TimeTravel {
  /** The axis, in execution order. Empty when the log is empty. */
  readonly stops: readonly Stop[];
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
  readonly parent: TimeTravel | undefined;

  /** Where the cursor is; `undefined` only when there are no stops. */
  at(): Stop | undefined;

  first(): Move;
  last(): Move;
  prev(): Move;
  next(): Move;

  /**
   * Move to a step number or to a `runtimeStageId`.
   * A miss refuses and names the `nearest` stop it could find.
   */
  jumpTo(target: number | string): Move;

  /** Fold of the log through `stop` (default: the current stop). Detached. */
  stateAt(stop?: Stop): FoldedState;

  /**
   * The state keys written between two stops — read straight off the bundles'
   * traces, so it costs no fold at all.
   *
   * With no argument: what the CURRENT stop changed (i.e. since the stop
   * before it). With a `from` stop: everything written after `from` up to and
   * including the current stop. Backwards or equal ranges give `[]`.
   */
  changedSince(from?: Stop): readonly string[];

  /** Bookmark a stop (default: the current one). Returns the mark, or
   *  `undefined` when there is no stop to name. */
  mark(name: string, stop?: Stop): Mark | undefined;
  /** A detached copy of this cursor's marks, in the order they were placed. */
  marks(): readonly Mark[];
  /** Move to a mark's stop. A mark whose stage is not on this axis misses. */
  jumpToMark(name: string): Move;

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
  drill(mountRuntimeStageId: string): TimeTravel | undefined;
}

/** Options for {@link timeTravel}. */
export interface TimeTravelOptions {
  /** How stops are derived. Default: `commitStops`. */
  readonly strategy?: TimeTravelStrategy;
  /** Marks to seed the cursor with — e.g. restored from a saved session. */
  readonly marks?: readonly Mark[];
}
