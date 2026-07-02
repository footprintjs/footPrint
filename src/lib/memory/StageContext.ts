/**
 * StageContext — Execution context for a single stage in a flowchart run
 *
 * Like a stack frame in a compiler/runtime:
 * - Reference to SharedMemory (accessing heap memory)
 * - TransactionBuffer for staging mutations (transaction buffer)
 * - Links to parent/child/next contexts (call stack frames)
 * - DiagnosticCollector for logs, errors, metrics
 */

import { summarizeReadValue, summarizeWriteValue } from '../capture/summarize.js';
import { isDevMode } from '../scope/detectCircular.js';
import { DiagnosticCollector } from './DiagnosticCollector.js';
import { EventLog } from './EventLog.js';
import { nativeGet } from './pathOps.js';
import { SharedMemory } from './SharedMemory.js';
import { TransactionBuffer } from './TransactionBuffer.js';
import type {
  CommitValuesMode,
  FlowControlType,
  FlowMessage,
  ReadTrackingMode,
  StageSnapshot,
  UntrackedSource,
  WriteProvenanceMode,
  WriteTrackingMode,
} from './types.js';
import { redactPatch } from './utils.js';

export class StageContext {
  private sharedMemory: SharedMemory;
  /**
   * Parallel redacted mirror of `sharedMemory`. Populated in `commit()` with
   * the already-computed redacted patches (the same ones fed to `eventLog`).
   * Present **only** when the executor has been told to maintain a redacted
   * view — i.e. when a `RedactionPolicy` is configured. Otherwise undefined,
   * zero extra work per commit.
   *
   * The mirror is read via `FlowChartExecutor.getSnapshot({ redact: true })`
   * and is the foundation for the "export trace" / paste-into-viewer feature
   * — consumers share the redacted view externally without leaking raw PII
   * through `sharedState`.
   */
  private redactedSharedMemory?: SharedMemory;
  private buffer?: TransactionBuffer;
  /**
   * Committed-state view captured at this stage's FIRST touch (first read OR
   * first write) — held by REFERENCE, never cloned. See
   * {@link firstTouchState} for the algorithm and the immutability invariant
   * that makes a bare reference safe.
   */
  private stateView?: Record<string, unknown>;
  private eventLog?: EventLog;

  public stageName = '';
  /** Unique stage identifier from the builder (matches spec node id). */
  public stageId: string;
  /** Unique per-execution-step identifier. Set by traverser before stage execution. */
  public runtimeStageId = '';
  public runId: string;
  public branchId?: string;
  public isDecider: boolean;
  public isFork: boolean;
  /** Human-readable description from builder (set by traverser before execution). */
  public description?: string;
  /** Subflow identifier (set by traverser when this is a subflow entry point). */
  public subflowId?: string;

  public parent?: StageContext;
  public next?: StageContext;
  public children?: StageContext[];

  public debug: DiagnosticCollector = new DiagnosticCollector();

  /** Tracks user-level writes (pre-namespace) for the memory view and onCommit. */
  private _stageWrites: Record<string, { value: unknown; operation: 'set' | 'update' | 'delete' }> = {};

  /** Tracks user-level reads (pre-namespace) for the memory view. */
  private _stageReads: Record<string, unknown> = {};

  /**
   * How tracked reads are recorded into `_stageReads` (#14). Default `'full'`
   * preserves the historical per-read `structuredClone`. Inherited by every
   * context created via {@link createNext} / {@link createChild} (same
   * propagation pattern as the redacted mirror), and pushed into subflow
   * root contexts by `SubflowExecutor`. Affects ONLY the snapshot's
   * `stageReads` payload — `ScopeRecorder.onRead` (and therefore narrative)
   * is dispatched at the scope tier and never cloned, so it is identical in
   * every mode.
   */
  private readTracking: ReadTrackingMode = 'full';

  /**
   * How tracked writes are recorded into `_stageWrites` (#13c-A) — the
   * sibling of {@link readTracking}, with the same propagation pattern
   * (inherited via {@link createNext}/{@link createChild}, pushed into
   * subflow root contexts by `SubflowExecutor`). Governs the per-write
   * `structuredClone` in {@link setObject}/{@link updateObject}. Affects the
   * snapshot's `stageWrites` payload AND the commit observer's mutations
   * payload (which is a spread of `_stageWrites`) — but NOT the write
   * itself: the transaction buffer, the commit log, and shared state are
   * identical in every mode, and `ScopeRecorder.onWrite` always fires with
   * the live value.
   */
  private writeTracking: WriteTrackingMode = 'full';

  /**
   * How commit-bundle values are encoded into the commit log (#13c-B) — the
   * third dial of the family, with the same propagation pattern as
   * {@link readTracking}/{@link writeTracking} (inherited via
   * {@link createNext}/{@link createChild}, pushed into subflow root
   * contexts by `SubflowExecutor`, re-applied on the resume path). Passed
   * into each {@link TransactionBuffer} at construction; `'full'` (default)
   * is byte-identical to history, `'delta'` enables append/delete verbs +
   * one-trace-entry-per-path dedup. Lossless in both modes.
   */
  private commitValues: CommitValuesMode = 'full';

  /**
   * Per-write read-provenance policy (#P1) — the fourth dial of the family,
   * same propagation pattern as {@link readTracking}/{@link writeTracking}/
   * {@link commitValues}. Under `'reads-prefix'` this context keeps a
   * lightweight ordered set of the keys tracked-read so far, and the
   * transaction buffer stamps that prefix onto every staged write
   * ({@link TraceEntry.readKeys}). INDEPENDENT of readTracking: provenance
   * needs only the key STRINGS, so it works even under readTracking 'off'
   * (and costs nothing when it is itself 'off' — the default).
   */
  private writeProvenance: WriteProvenanceMode = 'off';

  /** Lazily-allocated ordered registry of keys tracked-read in THIS stage —
   *  the source of the per-write prefix. Only allocated under the
   *  `'reads-prefix'` dial; insertion-ordered (a Set) and monotonic, which
   *  is what makes "last write's prefix == union" hold in delta mode. */
  private _provenanceReads?: Set<string>;

  /**
   * RFC-003 D2 honesty markers — untracked read paths used during THIS
   * stage's execution (`'args'` / `'env'` / `'silent'`). Marked by
   * `ScopeFacade`, surfaced on the stage's CommitBundle as
   * `untrackedSources`, then RELEASED with the staging state at commit end
   * (so the routine double-commit paths — fork children, subflow mounts —
   * record the field exactly once, on the first commit). Lazily allocated:
   * stages that never touch an untracked path pay nothing.
   */
  private _untrackedSources?: Set<UntrackedSource>;

  /** Observer called after commit() — used by ScopeFacade to fire ScopeRecorder.onCommit. */
  private _commitObserver?: (
    mutations: Record<string, { value: unknown; operation: 'set' | 'update' | 'delete' }>,
  ) => void;

  constructor(
    runId: string,
    name: string,
    stageId: string,
    sharedMemory: SharedMemory,
    branchId?: string,
    eventLog?: EventLog,
    isDecider?: boolean,
  ) {
    this.runId = runId;
    this.stageName = name;
    this.stageId = stageId;
    this.sharedMemory = sharedMemory;
    this.branchId = branchId;
    this.eventLog = eventLog;
    this.isDecider = !!isDecider;
    this.isFork = false;
  }

  /** Returns the SharedMemory instance (needed by scope layer). */
  getSharedMemory(): SharedMemory {
    return this.sharedMemory;
  }

  /**
   * Install a parallel redacted mirror. Subsequent `commit()` calls will
   * apply the already-computed redacted patches to this mirror in addition
   * to the raw `sharedMemory` + `eventLog`. Child / next contexts inherit
   * the mirror via `createNext` / `createChild`.
   *
   * Called once at the root context by `ExecutionRuntime.enableRedactedMirror()`.
   */
  useRedactedMirror(mirror: SharedMemory): void {
    this.redactedSharedMemory = mirror;
  }

  /** Returns the redacted mirror if installed, else undefined. */
  getRedactedSharedMemory(): SharedMemory | undefined {
    return this.redactedSharedMemory;
  }

  /**
   * Set the read-tracking policy for this context (#14). Called at the root
   * by `ExecutionRuntime.useReadTracking()` (plumbed from
   * `FlowChartExecutor`); descendants inherit via `createNext`/`createChild`,
   * and `SubflowExecutor` pushes the parent context's mode into each subflow
   * root so nested charts inherit too.
   */
  useReadTracking(mode: ReadTrackingMode): void {
    this.readTracking = mode;
  }

  /** Returns the active read-tracking policy (used for subflow propagation). */
  getReadTracking(): ReadTrackingMode {
    return this.readTracking;
  }

  /**
   * Set the write-tracking policy for this context (#13c-A). Same plumbing
   * as {@link useReadTracking}: called at the root by
   * `ExecutionRuntime.useWriteTracking()` (plumbed from `FlowChartExecutor`);
   * descendants inherit via `createNext`/`createChild`, and `SubflowExecutor`
   * pushes the parent context's mode into each subflow root.
   */
  useWriteTracking(mode: WriteTrackingMode): void {
    this.writeTracking = mode;
  }

  /** Returns the active write-tracking policy (used for subflow propagation). */
  getWriteTracking(): WriteTrackingMode {
    return this.writeTracking;
  }

  /**
   * Set the commit-values encoding policy for this context (#13c-B). Same
   * plumbing as {@link useReadTracking}/{@link useWriteTracking}: called at
   * the root by `ExecutionRuntime.useCommitValues()` (plumbed from
   * `FlowChartExecutor`); descendants inherit via `createNext`/`createChild`,
   * and `SubflowExecutor` pushes the parent context's mode into each subflow
   * root.
   */
  useCommitValues(mode: CommitValuesMode): void {
    this.commitValues = mode;
  }

  /** Returns the active commit-values policy (used for subflow propagation). */
  getCommitValues(): CommitValuesMode {
    return this.commitValues;
  }

  /**
   * Set the per-write read-provenance policy (#P1). Same plumbing as the
   * other three dials: called at the root by
   * `ExecutionRuntime.useWriteProvenance()` (plumbed from
   * `FlowChartExecutor`); descendants inherit via `createNext`/`createChild`,
   * and `SubflowExecutor` pushes the parent context's mode into each subflow
   * root so nested charts inherit too.
   */
  useWriteProvenance(mode: WriteProvenanceMode): void {
    this.writeProvenance = mode;
  }

  /** Returns the active write-provenance policy (used for subflow propagation). */
  getWriteProvenance(): WriteProvenanceMode {
    return this.writeProvenance;
  }

  /**
   * Record a tracked user-level write into `_stageWrites`, policy-gated
   * (#13c-A) — the single bookkeeping path for {@link setObject} and
   * {@link updateObject}.
   *
   * Redaction takes precedence over the dial in EVERY mode: a redacted
   * write stores the `'[REDACTED]'` placeholder under `'full'` AND
   * `'summary'` (a summary marker would leak the value's preview/size),
   * and stores nothing under `'off'` (entry skipped entirely — nothing to
   * leak). The staged write itself is unaffected — redaction of the
   * committed payload is handled by the transaction buffer's
   * `redactedPaths`.
   */
  private trackWrite(userKey: string, value: unknown, shouldRedact: boolean, operation: 'set' | 'update' | 'delete') {
    if (this.writeTracking === 'off') return;
    this._stageWrites[userKey] = {
      value: shouldRedact
        ? '[REDACTED]'
        : this.writeTracking === 'summary'
        ? summarizeWriteValue(value)
        : structuredClone(value),
      operation,
    };
  }

  /**
   * ── The first-touch state view (#13) ────────────────────────────────────
   *
   * WHAT: returns the committed shared state as it was at this stage's FIRST
   * touch (first read or first write), capturing the reference on first call.
   * Serves two consumers: reads before the first write ({@link readState})
   * and the transaction buffer's diff base ({@link getTransactionBuffer}).
   *
   * WHY A BARE REFERENCE IS SAFE — the invariant this rests on: committed
   * state is immutable-after-swap. `SharedMemory.applyPatch` routes through
   * `applySmartMerge`, which `structuredClone`s the current state, mutates
   * only the clone, and swaps `SharedMemory.context` to it — the object a
   * stage captured here is never edited afterwards. (`SharedMemory.setValue`/
   * `updateValue` DO mutate in place, but have no callers during traversal;
   * every runtime write reaches state through a stage commit's `applyPatch`.)
   * Holding the reference therefore gives this stage a stable snapshot at
   * zero cost — no clone, which is the entire point of #13.
   *
   * WHY FIRST TOUCH, not first write: the pre-#13 eager engine cloned the
   * state into the buffer at the stage's first ACCESS, anchoring both its
   * snapshot reads and its commit baseline (the net-change diff base) there.
   * #13's first cut anchored the lazy buffer at first WRITE — observably
   * different when something else commits in the gap between this stage's
   * first read and its first write. That gap is REACHABLE: fork siblings are
   * namespace-isolated for run-scoped keys (each child writes under
   * `runs/<childId>/`), but ROOT-level keys are shared — written via
   * `setGlobal` from consumer scope code and, critically, by
   * `SubflowInputMapper`'s output mapping (`parentContext.setGlobal`), which
   * is exactly what runs when a subflow is a fork branch. A sibling's
   * root-key commit landing in the gap would shift this stage's diff base,
   * making its CommitBundle record a phantom change (or swallow a real one)
   * relative to the eager engine. Anchoring the view at first touch restores
   * the EXACT eager semantics — sequential AND parallel — at zero clone cost.
   *
   * Read visibility is two-tier, matching eager byte-for-byte: keys present
   * in the view at first touch read repeatably from it; keys ABSENT from it
   * fall back to LIVE state (the eager engine's exact fallback — a
   * mid-flight sibling root-key write was always visible to reads, and
   * stays visible; only the DIFF BASE is pinned).
   */
  private firstTouchState(): Record<string, unknown> {
    if (!this.stateView) {
      this.stateView = this.sharedMemory.getState();
    }
    return this.stateView;
  }

  /** Lazily creates the transaction buffer on the stage's FIRST WRITE (#13).
   *
   *  Reads NEVER construct it: read-your-writes only matters once a staged
   *  write exists, so before that {@link getValue}/{@link getValueDirect}
   *  serve from the first-touch state view and {@link commit} records an
   *  empty bundle — all with ZERO `structuredClone`s of the shared state.
   *
   *  The buffer's base is the FIRST-TOUCH view, NOT the live state at write
   *  time: under parallel forks a sibling may have committed between this
   *  stage's first read and this write, and the net-change diff base must
   *  stay anchored at first touch to match the eager engine — see
   *  {@link firstTouchState}. */
  getTransactionBuffer(): TransactionBuffer {
    if (!this.buffer) {
      // Per-write provenance (#P1): hand the buffer a live view of this
      // stage's read prefix — evaluated AT EACH WRITE, so each staged op
      // captures exactly the reads that preceded it (temporal prefix).
      const readKeysProvider =
        this.writeProvenance === 'reads-prefix' ? () => [...(this._provenanceReads ?? [])] : undefined;
      this.buffer = new TransactionBuffer(this.firstTouchState(), this.commitValues, readKeysProvider);
    }
    return this.buffer;
  }

  /** Builds an absolute path inside the shared memory (run namespace). */
  private withNamespace(path: string[], key: string): string[] {
    if (!this.runId || this.runId === '') {
      return [...path, key];
    }
    return ['runs', this.runId, ...path, key];
  }

  // ── Write operations ───────────────────────────────────────────────────

  patch(path: string[], key: string, value: unknown, shouldRedact = false) {
    this.getTransactionBuffer().set(this.withNamespace(path, key), value, shouldRedact);
  }

  set(path: string[], key: string, value: unknown) {
    this.patch(path, key, value);
  }

  merge(path: string[], key: string, value: unknown) {
    this.getTransactionBuffer().merge(this.withNamespace(path, key), value);
  }

  setObject(
    path: string[],
    key: string,
    value: unknown,
    shouldRedact?: boolean,
    description?: string,
    operationOverride?: 'set' | 'delete',
  ) {
    if (operationOverride === 'delete') {
      // Explicit deletion (ScopeFacade.deleteValue) stages a distinct op so
      // delta-mode commits (#13c-B) can emit a real `delete` trace entry.
      // Under the default 'full' mode the buffer commits it as a
      // set-of-undefined — byte-identical to the historical flattening.
      this.getTransactionBuffer().delete(this.withNamespace(path, key), shouldRedact ?? false);
    } else {
      this.patch(path, key, value, shouldRedact ?? false);
    }
    // Track user-level write (pre-namespace) for memory view + onCommit —
    // policy-gated (#13c-A), see trackWrite.
    const userKey = path.length > 0 ? [...path, key].join('.') : key;
    this.trackWrite(userKey, value, shouldRedact ?? false, operationOverride ?? 'set');
    if (description) {
      const tagged = description.startsWith('[') ? description : `[WRITE] ${description}`;
      this.debug.addLog('message', tagged);
    }
  }

  updateObject(path: string[], key: string, value: unknown, description?: string, shouldRedact?: boolean) {
    this.merge(path, key, value);
    // Track user-level write (pre-namespace) for memory view + onCommit —
    // policy-gated (#13c-A), see trackWrite.
    const userKey = path.length > 0 ? [...path, key].join('.') : key;
    this.trackWrite(userKey, value, shouldRedact ?? false, 'update');
    if (description) {
      this.debug.addLog('message', description);
    }
  }

  setRoot(key: string, value: unknown) {
    this.patch([], key, value);
  }

  setGlobal(key: string, value: unknown, description?: string) {
    this.getTransactionBuffer().set([key], value);
    if (description) {
      this.debug.addLog('message', description);
    }
  }

  updateGlobalContext(key: string, value: unknown) {
    this.getTransactionBuffer().set([key], value);
  }

  appendToArray(path: string[], key: string, items: unknown[], description?: string) {
    const existing = this.getValue(path, key);
    const merged = Array.isArray(existing) ? [...existing, ...items] : [...items];
    this.setObject(path, key, merged, false, description);
  }

  mergeObject(path: string[], key: string, obj: Record<string, unknown>, description?: string) {
    const existing = this.getValue(path, key);
    const merged =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>), ...obj }
        : { ...obj };
    this.setObject(path, key, merged, false, description);
  }

  // ── Read operations ────────────────────────────────────────────────────

  /** Buffer-aware read, mirroring the eager engine's read order byte-for-byte:
   *
   *    1. staged writes + first-touch snapshot — `buffer.get` over its
   *       workingCopy when the buffer exists, else `nativeGet` over the
   *       zero-clone state view (the buffer's base IS that view, so the two
   *       tiers agree on content);
   *    2. LIVE state via `sharedMemory.getValue` for keys absent from the
   *       snapshot — including its run→global namespace fallback. The eager
   *       engine had this exact live fallback for snapshot-missing keys;
   *       byte-identity over purity.
   *
   *  Reads never construct the buffer (#13): a stage that never writes
   *  performs zero clones of the shared state. */
  private readState(path: string[], key?: string): unknown {
    const namespaced = this.withNamespace(path, key as string);
    const fromSnapshot = this.buffer ? this.buffer.get(namespaced) : nativeGet(this.firstTouchState(), namespaced);
    if (typeof fromSnapshot !== 'undefined') return fromSnapshot;
    return this.sharedMemory.getValue(this.runId, path, key);
  }

  /**
   * Tracked read. The returned value is BORROWED — see the contract on
   * `ScopeFacade.getValue`. Read-tracking cost is policy-gated (#14):
   * `'full'` clones the value into `_stageReads` (historical default),
   * `'summary'` records a cheap marker, `'off'` records nothing.
   */
  getValue(path: string[], key?: string, description?: string) {
    const value = this.readState(path, key);
    // Per-write provenance registry (#P1) — key strings only, independent of
    // the readTracking retention dial (which governs VALUE retention below).
    if (key !== undefined && this.writeProvenance === 'reads-prefix') {
      (this._provenanceReads ??= new Set()).add(path.length > 0 ? [...path, key].join('.') : key);
    }
    // Track user-level read (pre-namespace) for memory view
    if (key !== undefined && this.readTracking !== 'off') {
      const userKey = path.length > 0 ? [...path, key].join('.') : key;
      this._stageReads[userKey] =
        value === undefined
          ? undefined
          : this.readTracking === 'summary'
          ? summarizeReadValue(value)
          : structuredClone(value);
    }
    if (description) {
      this.debug.addLog('message', `[READ] ${description}`);
    }
    return value;
  }

  /** Read state without tracking in _stageReads or paying structuredClone cost.
   *  Used by ScopeFacade.getValueSilent() for array proxy internal operations. */
  getValueDirect(path: string[], key?: string): unknown {
    return this.readState(path, key);
  }

  getRoot(key: string) {
    return this.sharedMemory.getValue(this.runId, [], key);
  }

  getGlobal(key: string) {
    return this.sharedMemory.getValue('', [], key);
  }

  getScope(): Record<string, unknown> {
    return this.sharedMemory.getState();
  }

  getRunId(): string {
    return this.runId;
  }

  // ── Commit ─────────────────────────────────────────────────────────────

  /**
   * RFC-003 D2: record that this stage consumed an untracked read path.
   * Called by `ScopeFacade` (`getArgs`/`getEnv`/unshadowed `getValueSilent`);
   * surfaced as `CommitBundle.untrackedSources` on this stage's commit.
   */
  markUntrackedSource(source: UntrackedSource): void {
    (this._untrackedSources ??= new Set()).add(source);
  }

  /**
   * RFC-003 D2: the `untrackedSources` bundle fragment for commit() — `{}`
   * when nothing was marked, so the spread keeps the field ABSENT (not
   * empty-array-valued) and untouched charts stay byte-identical.
   */
  private untrackedSourcesFragment(): { untrackedSources?: UntrackedSource[] } {
    if (!this._untrackedSources || this._untrackedSources.size === 0) return {};
    return { untrackedSources: [...this._untrackedSources] };
  }

  /** Register an observer that fires after commit() applies patches.
   *  Used by ScopeFacade to dispatch ScopeRecorder.onCommit events. */
  setCommitObserver(
    observer: (mutations: Record<string, { value: unknown; operation: 'set' | 'update' | 'delete' }>) => void,
  ): void {
    this._commitObserver = observer;
  }

  /**
   * Flush staged writes to shared memory and RELEASE the per-stage staging
   * state (#13b).
   *
   * Commit is the stage's lifecycle end: `buffer` (2 full-state clones) and
   * `stateView` (a reference that pins one full committed-state GENERATION —
   * `applySmartMerge` clones + swaps the whole state per commit, so every
   * stage's view is a distinct object) are only needed DURING execution, as
   * the read snapshot + net-change diff base. The execution tree retains
   * every StageContext for the lifetime of the run, so WITHOUT the release
   * a long loop retains one state generation + two clones per executed
   * stage — measured O(N²): 563.8MB at N=200 on an agent-style chart; a
   * 500-iteration agent OOMed a default Node heap (backlog #18).
   *
   * RE-USE AFTER COMMIT stays correct because both fields re-create lazily:
   * - a later READ re-anchors via {@link firstTouchState} on the CURRENT
   *   committed state (which includes this stage's own flushed writes);
   * - a later WRITE constructs a fresh buffer on that re-anchored view, so a
   *   second commit diffs against post-first-commit state. The pre-release
   *   buffer behaved the same for VALUES (its `workingCopy` was reset on
   *   commit, falling reads through to live state) but kept the ORIGINAL
   *   `baseSnapshot` as diff base — unreachable in practice: every engine
   *   re-commit path (fork double-commit, subflow outputMapper double-commit)
   *   stages nothing in between, and the two real "write after commit" sites
   *   (SubflowExecutor seed → replaces the context; resume → fresh context
   *   via `leaf.createNext`) never re-use a committed context's buffer.
   * - `_stageWrites` / `_stageReads` are NOT released — `snapshotSelf()`
   *   reads them post-run for the execution-tree snapshot.
   */
  commit(): void {
    if (!this.buffer) {
      // Truly-lazy fast path (#13): no write ever constructed the buffer, so
      // the stage's net change is empty BY CONSTRUCTION. Same observable
      // outcome as an empty commit — the (empty) bundle is still recorded so
      // every executed stage remains a time-travel cursor stop — but with
      // ZERO clones: no buffer construction, no applyPatch replay.
      this.eventLog?.record({
        overwrite: {},
        updates: {},
        redactedPaths: [],
        trace: [],
        stage: this.stageName,
        stageId: this.stageId,
        runtimeStageId: this.runtimeStageId,
        ...this.untrackedSourcesFragment(),
      });
      if (this._commitObserver) {
        this._commitObserver({ ...this._stageWrites });
      }
      // #13b: drop the first-touch view — a read-only stage still pinned one
      // full state generation through it. D2 markers release with it.
      this.stateView = undefined;
      this._untrackedSources = undefined;
      return;
    }

    const bundle = this.buffer.commit();
    const commitBundle = {
      ...bundle,
      stage: this.stageName,
      stageId: this.stageId,
      runtimeStageId: this.runtimeStageId,
      ...this.untrackedSourcesFragment(),
    };

    this.sharedMemory.applyPatch(commitBundle.overwrite, commitBundle.updates, commitBundle.trace);

    // Already-computed redacted patches feed three consumers:
    //   1. the parallel redacted mirror (if enabled)
    //   2. the event log (persisted trace)
    //   3. (future) anything else that wants a scrubbed view at commit time
    // Computing once keeps cost linear in the commit size; no post-pass walk.
    const redactedOverwrite = redactPatch(commitBundle.overwrite, commitBundle.redactedPaths);
    const redactedUpdates = redactPatch(commitBundle.updates, commitBundle.redactedPaths);

    this.redactedSharedMemory?.applyPatch(redactedOverwrite, redactedUpdates, commitBundle.trace);

    this.eventLog?.record({
      ...commitBundle,
      redactedPaths: Array.from(commitBundle.redactedPaths.values()),
      overwrite: redactedOverwrite,
      updates: redactedUpdates,
    });

    // Notify observer (ScopeFacade) with tracked mutations
    if (this._commitObserver) {
      this._commitObserver({ ...this._stageWrites });
    }

    // #13b: release the staging state — see the method JSDoc. Done LAST so
    // the commit observer sees the exact same world as before the release.
    // D2's untracked-source markers release with it: the routine
    // double-commit paths then record the field exactly once.
    this.buffer = undefined;
    this.stateView = undefined;
    this._untrackedSources = undefined;
  }

  // ── Tree navigation ────────────────────────────────────────────────────

  /**
   * Create (or return) this context's linked successor.
   *
   * MEMOIZED: the first call creates `this.next`; every later call returns
   * that SAME context and IGNORES its arguments. In normal traversal each
   * context advances exactly once, so the memo never bites — but a caller
   * expecting a fresh context for different `stageName`/`stageId` args gets
   * the old one silently. Dev mode (`enableDevMode()`) warns on that
   * mismatch (backlog B4).
   */
  createNext(path: string, stageName: string, stageId: string, isDecider = false): StageContext {
    if (!this.next) {
      this.next = new StageContext(path, stageName, stageId, this.sharedMemory, '', this.eventLog, isDecider);
      this.next.parent = this;
      // Propagate the redacted mirror down the context tree so every commit
      // in the run writes to both views.
      if (this.redactedSharedMemory) this.next.redactedSharedMemory = this.redactedSharedMemory;
      this.next.readTracking = this.readTracking;
      this.next.writeTracking = this.writeTracking;
      this.next.commitValues = this.commitValues;
      this.next.writeProvenance = this.writeProvenance;
    } else if (isDevMode() && (this.next.stageId !== stageId || this.next.stageName !== stageName)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[footprint] StageContext.createNext: next context already exists as "${this.next.stageName}" ` +
          `(id: "${this.next.stageId}") — arguments "${stageName}" (id: "${stageId}") are ignored ` +
          'and the existing context is returned.',
      );
    }
    return this.next;
  }

  createChild(runId: string, branchId: string, stageName: string, stageId: string, isDecider = false): StageContext {
    if (!this.children) {
      this.children = [];
    }
    const child = new StageContext(runId, stageName, stageId, this.sharedMemory, branchId, this.eventLog, isDecider);
    child.parent = this;
    if (this.redactedSharedMemory) child.redactedSharedMemory = this.redactedSharedMemory;
    child.readTracking = this.readTracking;
    child.writeTracking = this.writeTracking;
    child.commitValues = this.commitValues;
    child.writeProvenance = this.writeProvenance;
    this.children.push(child);
    return child;
  }

  createDecider(path: string, stageName: string, stageId: string): StageContext {
    return this.createNext(path, stageName, stageId, true);
  }

  setAsDecider(): StageContext {
    this.isDecider = true;
    return this;
  }

  setAsFork(): StageContext {
    this.isFork = true;
    return this;
  }

  // ── Diagnostics delegation ─────────────────────────────────────────────

  addLog(key: string, value: unknown, path?: string[]) {
    this.debug.addLog(key, value, path);
  }

  setLog(key: string, value: unknown, path?: string[]) {
    this.debug.setLog(key, value, path);
  }

  addMetric(key: string, value: unknown, path?: string[]) {
    this.debug.addMetric(key, value, path);
  }

  setMetric(key: string, value: unknown, path?: string[]) {
    this.debug.setMetric(key, value, path);
  }

  addEval(key: string, value: unknown, path?: string[]) {
    this.debug.addEval(key, value, path);
  }

  setEval(key: string, value: unknown, path?: string[]) {
    this.debug.setEval(key, value, path);
  }

  addError(key: string, value: unknown, path?: string[]) {
    this.debug.addError(key, value, path);
  }

  addFlowDebugMessage(
    type: FlowControlType,
    description: string,
    options?: { targetStage?: string | string[]; rationale?: string; count?: number; iteration?: number },
  ) {
    const flowMessage: FlowMessage = { type, description, timestamp: Date.now(), ...options };
    this.debug.addFlowMessage(flowMessage);
  }

  // ── Snapshot ───────────────────────────────────────────────────────────

  getStageId(): string {
    if (!this.runId || this.runId === '') return this.stageName;
    return `${this.runId}.${this.stageName}`;
  }

  getSnapshot(): StageSnapshot {
    // Iterative walk (explicit work stack), NOT recursion: the execution
    // tree deepens by one level per executed stage along `next` chains, and
    // the trampolined traverser allows chains/loops of tens of thousands of
    // stages — far deeper than a recursive serializer can walk before
    // "Maximum call stack size exceeded".
    const root = this.snapshotSelf();
    const work: Array<{ ctx: StageContext; snap: StageSnapshot }> = [{ ctx: this, snap: root }];
    while (work.length > 0) {
      const { ctx, snap } = work.pop()!;
      if (ctx.next) {
        const nextSnap = ctx.next.snapshotSelf();
        snap.next = nextSnap;
        work.push({ ctx: ctx.next, snap: nextSnap });
      }
      if (ctx.children) {
        snap.children = ctx.children.map((child) => {
          const childSnap = child.snapshotSelf();
          work.push({ ctx: child, snap: childSnap });
          return childSnap;
        });
      }
    }
    return root;
  }

  /** Snapshot of THIS context's own fields — `next`/`children` are filled
   *  in by the iterative walk in `getSnapshot`. */
  private snapshotSelf(): StageSnapshot {
    const snapshot: StageSnapshot = {
      id: this.stageId,
      runtimeStageId: this.runtimeStageId || undefined,
      name: this.stageName,
      isDecider: this.isDecider,
      isFork: this.isFork,
      logs: this.debug.logContext,
      errors: this.debug.errorContext,
      metrics: this.debug.metricContext,
      evals: this.debug.evalContext,
    };
    if (Object.keys(this._stageWrites).length > 0) {
      // Extract values only for the snapshot (strip operation metadata)
      const writes: Record<string, unknown> = {};
      for (const [k, entry] of Object.entries(this._stageWrites)) {
        writes[k] = entry.value;
      }
      snapshot.stageWrites = writes;
    }
    if (Object.keys(this._stageReads).length > 0) {
      snapshot.stageReads = this._stageReads;
    }
    if (this.description) {
      snapshot.description = this.description;
    }
    if (this.subflowId) {
      snapshot.subflowId = this.subflowId;
    }
    if (this.debug.flowMessages.length > 0) {
      snapshot.flowMessages = this.debug.flowMessages;
    }
    return snapshot;
  }
}
