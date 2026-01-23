/**
 * ExecutionHistory - Time-travel snapshot storage for pipeline execution
 * ----------------------------------------------------------------------------
 *  Stores the commit bundles emitted by each stage's commit() operation in
 *  chronological order. This enables:
 *    - Time-travel debugging (replay to any point in execution)
 *    - Execution visualization in the UI
 *    - Audit trails for pipeline runs
 *
 *  Design notes:
 *    • No full snapshots are kept - just the data-diff bundles
 *    • Memory footprint stays < 100KB for typical pipelines
 *    • materialise() reconstructs state at any point by replaying commits
 */

import _cloneDeep from 'lodash.clonedeep';

import { applySmartMerge, MemoryPatch } from './WriteBuffer';

export interface TraceItem {
  path: string; // canonical path string (joined by \u001F)
  verb: 'set' | 'merge'; // operation verb
}

export interface CommitBundle {
  idx?: number; // set by ExecutionHistory when recorded
  stage: string; // stage name (human-readable)
  trace: TraceItem[]; // chronological write log
  redactedPaths: string[]; // paths that should be redacted in UI
  overwrite: MemoryPatch;
  updates: MemoryPatch;
}

/**
 * ExecutionHistory - Manages the chronological record of pipeline mutations
 * 
 * Think of it like a git history for your pipeline execution - each commit
 * bundle is a "commit" that can be replayed to reconstruct state at any point.
 */
export class ExecutionHistory {
  /** Base snapshot BEFORE the first stage mutates anything */
  private base: any;
  /** Ordered list of commit bundles */
  private steps: CommitBundle[] = [];

  constructor(initialMemory: any) {
    this.base = _cloneDeep(initialMemory);
  }

  /**
   * materialise(stepIdx?) - Build the full state at any given step.
   * 
   * Replays commits from the beginning up to stepIdx to reconstruct
   * the exact state at that point in execution.
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
   * record() - Persist a commit bundle for a finished stage.
   * 
   * The idx is auto-incremented so UI can address steps by index.
   */
  record(bundle: CommitBundle): void {
    bundle.idx = this.steps.length;
    this.steps.push(bundle);
  }

  /**
   * list() - Get all recorded commit bundles.
   */
  list(): CommitBundle[] {
    return this.steps;
  }

  /**
   * clear() - Wipe history (used by integration tests).
   */
  clear(): void {
    this.steps = [];
  }
}

// Legacy alias for backward compatibility during migration
export { ExecutionHistory as MemoryHistory };
