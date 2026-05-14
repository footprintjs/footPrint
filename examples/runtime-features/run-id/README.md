---
name: runId — Per-Run Identifier
group: Runtime Features
---

# `runId` — per-run scoping primitive

Every event the engine fires carries a `runId` in its `traversalContext`. The `runId` is generated fresh per `executor.run()` (and per `executor.resume()`), shared by every event of that run, and unique across consecutive runs of the same executor instance.

```
const recorder: FlowRecorder = {
  id: 'my-recorder',
  onSubflowEntry: (e) => {
    const runId = e.traversalContext?.runId;
    if (runId !== this.lastRunId) {
      this.resetTransientState();
      this.lastRunId = runId;
    }
    // ...accumulate per-run state
  },
};
```

## When you need it

| Scenario | Why runId matters |
|---|---|
| Multi-run scripts (one executor, many runs) | Without runId, recorder state from run #1 aliases into run #2. Bugs are silent. |
| Per-run rollups (tokens / latency / events) | Bucket events into `Map<runId, Rollup>` for clean per-run queries. |
| Pause/resume audit trails | Resume gets a new runId — distinguishes "first attempt" from "resume" in audit. |
| Long-lived agent services | Shared executor across many requests requires per-run state isolation. |

## Format

`${timestamp}-${counter.padStart(10, '0')}` — e.g., `1778427200914-0000000001`.

- **Timestamp** — `Date.now()` clamped to a monotonic-clock guard (never decreases under NTP drift).
- **Counter** — process-local, zero-padded so lexicographic sort matches generation order.

Sortable: `["...001", "...002", "...010"].sort()` returns the same order.

## What runId is NOT

- **Not cross-process.** Counter is process-local. For distributed correlation, use `getEnv().traceId` (consumer-supplied).
- **Not crypto-random.** Predictable counter suffix. If you need an unguessable identifier, generate your own UUID and pass via env.
- **Not preserved across resume.** Resume gets a new `runId`. If you need to correlate, store the original in your checkpoint payload at pause time.

## Examples

| File | What it shows |
|---|---|
| [01-detect-new-run.ts](./01-detect-new-run.ts) | Recorder logs each new runId. Two consecutive `run()` calls produce different ids. |
| [02-multi-run-scoping.ts](./02-multi-run-scoping.ts) | Per-run rollup: count stages per run by detecting runId change. |
| [03-nested-runs.ts](./03-nested-runs.ts) | Subflows mounted via `addSubFlowChart` inherit the parent's runId — one run, one runId. |
| [04-resume.ts](./04-resume.ts) | `resume()` fires `onResume` and a fresh `onRunStart` — both share a NEW runId distinct from the original run. |

Run any example with `npx tsx examples/runtime-features/run-id/<file>.ts`.
