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
 */

import type { ExplainCaptureNote } from '../../capture/explainCoverage.js';
import { hidesExplainIdentity, redactLateExplainFailureStage } from '../../capture/explainIdentity.js';
import { captureWitnessOf, rememberCaptureWitness, shareCaptureWitness } from '../../capture/explainWitness.js';
import { redactReadSources } from '../../capture/readSources.js';
import type { SubflowCapturePort } from '../../capture/subflowCapability.js';
import type { RedactionRule } from '../../memory/redaction.js';
import type { IExecutionRuntime, SubflowResult } from '../types.js';

/** The nested mirror's final state, keyed by the raw result it belongs to. */
const redactedStates = new WeakMap<SubflowResult, Record<string, unknown>>();
const redactedCaptures = new WeakMap<SubflowResult, ExplainCaptureNote>();

export function rememberSubflowCapture(result: SubflowResult, runtime: IExecutionRuntime): void {
  const { treeContext } = result;
  rememberCaptureWitness(treeContext, runtime.rootStageContext.capture, treeContext.history.length);
  const note = runtime.explainSnapshot?.(undefined, true);
  if (note) redactedCaptures.set(result, note);
}

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
  capture?: SubflowCapturePort,
  redaction?: RedactionRule,
): Record<string, SubflowResult> {
  if (!redact) return Object.fromEntries(results);
  const servedByRaw = new Map<SubflowResult, SubflowResult>();
  const served: Record<string, SubflowResult> = {};
  for (const [key, result] of results) {
    let entry = servedByRaw.get(result);
    if (entry === undefined) {
      // The fixed optional port owns its protocol projection; the mirror remains keyed by the raw result.
      const retained = capture?.privateResult(result) ?? result;
      const mirror = redactedStates.get(result);
      const sources = retained.treeContext.readSources;
      const handoff = retained.outputHandoff;
      const originalNote = retained.treeContext.capture;
      const identity = originalNote && (captureWitnessOf(result.treeContext) ?? originalNote);
      const servedNote =
        identity && !hidesExplainIdentity(redaction, identity.runId, identity.logAddress)
          ? redactedCaptures.get(result)
          : undefined;
      entry =
        mirror === undefined && sources === undefined && handoff === undefined && originalNote === undefined
          ? retained
          : {
              ...retained,
              ...(handoff && {
                outputHandoff: Object.freeze({
                  ...handoff,
                  status: 'partial' as const,
                  limitations: Object.freeze([...new Set([...handoff.limitations, 'privacy-active' as const])]),
                  writes: Object.freeze(
                    handoff.writes.map((write) => Object.freeze({ path: write.path, reads: Object.freeze([]) })),
                  ),
                }),
              }),
              treeContext: {
                ...retained.treeContext,
                ...(mirror !== undefined && { globalContext: mirror }),
                ...(sources && { readSources: redactReadSources(sources) }),
              },
            };
      if (originalNote) {
        const { capture: _unserved, ...context } = entry.treeContext;
        entry.treeContext = {
          ...context,
          ...(servedNote && { capture: redactLateExplainFailureStage(servedNote, redaction) }),
        };
        if (servedNote) shareCaptureWitness(result.treeContext, entry.treeContext);
      }
      servedByRaw.set(result, entry);
    }
    served[key] = entry;
  }
  return served;
}
