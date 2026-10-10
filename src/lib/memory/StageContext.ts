/**
 * StageContext — Execution context for a single stage in a flowchart run
 *
 * Like a stack frame in a compiler/runtime:
 * - A RecordFrame — the record half (C3): the heap, the address, the
 *   first-touch base, the lazy transaction buffer and every write's scrub
 *   (C4), the readKeys list
 * - Links to parent/child/next contexts (call stack frames)
 * - What belongs to a stage inside a run: retention of reads and writes, the
 *   redaction decision per write (`redaction.ts · decideWrite`) and where the
 *   frame writes (`runAddress.ts`), the dev-mode warnings, the commit observer
 * - DiagnosticCollector for logs, errors, metrics
 */

import type { CommitPhase, EmitSourcePosition, UntrackedSource } from 'foottrace';
import type { EventLog, SharedMemory, WriteVerb } from 'foottrace/write';
import { RecordFrame } from 'foottrace/write';

import { summarizeReadValue, summarizeWriteValue } from '../capture/summarize.js';
import { isDevMode } from '../devMode.js';
import { borrowedMutationMessage, committedMutationMessage, firstDifferingPath } from './borrowedMutation.js';
import { type DiagnosticChannel, DiagnosticCollector } from './DiagnosticCollector.js';
import type { FlowControlType, FlowMessage, ReadTrackingMode, StageSnapshot, WriteTrackingMode } from './frameTypes.js';
import type { RedactionVerdict } from './redaction.js';
import {
  CLEAR,
  decideWrite,
  inheritByIdentity,
  markStagedWrite,
  RedactionRule,
  SCOPE_PLACEHOLDER,
  scrubOf,
  userKeyOf,
} from './redaction.js';
import { runAddress } from './runAddress.js';
import type { RunPolicy } from './runPolicy.js';
import { DEFAULT_RUN_POLICY, withRedaction } from './runPolicy.js';

export class StageContext {
  /**
   * The record half of this frame (`RecordFrame.ts`, L3, C3): the heap and,
   * when the run keeps them, the redacted mirror and the log; the address;
   * the first-touch base; the lazy transaction buffer; the readKeys list.
   * Every state read of this frame goes through it, and so does every
   * commit. The mirror is present **only** when the run's policy keeps a
   * redacted view (a `RedactionPolicy` is configured) — read via
   * `FlowChartExecutor.getSnapshot({ redact: true })`, the foundation for
   * sharing a trace without leaking raw PII through `sharedState`.
   */
  private readonly record: RecordFrame;
  /**
   * The run's policy — the four dials, the redaction rule, the mirror flag
   * (`runPolicy.ts`, F5). Held BY REFERENCE: one frozen object per run (and
   * per resume), shared by every frame of the run, a subflow's included —
   * {@link createNext}/{@link createChild} pass the reference
   * ({@link inheritRun}), the runtime installs it on its root
   * ({@link usePolicy}). Never edited; a change is a new object.
   */
  private policy: RunPolicy = DEFAULT_RUN_POLICY;
  /** The emitting frame's logical leg, never the mutable executor's current leg. */
  private emitRunId?: string;

  public stageName = '';
  /** Unique stage identifier from the builder (matches spec node id). */
  public stageId: string;
  /** Unique per-execution-step identifier. Set by traverser before stage execution. */
  public runtimeStageId = '';
  /**
   * Declared tags (9.21.0) for the stage this context is executing. Set by
   * the traverser beside `runtimeStageId` (per-node identity — NOT inherited
   * by `createNext` / `createChild`), recorded on the first bundle
   * `commit()` writes, then released so a routine second commit on the same
   * context (a fork child's fan-out repeat, a mount's exit bundle) carries
   * none — the same once-per-execution law `_untrackedSources` keeps.
   */
  public tags?: readonly string[];
  /**
   * The run this frame belongs to — its identity on every event, and the run
   * namespace it reads and writes in ({@link runAddress}), read once, when the
   * frame is built (C3). Only {@link useAddressOf} moves the address after
   * that, and only before the first write.
   */
  public readonly runId: string;
  /**
   * The run namespace this frame writes and reads in when that is not its own
   * `runId` — set once, before the frame's first write, by
   * {@link useAddressOf}. Its one user is a subflow mount's merge-back (R13):
   * the record names the mount, the values land where the mount's parent
   * writes. Absent → `runId`, so every other frame is untouched.
   */
  private addressRunId?: string;
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

  public debug: DiagnosticCollector = new DiagnosticCollector(() => this.policy.redaction);

  /** Tracks user-level writes (pre-namespace) for the memory view and onCommit
   *  — in their RETAINED form (cloned / summarised / redacted). Filled from
   *  {@link _pendingWrites} by {@link materialiseWrites} at commit. */
  private _stageWrites: Record<string, { value: unknown; operation: 'set' | 'update' | 'delete' }> = {};

  /**
   * The writes of the CURRENT execution, held by reference with the verdict
   * they were staged under (9.23.0). A key written k times holds its LAST
   * value; the retained form (the `writeTracking` clone or summary, the
   * redaction placeholder or field scrub) is taken ONCE per key at commit —
   * see {@link materialiseWrites}. Same law as the transaction buffer's
   * patch trees: the copy the record needs is paid at the boundary, not at
   * every write. Lazily allocated; a stage that never writes pays nothing.
   */
  private _pendingWrites?: Map<
    string,
    { value: unknown; verdict: RedactionVerdict; operation: 'set' | 'update' | 'delete' }
  >;

  /** Tracks user-level reads (pre-namespace) for the memory view. */
  private _stageReads: Record<string, unknown> = {};

  /**
   * The `_stageReads` keys that were read at a NESTED path (`getValue(path,
   * key)` with a non-empty `path`). Only the engine reads that way — the
   * facade reads roots — so these are not user reads and the borrowed-read
   * guard skips them by this marker, never by guessing from a dot in the key
   * (a user's top-level key may itself contain one). Lazily created; the
   * facade path never allocates it.
   */
  private _nestedReads?: Set<string>;

  /**
   * Dev mode only: the root keys whose LAST tracked read was served from
   * committed state — before this stage's first write, when no transaction
   * buffer exists yet. Such a read is the committed object itself, so an
   * in-place edit of it moves the buffer's diff base too (copy-on-write,
   * 9.29.0); {@link warnOnBorrowedMutation} checks these keys even when the
   * stage wrote them. Never allocated outside `enableDevMode()`.
   */
  private _viewReads?: Set<string>;

  /**
   * Has this frame committed at least once? The borrowed-read guard runs on
   * the FIRST commit only — see {@link warnOnBorrowedMutation}. The frame
   * itself stays re-usable after commit (#13b): the engine's double-commit
   * paths and the subflow merge-back into a branch parent rely on it. The
   * user-level refusal of a handle held past its stage lives at the scope
   * tier (`ScopeFacade`, one per stage execution), not here.
   */
  private _committed = false;

  /** Tracked reads of a selected value ({@link selectedReads}). */
  private _selectedReads = 0;
  /** Each object this frame read under a selected name → that read's verdict (`stageWrite` hands it on). */
  private _selectedObjects?: WeakMap<object, RedactionVerdict>;

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
    this.record = new RecordFrame(sharedMemory, eventLog, runAddress(runId));
    this.record.useEncoding(this.policy);
    this.branchId = branchId;
    this.isDecider = !!isDecider;
    this.isFork = false;
  }

  /** Returns the SharedMemory instance (needed by scope layer). */
  getSharedMemory(): SharedMemory {
    return this.record.state;
  }

  /** @internal Stamped beside runtimeStageId, before scope construction. */
  bindEmitOrigin(runId: string, drillPath: readonly string[] | undefined): void {
    this.emitRunId = drillPath === undefined ? undefined : runId;
    if (drillPath !== undefined) this.record.log?.bindAddress(runId, drillPath);
  }

  /** Capture from this frame's OWN log. A manual/unaddressable frame stays unknown. */
  captureEmitPosition(): EmitSourcePosition | undefined {
    return this.emitRunId === undefined ? undefined : this.record.log?.capturePosition(this.emitRunId);
  }

  /**
   * Install a parallel redacted mirror. Subsequent `commit()` calls apply
   * the already-computed redacted patches — the ones the log records — to
   * this mirror, beside the raw patches on the heap (`recordCommit`).
   * Child / next contexts inherit the mirror via `createNext` / `createChild`.
   *
   * Called on a runtime's root frame by `ExecutionRuntime` when the run's policy keeps a mirror.
   */
  useRedactedMirror(mirror: SharedMemory): void {
    this.record.useMirror(mirror);
  }

  /** Returns the redacted mirror if installed, else undefined. */
  getRedactedSharedMemory(): SharedMemory | undefined {
    return this.record.mirror;
  }

  /**
   * Install the run's policy (`runPolicy.ts`) on this frame — called on a
   * runtime's root by `ExecutionRuntime` (at construction, and by
   * `ExecutionRuntime.usePolicy` on a same-executor resume). Descendants get
   * the same reference through {@link createNext}/{@link createChild}; a
   * subflow's runtime is constructed with it, so its seed frame and every
   * frame after commit under the run's dials too.
   */
  usePolicy(policy: RunPolicy): void {
    this.adoptPolicy(policy);
  }

  /** The run's policy this frame retains, encodes and scrubs under. */
  getPolicy(): RunPolicy {
    return this.policy;
  }

  /**
   * Install a redaction rule — the ONE owner of "what does the policy say
   * about this path" (`memory/redaction.ts`) — as a NEW policy for this frame
   * (the shared one is never edited). Under an executor the rule arrives
   * with the run's policy; this door is for a `ScopeFacade` on a bare frame
   * (unit tests, hand-built scopes), which brings its own rule. Every staged
   * write and every tracked read asks it, so a write that never passes a
   * facade — a subflow seed, an `outputMapper` merge-back, a resume re-seed —
   * is retained under the same verdict as a facade write. Absent: every
   * verdict is `'clear'` unless the caller passed an explicit flag.
   */
  useRedactionRule(rule: RedactionRule): void {
    if (this.policy.redaction !== rule) this.adoptPolicy(withRedaction(this.policy, rule));
  }

  /** The installed redaction rule, if any (the facade's lookup). */
  getRedactionRule(): RedactionRule | undefined {
    return this.policy.redaction;
  }

  /**
   * Take the run from `from`: the policy (by reference) and the run's mirror
   * store. The ONE inheritance step — {@link createNext} and
   * {@link createChild} both call it, and it names no dial.
   */
  private inheritRun(from: StageContext): void {
    this.adoptPolicy(from.policy);
    this.record.useMirror(from.record.mirror);
  }

  /**
   * The ONE place this frame's policy changes: the frame holds it, and its
   * record frame encodes under the same reference (`commitValues`,
   * `writeProvenance` — `RecordFrame · useEncoding`), so the two never differ.
   */
  private adoptPolicy(policy: RunPolicy): void {
    this.policy = policy;
    this.record.useEncoding(policy);
  }

  /**
   * Record a tracked user-level write, policy-gated (#13c-A) — the single
   * bookkeeping path for {@link setObject} and {@link updateObject}. Holds
   * the REFERENCE and the verdict (9.23.0); the retained form is taken at
   * commit by {@link materialiseWrites}, once per key.
   *
   * Redaction takes precedence over the dial in EVERY mode: a redacted
   * write stores the `'[REDACTED]'` placeholder under `'full'` AND
   * `'summary'` (a summary marker would leak the value's preview/size),
   * and stores nothing under `'off'` (entry skipped entirely — nothing to
   * leak). A field-level verdict scrubs a clone BEFORE the dial sees it, so
   * a summary preview can never show the secret either. The verdict is the
   * one `stageWrite` decided BEFORE staging, carried to commit with the
   * value. The staged write itself is unaffected — redaction of the
   * committed payload is the record frame's scrub of that write
   * (`RecordFrame · write`, then `scrub.ts` at commit).
   */
  private trackWrite(
    userKey: string,
    value: unknown,
    verdict: RedactionVerdict,
    operation: 'set' | 'update' | 'delete',
  ) {
    if (this.policy.writeTracking === 'off') return;
    (this._pendingWrites ??= new Map()).set(userKey, { value, verdict, operation });
  }

  /**
   * `_stageWrites` with every pending write folded in as its retained form
   * — the record a reader sees. Consumes nothing: a mid-run snapshot reads
   * the writes so far, and commit still materialises the final values.
   * Returns `_stageWrites` itself when nothing is pending.
   */
  private retainedWrites(): Record<string, { value: unknown; operation: 'set' | 'update' | 'delete' }> {
    if (!this._pendingWrites) return this._stageWrites;
    const out = { ...this._stageWrites };
    for (const [key, w] of this._pendingWrites) {
      out[key] = {
        value: this.retainedForm(w.verdict, w.value, this.policy.writeTracking, summarizeWriteValue),
        operation: w.operation,
      };
    }
    return out;
  }

  /**
   * Take the retained form of every pending write — ONCE per key, from the
   * value as it stands at commit (9.23.0) — and release the references. The
   * first thing `commit()` does, so the borrowed-mutation guard and the
   * commit observer see the finished record.
   */
  private materialiseWrites(): void {
    if (!this._pendingWrites) return;
    try {
      this._stageWrites = this.retainedWrites();
    } finally {
      // Released even when a retained form cannot be taken — an uncloneable
      // value (a function, a Proxy) is a contract violation ("state values
      // must survive structuredClone") that now surfaces HERE, at commit,
      // and fails the run loudly; a later snapshot of the failed run must
      // not throw the same error again.
      this._pendingWrites = undefined;
    }
  }

  /**
   * The form of a value the engine RETAINS (reads and writes retention):
   * the placeholder beats every dial; a field-level scrub happens before the
   * dial sees the value; a clear value is summarized or cloned as the dial
   * says. Callers handle `undefined` before asking.
   */
  private retainedForm(
    verdict: RedactionVerdict,
    value: unknown,
    mode: ReadTrackingMode | WriteTrackingMode,
    summarize: (value: unknown) => unknown,
  ): unknown {
    if (verdict.kind === 'whole') return SCOPE_PLACEHOLDER;
    const scrubbed = verdict.kind === 'fields' ? RedactionRule.scrubFields(value, verdict.paths) : undefined;
    if (mode === 'summary') return summarize(scrubbed ?? value);
    return scrubbed ?? structuredClone(value);
  }

  /**
   * The rule with something to say — `undefined` on the no-policy path (no
   * rule installed, or a rule with no policy entries and no marked keys), so
   * a tracked read or a staged write there pays no verdict call and no path
   * allocation. The default run is byte-identical AND cost-identical.
   */
  private activeRule(): RedactionRule | undefined {
    const rule = this.policy.redaction;
    return rule !== undefined && !rule.isInert() ? rule : undefined;
  }

  /**
   * THE ONE FUNNEL every staged write passes through — facade writes AND
   * the paths that bypass the facade (subflow seed, `outputMapper`
   * merge-back, resume re-seed). Two owners (C4): the run's rule DECIDES,
   * the record frame WRITES the verdict's bytes, in four steps
   * (`redaction.ts`, "The write decision"):
   *   1. the verdict — `decideWrite`, under the rule active as the write begins;
   *   2. identity inheritance — `inheritByIdentity`, against this frame's
   *      selected reads as they stand after step 1;
   *   3. the bytes — `RecordFrame · write`, the op and its scrub (the whole
   *      value, or the fields inside it);
   *   4. the marks — `markStagedWrite`, only once the write staged, so a
   *      write that fails to stage marks nothing.
   * Each step reads the rule (and the selected reads) when it acts, as this
   * funnel always did. Returns the verdict so the caller retains and reports
   * under the same decision.
   */
  private stageWrite(
    nsPath: string[],
    path: string[],
    key: string,
    value: unknown,
    explicit: boolean | undefined,
    verb: WriteVerb,
  ): RedactionVerdict {
    const active = this.activeRule();
    if (active === undefined && !explicit) {
      // The no-policy fast path, the same four steps with nothing to do: no rule with anything to say
      // and no flag is clear (step 1), nothing to inherit without a rule (step 2), no scrub (step 3),
      // and nothing to mark — a clear verdict marks nothing, and a delete unmarks only on the rule
      // active as it began (step 4). The default run pays the record's write and nothing else.
      this.record.write(nsPath, value, verb);
      return CLEAR;
    }
    const asked = decideWrite(active, path, key, explicit);
    const verdict = inheritByIdentity(active, asked, this._selectedObjects, path, key, value);
    this.record.write(nsPath, value, verb, scrubOf(verdict));
    markStagedWrite(active, this.policy.redaction, verdict, path, key, verb);
    return verdict;
  }

  /**
   * Write and read at ANOTHER frame's address (its run namespace) while this
   * frame keeps its own identity on the record — `stage`, `stageId`,
   * `runtimeStageId`, tags. A subflow mount's merge-back is the one caller
   * (`SubflowExecutor · executeSubflow`, R13): the mount frame of a branch or
   * fork child lands its values where its parent writes, as before, and its
   * bundle now names the mount instead of the stage before it. Refused once
   * the frame has staged anything — its buffer's address is fixed then. The
   * decision is the engine's (namespace ids, as since R13); the record frame
   * takes the address it comes to (`RecordFrame · useAddress`).
   */
  useAddressOf(frame: StageContext): void {
    if (this.record.hasStaged && frame.namespaceId !== this.namespaceId) {
      throw new Error(
        `[footprint] StageContext.useAddressOf: '${this.stageId}' has already staged writes at its own address.`,
      );
    }
    this.addressRunId = frame.namespaceId;
    this.record.useAddress(runAddress(this.namespaceId));
  }

  /** The run namespace writes and reads go to: {@link addressRunId}, else `runId`. */
  private get namespaceId(): string {
    return this.addressRunId ?? this.runId;
  }

  // ── Write operations ───────────────────────────────────────────────────

  patch(path: string[], key: string, value: unknown, shouldRedact = false): RedactionVerdict {
    return this.stageWrite(this.record.at(path, key), path, key, value, shouldRedact, 'set');
  }

  set(path: string[], key: string, value: unknown) {
    this.patch(path, key, value);
  }

  merge(path: string[], key: string, value: unknown, shouldRedact?: boolean): RedactionVerdict {
    return this.stageWrite(this.record.at(path, key), path, key, value, shouldRedact, 'merge');
  }

  setObject(
    path: string[],
    key: string,
    value: unknown,
    shouldRedact?: boolean,
    description?: string,
    operationOverride?: 'set' | 'delete',
  ): RedactionVerdict {
    // Explicit deletion (ScopeFacade.deleteValue) stages a distinct op so
    // delta-mode commits (#13c-B) can emit a real `delete` trace entry.
    // Under the default 'full' mode the buffer commits it as a
    // set-of-undefined — byte-identical to the historical flattening.
    const verdict =
      operationOverride === 'delete'
        ? this.stageWrite(this.record.at(path, key), path, key, undefined, shouldRedact, 'delete')
        : this.stageWrite(this.record.at(path, key), path, key, value, shouldRedact, 'set');
    // Track user-level write (pre-namespace) for memory view + onCommit —
    // policy-gated (#13c-A), see trackWrite.
    this.trackWrite(userKeyOf(path, key), value, verdict, operationOverride ?? 'set');
    if (description) {
      const tagged = description.startsWith('[') ? description : `[WRITE] ${description}`;
      this.debug.addLog('message', tagged);
    }
    return verdict;
  }

  updateObject(
    path: string[],
    key: string,
    value: unknown,
    description?: string,
    shouldRedact?: boolean,
  ): RedactionVerdict {
    const verdict = this.merge(path, key, value, shouldRedact);
    // Track user-level write (pre-namespace) for memory view + onCommit —
    // policy-gated (#13c-A), see trackWrite.
    this.trackWrite(userKeyOf(path, key), value, verdict, 'update');
    if (description) {
      this.debug.addLog('message', description);
    }
    return verdict;
  }

  setRoot(key: string, value: unknown) {
    this.patch([], key, value);
  }

  /** Root-level (un-namespaced) write — the subflow seed and merge-back path. */
  setGlobal(key: string, value: unknown, description?: string) {
    this.stageWrite([key], [], key, value, undefined, 'set');
    if (description) {
      this.debug.addLog('message', description);
    }
  }

  updateGlobalContext(key: string, value: unknown) {
    this.stageWrite([key], [], key, value, undefined, 'set');
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

  /**
   * Tracked read. The returned value is BORROWED — see the contract on
   * `ScopeFacade.getValue`. Read-tracking cost is policy-gated (#14):
   * `'full'` clones the value into `_stageReads` (historical default),
   * `'summary'` records a cheap marker, `'off'` records nothing.
   */
  getValue(path: string[], key?: string, description?: string) {
    // The record frame serves the value (two tiers) and keeps the per-write
    // provenance registry (#P1) — key strings only, independent of the
    // readTracking retention dial (which governs VALUE retention below).
    const value = this.record.read(path, key);
    if (key !== undefined) this.record.noteRead(path, key);
    // The verdict, once — for the retained read below and the selected-read
    // count (`selectedReads`). No policy and no marks → no verdict call, no
    // allocation (activeRule).
    const rule = key !== undefined ? this.activeRule() : undefined;
    const verdict = rule !== undefined ? rule.verdictAt(path, key as string) : CLEAR;
    if (verdict.kind !== 'clear' && value !== undefined) {
      this._selectedReads += 1;
      // An object read under a selected name, written back under another, keeps its rule (stageWrite).
      if (value !== null && typeof value === 'object') (this._selectedObjects ??= new WeakMap()).set(value, verdict);
    }
    // Track user-level read (pre-namespace) for memory view — retained under
    // the rule's verdict (9.19.0): a redacted key is retained as the
    // placeholder, a field-level key as a scrubbed clone, never the secret.
    if (key !== undefined && this.policy.readTracking !== 'off') {
      if (path.length > 0) (this._nestedReads ??= new Set()).add(userKeyOf(path, key));
      else if (this.policy.readTracking === 'full' && isDevMode()) {
        if (this.record.hasStaged) this._viewReads?.delete(key);
        else (this._viewReads ??= new Set()).add(key);
      }
      this._stageReads[userKeyOf(path, key)] =
        value === undefined
          ? undefined
          : this.retainedForm(verdict, value, this.policy.readTracking, summarizeReadValue);
    }
    if (description) {
      this.debug.addLog('message', `[READ] ${description}`);
    }
    return value;
  }

  /**
   * How many tracked reads of this frame read a value the run's rule selects
   * (a key it masks whole, or one with secret fields). A boundary that maps
   * what a stage function READ into a new name — the `parallelForEach` items
   * selector — compares it before and after, as a subflow mapper's taint does
   * (`memory/redaction.ts · MapperTaint`). Always 0 without a policy or a mark.
   */
  get selectedReads(): number {
    return this._selectedReads;
  }

  /** Read state without tracking in _stageReads or paying structuredClone cost.
   *  Used by ScopeFacade.getValueSilent() for array proxy internal operations. */
  getValueDirect(path: string[], key?: string): unknown {
    return this.record.read(path, key);
  }

  getRoot(key: string) {
    return this.record.readLive(key);
  }

  getGlobal(key: string) {
    return this.record.readGlobal(key);
  }

  getScope(): Record<string, unknown> {
    return this.record.state.getState();
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

  /** Register an observer that fires after commit() applies patches.
   *  Used by ScopeFacade to dispatch ScopeRecorder.onCommit events. */
  setCommitObserver(
    observer: (mutations: Record<string, { value: unknown; operation: 'set' | 'update' | 'delete' }>) => void,
  ): void {
    this._commitObserver = observer;
  }

  /**
   * Dev-mode only: did this stage change, IN PLACE, a value it merely READ?
   *
   * The typed scope intercepts every write it can reach — a property at any
   * depth, an indexed element, an array method. What it cannot reach is an
   * element handed out by a read method (`find`, `filter`, `for…of`,
   * `forEach`, destructuring): wrapping those would mean returning proxies out
   * of every read, which is a cost the library should not pay. So that family
   * is WARNED ABOUT rather than intercepted — loudly, here, instead of ending
   * the run with a commit log that silently disagrees with final state.
   *
   * This is a REPORT after the fact, not a refusal at the write: the write has
   * already happened in place and there is nothing to intercept. It runs under
   * TWO preconditions, both named in the README — `enableDevMode()`, and
   * `readTracking: 'full'` (the default), because the comparison needs the
   * clone of the value that mode retains at read time. A key the stage never
   * staged must still hold that clone — committed state is immutable-after-swap
   * and the buffer's working copy is private to this stage. Keys the stage DID
   * stage are skipped (they are expected to differ, and they are in the record),
   * so are keys under a redaction verdict, whose retained form is deliberately
   * not the value, and so are keys read at a nested path (`_nestedReads`) —
   * those are engine reads (the subflow merge-back), not user reads.
   *
   * It also only looks at keys served from the PINNED source — the first-touch
   * view or this stage's own buffer. A key absent from both was served by the
   * read's live fallback (`RecordFrame · read`, tier 2), which a parallel sibling's root-key commit can
   * legitimately move; accusing the stage there would be a false alarm. For
   * the same reason it runs on the frame's FIRST commit only: the reads belong
   * to that round, and by the engine's second round (a fork double-commit, a
   * subflow merge-back into a committed branch parent) other stages have
   * legitimately moved the state they were compared against.
   *
   * A key the stage DID stage is still checked when its last read came from
   * committed state ({@link _viewReads} — read before the first write):
   * that read was the committed object itself, and the buffer's diff base IS
   * that object (copy-on-write, 9.29.0), so an in-place edit followed by a
   * write of the key commits NO change — live state keeps the edit, the log
   * does not. Compared against committed state, not the written value, so a
   * legitimate write never trips it.
   *
   * Costs nothing outside `enableDevMode()`.
   */
  private warnOnBorrowedMutation(): void {
    if (!isDevMode() || this.policy.readTracking !== 'full' || this._committed) return;
    const rule = this.activeRule();
    for (const key of Object.keys(this._stageReads)) {
      const retained = this._stageReads[key];
      // Only a container can be mutated in place; a primitive read cannot.
      if (retained === null || typeof retained !== 'object') continue;
      if (this._nestedReads?.has(key)) continue;
      if (rule !== undefined && rule.verdictAt([], key).kind !== 'clear') continue;
      const namespaced = this.record.at([], key);
      if (Object.prototype.hasOwnProperty.call(this._stageWrites, key) || this.record.wasStaged(namespaced)) {
        this.warnOnCommittedMutation(key, namespaced, retained);
        continue;
      }

      // The pinned source only — see the note on the live fallback above.
      // `peek`, not `get`: a report compares, and must not take the private
      // copy a stage's read would (copy-on-write, 9.29.0).
      const current = this.record.peek(namespaced);
      if (current === undefined) continue;

      const path = firstDifferingPath(retained, current);
      if (path === undefined) continue;
      // eslint-disable-next-line no-console
      console.warn(borrowedMutationMessage(this.stageName, key, path));
    }
  }

  /** The staged-key half of {@link warnOnBorrowedMutation}: did committed state itself move under a read? */
  private warnOnCommittedMutation(key: string, namespaced: string[], retained: unknown): void {
    if (!this._viewReads?.has(key)) return;
    const committed = this.record.baseAt(namespaced);
    if (committed === undefined) return;
    const path = firstDifferingPath(retained, committed);
    if (path === undefined) return;
    // eslint-disable-next-line no-console
    console.warn(committedMutationMessage(this.stageName, key, path));
  }

  /**
   * Flush staged writes to shared memory and RELEASE the per-stage staging
   * state (#13b).
   *
   * `phase` (9.39.0) is the caller's statement of what a CONTINUATION commit
   * is — `'exit'` from a subflow mount's exit, `'repeat'` from a fork
   * fan-out's settle. It is stamped on the bundle (`CommitBundle.phase`) only
   * when this frame has ALREADY committed: the FIRST bundle of an execution
   * is the stage's own and never carries a `phase` — so a mount without an
   * `outputMapper` (a lazy mount, every `parallelForEach` branch), whose exit
   * is its only bundle, records that bundle as its own, tags and all.
   *
   * Commit is the stage's lifecycle end: the record frame's buffer and
   * first-touch base are only needed DURING execution, as the read snapshot +
   * net-change diff base, so the record frame releases them once the commit
   * has landed and the observer has seen it (`RecordFrame · release` — why a
   * frame that kept them would retain one state generation per executed
   * stage, and why a re-used frame re-anchors on current state, is there).
   *
   * RE-USE AFTER COMMIT stays correct because both re-create lazily:
   * - a later READ re-anchors on the CURRENT committed state (which includes
   *   this stage's own flushed writes);
   * - a later WRITE constructs a fresh buffer on that re-anchored view, so a
   *   second commit diffs against post-first-commit state. The pre-release
   *   buffer behaved the same for VALUES (its `workingCopy` was reset on
   *   commit, falling reads through to live state) but kept the ORIGINAL
   *   `baseSnapshot` as diff base — unreachable in practice: the engine's
   *   only writes after a commit are the subflow merge-back into a committed
   *   branch parent (a decider or fork frame commits before its branch runs);
   *   the other "write after commit"
   *   sites (SubflowExecutor seed → replaces the context; resume → fresh
   *   context via `leaf.createNext`) never re-use a committed context.
   * - A USER handle held past its stage is a different matter: its writes
   *   would land in a buffer nothing ever commits. That refusal lives on the
   *   scope tier (`ScopeFacade`, sealed by the commit observer — 9.22.0),
   *   because the frame's re-usability is exactly what the engine paths
   *   above need.
   * - `_stageWrites` / `_stageReads` are NOT released — `snapshotSelf()`
   *   reads them post-run for the execution-tree snapshot.
   */
  commit(phase?: CommitPhase): void {
    // A continuation only AFTER the execution's own bundle (see above).
    const continuation = this._committed ? phase : undefined;
    this.materialiseWrites();
    this.warnOnBorrowedMutation();
    // The record's half (`RecordFrame · commit` → `recordCommit.ts`). No buffer
    // = no write ever built one (#13): the commit is empty by construction,
    // recorded with ZERO clones. The names are read once the payload is built.
    this.record.commit(() => ({
      stage: this.stageName,
      stageId: this.stageId,
      runtimeStageId: this.runtimeStageId,
      untrackedSources: this._untrackedSources,
      tags: this.tags,
      phase: continuation,
    }));
    // The observer (ScopeFacade) sees the tracked mutations, THEN the staging
    // state is released (#13b), so it sees the world as it was. D2's markers
    // and the declared tags release with it — one stamp per execution, so the
    // engine's double-commit paths record them exactly once.
    if (this._commitObserver) {
      this._commitObserver({ ...this._stageWrites });
    }
    this.record.release();
    this._untrackedSources = undefined;
    this.tags = undefined;
    this._committed = true;
  }

  /**
   * Throw away everything this stage has STAGED, without committing any of it.
   *
   * The isolation primitive behind declarative retry: when a non-final attempt
   * fails, the writes it staged must not be visible to the next attempt, must
   * not reach shared state, and must not appear in the commit log or in this
   * stage's snapshot. Dropping the staging state achieves all four at once —
   * there is no rollback machinery to invoke because nothing was ever applied
   * (M1: the transaction buffer holds writes until `commit()` flushes them).
   *
   * What is released, and why each one matters for the next attempt:
   *  - the record frame's staged state (`RecordFrame · discard`) — the buffer
   *                    (the next attempt starts with nothing staged), the
   *                    first-touch base (it re-anchors on committed state as
   *                    it stands NOW — a sibling fork branch may legitimately
   *                    have committed in between) and the readKeys list (#P1:
   *                    a discarded attempt's reads must never reach the next
   *                    attempt's `TraceEntry.readKeys`);
   *  - `_stageWrites` / `_pendingWrites` / `_stageReads` — the snapshot
   *                    payload; without the reset the execution tree would
   *                    report writes that were discarded, which is the exact
   *                    lie this feature exists to prevent (the pending map
   *                    holds bare references — dropping it un-clones nothing);
   *  - `_untrackedSources` — the D2 honesty markers, released with the rest.
   *
   * What is deliberately KEPT: `debug` (logs, metrics, errors, flow messages).
   * Diagnostics are the append-only record of what every attempt did, and the
   * retry feature's whole point is that the earlier attempts stay visible.
   *
   * No commit is recorded and no observer fires — a discarded attempt is not a
   * cursor stop, because from shared state's point of view it never happened.
   */
  discardStaged(): void {
    this.record.discard();
    this._untrackedSources = undefined;
    this._pendingWrites = undefined;
    this._stageWrites = {};
    this._stageReads = {};
    this._nestedReads = undefined;
    this._viewReads = undefined;
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
      this.next = new StageContext(path, stageName, stageId, this.record.state, '', this.record.log, isDecider);
      this.next.parent = this;
      this.next.inheritRun(this);
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
    const child = new StageContext(runId, stageName, stageId, this.record.state, branchId, this.record.log, isDecider);
    child.parent = this;
    child.inheritRun(this);
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

  /** @internal Retained incoming value for the facade's legacy emit channel. */
  addDiagnostic(channel: DiagnosticChannel, key: string, value: unknown, path?: string[]): unknown {
    return this.debug.add(channel, key, value, path);
  }

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
    const stageWrites = this.retainedWrites();
    if (Object.keys(stageWrites).length > 0) {
      // Extract values only for the snapshot (strip operation metadata)
      const writes: Record<string, unknown> = {};
      for (const [k, entry] of Object.entries(stageWrites)) {
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
