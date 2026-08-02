/**
 * slice/types.ts — data shapes of the variable-first slicing layer.
 *
 * WHY THIS LIBRARY EXISTS (context for future readers, human or LLM):
 * `causalChain()` (memory/backtrack.ts) answers "what influenced this STEP?"
 * — its address space is runtimeStageIds. But every triage consumer starts
 * from a VARIABLE: a human clicks the key `creditTier` in a UI; an LLM tool
 * call asks "where did history[7] come from?". This library is the address
 * translation layer: variable in → slice out. It deliberately adds NO new
 * capture and NO new graph algorithm — it composes the commit-log primitives
 * (findLastWriter / causalChain / the per-key verb fold) so every surface
 * (UI panel, LLM tool, offline autopsy agent) asks the question the same way
 * and gets the same, honestly-labeled answer.
 *
 * Both directions live here: BACKWARD ("why is `key` what it is" —
 * {@link VariableSlice}) and FORWARD ("who read it, and what did it feed" —
 * {@link ForwardSlice}, {@link KeyTimeline}). Same anchor idiom, same
 * `KeysReadSource` strategies, same honesty vocabulary.
 *
 * DAG position: memory ← slice. This module may import ONLY from memory/.
 * Recorders, engine, and runner must never be imported here — that is what
 * keeps it a tiny, separately-evolvable library (see README.md).
 */

import type { CausalNode, KeysReadLookup } from '../memory/backtrack.js';
import type { CommitBundle, TraceEntry, UntrackedSource } from '../memory/types.js';

// ── Keys ───────────────────────────────────────────────────────────────────

/**
 * A state key as consumers know it: either the plain top-level key string, or
 * a path array for nested keys (`['customer', 'address']`). Path arrays are
 * normalised internally — the engine's path delimiter never appears in this
 * public contract.
 */
export type StateKey = string | ReadonlyArray<string | number>;

// ── KeysRead sourcing (strategy interface) ─────────────────────────────────

/**
 * STRATEGY INTERFACE: where per-stage read keys come from. THE canonical
 * strategy list lives here (implementations in keysReadSources.ts):
 *
 * Reads are deliberately NOT in the commit log (CommitBundle carries only the
 * `untrackedSources` honesty flags), so a slice needs a reads provider. There
 * are several legitimate providers with different trade-offs, and new ones
 * will appear — hence an interface rather than a hardcoded path:
 *
 * - `keysReadFromExecutionTree` — post-hoc, ZERO setup: reads live in the
 *   snapshot's `StageSnapshot.stageReads` whenever `readTracking` ≠ 'off'
 *   (default 'full'; 'summary' still keeps the keys). Use when you have a
 *   finished run's snapshot.
 * - `keysReadFromMap` — a prebuilt Map/object, e.g. collected live from
 *   `ScopeRecorder.onRead` events or deserialized from a stored trace.
 * - a bare `KeysReadLookup` function — anything else (e.g. QualityRecorder:
 *   `(id) => rec.getByKey(id)?.keysRead ?? []`). Wrapped as kind 'custom-fn'.
 *
 * `kind` is a debugging/honesty breadcrumb: `VariableSlice.keysReadKind`
 * records which strategy produced the slice, so a surprising slice can be
 * traced back to its reads provider.
 */
export interface KeysReadSource {
  /** Discriminator surfaced on {@link VariableSlice.keysReadKind}. */
  readonly kind: string;
  /** The lookup `causalChain` will call per visited node. */
  readonly lookup: KeysReadLookup;
  /**
   * OPTIONAL honesty telemetry a strategy can compute while it builds:
   * how many execution steps it saw, and how many actually had read entries.
   * `stepsWithReads === 0` over a multi-step run is the machine-detectable
   * signature of `readTracking: 'off'` — WITHOUT this, a reads-less slice is
   * indistinguishable from "genuinely no upstream dependencies", which is a
   * lie a triage tool must never tell. Copied onto
   * {@link VariableSlice.readsCoverage}.
   */
  readonly coverage?: ReadsCoverage;
}

/** See {@link KeysReadSource.coverage}. */
export interface ReadsCoverage {
  /** Execution steps the strategy saw (nodes with a runtimeStageId). */
  readonly steps: number;
  /** Of those, steps that had at least one recorded read key. */
  readonly stepsWithReads: number;
}

// ── Variable slice ─────────────────────────────────────────────────────────

/**
 * Why a slice could not be produced. Honest absence is a first-class result:
 * - `'empty-log'`     — there are no commits at all (run never executed, or
 *   snapshot came from elsewhere).
 * - `'never-written'` — no commit in range wrote `key`. The value (if any)
 *   came from the run's INITIAL state, run `input` (frozen args channel), or
 *   a closure — none of which the commit log can see. Same blind spot as
 *   `findLastWriter`.
 */
export type MissingSliceReason = 'empty-log' | 'never-written';

/**
 * The result of a variable-first backward slice: "why is `key` what it is?".
 *
 * Anchoring rule: the slice is rooted at the LAST writer of `key` (before
 * `before`, when given) — the commit that made the value what it currently
 * is. Everything upstream of that writer is reached through the causal DAG.
 *
 * SERIALIZATION WARNING: `root` is an in-memory DAG — nodes appear in BOTH
 * `parents` and `parentEdges[].parent`, and shared ancestors (diamonds) are
 * the same object reached through many paths. `JSON.stringify(slice)`
 * duplicates every shared subtree per path and explodes combinatorially.
 * Never stringify it: use `sliceToJSON()` (flat, id-referenced, linear) for
 * wire transfer or `formatSlice()` (bounded string) for LLM tools.
 */
export interface VariableSlice {
  /** The state key that was asked about (normalised string form). */
  key: string;
  /**
   * Exclusive commit-array-index upper bound the writer search was anchored
   * at ("as it stood before this idx"). Undefined = the whole log (current
   * value).
   */
  before?: number;
  /** The commit that last wrote `key` — the slice anchor. Absent when missing. */
  writer?: CommitBundle;
  /**
   * The backward causal DAG rooted at the writer (same `CausalNode` shape as
   * `causalChain` — parentEdges carry keyed data/control edges, honesty via
   * `incompleteSources`/`truncated`). Absent when missing. See the
   * serialization warning on this interface before stringifying.
   */
  root?: CausalNode;
  /** Present ONLY when `root` is absent — why there is no slice. */
  missing?: MissingSliceReason;
  /** Which {@link KeysReadSource} strategy resolved reads (honesty/debug). */
  keysReadKind: string;
  /**
   * Honesty telemetry copied from the strategy when it provides one — see
   * {@link KeysReadSource.coverage}. A root with no parents AND
   * `stepsWithReads === 0` means "reads were not recorded", NOT "no
   * dependencies"; triage tools must say so.
   */
  readsCoverage?: ReadsCoverage;
}

// ── Forward slice (the forward half: "what did this value FEED?") ─────────

/**
 * How a `fed` edge was attributed — the honesty axis of the FORWARD walk,
 * the mirror of {@link AttributionBasis} for the backward one. The two words
 * are deliberately `causalChain`'s `edgeAttribution` values, because they
 * name the same two mechanisms:
 *
 * - `'per-write'` — EXACT. The child's write carries per-write read
 *   provenance (`TraceEntry.readKeys`, recorded under the executor's
 *   `writeProvenance: 'reads-prefix'` dial) and this key is IN it: the value
 *   was read before that write, so it could feed it. The same provenance
 *   also EXCLUDES exactly: a write whose `readKeys` omit this key gets no
 *   edge at all.
 * - `'stage'` — CONSERVATIVE. The child's write carries no `readKeys` (the
 *   dial was off, or the log is mixed), so all that is known is stage-level
 *   co-occurrence: the stage read this key and wrote that one, in some order
 *   this log cannot see. A sound over-approximation — the edge may not be
 *   real. Never presented as exact: every conservative edge is stamped here
 *   AND summarised once on the slice as a `'conservative-fed-edges'`
 *   {@link HonestyNote}.
 */
export type FedBasis = 'per-write' | 'stage';

/**
 * A machine-readable honesty statement about a forward query's answer.
 * Codes (a consumer BRANCHES on `code`; `detail` is the sentence to show):
 *
 * - `'conservative-fed-edges'` — at least one `fed` edge is stage-level
 *   ({@link FedBasis}). Turn on `writeProvenance: 'reads-prefix'` for exact
 *   edges.
 * - `'pre-run-origin'` — the value being followed was already there before
 *   the first write this log can see (initial state, frozen run `input`, or
 *   a closure) — the same blind spot `missing: 'never-written'` names on the
 *   backward side.
 * - `'reads-not-recorded'` — this log carries no recorded read AT ALL (the
 *   `readTracking: 'off'` signature). "Nobody read it" is then UNKNOWABLE,
 *   not true — and no forward answer over this log can be complete.
 * - `'unknown-key'` — this log has no write and no recorded read of the key.
 *   The detail NAMES a bounded list of the keys it does know, because the
 *   overwhelmingly likely cause is a typo (or the wrong run's log), and a
 *   typo must never read as "this variable has no history".
 * - `'truncated'` — a budget (`maxDepth`/`maxNodes`) cut the walk. Stated,
 *   never silent.
 */
export type HonestyNoteCode =
  | 'conservative-fed-edges'
  | 'pre-run-origin'
  | 'reads-not-recorded'
  | 'unknown-key'
  | 'truncated';

/** One honesty statement — see {@link HonestyNoteCode}. */
export interface HonestyNote {
  code: HonestyNoteCode;
  /** One human/LLM-readable sentence. Rendered by the formatters as `⚠ …`. */
  detail: string;
}

/**
 * ONE recorded read of a key inside a value's live range: which execution
 * step read it, and where that step sits in the commit log. Both join keys
 * are carried (`runtimeStageId` for recorders/UIs, `commitIdx` for the log).
 */
export interface ForwardRead {
  runtimeStageId: string;
  stageId: string;
  stageName: string;
  /** Commit ARRAY position of the READING stage's own commit bundle. */
  commitIdx: number;
}

/**
 * A `fed` edge: the parent node's value was live and read by a stage, and
 * that same stage wrote `child`. The reader IS the child's writer — that is
 * why the edge carries no separate "via" step.
 */
export interface ForwardEdge {
  child: ForwardNode;
  /** Exact (`'per-write'`) or conservative (`'stage'`) — see {@link FedBasis}. */
  basis: FedBasis;
}

/**
 * ONE LIFE of one key's value — the forward mirror of {@link CausalNode}.
 *
 * A value's life starts at a write and ends at the key's NEXT write
 * (`nextWriteIdx`). Reads inside that window saw THIS value; the writes
 * those readers made are this value's `fedEdges`.
 *
 * SERIALIZATION WARNING (same as {@link VariableSlice}): `fedEdges` form an
 * in-memory DAG with SHARED nodes — two different values read by one stage
 * feed the same child write. `JSON.stringify` re-serializes shared subtrees
 * per path. Use `forwardSliceToJSON()` / `formatForwardSlice()`.
 */
export interface ForwardNode {
  /** The state key whose value this is (normalised string form). */
  key: string;
  /**
   * - `'write'` — a commit in this log started this life.
   * - `'pre-run'` — the value was already there before the log's first write
   *   of the key (initial state / frozen `input` / a closure). The
   *   identity/verb fields below are ABSENT: the commit log genuinely does
   *   not know who put it there.
   */
  origin: 'write' | 'pre-run';
  /** Execution step that wrote it. Absent for a `'pre-run'` origin. */
  runtimeStageId?: string;
  /** Stable stage identifier of the writer. Absent for `'pre-run'`. */
  stageId?: string;
  /** Human-readable stage name of the writer. Absent for `'pre-run'`. */
  stageName?: string;
  /** Commit ARRAY position of the write. Absent for `'pre-run'`. */
  commitIdx?: number;
  /** The trace verb of that write. Absent for `'pre-run'`. */
  verb?: TraceEntry['verb'];
  /**
   * Commit ARRAY position of the key's NEXT write — where this value's life
   * ends. Absent = still live at the end of the log. Reads AT this index
   * still belong to THIS life: reads fire before their stage's commit.
   */
  nextWriteIdx?: number;
  /** BFS depth from the anchor (0 = the anchor value). */
  depth: number;
  /** Recorded reads of `key` inside this life, in commit order. */
  reads: ForwardRead[];
  /** What this value fed — one edge per downstream write. */
  fedEdges: ForwardEdge[];
  /**
   * Honesty marker copied from the writer's `CommitBundle.untrackedSources`
   * — identical meaning to {@link CausalNode.incompleteSources}.
   */
  incompleteSources?: ReadonlyArray<UntrackedSource>;
  /** Set on the ROOT only, and only when a budget actually cut the walk. */
  truncated?: { byDepth: boolean; byNodes: boolean };
}

/**
 * The result of a forward slice: "who READ this value, and what did it
 * FEED?" — the mirror of {@link VariableSlice}.
 *
 * Anchoring rule is the backward one, unchanged: the LAST write of `key`
 * (before `before`, when given). What differs is the direction of the walk —
 * `before` bounds the ANCHOR search only; the walk then runs forward past it,
 * because "what did the value at step 12 go on to feed?" is the question.
 *
 * ABSENCE, split by what the recording affords (a typo must never read as
 * "this variable has no history"):
 * - `'empty-log'` — nothing executed.
 * - `'never-written'` — no write AND no recorded read of the key, in a log
 *   that DOES carry recorded reads. The log can see readers and this key has
 *   none, so "no history" is a finding, not a blind spot: no root node, and
 *   an `'unknown-key'` {@link HonestyNote} names the keys the log does know.
 * - otherwise a key with no write still gets a `'pre-run'` origin life —
 *   the value came from initial state / `input` / a closure and stages read
 *   it. When the log carries NO recorded reads at all, that pre-run node is
 *   the only honest answer and always ships the `'reads-not-recorded'` note:
 *   a typo and an unread seeded key are genuinely indistinguishable then.
 */
export interface ForwardSlice {
  /** The state key that was asked about (normalised string form). */
  key: string;
  /** Exclusive commit-array-index bound the ANCHOR search used. */
  before?: number;
  /** The commit that wrote the anchor value. Absent for a pre-run origin. */
  writer?: CommitBundle;
  /** The forward DAG rooted at the anchor value. Absent when `missing`. */
  root?: ForwardNode;
  /** Present ONLY when `root` is absent — see {@link MissingSliceReason}. */
  missing?: MissingSliceReason;
  /** Which {@link KeysReadSource} strategy resolved reads (honesty/debug). */
  keysReadKind: string;
  /** Honesty telemetry from the strategy — see {@link KeysReadSource.coverage}. */
  readsCoverage?: ReadsCoverage;
  /** Always present (possibly empty) — see {@link HonestyNote}. */
  notes: HonestyNote[];
}

/** One moment in a key's life: a write, or a recorded read. */
export interface KeyMoment {
  kind: 'write' | 'read';
  /**
   * Commit ARRAY position — for a `'write'` its own commit, for a `'read'`
   * the READING stage's commit. With `runtimeStageId` these are the two
   * universal join keys (to the commit log, and to recorders/UIs).
   */
  commitIdx: number;
  runtimeStageId: string;
  stageId: string;
  stageName: string;
  /** `'write'` moments only: the trace verb of the write. */
  verb?: TraceEntry['verb'];
  /**
   * `'read'` moments only: the `commitIdx` of the write whose live range
   * this read sits in — which value it saw. ABSENT when the read precedes
   * every write of the key (pre-run origin: initial state / `input` /
   * closure).
   */
  fromWriteIdx?: number;
}

/**
 * The whole life of one key in commit order — every write and every recorded
 * read. The flat, chronological companion to {@link ForwardSlice}: no graph,
 * no budgets, no live references (already JSON-safe by construction).
 */
export interface KeyTimeline {
  /** The state key that was asked about (normalised string form). */
  key: string;
  /** Exclusive commit-array-index bound: only moments before this index. */
  before?: number;
  /** Writes and reads in commit order. Absent when `missing`. */
  moments?: KeyMoment[];
  /**
   * Present ONLY when `moments` is absent — same split as
   * {@link ForwardSlice}: `'empty-log'` when nothing executed,
   * `'never-written'` when a log that DOES carry recorded reads has neither
   * a write nor a read of this key (an `'unknown-key'` note then names the
   * keys it knows).
   */
  missing?: MissingSliceReason;
  /** Which {@link KeysReadSource} strategy resolved reads (honesty/debug). */
  keysReadKind: string;
  /** Honesty telemetry from the strategy — see {@link KeysReadSource.coverage}. */
  readsCoverage?: ReadsCoverage;
  /** Always present (possibly empty) — see {@link HonestyNote}. */
  notes: HonestyNote[];
}

/**
 * Flat, id-referenced, JSON-safe projection of a {@link ForwardSlice} — the
 * forward twin of {@link SliceJSON}, and for the same reason (shared nodes;
 * see the serialization warning on {@link ForwardNode}).
 *
 * Node ids differ from `SliceJSON`'s deliberately: a forward node is a
 * (key, write) pair, so one `runtimeStageId` can host several nodes (a stage
 * writing two keys). Ids are therefore OPAQUE, assigned in BFS order —
 * never parse them; join on `runtimeStageId` / `commitIdx` / `key`, which
 * every node carries.
 */
export interface ForwardSliceJSON {
  key: string;
  before?: number;
  missing?: MissingSliceReason;
  keysReadKind: string;
  readsCoverage?: ReadsCoverage;
  notes: HonestyNote[];
  /** Opaque id of the anchor node. Absent when `missing`. */
  rootId?: string;
  /** Every DAG node exactly once, in BFS order. */
  nodes?: Array<{
    id: string;
    key: string;
    origin: 'write' | 'pre-run';
    runtimeStageId?: string;
    stageId?: string;
    stageName?: string;
    commitIdx?: number;
    verb?: TraceEntry['verb'];
    nextWriteIdx?: number;
    depth: number;
    reads: ForwardRead[];
    incompleteSources?: ReadonlyArray<UntrackedSource>;
  }>;
  /** Id-referenced edges: parent (`from`) fed child (`to`). */
  edges?: Array<{ from: string; to: string; basis: FedBasis }>;
  /** Copied from the root when a budget cut the walk. */
  truncated?: { byDepth: boolean; byNodes: boolean };
}

// ── Element provenance (append-fold) ───────────────────────────────────────

/**
 * How an element's birth commit was determined — the honesty axis of
 * append-fold provenance. Ordered strongest → weakest:
 *
 * - `'append-verb'`      — the engine RECORDED this tail append
 *   (`commitValues: 'delta'`). Exact by construction.
 * - `'prefix-inference'` — a full-value write preserved the previous array as
 *   a strict prefix, so the new tail is attributed to this commit. Heuristic:
 *   a writer that REPLACED the array with one that happens to share the old
 *   prefix is indistinguishable from an append. Right in practice (push-style
 *   growth), labeled honestly so consumers can tell.
 * - `'whole-value'`      — the array was (re)placed wholesale; every
 *   element's provenance resets to this commit. Exact but coarse.
 */
export type AttributionBasis = 'append-verb' | 'prefix-inference' | 'whole-value';

/**
 * The birth record of ONE array element: which commit (and therefore which
 * stage execution) first put it there. This is what turns the agent
 * mega-key problem ("everything depends on `history`") into element-level
 * answers ("history[7] was appended by tool-calls#41 in iteration 3").
 *
 * @see elementProvenance — the query that returns this record.
 */
export interface ElementBirth {
  /** Element index in the reconstructed array at query time. */
  index: number;
  /** Commit ARRAY position (the `CommitBundle.idx` space) of the birth. */
  commitIdx: number;
  /** Execution step that wrote it — joins to slices, recorders, UIs. */
  runtimeStageId: string;
  /** Stable stage identifier of the writer. */
  stageId: string;
  /** Human-readable stage name of the writer. */
  stageName: string;
  /** The trace verb of the birth commit's entry for this key. */
  verb: TraceEntry['verb'];
  /** How the attribution was determined — see {@link AttributionBasis}. */
  basis: AttributionBasis;
  /**
   * The element's value as of the fold (detached clone). Redaction note:
   * values are re-served exactly as the commit log stored them — a redacted
   * key's `'[REDACTED]'` placeholder stays redacted; this layer never
   * resurrects originals.
   */
  value: unknown;
}

/**
 * Why element provenance could not be produced (mirrors
 * {@link MissingSliceReason} — one honest-absence pattern module-wide):
 * - `'empty-log'`     — no commits at all.
 * - `'never-written'` — no commit in range touched the key.
 * - `'not-an-array'`  — the key WAS written but its folded value is not an
 *   array at the queried point: a scalar/object key, a deleted key, or a
 *   merge that degraded it. Element provenance is an array concept — for
 *   scalar keys the right query is `sliceForKey`.
 */
export type MissingProvenanceReason = 'empty-log' | 'never-written' | 'not-an-array';

/**
 * Element-level provenance for one array-valued key. Mirrors
 * {@link VariableSlice}'s honest-absence shape: on success `atIdx`/`length`/
 * `births` are set; otherwise `missing` says why (present ONLY when `births`
 * is absent).
 *
 * @see arrayProvenance — the query that returns this.
 * @see ElementBirth — one record per element, index-aligned.
 */
export interface ArrayProvenance {
  /** The state key (normalised string form). */
  key: string;
  /** Inclusive commit array idx the fold ran to. Absent when missing. */
  atIdx?: number;
  /** Length of the reconstructed array (births.length === length). */
  length?: number;
  /** One birth per element, index-aligned with the reconstructed array. */
  births?: ElementBirth[];
  /** Present ONLY when `births` is absent — why there is no provenance. */
  missing?: MissingProvenanceReason;
}

// ── JSON-safe serialization (for wire transfer / LLM tools) ────────────────

/**
 * Flat, id-referenced, JSON-safe projection of a {@link VariableSlice} —
 * linear in node count (each node serialized exactly once; edges reference
 * ids). THE shape to persist, send over the wire, or hand to structured
 * consumers. See the serialization warning on {@link VariableSlice}.
 */
export interface SliceJSON {
  key: string;
  before?: number;
  missing?: MissingSliceReason;
  keysReadKind: string;
  readsCoverage?: ReadsCoverage;
  /** runtimeStageId of the anchor writer. Absent when missing. */
  writerId?: string;
  /** Every DAG node exactly once, keyed by runtimeStageId. */
  nodes?: Record<
    string,
    {
      stageId: string;
      stageName: string;
      keysWritten: string[];
      depth: number;
      incompleteSources?: ReadonlyArray<UntrackedSource>;
    }
  >;
  /** Id-referenced edges: child (`from`) depends on parent (`to`). */
  edges?: Array<{ from: string; to: string; kind: 'data' | 'control'; key?: string; weight: number }>;
  /** Copied from the root when a budget cut the slice. */
  truncated?: { byDepth: boolean; byNodes: boolean };
}
