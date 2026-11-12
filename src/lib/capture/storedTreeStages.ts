import { ownData } from './noteShape.js';

/**
 * @internal The stages of a STORED execution tree, in the list form (13.0.0): the root chain's
 * stages in the order they ran, each stage's `branches` read right after it. One bounded loop, no
 * recursion, so every stored-capture reader walks the tree the same way.
 *
 * The input is inert, already-copied data (`copyHistoryData`), but a stored file is untrusted:
 * a chain must be an array, a stage a plain object, `branches` an array of arrays, and the walk
 * stops at `limit` stages. Anything else is `undefined` — the caller refuses the capture. The
 * linked form footprintjs 12 and older wrote (`next` / `children`) is not this shape and is refused too:
 * its depth grew with the run, so a capture of more than about 250 stages could not be stored.
 */
export function storedTreeStages(tree: unknown, limit: number): Record<string, unknown>[] | undefined {
  if (!Array.isArray(tree)) return undefined;
  const stages: Record<string, unknown>[] = [];
  const work: Array<{ chain: readonly unknown[]; at: number }> = [{ chain: tree, at: 0 }];
  while (work.length > 0) {
    const top = work[work.length - 1];
    if (top.at >= top.chain.length) {
      work.pop();
      continue;
    }
    const stage = top.chain[top.at++];
    if (!stage || typeof stage !== 'object' || Object.getPrototypeOf(stage) !== Object.prototype) return undefined;
    if (stages.length >= limit) return undefined;
    stages.push(stage as Record<string, unknown>);
    if (!Object.hasOwn(stage, 'branches')) continue;
    const branches = ownData(stage, 'branches');
    if (!Array.isArray(branches) || !branches.every((chain) => Array.isArray(chain))) return undefined;
    for (let b = branches.length - 1; b >= 0; b--) work.push({ chain: branches[b] as unknown[], at: 0 });
  }
  return stages;
}
