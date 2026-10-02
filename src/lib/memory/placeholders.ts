/**
 * placeholders.ts — the two strings a redaction leaves where a value was.
 *
 * WHY THIS FILE EXISTS. Before F4a six files each spelled one of these strings as a literal, and a
 * spelling kept in six places is a placeholder a reader can no longer match on. Every `src/` file
 * that writes one now imports it from here, and `test/architecture/placeholders.test.ts` pins that
 * no other `src/` file spells either.
 *
 * WHY TWO, AND WHY NOT UNIFIED. Both are historical and stored recordings hold the log one, so
 * neither string may change. Which one a reader sees depends on WHERE it reads, not on the policy:
 * the commit log and everything served from it say {@link LOG_PLACEHOLDER}; the scope channel says
 * {@link SCOPE_PLACEHOLDER}.
 *
 * WHY A LEAF OF ITS OWN (and not beside `honesty.ts · HONESTY_CODES`). Different readers, different
 * reasons to change: these two strings are read by the engine's WRITE path on every redacted run,
 * the honesty registry by a reader that explains a recording — and the registry's sentences have no
 * business in the bundle of an app that only runs charts. This file imports NOTHING, so it is L0:
 * `memory/utils.ts · redactPatch` (L1) writes the log one and `memory/redaction.ts` (L2) the scope
 * one — the layer table is `scripts/layering.config.cjs`.
 */

/**
 * What the COMMIT LOG and the redacted MIRROR carry where a value was scrubbed.
 *
 * `memory/utils.ts · redactPatch` writes it into the patch the log records (both encodings), and the
 * mirror's seed is scrubbed with the same string (`runner/ExecutionRuntime.ts`), so a fold of the log
 * reproduces it (`stateAt` → `FoldedState.redactedPaths`) and a slice or an element birth, which
 * re-serve the log's bytes, show it too. A subflow's SERVED state is the subflow's own nested mirror
 * (9.20.0): `subflowResults[*].treeContext.globalContext` under `getSnapshot({ redact: true })`, and
 * `onSubflowExit.outputState` whenever a policy keeps that mirror — so those carry this string as
 * well, not {@link SCOPE_PLACEHOLDER}.
 */
export const LOG_PLACEHOLDER = 'REDACTED';

/**
 * What the SCOPE CHANNEL carries where a value was scrubbed: a scope recorder's read, write and
 * commit events, the `stageReads` / `stageWrites` retention, the narrative, a decision's evidence, an
 * emit payload matched by `emitPatterns`, and a subflow's narrated seed (`onSubflowEntry`).
 *
 * NOT every recorder event: `onSubflowExit.outputState` serves the subflow's redacted mirror when a
 * policy keeps one, and so carries {@link LOG_PLACEHOLDER} (without a mirror — per-call marks alone —
 * it is the subflow's heap retained under the rule, with this string). The string did not change
 * when it moved here — it was `REDACTED`, in `memory/redaction.ts`, until then.
 */
export const SCOPE_PLACEHOLDER = '[REDACTED]';
