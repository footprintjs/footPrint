/**
 * slice/elementProvenance.ts — APPEND-FOLD PROVENANCE.
 *
 * THE PROBLEM (why this file exists): in agent charts, almost all dataflow
 * funnels through ONE array key (`history`). A key-level slice on it
 * degenerates to "everything depends on history" — true and useless. The
 * question that actually triages an agent run is element-level:
 * "which stage produced history[7]?".
 *
 * THE INSIGHT: the commit log already contains the answer. Under
 * `commitValues: 'delta'` every array growth is recorded as an `append` verb
 * whose `overwrite[key]` holds exactly the new tail — each element has an
 * explicit birth record. Under `'full'` mode, push-style growth appears as
 * consecutive `set`s where the previous array is a strict prefix of the next
 * — the tail is attributable by inference. No new capture is needed; this is
 * a pure post-hoc query.
 *
 * THE ALGORITHM (append-fold): WATCH the per-key verb fold — the SAME fold
 * `commitValueAt` runs (`memory/verbs.ts` · `foldKey`: one step, `applyVerb`,
 * for every verb; this file has no verb switch of its own) — while carrying a
 * births array kept index-aligned with the value. The observer is told, after
 * each row on, inside or around the key, the value at the key before it and
 * after it, and keeps the births — for the commits that WROTE the key under
 * the writer rule (`commitLogUtils · writersOf`; since 9.33.0 a write inside
 * the key or around it counts, as it does for every key query): a row that
 * records only its tail (`append`) earns an exact attribution; every other row
 * is a whole-value transition attributed by inference. One difference from
 * `commitValueAt`: that helper ANCHORS at the latest `set`/`delete` as a skip
 * optimization (earlier commits cannot change the final VALUE). Provenance
 * must fold from the FIRST touch, because full-mode growth is a chain of
 * `set`s and the anchor would erase every birth but the last. The final value
 * is identical either way (the fold is deterministic left-to-right) — a
 * property test pins this equivalence.
 *
 * INVARIANT (maintained on every branch): when the folded value is an array,
 * `births.length === value.length` and `births[i]` describes `value[i]`.
 *
 * HONESTY: every birth is labeled with how it was determined
 * ({@link AttributionBasis}) — `'append-verb'` is engine-recorded truth,
 * `'prefix-inference'` is a heuristic (a wholesale replacement that happens
 * to share the old prefix is indistinguishable from an append), and
 * `'whole-value'` is an explicit reset. Absence is honest too: a missing
 * provenance carries a {@link MissingProvenanceReason}, mirroring
 * `VariableSlice.missing` — one absence pattern module-wide.
 *
 * COMPLEXITY: delta-mode logs need no equality checks — O(total elements).
 * Full-mode logs pay a strict-prefix check (deepEqual per element) per
 * full-value touch: O(touches × length) element comparisons worst case.
 * Post-hoc query, off the hot path — acceptable; measured in the perf tests.
 */

import { rowsUnderRoot, writersOf } from '../memory/commitLogUtils.js';
import type { CommitBundle } from '../memory/types.js';
import { deepEqual, DELIM } from '../memory/utils.js';
import { type Touch, foldKey, recordsTail } from '../memory/verbs.js';
import { normaliseStateKey } from './sliceForKey.js';
import type { ArrayProvenance, AttributionBasis, ElementBirth, StateKey } from './types.js';

/** `prev` is a strict (leading, element-equal) prefix of `next`. */
function isStrictPrefix(prev: unknown[], next: unknown[]): boolean {
  if (prev.length > next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (!deepEqual(prev[i], next[i])) return false;
  }
  return true;
}

function birthOf(index: number, touch: Touch, basis: AttributionBasis, value: unknown): ElementBirth {
  return {
    index,
    commitIdx: touch.commitIdx,
    runtimeStageId: touch.bundle.runtimeStageId,
    stageId: touch.bundle.stageId,
    stageName: touch.bundle.stage,
    verb: touch.verb,
    basis,
    value,
  };
}

/**
 * Element-level provenance for one array-valued key: fold the key's commits
 * and return index-aligned birth records for every element.
 *
 * @param key A {@link StateKey}: the top-level key string, or a path array
 *   for nested keys (normalised internally — no engine delimiters needed).
 * @param options.atIdx Inclusive commit array index to fold to (default: the
 *   whole log). NOT the executionIndex from a runtimeStageId.
 * @returns Always an {@link ArrayProvenance}; on failure `missing` says why
 *   (`'not-an-array'` for scalar/deleted/degraded keys — those are
 *   `sliceForKey` territory). Blind spot shared with the whole commit-log
 *   family: elements present in the run's INITIAL state (seeded, never
 *   re-set in range) are invisible here.
 */
export function arrayProvenance(
  commitLog: CommitBundle[],
  key: StateKey,
  options?: { atIdx?: number },
): ArrayProvenance {
  const normalisedKey = normaliseStateKey(key);
  if (commitLog.length === 0) return { key: normalisedKey, missing: 'empty-log' };
  const end = Math.min(options?.atIdx ?? commitLog.length - 1, commitLog.length - 1);
  const segs = normalisedKey.split(DELIM);

  // Every row under the key's top-level key up to `end`, in commit order — the
  // rows commitValueAt folds (refusing a verb the law does not know), with the
  // commit position the birth records need.
  const rows = rowsUnderRoot(commitLog, normalisedKey, end);
  // The commits that WROTE the key — the writer rule every key query shares.
  const writers = new Set(writersOf(commitLog, normalisedKey, { end }));
  if (writers.size === 0) return { key: normalisedKey, missing: 'never-written' };

  // The append-fold: the key's one fold, watched. `births` is the added
  // provenance track, index-aligned whenever the value is an array (the
  // module invariant). A row of a commit that did not write the key (a merge
  // around it that never reached it) moves no birth.
  let births: ElementBirth[] = [];
  const value = foldKey(rows, segs, {
    observe: (touch, before, after) => {
      if (writers.has(touch.commitIdx)) births = nextBirths(births, touch, before, after);
    },
  });

  if (!Array.isArray(value)) return { key: normalisedKey, missing: 'not-an-array' };
  return { key: normalisedKey, atIdx: end, length: value.length, births };
}

/**
 * The births after one row of the fold, from the value before it and after it.
 *
 * A row that records only its TAIL (`append`) knows exactly what it added —
 * `'append-verb'`, no equality checks, O(tail). Every other row — a `set`, a
 * `merge`, a `delete` — is a whole-value transition: attributed by inference
 * ({@link rebaseBirths}), and a non-array result (a `delete` leaves none) ends
 * the track.
 */
function nextBirths(births: ElementBirth[], touch: Touch, before: unknown, after: unknown): ElementBirth[] {
  // An `append` records the tail of ITS OWN path. On a container around the key (or a path inside it) the
  // key's value changed wholesale — `append a` with a non-array tail replaces `a`, and `a␟b` with it — so
  // only an append ON the key earns exact tail attribution.
  if (!recordsTail(touch.verb) || touch.relation !== 'exact') {
    return rebaseBirths(before, after, births, touch, 'prefix-inference');
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    // The step extended the array: the elements past the old length are the
    // recorded tail — exact attribution.
    for (let j = before.length; j < after.length; j++) {
      births.push(birthOf(j, touch, 'append-verb', after[j]));
    }
    return births;
  }
  // Degenerate append: onto a non-array, or a non-array tail (e.g. a redacted
  // tail replaced by the 'REDACTED' string). The tail BECAME the value —
  // the step's own rule — and attribution stays exact.
  return Array.isArray(after) ? after.map((el, j) => birthOf(j, touch, 'append-verb', el)) : [];
}

/**
 * Re-derive births after a full-value transition (`set`/`merge`):
 * - non-array result → no births (invariant: births track arrays only)
 * - previous array is a strict prefix → keep old births, attribute the tail
 *   to this touch with the given (heuristic) basis
 * - otherwise → wholesale replacement: every element reborn 'whole-value'
 */
function rebaseBirths(
  prev: unknown,
  next: unknown,
  births: ElementBirth[],
  touch: Touch,
  tailBasis: AttributionBasis,
): ElementBirth[] {
  if (!Array.isArray(next)) return [];
  if (Array.isArray(prev) && isStrictPrefix(prev, next)) {
    const kept = births.slice(0, prev.length);
    for (let i = prev.length; i < next.length; i++) {
      kept.push(birthOf(i, touch, tailBasis, next[i]));
    }
    return kept;
  }
  return next.map((el, i) => birthOf(i, touch, 'whole-value', el));
}

/**
 * Convenience over {@link arrayProvenance}: the birth of ONE element.
 * Returns `undefined` when the key has no array provenance (any
 * {@link MissingProvenanceReason}) or `index` is out of range at `atIdx` —
 * Map.get-like semantics; use {@link arrayProvenance} directly when you need
 * the missing reason.
 *
 * @see ElementBirth
 */
export function elementProvenance(
  commitLog: CommitBundle[],
  key: StateKey,
  index: number,
  options?: { atIdx?: number },
): ElementBirth | undefined {
  const prov = arrayProvenance(commitLog, key, options);
  if (!prov.births || index < 0 || index >= prov.births.length) return undefined;
  return prov.births[index];
}
