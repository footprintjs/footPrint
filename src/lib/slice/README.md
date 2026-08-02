# slice/ — variable-first slicing, both directions

The **triage query layer** of footprintjs: given a *variable* (a state key, or one
element of an array-valued key), answer the two questions every investigation
asks about it —

- **backward**: why is it what it is? who wrote it, what did those writers read,
  which decisions allowed them to run;
- **forward**: who *read* it, and what did that value *feed*?

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
Know a value was **wrong or poisoned** and need its blast radius →
`forwardSliceForKey` (below).

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

### `forwardSliceForKey(commitLog, key, keysRead, options?)` → `ForwardSlice`

"Who read this value, and what did it feed?" — the same anchor idiom as
`sliceForKey` (the last write, or the last write before `before`), walked the
other way. The unit is not a step but a **value's life**:

1. a write starts a life; it ends at the key's **next write** (`nextWriteIdx`);
2. every stage that read the key inside that window is a `read`;
3. a reading stage that also wrote something carried the value onward — a
   `fed` edge to that write, itself the start of a new life;
4. descend breadth-first, visited-set guarded, budgeted (`maxDepth` 20 /
   `maxNodes` 100 — `causalChain`'s numbers).

`before` bounds the **anchor** only; the walk then runs forward past it,
because "what did the value at step 12 go on to feed?" is the question.

**The live range is `(writeIdx, nextWriteIdx]`** — open below, closed on top,
and both ends follow from the engine firing `onRead` PRE-commit: a
read-modify-write stage's own read saw the *previous* value, and the
overwriting stage's read still saw *this* one. A read after that commit
attributes to the new write, never the old. (Granularity limit, stated because
it cannot be seen: a stage that writes the key and then re-reads it within the
same stage read its own value; at commit-index resolution that is
indistinguishable.)

**`fed` edges are EXACT only under recorded read provenance.** With
`writeProvenance: 'reads-prefix'` on, the child write's `TraceEntry.readKeys`
names the keys read before it — this key present is an exact edge
(`basis: 'per-write'`), this key *absent* is an exact **exclusion** (no edge).
With the dial off there is only stage-level co-occurrence: every edge is
stamped `basis: 'stage'` and the slice carries a `'conservative-fed-edges'`
note. A conservative edge is never presented as an exact one.

### `keyTimeline(commitLog, key, keysRead, options?)` → `KeyTimeline`

The whole life of one key in commit order: every write (with its verb) and
every recorded read, each moment carrying `runtimeStageId` **and** `commitIdx`
— the two universal join keys. A read's `fromWriteIdx` says which value it saw,
by the *same* live-range rule the walk uses (a property test pins the two doors
to identical attribution). No graph, no budgets, no live references.

### `sliceToJSON(slice)` / `formatSlice(slice)` — the ONLY safe serializations

`VariableSlice.root` is an in-memory DAG with **shared nodes** — never
`JSON.stringify` it (every diamond re-serializes per path; combinatorial
blow-up). Use:

- `sliceToJSON(slice)` — flat `{nodes, edges}` keyed by runtimeStageId, linear
  in node count. For persistence, wire transfer, structured consumers.
- `formatSlice(slice)` — ONE bounded string for LLM tools; renders the honesty
  envelope too (missing reason, "⚠ reads were not recorded" when coverage says
  so, truncation footers).

The forward half has the same hazard (two values read by one stage feed the
same child write — shared nodes again) and the same two projections:
`forwardSliceToJSON(slice)` and `formatForwardSlice(slice)`, which renders
`[exact]` / `[conservative]` per edge and every honesty note as a `⚠` line.
Forward node ids are **opaque** (`n0`, `n1`, … in BFS order) rather than
`runtimeStageId` as in `SliceJSON`: a forward node is a *(key, write)* pair, so
one stage that wrote two keys owns two nodes. Never parse them — join on
`runtimeStageId` / `commitIdx` / `key`, which every node carries.

`KeyTimeline` is the deliberate exception, stated so nobody adds a pointless
twin: it is a flat list of plain fields with no sharing and no live references,
so `JSON.stringify(timeline)` is already correct and linear. What it still
needs is the bounded string — `formatTimeline(timeline)`.

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

- `CausalNode.incompleteSources` / `truncated` pass through from `causalChain`;
  `ForwardNode` carries the same two, stamped from the writer's bundle.
- `VariableSlice.missing` / `ArrayProvenance.missing` — absence with a reason,
  never a silent empty object.
- `ElementBirth.basis` — exact vs inferred vs reset, on every record;
  `ForwardEdge.basis` — exact vs conservative, on every edge.
- `keysReadKind` + `readsCoverage` — a slice can always be traced to its reads
  provider, and a reads-less provider is detectable, not silent.
- `HonestyNote[]` (forward) — the machine-readable envelope: a consumer
  branches on `code`, a human/LLM reads `detail`. Five codes:
  `'unknown-key'`, `'reads-not-recorded'`, `'pre-run-origin'`,
  `'conservative-fed-edges'`, `'truncated'`.
- Redaction: this layer re-serves commit-log bytes; a redacted key's
  `'[REDACTED]'` placeholder stays redacted. No new leak surface. (Forward
  nodes carry identity and position only — no values at all.)

**The typo guard**, split by what the recording affords — because
"nothing read it" and "you spelled it wrong" must never render alike:

| the log has | forward answer |
|---|---|
| no write, no read, **reads recorded elsewhere** | `missing: 'never-written'`, no root + an `'unknown-key'` note naming a bounded list of keys the log *does* know |
| no write, no read, **no reads recorded at all** | a `'pre-run'` origin life (the only honest answer) + BOTH the `'unknown-key'` and `'reads-not-recorded'` notes |
| no write, but the key **was read** | a `'pre-run'` origin life + the `'pre-run-origin'` note — a seeded/`input`/closure value that stages really did consume |

**Forward blind spot worth naming:** a stage that consumed the value through an
untracked path (`getValueSilent`, `getArgs`, `getEnv`) is invisible to the reads
provider, so it cannot appear as a reader. Its own commit carries
`untrackedSources`, which is why every node stamps `incompleteSources` — but the
missing *edge* is in another stage's life, not this one. Treat a forward slice
as a lower bound on consumers, exactly as a backward slice is on causes.

## What this library deliberately does NOT do

- **No capture.** Pure post-hoc queries over data the engine already records.
- **No recorder/engine/runner imports.** DAG position is `memory ← slice`;
  keeping the import set to `memory/` is what lets this evolve as a tiny
  library (its consumers — trace toolpacks, UI adapters — live above it).
- **No cross-LLM claims.** A slice is structural. Whether a context piece
  *semantically* influenced a model output is a different (sampled, ablation-
  tested) question that belongs to downstream libraries.

## Evolution path

- Per-write read-sets SHIPPED (`writeProvenance: 'reads-prefix'`): `causalChain`
  attributes a stage's writes to only the reads that preceded them, and the
  forward walk uses the same evidence to make `fed` edges exact. This library's
  contract did not change — slices just got tighter, and honest without it.
- LLM triage tools (`backtrack(variable, element?)`) and UI panels consume
  these queries; they live above this layer, never inside it.
- A subflow-boundary-crossing helper (auto re-anchoring through
  `subflowResults`) is a candidate next layer — today the re-anchor is manual
  and documented above.
