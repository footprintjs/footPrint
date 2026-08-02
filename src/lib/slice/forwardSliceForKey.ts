/**
 * slice/forwardSliceForKey.ts — the FORWARD half of variable-first slicing.
 *
 * `sliceForKey` answers "why is `key` what it is?" by walking backward from
 * the value to its causes. This file answers the opposite question, which no
 * query answered before: **"who READ this value, and what did it FEED?"**
 * (the production shape: *who read `recipeId`, and what did it feed?* — one
 * query, not a manual scan of a trace viewer).
 *
 * ## The algorithm: LIVE RANGES, not steps
 *
 * A backward slice hops writer→writer. Forward, the unit is a value's LIFE:
 *
 * 1. Anchor at a write of `key` — the SAME anchor idiom as `sliceForKey`
 *    (the last writer, or the last writer before `before`).
 * 2. That value lives until the key's NEXT write (`nextWriteIdx`). Every
 *    stage that READ `key` inside that window saw THIS value — a `read`.
 * 3. A reading stage that also WROTE something carried the value onward —
 *    a `fed` edge to that write, which is itself the start of a new life.
 * 4. Descend into fed lives breadth-first (visited-set guarded, budgeted).
 *
 * ### LAW — the live range is `(writeIdx, nextWriteIdx]`
 *
 * Open at the bottom, CLOSED at the top, and both ends follow from the
 * engine's event order (`onRead` fires PRE-commit — see CLAUDE.md):
 * - a read by the writing stage itself (`readIdx === writeIdx`) saw the
 *   PREVIOUS value: read-modify-write reads belong to the previous life;
 * - a read by the OVERWRITING stage (`readIdx === nextWriteIdx`) also fired
 *   before its commit, so it still saw THIS value.
 * A read after that commit attributes to the NEW write, never the old one.
 * (Granularity limit, stated because it cannot be seen: a stage that writes
 * `key` and then re-reads it within the SAME stage read its own value; at
 * commit-index resolution that read is indistinguishable from the one that
 * opened the stage.)
 *
 * ### LAW — a `fed` edge is EXACT only under recorded read provenance
 *
 * With `writeProvenance: 'reads-prefix'` on, the child write's
 * `TraceEntry.readKeys` names the keys read before it: this key IN that list
 * is an exact edge (`basis: 'per-write'`), and this key ABSENT from it is an
 * exact *exclusion* — no edge at all. With the dial off there is no such
 * evidence, only "the stage read this and wrote that": the edge is stamped
 * `basis: 'stage'` and the slice carries a `'conservative-fed-edges'` note.
 * A conservative edge is never presented as an exact one.
 *
 * Budgets mirror `causalChain`'s (maxDepth 20, maxNodes 100) and a cut is
 * STATED — `root.truncated` plus a `'truncated'` note.
 *
 * DAG position: memory ← slice. Imports memory/ only (see README.md).
 */

import type { KeysReadLookup } from '../memory/backtrack.js';
import type { CommitBundle } from '../memory/types.js';
import { DELIM } from '../memory/utils.js';
import {
  type KeyIndex,
  buildKeyIndex,
  conservativeEdgesNote,
  firstIndexAfter,
  hasRecordedReads,
  indicesInRange,
  lastIndexBefore,
  lastTraceEntry,
  preRunOriginNote,
  readsNotRecordedNote,
  truncatedNote,
  unknownKeyNote,
  writtenPaths,
} from './keyIndex.js';
import { resolveKeysReadSource } from './keysReadSources.js';
import { normaliseStateKey } from './sliceForKey.js';
import type { FedBasis, ForwardNode, ForwardSlice, HonestyNote, KeysReadSource, StateKey } from './types.js';

/** Options for {@link forwardSliceForKey} — anchoring plus walk budgets. */
export interface ForwardSliceForKeyOptions {
  /**
   * Exclusive commit-array-index upper bound for the ANCHOR search: follow
   * the value as it stood BEFORE this idx. Same contract as
   * `sliceForKey`'s `before` / `findLastWriter`'s `beforeIdx`.
   *
   * It bounds the anchor ONLY — the walk then runs forward past it, because
   * "what did the value at step 12 go on to feed?" is the whole question.
   */
  before?: number;
  /** Maximum BFS depth in value-lives (default: 20 — causalChain's). */
  maxDepth?: number;
  /** Maximum total nodes (default: 100 — causalChain's). */
  maxNodes?: number;
}

/** Identity of one value life: (write position, key). Never parsed. */
function nodeKey(commitIdx: number | undefined, key: string): string {
  return `${commitIdx ?? 'pre-run'}${DELIM}${key}`;
}

/**
 * Build the node for ONE value life. `writeIdx === undefined` is the pre-run
 * origin: the value was already there before the log's first write of the
 * key, so the writer identity fields stay ABSENT rather than fabricated.
 */
function makeNode(
  commitLog: CommitBundle[],
  index: KeyIndex,
  key: string,
  writeIdx: number | undefined,
  depth: number,
): ForwardNode {
  const writes = index.writesByKey.get(key);
  if (writeIdx === undefined) {
    const firstWrite = writes?.[0];
    return {
      key,
      origin: 'pre-run',
      ...(firstWrite !== undefined && { nextWriteIdx: firstWrite }),
      depth,
      reads: [],
      fedEdges: [],
    };
  }
  const bundle = commitLog[writeIdx];
  const entry = lastTraceEntry(bundle, key);
  const next = firstIndexAfter(writes, writeIdx);
  return {
    key,
    origin: 'write',
    runtimeStageId: bundle.runtimeStageId,
    stageId: bundle.stageId,
    stageName: bundle.stage,
    commitIdx: writeIdx,
    ...(entry !== undefined && { verb: entry.verb }),
    ...(next !== undefined && { nextWriteIdx: next }),
    depth,
    reads: [],
    fedEdges: [],
    // Untracked-read honesty rides through from the bundle exactly as
    // causalChain stamps CausalNode.incompleteSources.
    ...(bundle.untrackedSources !== undefined &&
      bundle.untrackedSources.length > 0 && { incompleteSources: bundle.untrackedSources }),
  };
}

/**
 * Forward slice for one state key: who read this value, and what did it feed?
 *
 * @param commitLog Ordered commit bundles — `getSnapshot().commitLog`.
 * @param key A {@link StateKey}: the plain key string, or a path array
 *   (normalised through the SAME `normaliseStateKey` the backward door uses,
 *   so both doors accept identical inputs).
 * @param keysRead A {@link KeysReadSource} strategy or a bare lookup — the
 *   same reads providers `sliceForKey` takes. Reads are not in the commit
 *   log; without a provider a forward walk can see nothing, which the
 *   `'reads-not-recorded'` note says out loud.
 * @returns Always a {@link ForwardSlice}. Absence is a RESULT with a reason
 *   and, for an unknown key, a bounded list of the keys the log does know.
 */
export function forwardSliceForKey(
  commitLog: CommitBundle[],
  key: StateKey,
  keysRead: KeysReadSource | KeysReadLookup,
  options?: ForwardSliceForKeyOptions,
): ForwardSlice {
  const source = resolveKeysReadSource(keysRead);
  const normalisedKey = normaliseStateKey(key);
  const base: Pick<ForwardSlice, 'key' | 'before' | 'keysReadKind' | 'readsCoverage'> = {
    key: normalisedKey,
    ...(options?.before !== undefined && { before: options.before }),
    keysReadKind: source.kind,
    ...(source.coverage !== undefined && { readsCoverage: source.coverage }),
  };

  if (commitLog.length === 0) return { ...base, missing: 'empty-log', notes: [] };

  const index = buildKeyIndex(commitLog, source.lookup);
  const readsRecorded = hasRecordedReads(index);
  const notes: HonestyNote[] = [];

  // ── The typo guard, split by what the recording affords ────────────────
  // Unknown key + reads ARE recorded → the log can see readers and this key
  // has none: honest absence with a named reason, no fabricated life.
  // Unknown key + NO reads recorded → a typo and a seeded-but-unread key are
  // genuinely indistinguishable; the pre-run life below is the only honest
  // answer, and it must carry BOTH notes so nobody reads it as "unread".
  const known = index.knownKeys.has(normalisedKey);
  if (!known) {
    notes.push(unknownKeyNote(index, normalisedKey));
    if (readsRecorded) return { ...base, missing: 'never-written', notes };
  }
  if (!readsRecorded) notes.push(readsNotRecordedNote());

  const maxDepth = options?.maxDepth ?? 20;
  const maxNodes = options?.maxNodes ?? 100;

  const nodes = new Map<string, ForwardNode>();
  let created = 0;
  let truncatedByDepth = false;
  let truncatedByNodes = false;
  let anyConservative = false;

  const anchorIdx = lastIndexBefore(index.writesByKey.get(normalisedKey), options?.before);
  const root = makeNode(commitLog, index, normalisedKey, anchorIdx, 0);
  nodes.set(nodeKey(anchorIdx, normalisedKey), root);
  created = 1;

  const queue: ForwardNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    // Live range: open below the write, CLOSED at the next write (see LAW).
    const from = node.commitIdx !== undefined ? node.commitIdx + 1 : 0;
    const readers = indicesInRange(index.readsByKey.get(node.key), from, node.nextWriteIdx);

    if (node.depth >= maxDepth) {
      // Only a life that still HAD readers to expand counts as a cut.
      if (readers.length > 0) truncatedByDepth = true;
      continue;
    }

    for (const readerIdx of readers) {
      const bundle = commitLog[readerIdx];
      node.reads.push({
        runtimeStageId: bundle.runtimeStageId,
        stageId: bundle.stageId,
        stageName: bundle.stage,
        commitIdx: readerIdx,
      });

      // The reader IS the writer of everything it committed — each written
      // path is a candidate `fed` edge.
      for (const path of writtenPaths(bundle)) {
        const entry = lastTraceEntry(bundle, path);
        let basis: FedBasis;
        if (entry?.readKeys !== undefined) {
          // EXACT both ways: recorded provenance can include or EXCLUDE.
          if (!entry.readKeys.includes(node.key)) continue;
          basis = 'per-write';
        } else {
          basis = 'stage';
          anyConservative = true;
        }

        const id = nodeKey(readerIdx, path);
        let child = nodes.get(id);
        if (!child) {
          if (created >= maxNodes) {
            truncatedByNodes = true;
            continue;
          }
          child = makeNode(commitLog, index, path, readerIdx, node.depth + 1);
          nodes.set(id, child);
          created++;
          queue.push(child);
        }
        // One edge per distinct child life (a stage reads a key once).
        if (!node.fedEdges.some((e) => e.child === child)) node.fedEdges.push({ child, basis });
      }
    }
  }

  // ── Honesty envelope, deterministic order ─────────────────────────────
  if (root.origin === 'pre-run') notes.push(preRunOriginNote(normalisedKey));
  if (anyConservative) notes.push(conservativeEdgesNote(normalisedKey));
  if (truncatedByDepth || truncatedByNodes) {
    root.truncated = { byDepth: truncatedByDepth, byNodes: truncatedByNodes };
    notes.push(truncatedNote(truncatedByDepth, truncatedByNodes));
  }

  return {
    ...base,
    ...(anchorIdx !== undefined && { writer: commitLog[anchorIdx] }),
    root,
    notes,
  };
}
