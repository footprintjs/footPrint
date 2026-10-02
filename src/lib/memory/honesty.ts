/**
 * honesty.ts — the ONE vocabulary for what a reader cannot see.
 *
 * WHY THIS FILE EXISTS. A recording cannot always answer what it is asked, and the library says
 * so in several places, each in its own words: a slice carries `HonestyNote`s and, when it has no
 * answer, a `missing` reason; a fed edge and an element birth carry a `basis`; a fold carries a
 * `basis` and its `redacted` paths; a stored log reports `LogGap`s; a causal node carries
 * `incompleteSources` and `truncated`. A reader that wants to EXPLAIN any of them to a person (a
 * why-panel, an agent tool) kept its own table of code → sentence, and tables kept apart drift.
 * This file is that table, once.
 *
 * WHAT IT HOLDS.
 *   - `HONESTY_CODES` — a frozen, closed registry: code → the ONE sentence that says what the code
 *     means. The shape of rustc's `--explain` and LSP's `Diagnostic.code`: the code is the stable
 *     key a consumer BRANCHES on; the sentence is for whoever reads the screen. It is not the
 *     per-instance `detail` a note carries (that names the key, the budget, the rows).
 *   - `HonestyCode` / `RegisteredCode` — what makes the registry the owner and not a suggestion:
 *     each public union of these codes (`HonestyNoteCode`, `MissingSliceReason`,
 *     `MissingProvenanceReason`, `FedBasis`, `AttributionBasis`, `FoldBasis`) declares its members
 *     through `RegisteredCode`, so a member the registry does not hold fails to COMPILE. And
 *     `test/architecture/honesty-vocabulary.test.ts` asks the type checker for every exported type
 *     alias of `footprintjs/trace` that is a union of string literals: each one is inside the
 *     registry or is named, with its reason, as not an honesty vocabulary.
 *
 * NO OBJECT GAINS A FIELD from being registered. Three signals carry no code of their own — a
 * `LogGap` (`'log-gap'`), `CausalNode.incompleteSources` (`'incomplete-sources'`) and
 * `FoldedState.redacted` / `redactedPaths` (`'redacted'`) — and a `truncated: { byDepth, byNodes }`
 * field means `'truncated'`; they are registered so a reader explains them from the same place.
 *
 * NOT HERE: the two strings a redaction leaves where a value was. The engine writes those on every
 * redacted run; they live in their own leaf, `memory/placeholders.ts`, so that an app which only
 * runs charts does not carry these sentences in its bundle (`HONESTY_CODES` is a pure expression,
 * so a bundler drops it wherever nothing reads it).
 *
 * WHY L0. This file imports NOTHING, and `slice/` and `time-travel/` (L3) type their codes through
 * it, so it sits below them — the layer table is `scripts/layering.config.cjs`.
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
 * Every honesty code the trace readers (`footprintjs/trace`) speak, with the one sentence that says
 * what it means.
 *
 * Frozen and closed: the keys are exactly the codes below, and {@link HonestyCode} is derived from
 * them. A new code is one new line here: a union declared through {@link RegisteredCode} cannot hold
 * a code that is not on it, and `test/architecture/honesty-vocabulary.test.ts` fails on an exported
 * type alias of `footprintjs/trace` that is a union of string literals neither inside the registry
 * nor named there as not an honesty vocabulary. The values are typed `string`, not literal types,
 * on purpose: the sentences are for a screen and may be reworded; a consumer branches on the KEY.
 */
export const HONESTY_CODES = /* @__PURE__ */ Object.freeze({
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
  // ── why a slice has no answer — `missing` (slice/: MissingSliceReason, MissingProvenanceReason) ─
  'empty-log':
    'The commit log holds no commit at all (nothing has executed, or the log handed in is empty), so there is no history to answer from.',
  'never-written':
    'No commit in the range asked about wrote the key (a forward slice or a timeline also found no recorded read of it), so there is no write to start from: any value it has came from the initial state, the frozen run input or a closure, none of which the commit log can see.',
  'not-an-array':
    'The key was written, but its value at the point asked about is not an array (a scalar or object key, a deleted key, or a merge that degraded it), so element provenance does not apply: sliceForKey is the query for it.',
  // ── how a fed edge was attributed — `ForwardEdge.basis` (slice/: FedBasis) ─
  'per-write':
    "This fed edge is exact: the downstream write carries per-write read provenance (TraceEntry.readKeys, recorded under writeProvenance: 'reads-prefix') and that list names the key, so the value was read before the write it feeds.",
  stage:
    'This fed edge is conservative: the downstream write carries no per-write read provenance (the writeProvenance dial was off, or the log is mixed), so all that is known is that its stage read this key and wrote that path in some order, and the edge may not be real.',
  // ── how an element's birth was attributed — `ElementBirth.basis` (slice/: AttributionBasis) ─
  'append-verb':
    "The engine recorded the element in an append row's tail (how commitValues: 'delta' records an array's growth), so the commit that added it is known exactly, not inferred.",
  'prefix-inference':
    'A whole-value write (a set or a merge) kept the previous array as its prefix, so the new tail is attributed to that commit by inference: a write that replaced the array with one that happens to begin the same way looks identical.',
  'whole-value':
    "This commit placed the array wholesale (there was no earlier array, or the new one does not begin with it), so every element's birth resets to this commit: exact, but coarse.",
  // ── how a fold was derived — `FoldedState.basis` (time-travel/) ───────────
  'initial+log':
    'The fold started from the fold base that travelled with the log (initialState) and replayed the commit log onto it, so nothing seeded before the run is missing; rows it could not read are listed apart, in skipped.',
  'log-only':
    'No initialState travelled with this log (a snapshot stored before 9.17, a redacted snapshot or a hand-built log), so the fold started from an empty object: a key seeded before the run is whole only once a commit since wrote its whole value, and until then it holds just what its merges, appends and nested writes added, or nothing.',
  // ── a row of a stored log that is not a commit bundle — `LogGap` ──────────
  'log-gap':
    'A row of the stored log could not be read as a commit bundle, so it keeps its index but contributes no state, and any fold that crosses it is missing whatever that row wrote.',
  // ── untracked reads a stage also consumed — `CausalNode.incompleteSources` ─
  'incomplete-sources':
    'The stage also consumed read paths that bypass read tracking (args, env or an unshadowed silent read), so a slice through it may be incomplete: those reads produce no read-to-write edge to follow.',
  // ── values scrubbed at write time — `FoldedState.redacted` / `redactedPaths` ─
  redacted:
    "Values at the paths listed in redactedPaths were scrubbed when they were written (by a redaction policy, or a write marked redacted), so where this fold holds the log's placeholder 'REDACTED' it stands in for a value the log never recorded.",
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
