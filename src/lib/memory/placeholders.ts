/**
 * placeholders.ts — the string a redaction leaves where a value was, in the RECORD.
 *
 * WHY THIS FILE EXISTS. Before F4a six files each spelled a placeholder as a literal, and a spelling
 * kept in six places is a placeholder a reader can no longer match on. Every `src/` file that writes
 * the log's placeholder imports it from here, and `test/architecture/placeholders.test.ts` pins that
 * no other `src/` file spells it.
 *
 * ONE STRING HERE, ITS TWIN ON THE VERDICT'S SIDE (C4, review N2). A redaction leaves one of two
 * strings, and both are historical, so neither may change (stored recordings hold this one). Which
 * one a reader sees depends on WHERE it reads, and each has the owner its reader has:
 *   - {@link LOG_PLACEHOLDER} (`'REDACTED'`, here) is a RECORD byte: the commit log and everything
 *     served from it — written into the log by the record's scrub (`memory/scrub.ts`, L2), and
 *     passed by the two places that serve a mirror (`runner/ExecutionRuntime.ts`, the mirror's
 *     seed; `engine/handlers/SubflowExecutor.ts`, a subflow's served state). The readers
 *     (`slice/`, `time-travel/`) only name it in their docs: they meet it as data in the log;
 *   - `SCOPE_PLACEHOLDER` (`'[REDACTED]'`) is the ENGINE's: the scope channel's retained reads and
 *     writes, recorder events, the narrative. It lives beside the verdict that writes it
 *     (`memory/redaction.ts`, L4). Until C4 both sat in this file ("two placeholders, one leaf");
 *     the record took the engine's string with it.
 *
 * WHY A LEAF OF ITS OWN (and not beside `honesty.ts · HONESTY_CODES`). Different readers, different
 * reasons to change: this string is written on the engine's WRITE path on every redacted run, the
 * honesty registry is read by a reader that explains a recording — and the registry's sentences have
 * no business in the bundle of an app that only runs charts. This file imports NOTHING, so it is L0
 * (the layer table is `scripts/layering.config.cjs`).
 */

/**
 * What the COMMIT LOG and the redacted MIRROR carry where a value was scrubbed.
 *
 * `memory/scrub.ts · scrubPatch` writes it into the patch the log records (both encodings), and the
 * mirror's seed is scrubbed with the same string (`runner/ExecutionRuntime.ts`), so a fold of the log
 * reproduces it (`stateAt` → `FoldedState.redactedPaths`) and a slice or an element birth, which
 * re-serve the log's bytes, show it too. A subflow's SERVED state is the subflow's own nested mirror
 * (9.20.0): `subflowResults[*].treeContext.globalContext` under `getSnapshot({ redact: true })`, and
 * `onSubflowExit.outputState` whenever a policy keeps that mirror — so those carry this string as
 * well, not the scope channel's `SCOPE_PLACEHOLDER` (`memory/redaction.ts`).
 */
export const LOG_PLACEHOLDER = 'REDACTED';
