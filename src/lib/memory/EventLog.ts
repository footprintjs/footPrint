/**
 * EventLog — Time-travel snapshot storage for flowchart execution
 *
 * Like git history: stores commit bundles (diffs), not full snapshots.
 *
 * THE RECORD IS IMMUTABLE FROM `record` (F3, ruling R3). Every bundle is deep-frozen as it is
 * recorded — the bundle, `overwrite` and `updates` at every depth, the trace and each row, the
 * row's `readKeys`, `redactedPaths`, `tags`, `untrackedSources` — so a holder of a snapshot can no
 * longer rewrite the history every later answer is folded from: an assignment into a bundle throws
 * a `TypeError` in strict code. Safe because nothing outside the log holds a bundle's containers:
 * the log's payload is the commit's own copy (`StageContext · commit` hands it the output of
 * `redactPatch`), and live state, the redacted mirror and write retention each take their own copy
 * (`verbs.ts · foldRows` detaches, `StageContext · retainedForm` clones) — pinned by
 * test/lib/memory/property/record-reachability.property.test.ts.
 *
 * Named holes — what `Object.freeze` cannot reach stays mutable: Map and Set contents, a Date's
 * time, the bytes of a typed array (skipped: a non-empty one cannot be frozen), and an object hung
 * on an array EXPANDO (arrays are walked by index — `deepFreeze`'s `'indices'` walk, which keeps
 * the freeze inside its budget). A frozen RegExp's `lastIndex` is read-only, so a `/g` or `/y`
 * regex read from a bundle throws when `exec` or `replace` advance it.
 */

import { deepFreeze } from '../capture/freeze.js';
import type { CommitBundle, MemoryPatch } from './types.js';
import { applySmartMergeInto } from './utils.js';

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
   *
   * One clone of the base per call, then every bundle replayed INTO that
   * private copy (`applySmartMergeInto` — the live commit's copy-on-write law
   * below the root, 9.29.0, so the fold and the live state agree at every
   * path). The result is the caller's: it shares nothing with the base or
   * the log.
   *
   * @deprecated Since 9.33.0 — use `stateAt` from `footprintjs/trace`, which folds the same log
   * from the same base (`RuntimeSnapshot.initialState`) and says how it was derived (`basis`).
   * Nothing in the library calls this; it stays for one minor and is then removed. Mind the
   * index: `materialise(n)` folds commits `0..n-1`, `stateAt(source, n - 1)` the same commits.
   */
  materialise(stepIdx = this.steps.length): any {
    const out = structuredClone(this.base);
    for (let i = 0; i < stepIdx; i++) {
      const { overwrite, updates, trace } = this.steps[i];
      applySmartMergeInto(out, updates as MemoryPatch, overwrite as MemoryPatch, trace);
    }
    return out;
  }

  /**
   * Persists a commit bundle for a finished stage, and FREEZES it (see the module doc): the bundle
   * is stamped with its position, then deep-frozen, then appended. The engine hands it a bundle
   * built for the log alone; a caller of this class (`footprintjs/advanced`) hands over a bundle it
   * will no longer edit — its own object is the one frozen.
   */
  record(bundle: CommitBundle): void {
    bundle.idx = this.steps.length;
    deepFreeze(bundle, 'indices');
    this.steps.push(bundle);
  }

  /** Gets all recorded commit bundles — the live array; every bundle in it is frozen. */
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
