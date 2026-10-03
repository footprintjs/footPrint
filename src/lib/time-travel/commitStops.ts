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

import { isExecutionKey, isWithinSubflow, parseRuntimeStageId, stageIdOf } from '../ids/runtimeStageId.js';
import { buildCommitIndex, inferLegacyPhases, recordsPhases } from '../memory/commitLogUtils.js';
import type { CommitBundle, CommitPhase, StageSnapshot } from '../memory/types.js';
import type { Stop, TimeTravelStrategy } from './types.js';

/**
 * Every `runtimeStageId` in the execution tree that the engine marked as a
 * subflow mount. Authoritative, as is a bundle's recorded `phase: 'exit'`
 * (9.39.0) — a mount with a merge-back records its exit as a continuation. A
 * mount without one has a single bundle, its own (no `phase`), so only the
 * tree names it. Only a log written before 9.39.0 AND handed over without its
 * tree falls back to the legacy inference (`inferLegacyPhases`).
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
 * a subflow mount commits its output-mapping bundle and then its EXIT; a
 * parallel fork child is committed by the stage funnel and again by the
 * fan-out (its REPEAT), and siblings interleave. The writer names each
 * continuation on its bundle (`phase: 'exit' | 'repeat'`, 9.39.0), so the
 * grouping is read, never inferred: the axis shows the stage ONCE, at its
 * first commit ({@link buildCommitIndex}), which keeps `runtimeStageId → stop`
 * one-to-one — the property `jumpTo` and marks depend on. The FIRST bundle per
 * `runtimeStageId` is the stage's own and never carries a `phase`; a stage
 * whose bundles include an `'exit'` is a `'mount'`. A continuation is normally empty
 * (the first commit released the staging buffer); one that carries a write is
 * folded where it sits in the log, which is when it happened.
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
 *
 * **THE SHAPE IS A CONTRACT (9.18.0).** For a non-empty log the result is
 * `[start, …stages, end]` — `'start'` first, `'end'` last, one stop per
 * executed stage between them, in execution order — and for an empty log it
 * is `[]`. A strategy that COMPOSES this one (keep some stages, drop the rest)
 * rests on that shape; it is pinned by `test/lib/time-travel/`, and
 * {@link splitAxis} is the one guard that reads it — a composer calls that, or
 * {@link filterStops} which calls it, instead of writing its own.
 */
export function commitStops(
  commitLog: readonly CommitBundle[],
  executionTree?: StageSnapshot,
  subflowResults?: unknown,
): Stop[] {
  if (commitLog.length === 0) return [];

  // No tree? The snapshot's `subflowResults` still keys every mount EXECUTION
  // by its runtimeStageId (9.39.0) — the mapper-less mounts whose one bundle
  // carries no `phase` (fork / selector children, lazy mounts, `parallelForEach`
  // branches) included.
  const mountIds = executionTree ? mountIdsFrom(executionTree) : mountKeysOf(subflowResults);
  const phases = phasesOf(commitLog, executionTree !== undefined);

  // First commit of each distinct runtimeStageId, in execution order — the
  // one index every reader shares (`buildCommitIndex`).
  // A subflow's `inputMapper` seed is not one of the subflow's stages: it is
  // the MOUNT's commit, made before any of them ran. It gets no stop of its
  // own; it belongs to the `'start'` bookend, which is where a reader looks
  // for "the input this chart began with" anyway. See {@link seedCommits}.
  const seeds = seedCommits(commitLog, executionTree);
  const firsts: number[] = [];
  for (const [id, i] of buildCommitIndex(commitLog)) if (id && i >= seeds) firsts.push(i);
  const exits = new Set<string>();
  for (let i = seeds; i < commitLog.length; i++) if (phases[i] === 'exit') exits.add(commitLog[i].runtimeStageId);

  const stops: Stop[] = [
    {
      step: 0,
      runtimeStageId: '',
      commitIdx: -1,
      // Covers the subflow input seed, when the log opens with one.
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
    stops.push({
      step: stops.length,
      runtimeStageId: bundle.runtimeStageId,
      commitIdx: first,
      lastCommitIdx: last,
      stageId: bundle.stageId,
      subflowPath: parseRuntimeStageId(bundle.runtimeStageId).subflowPath,
      label: bundle.stage || bundle.stageId || bundle.runtimeStageId,
      kind: mountIds.has(bundle.runtimeStageId) || exits.has(bundle.runtimeStageId) ? 'mount' : 'commit',
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

/** The per-execution mount keys of a snapshot's `subflowResults` (`'#'` keys; path keys skipped). */
function mountKeysOf(subflowResults: unknown): Set<string> {
  const ids = new Set<string>();
  if (subflowResults === null || typeof subflowResults !== 'object') return ids;
  for (const key of Object.keys(subflowResults)) if (isExecutionKey(key)) ids.add(key);
  return ids;
}

/**
 * The phase of every bundle: as RECORDED when the log records any (9.39.0+).
 * A log that records none is either free of continuations (nothing to read)
 * or older than the field: with its execution tree the tree names the mounts,
 * so nothing is inferred; without it, the one legacy reader infers what
 * 9.38.0 inferred (`inferLegacyPhases`) — a stored recording keeps its axis.
 */
function phasesOf(commitLog: readonly CommitBundle[], haveTree: boolean): readonly (CommitPhase | undefined)[] {
  if (recordsPhases(commitLog)) return commitLog.map((bundle) => bundle.phase);
  return haveTree ? [] : inferLegacyPhases(commitLog);
}

/** `commitStops` as a {@link TimeTravelStrategy} — the default for `timeTravel`. */
export const commitStopsStrategy: TimeTravelStrategy = { stopsFor: commitStops };

/**
 * How many commits at the head of a log are a subflow's input seed — 0 on a
 * run's own log. The seed is `history[0]` of the subflow's log, committed by
 * the MOUNT before any of the subflow's stages ran:
 *
 * - since R13 it carries the mount's runtimeStageId — and a mount's stage
 *   address (the id before `#`) IS the subflow path of every stage in the
 *   log it opens (`sub#2` opens `sub/in#3`; `outer/sub#5` opens
 *   `outer/sub/in#6`), which no stage of that log can be;
 * - through 9.33.0 it carried `''`, which is still read the same way, so an
 *   old recording keeps its axis.
 *
 * A log that holds ONLY the seed (the subflow committed no stage — it paused
 * or failed first) has no stage to compare with; the execution tree's root
 * stands in for it: a subflow's tree is rooted at one of its own stages,
 * whose id carries the same subflow path. Without a tree such a log reads as
 * one stop.
 */
function seedCommits(commitLog: readonly CommitBundle[], executionTree?: StageSnapshot): number {
  const head = commitLog[0]?.runtimeStageId;
  if (head === undefined) return 0;
  if (head === '') {
    let n = 0;
    while (n < commitLog.length && commitLog[n].runtimeStageId === '') n++;
    return n;
  }
  let next = 1;
  while (next < commitLog.length && commitLog[next].runtimeStageId === head) next++;
  const address = stageIdOf(head);
  if (next >= commitLog.length) {
    const rootId = executionTree?.id;
    return typeof rootId === 'string' && isWithinSubflow(rootId, address) ? next : 0;
  }
  return parseRuntimeStageId(commitLog[next].runtimeStageId).subflowPath === address ? next : 0;
}
