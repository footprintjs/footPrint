/**
 * MemoryHistory – backend implementation for time‑travel snapshots
 * ----------------------------------------------------------------------------
 *  • Stores the *commit bundle* emitted by each StageContext.commitPatch()
 *    in chronological order.
 *  • No snapshots are kept – just the data‑diff bundles – keeping memory
 *    footprint < 10O KB for typical pipelines.
 */

import _cloneDeep from 'lodash.clonedeep';

import { applySmartMerge, MemoryPatch } from './PatchedMemoryContext';

export interface TraceItem {
  path: string; // canonical path string (joined by \u001F)
  verb: 'set' | 'merge'; // operation verb
}

export interface CommitBundle {
  idx?: number; // set by MemoryHistory when recorded
  stage: string; // stage name (human‑readable)
  trace: TraceItem[]; // chronological write log
  redactedPaths: string[]; // chronological write log
  overwrite: MemoryPatch;
  updates: MemoryPatch;
}

export class MemoryHistory {
  /** base snapshot BEFORE the first stage mutates anything */
  private base: any;
  /** ordered list of commit bundles */
  private steps: CommitBundle[] = [];

  constructor(initialMemory: any) {
    this.base = _cloneDeep(initialMemory);
  }

  /**
   * materialise(stepIdx?) – build the full AppContext at any given step.
   *  stepIdx omitted → returns latest.
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
   * record() – persist bundle for a finished stage.
   *  • idx is auto‑incremented so UI can address steps by index.
   */
  record(bundle: CommitBundle): void {
    bundle.idx = this.steps.length;
    this.steps.push(bundle);
  }

  list(): CommitBundle[] {
    return this.steps;
  }

  /** wipe history (used by integration tests) */
  clear(): void {
    this.steps = [];
  }
}
