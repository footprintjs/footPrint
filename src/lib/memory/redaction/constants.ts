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
 */
export const SCOPE_PLACEHOLDER = '[REDACTED]';
