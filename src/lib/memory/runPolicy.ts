/**
 * RunPolicy — what a run retains, encodes and scrubs, as ONE immutable object (F5).
 *
 * WHY. A run carries six settings that every stage frame must agree on: the four
 * observability dials (`readTracking`, `writeTracking`, `commitValues`, `writeProvenance`),
 * the redaction rule, and whether a redacted mirror is kept. Until 9.34.0 each one was
 * copied field by field down three separate paths — `ExecutionRuntime.use*` on the root,
 * `StageContext.createNext`/`createChild` (six assignments each), and a duck-typed push per
 * dial in `SubflowExecutor` — so a new dial meant six edits, and a missed one ran a subflow
 * on the default silently. Now the executor builds ONE policy per run (and per resume), the
 * runtime installs it on its root frame, and every frame holds it BY REFERENCE: a child, a
 * continuation and a subflow's root (its seed frame included) all point at the same object.
 * The borrowed idea is Go's `context.Context` / OpenTelemetry's `Context`: an immutable value
 * handed down, never copied apart.
 *
 * ADDING A DIAL is two files: a field + its default here ({@link RunDials},
 * {@link DIAL_DEFAULTS}), and the frame code that reads `policy.<dial>` (`StageContext`). The
 * executor's options inherit {@link RunDials}, picks them with {@link pickDials}, and every
 * propagation path carries the whole object — none of them names a dial.
 *
 * ```ts
 * const policy = runPolicy({ commitValues: 'delta' }, rule, true);
 * policy.readTracking; // 'full' — an absent dial is its default
 * Object.isFrozen(policy); // true — a frame can never edit what its siblings share
 * ```
 *
 * The RULE inside is shared too, and is itself stateful by design (per-call `setValue(k, v,
 * true)` marks a key on it for the rest of the run); the policy freezes which rule, not the
 * rule's marks. The mirror STORE is not policy — each runtime (a subflow has its own) keeps
 * its own store when `mirror` is set.
 */

import type { ReadTrackingMode, WriteTrackingMode } from './frameTypes.js';
import type { RedactionRule } from './redaction.js';
import type { CommitValuesMode, WriteProvenanceMode } from './types.js';

/**
 * The four observability dials as an executor takes them — every field optional, an absent
 * one is its default. `FlowChartExecutorOptions` extends this interface.
 */
export interface RunDials {
  /**
   * Policy for `StageSnapshot.stageReads` (#14). Default `'full'` — every
   * tracked read `structuredClone`s the value into the stage's read view
   * (the historical behavior; what lens/agentfootprint snapshots show).
   * `'summary'` records a cheap type/size/preview marker per read; `'off'`
   * records nothing — zero per-read clone cost (reads of large values become
   * ~free). Narrative and `ScopeRecorder.onRead` are identical in every mode.
   * Caveat: under `'off'` a stage's snapshot is indistinguishable from one
   * that read nothing — auditing consumers that need "did it read?" without
   * the value cost should prefer `'summary'`.
   * Equivalent to calling `executor.setReadTracking(mode)` before `run()`.
   */
  readTracking?: ReadTrackingMode;

  /**
   * Policy for `StageSnapshot.stageWrites` (#13c-A) — the sibling of
   * {@link readTracking}; the two dials are independent. Default `'full'` —
   * every tracked write `structuredClone`s the value into the stage's write
   * view (the historical behavior). `'summary'` records a cheap
   * `WriteSummaryMarker` (type/size/preview) per write; `'off'` records
   * nothing — `stageWrites` is absent from the snapshot.
   *
   * Observable consequences — what the policy DOES govern:
   * - `StageSnapshot.stageWrites` (markers under `'summary'`, absent under
   *   `'off'`).
   * - The commit observer payload: `ScopeRecorder.onCommit(mutations)`
   *   receives the retained `_stageWrites` entries, so it carries the same
   *   markers under `'summary'` and an empty mutations bag under `'off'` —
   *   deferred/observer consumers see exactly what retention stored.
   *
   * What it does NOT govern:
   * - The writes themselves: shared state, the transaction buffer, and the
   *   COMMIT LOG are identical in every mode (commitLog values keep their
   *   full payloads — the lossless linear-cost fix for those is the
   *   {@link commitValues} dial, #13c-B).
   * - Per-op `ScopeRecorder.onWrite` events — they fire with live values
   *   regardless (delivery tier, RFC-001's concern), so narrative output is
   *   identical in every mode.
   * - Redaction: a policy/per-call-redacted write stores `'[REDACTED]'`
   *   under `'full'` AND `'summary'` (redaction takes precedence over the
   *   dial; a marker would leak size/preview), and nothing under `'off'`.
   *
   * Caveat: under `'off'` a stage's SNAPSHOT is indistinguishable from one
   * that wrote nothing — but unlike `readTracking: 'off'`, the commit log
   * still records every net change, so "did it write?" stays answerable.
   * Equivalent to calling `executor.setWriteTracking(mode)` before `run()`.
   */
  writeTracking?: WriteTrackingMode;

  /**
   * Encoding policy for COMMIT LOG values (#13c-B) — the third dial of the
   * family, and unlike its siblings it is **lossless in both modes** (it
   * changes the log's encoding, never its information).
   *
   * - `'full'` (default) — every surviving `set` path stores the full final
   *   value; byte-identical to the historical behavior.
   * - `'delta'` — array net-changes that are "base plus a tail" commit as an
   *   `append` trace verb storing ONLY the tail (the growing-history commit
   *   log becomes linear instead of O(N²) retained); `deleteValue()` commits
   *   as a real `delete` verb (replay removes the key instead of leaving
   *   `key: undefined`); bundles carry exactly ONE trace entry per surviving
   *   path. Replay (the one verb law — live state, `materialise()`, the
   *   redacted mirror, `stateAt`) reconstructs every step's full state
   *   exactly.
   *
   * Consumers that read `bundle.overwrite[key]` as "the full value written"
   * must switch to `commitValueAt(commitLog, idx, key)` from
   * `footprintjs/trace` — under `'delta'` that value is verb-qualified (an
   * `append` bundle holds only the tail). Path-tier consumers
   * (`findLastWriter`, `causalChain`, narrative, lens highlights) are
   * unaffected. The active mode is surfaced as
   * `getSnapshot().commitValues`.
   *
   * Honest cost note: append detection is new wall work — an O(|base array|)
   * structural prefix compare per array-set path per commit. On a hit the
   * commit gets cheaper in both wall and heap; on a miss (prefix diverges)
   * it pays compare + full clone. `'full'` pays zero.
   * Equivalent to calling `executor.setCommitValues(mode)` before `run()`.
   */
  commitValues?: CommitValuesMode;

  /**
   * Per-write read provenance (#P1) — the fourth dial of the family. Default
   * `'off'`: zero cost, byte-identical commit logs. `'reads-prefix'`: every
   * committed `TraceEntry` carries `readKeys` — the keys tracked-read BEFORE
   * that write — enabling per-write causal attribution (`causalChain`'s
   * `edgeAttribution: 'per-write'` and variable slices). Cost: one small
   * array copy per write. Snapshot discriminant:
   * `getSnapshot().writeProvenance`.
   */
  writeProvenance?: WriteProvenanceMode;
}

/** The run's policy: every dial resolved, plus the redaction rule and the mirror flag. Frozen. */
export interface RunPolicy extends Readonly<Required<RunDials>> {
  /** The run's redaction rule — the ONE owner of the verdict (`redaction.ts`). Absent on bare frames. */
  readonly redaction?: RedactionRule;
  /** Keep a redacted mirror of the heap (a run with a redaction policy). Each runtime owns its own store. */
  readonly mirror: boolean;
}

/** Each dial's default — the value a run gets when the option is absent. The dial list IS these keys. */
export const DIAL_DEFAULTS: Readonly<Required<RunDials>> = Object.freeze({
  readTracking: 'full',
  writeTracking: 'full',
  commitValues: 'full',
  writeProvenance: 'off',
});

const DIAL_NAMES = Object.keys(DIAL_DEFAULTS) as Array<keyof RunDials>;

/** Every default, no rule, no mirror — what a bare frame (a unit test's `new StageContext`) runs under. */
export const DEFAULT_RUN_POLICY: RunPolicy = Object.freeze({ ...DIAL_DEFAULTS, mirror: false });

/** Build a run's policy: absent dials take their default; the result is frozen. */
export function runPolicy(dials: RunDials = {}, redaction?: RedactionRule, mirror = false): RunPolicy {
  const resolved: Record<string, unknown> = { ...DIAL_DEFAULTS, ...pickDials(dials), mirror };
  if (redaction) resolved.redaction = redaction;
  return Object.freeze(resolved) as unknown as RunPolicy;
}

/** The dials set on `source` (an options object, say) — and nothing else from it. */
export function pickDials(source: RunDials): RunDials {
  const dials: Record<string, unknown> = {};
  for (const name of DIAL_NAMES) if (source[name] !== undefined) dials[name] = source[name];
  return dials as RunDials;
}

/** The same policy under another rule — a NEW frozen object; the old one is never edited. */
export function withRedaction(policy: RunPolicy, redaction: RedactionRule): RunPolicy {
  return derivePolicy(policy, { redaction });
}

/**
 * The same policy with some settings changed — a NEW frozen object; the old one is never
 * edited. A frame or runtime changes a setting by swapping in a derived policy (`usePolicy`), so
 * no mutable dial field exists anywhere.
 */
export function derivePolicy(policy: RunPolicy, patch: Partial<RunPolicy>): RunPolicy {
  return Object.freeze({ ...policy, ...patch });
}
