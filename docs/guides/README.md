# Guides

Comprehensive guides for using FootPrint — the flowchart pattern for self-explainable backend code.

**New here?** Read in this order: **[Patterns](patterns.md)** → **[Scope](scope.md)** → **[Flow Recorders](flow-recorders.md)**. The rest (Execution Control, Error Handling, Contracts, Performance) is reference to reach for when you need it.

### Vocabulary

footprint uses a few of its own terms — here's the standard concept behind each:

| footprint term | = the thing you already know |
|---|---|
| **scope** | the run's shared **state** (working memory), but every read/write is tracked |
| **narrative** | the execution **trace** as plain-English sentences (LLM-readable) |
| **recorder** | an **observer** called on each read, write, and decision |
| **subflow** | a nested flowchart composed like a **function** |
| **decider** / **selector** | a **router** (one branch) / **parallel fan-out** (many) |
| **commit log** | the ordered record of **what each step wrote** (powers time-travel) |
| **runtimeStageId** | a **step id** — the key that links trace events, commit-log entries, and tree nodes |

---

| Guide | What it covers |
|-------|---------------|
| **[Patterns](patterns.md)** | All 7 flowchart composition patterns — linear, parallel, conditional, multi-select, subflow, streaming, and loops — with diagrams |
| **[Scope](scope.md)** | Typed, raw, and Zod scope; pluggable recorders; PII redaction; scope protection; provider system |
| **[Execution Control](execution.md)** | `breakFn()`, cancellation via AbortSignal, timeout, fail-fast forks, loop control |
| **[Error Handling](error-handling.md)** | Commit-on-error, declarative per-stage retry, DebugRecorder, error narrative, post-mortem snapshots |
| **[Flow Recorders](flow-recorders.md)** | Pluggable observers for control flow narrative — 7 built-in loop strategies to control narrative size |
| **[Contracts](contracts.md)** | `.contract()`, OpenAPI 3.1 generation, Zod vs JSON Schema |
| **[API reference](https://footprintjs.github.io/footPrint/api/)** | Generated from the code, for all seven doors |
| **[Import map](https://footprintjs.github.io/footPrint/api/import-map/)** | Which door to import from, for each job |
| **[Performance](performance.md)** | Benchmarks — read/write throughput, pipeline latency, structuredClone costs |
| **[Execution Model](execution-model.md)** | The operating envelope: what one executor is for, the depth budget, what each read/write costs, what a pause checkpoint captures |
| **[Deferred Observers](observers-deferred.md)** | The deferred tier: recorders that run one beat behind instead of inline |
| **[Attempt Metrics](attempt-metrics.md)** | `attempts()`, an opt-in recorder of attempt rows, collected during traversal |
| **[Stage Attention](attention.md)** | `StageSnapshot.attention`: bounded marks the engine collects while it retains errors, attempts and summaries |
| **[Terminal Failure Context](terminal-failure-context.md)** | `executor.getFailureContext()` after a rejected `run()` or `resume()` |
| **[Record Contract](record-contract.md)** | How FootPrint writes its record through `foottrace/write`; the contract itself lives in `foottrace` |
| **[Capture Coverage](capture-coverage.md)** | What the engine captured: an opt-in engine observation, not proof that an operation succeeded |
| **[Closed Native Capture](closed-native-capture.md)** | `captureClosure: true`: a separate, bounded copy of a supported native root prefix |
| **[Saved Capture History](saved-capture-history.md)** | Saving the capture observation with its evidence through a capture-capable sink |
| **[Exact Read Sources](exact-read-sources.md)** | `readSources: true`: where each read value came from |
| **[External Evidence](external-evidence.md)** | Saved external-call evidence: one attempt, separate observations |
| **[Indexed Scope Loading](indexed-scope-loading.md)** | `openIndexedRecordFile`: a Node-only reader that loads one authorized saved scope by byte range |
| **[Performance Patterns](performance-patterns.md)** | Each speed-up as a named pattern, with a measurement before and after and a test that pins the answer |
| **[The Fold](the-fold-and-how-it-got-fast.md)** | The replay algorithm and each optimisation, in order, with what it traded and measured |
| **[Consumer Audit](consumer-audit.md)** | No release tags until every family consumer passes its own checks against the release candidate |

---

## Highlights

### PII Redaction — [scope.md#redaction](scope.md#redaction-pii-protection)

Protect sensitive data in all recorder output — per-key flag or declarative policy:

```typescript
// Per-key
scope.setValue('creditCard', '4111-1111-1111-1111', true);

// Declarative policy — define once, applied everywhere
executor.setRedactionPolicy({
  keys: ['ssn', 'creditCard'],           // exact key matches
  patterns: [/password|secret|token/i],  // regex auto-redact
  fields: { patient: ['ssn', 'dob', 'address.zip'] }, // dot-notation for nested paths
});

// Audit trail (after run)
executor.getRedactionReport(); // { redactedKeys, fieldRedactions, patterns }
```

Cross-stage persistence is automatic. Runtime always gets real values — only recorders see `[REDACTED]`.

### Loop Narrative Strategies — [flow-recorders.md#strategies](flow-recorders.md#built-in-loop-strategies)

Loops can generate hundreds of narrative sentences. Choose a compression strategy:

| Strategy | Output for 50 iterations |
|----------|-------------------------|
| **Default** | All 50 sentences |
| **Windowed** | First 3, "...(45 omitted)", last 2 |
| **Silent** | "Looped 50 times through Retry." |
| **Adaptive** | First 5 full, then every 10th |
| **Progressive** | 1, 2, 4, 8, 16, 32 (exponential) |
| **Milestone** | 1, 10, 20, 30, 40, 50 (every Nth) |
| **RLE** | "Looped through Retry 50 times (passes 1–50)." |
| **Separate** | Clean main narrative + full detail in side channel |

Or build your own by extending `NarrativeFlowRecorder`.

---

For architecture deep-dives, see [docs/internals/](../internals/).
