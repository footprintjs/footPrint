import { LOG_PLACEHOLDER } from 'foottrace/write';

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
import {
  applyExplainPrivacy,
  hidesExplainIdentity,
  redactLateExplainFailureStage,
} from '../../capture/explainIdentity.js';
import { captureWitnessOf, rememberCaptureWitness, shareCaptureWitness } from '../../capture/explainWitness.js';
import { redactReadSources } from '../../capture/readSources.js';
import type { SubflowCapturePort } from '../../capture/subflowCapability.js';
import { observeRedactionDisclosure } from '../../memory/readAuthority/disclosure.js';
import type { RedactionRule } from '../../memory/redaction.js';
import type { IExecutionRuntime, SubflowResult } from '../types.js';

interface ChildProjection {
  mirror?: Record<string, unknown>;
  note?: ExplainCaptureNote;
  policy?: string;
  capture?: SubflowCapturePort;
}

/** One projection and disclosure proof per raw result, shared by both mount keys. */
const projections = new WeakMap<SubflowResult, ChildProjection>();

export function canServeRetainedChild(
  result: SubflowResult,
  policy: string | undefined,
  capture: SubflowCapturePort | undefined,
): boolean {
  const projection = projections.get(result);
  return policy !== undefined && projection?.policy === policy && projection.capture === capture;
}

/**
 * Keep the child's mirror alongside its raw result. The exit event serves the
 * mirror through the boundary rule, or retains the raw heap when only marks
 * are active. The raw result stays available to the current leg's execution.
 */
export function serveCompletedChild(
  result: SubflowResult,
  runtime: IExecutionRuntime,
  entryDisclosure: string | undefined,
  rule: RedactionRule | undefined,
  capture: SubflowCapturePort | undefined,
): Record<string, unknown> {
  const mirror = runtime.redactedStore?.getState();
  // If disclosure changed during collection, or an active rule has no mirror, the raw result is live only.
  const policy =
    entryDisclosure === observeRedactionDisclosure(rule) && (mirror || rule?.isInert() !== false)
      ? entryDisclosure
      : undefined;
  const context = result.treeContext;
  let note: ExplainCaptureNote | undefined;
  if (context.capture) {
    rememberCaptureWitness(context, runtime.rootStageContext.capture, context.history.length);
    note = runtime.explainSnapshot?.(undefined, true);
  }
  if (mirror || note || policy !== undefined) projections.set(result, { mirror, note, policy, capture });
  const state = mirror ?? context.globalContext;
  return rule?.retainBoundary(state, mirror && LOG_PLACEHOLDER) ?? state;
}

/**
 * The `subflowResults` record a snapshot serves. Both views apply the live
 * policy to explain notes. Redacted: each result that remembers a mirror is
 * served as a copy whose `globalContext` IS that mirror — one copy per raw
 * result, so a mount's two keys still point at one object — and a result
 * without a mirror (no policy) is served as itself.
 */
export function servedSubflowResults(
  results: ReadonlyMap<string, SubflowResult>,
  redact: boolean,
  capture?: SubflowCapturePort,
  redaction?: RedactionRule,
  explainEnabled = false,
  retainedHistory = false,
): Record<string, SubflowResult> {
  const livePrivacy = explainEnabled && redaction?.isInert() === false;
  if (!redact && !livePrivacy) return Object.fromEntries(results);
  const servedByRaw = new Map<SubflowResult, SubflowResult>();
  const served: Record<string, SubflowResult> = {};
  for (const [key, result] of results) {
    let entry = servedByRaw.get(result);
    if (entry === undefined) {
      if (!redact) {
        const context = result.treeContext;
        const note = context.capture;
        const projected = note && applyExplainPrivacy(note);
        entry = projected === note ? result : { ...result, treeContext: { ...context, capture: projected } };
        if (entry !== result) shareCaptureWitness(context, entry.treeContext);
      } else {
        // The fixed optional port owns its protocol projection; the mirror remains keyed by the raw result.
        const retained = capture?.privateResult(result) ?? result;
        const projection = projections.get(result);
        const mirror = projection?.mirror;
        const sources = retained.treeContext.readSources;
        const handoff = retained.outputHandoff;
        const originalNote = retained.treeContext.capture;
        const identity = originalNote && (captureWitnessOf(result.treeContext) ?? originalNote);
        const servedNote =
          identity && !hidesExplainIdentity(redaction, identity.runId, identity.logAddress)
            ? projection?.note
            : undefined;
        if (mirror || sources || handoff || originalNote) {
          const context = { ...retained.treeContext };
          const projection = { ...retained, treeContext: context };
          if (mirror) {
            context.globalContext = mirror;
            if (retainedHistory && redaction)
              context.initialState = redaction.retainState(context.initialState, LOG_PLACEHOLDER);
          }
          if (sources) context.readSources = redactReadSources(sources);
          if (handoff) {
            projection.outputHandoff = Object.freeze({
              ...handoff,
              status: 'partial' as const,
              limitations: Object.freeze([...new Set([...handoff.limitations, 'privacy-active' as const])]),
              writes: Object.freeze(
                handoff.writes.map((write) => Object.freeze({ path: write.path, reads: Object.freeze([]) })),
              ),
            });
          }
          if (originalNote) {
            const projected = servedNote && redactLateExplainFailureStage(servedNote, redaction);
            delete context.capture;
            if (projected) context.capture = livePrivacy ? applyExplainPrivacy(projected) : projected;
            if (servedNote) shareCaptureWitness(result.treeContext, context);
          }
          entry = projection;
        } else {
          entry = retained;
        }
      }
      servedByRaw.set(result, entry);
    }
    served[key] = entry;
  }
  return served;
}
