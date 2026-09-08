/**
 * chain.ts — reading a pause/resume as ONE axis.
 *
 * WHY THIS FILE EXISTS. A pause and its resume produce TWO snapshots. On a
 * cross-executor resume (the checkpoint was persisted and a fresh executor
 * picked it up) the second run gets a fresh runtime: its `commitLog` starts at
 * index 0 and holds only the post-resume commits, and its `initialState` is
 * the state at the pause. Two logs, two disjoint axes — so a reader scrubbing
 * a resumed run saw only the second half unless the application had kept the
 * paused snapshot and stitched the halves itself. Every application that
 * pauses would write that stitching, and none of them own the arithmetic.
 *
 * THE HONEST BIT, up front: COMMIT INDICES ARE RUN-LOCAL. There is no global
 * index across a chain and this file does not invent one — `commitIdx` and
 * `lastCommitIdx` keep indexing their own source, and every stop carries the
 * {@link Stop.sourceIdx} they belong to. The cursor's STEPS are what run
 * across the whole chain.
 *
 * AND THE REFUSAL: a chain that is not ordered, or whose legs are not from one
 * lineage, is REFUSED rather than guessed at. The record carries TWO signals
 * and this file reads both:
 *
 * - The execution index the engine stamps into every `runtimeStageId` —
 *   globally monotonic per run and, deliberately, NOT reset on resume. So a
 *   later leg's first execution index must be past the earlier leg's last, and
 *   no stage may appear in two legs. This catches a backwards chain, a fresh
 *   run (which restarts at 0) and a same-executor resume (whose one snapshot
 *   already holds both halves).
 * - The later leg's `initialState`. On a resume the fresh runtime is seeded
 *   from the checkpoint, so that base IS the state at the pause — and the
 *   state the earlier legs FOLD TO must deep-equal it. This is what catches a
 *   leg from some OTHER lineage whose indices merely happen to be higher: the
 *   counters line up by accident, the state never does.
 *
 * A chart identity or a lineage id is NOT on the record, so nothing here
 * pretends to check one. And where the state signal is not on the record
 * either — a leg recorded before 9.17 carries no `initialState`; an earlier
 * leg with no base folds `'log-only'`; a leg with unreadable rows folds an
 * incomplete state — that check is SKIPPED, not faked: the chain then rests on
 * the index checks alone, and every fold's `basis` still says what it stood
 * on. That degradation is documented on `refuseChain`, on `timeTravel`'s
 * `@throws`, and in the README.
 */

import { parseRuntimeStageId } from '../engine/runtimeStageId.js';
import type { CommitBundle } from '../memory/types.js';
import { DELIM } from '../memory/utils.js';
import { type ReadSource, foldLegs } from './stateAt.js';
import type { TimeTravelSource } from './types.js';

/** One leg of a chain: a source, its read log, and where it sits in the run. */
export interface ChainLeg {
  readonly source: TimeTravelSource;
  readonly log: readonly CommitBundle[];
  /** Lowest execution index stamped in this leg; `undefined` for an id-less log. */
  readonly firstExecutionIndex: number | undefined;
  /** Highest execution index stamped in this leg. */
  readonly lastExecutionIndex: number | undefined;
}

/** The execution-index span of one leg, read off its `runtimeStageId`s. */
export function spanOf(log: readonly CommitBundle[]): {
  first: number | undefined;
  last: number | undefined;
  ids: Set<string>;
} {
  let first: number | undefined;
  let last: number | undefined;
  const ids = new Set<string>();
  for (const bundle of log) {
    const id = bundle.runtimeStageId;
    if (!id) continue;
    ids.add(id);
    const { executionIndex } = parseRuntimeStageId(id);
    if (Number.isNaN(executionIndex)) continue;
    if (first === undefined || executionIndex < first) first = executionIndex;
    if (last === undefined || executionIndex > last) last = executionIndex;
  }
  return { first, last, ids };
}

/**
 * Structural equality of two folded states, ignoring the paths the log was
 * redacted at.
 *
 * The fold reproduces `'REDACTED'` wherever the engine scrubbed a write, while
 * the checkpoint that seeded the resumed leg holds the real value — so those
 * paths CANNOT agree, and are not asked to. Everything else must: same keys
 * (a key holding `undefined` counts as absent, as it does through JSON), same
 * array lengths, same leaves by `Object.is`, Dates by their instant. Values
 * are whatever survived `structuredClone`, which is the library's own law on
 * state values.
 */
function sameState(a: unknown, b: unknown, redacted: ReadonlySet<string>, path: string): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (a instanceof Map || b instanceof Map || a instanceof Set || b instanceof Set) {
    if (!(a instanceof Map && b instanceof Map) && !(a instanceof Set && b instanceof Set)) return false;
    return sameState([...a.entries()], [...b.entries()], redacted, path);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => sameState(item, b[i], redacted, path === '' ? String(i) : `${path}${DELIM}${i}`));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const present = (o: Record<string, unknown>) => Object.keys(o).filter((k) => o[k] !== undefined);
  const leftKeys = present(left);
  const rightKeys = new Set(present(right));
  if (leftKeys.length !== rightKeys.size || !leftKeys.every((k) => rightKeys.has(k))) return false;
  return leftKeys.every((k) => {
    const childPath = path === '' ? k : `${path}${DELIM}${k}`;
    return redacted.has(childPath) || sameState(left[k], right[k], redacted, childPath);
  });
}

/**
 * Check that `legs` really are one run read in order, and say why not.
 *
 * Returns the refusal message, or `undefined` when the chain is sound. Three
 * distinct failures, because they are three different mistakes, checked in
 * this order:
 *
 * - REPEATED STAGE — one `runtimeStageId` appears in two legs. Ids are unique
 *   within a run, so a repeat means the same execution was recorded twice: a
 *   same-executor resume, whose snapshot ALREADY holds the whole log and needs
 *   no chaining, is the usual cause.
 * - OUT OF ORDER — a later leg's first execution index is not past the earlier
 *   leg's last. Either the sources were handed over backwards, or the second
 *   is not a continuation at all (a fresh run restarts the counter at 0, so an
 *   unrelated snapshot fails here rather than silently interleaving).
 * - WRONG LINEAGE — leg k's `initialState` is not the state legs 0..k-1 fold
 *   to. On a resume the later leg is seeded from the checkpoint, so its base
 *   IS the state at the pause; a leg that begins anywhere else is from some
 *   other run, however its indices happen to line up.
 *
 * THE LINEAGE CHECK RUNS ONLY WHERE THE RECORD ALLOWS IT, and is skipped —
 * never faked — otherwise: leg k must carry an `initialState` (a recording
 * made before 9.17 has none), and the fold of the legs before it must stand on
 * a real base (`basis: 'initial+log'`) with no unreadable rows (`skipped`
 * absent) — a log-only or gapped fold is not a state a real base may be held
 * against. On such a chain the two index checks are the whole defence, and
 * `foldLegs`' leg rule then CONTINUES the fold across the seam, which is the
 * right state for a real resume and is what `basis` reports. Paths the log
 * was redacted at are excluded from the comparison: the fold holds
 * `'REDACTED'` there and the checkpoint holds the value.
 */
export function refuseChain(legs: readonly ReadSource[]): string | undefined {
  if (legs.length === 0) return 'timeTravel: a chain needs at least one source, got an empty array.';

  const spans = legs.map((leg) => spanOf(leg.log));
  const seen = new Map<string, number>();
  for (const [i, span] of spans.entries()) {
    for (const id of span.ids) {
      const earlier = seen.get(id);
      if (earlier !== undefined) {
        return (
          `timeTravel: sources ${earlier} and ${i} both record '${id}'. A runtimeStageId is unique ` +
          'within a run, so these are not two legs of one run — a same-executor resume already ' +
          'carries the whole log in ONE snapshot and must not be chained with the paused one.'
        );
      }
      seen.set(id, i);
    }
  }

  let previous: { idx: number; last: number } | undefined;
  for (const [i, span] of spans.entries()) {
    if (span.first === undefined || span.last === undefined) continue;
    if (previous && span.first <= previous.last) {
      return (
        `timeTravel: source ${i} starts at execution index ${span.first}, which is not past ` +
        `source ${previous.idx}'s last (${previous.last}). Chain the sources in run order, and ` +
        'only sources from ONE lineage — the engine never resets the execution counter across a ' +
        'resume, so a fresh run restarting at 0 is a different run, not a continuation.'
      );
    }
    previous = { idx: i, last: span.last };
  }

  for (let k = 1; k < legs.length; k++) {
    const base = legs[k].base;
    if (!base || typeof base !== 'object') continue; // no signal on the record — documented degradation
    const before = foldLegs(legs, k - 1, Number.POSITIVE_INFINITY);
    if (before.basis !== 'initial+log' || before.skipped) continue; // not a state a real base can be held to
    if (!sameState(before.state, base, new Set(before.redactedPaths), '')) {
      return (
        `timeTravel: source ${k}'s initialState is not the state source ${k - 1} folds to. On a resume ` +
        "the later leg's initialState IS the state at the pause, so a leg that begins anywhere else is " +
        'not from one lineage — a different chart, or another run of this one — even when its execution ' +
        'indices happen to be higher.'
      );
    }
  }
  return undefined;
}
