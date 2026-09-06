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
    // Normalised to an object: the base is a STATE, and every fold over it
    // (`materialise`, `stateAt`) applies path writes to it. `undefined` —
    // what a run with no `initialContext` used to store here — made every
    // one of those folds throw on the first `set`.
    this.base = initialMemory === undefined ? {} : structuredClone(initialMemory);
  }

  /**
   * The fold BASE — the state as it stood before the first commit.
   *
   * This is the other half of the commit log: bundles are DIFFS, so a log
   * alone cannot reconstruct state that was seeded before the run (an
   * executor `initialContext`, `defaultValuesForContext`, a resume's
   * `checkpoint.sharedState`, a subflow's `inputMapper` seed). Travelling
   * with the log — `RuntimeSnapshot.initialState` — is what lets an OFFLINE
   * consumer fold; without it the honest answer is a partial one
   * (`stateAt`'s `basis: 'log-only'`).
   *
   * Returns a fresh detached clone on every call — the caller owns it.
   */
  getInitialState(): any {
    return structuredClone(this.base);
  }

  /**
   * Reconstructs the full state at any given step.
   * Replays commits from the beginning — O(n) but low memory footprint.
   *
   * INDEX CONVENTION — `stepIdx` is EXCLUSIVE: `materialise(3)` folds commits
   * 0, 1 and 2. `stateAt(source, commitIdx)` (footprintjs/trace) folds the
   * same log but its `commitIdx` is INCLUSIVE, because a reader's cursor asks
   * "the state AT this stop", which must include that stop's own commit. Two
   * folds over one log with opposite conventions: check which one you hold.
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
