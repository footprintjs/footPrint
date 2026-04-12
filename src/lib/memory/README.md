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

---

### 2. TransactionBuffer — "The Database Transaction"

Stages write here instead of directly to SharedMemory. All writes are staged, then committed atomically.

**Why it connects to the main goal:** Every write is recorded in a chronological operation trace — which path was written, whether it was a `set` (overwrite) or `merge` (deep union). This trace *is* the causal record. Without it, you know the final state but not *how* you got there. The trace is what makes time-travel and deterministic replay possible — you can reconstruct the exact state at any point by replaying traces in order.

**Why not write directly to SharedMemory?** Three reasons:

1. **Atomicity** — If a stage sets 5 values and crashes on the 4th, you don't want the first 3 to be visible. All-or-nothing commits.
2. **Read-after-write consistency** — Within a stage, you see your own uncommitted writes immediately. Set `name = 'Alice'`, read `name`, get `'Alice'` — even before commit.
3. **Deterministic replay** — The operation trace enables exact state reconstruction at any commit point.

```typescript
const buffer = new TransactionBuffer(currentState);
buffer.set(['user', 'name'], 'Alice');     // staged, not applied
buffer.merge(['user', 'tags'], ['admin']); // staged
buffer.get(['user', 'name']);              // 'Alice' (read-after-write)

const { overwrite, updates, trace } = buffer.commit(); // atomic flush
// trace = [{ path: 'user.name', verb: 'set' }, { path: 'user.tags', verb: 'merge' }]
```

**Key design decision:** After commit, the working copy resets to `{}` (empty), not back to the base snapshot. This prevents a stale-read bug where the buffer would return old values instead of falling through to SharedMemory for the current committed state.

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

**Key design decision:** Replay is O(n) from the beginning every time. Simple, correct, tiny memory footprint. For < 200 stages this is fast enough. Checkpoint caching can be added later without changing the API.

---

### 4. StageContext — "The Stack Frame"

Per-stage execution context. Wraps SharedMemory with a TransactionBuffer and provides tree navigation.

**Why it connects to the main goal:** The stage context is where *execution* meets *recording*. When a stage calls `commit()`, three things happen atomically: (1) patches are applied to SharedMemory, (2) the commit is recorded to EventLog, and (3) the write trace is logged to diagnostics. This triple-write is what makes traces connected — the execution, the history, and the diagnostics all stay in sync without the stage author thinking about it.

**Why does this exist? Why not hand stages a TransactionBuffer directly?** Because a stage needs more than read/write:

- **Namespace scoping** — Stage writes `result`, it lands at `runs/{id}/result`. The stage doesn't know about namespacing.
- **Tree structure** — Stages form a tree (next, children, parent). The engine traverses this tree for execution. Snapshots capture the full shape.
- **Commit orchestration** — The triple-write (SharedMemory + EventLog + DiagnosticCollector) happens inside `commit()`. If stages managed this themselves, someone would forget to record history and the trace would have a gap.

```typescript
const ctx = new StageContext('run-1', 'validate', sharedMemory, '', eventLog);
ctx.setObject([], 'userName', 'Alice');   // staged
ctx.getValue([], 'userName');             // 'Alice' (read-after-write)
ctx.commit();                             // atomic: applies + records + logs

const next = ctx.createNext('run-1', 'process');
const child = ctx.createChild('run-1', 'branch-1', 'parallelTask');
```

**Key design decision:** TransactionBuffer is lazily created — you only pay the `structuredClone` cost if the stage actually writes. Many stages are read-only; lazy instantiation saves real time.

---

### 5. DiagnosticCollector — "The Flight Recorder"

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
   (staged in buffer, not applied to shared memory yet)
   (every write recorded in operation trace)

4. Stage reads → StageContext → TransactionBuffer (if buffered) → SharedMemory (fallback)
   (read-after-write: sees own uncommitted writes)

5. Stage finishes → engine calls ctx.commit():
   a. TransactionBuffer.commit()  → returns { overwrite, updates, trace }
   b. SharedMemory.applyPatch()   → state updated (visible to next stage)
   c. EventLog.record()           → history recorded (replayable)
   d. DiagnosticCollector.addLog() → trace logged (debuggable)

6. Next stage gets a fresh StageContext → same SharedMemory, fresh buffer
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
| Atomic commit (all-or-nothing) | Prevents partial state on failure | Every commit in the history is a complete, consistent snapshot |
| Diff-based EventLog (not full snapshots) | O(1) storage per commit | Can store complete history without blowing up memory |
| Replay-based materialise | Reconstructs state at any point | Time-travel debugging: "what did the decider see at step 47?" |
| DiagnosticCollector separate from state | Observational data can't corrupt execution | Stage narratives are always safe to capture — no side effects |
| Lazy TransactionBuffer creation | Only clone state if stage actually writes | Performance: read-only stages are free |
| `structuredClone` for isolation | Prevents external mutation of internal state | History is immutable — replaying always gives the same result |

---

## Dependency Graph

```
This library has ZERO dependencies on other footprint libraries.

  StageContext
  /     |     \
SharedMemory  TransactionBuffer  DiagnosticCollector
  \     |
  EventLog
    |
  utils (deepSmartMerge, applySmartMerge, path helpers)
    |
  types (MemoryPatch, CommitBundle, TraceEntry, FlowMessage, etc.)
```

External dependencies: `lodash.get`, `lodash.set`, `lodash.has`, `lodash.mergewith` (path traversal only).

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
