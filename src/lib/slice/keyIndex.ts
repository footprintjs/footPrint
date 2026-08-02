/**
 * slice/keyIndex.ts — the one pass over the log both FORWARD queries share.
 *
 * WHY it exists: a backward slice only ever asks "who wrote key k before
 * idx i" — `findLastWriter` answers that with a backward scan. A forward
 * query asks the opposite, and the opposite is not symmetric: reads are NOT
 * in the commit log, and `KeysReadSource` is a LOOKUP (runtimeStageId →
 * keys), not an enumerable collection. So "who read k" cannot be looked up —
 * it has to be inverted.
 *
 * THE INVERSION (and the law it rests on): the engine commits exactly ONE
 * bundle per executed stage, so the commit log IS the list of execution
 * steps. Calling the reads lookup once per bundle turns the strategy into a
 * key → [commit indices that read it] index — and gives every read moment a
 * commit position, the join key the whole library is addressed by.
 *
 * Consequence worth stating (documented, not silently absorbed): a reads
 * provider naming a step that has no commit in THIS log contributes nothing.
 * That is the same log↔reads pairing law the backward side has — a subflow
 * runs in an isolated runtime, so its log and its tree must come from the
 * same scope (see README.md § Subflow boundaries).
 *
 * Cost: one lookup call per bundle, once per query — O(N + total read keys).
 * Both forward queries then run off sorted index arrays.
 *
 * DAG position: internal to slice/ (not exported from the barrel).
 */

import type { KeysReadLookup } from '../memory/backtrack.js';
import type { CommitBundle, TraceEntry } from '../memory/types.js';
import type { HonestyNote } from './types.js';

/** How many known keys an unknown-key refusal lists before it says "+N more". */
export const KNOWN_KEYS_LISTED = 10;

/** The inverted view of one commit log + its reads provider. */
export interface KeyIndex {
  /** key → commit ARRAY positions that WROTE it, ascending. */
  writesByKey: Map<string, number[]>;
  /** key → commit ARRAY positions whose stage READ it, ascending. */
  readsByKey: Map<string, number[]>;
  /** Every key this log knows: written ∪ recorded-read. */
  knownKeys: Set<string>;
}

/** Push into a Map<string, number[]>, creating the bucket on first touch. */
function push(map: Map<string, number[]>, key: string, idx: number): void {
  const arr = map.get(key);
  if (arr) arr.push(idx);
  else map.set(key, [idx]);
}

/**
 * Build the index. Indices go in ascending order by construction (we iterate
 * the log forwards), which is what lets every range query below be a pair of
 * binary searches instead of a scan.
 */
export function buildKeyIndex(commitLog: CommitBundle[], lookup: KeysReadLookup): KeyIndex {
  const writesByKey = new Map<string, number[]>();
  const readsByKey = new Map<string, number[]>();
  for (let i = 0; i < commitLog.length; i++) {
    const bundle = commitLog[i];
    for (const t of bundle.trace) {
      // Full mode may record several ops on one path in one commit — one
      // index per PATH per commit is what a life-range query needs.
      const arr = writesByKey.get(t.path);
      if (arr) {
        if (arr[arr.length - 1] !== i) arr.push(i);
      } else writesByKey.set(t.path, [i]);
    }
    // Reads: one lookup per execution step (see THE INVERSION above).
    // A provider that throws is a consumer bug, not a reason to lose the
    // query — the same error-isolation posture recorder callbacks get.
    let keys: string[] = [];
    try {
      keys = lookup(bundle.runtimeStageId) ?? [];
    } catch {
      /* provider threw — treat this step as "no recorded reads" */
    }
    for (const k of new Set(keys)) push(readsByKey, k, i);
  }
  const knownKeys = new Set<string>([...writesByKey.keys(), ...readsByKey.keys()]);
  return { writesByKey, readsByKey, knownKeys };
}

/**
 * LAW — an unknown key is NAMED as unknown; it never renders as "no history".
 *
 * The failure this prevents: `forwardSliceForKey(log, 'recipId')` (typo) must
 * not come back looking like a real variable that nothing happened to. The
 * answer says so out loud AND lists the keys the log does know — bounded, so
 * a 400-key agent state is a hint, not a wall.
 *
 * Why a NOTE and not a throw: the module's absence convention is a RESULT,
 * not an exception (`VariableSlice.missing`) — one absence vocabulary across
 * both doors. The loudness comes from the note + `missing: 'never-written'`,
 * not from a stack trace a triage tool would have to catch.
 */
export function unknownKeyNote(index: KeyIndex, key: string): HonestyNote {
  const all = [...index.knownKeys].sort();
  const shown = all.slice(0, KNOWN_KEYS_LISTED);
  const more = all.length - shown.length;
  const known = shown.length > 0 ? `${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}` : '(none)';
  return {
    code: 'unknown-key',
    detail:
      `unknown key '${key}' — this commit log has no write and no recorded read of it. ` +
      `Known keys: ${known}. ` +
      'If the key is real, check that the commit log and the reads provider come from the SAME scope ' +
      '(a subflow has its own).',
  };
}

/**
 * Does this log carry ANY recorded read? The provider-agnostic version of
 * `ReadsCoverage.stepsWithReads > 0` (map / custom-fn strategies carry no
 * coverage), and the switch that decides whether "nobody read it" is a
 * FINDING or a BLIND SPOT.
 */
export function hasRecordedReads(index: KeyIndex): boolean {
  return index.readsByKey.size > 0;
}

/** First position in the ascending array holding a value >= `value`. */
function lowerBound(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Ascending indices in the INCLUSIVE range [from, to]. `to === undefined`
 * means "to the end of the log".
 */
export function indicesInRange(sorted: number[] | undefined, from: number, to?: number): number[] {
  if (!sorted || sorted.length === 0) return [];
  const start = lowerBound(sorted, from);
  const end = to === undefined ? sorted.length : lowerBound(sorted, to + 1);
  return sorted.slice(start, end);
}

/** The largest index in the ascending array that is < `before`, or undefined. */
export function lastIndexBefore(sorted: number[] | undefined, before?: number): number | undefined {
  if (!sorted || sorted.length === 0) return undefined;
  const end = before === undefined ? sorted.length : lowerBound(sorted, before);
  return end > 0 ? sorted[end - 1] : undefined;
}

/** The smallest index in the ascending array that is > `after`, or undefined. */
export function firstIndexAfter(sorted: number[] | undefined, after: number): number | undefined {
  if (!sorted || sorted.length === 0) return undefined;
  const at = lowerBound(sorted, after + 1);
  return at < sorted.length ? sorted[at] : undefined;
}

/**
 * The LAST trace entry for `path` in a bundle — the one that decides both the
 * committed verb and (under the writeProvenance dial) the widest read prefix.
 * Full mode can record several ops on one path in one commit; read prefixes
 * only grow during a stage, so the last entry is the honest one to attribute
 * with.
 */
export function lastTraceEntry(bundle: CommitBundle, path: string): TraceEntry | undefined {
  for (let i = bundle.trace.length - 1; i >= 0; i--) {
    if (bundle.trace[i].path === path) return bundle.trace[i];
  }
  return undefined;
}

// ── Shared honesty notes (one sentence per code, one place) ───────────────
//
// LAW: every forward answer states what it could not see, in the SAME words
// whichever query produced it. Codes are what a consumer branches on; the
// detail is what a human or an LLM reads.

/** The `readTracking: 'off'` signature — see the HonestyNoteCode docs. */
export function readsNotRecordedNote(): HonestyNote {
  return {
    code: 'reads-not-recorded',
    detail:
      "reads were not recorded (readTracking may be 'off') — 'nothing read this value' is " +
      'UNKNOWABLE here, not true.',
  };
}

/** The value predates every write this log can see. */
export function preRunOriginNote(key: string): HonestyNote {
  return {
    code: 'pre-run-origin',
    detail:
      `'${key}' has no write before this point — the value came from initial state, frozen run input ` +
      '(args), or a closure. The reads listed did see it; who put it there is outside the commit log.',
  };
}

/** At least one fed edge rests on stage-level co-occurrence only. */
export function conservativeEdgesNote(key: string): HonestyNote {
  return {
    code: 'conservative-fed-edges',
    detail:
      "some 'fed' edges are CONSERVATIVE (stage-level): those writes carry no per-write read provenance, " +
      `so a stage that read '${key}' and wrote another key may not actually have used it. Run with ` +
      "writeProvenance: 'reads-prefix' to get exact edges.",
  };
}

/** A budget cut the walk — stated, never silent. */
export function truncatedNote(byDepth: boolean, byNodes: boolean): HonestyNote {
  const causes = [byDepth && 'maxDepth reached', byNodes && 'maxNodes reached'].filter(Boolean).join(', ');
  return {
    code: 'truncated',
    detail: `walk truncated (${causes}) — more consumers of this value exist beyond this horizon.`,
  };
}

/** Distinct written paths of a bundle, in first-touch order. */
export function writtenPaths(bundle: CommitBundle): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of bundle.trace) {
    if (!seen.has(t.path)) {
      seen.add(t.path);
      out.push(t.path);
    }
  }
  return out;
}
