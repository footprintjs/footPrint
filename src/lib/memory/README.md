# memory/

The foundation library of footprint. Zero dependencies on any other footprint library.

---

## Why This Exists

Traditional applications produce traces **after** execution — logs, spans, metrics — stitched together by an ops team or an LLM trying to reconstruct what happened.

That breaks when a user asks *"Why was my loan rejected?"* and the LLM needs to explain the reasoning. It can't reliably reconstruct a causal chain from disconnected log lines. It hallucinates. It misses steps. It costs tokens re-reading irrelevant context.

FootPrint's answer: **capture causality while executing, not after.** Every stage writes through a transactional buffer that records *what* changed and *how* (set vs. merge). Every commit is stored as a diff. The result is a complete, replayable execution history that any model — even a cheap one — can read and explain accurately.

**This memory library is the thing that makes that possible.**

It captures everything because the whole point of footprint is to produce **connected causal traces** as a byproduct of execution. Not reconstructed from logs. Not assembled after the fact. Connected *during* execution. That's the bet: if your runtime already knows exactly what data flowed where and why each branch was taken, explaining it to a human (or an LLM) is trivial.

---

## The Five Primitives

Each one exists to serve the main goal: **make every decision traceable, replayable, and explainable.**

---

### 1. SharedMemory — "The Heap"

A single shared store that all stages read from and write to, with automatic namespace isolation.

**Why it connects to the main goal:** For traces to be connected, all state must flow through a single, observable location. If stages stored data in local variables, closures, or scattered global objects, the runtime couldn't know what data influenced what decision. SharedMemory is the single source of truth — every read and every write passes through it, so the runtime can record the full data flow.

**Why not just a plain object?** Namespace isolation. Run A's `result` key must not collide with Run B's `result` key. SharedMemory stores data under `runs/{id}/` automatically — each flowchart execution (run) gets its own isolated address space. Values fall back from run scope to global scope — same as CSS inheritance or prototype chains — so you can set global defaults that any run overrides.

```typescript
const mem = new SharedMemory({ defaultTheme: 'light' });
mem.setValue('run-1', [], 'name', 'Alice');
mem.getValue('run-1', [], 'name');    // 'Alice'
mem.getValue('run-2', [], 'name');    // undefined (isolated)
mem.getValue('run-1', [], 'defaultTheme'); // 'light' (global fallback)
```

**Copy-on-write (9.29.0).** The state is a sequence of GENERATIONS, and a generation is never edited. Every write — a stage's commit (`applyPatch`, through `utils · nextGeneration`), `setValue`, `updateValue` — copies the root and the containers on each path it writes, shares every other subtree with the generation before it, and swaps the new one in. That is what lets a stage hold the generation it first touched by bare reference (its read snapshot and its buffer's diff base) for free, and it makes a write cost what it writes, not what the state holds. The seed (`initialContext` + defaults) is detached once, when the store is built.

```typescript
const before = mem.getState();
mem.applyPatch({ turn: 2 }, {}, [{ path: 'turn', verb: 'set' }]);
const after = mem.getState();
after === before;                    // false — a new generation
after.history === before.history;    // true  — untouched, so shared (no clone of the history)
before.turn;                         // still the old value — a generation is never edited
```

---

### 2. TransactionBuffer — "The Database Transaction"

Stages write here instead of directly to SharedMemory. Writes are staged, then flushed to SharedMemory in **one batch per stage**. Despite the name, this is a **staging buffer with read-your-writes — not a rollback mechanism** (see below).

**Why it connects to the main goal:** Every write is recorded in a chronological operation trace — which path was written, whether it was a `set` (overwrite) or `merge` (deep union). This trace *is* the causal record. Without it, you know the final state but not *how* you got there. The trace is what makes time-travel and deterministic replay possible — you can reconstruct the exact state at any point by replaying traces in order.

**Why not write directly to SharedMemory?** Three reasons:

1. **No mid-stage visibility** — Other stages (and parallel siblings) never see a stage's half-finished writes; everything lands in one commit when the stage finishes.
2. **Read-after-write consistency** — Within a stage, you see your own uncommitted writes immediately. Set `name = 'Alice'`, read `name`, get `'Alice'` — even before commit.
3. **Deterministic replay** — The operation trace enables exact state reconstruction at any commit point.

**What it does NOT give you: rollback.** When a stage throws, the engine still **commits everything staged so far** before re-throwing (commit-on-error in `FlowchartTraverser`). That is deliberate — the audit trail must record what the failing stage changed; evidence beats all-or-nothing semantics here. Do not rely on "stage failed → its writes vanished".

```typescript
const buffer = new TransactionBuffer(currentState);
buffer.set(['user', 'name'], 'Alice');     // staged, not applied
buffer.merge(['user', 'tags'], ['admin']); // staged
buffer.get(['user', 'name']);              // 'Alice' (read-after-write)

const { overwrite, updates, trace } = buffer.commit(); // one-batch flush (net change)
// trace = [{ path: 'user.name', verb: 'set' }, { path: 'user.tags', verb: 'merge' }]
```

**The base by reference; reads after the first write are the stage's own (9.29.0).** The buffer is built at the stage's first write from the committed generation the stage first touched — held BY REFERENCE as the net-change diff base (a generation is never edited), with a working copy that starts as a copy of the root only. Each write copies the containers on its own path. The first READ after the first write of a container still shared with committed state takes a private deep copy of it (`privatise`) — what the whole-state clone used to give every such read — so an in-place edit of a read value (out of contract: reads are borrowed) stays inside the buffer exactly as before 9.29.0. Whether the RECORD keeps such an edit is the admitted record's law (9.30.0, owner ruling R1): kept at or below a path the stage wrote in that stage — set, merged or written back alike — and lost elsewhere. A value the stage itself staged is handed back as it is; a merge privatises the value it merges into first, because `deepSmartMerge` unions arrays by reference.

```typescript
const buffer = new TransactionBuffer(committed);  // no clone — `committed` IS the diff base
buffer.set(['turn'], 2);                         // copies the root only
const h = buffer.get(['history']);               // a private copy, taken once
h.push('edit');                                  // stays private: committed.history is untouched,
                                                 // and nothing is recorded unless the stage writes `history`
                                                 // itself (set, merged or written back — 9.30.0)
buffer.peek(['history']) === h;                  // peek: a non-copying read, for reports that only compare
```

**Key design decision:** After commit, the working copy resets to `{}` (empty), not back to the base snapshot. This prevents a stale-read bug where the buffer would return old values instead of falling through to SharedMemory for the current committed state.

**The patch trees hold references until commit (9.23.0).** A `set` stores the caller's own value in `overwritePatch` — the same reference `workingCopy` always held — and the copy the record needs is taken ONCE per surviving path when the payload leaves the buffer (`toChangeOnlyPayload` / `toDeltaPayload`). The law "the record never aliases a caller's object" is kept at the commit boundary instead of at every write. Consequence: a caller who mutates its own object after the write and before the stage ends commits the value **as the stage read it back** — log and stage agree. The honest form of "snapshot it now" is `scope.$setValue(k, structuredClone(o))`.

```typescript
const o = { x: 0 };
scope.$setValue('doc', o);
o.x = 1;                 // the caller's own object, after the write
scope.doc.x;             // 1 — read-your-writes always said so
// at commit (9.23.0): overwrite.doc = { x: 1 } — the record now agrees (9.22.1 committed { x: 0 })
o.x = 2;                 // after the stage ends: changes NOTHING retained — the commit cloned it
```

---

### 3. EventLog — "Git History"

Stores commit bundles from every stage in chronological order. Reconstructs state at any point via replay.

**Why it connects to the main goal:** This is the execution history that powers time-travel debugging and the "what happened at step N?" question. When a user asks *"Why was my loan rejected?"*, the answer lives here — you can replay commits up to the rejection decision and see exactly what data the decider saw when it chose to reject. No log parsing. No guesswork. Exact state reconstruction.

**Why diffs, not full snapshots?** Memory. A run might have 200 stages. Storing full state at each step costs O(n * state_size). Storing just the diffs (commit bundles) costs O(n * diff_size) — typically orders of magnitude smaller. `materialise(stepIdx)` replays diffs from the beginning to reconstruct state. Same approach git uses.

```typescript
const log = new EventLog(initialState);
log.record(commitFromStage1);
log.record(commitFromStage2);

log.materialise(0);  // initial state — before anything ran
log.materialise(1);  // state after stage 1 — what did stage 2 see?
log.materialise();   // final state
```

**Key design decision:** Replay is O(n) from the beginning every time. Simple, correct, tiny memory footprint. For < 200 stages this is fast enough. Checkpoint caching can be added later without changing the API. Since 9.29.0 `materialise` clones its base once and replays every bundle into that private copy (`applySmartMergeInto` — below the root it follows the live commit's copy-on-write law, so the fold and live state agree at every path); the public `applySmartMerge` keeps its own contract, a fully detached result. **`materialise` is deprecated since 9.33.0** — nothing in the library calls it; `stateAt` (footprintjs/trace) folds the same log from the same base and says how it was derived (mind the index: `materialise(n)` folds commits `0..n-1`, `stateAt(source, n - 1)` the same commits).

**The record is immutable from `record` (9.33.0, ruling R3).** `EventLog · record` stamps a bundle's position and deep-freezes it (`capture/freeze.ts · deepFreeze`, arrays walked by index): the bundle, `overwrite` and `updates` at every depth, the trace and every row, each row's `readKeys`, `redactedPaths`, `tags`, `untrackedSources`. Before, `getSnapshot().commitLog` was a frozen ARRAY of the engine's own, writable bundles — one assignment into a snapshot rewrote every later `commitValueAt` and `stateAt` answer. Now it throws in strict code. Freezing cannot reach live state: nothing outside the log holds a bundle's containers — the log keeps the commit's own copy — since F4b the transaction buffer's commit-time payload itself, or `scrubPatch`'s spine copy of it — and live state, the redacted mirror and write retention each take theirs (pinned over real runs by test/lib/memory/property/record-reachability.property.test.ts). Freezing changes no byte of the log. Cost: the walk is at most 1.4% of the run at N = 10,000 element writes (`bench/element-writes.ts`, the freeze row; budget 5%).

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';

const executor = new FlowChartExecutor(
  flowChart('Seed', (scope: any) => {
    scope.cfg = { tier: 'gold' };
  }, 'seed').build(),
);
await executor.run();
const [bundle] = executor.getSnapshot().commitLog;
Object.isFrozen(bundle.overwrite.cfg); // true
// (bundle.overwrite.cfg as { tier: string }).tier = 'forged'; → TypeError in strict code
```

**Named holes** — what `Object.freeze` cannot reach stays mutable: Map and Set contents, a Date's time, the bytes of a typed array (skipped: a non-empty one cannot be frozen at all — which also made `getSnapshot()` throw for a `Uint8Array` in `initialContext` until 9.33.0), and an object hung on an array expando (the record walks arrays by index; args and the dev-mode snapshot keep the full walk). A frozen RegExp's `lastIndex` is read-only, so a `/g` or `/y` regex read from a bundle throws when `exec` or `replace` advance it — copy it (`new RegExp(re)`) to use it. `EventLog.record` on `footprintjs/advanced` freezes the bundle it is handed.

**One stage, one record — continuations are named by the writer (9.39.0, F8).** Some executions commit more than one bundle under one `runtimeStageId`: a subflow mount (its merge-back, then its exit) and a fork child (its own commit, then the fan-out's settle commit). The engine says which is which on the bundle: `StageContext · commit(phase?)` stamps `phase: 'exit'` (from `SubflowExecutor`) or `phase: 'repeat'` (from `ChildrenExecutor`) — but only on a frame that has ALREADY committed. THE LAW: the FIRST bundle per `runtimeStageId` is the stage's own and carries no `phase` key (and the declared tags); a mount with no merge-back (no `outputMapper`, a lazy mount, a `parallelForEach` branch) has its exit as that one own bundle. Readers group by `runtimeStageId` (first bundle = where the stage starts — `buildCommitIndex`) and read `phase`; none infers a continuation from the log's shape. A log written before 9.39.0 has no `phase` anywhere and is read by ONE legacy function, `commitLogUtils · inferLegacyPhases` (9.38.0's adjacency rule), and only when no execution tree is at hand. Before, `commitStops` guessed a mount from "the second bundle follows the first" — which a one-child fork also does.

```ts
const log = executor.getSnapshot().commitLog;
log.filter((b) => b.stageId === 'sf-pay').map((b) => b.phase); // [undefined, 'exit'] — merge-back, exit
log.filter((b) => b.stageId === 'child-a').map((b) => b.phase); // [undefined, 'repeat']
```

---

### 4. StageContext — "The Stack Frame"

Per-stage execution context. Wraps SharedMemory with a TransactionBuffer and provides tree navigation.

**Why it connects to the main goal:** The stage context is where *execution* meets *recording*. When a stage calls `commit()`, three things happen together: (1) patches are applied to SharedMemory, (2) the commit is recorded to EventLog, and (3) the write trace is logged to diagnostics. This triple-write is what makes traces connected — the execution, the history, and the diagnostics all stay in sync without the stage author thinking about it.

**Why does this exist? Why not hand stages a TransactionBuffer directly?** Because a stage needs more than read/write:

- **Namespace scoping** — Stage writes `result`, it lands at `runs/{id}/result`. The stage doesn't know about namespacing.
- **Tree structure** — Stages form a tree (next, children, parent). The engine traverses this tree for execution. Snapshots capture the full shape.
- **Commit orchestration** — The triple-write (SharedMemory + EventLog + DiagnosticCollector) happens inside `commit()`. If stages managed this themselves, someone would forget to record history and the trace would have a gap.

```typescript
const ctx = new StageContext('run-1', 'validate', 'validate', sharedMemory, '', eventLog);
ctx.setObject([], 'userName', 'Alice');   // staged
ctx.getValue([], 'userName');             // 'Alice' (read-after-write)
ctx.commit();                             // one step: applies + records + logs

const next = ctx.createNext('run-1', 'process', 'process');
const child = ctx.createChild('run-1', 'branch-1', 'parallelTask', 'parallelTask');
```

**Key design decision:** TransactionBuffer is lazily created — you only pay the `structuredClone` cost if the stage actually writes. Many stages are read-only; lazy instantiation saves real time.

**Key design decision — staging state is released at commit (#13b).** `commit()` nulls both the buffer (2 full-state clones) and the first-touch state view (a reference pinning one full committed-state generation) at its end; both re-create lazily if the context is touched again, so engine double-commit paths are observably identical. Without the release, the execution tree — which retains every StageContext for the lifetime of the run — pinned one state generation + two clones per executed stage: O(N²) retained heap on loop charts (the #18 finding; 849MB at 500 iterations, OOM for the full agent). See `docs/guides/execution-model.md` § "Staging-state lifetime".

**Read values are borrowed — do not mutate them.** Since the lazy buffer (#13), a read before the stage's first write returns a reference INTO COMMITTED SHARED STATE (the zero-clone first-touch view); a read after a write returns a reference into the buffer's working copy. Mutating a returned value in place corrupts state without a commit record — write changes back through `setObject`/`updateObject` (or, at the scope tier, `setValue`/`updateValue`). TypedScope consumers are safe automatically (the proxy routes every mutation through tracked writes). There is deliberately no dev-mode deep-freeze guard: freezing a buffer-served read would freeze the stage's own working copy (a later deep write into the same key throws), and freezing a committed-state read mutates an object shared with every other consumer of the live state — neither is a safe guard, so the contract is documented instead.

**Redaction — the one law (9.19.0):** a redaction policy covers everything retained or served (commit log in both encodings, redacted mirror, `stageReads`/`stageWrites`, narrative, a subflow's seed and merge-back, and since 9.20.0 a subflow's SERVED state — `subflowResults[*].treeContext.globalContext` under `redact: true` and `onSubflowExit.outputState` are the subflow's own nested mirror — its runtime keeps one because the run's policy says so, as the root's does — served by `engine/handlers/servedSubflowResults`) and never the live heap or the resume checkpoint. The verdict has ONE owner, `RedactionRule` (`redaction.ts`), carried by the run's policy ([below](#runpolicy--one-object-for-the-dials-the-rule-and-the-mirror-f5)) — so every frame of the run, a subflow's seed frame included, holds the same rule by reference. `StageContext.stageWrite` is the ONE funnel every staged write passes through: it asks the rule, stages the write with the paths the log will scrub (a whole key, or the `fields` inside the value via `TransactionBuffer.markRedactedFields`), and marks/unmarks the run's shared set; `getValue` retains reads under the same verdict (`retainedForm`: placeholder beats every dial, a field scrub happens before the dial sees the value). A bypassing path is therefore impossible to write without noticing — there is no second decider. Placeholders are historical: `redactPatch` writes `'REDACTED'` into the log and mirror (and so into a subflow's served state, which is a mirror); retention and the scope channel's recorder views carry `'[REDACTED]'` — the commit path's scrub is `scrubPatch` (`redaction.ts`, 9.33.0), clone-free: no path to scrub (no policy, no per-call mark) hands back the buffer's commit-time payload itself, otherwise only the spine of each scrubbed path is copied — byte-identical to the old whole-patch clone (pinned by the 9.18.1 / 9.19.1 redaction tests); the public `redactPatch` (`footprintjs/advanced`) keeps its contract, a fresh deep copy; the two strings are owned by `placeholders.ts` (`LOG_PLACEHOLDER` / `SCOPE_PLACEHOLDER`, [below](#honesty--one-vocabulary-for-what-a-reader-cannot-see)) and spelled nowhere else in `src/`.

**Read-tracking policy (#14):** the per-read `structuredClone` into the snapshot's `stageReads` view is policy-gated via `ReadTrackingMode` — `'full'` (default, historical behavior), `'summary'` (cheap type/size/preview marker per read), `'off'` (no `stageReads`, zero per-read cost). Set per executor: `new FlowChartExecutor(chart, { readTracking: 'off' })` or `executor.setReadTracking('off')`. Only the snapshot payload changes — `onRead` events (and therefore narrative) pass the live reference and are identical in every mode.

**Write-tracking policy (#13c-A):** the independent sibling dial for the per-write `structuredClone` into `stageWrites`, via `WriteTrackingMode` (same `'full' | 'summary' | 'off'` family — both dials alias `RetentionPolicy` from `lib/capture`, which also owns the shared marker builders). Set per executor: `new FlowChartExecutor(chart, { writeTracking: 'summary' })` or `executor.setWriteTracking(mode)`. Two consumers see the policy: the snapshot's `stageWrites` (markers under `'summary'`, absent under `'off'`) and the commit observer — `ScopeRecorder.onCommit` mutations are a spread of `_stageWrites`, so they carry the same markers or arrive empty. The WRITE itself is untouched in every mode: shared state, the transaction buffer, and the commit log are byte-identical (commit-log payloads are #13c-B's delta verb, not this dial), and `onWrite` fires with the live value regardless. Redaction beats the dial — `'[REDACTED]'` under `'full'`/`'summary'`, nothing retained under `'off'`.

**Commit-values encoding (#13c-B):** the third dial — `CommitValuesMode = 'full' | 'delta'` — governs the COMMIT LOG's value encoding, and unlike the two retention dials it is **lossless in both modes**. `'full'` (default) is byte-identical to history. `'delta'`: an array net-change that is "base plus a tail" commits an `append` trace verb whose `overwrite[path]` holds ONLY the tail (the growing-history log becomes linear instead of O(N²) retained); `deleteValue()` commits a real `delete` verb (replay removes the key — closes the set-`undefined` flattening); bundles carry exactly ONE trace entry per surviving path (append is not idempotent on replay; since 9.30.0 every path commits the value the stage read back — the admitted record, below). `applySmartMerge` replays all four verbs, so live state, `materialise()`, and the redacted mirror reconstruct every step exactly. The one consumer-visible change: `overwrite[path]` is verb-qualified — use `commitValueAt(commitLog, idx, key)` (`footprintjs/trace`) for "the full value at this commit". Set per executor: `new FlowChartExecutor(chart, { commitValues: 'delta' })` or `executor.setCommitValues('delta')`; surfaced as `getSnapshot().commitValues`. Design memo: `docs/design/13c-b-delta-commit-verb.md`.

---

**RunPolicy — one object for the dials, the rule and the mirror (F5).** `runPolicy.ts` folds the four dials (`readTracking`, `writeTracking`, `commitValues`, `writeProvenance`), the `RedactionRule` and the `mirror` flag into ONE frozen `RunPolicy`. WHY: through 9.34.0 each setting was copied field by field down three paths — `ExecutionRuntime.use*` on the root, six assignments in each of `createNext`/`createChild`, and a duck-typed `getReadTracking?.()`-style push per dial in `SubflowExecutor` — so a new dial was six edits and a missed one ran a subflow on the default silently. Now `FlowChartExecutor · createTraverser` builds the policy once per leg (run AND resume — a resume brings a fresh rule), `ExecutionRuntime` takes it at construction (or `usePolicy` on a same-executor resume's continuation root) and installs it on its root frame (`newRoot`), every frame takes the SAME reference (`StageContext · inheritRun`, called by `createNext` and `createChild`), and `SubflowExecutor · executeSubflow` constructs the nested runtime with the parent frame's policy — BEFORE `seedSubflowGlobalStore`, so a subflow's seed (`history[0]`) commits under the run's dials too (C-F5: under `writeProvenance: 'reads-prefix'` its rows carry `readKeys: []`; under the other three the bytes are unchanged). The policy is immutable; a bare frame that brings its own rule (`ScopeFacade` on a hand-built context) gets a NEW policy (`withRedaction`). The mirror STORE is not policy — each runtime keeps its own when `mirror` is set. A fifth dial is two files: a field + default here, and the frame code that reads it.

```ts
const policy = runPolicy({ commitValues: 'delta' }, rule, /* mirror */ true);
const runtime = new ExecutionRuntime('root', 'root', undefined, undefined, policy);
runtime.rootStageContext.createNext('', 'next', 'next').getPolicy() === policy; // true — by reference
```

### 5. DiagnosticCollector — "The Flight ScopeRecorder"

Per-stage metadata: logs, errors, metrics, evaluation scores, flow control messages.

**Why it connects to the main goal:** The EventLog tells you *what data changed*. The DiagnosticCollector tells you *why* — the human-readable narrative. When a decider stage writes *"Risk tier: high. DTI at 60% exceeds the 43% maximum"* to the log, that message becomes a sentence in the narrative that the LLM reads to answer the user's question. EventLog is the data trace. DiagnosticCollector is the story trace. Together they produce the full causal explanation.

**Why separate from execution state?** Diagnostics are observational — they never affect execution logic. The flowchart doesn't branch based on how many errors a previous stage logged. Keeping them separate means:

- Diagnostics can't corrupt execution state
- They can be safely dropped or filtered without affecting results
- They form a clean "what happened and why" narrative alongside the "what changed" in EventLog

```typescript
const diag = new DiagnosticCollector();
diag.addLog('message', 'Validated user input — all fields present');
diag.addMetric('duration_ms', 42);
diag.addError('validation', { field: 'email', reason: 'invalid format' });
diag.addFlowMessage({ type: 'branch', description: 'chose rejection path', timestamp: Date.now() });
```

---

## How They Work Together

The full flow for a single stage:

```
1. Engine creates StageContext(runId, stageName, sharedMemory, eventLog)

2. Stage function receives a scope object (built from StageContext by the scope layer)

3. Stage writes → StageContext → TransactionBuffer
   (buffer constructed lazily on the stage's FIRST write — #13; since 9.29.0
    it holds committed state by reference and copies only the paths written)
   (staged in buffer, not applied to shared memory yet)
   (every write recorded in operation trace)

4. Stage reads → StageContext → TransactionBuffer (if a write created one) → SharedMemory (fallback)
   (read-after-write: sees own uncommitted writes)
   (after the first write: a read of committed state is the stage's own copy — once per container)
   (before any write: reads go straight to SharedMemory — zero clones, borrowed)

5. Stage finishes → engine calls ctx.commit():
   a. TransactionBuffer.commit()  → returns { overwrite, updates, trace }
      (no buffer = stage never wrote → empty bundle recorded, zero clones)
   b. SharedMemory.applyPatch()   → the next generation: written paths copied, the rest shared (visible to next stage)
   c. EventLog.record()           → history recorded (replayable)
   d. DiagnosticCollector.addLog() → trace logged (debuggable)

6. Next stage gets a fresh StageContext → same SharedMemory, fresh (lazy) buffer
```

For parallel execution (fork/join):

```
Parent creates N children via createChild()
     |
     +-→ Child 1: own StageContext, own TransactionBuffer (isolated)
     +-→ Child 2: own StageContext, own TransactionBuffer (isolated)
     +-→ Child N: own StageContext, own TransactionBuffer (isolated)
     |
     Each child commits independently to SharedMemory
     (parallel children can't see each other's uncommitted writes)
     (last writer wins for overlapping keys)
     |
     Join stage: fresh StageContext, sees all committed results
```

---

## Design Decisions — Each Traced Back to the Main Goal

| Decision | Why | How it serves the goal |
|---|---|---|
| Single SharedMemory as source of truth | All data flows through one observable location | Every read/write is capturable — no hidden state |
| Namespace isolation via `runs/{id}/` prefix | Prevents collisions between concurrent runs | Parallel runs produce clean, separate traces |
| Run-then-global fallback reads | Global defaults with per-run overrides | Traces show where a value came from (local vs. inherited) |
| TransactionBuffer with operation trace | Records *how* state changed, not just *what* | Enables deterministic replay and time-travel |
| One staged commit per stage (NOT rollback) | No mid-stage visibility; on a stage error the staged writes still commit — audit evidence over all-or-nothing | Every commit in the history is one stage's net change, including what a failing stage changed |
| Diff-based EventLog (not full snapshots) | O(1) storage per commit | Can store complete history without blowing up memory |
| Replay-based materialise | Reconstructs state at any point | Time-travel debugging: "what did the decider see at step 47?" |
| DiagnosticCollector separate from state | Observational data can't corrupt execution | Stage narratives are always safe to capture — no side effects |
| Lazy TransactionBuffer creation | Only build a buffer if the stage actually writes | Performance: read-only stages are free |
| `structuredClone` for isolation — of VALUES crossing the commit boundary | Prevents external mutation of internal state: a written value is cloned once at commit (9.23.0), a replayed value once per replay; the state itself is copy-on-write (next row) | History is immutable — replaying always gives the same result |
| Copy-on-write commit (9.29.0, `verbs` · `nextGeneration` / `foldRows`, `pathOps` · `ownSpine` / `ownedRootOf`, `TransactionBuffer` · `privatise`) | Every writing stage cloned the WHOLE state three times (buffer ×2, commit ×1; ×4 with a mirror), so one changed number paid for an agent's whole conversation: 8 clones / 3.05 MB / 180,053 nodes per stage at N = 10,000. THE LAW: a committed generation is never edited; a commit copies the root and every container on each written path and shares the rest; a writer edits in place only what it created in the current operation. | 5 clones / 29 B / 6 nodes at every N (`bench/commit-clones.ts`; counted guard: `test/lib/memory/boundary/commit-cost-independent-of-state.test.ts`, red on 9.28.0). Byte-identical to 9.28.0 for every in-contract program — a differential against the published 9.28.0 and a pinned 320-program corpus, both encodings (`test/lib/memory/property/copy-on-write-differential.property.test.ts`). Reads after the first write stay private (option D, no setting), so in-place edits of reads behave as before; a read the working copy cannot answer (a key the stage deleted) is served from live state as before, after `TransactionBuffer` · `detachBase` gives the diff base a private copy at that path. Named moves, each pinned against the real 9.28.0 in `test/lib/memory/scenario/copy-on-write-commit.test.ts`: M3 (a write through an alias changes that path only), M4 (a class instance in `initialContext` is plain from the first stage), M5 (the seed is detached at construction), M6 (Date expandos stay in live state), M7 (a read BEFORE the first write, edited after it and written back, records no change — dev mode warns), M8 (a nested write through a value the same stage set copies it). Census (design page): with every generation frozen the engine never writes into committed state; a freeze-based dev guard waits on the typed scope proxying frozen values. Not chased: a write still copies each container on its path in full (a root with thousands of keys pays that width). |
| The admitted record (9.30.0, `TransactionBuffer` · `admit`, `admission.ts` · `lossyFamilies`; docs/design/2026-10-admitted-record.md) | The buffer keeps ONE accumulated merge delta per path and the bundle replayed it at every `merge` row of the path — faithful only while the merges compose. `$update('k',{x:1}); $setValue('k',{y:2}); $update('k',{z:3})` reads back `{y:2,z:3}` and committed `{y:2,x:1,z:3}`; the typed scope's `s.k = {a:1}; s.k.b = 2; delete s.k.b; s.k.c = 3` committed the deleted `b`. Nothing checked the record against what the stage read. | THE LAW: a commit is admitted only if its bundle, replayed onto the state the stage began from, gives back the stage's working copy at every path it touched and every container / array slot its writes made on the way, below its address (`runs/<id>` — where a namespaced stage writes, not a value it reads). Checked with one `dryFold` (no clone) when the stage staged a `merge` or a nested op; a stage of root-key `set`/`delete` only is the read-back by construction. A family that does not fold back is re-encoded as `set` rows of the read-back (C2); an in-place edit of a merged value is recorded like a set one (C3, owner ruling R1); the delta encoder's values come from one fold — `replayPathVerbs`/`replayFamilyVerbs` deleted (C4); a dropped nested op whose container the stage read back is recorded (C5). Example: the `$update`/`$setValue`/`$update` stage above now commits `{y:2,z:3}`. Every commit that already folded back keeps its bytes (the four byte-identity references unchanged, both encodings); clone counts unchanged on every `bench/commit-clones.ts` row. Pinned by `test/lib/memory/property/record-equals-read-back.property.test.ts` (an independent oracle; 8 arms × 1,000 programs) and, on both engines end to end, by the witness in `property/copy-on-write-fixture.ts`. |
| Replay skips a `set` superseded by the NEXT `set` of the same path (9.22.1, `verbs.ts` · `supersededByNextSet`) | A `set` row writes a clone of the recorded value; a consecutive `set` of the same path writes a clone of the SAME value over it with nothing running in between, so the first write is unobservable. The 9.22.0 element-write funnel records N whole-array `set` rows on one path; without the skip a replay clones the array N times per fold. | Replay is O(N) not O(N × rows) — fold at 1,000 rows 241 ms → 1 ms, log bytes IDENTICAL (pinned against 9.22.0 references, both encodings). CONSECUTIVE-ONLY is the law: the wider skip (any earlier row on the path) is NOT byte-safe — `set list; delete list.1; set list = 0` materialises through a primitive and the second `set` REPAIRS it; fast-check found this on run 228 and both counterexamples are pinned in `test/lib/memory/unit/repeated-path-skips.test.ts`. Shared by every replay owner via `foldRows` (the delta encoder's own replay, `replayFamilyVerbs`, was deleted in 9.30.0); `commitValueAt` anchors at the last `set` and needs none. |
| One verb law (`verbs.ts` · `applyVerb`, `foldRows`, `foldKey`) | A commit row's verb was interpreted by THREE switches that had to stay in lockstep — the replay, `commitValueAt`, `arrayProvenance` — and they had drifted: `commitValueAt` cloned a bundle's merge delta once per ROW, so two `$update`s of one key after a `set` in one stage returned the array elements twice where state and `stateAt` held them once. | ONE step turns a row into a value (`applyVerb`; `placeVerb` puts it); `foldRows` folds a bundle into a state and takes the clone DISCIPLINE as a parameter (`'private'` = `applySmartMerge`, `'pathCopy'` = the live commit and the read-side folds, `'byReference'` = `dryFold`), `foldKey` folds one path across a log (`commitValueAt`; `arrayProvenance` is an observer of it). A bundle's merge delta is detached once per bundle. There is one `append` arm in the library (it was three). Pinned by the old replicas kept as the CONTROL in `test/lib/memory/property/verb-law-differential.property.test.ts`; byte-identical for every engine run. The one behaviour change: an unknown verb is refused (`UnknownVerbError`, below), where the old switches folded it as a merge. |
| Commit payload memoises the net-change verdict per path (9.22.1, `TransactionBuffer` · `toChangeOnlyPayload`) | The same stage writing one path k times cloned that path's value k times into the payload. | One clone per consecutive run of the same path at commit (500 sets → 1 clone, spied). Same consecutive-only law as above, for the same reason. |
| Clone once at commit — the patch trees and the tracked writes hold the caller's REFERENCES until the stage commits (9.23.0, `TransactionBuffer` · `set` / `detachHeldAncestors`; `StageContext` · `trackWrite` / `materialiseWrites`) | After 9.22.1 the stage BODY was still O(N²) for N element writes on one array: every write paid two `structuredClone`s (the buffer's patch copy and the `_stageWrites` retention) of a value the next write overwrote. A patch only needs to be final at COMMIT, and the last write to a path wins — so the copy is taken there, once per surviving path and once per tracked key. | The law "the record never aliases a caller's object" is kept at the commit boundary (proof: `test/lib/memory/scenario/clone-once-at-commit.test.ts`); the three byte-identity reference suites pass unchanged in both encodings. The ONE moved behaviour, and it is CLAUDE.md landmine 3's first bite CLOSED: `$setValue(k, o); o.x = 1` now commits `x: 1` — the value the stage read back — instead of a stale write-time snapshot the stage itself never saw; the honest form of the old intent is `$setValue(k, structuredClone(o))`. The engine's OWN nested ops (`set a` then `merge a.b`, unreachable from the scope proxy, which writes root keys) detach the held ancestor first, because `workingCopy` alone receives a nested merge's result and a shared container would leak it into `overwrite` — the design page missed this; the `set-merge-interleaved` reference pins it. Bench (`bench/element-writes.ts`): see the CHANGELOG [9.23.0] table. |

---

**The story in order** — base algorithm, each optimisation, what it traded, what it measured, what was refused: [docs/guides/the-fold-and-how-it-got-fast.md](../../../docs/guides/the-fold-and-how-it-got-fast.md).

## The Verb Law and the leaves under it

A commit row carries one of four verbs — `set | merge | append | delete` — and ONE step turns a row into a value. Every reader of the log folds that step; nothing else in the library has an arm per verb.

| File | Layer | Owns |
|---|---|---|
| `verbs.ts` | L1 | **The one verb law.** `applyVerb` (one row → a value), `placeVerb` (put it, or remove the key), `foldRows` (one bundle into a state — the clone discipline `'private'` / `'pathCopy'` / `'byReference'` is a parameter), `foldKey` (one KEY across a log — every row under its top-level key, read at the key: `commitValueAt` runs it, `arrayProvenance` and the writer rule watch it), `supersededByNextSet`, `VERBS` / `isVerb`, `UnknownVerbError`, and the four doors over `foldRows`: `applySmartMerge`, `nextGeneration`, `applySmartMergeInto`, `dryFold` |
| `keyPaths.ts` | L0 | **Which rows touch a key** (9.33.0): `relation` (a row on, inside or around a key — a segment prefix on DELIM paths), `rootOf`, and the writer index — a path TRIE (`buildWriterIndex`, `nodeAt`, `ancestorNodes`, `subtreePositions`): a key's candidates cost O(depth + matches). The rules every key query follows are defined in its header — see the next section |
| `logModel.ts` | L3 | **The read model of one log**: the writer and value rules at a cost proportional to the answer — the index built once, each top-level key folded at most once (keeping its value before and after the commits a verdict can ask about), the last writer found lazily. Memoised on a frozen log (every engine log since F3) |
| `paths.ts` | L0 | The path codec: `DELIM`, the one separator inside a `TraceEntry.path` (never a dot — a state key may contain one), `normalisePath` to write a path, `pathSegments` to take it apart |
| `equality.ts` | L0 | `deepEqual` — structural equality of committed-state values: `Date` / `Map` / `Set` by content, an own `undefined` is a deleted key, cycles terminate |
| `merge.ts` | L0 | `deepSmartMerge` — the union merge the `merge` verb applies: arrays union, objects recurse, `[]` clears, cycles terminate |
| `utils.ts` | L1 | The nested-object helpers (`setNestedValue`, `updateNestedValue`, `updateValue`, `getNestedValue`; `redactPatch` moved to `redaction.ts` in 9.33.0, beside the engine's clone-free `scrubPatch`) and the one re-export surface of the four files above, so no importer moved |

`paths.ts`, `equality.ts` and `merge.ts` import nothing; `verbs.ts` imports only them and `pathOps.ts` (layer table: `scripts/layering.config.cjs`).

```typescript
import { applySmartMerge } from 'footprintjs/advanced';

// One stage's commit — `s.name = 'b'; s.$update('tags', ['x']); s.$delete('tmp')` — replayed onto the state it began from.
const next = applySmartMerge(
  { name: 'a', tags: ['y'], tmp: 1 }, // base
  { tags: ['x'] }, // updates: the merge deltas
  { name: 'b' }, // overwrite: the set values
  [
    { path: 'name', verb: 'set' },
    { path: 'tags', verb: 'merge' },
    { path: 'tmp', verb: 'delete' },
  ],
);
// next → { name: 'b', tags: ['y', 'x'] }
```

**A row whose verb is none of the four is refused with `UnknownVerbError` (naming the row) by `applySmartMerge`, `commitValueAt` and `arrayProvenance`, never folded as a `merge`** — engine-written logs carry only the four, so an engine run never meets it; a foreign or corrupted log does. (`stateAt`, the cursor's reader, keeps its own answer for such a bundle: a gap with the reason, and the rest of the log folds.)

```typescript
import { commitValueAt, UnknownVerbError } from 'footprintjs/trace';

try {
  commitValueAt(commitLogFromAnotherTool, commitLogFromAnotherTool.length - 1, 'history');
} catch (error) {
  if (error instanceof UnknownVerbError) {
    // error.verb === 'upsert', error.path === 'history', error.row === 0, error.commit === 3
    console.error(error.message); // unknown verb "upsert" on trace row 0 (path "history", commit 3): a commit row is one of set | merge | append | delete — the log is refused, not replayed as a merge
  }
}
```

## Which rows touch a key — `keyPaths.ts` (9.33.0, ruling R4)

Every key query — `commitValueAt`, `findLastWriter`, `findCommit`, `causalChain`, and the slice layer's `sliceForKey`, `arrayProvenance`, `keyTimeline`, `forwardSliceForKey` — asks the log ONE question, "which rows wrote this key?", and asks it here. Until 9.32 each answered with its own `row.path === key`, so a key the engine wrote through a NESTED row read as "never written" while the fold applied it: a subflow's input seed (`cfg␟a`), an outputMapper merge-back (`cfg␟b`), a fork child's namespace (`runs␟c0␟x`).

| Rule | What it says | Applied by |
|---|---|---|
| path relation | a row is ON the key (`'exact'`), INSIDE it (`'inside'` — it wrote part of the value) or AROUND it (`'around'` — it wrote a container holding it); a segment prefix, so `cfg` is never around `cfgX` | `keyPaths · relation` |
| writer rule | a commit WROTE the key when it has a row on or inside it, or a row around it across which the value at the key differs — the whole commit compared, so `$update('cfg', { list: [3] })` is not a write of `cfg␟a` | `commitLogUtils · writersOf` / `findLastWriter` |
| value rule | the value of the key is the fold of EVERY row under its top-level key, anchored at that key's last `set`/`delete`, read at the key — `stateAt`'s fold restricted to one top-level key, exact because top-level keys never interact (folding only the rows that touch the key is NOT: an array union dedups the whole array) | `commitLogUtils · commitValueAt` (`verbs · foldKey`) |
| read rule | a stage read the key when its reads provider names the key, a path inside it, or a container around it | `slice/keyIndex · readsOf` |

A top-level key has nothing around it, so for it the writer rule is the path check alone and costs what the old scan cost. On exact-row logs every answer is the 9.32 answer (pinned as the CONTROL in property/verb-law-differential.property.test.ts); everywhere, `commitValueAt(log, i, k)` IS `stateAt({ commitLog: log }, i)` read at `k` (property/keyed-fold-differential.property.test.ts).

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';
import { commitValueAt, findLastWriter } from 'footprintjs/trace';

const inner = flowChart('Enrich', (scope: any) => {
  scope.score = 7;
}, 'enrich').build();
const chart = flowChart('Seed', (scope: any) => {
  scope.cfg = { tier: 'gold' };
}, 'seed')
  .addSubFlowChart('enrich', inner, 'Enrich', {
    inputMapper: () => ({}),
    outputMapper: (out: any) => ({ cfg: { score: out.score } }), // merged back as the nested row cfg␟score
  })
  .build();
const executor = new FlowChartExecutor(chart);
await executor.run();
const { commitLog } = executor.getSnapshot();

commitValueAt(commitLog, commitLog.length - 1, 'cfg'); // { tier: 'gold', score: 7 } — 9.32 answered { tier: 'gold' }
findLastWriter(commitLog, 'cfg'); // the merge-back's bundle — 9.32 named the seed's
```

A write found through a row INSIDE the key changed only PART of its value; `keyTimeline` and `forwardSliceForKey` say so with the `'nested-rows'` honesty note.

**Every absence names its basis (F4b, 9.33.0).** `commitValueAt` and `findLastWriter` keep their signatures; each has a twin that returns the same answer with the codes that say what it rests on — `commitValueAtWithBasis(log, idx, key, { initialState? }) → { value, basis }` and `findLastWriterWithBasis(log, key, before?) → { writer?, basis }`. A value's basis: `'never-written'` (no writer in range), `'deleted'` (written, and its last write left it absent), `'nested-rows'` (it rests on rows inside the key, with no `set`/`delete` of the key or around it in range), `'from-initial-state'` (no such `set`/`delete`: with `initialState` it folds from that base — `stateAt`'s value — and without it the answer is partial), `'redacted'` (a commit it rests on lists a path at, inside or around the key in `redactedPaths` — asked of the path list, never of the placeholder string). An exact answer has `basis: []`. `test/architecture/absence-codes.test.ts` lists every `/trace` reader that can answer `undefined` or empty for a key and where its code lives.

```typescript
import { commitValueAtWithBasis, HONESTY_CODES } from 'footprintjs/trace';

const snap = executor.getSnapshot();
const last = snap.commitLog.length - 1;
commitValueAtWithBasis(snap.commitLog, last, 'cfg');
// { value: { b: 'REDACTED' }, basis: ['nested-rows', 'from-initial-state', 'redacted'] } — a redacted merge-back
commitValueAtWithBasis(snap.commitLog, last, 'cfg', { initialState: snap.initialState }).value; // the stateAt value
HONESTY_CODES['from-initial-state']; // the one sentence to show
``` Since R13 that bundle is the subflow MOUNT's own commit, so the writer it names is the mount — see slice/README.md.

## Honesty — one vocabulary for what a reader cannot see

A recording cannot always answer what it is asked, and the library says so in several places: a slice's `HonestyNote`s and `missing` reason, a fed edge's and an element birth's `basis`, a fold's `basis` and `redacted` paths, a stored log's `LogGap`s, a causal node's `incompleteSources` and `truncated`. A reader that wants to explain any of them to a person (a why-panel, an agent tool) kept its own table of code → sentence, and tables kept apart drift. `honesty.ts` is the one place that names them. It imports nothing. The placeholder a redaction leaves where a value was is a different thing with a different reader — the engine's write path — so it has its own leaf, `placeholders.ts`.

| Owns | What |
|---|---|
| `HONESTY_CODES` (`honesty.ts`) | A frozen, closed registry: code → the one sentence that says what it means (rustc's `--explain`, LSP's `Diagnostic.code`; the code is what a consumer branches on, the sentence is for the screen). Twenty-one codes: the six slice-note codes (`'nested-rows'` since 9.33.0); the three `missing` reasons (`empty-log`, `never-written`, `not-an-array`); the fed-edge bases (`per-write`, `stage`) and the element-birth bases (`append-verb`, `prefix-inference`, `whole-value`); the two fold bases (`initial+log`, `log-only`); the two value-basis codes of `commitValueAtWithBasis` (`deleted`, `from-initial-state` — 9.33.0); and `log-gap` / `incomplete-sources` / `redacted` — registered so a reader explains `LogGap`, `CausalNode.incompleteSources` and `FoldedState.redacted` from the same place, though none carries a `code` field (a `truncated: { byDepth, byNodes }` field means `truncated`). A pure expression, so a bundle that never reads it drops it. Served as `HONESTY_CODES` and `HonestyCode` on `footprintjs/trace` |
| `RegisteredCode<T>` (`honesty.ts`) | The gate. `HonestyNoteCode`, `MissingSliceReason`, `MissingProvenanceReason`, `FedBasis`, `AttributionBasis` and `FoldBasis` declare their members through it, so a code the registry does not hold fails to compile (TS2344). `RegisteredCode<T>` is `T`: the public unions are exactly the members they were, not widened to every code |
| `LOG_PLACEHOLDER` / `SCOPE_PLACEHOLDER` (`placeholders.ts`) | The two strings a redaction leaves where a value was: `'REDACTED'` in the commit log and the mirror (`redactPatch`) — and so in a fold, a slice, and a subflow's served state, which is its own mirror (`onSubflowExit.outputState` included, whenever a policy keeps one); `'[REDACTED]'` on the scope channel (scope recorder events, `stageReads`/`stageWrites`, narrative, decision evidence, an `emitPatterns` payload). Two on purpose — stored recordings hold the first. No other `src/` file spells either as a literal (`test/architecture/placeholders.test.ts`) |

**Why two leaves, both L0.** Each imports nothing. `utils.ts` (L1) writes the log placeholder and `redaction.ts` (L2) the scope one, on every redacted run; `slice/` and `time-travel/` (L3) type their codes through the registry. Kept in one file, the write path pulled the registry's sentences into every app bundle that runs a chart (layer table: `scripts/layering.config.cjs`).

```typescript
import { forwardSliceForKey, HONESTY_CODES, keysReadFromExecutionTree, stateAt } from 'footprintjs/trace';

// One lookup explains any honesty signal — no table of your own to keep in step.
const { notes } = forwardSliceForKey(snapshot.commitLog, 'creditTier', keysReadFromExecutionTree(snapshot.executionTree));
for (const { code } of notes) console.log(code, '→', HONESTY_CODES[code]);
// reads-not-recorded → This log carries no recorded read at all (the readTracking: 'off' signature), so …

const { basis } = stateAt(snapshot, 3);
console.log(HONESTY_CODES[basis]); // 'log-only' → No initialState travelled with this log (…), so the fold started from an empty object …
```

Adding a code is one new line in `HONESTY_CODES`. A union declared through `RegisteredCode` cannot hold a code without that line (it does not compile), and `test/architecture/honesty-vocabulary.test.ts` fails on a union of string literals `footprintjs/trace` exports that is neither inside the registry nor named there, with its reason, as a different kind of word.

## Dependency Graph

```
This library has ZERO dependencies on other footprint libraries.

  StageContext
  /     |     \
SharedMemory  TransactionBuffer  DiagnosticCollector
  \     |
  EventLog
    |
  verbs (applyVerb, foldRows, foldKey — the one verb law; applySmartMerge, nextGeneration, dryFold)
    |
  paths · equality · merge · pathOps (leaves) — utils re-exports them and holds the nested-object helpers
  keyPaths (leaf) — which rows touch a key; read by TransactionBuffer (L2) and every log reader (L3)
  honesty (leaf) — HONESTY_CODES; typed through by slice/ and time-travel/
  placeholders (leaf) — the two redaction strings; read by utils, redaction, StageContext, decide/, scope/, runner/
    |
  types (MemoryPatch, CommitBundle, TraceEntry, FlowMessage, etc.)
```

External dependencies: none — nested-path traversal uses the native `pathOps.ts` helpers, which replaced `lodash.get`/`lodash.set`/`lodash.has`/`lodash.mergewith`.

---

## Test Coverage

Four test tiers, 114 tests across 17 suites:

| Tier | What it proves | Example |
|---|---|---|
| **unit/** | Individual method correctness | SharedMemory.setValue returns correct value |
| **scenario/** | Multi-step workflow correctness | stage writes → commit → next stage reads |
| **property/** | Invariants hold for random inputs (fast-check) | replay N commits = same state every time |
| **boundary/** | Edge cases and extremes | 10K-item arrays, 200 sequential commits, 100 parallel children |

### Tested Capacity (Boundary Results)

These are tested and passing — not theoretical limits, but what the test suite proves works:

| What | Tested at | Detail |
|---|---|---|
| Sequential commits | **200** | 200 stages in a chain, materialise at any step ✓ |
| Parallel children | **100** | 100 concurrent buffers, all commit without data loss ✓ |
| Keys per commit | **1,000** | Single commit with 1K key-value pairs ✓ |
| Object value size | **100KB+** | 10,000-item array (serialised >100KB) in one commit ✓ |
| State fields for materialise | **500** | EventLog materialise with 500-field bulk object ✓ |
| Deep nesting | **50 levels** | 50-level nested path read/write ✓ |
| Commit determinism | **random inputs × 50 runs** | Property test: N random commits replayed = same state every time ✓ |
| Namespace isolation | **random inputs × 50 runs** | Property test: N runs writing same key never interfere ✓ |
| Empty inputs | **all primitives** | No constructor args, no writes, no defaults — nothing crashes ✓ |

---

## Backward Causal Chain (backtrack.ts)

`causalChain()` implements backward program slicing to answer **"what stages contributed data to this result?"** See [algorithm.md](./algorithm.md) for the full algorithm reference, complexity analysis, staged optimization strategy, and academic references.

### Staged Optimization

`causalChain()` automatically selects the optimal writer-lookup strategy:

| Commit log size | Strategy | Per-lookup cost |
|----------------|----------|-----------------|
| ≤ 256 | Linear scan | O(N) — zero setup |
| > 256 | Reverse index + binary search | O(log N) — O(N×U) setup amortized |

The consumer never sees this — like a database query optimizer choosing between sequential scan and index scan.
