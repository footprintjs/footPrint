/**
 * slice/keyTimeline.ts — the whole life of ONE key, in commit order.
 *
 * The flat companion to {@link forwardSliceForKey}: no graph, no budgets,
 * no anchor — every write of the key and every recorded read of it, as one
 * chronological list. This is what a UI timeline row and an LLM's "walk me
 * through what happened to `total`" both want, and what makes a forward
 * slice checkable: the same facts, unfolded instead of walked.
 *
 * Every moment carries BOTH universal join keys — `runtimeStageId` (to
 * recorders, execution trees, UIs) and `commitIdx` (to the commit log).
 *
 * ### LAW — read attribution is the walk's, exactly
 *
 * A read moment's `fromWriteIdx` is the write whose live range it sits in:
 * the last write at a STRICTLY earlier commit index. That is the same
 * `(writeIdx, nextWriteIdx]` rule `forwardSliceForKey` walks (reads fire
 * PRE-commit), so the two doors can never disagree about which value a read
 * saw — pinned by a cross-door property test. A read before ANY write has no
 * `fromWriteIdx` and raises the `'pre-run-origin'` note: it saw initial
 * state, frozen run `input`, or a closure.
 *
 * DAG position: memory ← slice. Imports memory/ only (see README.md).
 */

import type { KeysReadLookup } from '../memory/backtrack.js';
import type { CommitBundle } from '../memory/types.js';
import {
  buildKeyIndex,
  hasRecordedReads,
  lastIndexBefore,
  lastTraceEntry,
  preRunOriginNote,
  readsNotRecordedNote,
  unknownKeyNote,
} from './keyIndex.js';
import { resolveKeysReadSource } from './keysReadSources.js';
import { normaliseStateKey } from './sliceForKey.js';
import type { HonestyNote, KeyMoment, KeysReadSource, KeyTimeline, StateKey } from './types.js';

/** Options for {@link keyTimeline}. */
export interface KeyTimelineOptions {
  /**
   * Exclusive commit-array-index upper bound: only moments BEFORE this idx.
   * Same word and semantics as `sliceForKey`'s `before` (note the sibling
   * `arrayProvenance` uses an INCLUSIVE `atIdx` — this family follows the
   * slice doors).
   */
  before?: number;
}

/**
 * The life of one key as a chronological list of writes and reads.
 *
 * @param commitLog Ordered commit bundles — `getSnapshot().commitLog`.
 * @param key A {@link StateKey} — normalised through the same
 *   `normaliseStateKey` both slice doors use.
 * @param keysRead A {@link KeysReadSource} or bare lookup (reads are not in
 *   the commit log).
 * @returns Always a {@link KeyTimeline}; absence carries its reason, and an
 *   unknown key is NAMED as unknown with a bounded list of known keys.
 */
export function keyTimeline(
  commitLog: CommitBundle[],
  key: StateKey,
  keysRead: KeysReadSource | KeysReadLookup,
  options?: KeyTimelineOptions,
): KeyTimeline {
  const source = resolveKeysReadSource(keysRead);
  const normalisedKey = normaliseStateKey(key);
  const base: Pick<KeyTimeline, 'key' | 'before' | 'keysReadKind' | 'readsCoverage'> = {
    key: normalisedKey,
    ...(options?.before !== undefined && { before: options.before }),
    keysReadKind: source.kind,
    ...(source.coverage !== undefined && { readsCoverage: source.coverage }),
  };

  if (commitLog.length === 0) return { ...base, missing: 'empty-log', notes: [] };

  const index = buildKeyIndex(commitLog, source.lookup);
  const readsRecorded = hasRecordedReads(index);
  const notes: HonestyNote[] = [];

  // Same typo guard as the forward walk — one rule, both doors.
  if (!index.knownKeys.has(normalisedKey)) {
    notes.push(unknownKeyNote(index, normalisedKey));
    if (readsRecorded) return { ...base, missing: 'never-written', notes };
  }
  if (!readsRecorded) notes.push(readsNotRecordedNote());

  const limit = options?.before ?? commitLog.length;
  const allWrites = index.writesByKey.get(normalisedKey) ?? [];
  const writes = allWrites.filter((i) => i < limit);
  const reads = (index.readsByKey.get(normalisedKey) ?? []).filter((i) => i < limit);

  // Merge two ascending index lists. At the SAME commit index a read comes
  // first: reads fire before their stage's commit (the engine's event order,
  // and the reason the live range is closed at the next write).
  const moments: KeyMoment[] = [];
  let w = 0;
  let r = 0;
  let sawPreRunRead = false;
  while (w < writes.length || r < reads.length) {
    const takeRead = r < reads.length && (w >= writes.length || reads[r] <= writes[w]);
    if (takeRead) {
      const idx = reads[r++];
      const bundle = commitLog[idx];
      // The live range this read sits in: the last write STRICTLY earlier.
      const fromWriteIdx = lastIndexBefore(allWrites, idx);
      if (fromWriteIdx === undefined) sawPreRunRead = true;
      moments.push({
        kind: 'read',
        commitIdx: idx,
        runtimeStageId: bundle.runtimeStageId,
        stageId: bundle.stageId,
        stageName: bundle.stage,
        ...(fromWriteIdx !== undefined && { fromWriteIdx }),
      });
    } else {
      const idx = writes[w++];
      const bundle = commitLog[idx];
      const entry = lastTraceEntry(bundle, normalisedKey);
      moments.push({
        kind: 'write',
        commitIdx: idx,
        runtimeStageId: bundle.runtimeStageId,
        stageId: bundle.stageId,
        stageName: bundle.stage,
        ...(entry !== undefined && { verb: entry.verb }),
      });
    }
  }

  if (sawPreRunRead) notes.push(preRunOriginNote(normalisedKey));
  return { ...base, moments, notes };
}
