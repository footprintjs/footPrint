/**
 * EventLog — Time-travel snapshot storage for flowchart execution
 *
 * Like git history: stores commit bundles (diffs), not full snapshots.
 * materialise(stepIdx) reconstructs state at any point by replaying commits.
 */

import type { CommitBundle, MemoryPatch } from './types.js';
import { applySmartMerge } from './utils.js';

export class EventLog {
  /** Base snapshot BEFORE the first stage mutates anything. */
  private base: any;
  /** Ordered list of commit bundles. */
  private steps: CommitBundle[] = [];

  constructor(initialMemory: any) {
    this.base = structuredClone(initialMemory);
  }

  /**
   * Reconstructs the full state at any given step.
   * Replays commits from the beginning — O(n) but low memory footprint.
   */
  materialise(stepIdx = this.steps.length): any {
    let out = structuredClone(this.base);
    for (let i = 0; i < stepIdx; i++) {
      const { overwrite, updates, trace } = this.steps[i];
      out = applySmartMerge(out, updates as MemoryPatch, overwrite as MemoryPatch, trace);
    }
    return out;
  }

  /** Persists a commit bundle for a finished stage. */
  record(bundle: CommitBundle): void {
    bundle.idx = this.steps.length;
    this.steps.push(bundle);
  }

  /** Gets all recorded commit bundles. */
  list(): CommitBundle[] {
    return this.steps;
  }

  /** Number of recorded commits. */
  get length(): number {
    return this.steps.length;
  }

  /** Wipes history (useful for test resets). */
  clear(): void {
    this.steps = [];
  }
}
