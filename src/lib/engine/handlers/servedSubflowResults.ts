/**
 * servedSubflowResults — the ONE place that decides which state a subflow's
 * result serves under `getSnapshot({ redact: true })` (9.20.0).
 *
 * A `SubflowResult` is built once by `SubflowExecutor` with the subflow's raw
 * heap as `treeContext.globalContext` — the live view the plain snapshot
 * keeps (the pause checkpoint keeps no subflow result: format 2). When the
 * run keeps a redacted mirror, the nested
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
 *
 * A subflow's `history` and `initialState` are records like the run's own
 * (9.45.0): a bundle or base that holds a value freezing cannot seal (a Date,
 * a Map, a buffer …) is served as a fresh frozen copy each time
 * (`capture/freeze.ts · serveRecord`), so a holder of one snapshot cannot
 * change the subflow record the next snapshot serves.
 */

import { holdsUnsealed, serveCopy, serveRecord } from '../../capture/freeze.js';
import type { SubflowResult } from '../types.js';

/** The nested mirror's final state, keyed by the raw result it belongs to. */
const redactedStates = new WeakMap<SubflowResult, Record<string, unknown>>();

/** Remember the served (mirror) state of a subflow result. Absent without a policy. */
export function rememberRedactedSubflowState(result: SubflowResult, state: Record<string, unknown>): void {
  redactedStates.set(result, state);
}

/** Results whose log holds a bundle freezing could not seal — decided once per result. */
const unsealedHistory = new WeakMap<SubflowResult, boolean>();

function historyHoldsUnsealed(result: SubflowResult): boolean {
  let answer = unsealedHistory.get(result);
  if (answer === undefined) {
    const { history } = result.treeContext;
    answer = Array.isArray(history) && history.some(holdsUnsealed);
    unsealedHistory.set(result, answer);
  }
  return answer;
}

/**
 * The `subflowResults` record a snapshot serves: one fresh result per raw
 * result (so a mount's two keys still point at one object), never the
 * traverser's own record. `globalContext` is the subflow's LIVE heap — or,
 * under `redact: true`, its mirror (9.20.0) — a live view, like the run's own
 * `sharedState`. Everything else is served as a record (9.45.0): its `history`
 * and `initialState` like the run's log and fold base, its `stageContexts` (the
 * subflow's execution tree, stored frozen) through the same `serveRecord`,
 * and its `pipelineStructure` (the chart's own) as a fresh copy — one per
 * snapshot, however many results share it.
 */
export function servedSubflowResults(
  results: ReadonlyMap<string, SubflowResult>,
  redact: boolean,
): Record<string, SubflowResult> {
  const servedByRaw = new Map<SubflowResult, SubflowResult>();
  const structures = new Map<unknown, unknown>();
  const served: Record<string, SubflowResult> = {};
  for (const [key, result] of results) {
    let entry = servedByRaw.get(result);
    if (entry === undefined) {
      entry = servedResult(result, redact, structures);
      servedByRaw.set(result, entry);
    }
    served[key] = entry;
  }
  return served;
}

function servedResult(result: SubflowResult, redact: boolean, structures: Map<unknown, unknown>): SubflowResult {
  const mirror = redact ? redactedStates.get(result) : undefined;
  const raw = result.treeContext;
  const treeContext: SubflowResult['treeContext'] = {
    ...raw,
    globalContext: mirror ?? raw.globalContext,
    stageContexts: serveRecord(raw.stageContexts),
    history:
      Array.isArray(raw.history) && historyHoldsUnsealed(result)
        ? (Object.freeze(raw.history.map(serveRecord)) as unknown[])
        : raw.history,
  };
  if (raw.initialState !== undefined) treeContext.initialState = serveRecord(raw.initialState);
  const served: SubflowResult = { ...result, treeContext };
  if (result.pipelineStructure !== undefined) {
    if (!structures.has(result.pipelineStructure)) {
      structures.set(result.pipelineStructure, serveCopy(result.pipelineStructure));
    }
    served.pipelineStructure = structures.get(result.pipelineStructure);
  }
  return served;
}
