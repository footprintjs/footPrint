# Guides

Comprehensive guides for using FootPrint — the flowchart pattern for self-explainable backend code.

| Guide | What it covers |
|-------|---------------|
| **[Patterns](patterns.md)** | All 7 flowchart composition patterns — linear, parallel, conditional, multi-select, subflow, streaming, and loops — with diagrams |
| **[Scope](scope.md)** | Typed, raw, and Zod scope; pluggable recorders; PII redaction; scope protection; provider system |
| **[Execution Control](execution.md)** | `breakFn()`, cancellation via AbortSignal, timeout, fail-fast forks, loop control |
| **[Error Handling](error-handling.md)** | Commit-on-error, DebugRecorder, error narrative, post-mortem snapshots |
| **[Flow Recorders](flow-recorders.md)** | Pluggable observers for control flow narrative — 7 built-in loop strategies to control narrative size |
| **[Contracts](contracts.md)** | `defineContract()`, OpenAPI 3.1 generation, Zod vs JSON Schema |

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
  fields: { patient: ['ssn', 'dob'] },  // field-level within objects
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
