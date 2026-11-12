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
import { nativeGet } from 'foottrace/paths';
import type { EventLog, SharedMemory, WriteVerb } from 'foottrace/write';
import { RecordFrame } from 'foottrace/write';

import type { AttemptContext, AttemptRecord, AttemptSummary, LateWrite } from '../attempt/types.js';
import { NativeClosureInvocations } from '../capture/nativeClosure/invocations.js';
import type { NativeCapture } from '../capture/nativeCoverage.js';
import type { NativeExtent } from '../capture/nativeExtent/collector.js';
import type { EngineReadSourceCapture } from '../capture/readSources.js';
import { EMPTY_SOURCE_READ_COUNTS, SourceReadCounter } from '../capture/sourceReadCounts.js';
import { summarizeReadValue, summarizeWriteValue } from '../capture/summarize.js';
import { isDevMode } from '../devMode.js';
import { callsEndedReason } from '../errors/callsEnded/index.js';
import type { StructuredErrorInfo } from '../errors/errorInfo.js';
import {
  type SelectedNativeFailure,
  type TerminalFailureContext,
  NativeFailureState,
} from '../errors/terminalFailure.js';
import { StageAttention } from './attention.js';
import { borrowedMutationMessage, committedMutationMessage, firstDifferingPath } from './borrowedMutation.js';
import { type DiagnosticChannel, DiagnosticCollector } from './DiagnosticCollector.js';
import type { FlowControlType, FlowMessage, StageSnapshot } from './frameTypes.js';
import { type KeptWrite, HiddenObjectTrail } from './hiddenObjectTrail.js';
import { KeptReads } from './keptReads.js';
import { placeOf } from './markPlaces.js';
import {
  type RedactionRule,
  type RedactionVerdict,
  type StagedDelete,
  CLEAR,
  decideWrite,
  inheritByIdentity,
  markStagedWrite,
  userKeyOf,
} from './redaction.js';
import { activeRule, retainedForm } from './retainedValue/index.js';
import { RUN_NAMESPACE, runAddress } from './runAddress.js';
import type { RunPolicy } from './runPolicy.js';
import { DEFAULT_RUN_POLICY, withRedaction } from './runPolicy.js';

/** How many late writes a stage keeps — an abandoned attempt that loops must not grow the record without bound. */
const MAX_LATE_WRITES = 100;

/**
 * How many call and observed attempt records one stage execution keeps (P2) — a stage that calls in a loop must
 * not grow the execution tree without bound. The rest are counted (`StageSnapshot.attemptsDropped`) and still
 * fired on `onAttempt`. A stage's OWN attempt records are never displaced: its policy's ceiling bounds them.
 */
export const MAX_CALL_RECORDS = 1000;

export class StageContext {
  /** @internal Ownership of an escaping failure. Shared only by sequential frames, never serialized. */
  failureState = new NativeFailureState();
  /** @internal Default-off producer seam. It grants no closure or capture completeness by itself. */
  declare captureClosureTracking?: boolean;
  private declare closureInvocations?: NativeClosureInvocations;
  #failureIdentity?: NonNullable<TerminalFailureContext['stage']>;

  /** @internal The native frame stamp, independent of mutable recorder event context. */
  get failureIdentity(): NonNullable<TerminalFailureContext['stage']> | undefined {
    return this.#failureIdentity;
  }

  /** @internal Stamped before observers; never inherited by another frame or persisted. */
  bindFailureIdentity(runId: string, runtimeStageId: string): void {
    this.#failureIdentity = Object.freeze({ runId, runtimeStageId });
    this.sourceInvocations = 0;
    if (this.captureClosureTracking) this.closureInvocations?.reset();
    if (this.readSources?.active)
      this.readSources.ownership?.begin(runId, runtimeStageId, runAddress(this.namespaceId));
  }

  /**
   * The record half of this frame (foottrace's `RecordFrame`, C3): the heap and,
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

  /** The native root-log collector; copied to same-log frames, never child runtimes. */
  capture?: NativeCapture;
  declare captureExtent?: NativeExtent;
  /** Source coverage, shared only by frames of this runtime. */
  readSources?: EngineReadSourceCapture;
  private sourceReadCounter?: SourceReadCounter;
  private sourceAttempt?: string;
  private sourceInvocations = 0;

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
  private _pendingWrites?: Map<string, KeptWrite>;

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

  /** Which reads this frame has already kept: a read is kept once for each object a key holds (`keptReads.ts`). */
  private readonly keptReads = new KeptReads();

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
   * Dev mode only: the root keys read LIVE through {@link readLiveRoot} (a subflow mount's mappers and
   * its list append). Such a read is of committed state as it was at that moment, not of this frame's
   * pinned view, and a mount stays open for the whole run of its subflow: a parallel sibling may
   * rightly replace the key in between. {@link warnOnBorrowedMutation} has no pinned value to compare
   * the copy with, so it skips these keys, as it skips every read the live fallback served.
   * Never allocated outside `enableDevMode()`.
   */
  private _liveReads?: Set<string>;

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
  /**
   * Follows the objects this frame read under a selected name into what it writes: at each write, and
   * once more at commit (`hiddenObjectTrail.ts`). Made at the first write or read a redaction rule
   * has something to say about, so a run without a policy holds none.
   */
  private _trail?: HiddenObjectTrail;
  /**
   * This frame's staged deletes of keys the redaction rule keeps hidden (`redaction.ts · markStagedWrite`),
   * each with the absolute path it deletes. A delete is only STAGED until the frame commits, so no mark
   * ends at the write: {@link endMarksOfLandedDeletes} asks the state once the commit has landed. A
   * discarded try drops them; a delete that never landed ends nothing.
   */
  private _stagedDeletes?: { readonly ending: StagedDelete; readonly at: readonly string[] }[];
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

  /**
   * The attempts of this frame's execution (10.1) — its own under the attempt runner, appended as each attempt ends
   * (`FlowchartTraverser · executeStage`), and those of the calls it made (P2, {@link reportCallAttempt}) — read
   * by {@link ownSnapshot}. Append-only
   * evidence like `debug`: NOT cleared by {@link discardStaged} (the earlier attempts are the point) and never
   * part of a commit bundle. Lazily allocated: a stage without a policy pays nothing.
   */
  private _attempts?: AttemptRecord[];
  /** The attempt series at a glance, stamped once when it ends. */
  private _attemptSummary?: AttemptSummary;
  /** Facts collected for this execution only; retry discards deliberately keep them. */
  private _attention?: StageAttention;
  /**
   * The attempt now running (P1b) — set by `StageRunner` before the scope is built, so the facade can hand it out
   * (`scope.$attempt()`) and fence its own attempt. Absent for a stage the attempt runner does not run.
   */
  private _attempt?: AttemptContext;
  /** The run's signal, for the attempt a stage outside the runner reports (attempt 1 of 1). */
  private _runSignal?: AbortSignal;
  /** Every attempt up to this number has ENDED without an answer — its scope is fenced (0 = none). */
  private _endedThrough = 0;
  /** Writes an attempt tried after it ended — dropped at the scope, kept here as names. Lazily allocated. */
  private _lateWrites?: LateWrite[];
  /**
   * Where a call's attempt records are reported (P2) — the engine's `onAttempt` for this stage execution, set by
   * `FlowchartTraverser · executeStage` with the stage's own traversal context (and its correlation).
   */
  private _attemptReporter?: (record: AttemptRecord, structuredError: StructuredErrorInfo | undefined) => void;

  /** Calls made so far, per stage attempt — the `k` of a call's series. Lazily allocated. */
  private _callOrdinals?: Map<number, number>;
  /** Per stage attempt, the signal its calls stop by (`callsEndedSignal`). Lazily allocated. */
  private _callsEnded?: Map<number, AbortController>;
  /** Call and observed records kept on the frame, and those past {@link MAX_CALL_RECORDS}. */
  private _callRecords = 0;
  private _attemptsDropped = 0;

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
   * this mirror, beside the raw patches on the heap (foottrace's `RecordFrame · commit`).
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
    this.readSources = from.readSources;
    this.adoptPolicy(from.policy);
    this.capture = from.capture;
    if (from.captureExtent) this.captureExtent = from.captureExtent;
    if (from.captureClosureTracking) this.captureClosureTracking = true;
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
   * (`RecordFrame · write`, then foottrace's scrub at commit).
   */
  private trackWrite(
    path: readonly string[],
    key: string,
    value: unknown,
    verdict: RedactionVerdict,
    operation: 'set' | 'update' | 'delete',
  ) {
    if (this.policy.writeTracking === 'off') return;
    (this._pendingWrites ??= new Map()).set(userKeyOf(path, key), { value, verdict, operation, path, key });
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
        value: retainedForm(w.verdict, w.value, this.policy.writeTracking, summarizeWriteValue),
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
   * THE ONE FUNNEL every staged write passes through — facade writes AND
   * the paths that bypass the facade (subflow seed, `outputMapper`
   * merge-back, resume re-seed). Two owners (C4): the run's rule DECIDES,
   * the record frame WRITES the verdict's bytes, in four steps
   * (`redaction.ts`, "The write decision"):
   *   1. the verdict — `decideWrite`, under the rule active as the write begins;
   *   2. identity inheritance — `inheritByIdentity`, against this frame's
   *      selected reads as they stand after step 1;
   *   3. the bytes — `RecordFrame · write`, the op and its scrub (the whole
   *      value, or the fields inside it). Steps 2 and 3 are one call,
   *      `HiddenObjectTrail · stage`, which also keeps what the key showed;
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
    // From here on this frame's own writes decide what a read of this root returns (`keptReads.ts`).
    if (this.policy.readTracking !== 'off') this.keptReads.wrote(path[0] ?? key);
    const active = activeRule(this.policy.redaction);
    if (active === undefined && !explicit) {
      // The no-policy fast path, the same four steps with nothing to do: no rule with anything to say
      // and no flag is clear (step 1), nothing to inherit without a rule (step 2), no scrub (step 3),
      // and nothing to mark — a clear verdict marks nothing, and a delete unmarks only on the rule
      // active as it began (step 4). The default run pays the record's write and nothing else.
      this.record.write(nsPath, value, verb);
      return CLEAR;
    }
    const asked = decideWrite(active, path, key, explicit);
    const verdict = this.trail.stage(active, asked, nsPath, path, key, value, verb);
    // Where this write lands: this run's state, and the address in front of the path. Read from the
    // absolute path, not from the frame: a root-level write (`setGlobal`) of a namespaced frame lands at
    // the root. A mark knows the places its values live, so a delete ends it only by taking away the last
    // one. Asked only when a mark can change: a delete, a write with a verdict, or a write under a top
    // key the rule itself keeps hidden.
    const rule = this.policy.redaction;
    const place =
      verb === 'delete' || verdict.kind !== 'clear' || rule?.keeps(path[0] ?? key)
        ? placeOf(this.record.state, nsPath.slice(0, nsPath.length - path.length - 1))
        : undefined;
    const ending = markStagedWrite(active, rule, verdict, path, key, verb, place);
    if (ending !== undefined) (this._stagedDeletes ??= []).push({ ending, at: nsPath });
    return verdict;
  }

  /**
   * The frame's staged writes have landed. A delete among them ends its key's mark NOW, and only when
   * the key is really gone from the state. WHY ask the state: a stage that deletes a key and writes it
   * again before its commit has not deleted it (the record shows no delete either), and what it wrote
   * back may be the hidden value it read first.
   */
  private endMarksOfLandedDeletes(): void {
    const staged = this._stagedDeletes;
    if (staged === undefined) return;
    this._stagedDeletes = undefined;
    const state = this.record.state.getState();
    for (const { ending, at } of staged) {
      if (nativeGet(state, at as string[]) === undefined) ending.rule.unmark(ending.key, ending.place);
    }
  }

  /** This frame's trail of hidden objects, made when first asked for (`hiddenObjectTrail.ts`). */
  private get trail(): HiddenObjectTrail {
    return (this._trail ??= new HiddenObjectTrail(this.record, () => activeRule(this.policy.redaction)));
  }

  /**
   * Search what this frame wrote once more, as it stands now, before it is recorded
   * (`HiddenObjectTrail · followAtCommit`, why). A key that gained a hidden place there was staged
   * again; here it gets its marks. And every write the frame kept for its snapshot takes the verdict
   * its kept form is taken under: this runs before {@link materialiseWrites}.
   */
  private followLateEdits(): void {
    if (this._trail === undefined) return;
    const active = activeRule(this.policy.redaction);
    this._trail.followAtCommit((root, at, verdict) => {
      markStagedWrite(active, active, verdict, [], root, 'set', placeOf(this.record.state, at.slice(0, -1)));
    }, this._pendingWrites?.values());
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
    if (this.readSources?.active && this.#failureIdentity && frame.namespaceId !== this.namespaceId)
      this.readSources.ownership?.limit('namespace-changed');
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
    this.trackWrite(path, key, value, verdict, operationOverride ?? 'set');
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
    this.trackWrite(path, key, value, verdict, 'update');
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
   * `'full'` keeps a clone of the value in `_stageReads` (the default), once
   * for each object a key holds ({@link keepOnce}); `'summary'` records a
   * cheap marker, `'off'` records nothing.
   */
  getValue(path: string[], key?: string, description?: string) {
    return this.retainedRead(path, key, description, true);
  }

  /**
   * {@link getValue} for an answer that hands the stage a NAME, never the value: a key listing and its per-key check.
   * The same read and the same rows, but it does not count for the taint law ({@link taintedReads}): a stage that knows
   * a name holds nothing a rule selects. Only `ScopeFacade · getStateKeys` and `listsKey` ask it.
   */
  inspectValue(path: string[], key?: string) {
    return this.retainedRead(path, key, undefined, false);
  }

  private retainedRead(path: string[], key: string | undefined, description: string | undefined, handsValue: boolean) {
    try {
      return this.readRetainedValue(path, key, description, handsValue);
    } catch (error) {
      this.capture?.limit('read-retention-failed');
      throw error;
    }
  }

  private readRetainedValue(
    path: string[],
    key: string | undefined,
    description: string | undefined,
    handsValue: boolean,
  ) {
    // The record frame serves the value (two tiers) and keeps the per-write
    // provenance registry (#P1) — key strings only, independent of the
    // readTracking retention dial (which governs VALUE retention below).
    let verdict: RedactionVerdict = CLEAR;
    const value =
      this.policy.readSources && this.readSources
        ? this.readWithNativeSource(path, key, () => {
            verdict = this.judgeRead(path, key);
            return verdict.kind === 'clear' ? 'visible' : 'redacted';
          })
        : this.record.read(path, key);
    // Default-off retains its original read -> noteRead -> ONE verdict order.
    // Enabled capture uses a pure post-read verdict; prefix bookkeeping follows it
    // before returning to stage code. A pure, name-only verdict cannot observe the prefix.
    if (!this.policy.readSources || !this.readSources) verdict = this.noteAndJudgeRead(path, key);
    return this.retainRead(path, key, value, verdict, description, handsValue);
  }

  /**
   * A read of one ROOT key of live committed state, recorded as a read of THIS step. The mount of a
   * subflow reads this way: its two mappers (`engine/handlers/mapperScope.ts`) and its merge-back,
   * which reads what is there before it adds to it (`SubflowInputMapper · applyOutputMapping`). The
   * value is live state at the root, exactly what those were handed before. What is new is that the
   * read is RECORDED: on the frame's read prefix, under the rule's verdict, in the taint count and
   * in `stageReads`. A key the state does not hold reads `undefined` and records nothing, as before.
   *
   * WHY NOT `getValue`: that serves the frame's own view, pinned at its first touch. A mount's
   * output mapping runs after the subflow has run, and reads state as it is THEN; a pinned view
   * would hand it state as it was when the mount began.
   *
   * WHAT `stageReads` KEEPS IS THE RUN'S OWN SETTING (`readTracking`), as for every read of every
   * step: a copy under `'full'`, a marker under `'summary'`, nothing under `'off'`. The first cut kept
   * a marker whatever the setting said, to spare a mount in a loop the copy. That broke what `'full'`
   * promises a reader of the record (every read of a step is there as a value), and a consumer's own
   * test caught it. The copy is the setting's price, here as for a stage; `bench/mapper-reads.ts`
   * measures it, and `'summary'` is the setting for a run that hands large values on.
   *
   * WITH READ SOURCES ON (`readSources: true`) this read has no source of its own: the record's
   * source-capturing door reads the frame's view, not live root state. The capture says so
   * (`untracked-read`, status `partial`) and never reports a run with such a read as fully captured.
   */
  readLiveRoot(key: string): unknown {
    if (!this.hasRootKey(key)) return undefined;
    const value = this.record.readGlobal(key);
    if (this.policy.readSources && this.readSources) this.readSources.limit('untracked-read');
    if (this.policy.readTracking === 'full' && isDevMode()) (this._liveReads ??= new Set()).add(key);
    try {
      return this.retainRead([], key, value, this.noteAndJudgeRead([], key), undefined, true);
    } catch (error) {
      // The same note a view read leaves when what it read cannot be kept (`retainedRead`).
      this.capture?.limit('read-retention-failed');
      throw error;
    }
  }

  /**
   * A read of `key` as THIS frame's writes see it (its own address, then the root), recorded as a read
   * of this step like any other. A subflow's merge-back reads this way before it merges a plain object
   * field by field: what comes out under `key` is what was there with those fields changed, and the
   * fields are written where the frame writes. (For a mount whose frame writes at the root, which is
   * every mount the builder makes, this is the root key; read at the root regardless, a frame that
   * writes under a namespace would be given the wrong writer.) A key that is not there reads
   * `undefined` and records nothing: that is all this door adds to {@link getValue}.
   */
  readOwnView(key: string): unknown {
    // `peek` and `hasRootKey` ask whether it is there without reading it as the step.
    if (this.record.peek(this.record.at([], key)) === undefined && !this.hasRootKey(key)) return undefined;
    return this.retainedRead([], key, undefined, true);
  }

  /**
   * `value` is about to be written at `path`/`key` in PIECES: a subflow's merge-back merges a plain
   * object field by field and appends a list as a new array. The write funnel then sees only the
   * pieces, so an object this frame read under a selected name would lose its rule on the way (step 2
   * of {@link stageWrite}, which follows an object by identity). Asked here with the whole value
   * first, the target inherits what a whole write would have given it.
   */
  inheritRule(path: string[], key: string, value: unknown): void {
    const active = activeRule(this.policy.redaction);
    if (active === undefined) return;
    inheritByIdentity(active, active.verdictAt(path, key), this._trail?.objects, path, key, value);
  }

  /**
   * `handed` is what user code was given in place of `value`, an object this frame read under a
   * selected name: the redaction rule hands a subflow mapper a VIEW of a record whose fields are
   * selected, not the record. It carries the same rule, so that a copy of it written under another
   * name is found by identity ({@link inheritRule}, {@link stageWrite}) as the record itself would be.
   */
  sameRuleFor(handed: unknown, value: unknown): void {
    if (handed === null || typeof handed !== 'object' || value === null || typeof value !== 'object') return;
    this._trail?.objects?.sameRuleFor(handed, value);
  }

  /**
   * `copy` is a full copy the scope made of `value` and handed to user code (`$batchArray`). An object
   * taken out of the copy is the selected value's all the same.
   */
  copyOfSelected(copy: unknown, value: unknown): void {
    if (copy === null || typeof copy !== 'object' || value === null || typeof value !== 'object') return;
    this._trail?.objects?.copyOf(copy, value);
  }

  /** What every tracked read keeps, once the value is in hand and its verdict known (see {@link getValue}). */
  private retainRead(
    path: string[],
    key: string | undefined,
    value: unknown,
    verdict: RedactionVerdict,
    description: string | undefined,
    handsValue: boolean,
  ) {
    if (handsValue) {
      if (verdict.kind !== 'clear' && value !== undefined) {
        this._selectedReads += 1;
        this.rememberSelected(value, verdict);
      } else if (key === undefined) {
        this.noteKeylessRead(path, value);
      }
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
      this.keepOnce(path, key, value, verdict);
    }
    if (description) {
      this.debug.addLog('message', `[READ] ${description}`);
    }
    return value;
  }

  /**
   * Keep what this read saw in {@link _stageReads}: once for each object a root key holds, not once for
   * each read of it. The rule, why it holds and what it leaves alone are in `keptReads.ts`.
   */
  private keepOnce(path: string[], key: string, value: unknown, verdict: RedactionVerdict): void {
    const atRoot = path.length === 0;
    const object =
      atRoot && verdict.kind === 'clear' && value !== null && typeof value === 'object' ? value : undefined;
    if (object !== undefined && this.keptReads.holds(key, object)) return;
    const slot = userKeyOf(path, key);
    this._stageReads[slot] =
      value === undefined ? undefined : retainedForm(verdict, value, this.policy.readTracking, summarizeReadValue);
    // The slot is told, not the key: a read at a path fills the slot its dotted name spells, and a root
    // key may bear that very name. What was held for that root no longer stands then.
    this.keptReads.kept(slot, value, object !== undefined);
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

  /**
   * {@link selectedReads} as the taint law asks it (`RedactionRule · retainStageText`, `serveThreshold`): a stage's
   * own effect key may be made of a selected value, so holding one counts as a read of it.
   */
  get taintedReads(): number {
    return this._selectedReads + (this._effectKeyTainted ? 1 : 0);
  }

  /**
   * A read past the tracked funnel still reads what the rule selects: a stage's silent read leaves no row but the value
   * is in its hands all the same, by the key's verdict or, with no key, by {@link noteKeylessRead}. Counted, never
   * retained or reported.
   */
  noteUntrackedRead(key: string | undefined, value: unknown): void {
    if (key === undefined) {
      this.noteKeylessRead([], value);
      return;
    }
    if (value === undefined) return;
    const verdict = activeRule(this.policy.redaction)?.verdictAt([], key);
    if (verdict === undefined || verdict.kind === 'clear') return;
    this._selectedReads += 1;
    // A handle the stage held reads this way, and after the stage's own write it reads NEW objects: they
    // are the hidden value's all the same, and keep its rule wherever they are written.
    this.rememberSelected(value, verdict);
  }

  /**
   * The stage asked for its input (`$getArgs()`): what the rule hides in it stays hidden wherever the
   * stage writes it (`HiddenObjectTrail · rememberInput`). Never counted as a selected read: the taint
   * law asks the input itself (`redaction.ts`, "the taint law").
   */
  noteInputRead(input: unknown, source?: unknown): void {
    if (activeRule(this.policy.redaction) !== undefined) this.trail.rememberInput(input, source);
  }

  /** An object read under a selected name, and every object inside it, keeps its rule wherever the stage writes it (`selectedObjects.ts`). */
  private rememberSelected(value: unknown, verdict: Exclude<RedactionVerdict, { kind: 'clear' }>): void {
    if (value !== null && typeof value === 'object') this.trail.remember(value, verdict);
  }

  /**
   * A read with no key hands the stage everything under `path`, so it counts when that holds a selected
   * name, and each selected value in it is remembered like one read by its key (`selectedObjects.ts`):
   * the value at a selected path, or, for the whole state, the value of each selected key (the keys of
   * every run namespace included).
   */
  private noteKeylessRead(path: readonly string[], value: unknown): void {
    const rule = activeRule(this.policy.redaction);
    if (value === undefined || rule === undefined) return;
    if (rule.holdsSelected(path, value)) this._selectedReads += 1;
    if (path.length > 0) {
      const verdict = rule.verdict(path);
      if (verdict.kind !== 'clear') this.rememberSelected(value, verdict);
      return;
    }
    const rememberKeys = (record: unknown): void => {
      if (record === null || typeof record !== 'object' || Array.isArray(record)) return;
      for (const [key, held] of Object.entries(record)) {
        const verdict = rule.verdictAt([], key);
        if (verdict.kind !== 'clear') this.rememberSelected(held, verdict);
      }
    };
    rememberKeys(value);
    const runs = (value as Record<string, unknown> | null)?.[RUN_NAMESPACE];
    if (runs !== null && typeof runs === 'object') for (const space of Object.values(runs)) rememberKeys(space);
  }

  private noteAndJudgeRead(path: string[], key?: string): RedactionVerdict {
    if (key !== undefined) this.record.noteRead(path, key);
    return this.judgeRead(path, key);
  }

  private judgeRead(path: string[], key?: string): RedactionVerdict {
    const rule = key !== undefined ? activeRule(this.policy.redaction) : undefined;
    return rule !== undefined ? rule.verdictAt(path, key as string) : CLEAR;
  }

  private readWithNativeSource(
    path: string[],
    key: string | undefined,
    privacy: () => 'visible' | 'redacted',
  ): unknown {
    const identity = this.#failureIdentity;
    const counts =
      this.readSources?.active && identity && key !== undefined
        ? (this.sourceReadCounter ??= new SourceReadCounter())
        : undefined;
    let judged = false;
    let hidden = false;
    const verdict = () => {
      judged = true;
      if (counts && !counts.observe()) this.readSources?.limit('source-capture-failed');
      const result = privacy();
      hidden = result !== 'visible';
      return result;
    };
    let value: unknown;
    try {
      if (key === undefined || !identity) {
        this.readSources?.limit(key === undefined ? 'untracked-read' : 'identity-unavailable');
        value = this.record.read(path, key);
        verdict();
      } else {
        if (!this.sourceAttempt) this.readSources?.ownership?.limit('attempt-unavailable');
        const read = this.record.readWithSource(
          path,
          key,
          { runtimeStageId: identity.runtimeStageId, ...(this.sourceAttempt && { attemptId: this.sourceAttempt }) },
          verdict,
        );
        value = read.value;
        if (read.occurrence && this.readSources?.active) {
          counts?.retain(read.occurrence.source.kind);
          this.readSources.ownership?.checkSelectedAddress(identity.runtimeStageId, read.occurrence.stateAddress);
        }
      }
    } catch (error) {
      // A successful native read keeps its prefix even when the verdict throws.
      // A native failure never enters the verdict and must not invent a read.
      if (judged) this.noteSourceRead(path, key, hidden, false);
      throw error;
    }
    if (judged) this.noteSourceRead(path, key, hidden, true);
    return value;
  }

  private noteSourceRead(path: string[], key: string | undefined, hidden: boolean, propagateFailure: boolean): void {
    try {
      if (key !== undefined) this.record.noteRead(path, key);
      if (hidden) this.readSources?.limit('privacy-active');
    } catch (error) {
      try {
        this.readSources?.limit('source-capture-failed');
      } catch {
        // Collector failures must not replace the original read/verdict error.
      }
      if (propagateFailure) throw error;
    }
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

  /**
   * The names of the root keys of committed state, as they stand now: what a subflow mapper may read
   * (`engine/handlers/mapperScope.ts`). Names only; a value is read through {@link readLiveRoot}.
   */
  rootKeys(): string[] {
    return Object.keys(this.record.state.getState());
  }

  /** Does committed state hold `key` at its root, as it stands now? A name is asked, no value is read. */
  hasRootKey(key: unknown): key is string {
    return typeof key === 'string' && Object.hasOwn(this.record.state.getState(), key);
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
    this.readSources?.limit('untracked-read');
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
    const rule = activeRule(this.policy.redaction);
    for (const key of Object.keys(this._stageReads)) {
      const retained = this._stageReads[key];
      // Only a container can be mutated in place; a primitive read cannot.
      if (retained === null || typeof retained !== 'object') continue;
      if (this._nestedReads?.has(key) || this._liveReads?.has(key)) continue;
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
   * - `_stageWrites` / `_stageReads` are NOT released — `ownSnapshot()`
   *   reads them post-run for the execution-tree snapshot.
   */
  commit(phase?: CommitPhase): void {
    try {
      this.commitRetained(phase);
    } catch (error) {
      this.capture?.limit('commit-retention-failed');
      throw error;
    } finally {
      // The stage is over, whether its commit landed or threw (an uncloneable value): every call it made that is
      // still running stops (P2), and nothing reports through the engine any more — a late record is refused before
      // it would reach it.
      this.endCalls(undefined);
      this._attemptReporter = undefined;
    }
  }

  private commitRetained(phase?: CommitPhase): void {
    // A continuation only AFTER the execution's own bundle (see above).
    const continuation = this._committed ? phase : undefined;
    this.followLateEdits();
    this.materialiseWrites();
    this.warnOnBorrowedMutation();
    // The record's half (foottrace's `RecordFrame · commit`). No buffer
    // = no write ever built one (#13): the commit is empty by construction,
    // recorded with ZERO clones. The names are read once the payload is built.
    const commitIndex = this.record.log?.length;
    this.record.commit(() => ({
      stage: this.stageName,
      stageId: this.stageId,
      runtimeStageId: this.runtimeStageId,
      untrackedSources: this._untrackedSources,
      tags: this.tags,
      phase: continuation,
    }));
    this.endMarksOfLandedDeletes();
    if (this.readSources?.active && this.#failureIdentity && commitIndex !== undefined)
      this.readSources.ownership?.commit(this.#failureIdentity.runtimeStageId, commitIndex);
    // The observer (ScopeFacade) sees the tracked mutations, THEN the staging
    // state is released (#13b), so it sees the world as it was. D2's markers
    // and the declared tags release with it — one stamp per execution, so the
    // engine's double-commit paths record them exactly once.
    if (this._commitObserver) {
      this._commitObserver({ ...this._stageWrites });
    }
    this.record.release();
    this._untrackedSources = undefined;
    this.keptReads.release();
    this.tags = undefined;
    this._committed = true;
  }

  /** Whether this frame has committed — a call's record arriving after it is late (P2, `ScopeFacade · call`). */
  get committed(): boolean {
    return this._committed;
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
   * What is deliberately KEPT: `debug` (logs, metrics, errors, flow messages)
   * and the attempt records (10.1). Both are the append-only record of what
   * every attempt did, and the retry feature's whole point is that the earlier
   * attempts stay visible.
   *
   * Also KEPT: what the attempt read under a selected name — the count
   * (`_selectedReads`, so {@link selectedReads} and {@link taintedReads} still
   * count it) and the objects it read (`HiddenObjectTrail`, so `stageWrite`
   * still hands their rule on). A later attempt can hold what a failed one
   * read (a closure, a module variable), and the library cannot tell, so a
   * selected read in any attempt marks the later ones: a threshold or break
   * reason they serve is masked, and such an object keeps its rule when a
   * later attempt writes it under another name. This is the conservative
   * side for redaction (test/lib/engine/security/retry-isolation.test.ts).
   *
   * No commit is recorded and no observer fires — a discarded attempt is not a
   * cursor stop, because from shared state's point of view it never happened.
   */
  discardStaged(): void {
    this.record.discard();
    // The staged deletes go with the rest: a delete that never landed ends no redaction mark.
    this._stagedDeletes = undefined;
    this._trail?.discard();
    this._untrackedSources = undefined;
    this._pendingWrites = undefined;
    this._stageWrites = {};
    this._stageReads = {};
    this._nestedReads = undefined;
    this._viewReads = undefined;
    this._liveReads = undefined;
    this.keptReads.release();
  }

  // ── Attempts (10.1) ────────────────────────────────────────────────────

  /** Append one attempt's record — the attempt runner calls this as each attempt ends. */
  recordAttempt(record: AttemptRecord): void {
    (this._attempts ??= []).push(record);
    (this._attention ??= new StageAttention(() => this.capture?.limit('attention-omitted'))).recordAttempt(
      record,
      this.runtimeStageId,
    );
    this.noteAttempt(record);
    // The stage attempt is over, however it ended: the calls it made stop (P2).
    this.endCalls(record.attempt);
  }

  /** Stamp the series' summary — once, when the runner ends the series. */
  endAttempts(summary: AttemptSummary): void {
    this._attemptSummary = summary;
    (this._attention ??= new StageAttention(() => this.capture?.limit('attention-omitted'))).recordSummary(summary);
  }

  /** Reset only at the node's execution stamp, never between attempts. */
  beginAttention(): void {
    this._attention?.begin();
  }

  /** Delegate the explicit retained-error fact; attention owns validation of its proof. */
  markStageFailure(): void {
    (this._attention ??= new StageAttention(() => this.capture?.limit('attention-omitted'))).stageFailed(
      this.debug.errorContext,
    );
  }

  /**
   * The crash-safe record (10.1, P6): an attempt that ended is noted in the run's sink AT ONCE, beside this frame's
   * log — so a process killed before the stage commits (mid-retry) still leaves every attempt that ended. The
   * record is the one the tree keeps: frozen, `structuredClone`-safe, its error the SERVED form (no `raw`), so the
   * note needs no second redaction pass. Without a sink the log does nothing (`EventLog · note`).
   */
  private noteAttempt(record: AttemptRecord, evidence?: Readonly<Record<string, unknown>>): void {
    this.record.log?.note('attempt', { record, ...evidence });
  }

  /** Capture-only invocation note; independent of staged business-state writes. */
  noteCallStart(data: Readonly<Record<string, unknown>>): void {
    const sourcePosition = this.captureEmitPosition();
    this.record.log?.note('attempt-start', { ...data, ...(sourcePosition && { sourcePosition }) });
  }

  /** The answered call may feed subsequent writes in this live owning attempt. */
  noteCallAnswerRead(attemptId: string): void {
    this.record.noteReadAttempt(attemptId);
  }

  /** The attempts of this execution so far, in order — its own and its calls'; `undefined` when there are none. */
  get attempts(): readonly AttemptRecord[] | undefined {
    return this._attempts;
  }

  /** The ended series' summary; `undefined` while it runs and without a policy. */
  get attemptSummary(): AttemptSummary | undefined {
    return this._attemptSummary;
  }

  /** The attempt about to run (and the run's signal) — `StageRunner` sets both before it builds the scope. */
  useAttempt(attempt: AttemptContext | undefined, runSignal: AbortSignal | undefined): void {
    // Scope preparation can read or throw before the function is entered. Only the actual-entry
    // funnel may grant source identity; the real retry context still belongs to the scope.
    this.sourceAttempt = undefined;
    if (this.captureClosureTracking) this.failureState.clearInvocationFailure();
    this._attempt = attempt;
    this._runSignal = runSignal;
  }

  /** Native function-entry fact, including the direct one-call path with no retry runner. */
  beginSourceInvocation(attempt: AttemptContext | undefined): void {
    if (!this.readSources?.active || !this.#failureIdentity) return;
    this.sourceInvocations++;
    // This is the engine observing the call it is about to make, not a reader guessing an old attempt.
    this.sourceAttempt = this.readSources.ownership?.attempt(
      this.#failureIdentity.runtimeStageId,
      attempt?.attempt ?? 1,
    );
  }

  /** @internal Called only immediately before an actual native function entry, never reconstructed from rows. */
  beginClosureInvocation(
    attempt: AttemptContext | undefined,
  ): Extract<SelectedNativeFailure, { kind: 'invocation' }> | undefined {
    const identity = this.#failureIdentity;
    if (!this.captureClosureTracking || !identity) return;
    const invocation = (this.closureInvocations ??= new NativeClosureInvocations()).begin(identity, attempt);
    if (invocation === 'counter-saturated') {
      this.captureExtent?.refuseClosure('counter-saturated');
      return;
    }
    return invocation;
  }

  /** The attempt now running; `undefined` for a stage the attempt runner does not run. */
  get attempt(): AttemptContext | undefined {
    return this._attempt;
  }

  /** The run's signal, as `StageRunner` last saw it. */
  get runSignal(): AbortSignal | undefined {
    return this._runSignal;
  }

  /**
   * Attempt `attempt` ended without an answer: from now on its scope is fenced — a write, an emit or a read
   * through it is refused (`ScopeFacade`). The runner calls this the moment the attempt's signal aborts.
   */
  endAttempt(attempt: number): void {
    if (this._attempt?.attempt === attempt) this.sourceAttempt = undefined;
    if (attempt > this._endedThrough) this._endedThrough = attempt;
    // Its calls stop at the same moment, with the attempt's own reason when its signal aborted (a cap or the
    // deadline is a time limit: a call it cuts timed out) — synchronous, ahead of the calls' own listeners.
    const current = this._attempt;
    const signal = current !== undefined && current.attempt === attempt ? current.signal : undefined;
    this.endCalls(attempt, signal?.aborted ? signal.reason : undefined);
  }

  /** Whether attempt `attempt` has ended — its scope may no longer touch the stage. */
  hasAttemptEnded(attempt: number): boolean {
    return attempt <= this._endedThrough;
  }

  /** Record a write an ended attempt tried — a name, never the value. Append-only evidence like the attempts. */
  recordLateWrite(write: LateWrite): void {
    const writes = (this._lateWrites ??= []);
    // Bounded: the first ones say what the abandoned attempt kept doing; a loop of them adds nothing.
    if (writes.length < MAX_LATE_WRITES) writes.push(Object.freeze({ ...write }));
  }

  // ── Side effects (P3) ──────────────────────────────────────────────────

  /** This execution's own idempotency key may be made of a selected value (or was carried by a checkpoint). */
  private _effectKeyTainted = false;
  /** A touching `$call` with NO key started in this execution — the stage may not be re-run by a resume. */
  private _keylessEffect = false;

  /**
   * Start an execution's side-effect bookkeeping (`FlowchartTraverser · executeStage`, before attempt 1) — reset,
   * because a frame can be re-used by a later execution. `keyTainted`: the stage's own key may be made of a selected
   * value, so a key a `$call` passes on (`$attempt().idempotencyKey`) is served the same way.
   */
  beginEffects(keyTainted: boolean): void {
    this._effectKeyTainted = keyTainted;
    this._keylessEffect = false;
  }

  get effectKeyTainted(): boolean {
    return this._effectKeyTainted;
  }

  /** A keyless touching `$call` started: an `interrupt()` after it would re-send it on resume (`StageRunner`). */
  markKeylessEffect(): void {
    this._keylessEffect = true;
  }

  get hasKeylessEffect(): boolean {
    return this._keylessEffect;
  }

  // ── Calls made inside the stage (P2) ───────────────────────────────────

  /** Where this execution's call records are reported — the engine sets it before the stage runs. */
  useAttemptReporter(
    report: ((record: AttemptRecord, structuredError: StructuredErrorInfo | undefined) => void) | undefined,
  ): void {
    this._attemptReporter = report;
  }

  /**
   * The signal the calls of stage attempt `stageAttempt` run under besides its own (P2): aborted when that attempt is
   * over — however it ended — and when the frame commits, so no call outlives the attempt that made it (no
   * background retry, no wait, no listener left on the run's signal). Already aborted after the commit.
   */
  callsEndedSignal(stageAttempt: number): AbortSignal {
    const ended = (this._callsEnded ??= new Map());
    let controller = ended.get(stageAttempt);
    if (controller === undefined) {
      controller = new AbortController();
      ended.set(stageAttempt, controller);
      if (this._committed) controller.abort(callsEndedReason());
    }
    return controller.signal;
  }

  /** End the calls of `stageAttempt` (every attempt's when `undefined`) — `reason` when the attempt's signal gave one. */
  private endCalls(stageAttempt: number | undefined, reason?: unknown): void {
    if (this._callsEnded === undefined) return;
    for (const [attempt, controller] of this._callsEnded) {
      if (stageAttempt !== undefined && attempt !== stageAttempt) continue;
      if (!controller.signal.aborted) controller.abort(reason ?? callsEndedReason());
    }
  }

  /** The next call's ordinal within stage attempt `stageAttempt`, 1-based (`attempt/call.ts · callSeries`). */
  nextCallOrdinal(stageAttempt: number): number {
    const ordinals = (this._callOrdinals ??= new Map());
    const next = (ordinals.get(stageAttempt) ?? 0) + 1;
    ordinals.set(stageAttempt, next);
    return next;
  }

  /**
   * A call's (or an observed) attempt record: kept beside the stage's own attempts — the first
   * {@link MAX_CALL_RECORDS}, the rest counted — and reported to the run's `onAttempt` either way. Like the stage's
   * records, NOT cleared by {@link discardStaged}: a failed attempt's calls are evidence too.
   */
  reportCallAttempt(
    record: AttemptRecord,
    structuredError: StructuredErrorInfo | undefined,
    evidence?: Readonly<Record<string, unknown>>,
  ): void {
    if (this._callRecords < MAX_CALL_RECORDS) {
      this._callRecords += 1;
      (this._attempts ??= []).push(record);
      (this._attention ??= new StageAttention(() => this.capture?.limit('attention-omitted'))).recordAttempt(
        record,
        this.runtimeStageId,
      );
      this.noteAttempt(record, evidence);
    } else {
      this._attemptsDropped += 1;
      (this._attention ??= new StageAttention(() => this.capture?.limit('attention-omitted'))).attemptDropped();
    }
    this._attemptReporter?.(record, structuredError);
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
      this.next.failureState = this.failureState;
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

  /**
   * This context and every one after it, as the list form of the execution tree: the stages in the
   * order they ran, a fork's children as `branches`, one list each. A loop, not recursion, builds
   * it, and its depth is how far forks nest, so a run of any length can be copied
   * (`structuredClone`) and saved (`JSON.stringify`).
   */
  getSnapshot(): StageSnapshot[] {
    const root: StageSnapshot[] = [];
    const work: Array<{ ctx: StageContext; chain: StageSnapshot[] }> = [{ ctx: this, chain: root }];
    while (work.length > 0) {
      const { ctx: head, chain } = work.pop()!;
      for (let ctx: StageContext | undefined = head; ctx; ctx = ctx.next) {
        const snap = ctx.ownSnapshot();
        chain.push(snap);
        if (ctx.children) {
          snap.branches = ctx.children.map((child) => {
            const branch: StageSnapshot[] = [];
            work.push({ ctx: child, chain: branch });
            return branch;
          });
        }
      }
    }
    return root;
  }

  /** @internal Snapshot of THIS context's own fields — `branches` is filled in by `getSnapshot`. */
  ownSnapshot(): StageSnapshot {
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
    if (this.readSources?.observing) {
      snapshot.readSourceCounts = this.sourceReadCounter?.snapshot() ?? EMPTY_SOURCE_READ_COUNTS;
      snapshot.readSourceInvocations = this.sourceInvocations;
    }
    if (this.captureClosureTracking) snapshot.nativeInvocations = this.closureInvocations?.count ?? 0;
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
    // A copy of the list (the records themselves are frozen): a reader of one snapshot never sees a later
    // attempt arrive in it, and never edits the frame's own list.
    if (this._attempts) snapshot.attempts = Object.freeze([...this._attempts]);
    if (this._attemptSummary) snapshot.attemptSummary = this._attemptSummary;
    if (this._lateWrites) snapshot.lateWrites = Object.freeze([...this._lateWrites]);
    if (this._attemptsDropped > 0) snapshot.attemptsDropped = this._attemptsDropped;
    const attention = this._attention?.snapshot();
    if (attention?.length) snapshot.attention = attention;
    return snapshot;
  }
}
