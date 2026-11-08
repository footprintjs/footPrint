import { HistoryDataError, MAX_HISTORY_DATA_DEPTH, MAX_HISTORY_DATA_NODES } from '../../capture/historyData.js';
import type { RecorderBundle } from '../snapshot.js';

/** One synchronous automatic collection; never retained by the registry. */
export interface CaptureSnapshotContext {
  rows: number;
  depth: number;
  readonly active: Set<object>;
}

type SnapshotOwner = { toSnapshot?: () => RecorderBundle };
type CaptureSnapshotStrategy = (owner: object, context: CaptureSnapshotContext) => RecorderBundle;
const strategies = new WeakMap<object, CaptureSnapshotStrategy>();

/** Built-in method identity only: overrides remain the recorder author's own hook. */
export function registerCaptureSnapshot(method: object, strategy: CaptureSnapshotStrategy): void {
  strategies.set(method, strategy);
}

export function createCaptureSnapshotContext(): CaptureSnapshotContext {
  return { rows: 0, depth: 0, active: new Set() };
}

/** Bound library-owned composite expansion before invoking the next synchronous hook. */
export function captureRecorderSnapshot(owner: SnapshotOwner, context: CaptureSnapshotContext): RecorderBundle {
  if (context.rows >= MAX_HISTORY_DATA_NODES || context.depth > MAX_HISTORY_DATA_DEPTH || context.active.has(owner))
    throw new HistoryDataError('invalid-data');
  context.rows++;
  context.depth++;
  context.active.add(owner);
  try {
    const hook = owner.toSnapshot;
    if (typeof hook !== 'function') throw new HistoryDataError('invalid-data');
    const strategy = strategies.get(hook);
    return strategy ? strategy(owner, context) : hook.call(owner);
  } finally {
    context.depth--;
    context.active.delete(owner);
  }
}
