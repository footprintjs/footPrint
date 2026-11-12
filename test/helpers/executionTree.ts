/**
 * Test helpers for the list form of the execution tree (12.0.0): `executionTree` is the run's
 * stages in the order they ran, and a fork's children are `branches`, one list each.
 *
 * `stagesOf` flattens a tree into every stage in run order (a stage's branches right after it);
 * `stageById` finds the first stage with an id or runtimeStageId. Both walk with a loop, never
 * recursion, so a long run is no problem for the test either.
 */
import type { StageSnapshot } from '../../src/lib/memory/frameTypes.js';

type Stage = StageSnapshot | Record<string, any>;

/** Every stage of a list-form tree, in run order: each stage, then its branches, then the stage after it. */
export function stagesOf<T extends Stage = StageSnapshot>(tree: readonly T[] | undefined): T[] {
  const out: T[] = [];
  if (!tree) return out;
  const work: Array<{ chain: readonly T[]; at: number }> = [{ chain: tree, at: 0 }];
  while (work.length > 0) {
    const top = work[work.length - 1];
    if (top.at >= top.chain.length) {
      work.pop();
      continue;
    }
    const stage = top.chain[top.at++];
    out.push(stage);
    const branches = (stage as { branches?: readonly (readonly T[])[] }).branches;
    if (branches) for (let b = branches.length - 1; b >= 0; b--) work.push({ chain: branches[b], at: 0 });
  }
  return out;
}

/** The first stage (run order) whose `id` or `runtimeStageId` is `id`; undefined when none. */
export function stageById<T extends Stage = StageSnapshot>(tree: readonly T[] | undefined, id: string): T | undefined {
  return stagesOf(tree).find((stage) => stage.id === id || stage.runtimeStageId === id);
}

/** Every stage (run order) whose `id` or `runtimeStageId` is `id`: a loop's passes, one each. */
export function stagesById<T extends Stage = StageSnapshot>(tree: readonly T[] | undefined, id: string): T[] {
  return stagesOf(tree).filter((stage) => stage.id === id || stage.runtimeStageId === id);
}
