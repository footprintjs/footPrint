/**
 * ExecutionRuntime — The runtime environment for one flowchart execution.
 *
 * Wires up the three memory primitives into a single container:
 *   - SharedMemory (the heap — shared state across all stages)
 *   - StageContext  (the call stack — per-stage execution tree)
 *   - EventLog      (the transaction log — commit history for replay)
 *
 * The engine (FlowchartTraverser) receives this as its runtime parameter.
 * After execution, consumers query it for the full execution state.
 */

import { EventLog } from '../memory/EventLog.js';
import { SharedMemory } from '../memory/SharedMemory.js';
import { StageContext } from '../memory/StageContext.js';
import type { CommitBundle, StageSnapshot } from '../memory/types.js';

/** Snapshot of a single recorder's collected data. */
export interface RecorderSnapshot {
  id: string;
  name: string;
  /** Recorder type and pattern description (e.g., "Translator (KeyedRecorder) — per-step token usage"). */
  description?: string;
  /** Preferred read-time operation — hints the UI about which view to show prominently. */
  preferredOperation?: 'translate' | 'accumulate' | 'aggregate';
  data: unknown;
}

export type RuntimeSnapshot = {
  sharedState: Record<string, unknown>;
  executionTree: StageSnapshot;
  commitLog: CommitBundle[];
  /** Per-subflow execution results (keyed by subflowId). */
  subflowResults?: Record<string, unknown>;
  /** Snapshot data from recorders that implement toSnapshot(). */
  recorders?: RecorderSnapshot[];
};

export class ExecutionRuntime {
  public globalStore: SharedMemory;
  /**
   * Parallel redacted mirror of `globalStore`. Populated during traversal via
   * `StageContext.commit()` using the already-computed redacted patches.
   * Only exists when `enableRedactedMirror()` has been called — typically by
   * `FlowChartExecutor` when a `RedactionPolicy` is configured. Otherwise
   * undefined and zero cost.
   *
   * Read via `getSnapshot({ redact: true })`.
   */
  public redactedStore?: SharedMemory;
  public rootStageContext: StageContext;
  public executionHistory: EventLog;
  /** Original root for getSnapshot() — set before resume changes rootStageContext. */
  private _snapshotRoot?: StageContext;
  private _initialState: unknown;
  private _defaultValues: unknown;

  constructor(rootName: string, rootId: string, defaultValues?: unknown, initialState?: unknown) {
    this._initialState = initialState;
    this._defaultValues = defaultValues;
    this.executionHistory = new EventLog(initialState);
    this.globalStore = new SharedMemory(defaultValues, initialState);
    this.rootStageContext = new StageContext('', rootName, rootId, this.globalStore, '', this.executionHistory);
  }

  /**
   * Opt in to maintaining a parallel redacted mirror of `globalStore`. After
   * this call, every `StageContext.commit()` in the run writes the redacted
   * patches (the same ones fed to the event log) into `redactedStore` in
   * addition to the raw ones written to `globalStore`.
   *
   * The mirror is created lazily and propagated into all child / next
   * contexts, so it correctly reflects subflow-scope writes. When no
   * `RedactionPolicy` is configured, callers should skip this — unused
   * allocation, no functional difference in the snapshot.
   */
  enableRedactedMirror(): void {
    if (this.redactedStore) return; // idempotent
    this.redactedStore = new SharedMemory(
      this._defaultValues,
      // Seed with the same initial state as the raw store so the mirror
      // starts from a scrubbed-nothing baseline; subsequent commits apply
      // the redacted patches on top.
      this._initialState,
    );
    this.rootStageContext.useRedactedMirror(this.redactedStore);
  }

  /** Preserve the current rootStageContext for snapshots before changing it for resume. */
  preserveSnapshotRoot(): void {
    if (!this._snapshotRoot) {
      this._snapshotRoot = this.rootStageContext;
    }
  }

  getPipelines(): string[] {
    const state = this.globalStore.getState();
    return state.pipelines ? Object.keys(state.pipelines as Record<string, unknown>) : [];
  }

  setRootObject(path: string[], key: string, value: unknown) {
    this.rootStageContext.setObject(path, key, value);
  }

  /**
   * Return the runtime snapshot.
   *
   * @param options.redact  When `true`, returns `sharedState` from the
   *   parallel redacted mirror (if one was enabled). This is the safe view
   *   for sharing traces externally — paste into a viewer, ship to support,
   *   etc. When the mirror was never enabled, falls back to raw `globalStore`
   *   and a dev-mode warning is emitted (silent in production).
   *
   *   Default `false` preserves the runtime view — necessary for pause /
   *   resume (resumption must replay against the real values, not
   *   '[REDACTED]').
   *
   * Other fields (`executionTree`, `commitLog`) are the same either way —
   * the commit log is already redacted at write-time, and the execution
   * tree only carries structural metadata.
   */
  getSnapshot(options?: { redact?: boolean }): RuntimeSnapshot {
    const snapshotRoot = this._snapshotRoot ?? this.rootStageContext;
    const useRedacted = options?.redact === true && this.redactedStore !== undefined;
    return {
      sharedState: useRedacted ? this.redactedStore!.getState() : this.globalStore.getState(),
      executionTree: snapshotRoot.getSnapshot(),
      commitLog: this.executionHistory.list(),
    };
  }
}
