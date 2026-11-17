/**
 * What the SCOPE CHANNEL carries where a value was scrubbed: a scope recorder's read, write and
 * commit events, the `stageReads` / `stageWrites` retention, the narrative, a decision's evidence, an
 * emit payload matched by `emitPatterns`, a pause payload's served form and a subflow's narrated seed
 * (`onSubflowEntry`) — every value this verdict serves, unless its caller passes the log's string.
 *
 * Its twin is the RECORD's `LOG_PLACEHOLDER` (`'REDACTED'`, in foottrace): the commit log,
 * the redacted mirror and everything served from them. So NOT every recorder event carries this one:
 * `onSubflowExit.outputState` serves the subflow's redacted mirror when a policy keeps one, and so
 * carries the log's string (without a mirror — per-call marks alone — it is the subflow's heap
 * retained under the rule, with this one). Both strings are historical and neither changed when it
 * moved: this one was the constant `REDACTED` in this file until F4a, then `placeholders.ts ·
 * SCOPE_PLACEHOLDER`, and since C4 it lives here again, beside the verdict that writes it.
 * The shared fixed-value owner is now `memory/redactionValues.ts`; the original verdict facade re-exports it.
 */
export const SCOPE_PLACEHOLDER = '[REDACTED]';

/**
 * What the policy says about the value at one user-level path.
 *
 * - `'clear'`  — nothing to scrub; retain and serve the value as it is.
 * - `'whole'`  — the entire value is secret. `key` is the policy or marked
 *   key that decided it (the path itself or one of its ancestors).
 * - `'fields'` — the value is an object whose `paths` (dot-paths INSIDE the
 *   value, relative to it) are secret; everything else in it is not.
 */
export type RedactionVerdict =
  | { readonly kind: 'clear' }
  | { readonly kind: 'whole'; readonly key: string }
  | { readonly kind: 'fields'; readonly key: string; readonly paths: readonly string[] };

export const CLEAR: RedactionVerdict = Object.freeze({ kind: 'clear' } as const);

/** What a condition row keeps of its threshold: the value to store, and whether that value is a hole. */
export interface ServedThreshold {
  readonly threshold: unknown;
  /** Absent for a value: the string `[REDACTED]` can be a real threshold. */
  readonly thresholdRedacted?: true;
}

/** A threshold nothing can answer for: the placeholder, and the marker that says it is one. */
export const THRESHOLD_HOLE: ServedThreshold = Object.freeze({
  threshold: SCOPE_PLACEHOLDER,
  thresholdRedacted: true,
});
