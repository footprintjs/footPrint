/**
 * honesty.ts — the ONE vocabulary for what a reader cannot see.
 *
 * WHY THIS FILE EXISTS. A recording cannot always answer what it is asked, and the library says
 * so in several places, each in its own words: a slice carries `HonestyNote`s, a fold carries a
 * `basis`, a stored log reports `LogGap`s, a causal node carries `incompleteSources`, and a
 * redaction leaves a placeholder where a value was. A reader that wants to EXPLAIN any of them to
 * a person (a why-panel, an agent tool) kept its own table of code → sentence, and tables kept
 * apart drift. This file is that table, once, with the two placeholder strings beside it.
 *
 * WHAT IT HOLDS.
 *   - `HONESTY_CODES` — a frozen, closed registry: code → the ONE sentence that says what the code
 *     means. The shape of rustc's `--explain` and LSP's `Diagnostic.code`: the code is the stable
 *     key a consumer BRANCHES on; the sentence is for whoever reads the screen. It is not the
 *     per-instance `detail` a note carries (that names the key, the budget, the rows).
 *   - `HonestyCode` / `RegisteredCode` — what makes the registry the owner and not a suggestion: a
 *     type that is a vocabulary of codes (`HonestyNoteCode`, `FoldBasis`) declares its members
 *     through `RegisteredCode`, so a member the registry does not hold fails to COMPILE.
 *   - `note` — the one constructor of a slice note's `{ code, detail }` (internal).
 *   - `LOG_PLACEHOLDER` / `SCOPE_PLACEHOLDER` — the two strings a redaction leaves where a value
 *     was. Two on purpose (stored recordings hold the log one), so they are not unified; five
 *     files each spelled one as a literal before they moved here, and
 *     `test/architecture/placeholders.test.ts` pins that no other `src/` file spells either.
 *
 * NO OBJECT GAINS A FIELD from being registered. `LogGap` and `CausalNode.incompleteSources` carry
 * no code; they are registered so that a reader can explain every honesty signal from the same
 * place.
 *
 * WHY L0. This file imports NOTHING. `memory/utils.ts` (L1) writes the log placeholder,
 * `memory/redaction.ts` (L2) the scope one, and `slice/` and `time-travel/` (L3) type their codes
 * through the registry, so the owner has to sit at or below the lowest of them — the layer table
 * is `scripts/layering.config.cjs`.
 *
 * @example
 * ```typescript
 * import { HONESTY_CODES } from 'footprintjs/trace';
 *
 * for (const { code } of forwardSlice.notes) console.log(code, '→', HONESTY_CODES[code]);
 * // reads-not-recorded → This log carries no recorded read at all (the readTracking: 'off' signature), …
 * HONESTY_CODES[foldedState.basis]; // 'log-only' → No initialState travelled with this log (…), …
 * ```
 */

/**
 * Every honesty code the library speaks, with the one sentence that says what it means.
 *
 * Frozen and closed: the keys are exactly the codes below, and {@link HonestyCode} is derived from
 * them. A new code is one new line here, and nothing else in the library can use a code that is
 * not on it.
 */
export const HONESTY_CODES = Object.freeze({
  // ── a slice's notes — `HonestyNote.code` (slice/) ─────────────────────────
  'conservative-fed-edges':
    "At least one 'fed' edge is stage-level (conservative): its write carries no per-write read provenance, so the edge may not be real — turn on writeProvenance: 'reads-prefix' for exact edges.",
  'pre-run-origin':
    'The value being followed was already there before the first write this log can see (initial state, frozen run input or a closure), so who put it there is outside the commit log.',
  'reads-not-recorded':
    "This log carries no recorded read at all (the readTracking: 'off' signature), so 'nothing read this value' is unknowable here, not true.",
  'unknown-key':
    "This log has no write and no recorded read of the key, which is most likely a typo or the wrong run's log rather than a variable with no history.",
  truncated:
    'A budget (maxDepth or maxNodes) cut the walk, so more of the answer exists beyond the horizon it stopped at.',
  // ── how a fold was derived — `FoldedState.basis` (time-travel/) ───────────
  'initial+log': "The state was folded from the run's real fold base plus the commit log, so it is complete.",
  'log-only':
    'No initialState travelled with this log (a snapshot stored before 9.17, a redacted snapshot or a hand-built log), so the fold started from an empty object and anything seeded before the run and only merged since is missing.',
  // ── a row of a stored log that is not a commit bundle — `LogGap` ──────────
  'log-gap':
    'A row of the stored log could not be read as a commit bundle, so it keeps its index but contributes no state, and any fold that crosses it is incomplete at exactly that place.',
  // ── untracked reads a stage also consumed — `CausalNode.incompleteSources` ─
  'incomplete-sources':
    'The stage also consumed read paths that bypass read tracking (args, env or an unshadowed silent read), so a slice through it may be incomplete: those reads produce no read-to-write edge to follow.',
} satisfies Record<string, string>);

/** Any code in {@link HONESTY_CODES} — the key a reader looks an explanation up by. */
export type HonestyCode = keyof typeof HONESTY_CODES;

/**
 * A union of honesty codes a type DECLARES: `T` must be a subset of {@link HonestyCode}, or the
 * declaration fails to compile (TS2344).
 *
 * `RegisteredCode<T>` is `T` — an identity at the type level — so the union keeps exactly the
 * members it was written with and does NOT widen to every code:
 * `type FoldBasis = RegisteredCode<'initial+log' | 'log-only'>`.
 */
export type RegisteredCode<T extends HonestyCode> = T;

/**
 * One honesty statement as a slice carries it: the code a consumer branches on, then the sentence
 * to show. INTERNAL — the one constructor of a note's `{ code, detail }` (key order included), so
 * that a note cannot be built with a code the registry does not hold. It is on no barrel.
 */
export function note<C extends HonestyCode>(code: C, detail: string): { code: C; detail: string } {
  return { code, detail };
}

/**
 * What the COMMIT LOG and the redacted mirror carry where a value was scrubbed. `redactPatch`
 * writes it into the patch the log records, and the mirror's seed is scrubbed with the same
 * string, so a fold of the log reproduces it (`stateAt` → `FoldedState.redactedPaths`). Unchanged
 * since 4.x, and unchanged by the move here — stored recordings hold it, which is why it is not
 * unified with {@link SCOPE_PLACEHOLDER}.
 */
export const LOG_PLACEHOLDER = 'REDACTED';

/**
 * What every SCOPE-TIER view carries where a value was scrubbed: recorder events, the
 * `stageReads` / `stageWrites` retention, the narrative, a decision's evidence and an emit payload
 * under `emitPatterns`. The string did not change when it moved here — it was `REDACTED`, in
 * `memory/redaction.ts`, until then.
 */
export const SCOPE_PLACEHOLDER = '[REDACTED]';
