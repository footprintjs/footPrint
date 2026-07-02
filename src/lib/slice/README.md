# slice/ — variable-first backward slicing

The **triage query layer** of footprintjs: given a *variable* (a state key, or one
element of an array-valued key), produce the backward slice that explains it —
who wrote it, what those writers read, which decisions allowed them to run.

One contract, three consumers:

| Consumer | Example |
|---|---|
| Human UI | click `creditTier` in explainable-ui → dependency panel + chart cone |
| LLM tool | a `backtrack(variable, element?)` tool an agent calls to answer "why did you say that?" |
| Offline autopsy | a triage agent fed a stored run's commit log |

All three call the same queries below, so their answers can never disagree.

**Picking an entry point:** know the failing **variable** → `sliceForKey` /
`elementProvenance` (here). Know only that **quality dropped** somewhere →
`qualityTrace` (`footprintjs/trace`) finds the step; then slice from there.

## The queries

### `sliceForKey(commitLog, key, keysRead, options?)` → `VariableSlice`

"Why is `key` what it is?" Anchors at the key's **last writer**
(`findLastWriter`), then delegates to `causalChain` (thin backward slicing,
Weiser 1984 — implemented in `memory/backtrack.ts`) for the transitive
read→write walk, with optional control edges and edge weights passed through
untouched. Deliberately a composition, not a new algorithm: the value is the
shared contract, not new graph theory.

`key` accepts a plain string or a path array (`['customer', 'address']`) —
engine path delimiters never appear in this API.

Honest absence is a first-class result: `missing: 'never-written'` means the
value came from initial state, frozen `args`, or a closure — none of which the
commit log can see. A triage tool should SAY that, not guess.

### `arrayProvenance(commitLog, key)` / `elementProvenance(commitLog, key, index)` → births

**Append-fold provenance** — the fix for the agent *mega-key problem*: in agent
charts everything flows through `history`, so a key-level slice degenerates to
"everything depends on history". Element-level provenance answers the real
question: *history[7] was appended by `tool-calls#41` in iteration 3*.

No new capture: the commit log already knows. The fold replays the key's verbs
(the same fold `commitValueAt` runs — a property test pins the two folds to
identical values) while carrying an index-aligned births array:

- `append` verbs (`commitValues: 'delta'`) hold exactly the new tail → **exact** attribution (`basis: 'append-verb'`)
- full-mode growth is consecutive `set`s where the old array is a strict prefix of the new → tail attributed by inference (`basis: 'prefix-inference'`, labeled honestly — a wholesale replacement sharing the old prefix is indistinguishable)
- anything else → `basis: 'whole-value'` (provenance reset)

Absence mirrors `VariableSlice`: `missing: 'empty-log' | 'never-written' |
'not-an-array'` (`'not-an-array'` = scalar/deleted/degraded key — that's
`sliceForKey` territory).

**Chained triage** (the hop an LLM tool makes — "who made history[2], and why
did THAT run?"): a birth's `commitIdx` is inclusive; `sliceForKey`'s `before`
is exclusive — anchor the follow-up with `before: birth.commitIdx + 1`.

### `sliceToJSON(slice)` / `formatSlice(slice)` — the ONLY safe serializations

`VariableSlice.root` is an in-memory DAG with **shared nodes** — never
`JSON.stringify` it (every diamond re-serializes per path; combinatorial
blow-up). Use:

- `sliceToJSON(slice)` — flat `{nodes, edges}` keyed by runtimeStageId, linear
  in node count. For persistence, wire transfer, structured consumers.
- `formatSlice(slice)` — ONE bounded string for LLM tools; renders the honesty
  envelope too (missing reason, "⚠ reads were not recorded" when coverage says
  so, truncation footers).

## KeysRead strategies

Reads are **not** in the commit log, so a slice needs a reads provider.
`KeysReadSource` is the strategy seam — the canonical list and rationale live
on the type's JSDoc (types.ts); implementations in `keysReadSources.ts`:
`keysReadFromExecutionTree` (post-hoc snapshot, zero setup),
`keysReadFromMap` (live-collected or stored), or any bare function
(e.g. a QualityRecorder adapter: `(id) => rec.getByKey(id)?.keysRead ?? []`).
Every slice records which strategy produced it (`keysReadKind`) plus optional
`readsCoverage` — `stepsWithReads === 0` over a multi-step run is the
machine-detectable signature of `readTracking: 'off'`.

## Subflow boundaries (read this before slicing agent charts)

A subflow runs in an **isolated runtime**: its commits live in
`snapshot.subflowResults[sfId].commitLog`, its reads in
`snapshot.subflowResults[sfId].executionTree` — NOT in the root log/tree. A
root-log slice therefore ends at the subflow **mount** commit (the
outputMapper's write into the parent). To continue inside, re-anchor in the
subflow's own scope with tree and log paired from the SAME snapshot:

```ts
const sf = snapshot.subflowResults['sf-tools'];
sliceForKey(sf.commitLog, key, keysReadFromExecutionTree(sf.executionTree));
```

(Passing multiple trees to `keysReadFromExecutionTree` widens *read*
resolution when one log genuinely spans them; it does not make a root slice
cross a mount.)

## Honesty model (inherited + added)

- `CausalNode.incompleteSources` / `truncated` pass through from `causalChain`.
- `VariableSlice.missing` / `ArrayProvenance.missing` — absence with a reason,
  never a silent empty object.
- `ElementBirth.basis` — exact vs inferred vs reset, on every record.
- `keysReadKind` + `readsCoverage` — a slice can always be traced to its reads
  provider, and a reads-less provider is detectable, not silent.
- Redaction: this layer re-serves commit-log bytes; a redacted key's
  `'[REDACTED]'` placeholder stays redacted. No new leak surface.

## What this library deliberately does NOT do

- **No capture.** Pure post-hoc queries over data the engine already records.
- **No recorder/engine/runner imports.** DAG position is `memory ← slice`;
  keeping the import set to `memory/` is what lets this evolve as a tiny
  library (its consumers — trace toolpacks, UI adapters — live above it).
- **No cross-LLM claims.** A slice is structural. Whether a context piece
  *semantically* influenced a model output is a different (sampled, ablation-
  tested) question that belongs to downstream libraries.

## Evolution path

- Per-write read-sets (planned dial) will let `causalChain` attribute a
  stage's writes to only the reads that preceded them; this library's contract
  doesn't change — slices just get tighter.
- LLM triage tools (`backtrack(variable, element?)`) and UI panels consume
  these queries; they live above this layer, never inside it.
- A subflow-boundary-crossing helper (auto re-anchoring through
  `subflowResults`) is a candidate next layer — today the re-anchor is manual
  and documented above.
