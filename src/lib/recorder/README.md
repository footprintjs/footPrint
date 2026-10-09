<p align="center">
  <strong>The Recorder Architecture</strong><br/>
  <em>How footprintjs turns execution into a causal trace — without any instrumentation.</em>
</p>

<p align="center">
  <strong>4 channels · 1 universal key · 2 consumption modes</strong>
</p>

---

## 1. The shape

footprintjs observes execution along **4 orthogonal channels**. Each has one purpose. Together they reconstruct the full causal trace of a run.

```
┌──────────────────────────────────────────────────────────────────────┐
│                          FlowChartExecutor                           │
│                                                                      │
│   traversal proceeds → fires events on 4 channels →                  │
│                                                                      │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│   │  Structure  │  │    Scope    │  │    Flow     │  │    Emit     │ │
│   │ (build-time)│  │ (data ops)  │  │(control flow)│  │(custom evts)│ │
│   └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘ │
│          │                │                │                │        │
│          └────────────────┴────────────────┴────────────────┘        │
│                          dispatchers fan out                         │
│                                  │                                   │
└──────────────────────────────────┼───────────────────────────────────┘
                                   ▼
                ┌──────────────────────────────────┐
                │     consumer recorders           │
                │  (sync handlers, error-isolated) │
                └──────────────────────────────────┘
```

Every event carries the same correlation key — `runtimeStageId` in format `[subflowPath/]stageId#executionIndex`. One key ties everything together.

---

## 2. The four channels

### Structure — build-time chart shape

> Fires synchronously during `flowChart(...)`  →  `.addFunction(...)`  →  `.build()`. **Not at runtime.**

```
StructureRecorder
├── onStageAdded           — every spec node added
├── onEdgeAdded            — every outgoing edge wired
├── onLoopEdgeAdded        — every loopTo() back-edge
├── onDeciderComplete      — every decider/selector .end()
└── onSubflowMounted       — every subflow mount (with subflowSpec)
```

By the time `.build()` returns, the structure is fully observed.

**Why this channel exists**: chart shape is *reference data*. UIs render it. Audit systems hash it. Static analysis tools verify it. None of this needs to wait for execution.

### Scope — data ops

> Fires DURING stage execution. Buffered per-stage; flushed at commit.

```
ScopeRecorder
├── onStageStart           — stage begins
├── onRead                 — every shared-state read
├── onWrite                — every shared-state write
├── onCommit               — transaction flush
├── onStageEnd             — stage completes
└── onError                — a recorder threw in one of the hooks above
                             (event.error: StructuredErrorInfo — message, name?, raw)
```

**Why this channel exists**: gives you the **data-level "stack trace"**. When the rejection decision says `'high-risk'`, you want to know: which key was read, what value did it have, what threshold was checked, did it match. Logs answer "this happened." Scope events answer "*because* X was Y."

### Flow — control flow

> Fires AFTER stage execution (or after the control-flow decision for forks/deciders).

```
FlowRecorder
├── onStageExecuted        — UNIFORM for every stage kind (v6+)
│                            event.stageType discriminates:
│                              'linear' | 'decider' | 'fork' | 'selector' | 'subflow-mount'
├── onNext                 — linear continuation
├── onDecision             — decider chose a branch
├── onFork                 — fork spawned children
├── onSelected             — selector picked a subset
├── onSubflowEntry/Exit    — subflow boundary
├── onLoop                 — loop iteration
├── onBreak                — $break() called
├── onError                — stage threw
├── onStageRetry           — an attempt failed and is being retried (declared `retry` policy)
├── onThrottled            — a fork child's error was classified as throttling (`throttlingErrorChecker`, 9.39.0)
├── onPause/onResume       — pause/resume signal
└── onRunStart/onRunEnd    — top-level run boundary
```

**Why this channel exists**: data alone doesn't tell you the path. You need to know *which* branch the engine took, *which* child it forked, *how many* loop iterations ran. The shape of the path **is** part of the answer.

### Emit — consumer-defined events

> Fires synchronously when consumer code calls `scope.$emit(name, payload)`.

```
EmitRecorder
└── onEmit                 — pass-through with auto-enriched context
```

```ts
scope.$emit('myapp.llm.tokens', { input: 100, output: 50 });
// → fires onEmit({
//     name: 'myapp.llm.tokens',
//     payload: { input: 100, output: 50 },
//     stageName, runtimeStageId, subflowPath, timestamp,
//   })
```

**Why this channel exists**: lets consumers send domain-specific events (token counts, retry attempts, custom metrics) that flow through the same fan-out as built-in events — but with a hierarchical name (`myapp.billing.spend`) so downstream tools can route by namespace.

---

## 3. The traversal animation

How the channels fire as a stage runs:

```
                    ┌─────────────────────────────────┐
   t = 0  ●────────►│ FlowRecorder.onRunStart         │
                    └─────────────────────────────────┘
                                  │
                                  ▼
                    ┌─────────────────────────────────┐
   t = 1  ●────────►│ Recorder.onStageStart('seed')   │  ─┐
                    └─────────────────────────────────┘   │
                                  │                       │
                    ┌─────────────────────────────────┐   │
   t = 2  ●────────►│ Recorder.onRead('input')        │   │  buffered
                    └─────────────────────────────────┘   │  scope ops
                                  │                       │  for 'seed'
                    ┌─────────────────────────────────┐   │
   t = 3  ●────────►│ Recorder.onWrite('result', x)   │   │
                    └─────────────────────────────────┘  ─┘
                                  │
                    ┌─────────────────────────────────┐
   t = 4  ●────────►│ Recorder.onCommit               │  flush buffered
                    └─────────────────────────────────┘  scope ops
                                  │
                    ┌─────────────────────────────────┐
   t = 5  ●────────►│ Recorder.onStageEnd('seed')     │
                    └─────────────────────────────────┘
                                  │
                    ┌─────────────────────────────────┐
   t = 6  ●────────►│ FlowRecorder.onStageExecuted    │  stageType: 'linear'
                    │   ('seed', stageType: 'linear') │
                    └─────────────────────────────────┘
                                  │
                    ┌─────────────────────────────────┐
   t = 7  ●────────►│ FlowRecorder.onNext             │
                    │   ('seed' → 'classify')         │
                    └─────────────────────────────────┘
                                  │
                              .  .  .

                              traversal continues with the next stage,
                              same pattern repeats. Loops, forks, decisions,
                              subflow mounts all fire their specialized
                              Flow events FOLLOWED BY onStageExecuted
                              with the appropriate stageType.

                                  │
                                  ▼
                    ┌─────────────────────────────────┐
                    │ FlowRecorder.onRunEnd           │
                    └─────────────────────────────────┘
```

Every event flows through its dispatcher to every attached recorder. Errors thrown by a recorder are caught and isolated — one misbehaving consumer can't bring down the engine or block the next event.

---

## 4. The universal correlation key

```
                          runtimeStageId
            ┌───────────────────────────────────────────────┐
            │                                               │
            │   [subflowPath/]stageId#executionIndex        │
            │                                               │
            │   examples:                                   │
            │     seed#0                                    │
            │     call-llm#5                                │
            │     sf-tools/execute-tool-calls#8             │
            │     sf-outer/sf-inner/validate#3              │
            │                                               │
            └─────────────────────┬─────────────────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
              ▼                   ▼                   ▼
       scope events        flow events       commit log entries
       (all 4 stages)      (all 4 stages)    (write history)
              │                   │                   │
              └─────────── same key ──────────────────┘

      → no correlation IDs to weave by hand
      → no timestamps to align across services
      → engine assigns it once, threads it through every event
```

```ts
import { parseRuntimeStageId, splitStageId } from 'foottrace';

parseRuntimeStageId('sf-tools/call-llm#5');
// → { stageId: 'call-llm', executionIndex: 5, subflowPath: 'sf-tools' }

splitStageId('sf-tools/call-llm');     // bare prefixed id (no #N)
// → { localStageId: 'call-llm', subflowPath: 'sf-tools' }
```

> [!NOTE]
> Loops re-execute the same `stageId` with bumping `executionIndex` — `call-llm#5` and `call-llm#9` are the same stage, two iterations apart. The execution-index ordering is your time axis for time-travel scrubbing.

### Source positions in emitted events

`EmitEvent.sourcePosition` identifies the committed log prefix at the moment
`scope.$emit()` runs. The engine captures it before recorder dispatch, so a
deferred observer does not need to guess the position from its delivery time.
`EmitSourcePosition` and `LogAddress` are exported from `footprintjs/recorders`.

| Source position field | Meaning |
|---|---|
| `runId` | The execution leg bound to the emitting frame. A resume starts a new leg. |
| `logRunId` | The first execution leg that owned this log. Same-executor resume preserves the reused root log's identity; fresh-executor resume owns a new log. |
| `drillPath` | The actual runtime mount-ID chain identifying the nested log, or `[]` for the root log. Unlike static `subflowPath`, this distinguishes repeated mounts. |
| `committedThroughIdx` | The inclusive last committed index in that log at emission: `EventLog.length - 1`, or `-1` before any commit. |

The root snapshot and each nested `treeContext` snapshot expose the matching
optional `logAddress: { logRunId, drillPath }`. Before folding a position with
`stateAt`, match both address fields against the chosen log and verify that
`committedThroughIdx` is an integer from `-1` through `log.length - 1`. Use that
log's initial state; do not silently clamp an unavailable index or substitute a
different log. A paused subflow's log may not be present in the stored snapshot,
even when its emitted event has a source position.
Lean checkpoints can retain a nested `logAddress` while omitting its history;
the address alone is never proof that the log is available.
The run identifiers follow the engine's existing process-local identity rule;
retain recording/session context when comparing records from different processes.

This position is **not** the emitting stage's own commit index, its working/read
view, or an event-order counter. It excludes staged writes, and a sibling can
commit between two emits from the same stage. Several events can share one
position. Selecting the stage's eventual completed stop would show later state,
not the captured prefix. This metadata does not add Lens navigation support.

Bare or otherwise unaddressable emitters omit `sourcePosition`; snapshots without
an addressed log omit `logAddress`. Treat missing metadata as unknown, including
older recordings. Source metadata is copied and frozen for inline delivery.
Successful deferred `clone` capture preserves its values, not its frozen status;
`ref` retains the original metadata, while `summary` capture can lose these
fields. See [deferred observers](../../../docs/guides/observers-deferred.md#source-time-positions)
for the delivery boundary.

---

## 5. Live vs Offline — the consumer's choice

The same recorder API works in two consumption modes. You pick based on what you're trying to do.

### LIVE — real-time BE → FE

```
┌──────────────────────┐                  ┌──────────────────────┐
│  Backend executor    │ ──► WebSocket ──►│  Frontend dashboard  │
│  (running pipeline)  │      events       │  (lights up live)    │
└──────────────────────┘                  └──────────────────────┘
   • Slow handler blocks engine — handlers MUST be sync and fast
   • Events fire in execution order
   • Real-time dashboards, interactive debugging, live support tools
```

```ts
const liveRec: FlowRecorder = {
  id: 'live-stream',
  onStageExecuted(e) { ws.send({ kind: 'stage', data: e }); },
  onDecision(e)      { ws.send({ kind: 'decision', data: e }); },
  onError(e)         { ws.send({ kind: 'error', data: e }); },
};
executor.attachFlowRecorder(liveRec);
await executor.run({ input });
```

### OFFLINE — capture, ship, replay

```
┌──────────────────────┐                  ┌──────────────────────┐
│  Process A (capture) │ ── JSON ────────►│  Process B (replay)  │
│  ─────────           │   trace.json     │  ─────────           │
│  await run()         │ ──────────────►  │  load trace          │
│  snapshot = ...      │   S3 / SQS /     │  render in UI        │
│  narrative = ...     │   data warehouse │  run analytics       │
│  spec = chart.buildT │                  │  generate audit      │
└──────────────────────┘                  └──────────────────────┘
   • Returns fast — request handler unblocked
   • Loses reference equality (deep copies via JSON)
   • Long-term storage, post-mortem debugging, Lambda → Lambda
```

```ts
// Process A — capture
const executor = new FlowChartExecutor(chart);
executor.enableNarrative();
await executor.run({ input });

const wire = JSON.stringify({
  spec:      chart.buildTimeStructure,
  snapshot:  executor.getSnapshot(),
  narrative: executor.getNarrativeEntries(),
});
await s3.putObject({ Bucket: 'traces', Key: `${runId}.json`, Body: wire });
return response;  // user gets a fast response

// Process B — replay (different process, machine, or time)
const trace = JSON.parse(await fs.readFile('trace.json'));
// → render in <TracedFlow>, feed to analytics, anomaly detection, …
```

> [!IMPORTANT]
> **Same recorder API for both modes.** A `FlowRecorder` written for live monitoring works on a replayed trace without modification. The contract is the same data shape, fired in the same order. The only difference is *when* events are dispatched.

---

## 6. ID contract

> [!NOTE]
> `attachRecorder` is **idempotent by ID**: same ID replaces, different IDs coexist. Prevents accidental double-counting; multiple instances with different configs can coexist naturally.

```
ScopeRecorder /  FlowRecorder /  StructureRecorder /  EmitRecorder
              ↓               ↓                   ↓               ↓
         attach by         attach by          attach by      attach by
         executor.         executor.          flowChart()    executor.
         attachScope-      attachFlow-        options bag    attachEmit-
         Recorder(r)       Recorder(r)        OR fluent      Recorder(r)
                                              .attachStruct-
                                              ureRecorder(r)
```

`CombinedRecorder` is a union shape — implement methods from any subset of channels in one object. The runtime detects which methods exist (own properties only, prototype methods ignored for security) and routes events accordingly. One `attachCombinedRecorder(r)` call.

---

## 7. Composition primitives

| Class | Use when |
|---|---|
| `KeyedStore<T>` | Each step produces ONE record. Translate by `runtimeStageId`. |
| `SequenceStore<T>` | Each step produces N records, ordering matters. Aggregate, accumulate, range-query. |
| `BoundaryStateStore<T>` | Live state DURING a matched `[start, stop]` interval; clears on stop. |
| `CommitRangeIndex<T>` (from `foottrace`) | Interval index over commit log positions. Generic label `T`; owned by the record package, not a FootPrint export. |
| `CombinedRecorder` | Implement multi-channel observation in one object. |
| `CompositeRecorder` | Bundle multiple recorders behind one ID. Its fan-out is generated from the hook registry, so every child sees every hook on every channel (26/26); a child that throws never costs a sibling the event. |

**Convention**: one purpose per recorder. A recorder owns exactly ONE concern (storage OR event ingestion OR state machine OR projection). Multi-concern recorders MUST be decomposed and composed via a thin facade. See `examples/recorders/` for canonical patterns.

---

## 7b. The hook registry and the one dispatcher (`hooks.ts`, `snapshot.ts`)

**Why.** Hook names used to be kept in about ten hand lists (three routing lists, two deferred taps, the composite's methods, the snapshot copier's fields…). A list that missed a hook failed silently: the composite never forwarded `onRunStart`, and a deferred recorder never sees an event its tap list forgot. Now each hook is declared ONCE and every broadcaster derives from the declaration.

- `HOOKS` — one entry per hook: the channel(s) that declare it (each with its payload type's name) and whether the executor makes it (`onResume`). It `satisfies` a type built from `ScopeRecorder` / `FlowRecorder` / `EmitRecorder`, so **a hook added to an interface and not to `HOOKS` does not compile** (pinned by `test/architecture/hook-registry-compile.test.ts`).
- `hooksOn(channel)` — the channel's hooks in registry order. Channel routing (`has*RecorderMethods`), and the deferred tier's taps read it; `CompositeRecorder`'s generated fan-out reads `HOOK_NAMES`.
- `fire(recorders, hook, event, onFailure)` — the one per-recorder loop. A throw goes to the channel's policy (scope: `onError` on the recorders; flow: a dev-mode warning) and the loop goes on; nothing a recorder throws — not even a null-prototype object — reaches the run. Executor-made events (`resume`'s `onResume`) go through it too.
- `recorderFailureEvent(site, thrown, hook)` — THE scope `onError` event for a recorder that threw (9.39.0). Every path that reports one builds it here: the inline facade, the executor's `onResume`, and deferred delivery. `error` is the structured form (`extractErrorInfo`: `message`, `name?`, `code?`, `raw` = exactly what was thrown), so a string thrown inline and the same string thrown by a deferred recorder arrive as the same event. Deferred delivery hands it to every scope observer — the failing one included, as the inline tier does — so a `CompositeRecorder`'s other children hear a sibling's throw; a throw from `onError` is not routed again. Pinned by `test/lib/recorder/error-event-shape.test.ts`.

  ```ts
  executor.attachScopeRecorder({ id: 'alerts', onError: (e) => alert(e.error.message, e.error.raw) });
  ```
- `copyBundle(id, bundle)` (`snapshot.ts`) — the one copier from `toSnapshot()` to a snapshot row; the executor and the composite both call it, so a child row keeps `description` / `preferredOperation` / `meta`.

```text
hooksOn('flow')   → ['onStageExecuted', 'onNext', …, 'onRunFailed']   (18, registry order)
fire(recorders, 'onLoop', event, policy)   → a throwing recorder is handed to `policy`, the rest still run
```

Adding a hook: declare it on the interface, let the compiler point at `HOOKS`, add the entry — routing, taps and the composite follow. Fire it with `fire` at its dispatch site.

---

## 8. Built-in recorders

| Recorder | Purpose |
|---|---|
| `MetricRecorder` | Aggregates `scope.$metric()` calls; queryable as a map |
| `DebugRecorder` | Captures `scope.$debug()` calls for diagnostic context |
| `NarrativeFlowRecorder` | Plain-English flow narrative (one sentence per event) |
| `CombinedNarrativeRecorder` | Combined data + flow narrative; flat ordered entries |
| `TopologyRecorder` | Live composition graph for streaming consumers |
| `InOutRecorder` | Chart in/out stream — entry/exit pairs at every boundary |
| `QualityRecorder` | Per-step quality scoring with backtracking |

---

## 9. What this means for your day-to-day

If you're an ops engineer at 2 AM debugging a rejected loan:

```ts
// You don't grep logs. You load the trace.
const trace = JSON.parse(await s3.getObject({ Bucket: 'traces', Key: 'req_abc.json' }).Body);

// You see the whole causal chain:
trace.narrative
//   → [stage] Stage 1: load — input received
//   → [stage] Stage 2: assess-risk
//   → [step]  read creditScore = 620
//   → [step]  read dti = 0.47
//   → [stage] Stage 3: classify
//   → [condition] Rule "high-DTI": dti 0.47 gt 0.43 ✓, chose review path
//   → [stage] Stage 4: manual-review
//   → [step]  read pendingFlags = ['address-mismatch']
//   → [stage] Stage 5: reject
//   → [step]  write decision = "Rejected: identity verification incomplete"

// Exactly which rule fired, with what values, why.
// Debug time: 30 seconds. Vs 20 minutes hand-reconstructing from logs.
```

If you're writing a custom observer:

```ts
const myRecorder: FlowRecorder = {
  id: 'my-thing',
  onStageExecuted(e) {
    if (e.stageType !== 'linear') return;        // skip control-flow stages
    metrics.timing('stage.duration', e.duration, { stage: e.stageName });
  },
};
executor.attachFlowRecorder(myRecorder);
```

You write the observer once. It works on live execution. It works on replayed traces. It works in dev, in prod, in CI tests. The framework guarantees the event contract; you handle the destination.

> [!TIP]
> See `examples/build-time-features/structure-recorder/` for end-to-end usage of the build-time channel, and `examples/runtime-features/snapshot-replay/` for the capture-and-replay pattern.
