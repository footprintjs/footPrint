/**
 * ExecutionHistory - Time-travel snapshot storage for pipeline execution
 * 
 * WHY: Enables debugging and visualization of pipeline execution by storing
 * the commit bundles from each stage in chronological order.
 * 
 * DESIGN: Like git history for pipeline execution:
 * - Each commit bundle is a "commit" that can be replayed
 * - No full snapshots stored - just data-diff bundles
 * - Memory footprint stays < 100KB for typical pipelines
 * - materialise() reconstructs state at any point by replaying commits
 * 
 * RESPONSIBILITIES:
 * - Store commit bundles in chronological order
 * - Reconstruct state at any point via replay
 * - Provide audit trail for pipeline runs
 * 
 * RELATED:
 * - {@link WriteBuffer} - Produces commit bundles
 * - {@link GlobalStore} - Uses history for time-travel
 * 
 * @example
 * ```typescript
 * const history = new ExecutionHistory(initialState);
 * history.record({ stage: 'validate', trace: [...], overwrite: {...}, updates: {...} });
 * const stateAtStep1 = history.materialise(1);
 * ```
 */

import _cloneDeep from 'lodash.clonedeep';

import { applySmartMerge, MemoryPatch } from '../memory/WriteBuffer';

export interface TraceItem {
  /** Canonical path string (joined by \u001F delimiter) */
  path: string;
  /** Operation verb - 'set' for overwrite, 'merge' for deep merge */
  verb: 'set' | 'merge';
}

export interface CommitBundle {
  /** Step index - set by ExecutionHistory when recorded */
  idx?: number;
  /** Stage name (human-readable) */
  stage: string;
  /** Chronological write log for deterministic replay */
  trace: TraceItem[];
  /** Paths that should be redacted in UI (sensitive data) */
  redactedPaths: string[];
  /** Hard overwrite patches */
  overwrite: MemoryPatch;
  /** Deep merge patches */
  updates: MemoryPatch;
}

export class ExecutionHistory {
  /** Base snapshot BEFORE the first stage mutates anything */
  private base: any;
  /** Ordered list of commit bundles */
  private steps: CommitBundle[] = [];

  constructor(initialMemory: any) {
    // DESIGN: Deep clone to ensure isolation from external mutations
    this.base = _cloneDeep(initialMemory);
  }

  /**
   * Reconstructs the full state at any given step.
   * WHY: Enables time-travel debugging by replaying commits.
   * 
   * DESIGN: Replays commits from the beginning up to stepIdx.
   * This is O(n) but keeps memory footprint low since we don't
   * store full snapshots at each step.
   * 
   * @param stepIdx - Step index to materialise to (default: latest)
   * @returns The reconstructed state at the specified step
   */
  materialise(stepIdx = this.steps.length): any {
    let out = _cloneDeep(this.base);
    for (let i = 0; i < stepIdx; i++) {
      const { overwrite, updates, trace } = this.steps[i];
      out = applySmartMerge(out, updates as MemoryPatch, overwrite as MemoryPatch, trace);
    }
    return out;
  }

  /**
   * Persists a commit bundle for a finished stage.
   * WHY: Builds the execution history for debugging and visualization.
   * 
   * @param bundle - The commit bundle from a completed stage
   */
  record(bundle: CommitBundle): void {
    // Auto-increment idx so UI can address steps by index
    bundle.idx = this.steps.length;
    this.steps.push(bundle);
  }

  /**
   * Gets all recorded commit bundles.
   * WHY: Enables UI to display execution timeline.
   */
  list(): CommitBundle[] {
    return this.steps;
  }

  /**
   * Wipes history.
   * WHY: Used by integration tests to reset state between tests.
   */
  clear(): void {
    this.steps = [];
  }
}

// Legacy alias for backward compatibility during migration
export { ExecutionHistory as MemoryHistory };
