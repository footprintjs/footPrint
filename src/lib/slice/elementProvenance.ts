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
 * THE ALGORITHM (append-fold): replay the per-key verb fold — the SAME fold
 * `commitValueAt` runs (set → replace, append → concat, merge → deepSmartMerge,
 * delete → clear) — while carrying a births array kept index-aligned with the
 * value. One difference from `commitValueAt`: that helper ANCHORS at the
 * latest `set`/`delete` as a skip optimization (earlier commits cannot change
 * the final VALUE). Provenance must fold from the FIRST touch, because
 * full-mode growth is a chain of `set`s and the anchor would erase every
 * birth but the last. The final value is identical either way (the fold is
 * deterministic left-to-right) — a property test pins this equivalence.
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

import { nativeGet } from '../memory/pathOps.js';
import type { CommitBundle, TraceEntry } from '../memory/types.js';
import { deepEqual, deepSmartMerge, DELIM } from '../memory/utils.js';
import { normaliseStateKey } from './sliceForKey.js';
import type { ArrayProvenance, AttributionBasis, ElementBirth, StateKey } from './types.js';

/** One per-key touch of the commit log, in commit order. */
interface KeyTouch {
  verb: TraceEntry['verb'];
  bundle: CommitBundle;
  /** Commit ARRAY position (== `bundle.idx` for engine-produced logs). */
  commitIdx: number;
}

/** `prev` is a strict (leading, element-equal) prefix of `next`. */
function isStrictPrefix(prev: unknown[], next: unknown[]): boolean {
  if (prev.length > next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (!deepEqual(prev[i], next[i])) return false;
  }
  return true;
}

function birthOf(index: number, touch: KeyTouch, basis: AttributionBasis, value: unknown): ElementBirth {
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

  // Collect every touch of the key up to `end`, in commit order — the same
  // scan commitValueAt does, plus the commit position for birth records.
  const touches: KeyTouch[] = [];
  for (let i = 0; i <= end; i++) {
    for (const t of commitLog[i].trace) {
      if (t.path === normalisedKey) touches.push({ verb: t.verb, bundle: commitLog[i], commitIdx: i });
    }
  }
  if (touches.length === 0) return { key: normalisedKey, missing: 'never-written' };

  // The append-fold. `value` mirrors commitValueAt's fold byte-for-byte;
  // `births` is the added provenance track, index-aligned whenever `value`
  // is an array (the module invariant).
  let value: unknown;
  let births: ElementBirth[] = [];

  for (const touch of touches) {
    const { verb, bundle } = touch;
    if (verb === 'set') {
      const next = structuredClone(nativeGet(bundle.overwrite, segs));
      births = rebaseBirths(value, next, births, touch, 'prefix-inference');
      value = next;
    } else if (verb === 'delete') {
      value = undefined;
      births = [];
    } else if (verb === 'append') {
      const tail = structuredClone(nativeGet(bundle.overwrite, segs));
      if (Array.isArray(value) && Array.isArray(tail)) {
        // Engine-recorded tail: exact attribution, no equality checks.
        for (let j = 0; j < tail.length; j++) {
          births.push(birthOf(value.length + j, touch, 'append-verb', tail[j]));
        }
        value = [...value, ...tail];
      } else {
        // Degenerate append onto a non-array, or a non-array tail (e.g. a
        // redacted tail replaced by the '[REDACTED]' string). Mirrors
        // commitValueAt: the tail BECOMES the value. Attribution stays exact.
        value = tail;
        births = Array.isArray(tail) ? tail.map((el, j) => birthOf(j, touch, 'append-verb', el)) : [];
      }
    } else {
      // 'merge' — deepSmartMerge (non-mutating: fresh array/object on every
      // path), then re-derive births from the shape change. Note merge's
      // array semantics are UNION-dedup: growth keeps the old prefix (tail
      // attributed by inference); a dedup-shrink is a wholesale rebirth.
      const next = deepSmartMerge(value, structuredClone(nativeGet(bundle.updates, segs)));
      births = rebaseBirths(value, next, births, touch, 'prefix-inference');
      value = next;
    }
  }

  if (!Array.isArray(value)) return { key: normalisedKey, missing: 'not-an-array' };
  return { key: normalisedKey, atIdx: end, length: value.length, births };
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
  touch: KeyTouch,
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
