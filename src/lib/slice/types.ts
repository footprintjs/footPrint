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
