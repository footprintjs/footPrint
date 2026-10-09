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
 * the log's payload is the commit's own copy (`recordCommit` hands it the output of
 * `scrubPatch`), and live state, the redacted mirror and write retention each take their own copy
 * (`verbs.ts · foldRows` detaches, `StageContext · retainedForm` clones) — pinned by
 * test/lib/memory/property/record-reachability.property.test.ts.
 *
 * What `Object.freeze` cannot seal — a Date's time, a Map's or Set's entries, a buffer's bytes, a
 * RegExp, an Error's stack — is never handed out to a reader (9.44.2): `record` remembers that a
 * bundle holds such a value (`capture/freeze.ts · freezeRecord`), and `list()` — like the public
 * snapshot, `runner/snapshot.ts · servedSnapshot` — serves that bundle as a copy of its open paths
 * (`serveRecord`, mapped at its first serve): fresh frozen containers down to each such value, a
 * fresh copy of it, every other part the log's own. A reader edits only its own copy; every later
 * serve reads the record as recorded. `recorded()` is the engine's own, unserved read. Named holes: an object hung on an array EXPANDO (arrays are walked
 * by index — the `'indices'` walk, which keeps the freeze inside its budget; an expando is out of
 * contract for state) and a `SharedArrayBuffer` (every copy shares its memory). A frozen RegExp's
 * `lastIndex` is read-only, so a `/g` or `/y` regex read from a bundle throws when `exec` or
 * `replace` advance it.
 */

import { freezeRecord, serveRecord } from '../capture/freeze.js';
import type { EmitSourcePosition, LogAddress } from './eventPosition.js';
import type { CommitBundle, MemoryPatch } from './types.js';
import { applySmartMergeInto } from './utils.js';

export class EventLog {
  /** Base snapshot BEFORE the first stage mutates anything. */
  private base: any;
  /** Ordered list of commit bundles. */
  private steps: CommitBundle[] = [];
  private sourceAddress?: LogAddress;
  private sourceAddressRetired = false;

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
   * built for the log alone; a caller of this class (`footprintjs/write`) hands over a bundle it
   * will no longer edit — its own object is the one frozen.
   */
  record(bundle: CommitBundle): void {
    bundle.idx = this.steps.length;
    freezeRecord(bundle, 'indices');
    this.steps.push(bundle);
  }

  /**
   * Every recorded commit bundle, AS SERVED (9.44.2): a new array each call; a bundle freezing sealed
   * whole is the log's own (frozen) object, one holding a Date, Map, buffer … is a copy of its open
   * paths (`capture/freeze.ts · serveRecord`) — the reader's own, so no edit reaches the log.
   */
  list(): CommitBundle[] {
    return this.steps.map(serveRecord);
  }

  /**
   * @internal The bundles as the log holds them — each frozen, NOT served — in a new array, so a holder's
   * `splice` reaches only its own. For the engine's own snapshot (`ExecutionRuntime · getSnapshot`, which
   * a subflow mount takes once per mount), so the run serves nothing; a reader is served by `list()` and
   * `getSnapshot().commitLog`. A known open door (CHANGELOG 9.44.2): a holder of these bundles can still
   * edit a Date, Map or buffer inside them.
   */
  recorded(): CommitBundle[] {
    return this.steps.slice();
  }

  /** Number of recorded commits. */
  get length(): number {
    return this.steps.length;
  }

  /** Immutable identity of this log, absent until the engine binds it. */
  get address(): LogAddress | undefined {
    return this.sourceAddress;
  }

  /** @internal Bind once; resuming the same log must not rename its earlier positions. */
  bindAddress(logRunId: string, drillPath: readonly string[]): void {
    if (this.sourceAddressRetired) return;
    this.sourceAddress ??= Object.freeze({ logRunId, drillPath: Object.freeze([...drillPath]) });
  }

  /** O(1) source-time capture. No counter, observer bookkeeping, or future commit prediction. */
  capturePosition(runId: string): EmitSourcePosition | undefined {
    if (!this.sourceAddress) return undefined;
    return Object.freeze({ runId, ...this.sourceAddress, committedThroughIdx: this.steps.length - 1 });
  }

  /** Wipes history (useful for test resets). */
  clear(): void {
    this.steps = [];
    // A reset prefix cannot reuse old coordinates, even if another stage of
    // the SAME leg binds it again. Keep clear's data behavior, but retire
    // addressing for this log; known coordinates require a fresh EventLog.
    this.sourceAddress = undefined;
    this.sourceAddressRetired = true;
  }
}
