# Flow Recorders

Pluggable observers for control flow events. Observe decisions, loops, forks, subflows, and errors — without modifying execution.

---

## Why Flow Recorders?

FootPrint captures two kinds of trace:

```
Scope Recorders (data layer)   → "wrote riskScore = 0.87"
Flow Recorders (engine layer)  → "chose Reject because riskScore > 0.5"
```

Scope Recorders observe data operations. Flow Recorders observe control flow decisions. Together they tell the complete story of *what happened and why*.

The FlowRecorder system mirrors the scope-level Recorder pattern:
- Same shape: `id` + optional hooks
- Same dispatch: fan-out to N observers
- Same safety: errors swallowed, never break execution
- Same lifecycle: attach/detach by ID

---

## Quick Start

### Default Narrative

```typescript
import { FlowChartExecutor } from 'footprintjs';

const executor = new FlowChartExecutor(chart);
executor.enableNarrative(); // auto-attaches the CombinedNarrativeRecorder
await executor.run();

// getNarrativeEntries() is the single public narrative API — structured
// entries with { type, text, depth }. Map to text for a flat string[].
console.log(executor.getNarrativeEntries().map((e) => e.text));
// ["The process began with Validate.", "A decision was made...", ...]
```

### Custom Observer

```typescript
import { FlowChartExecutor, type FlowRecorder } from 'footprintjs';

const metrics: FlowRecorder = {
  id: 'metrics',
  onLoop: (event) => {
    console.log(`Loop ${event.iteration} → ${event.target}`);
  },
  onDecision: (event) => {
    console.log(`Decision: ${event.decider} → ${event.chosen}`);
  },
};

const executor = new FlowChartExecutor(chart);
executor.attachFlowRecorder(metrics);
await executor.run();
```

### Loop Compression Strategy

```typescript
import {
  FlowChartExecutor,
  WindowedNarrativeFlowRecorder,
} from 'footprintjs';

const executor = new FlowChartExecutor(chart);
executor.attachFlowRecorder(new WindowedNarrativeFlowRecorder(3, 2));
await executor.run();

// Output: first 3 iterations, "... (45 iterations omitted)", last 2
```

---

## The FlowRecorder Interface

```typescript
interface FlowRecorder {
  readonly id: string;
  onStageExecuted?(event: FlowStageEvent): void;   // every stage kind (carries stageType)
  onNext?(event: FlowNextEvent): void;
  onDecision?(event: FlowDecisionEvent): void;
  onFork?(event: FlowForkEvent): void;
  onSelected?(event: FlowSelectedEvent): void;
  onSubflowEntry?(event: FlowSubflowEvent): void;
  onSubflowExit?(event: FlowSubflowEvent): void;
  onSubflowRegistered?(event: FlowSubflowRegisteredEvent): void;
  onLoop?(event: FlowLoopEvent): void;
  onBreak?(event: FlowBreakEvent): void;
  onError?(event: FlowErrorEvent): void;
  onPause?(event: FlowPauseEvent): void;
  onResume?(event: FlowResumeEvent): void;
  onRunStart?(event: FlowRunEvent): void;          // once per executor.run(), before traversal
  onRunEnd?(event: FlowRunEvent): void;            // once per run, after clean completion
  onRunFailed?(event: FlowRunFailedEvent): void;   // once per run on a non-pause error (terminal)
  clear?(): void;                                  // reset per-run state (stateful recorders)
  toSnapshot?(): { name: string; data: unknown };  // expose data for getSnapshot()
}
```

All hooks are **optional**. Implement only the events you care about. The `id` field is used for `detachFlowRecorder(id)`.

### Event Types

| Event | When it fires | Key fields |
|---|---|---|
| `FlowStageEvent` | A stage executed (any kind) | `stageName`, `description?`, `stageType` |
| `FlowNextEvent` | Linear next transition | `from`, `to`, `description?` |
| `FlowDecisionEvent` | Decider picks a branch | `decider`, `chosen`, `rationale?`, `description?`, `evidence?` |
| `FlowForkEvent` | Children dispatched in parallel | `parent`, `children[]` |
| `FlowSelectedEvent` | Selector filters children | `parent`, `selected[]`, `total`, `evidence?` |
| `FlowSubflowEvent` | Entering/exiting a subflow | `name`, `subflowId?`, `description?`, `mappedInput?`, `outputState?` |
| `FlowSubflowRegisteredEvent` | Dynamic subflow registered | `subflowId`, `name`, `description?`, `specStructure?` |
| `FlowLoopEvent` | Back-edge loop iteration | `target`, `iteration`, `description?` |
| `FlowBreakEvent` | Break function called | `stageName`, `reason?`, `propagatedFromSubflow?` |
| `FlowErrorEvent` | Stage threw an error | `stageName`, `message`, `structuredError` |
| `FlowPauseEvent` / `FlowResumeEvent` | Pausable stage paused / resumed | `stageName`, `stageId`, `pauseData?` / `hasInput` |
| `FlowRunEvent` | `executor.run()` started / ended cleanly | `payload?` (input on start, return value on end) |
| `FlowRunFailedEvent` | `executor.run()` terminated on a non-pause error | `structuredError` |

Every event also carries a read-only `traversalContext` (runId, stageId,
runtimeStageId, subflowPath, depth, …). `onStageExecuted` fires uniformly for
**every** stage kind — switch on `event.stageType`
(`'linear' | 'decider' | 'fork' | 'selector' | 'subflow-mount'`) for kind-specific
handling, and return early on non-`'linear'` types if you only want plain stages.

### Structured Errors in FlowErrorEvent

`FlowErrorEvent` carries an optional `structuredError` field that preserves the full error structure. For `InputValidationError`, this includes field-level `.issues`:

```typescript
const errorRecorder: FlowRecorder = {
  id: 'error-handler',
  onError(event: FlowErrorEvent) {
    // event.message — always a string (backward-compatible)
    // event.structuredError — StructuredErrorInfo with full details

    if (event.structuredError?.issues) {
      // InputValidationError: access field-level issues
      for (const issue of event.structuredError.issues) {
        console.log(`${issue.path.join('.')}: ${issue.message}`);
      }
    }

    // event.structuredError.code — 'INPUT_VALIDATION_ERROR', 'ENOENT', etc.
    // event.structuredError.raw  — original error object
  },
};
```

See [Error Handling — Structured Error Preservation](./error-handling.md#structured-error-preservation) for full details.

---

## Built-in Loop Strategies

Loops can generate hundreds of narrative sentences. These strategies compress loop output while preserving the important information.

### NarrativeFlowRecorder (default)

Full detail — every event generates a sentence. Best for short loops or debugging.

```typescript
import { NarrativeFlowRecorder } from 'footprintjs';
executor.attachFlowRecorder(new NarrativeFlowRecorder());
// "On pass 1 through Retry."
// "On pass 2 through Retry."
// ... every iteration
```

### WindowedNarrativeFlowRecorder

Shows first N and last M iterations, skips the middle. Best for moderate loops (10–200) where you want to see start and end.

```typescript
import { WindowedNarrativeFlowRecorder } from 'footprintjs';
executor.attachFlowRecorder(new WindowedNarrativeFlowRecorder(3, 2));
// "On pass 1 through Retry."
// "On pass 2 through Retry."
// "On pass 3 through Retry."
// "... (45 iterations omitted)"
// "On pass 49 through Retry."
// "On pass 50 through Retry."
```

**Parameters:** `new WindowedNarrativeFlowRecorder(head = 3, tail = 2, id?)`

### SilentNarrativeFlowRecorder

Suppresses all per-iteration sentences, emits a single summary. Best when iteration details are irrelevant.

```typescript
import { SilentNarrativeFlowRecorder } from 'footprintjs';
executor.attachFlowRecorder(new SilentNarrativeFlowRecorder());
// "Looped 50 times through Retry."
```

Access counts programmatically: `recorder.getLoopCounts()` → `Map<target, count>`.

### AdaptiveNarrativeFlowRecorder

Full detail until a threshold, then samples every Nth iteration. Best for unknown loop counts where short loops should be fully detailed.

```typescript
import { AdaptiveNarrativeFlowRecorder } from 'footprintjs';
executor.attachFlowRecorder(new AdaptiveNarrativeFlowRecorder(5, 10));
// Iterations 1–5: full detail
// After 5: every 10th (15, 25, 35, ...)
```

**Parameters:** `new AdaptiveNarrativeFlowRecorder(threshold = 5, sampleRate = 10, id?)`

### ProgressiveNarrativeFlowRecorder

Emits at exponentially increasing intervals: 1, 2, 4, 8, 16, 32... Best for convergence-style loops where early iterations are most informative.

```typescript
import { ProgressiveNarrativeFlowRecorder } from 'footprintjs';
executor.attachFlowRecorder(new ProgressiveNarrativeFlowRecorder(2));
// Emits: pass 1, 2, 4, 8, 16, 32, 64...
```

**Parameters:** `new ProgressiveNarrativeFlowRecorder(base = 2, id?)`

### MilestoneNarrativeFlowRecorder

Emits every Nth iteration for regular progress markers.

```typescript
import { MilestoneNarrativeFlowRecorder } from 'footprintjs';
executor.attachFlowRecorder(new MilestoneNarrativeFlowRecorder(10));
// Emits: pass 1, 10, 20, 30, 40, 50
```

**Parameters:** `new MilestoneNarrativeFlowRecorder(interval = 10, alwaysEmitFirst = true, id?)`

### RLENarrativeFlowRecorder

Run-Length Encoding — collapses consecutive same-target loops into a single summary. Best for simple retry loops.

```typescript
import { RLENarrativeFlowRecorder } from 'footprintjs';
executor.attachFlowRecorder(new RLENarrativeFlowRecorder());
// "Looped through Retry 50 times (passes 1–50)."
```

### SeparateNarrativeFlowRecorder

Two-channel design: main narrative stays clean (no loop sentences), full loop detail available via `getLoopSentences()`. Best for UIs with collapsible sections or LLM pipelines where loop context should be available but not in the main prompt.

```typescript
import { SeparateNarrativeFlowRecorder } from 'footprintjs';

const recorder = new SeparateNarrativeFlowRecorder();
executor.attachFlowRecorder(recorder);
await executor.run();

const mainNarrative = executor.getNarrativeEntries().map((e) => e.text); // clean — no loops
const loopDetail = recorder.getLoopSentences();     // full loop detail
const loopCounts = recorder.getLoopCounts();         // Map<target, count>
```

---

## Choosing a Strategy

| Scenario | Recommended strategy |
|---|---|
| Debugging / short loops (< 10) | `NarrativeFlowRecorder` (default) |
| Moderate loops, show start & end | `WindowedNarrativeFlowRecorder` |
| Loop count only, no detail | `SilentNarrativeFlowRecorder` |
| Unknown loop count, auto-adapt | `AdaptiveNarrativeFlowRecorder` |
| Convergence / refinement loops | `ProgressiveNarrativeFlowRecorder` |
| Regular progress markers | `MilestoneNarrativeFlowRecorder` |
| Simple retry collapser | `RLENarrativeFlowRecorder` |
| UI with collapsible loop section | `SeparateNarrativeFlowRecorder` |
| Custom domain logic | Implement `FlowRecorder` interface |

---

## Building Custom FlowRecorders

### Minimal: Object literal

```typescript
const logger: FlowRecorder = {
  id: 'console-logger',
  onDecision: (e) => console.log(`${e.decider} → ${e.chosen}`),
  onLoop: (e) => console.log(`Loop ${e.iteration}`),
};
```

### Full class

```typescript
import { type FlowRecorder, type FlowLoopEvent, type FlowDecisionEvent } from 'footprintjs';

class AuditFlowRecorder implements FlowRecorder {
  readonly id = 'audit';
  private log: string[] = [];

  onDecision(event: FlowDecisionEvent): void {
    this.log.push(`Decision: ${event.decider} → ${event.chosen} (${event.rationale ?? 'no reason'})`);
  }

  onLoop(event: FlowLoopEvent): void {
    this.log.push(`Loop: ${event.target} iteration ${event.iteration}`);
  }

  getLog(): string[] { return [...this.log]; }
}
```

### Extending NarrativeFlowRecorder

For custom loop strategies, extend `NarrativeFlowRecorder` and override `onLoop()`:

```typescript
import { NarrativeFlowRecorder, type FlowLoopEvent } from 'footprintjs';

class MyStrategy extends NarrativeFlowRecorder {
  constructor() { super('my-strategy'); }

  override onLoop(event: FlowLoopEvent): void {
    // Custom logic — call super.onLoop(event) to emit, or skip
    if (event.iteration % 7 === 0) {
      super.onLoop(event); // only every 7th iteration
    }
  }
}
```

---

## Causal Completeness (RFC-003 Part A)

A causal slice built from `causalChain()` follows **data** edges (read→write
from the commit log). Two things make a naive slice silently WRONG, and the
library now surfaces both:

1. **Control dependence.** A branch stage often reads nothing — it ran
   BECAUSE a decider chose it. Attach `controlDepRecorder()` (from
   `footprintjs/trace`) before running, then pass its lookup to the
   backtracker:

   ```typescript
   import { causalChain, controlDepRecorder, formatCausalChain } from 'footprintjs/trace';

   const ctrl = controlDepRecorder();
   executor.attachFlowRecorder(ctrl);
   await executor.run({ input });

   const dag = causalChain(commitLog, statusStepId, keysRead, {
     controlDeps: ctrl.asLookup(),
   });
   console.log(formatCausalChain(dag!));
   // Approve (approved#2) [wrote: status]
   //   ClassifyRisk (classify-risk#1) ← [control: Good credit]
   //     PullBureau (pull-bureau#0) ← via creditScore [wrote: creditScore]
   ```

   The recorder builds the runtime ancestor chain from
   `TraversalContext.parentRuntimeStageId` and resolves the NEAREST
   governing decision per step — deciders, selectors, nested subflow
   branches, and loop re-entries all correlate by runtime ids.

2. **Honesty markers.** Reads through `getArgs()`/`getEnv()`/unshadowed
   `getValueSilent` bypass tracking — the slice CANNOT follow them. The
   stage's commit carries `untrackedSources`, the slice node carries
   `incompleteSources`, and the formatted chain prints
   `⚠ also consumed args — slice may be incomplete here`. A truncated
   slice (depth/node limits) is equally explicit: `root.truncated` +
   a `⚠ slice truncated …` footer + a dev-mode warning. A consumer —
   human or LLM — debugging from a slice must be TOLD when the slice is
   incomplete; never present a partial slice as the whole story.

Edge weights are consumer-injected via `causalChain(..., { weigh })` — the
engine never computes them (plug in embedding similarity, influence scores,
etc., the same pattern as `NarrativeFormatter`).

Example: [examples/runtime-features/causal-control-deps/01-credit-fixture.ts](../../examples/runtime-features/causal-control-deps/01-credit-fixture.ts)

---

## Multiple Recorders

Attach as many recorders as you need. Each receives every event independently.
`attachFlowRecorder` is **idempotent by ID** — attaching a recorder whose `id`
matches an already-attached one replaces it (prevents accidental double-counting);
distinct IDs coexist.

```typescript
executor.attachFlowRecorder(new WindowedNarrativeFlowRecorder(3, 2)); // narrative
executor.attachFlowRecorder(metricsRecorder);  // telemetry
executor.attachFlowRecorder(auditRecorder);    // compliance
```

### Error Isolation

If a recorder throws, the error is swallowed and execution continues to the next recorder. A failing recorder never breaks your pipeline.

### Detaching

```typescript
executor.detachFlowRecorder('metrics'); // removes by ID
```

---

## Performance

- **Zero-cost when disabled:** When no recorders are attached, every hook call returns immediately (empty array fast-path).
- **Negligible overhead:** ~2ns per recorder per hook call. The dispatch loop is a simple for-of with optional chaining.
- **Tree-shakeable:** All built-in strategies are separate exports. Import only what you use — unused strategies are eliminated by bundlers.
- **No allocation pressure:** Event objects are ~50 bytes, short-lived, same pattern as scope ReadEvent/WriteEvent.

---

## How It Works Internally

```
FlowchartTraverser
     │
     └── HandlerDeps.narrativeGenerator = FlowRecorderDispatcher
              │
              ├── implements IControlFlowNarrative (same interface as ControlFlowNarrativeGenerator)
              │
              ├── attach(recorder) / detach(id) — manages N FlowRecorders
              │
              └── Each hook: for (const r of recorders) { try { r.onX?.(event); } catch { } }
```

The `FlowRecorderDispatcher` implements the existing `IControlFlowNarrative` interface, so it drops into the traverser without any handler changes. The handlers call `narrativeGenerator.onLoop(...)` etc. exactly as before — but now the call fans out to N observers instead of one.

For reference, see:
- [src/lib/engine/narrative/types.ts](../../src/lib/engine/narrative/types.ts) — FlowRecorder interface and event types
- [src/lib/engine/narrative/FlowRecorderDispatcher.ts](../../src/lib/engine/narrative/FlowRecorderDispatcher.ts) — Dispatcher implementation
- [src/lib/engine/narrative/NarrativeFlowRecorder.ts](../../src/lib/engine/narrative/NarrativeFlowRecorder.ts) — Default narrative recorder
- [src/lib/engine/narrative/recorders/](../../src/lib/engine/narrative/recorders/) — built-in narrative strategies (7 loop strategies + `ManifestFlowRecorder`)
