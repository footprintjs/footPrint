/**
 * Every commit bundle that sits inside a log, anywhere in a value: the one walk the record laws share.
 *
 * WHY THIS FILE EXISTS. A byte pin against an older engine takes a law's fields out of the BUILD's bytes
 * before it compares (`read-window-law.ts`, `view-mark-law.ts`). Each law checks a bundle against its
 * NEIGHBOURS first (another step's commit inside a window; a commit since a view was pinned), so it needs
 * the log the bundle sits in, and the logs of a run are nested: the top log, and one per sub-flowchart
 * under `subflowResults`. The walk that finds them was written inside the first law. A second law would
 * have copied it, and two copies of "what is a bundle, what is a log" drift.
 */

export type Json = Record<string, any>;

/** A commit bundle, as a record holds it: it names its step and carries rows. */
export const isBundle = (x: unknown): x is Json =>
  x !== null &&
  typeof x === 'object' &&
  !Array.isArray(x) &&
  typeof (x as Json).runtimeStageId === 'string' &&
  Array.isArray((x as Json).trace);

/**
 * Call `take(bundle, log)` for every bundle inside `value` that `carries` the law's fields, in walk order:
 * depth first, object keys in order, a log's bundles in log order. A log is an array that holds the
 * bundle. A bundle that carries the fields outside a log cannot be checked against its neighbours, so it
 * fails, named by `law`.
 */
export function takeFromBundlesInLogs<Taken>(
  value: unknown,
  law: string,
  carries: (bundle: Json) => boolean,
  take: (bundle: Json, log: readonly unknown[]) => Taken,
): Taken[] {
  const taken: Taken[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        if (isBundle(item) && carries(item)) taken.push(take(item, node));
        walk(item);
      }
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (isBundle(node) && carries(node)) {
      throw new Error(`${law} at ${node.runtimeStageId}: a bundle that carries it outside a log`);
    }
    for (const key of Object.keys(node)) walk((node as Json)[key]);
  };
  walk(value);
  return taken;
}
