/**
 * commitStops — the one strategy footprintjs ships.
 *
 * One stop per executed stage, in execution order, plus `'start'` / `'end'`
 * bookends. It is the only stop grammar the substrate itself knows: the engine
 * stamps one `runtimeStageId` per executed stage, and an empty commit is a
 * deliberate cursor stop, not noise. Richer vocabularies (milestones, turns,
 * tool calls) belong to the consumer that owns them — they plug in through
 * `TimeTravelStrategy`, they do not go here.
 */

import { parseRuntimeStageId } from '../engine/runtimeStageId.js';
import type { CommitBundle, StageSnapshot } from '../memory/types.js';
import type { Stop, TimeTravelStrategy } from './types.js';

/**
 * Every `runtimeStageId` in the execution tree that the engine marked as a
 * subflow mount. This is the AUTHORITATIVE mount signal; the shape heuristic
 * in {@link commitStops} is only the fallback for a log handed over without
 * its tree (a stored bundle stream, a hand-built log).
 */
function mountIdsFrom(tree: StageSnapshot | undefined): Set<string> {
  const ids = new Set<string>();
  if (!tree) return ids;
  const work: StageSnapshot[] = [tree];
  while (work.length > 0) {
    const node = work.pop()!;
    if (node.subflowId && node.runtimeStageId) ids.add(node.runtimeStageId);
    if (node.next) work.push(node.next);
    if (node.children) work.push(...node.children);
  }
  return ids;
}

/**
 * Derive one stop per executed stage from a recorded commit log.
 *
 * **One stop per `runtimeStageId`.** A stage can commit MORE than one bundle:
 * a subflow mount commits its output-mapping bundle and then its mount-exit
 * bundle; a parallel fork child is committed once by the fan-out and once by
 * the stage funnel, and siblings interleave. Every repeat after the first is
 * an EMPTY bundle — the staging buffer was released by the first commit — so
 * they are cursor positions without content. The axis shows the stage ONCE, at
 * its first commit, which keeps `runtimeStageId → stop` one-to-one: the
 * property `jumpTo` and marks depend on.
 *
 * **Stops PARTITION the log.** A stop's range runs from its own first commit
 * up to (and including) the last commit before the NEXT stop begins —
 * `lastCommitIdx`. Every bundle therefore belongs to exactly one stop, nothing
 * is orphaned, and `stateAt(stop)` is precisely the state that existed just
 * before the next stop's stage started. Folding through `commitIdx` instead
 * would silently drop a mount's output mapping.
 *
 * **Bookends.** `'start'` is the position before the first commit — the fold
 * base, which no commit index can otherwise address. `'end'` is "the run is
 * over"; it folds the whole log, the same as the last stage's stop, because
 * "after the last stage" and "the run finished" are the same state asked as
 * two different questions.
 *
 * An EMPTY log yields NO stops at all — not two bookends around nothing. A
 * cursor with nowhere to stand says so (`Move.reason === 'empty'`).
 */
export function commitStops(commitLog: readonly CommitBundle[], executionTree?: StageSnapshot): Stop[] {
  if (commitLog.length === 0) return [];

  const mountIds = mountIdsFrom(executionTree);
  // With the tree in hand the mount set is AUTHORITATIVE; the shape heuristic
  // below is the fallback for a log handed over without its tree, and must not
  // second-guess the tree (a single-child fork looks exactly like a mount).
  const haveTree = executionTree !== undefined;

  // First commit of each distinct runtimeStageId, in execution order.
  // An EMPTY runtimeStageId is not a stage: it is a root-context commit made
  // before any stage ran — a subflow's `inputMapper` seed. It gets no stop of
  // its own (a stop with no id could not be jumped to or marked); it belongs
  // to the `'start'` bookend, which is where a reader looks for "the input
  // this chart began with" anyway.
  const firsts: number[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < commitLog.length; i++) {
    const id = commitLog[i].runtimeStageId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    firsts.push(i);
  }

  const stops: Stop[] = [
    {
      step: 0,
      runtimeStageId: '',
      commitIdx: -1,
      // Covers any leading id-less commits — the subflow input seed.
      lastCommitIdx: (firsts.length > 0 ? firsts[0] : commitLog.length) - 1,
      stageId: '',
      label: 'Run start',
      kind: 'start',
    },
  ];

  for (let g = 0; g < firsts.length; g++) {
    const first = firsts[g];
    const bundle = commitLog[first];
    // Partition boundary: everything up to the next stage's first commit.
    const last = g + 1 < firsts.length ? firsts[g + 1] - 1 : commitLog.length - 1;
    // No tree? A mount is the one stage whose SECOND bundle follows its first
    // immediately — the entry/exit pair. An interleaved fork-child repeat does
    // not look like that, which is exactly the pair this must not match.
    const looksLikeMount =
      first + 1 < commitLog.length && commitLog[first + 1].runtimeStageId === bundle.runtimeStageId;
    stops.push({
      step: stops.length,
      runtimeStageId: bundle.runtimeStageId,
      commitIdx: first,
      lastCommitIdx: last,
      stageId: bundle.stageId,
      subflowPath: parseRuntimeStageId(bundle.runtimeStageId).subflowPath,
      label: bundle.stage || bundle.stageId || bundle.runtimeStageId,
      kind: mountIds.has(bundle.runtimeStageId) || (!haveTree && looksLikeMount) ? 'mount' : 'commit',
    });
  }

  stops.push({
    step: stops.length,
    runtimeStageId: '',
    commitIdx: commitLog.length - 1,
    lastCommitIdx: commitLog.length - 1,
    stageId: '',
    label: 'Run end',
    kind: 'end',
  });

  return stops;
}

/** `commitStops` as a {@link TimeTravelStrategy} — the default for `timeTravel`. */
export const commitStopsStrategy: TimeTravelStrategy = { stopsFor: commitStops };
