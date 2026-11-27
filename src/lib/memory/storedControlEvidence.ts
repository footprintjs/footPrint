import type { CommitAbout, EventLog, RunDecisionNote, RunLoopNote } from 'foottrace/write';
import { registerStoredControl, storedControlFor, type StoredControlLifecycle } from './storedControlLifecycle.js';

interface ControlExecution {
  readonly id: string;
  readonly parent?: string;
  readonly resumes?: string;
}

interface ControlFrame {
  readonly log: EventLog;
  readonly execution: ControlExecution;
  committed: boolean;
  notedStage: boolean;
  notedDecision: boolean;
  notedLoop: boolean;
}

const frames = new WeakMap<object, ControlFrame>();
const incompleteLogs = new WeakSet<EventLog>();

/** Private producer state. An unresolved dispatch cannot certify a served recording's chart. */
export function canBindStoredControl(log: EventLog): boolean {
  return storedControlFor(log) !== undefined && !incompleteLogs.has(log);
}

/** Install once on the opted-in native log. An ordinary writer stays on its existing path. */
export function installStoredControl(log: EventLog, seal?: StoredControlLifecycle['seal']): void {
  if (!log.keepsEvidence) return;
  const lifecycle: StoredControlLifecycle = {
    begin: (frame, id, ownerLog) => {
      const parent = ownerLog === log ? frame.parent?.runtimeStageId || undefined : undefined;
      beginStoredControl(frame, log, { id, parent });
      registerStoredControl(frame, lifecycle);
    },
    about: storedControlAbout,
    landed: storedControlLanded,
    dynamic: () => incompleteLogs.add(log),
    seal,
    decision(frame, children, chosen, fellBack, fromRules) {
      if (
        frame.getRedactionRule()?.isInert() === false ||
        children.filter((child) => child.name === chosen).length !== 1
      ) {
        incompleteLogs.add(log);
        return;
      }
      noteStoredControlDecision(frame, {
        by: fromRules ? 'decide' : 'plain',
        chosen,
        ...(fellBack && { fellBack: true }),
      });
    },
    selection(frame, children, chosen) {
      if (frame.getRedactionRule()?.isInert() === false) {
        incompleteLogs.add(log);
        return;
      }
      const counts = new Map<string, number>();
      for (const child of children) counts.set(child.name, (counts.get(child.name) ?? 0) + 1);
      if (chosen.some((name) => counts.get(name) !== 1)) {
        incompleteLogs.add(log);
        return;
      }
      noteStoredControlDecision(frame, { by: 'select', chosen, total: children.length });
    },
    loop(frame, source, reference, target) {
      if (source.next !== reference || !source.next?.isLoopRef || frame.getRedactionRule()?.isInert() === false) {
        incompleteLogs.add(log);
        return;
      }
      noteStoredControlLoop(frame, target);
    },
  };
  registerStoredControl(log, lifecycle);
}

/** Bind the native identity at entry. An ordinary log creates no frame evidence. */
export function beginStoredControl(frame: object, log: EventLog, execution: ControlExecution): void {
  if (log.keepsEvidence) {
    frames.set(frame, { log, execution, committed: false, notedStage: false, notedDecision: false, notedLoop: false });
  } else {
    frames.delete(frame);
  }
}

/** The first substantive bundle owns ancestry, including an explicit empty root stamp. */
export function storedControlAbout(frame: object): CommitAbout | undefined {
  const state = frames.get(frame);
  if (!state || state.committed) return undefined;
  const { parent, resumes } = state.execution;
  return {
    ...(parent !== undefined && { parent }),
    ...(resumes !== undefined && { resumes }),
  };
}

export function storedControlLanded(frame: object): void {
  const state = frames.get(frame);
  if (state) state.committed = true;
}

/** A native entry without an owning bundle can supply its edge, but no settled choice. */
export function noteStoredControlStage(frame: object): void {
  const state = frames.get(frame);
  if (!state || state.notedStage || state.committed) return;
  state.notedStage = true;
  const { id } = state.execution;
  state.log.noteRun('run.stage', { id, ...storedControlAbout(frame) });
}

/** Only an admitted, actually dispatched choice follows the owning commit. */
export function noteStoredControlDecision(frame: object, decision: Omit<RunDecisionNote, 'id'>): void {
  const state = frames.get(frame);
  if (!state?.committed || state.notedDecision) return;
  state.notedDecision = true;
  state.log.noteRun('run.decision', { ...decision, id: state.execution.id });
}

/** The exact resolved static target is known before the next execution begins. */
export function noteStoredControlLoop(frame: object, target: RunLoopNote['target']): void {
  const state = frames.get(frame);
  if (!state?.committed || state.notedLoop) return;
  state.notedLoop = true;
  state.log.noteRun('run.loop', { id: state.execution.id, target });
}
