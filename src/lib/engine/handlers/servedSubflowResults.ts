/**
 * servedSubflowResults — the ONE place that decides which state a subflow's
 * result serves under `getSnapshot({ redact: true })` (9.20.0).
 *
 * A `SubflowResult` is built once by `SubflowExecutor` with the subflow's raw
 * heap as `treeContext.globalContext` — the live view the plain snapshot and
 * the checkpoint keep. When the run keeps a redacted mirror, the nested
 * runtime keeps one too (enabled by `SubflowExecutor` the way the root does),
 * and its final state is REMEMBERED here beside the result — never written
 * into the result, so the plain snapshot stays byte-identical, and never
 * scrubbed a second time: the mirror already holds exactly what the subflow's
 * log holds (`stateAt` over `treeContext.history` folds to it).
 *
 * The association is by object identity, so it survives the upward merge of
 * nested traversers' result maps and keeps the dual keying honest: the path
 * key and the `#n` twin of one mount point at ONE raw result and are served
 * as ONE substituted result.
 */

import type { SubflowResult } from '../types.js';

/** The nested mirror's final state, keyed by the raw result it belongs to. */
const redactedStates = new WeakMap<SubflowResult, Record<string, unknown>>();

/** Remember the served (mirror) state of a subflow result. Absent without a policy. */
export function rememberRedactedSubflowState(result: SubflowResult, state: Record<string, unknown>): void {
  redactedStates.set(result, state);
}

/**
 * The `subflowResults` record a snapshot serves. Plain: the traverser's own
 * records, as they are. Redacted: each result that remembers a mirror is
 * served as a copy whose `globalContext` IS that mirror — one copy per raw
 * result, so a mount's two keys still point at one object — and a result
 * without a mirror (no policy) is served as itself.
 */
export function servedSubflowResults(
  results: ReadonlyMap<string, SubflowResult>,
  redact: boolean,
): Record<string, SubflowResult> {
  if (!redact) return Object.fromEntries(results);
  const servedByRaw = new Map<SubflowResult, SubflowResult>();
  const served: Record<string, SubflowResult> = {};
  for (const [key, result] of results) {
    let entry = servedByRaw.get(result);
    if (entry === undefined) {
      const mirror = redactedStates.get(result);
      entry =
        mirror === undefined ? result : { ...result, treeContext: { ...result.treeContext, globalContext: mirror } };
      servedByRaw.set(result, entry);
    }
    served[key] = entry;
  }
  return served;
}
