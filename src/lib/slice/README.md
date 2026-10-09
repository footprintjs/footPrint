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

## What "wrote" and "read" mean — nested rows (9.33.0)

Every query here asks the commit log ONE question — which rows touch a key — and asks it in one place,
`memory/keyPaths.ts` (ruling R4). Until 9.32 each reader matched rows on the key's EXACT path, so a key
the engine wrote through a nested row read as "never written" while the fold applied it: a subflow's
input seed writes `cfg␟a`, an outputMapper merge-back writes `cfg␟b` into the parent, a fork child
writes `runs␟c0␟x`.

- **A commit WROTE `K`** when it has a row ON `K`, INSIDE it (`cfg␟b` is a write of `cfg`), or AROUND
  it with the value at `K` different across the commit (a `set` of `cfg` writes `cfg␟a`;
  `$update('cfg', { list: [3] })` does not — its delta never reaches `a`).
- **A stage READ `K`** when the reads provider names `K`, a path inside it (part of its value) or a
  container around it (all of it). A read key is matched as a DELIM path — the form
  `normalisePath(['cfg', 'a'])` gives. The engine's own nested reads are spelled with dots
  (`StageContext · getValue(path, key)`), and a dot is a legal character of a top-level key, so
  `'cfg.a'` stays the literal key it may be. A typed scope reads top-level keys, so the common case is
  unaffected.
- **The value of `K`** (`commitValueAt`) is the fold of every row under `K`'s top-level key — what
  `stateAt` gives at `K` when it folds the log alone.

What moved, on the charts that show it (test/lib/slice/nested-rows.test.ts):

| question | 9.32 | 9.33 |
|---|---|---|
| `commitValueAt(log, mergeBack, 'cfg')` after `cfg = { a: 1 }` and a merge-back of `{ cfg: { b: 2 } }` | `{ a: 1 }` | `{ a: 1, b: 2 }` (the fold) |
| `findLastWriter(log, 'cfg')` / `sliceForKey(…).writer` there | the seed's bundle | the merge-back's bundle |
| `keyTimeline(log, 'cfg', …)` | one write; the reader saw the seed | two writes; the reader saw the merge-back; a `'nested-rows'` note |
| `forwardSliceForKey(log, 'cfg', …)` anchor | the seed | the merge-back, with a `'nested-rows'` note |
| `findLastWriter` / `commitValueAt` / `sliceForKey` on `cfg` in a subflow seeded with `{ cfg: { a: 1, b: 2 } }` | none / `undefined` / `missing: 'never-written'` | the seed / `{ a: 1, b: 2 }` / a writer |
| `commitValueAt(log, 0, 'cfg␟a')` after `cfg = { a: 1, … }` | `undefined` | `1` |
| `findLastWriter(log, 'cfg␟a')` after that set and `$update('cfg', { list: [3] })` | none | the set — not the merge |
| `arrayProvenance(log, ['cfg', 'list'])` | `missing: 'never-written'` | births: `whole-value`, `whole-value`, `prefix-inference` |
| a reader of `cfg`, asked about `['cfg', 'b']` (`keyTimeline` / `forwardSliceForKey`) | no reader | a reader (a read around the key) |

On a log whose rows are all on their exact paths, every answer is the 9.32 answer.

**A write inside the key does not end a value's life.** In `forwardSliceForKey` a life runs to the next
write that replaces the value — never to one that only wrote a path inside the key: a reader after a
merge-back still read the rest of the anchored value, so it stays listed.

**A write found through a row inside the key wrote only PART of its value.** `keyTimeline` (any such
write moment) and `forwardSliceForKey` (such an anchor) say so with a `'nested-rows'` note naming the
commits: earlier writes may account for the rest, and a reader of the key may not have read the part
that write changed. The other readers carry the same code (F4b, same minor): `sliceForKey` has an
optional `notes` (a `'nested-rows'` note when its anchor wrote the key only through paths inside it —
absent otherwise, so an exact slice keeps its 9.32 shape; `sliceToJSON` copies it, `formatSlice` prints
it); each `causalChain` data edge to such a writer carries `basis: 'nested-rows'`, and a node that read a key no commit before it wrote says so in `preRunReads: { code: 'pre-run-origin', keys }` (the walk used to drop such a read silently); `arrayProvenance` has
an optional `basis` — the codes of `commitValueAtWithBasis` at `atIdx`, less what `missing` already says.

```typescript
import type { RuntimeSnapshot } from 'footprintjs';
import { arrayProvenance, keysReadFromExecutionTree, sliceForKey } from 'footprintjs/trace';

// Application boundary: inspect an actual completed run, not an invented log.
function inspectChanges(snapshot: RuntimeSnapshot) {
  const log = snapshot.commitLog;
  const reads = keysReadFromExecutionTree(snapshot.executionTree);
  return {
    cfg: sliceForKey(log, 'cfg', reads),
    score: sliceForKey(log, 'score', reads),
    gone: arrayProvenance(log, 'gone'),
  };
}
// If cfg's last writer wrote only a nested row, cfg.notes includes 'nested-rows'.
// An exact write of score needs no such note. A deleted gone array reports
// missing: 'not-an-array' with basis: ['deleted']; a never-written key differs.
```

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';
import { keysReadFromExecutionTree, keyTimeline } from 'footprintjs/trace';

const inner = flowChart('Enrich', (scope: any) => {
  scope.score = 7;
}, 'enrich').build();
const chart = flowChart('Seed', (scope: any) => {
  scope.cfg = { tier: 'gold' };
}, 'seed')
  .addSubFlowChart('enrich', inner, 'Enrich', {
    inputMapper: () => ({}),
    outputMapper: (out: any) => ({ cfg: { score: out.score } }),
  })
  .addFunction('Decide', (scope: any) => {
    scope.ok = scope.cfg.score > 5;
  }, 'decide')
  .build();
const executor = new FlowChartExecutor(chart);
await executor.run();
const { commitLog, executionTree } = executor.getSnapshot();

const timeline = keyTimeline(commitLog, 'cfg', keysReadFromExecutionTree(executionTree));
// moments: write @0 (the seed), write @1 (the merge-back), read by Decide — it saw the merge-back
// notes:   [{ code: 'nested-rows', detail: "'cfg' was written only through paths inside it at commit 1 — …" }]
```

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
(the SAME fold `commitValueAt` runs — `memory/verbs.ts · foldKey`; provenance only
watches it, it has no verb switch of its own, and a property test pins the two
to identical values) while carrying an index-aligned births array:

- `append` verbs (`commitValues: 'delta'`) hold exactly the new tail → **exact** attribution (`basis: 'append-verb'`)
- full-mode growth is consecutive `set`s where the old array is a strict prefix of the new → tail attributed by inference (`basis: 'prefix-inference'`, labeled honestly — a wholesale replacement sharing the old prefix is indistinguishable)
- anything else → `basis: 'whole-value'` (provenance reset)

Absence mirrors `VariableSlice`: `missing: 'empty-log' | 'never-written' |
'not-an-array'` (`'not-an-array'` = scalar/deleted/degraded key — that's
`sliceForKey` territory).

A row whose verb is not `set | merge | append | delete` is not folded as a merge:
`arrayProvenance` (like `commitValueAt`) throws `UnknownVerbError` naming the row.

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
root-log slice therefore ends at the outputMapper's write into the parent (the
merge-back bundle — see the known limit below for the stage it is recorded
under). To continue inside, re-anchor in the subflow's own scope with tree and
log paired from the SAME snapshot:

```ts
const sf = snapshot.subflowResults['sf-tools'];
sliceForKey(sf.commitLog, key, keysReadFromExecutionTree(sf.executionTree));
```

(Passing multiple trees to `keysReadFromExecutionTree` widens *read*
resolution when one log genuinely spans them; it does not make a root slice
cross a mount.)

### Who a merge-back names — the mount (R13)

The bundle that holds an outputMapper's merge-back is the MOUNT's commit, and
a subflow's input seed (`history[0]` of its log) carries the mount's names
too. So `findLastWriter(log, 'cfg')` and a slice's `writer` name the mount,
`causalChain` reaches the mount's own commit, and a reads provider keyed by
runtimeStageId names each reader once. A recording made through 9.33.0
stamped the merge-back with the stage before a branch or fork-child mount (or
the decider) and the seed with `''`; every reader still reads it, and answers
with the names it recorded (`test/lib/slice/nested-rows.test.ts`).


## Honesty model (inherited + added)

- `CausalNode.incompleteSources` / `truncated` pass through from `causalChain`;
  `ForwardNode` carries the same two, stamped from the writer's bundle.
- `VariableSlice.missing` / `ArrayProvenance.missing` — absence with a reason,
  never a silent empty object.
- `ElementBirth.basis` — exact vs inferred vs reset, on every record;
  `ForwardEdge.basis` — exact vs conservative, on every edge.
- `keysReadKind` + `readsCoverage` — a slice can always be traced to its reads
  provider, and a reads-less provider is detectable, not silent.
- `HonestyNote[]` (forward, timeline) — the machine-readable envelope: a consumer
  branches on `code`, a human/LLM reads `detail`. Six codes:
  `'unknown-key'`, `'reads-not-recorded'`, `'pre-run-origin'`,
  `'conservative-fed-edges'`, `'truncated'`, and `'nested-rows'` (9.33.0 — a
  write reached the key only through paths inside it). What each code MEANS is
  registered once, in `memory/honesty.ts · HONESTY_CODES` (served as
  `HONESTY_CODES` on `footprintjs/trace`): `HONESTY_CODES[note.code]` is the
  one-sentence explanation, and the `detail` is the per-instance sentence (it
  names the key or the budget). The module's other honesty words are
  registered there too — the `missing` reasons (`MissingSliceReason`,
  `MissingProvenanceReason`), `FedBasis` and `AttributionBasis` — and every
  one of these unions declares its members through `RegisteredCode`, so a code
  the registry does not hold does not compile.
- Redaction: this layer re-serves commit-log bytes; a redacted key's
  `'REDACTED'` placeholder — the log's string, `memory/placeholders.ts ·
  LOG_PLACEHOLDER`, spelled nowhere else in `src/` — stays redacted. No new
  leak surface. (Forward nodes carry identity and position only — no values
  at all.)

**The typo guard**, split by what the recording affords — because
"nothing read it" and "you spelled it wrong" must never render alike ("write"
and "read" as defined at the top: on, inside or around the key):

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
  Every file here is a record file (`RECORD_FILES`, C6), so even the tree
  `keysReadFromExecutionTree` walks is the record's own type, `ExecutionTree`
  (`memory/types.ts`): the ids, the keys of `stageReads`, `next` and
  `children`. A snapshot's `StageSnapshot` tree is one; so is a stored tree.
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
