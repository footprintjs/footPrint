import type { Attention } from 'foottrace';
import { normaliseStateKey } from 'foottrace/paths';
import type { CommitAbout, EventLog, LogCollects, RunDecisionNote, RunStopNote } from 'foottrace/write';
import { RUN_EVIDENCE_LIMITS } from 'foottrace/write';

export interface EvidenceExecution {
  readonly stageId: string;
  readonly id: string;
  readonly parent?: string;
  readonly resumes?: string;
  readonly description?: string;
}

interface FrameEvidence {
  readonly log: EventLog;
  readonly declaration: LogEvidence;
  execution?: EvidenceExecution;
  trackReads: boolean;
  names: Set<string>;
  overflow: boolean;
  missingReads: boolean;
  edgeNoted: boolean;
  committed: boolean;
  stopped: boolean;
  resume?: string;
}

const frames = new WeakMap<object, FrameEvidence>();
interface LogEvidence {
  readonly reads: LogCollects['reads'];
  readonly descriptions: Set<string>;
}
const logs = new WeakMap<EventLog, LogEvidence>();
/** Bounded metadata only. Later stage descriptions stay absent rather than become another per-log history. */
const MAX_DESCRIBED_STAGES = 1024;

/** Called once by the native constructor owner with the fixed declaration actually passed to that writer. */
export function registerLogEvidence(log: EventLog, declaration: Pick<LogCollects, 'reads'> | undefined): void {
  if (log.keepsEvidence && declaration !== undefined && !logs.has(log)) {
    logs.set(log, { reads: declaration.reads, descriptions: new Set() });
  }
}

/** Bind only to a log whose native writer declared collection; never add a field to the frame. */
export function registerEvidence(frame: object, log: EventLog): void {
  const declaration = logs.get(log);
  if (log.keepsEvidence && declaration)
    frames.set(frame, {
      log,
      declaration,
      trackReads: false,
      names: new Set(),
      overflow: false,
      missingReads: false,
      edgeNoted: false,
      committed: false,
      stopped: false,
    });
  else frames.delete(frame);
}

/** Metadata is supplied at the native entry seam, before observers; description is already served. */
export function beginEvidence(frame: object, execution: EvidenceExecution, reads: boolean): void {
  const state = frames.get(frame);
  if (!state) return;
  const { stageId, id, parent, description } = execution;
  const resumes = state.resume ?? execution.resumes;
  state.resume = undefined;
  const described = state.declaration.descriptions;
  const first =
    !described.has(stageId) && described.size < MAX_DESCRIBED_STAGES && stageId.length <= RUN_EVIDENCE_LIMITS.text;
  if (first) described.add(stageId);
  state.execution = {
    stageId,
    id,
    parent,
    resumes,
    ...(first && description !== undefined && { description: description.slice(0, RUN_EVIDENCE_LIMITS.description) }),
  };
  state.trackReads = reads && state.declaration.reads === 'keys';
  state.missingReads = !reads && state.declaration.reads === 'keys';
  state.names.clear();
  state.overflow = false;
  state.edgeNoted = false;
  state.committed = false;
  state.stopped = false;
}

/** Canonical native paths, never snapshot labels. An over-cap row is unavailable, never an invented exact count. */
export function recordEvidenceRead(frame: object, path: readonly string[], key: string): void {
  const state = frames.get(frame);
  if (!state?.execution || !state.trackReads || state.committed || state.overflow) return;
  const name = normaliseStateKey([...path, key]);
  if (state.names.has(name)) return;
  if (state.names.size < RUN_EVIDENCE_LIMITS.reads) state.names.add(name);
  else {
    state.overflow = true;
    noteEdge(state);
  }
}

/** Retry discards affect read facts, not the execution identity or its already-served description. */
export function discardEvidenceReads(frame: object): void {
  const state = frames.get(frame);
  if (!state) return;
  state.names.clear();
  state.overflow = false;
}

/** First execution bundle only. Foottrace still owns bounds, admission and copying at its writer door. */
export function takeEvidenceAbout(frame: object, attention?: readonly Attention[]): CommitAbout | undefined {
  const state = frames.get(frame);
  if (!state?.execution || state.committed) return;
  state.committed = true;
  if (state.overflow || state.missingReads) {
    noteEdge(state);
    return;
  }
  const { parent, resumes, description } = state.execution;
  return {
    ...(parent === undefined ? {} : { parent }),
    ...(resumes === undefined ? {} : { resumes }),
    ...(state.trackReads && { reads: [...state.names] }),
    ...(description === undefined ? {} : { description }),
    ...(attention?.length && { attention }),
  };
}

/** One owner for native mount/no-function entry and collector refusal; never emit a duplicate edge. */
export function noteEvidenceStage(frame: object): void {
  const state = frames.get(frame);
  if (state) noteEdge(state);
}

/** Preserve the real edge without inventing a commit or claiming how the reader treats a missing commit. */
function noteEdge(state: FrameEvidence): void {
  if (state.edgeNoted || !state.execution) return;
  state.edgeNoted = true;
  const { id, parent, resumes } = state.execution;
  state.log.noteRun('run.stage', {
    id,
    ...(parent === undefined ? {} : { parent }),
    ...(resumes === undefined ? {} : { resumes }),
  });
}

/** Test the weak native binding before a producer allocates or serves any evidence. */
export function keepsRunEvidence(frame: object): boolean {
  return frames.has(frame);
}

/** A child log is a new declaration under this leg's dial; a reused log is never relabelled. */
export function childLogEvidence(log: EventLog, reads: boolean): Pick<LogCollects, 'reads'> | undefined {
  const declaration = logs.get(log);
  return declaration && { reads: reads && declaration.reads === 'keys' ? 'keys' : 'off' };
}

/** Dispatch data is already served; the native binding owns the execution id and its log. */
export function noteEvidenceDecision(frame: object, data: Omit<RunDecisionNote, 'id'>): void {
  const state = frames.get(frame);
  if (state?.execution) state.log.noteRun('run.decision', { ...data, id: state.execution.id });
}

/** One terminal native stop; never store a raw exception or reconstruct a stop from the tree. */
export function noteEvidenceStop(frame: object, data: Omit<RunStopNote, 'id'>): void {
  const state = frames.get(frame);
  if (!state?.execution || state.stopped) return;
  state.stopped = true;
  state.log.noteRun('run.stop', { ...data, id: state.execution.id });
}

/** Only the first native entry of this resumed leg continues the checkpoint's explicit execution. */
export function bindResumedEvidence(frame: object, runtimeStageId: string | undefined): void {
  const state = frames.get(frame);
  if (state) state.resume = runtimeStageId;
}
