/**
 * types.ts — the record's types: a bundle, its rows, its patches, its encoding, and the
 * execution tree as the record's readers read it.
 *
 * Imports nothing. The record names nothing outside itself (C6, `RECORD_FILES` in
 * scripts/layering.config.cjs): the engine's frame types — the stage snapshot, the flow
 * messages, the retention dials — live beside the frame, in `frameTypes.ts` (L4).
 */

// ── Patch & Trace ──────────────────────────────────────────────────────────

/** A flat key-value bag representing a state patch (overwrite or merge). */
export interface MemoryPatch {
  [key: string]: any;
}

/** A single entry in the chronological operation trace. */
export interface TraceEntry {
  /** Canonical path string (segments joined by DELIM). */
  path: string;
  /**
   * Per-write read provenance (#P1) — the keys this stage had TRACKED-READ at
   * the moment this path was (last) written: the temporal-prefix attribution
   * that lets slices link a specific write to only the reads that could have
   * fed it (a stage reading `a,b` and writing `x,y` no longer implies x←b).
   * ABSENT unless the `writeProvenance: 'reads-prefix'` dial is on — charts
   * that never enable it keep byte-identical commit logs. Read prefixes only
   * grow during a stage, so under delta mode's one-entry-per-path dedup the
   * LAST write's prefix == the union across all of that path's writes.
   * Honest ceiling: a write with NO tracked reads before it records `[]` —
   * "depended on no tracked reads" is information, not absence.
   */
  readKeys?: string[];
  /**
   * - `'set'`    — hard overwrite; `overwrite[path]` holds the full final value.
   * - `'merge'`  — deep union merge; `updates[path]` holds the accumulated delta.
   * - `'append'` — (#13c-B, produced only under {@link CommitValuesMode}
   *   `'delta'`) the path's final value is its base value plus a tail of new
   *   trailing elements; `overwrite[path]` holds ONLY the tail. Replay
   *   reconstructs by concatenation. NOT idempotent — delta-mode bundles
   *   carry exactly one trace entry per surviving path.
   * - `'delete'` — (#13c-B, produced only under `'delta'`; absorbs backlog
   *   B8) the key was explicitly removed via `deleteValue()`. Replay removes
   *   the key. `overwrite[path]` still ENUMERATES the path (value
   *   `undefined`) so key-set consumers keep seeing the changed key.
   *
   * `overwrite` values are therefore VERB-QUALIFIED: consumers that read
   * `bundle.overwrite[key]` as "the full value written" must use
   * `commitValueAt(commitLog, idx, key)` (from `footprintjs/trace`) when the
   * log may contain delta-mode bundles.
   */
  verb: 'set' | 'merge' | 'append' | 'delete';
}

/**
 * RFC-003 D2 — read paths that BYPASS read tracking:
 * - `'args'`   — the stage called `getArgs()` / `$getArgs()` with non-empty
 *   run input (frozen, untracked by design)
 * - `'env'`    — the stage called `getEnv()` / `$getEnv()` with a non-empty
 *   execution environment (frozen, untracked by design)
 * - `'silent'` — the stage performed a silent read (`getValueSilent` /
 *   `getValueDirect`) of a key it never tracked-read in the same stage.
 *   Silent reads SHADOWED by a tracked read of the same key in the same
 *   stage (TypedScope array-proxy internals, `$batchArray`) are NOT
 *   flagged — their read→write edge is already captured.
 */
export type UntrackedSource = 'args' | 'env' | 'silent';

/** The atomic bundle produced by TransactionBuffer.commit(). */
export interface CommitBundle {
  /** Auto-assigned step index (set by EventLog.record). */
  idx?: number;
  /** Human-readable stage name. */
  stage: string;
  /** Stable stage identifier (matches spec node id). */
  stageId: string;
  /** Unique per-execution-step identifier. Format: [subflowPath/]stageId#executionIndex */
  runtimeStageId: string;
  /** Chronological write log for deterministic replay. */
  trace: TraceEntry[];
  /** Paths that should be redacted in UI (sensitive data). */
  redactedPaths: string[];
  /** Hard overwrite patches. */
  overwrite: MemoryPatch;
  /** Deep merge patches. */
  updates: MemoryPatch;
  /**
   * RFC-003 D2 honesty markers — untracked read paths this stage consumed
   * (see {@link UntrackedSource}). ABSENT when the stage used none, so
   * charts that never touch those paths keep byte-identical commit logs.
   * Causal-slice consumers (`causalChain`/`formatCausalChain`) surface this
   * as "slice may be incomplete here". Residual limitation (by design):
   * values smuggled through JS closures are undetectable.
   */
  untrackedSources?: ReadonlyArray<UntrackedSource>;
  /**
   * Declared tags (9.21.0) — the names the author put on this stage at build
   * time (`FlowChartBuilder.tag` / `options.tags`), stamped here by the
   * traverser so a stored recording carries its own milestones without a
   * consumer's id conventions. ABSENT when the stage declares none, so an
   * untagged chart's log is byte-identical to 9.20.0 (the law
   * `untrackedSources` keeps). Recorded on the FIRST bundle of each execution
   * of the stage — the stage's own bundle, the one without a `phase` — so
   * retry attempts stamp it once, a continuation (a fork child's `'repeat'`,
   * a mount's `'exit'` after its merge-back) carries none, and a mount whose
   * exit is its only bundle (no `outputMapper`) carries them on that bundle. Free strings: footprintjs assigns
   * them no meaning; `tagStops` (footprintjs/trace) keeps a stop when any of
   * them matches.
   */
  tags?: readonly string[];
  /**
   * Which CONTINUATION of a stage's execution this bundle is (9.39.0) —
   * stamped by the WRITER. THE LAW: the FIRST bundle per `runtimeStageId` is
   * the stage's own and carries NO `phase`; only a bundle after it can:
   *
   * - `'exit'` — a subflow mount's exit commit (`SubflowExecutor`) after its
   *   merge-back bundle (`outputMapper`). A mount without a merge-back (a lazy
   *   mount, every `parallelForEach` branch, any mount with no mapper) has
   *   its exit as its ONLY bundle — its own, so no `phase`; the execution
   *   tree names it a mount.
   * - `'repeat'` — the fan-out's settle commit of a fork child's frame
   *   (`ChildrenExecutor`), after the child's own bundle.
   *
   * A reader groups a stage's bundles by `runtimeStageId` and reads this
   * field to know what each continuation is; it never infers it from the
   * log's shape. A log written before 9.39.0 carries no `phase` anywhere —
   * see `inferLegacyPhases` (footprintjs/trace) for how it is still read.
   */
  phase?: CommitPhase;
}

/** The continuation a bundle records — see {@link CommitBundle.phase}. */
export type CommitPhase = 'exit' | 'repeat';

/**
 * Per-write read-provenance policy (#P1) — the fourth dial of the
 * readTracking/writeTracking/commitValues family, same 6-site propagation
 * pattern (executor option → ExecutionRuntime.use* → root StageContext →
 * createNext/createChild inheritance → SubflowExecutor duck-push).
 *
 * - `'off'` (default) — zero cost, byte-identical commit logs.
 * - `'reads-prefix'` — every committed {@link TraceEntry} carries
 *   `readKeys`: the keys tracked-read BEFORE that write (temporal-prefix
 *   attribution). Cost: one Set-to-array copy per write. Consumed by
 *   `causalChain`'s `edgeAttribution: 'per-write'` and the slice layer.
 */
export type WriteProvenanceMode = 'off' | 'reads-prefix';

/**
 * Policy for how commit-bundle VALUES are encoded into the commit log
 * (#13c-B) — completes the `readTracking`/`writeTracking` dial family.
 * Unlike those two (which gate lossy snapshot bookkeeping), this dial is
 * **lossless in both modes** — it changes the commit log's *encoding*,
 * never its *information*; any step's full state stays exactly
 * reconstructable by replay.
 *
 * - `'full'` (default) — every surviving `set` path stores the full final
 *   value, one trace entry per operation. Byte-identical to the historical
 *   behavior.
 * - `'delta'` — two changes, both replay-covered by `applySmartMerge`:
 *   1. **`append` detection**: when a path's net change is "the base array
 *      plus new trailing elements" (strict prefix), the bundle records ONLY
 *      the tail under a `verb: 'append'` trace entry — the growing-history
 *      commit log becomes linear in tail size instead of O(N²) retained.
 *      A real `verb: 'delete'` entry replaces the `set: undefined` flattening
 *      for `deleteValue()` (closes the documented MemoryPatch limitation).
 *   2. **One trace entry per surviving path** (append is not idempotent on
 *      replay): the verb is resolved from the path's base→final relationship
 *      and op mix; entries are ordered by each path's LAST touch.
 *
 * Honest cost note: append detection is NEW wall work — an O(|base|)
 * structural prefix compare per array-set path per commit (today's
 * `deepEqual` fast-fails on length in O(1) for a grown array). On a hit the
 * commit gets cheaper in both wall and heap (the O(|final|) clone shrinks to
 * O(|tail|)); on a miss it pays compare + full clone. `'full'` pays zero —
 * the detection branch is mode-gated.
 *
 * Set via `new FlowChartExecutor(chart, { commitValues })` or
 * `executor.setCommitValues(mode)` (before `run()`). The active mode is
 * surfaced as the snapshot discriminant `RuntimeSnapshot.commitValues`.
 */
export type CommitValuesMode = 'full' | 'delta';

// ── The execution tree, as the record's readers read it ────────────────────

/**
 * The execution tree as the record's readers read it (C6): the fields a reader touches and
 * nothing else. `commitStops` (and so `tagStops` and every strategy built on it) reads the mount
 * marker (`subflowId`) and the root's `id`; `keysReadFromExecutionTree` reads the keys of
 * `stageReads`; both key on `runtimeStageId` and walk `next` and `children`.
 *
 * A structural type the record owns, so the readers name nothing of the engine. The engine's
 * `StageSnapshot` (`getSnapshot().executionTree`) is one — a supertype of it, so every caller
 * that hands a snapshot's tree over compiles unchanged — and so is a stored recording's parsed
 * JSON with these fields. Every field is optional: a reader that finds one absent reads on.
 *
 * @example
 * ```typescript
 * import { type ExecutionTree, keysReadFromExecutionTree } from 'footprintjs/trace';
 *
 * const tree: ExecutionTree = {
 *   runtimeStageId: 'seed#0',
 *   next: { runtimeStageId: 'decide#1', stageReads: { creditTier: 'A' } },
 * };
 * keysReadFromExecutionTree(tree).lookup('decide#1'); // ['creditTier']
 * ```
 */
export interface ExecutionTree {
  /** The stage's id (prefixed inside a subflow). `commitStops` reads the root's to place a subflow's seed. */
  readonly id?: string;
  /** `[subflowPath/]stageId#executionIndex` — what a reader keys on. A node without one is not a stage. */
  readonly runtimeStageId?: string;
  /** Present on a subflow mount: the stop there says `kind: 'mount'`. */
  readonly subflowId?: string;
  /** What the stage tracked-read, by key. Only the KEYS are read: a `'summary'` marker serves as well as a value. */
  readonly stageReads?: Readonly<Record<string, unknown>>;
  /** The stage that ran next. */
  readonly next?: ExecutionTree;
  /** The stages that ran as this one's children (a fork's branches, a decider's chosen branch). */
  readonly children?: readonly ExecutionTree[];
}
