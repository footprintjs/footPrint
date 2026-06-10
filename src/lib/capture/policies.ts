/**
 * policies.ts — The retention policy family shared by every snapshot-tracking
 * dial (#14 `readTracking`, #13c-A `writeTracking`).
 *
 * RETENTION answers "what does the engine KEEP in its own snapshot state
 * (`StageSnapshot.stageReads` / `stageWrites`, and therefore the commit
 * observer's mutations payload) after the moment of the operation?" It is
 * distinct from DELIVERY — what an observer receives at event time
 * (`ScopeRecorder.onRead`/`onWrite` always deliver the live value, in every
 * retention mode).
 *
 * ── RFC-001 (deferred observer delivery) mapping ──────────────────────────
 * RFC-001's capture tier uses the vocabulary `'clone' | 'summary' | 'ref'`.
 * When its Block 1 lands it builds on THIS module:
 *
 *   - RFC capture `'clone'`   ≈ retention `'full'` (alias at the module
 *     boundary — same semantics: structuredClone at capture time).
 *   - RFC capture `'summary'` ≈ retention `'summary'` (same marker shapes —
 *     see `summarize.ts`).
 *   - RFC capture `'ref'` is DELIVERY-tier only and is NOT implemented here
 *     — reserved. Retention must never hold live references into engine
 *     state: retained entries outlive the stage (the execution tree keeps
 *     them for the whole run), while a `'ref'` is only safe within the
 *     immutability window of the captured value. Holding one in retention
 *     would either pin state generations (the #18 leak) or expose
 *     later-mutated values as if they were point-in-time captures.
 */

/**
 * How a tracked operation's value is retained in the per-stage snapshot view.
 *
 * - `'full'` — `structuredClone` the value at the moment of the operation
 *   (the historical default for both dials; point-in-time, detached copy).
 * - `'summary'` — retain a cheap marker (type + size proxy + short preview)
 *   instead of the value. O(1)-ish per operation; no value clone.
 * - `'off'` — retain nothing. The operation itself is unaffected (reads
 *   still return values, writes still commit); only the snapshot bookkeeping
 *   is skipped.
 *
 * `ReadTrackingMode` (#14) and `WriteTrackingMode` (#13c-A) are public
 * aliases of this type — see `memory/types.ts`.
 */
export type RetentionPolicy = 'full' | 'summary' | 'off';
