# recorder/ — Composable Observation Infrastructure

Composition primitives for combining multiple recorders into bundled presets. Domain libraries use this to offer one-call observability without forcing consumers to know individual recorder types.

## Architecture

footprintjs has **two parallel recorder systems**:

| System | Interface | Fires | Captures |
|--------|-----------|-------|----------|
| **Scope Recorder** | `Recorder` | DURING stage execution | Data ops: reads, writes, commits, errors, stage start/end |
| **Flow Recorder** | `FlowRecorder` | AFTER stage execution | Control flow: decisions, forks, loops, subflows, breaks |

Both use the same pattern: `{ id, optional hooks } → dispatcher → error isolation → attach/detach`.

## ID Contract

```
attachRecorder is idempotent by ID:
  Same ID    → replaces (prevents double-counting)
  Different  → coexists (multiple configs)
```

**Built-in recorders** use auto-increment IDs (`metrics-1`, `debug-1`, ...) so multiple instances coexist by default.

**Framework recorders** use well-known IDs (`'metrics'`) so consumers can override or coexist:

```typescript
// Framework auto-attaches with well-known ID
executor.attachRecorder(new MetricRecorder('metrics'));

// Consumer overrides (same ID → replace)
executor.attachRecorder(new MetricRecorder('metrics'));

// Consumer adds second (different auto ID → coexist)
executor.attachRecorder(new MetricRecorder());
```

## Built-in Recorders

### Scope Recorders

| Recorder | Hooks | Config | Snapshot | Purpose |
|----------|-------|--------|----------|---------|
| `MetricRecorder` | read, write, commit, stageStart, stageEnd | `stageFilter`, `id` | `{ name: 'Metrics', data: { stages, totals } }` | Timing + counts |
| `DebugRecorder` | read, write, error, stageStart, stageEnd | `verbosity`, `id` | — | Development diagnostics |

### Flow Recorders

| Recorder | Strategy | Config | Purpose |
|----------|----------|--------|---------|
| `CombinedNarrativeRecorder` | Merge flow + data inline | `renderer`, `maxValueLength` | LLM-readable narrative |
| `NarrativeFlowRecorder` | Full English sentences | — | Flow-only narrative |
| `ManifestFlowRecorder` | Subflow tree + specs | — | Subflow catalog |
| `SilentNarrativeFlowRecorder` | Suppress per-loop, summary at end | — | High-iteration loops |
| `WindowedNarrativeFlowRecorder` | First N + last M iterations | `head`, `tail` | Bounded loop detail |
| `AdaptiveNarrativeFlowRecorder` | Full detail then sample | `threshold`, `sampleRate` | Convergence loops |
| `ProgressiveNarrativeFlowRecorder` | Exponential intervals | `base` | Geometric taper |
| `MilestoneNarrativeFlowRecorder` | Every Nth iteration | `interval` | Progress markers |
| `RLENarrativeFlowRecorder` | Run-length compress | — | Collapse consecutive loops |

## CompositeRecorder

Bundles multiple child recorders under a single ID. Implements **both** `Recorder` and `FlowRecorder` — fan-out all events to children.

```typescript
import { CompositeRecorder, MetricRecorder, DebugRecorder } from 'footprintjs';

const bundle = new CompositeRecorder('my-observability', [
  new MetricRecorder({ stageFilter: (name) => name === 'CallLLM' }),
  new DebugRecorder({ verbosity: 'minimal' }),
]);

executor.attachRecorder(bundle);

// Access children by type
const metrics = bundle.get(MetricRecorder);
metrics?.getMetrics();
```

### Why CompositeRecorder exists

Without it, domain libraries force consumers to attach multiple recorders:

```typescript
// Without composite — 4 calls, consumer must know all types
executor.attachRecorder(new MetricRecorder());
executor.attachRecorder(new TokenRecorder());
executor.attachRecorder(new ToolUsageRecorder());
executor.attachRecorder(new CostRecorder());
```

With it, the domain library exports a preset:

```typescript
// With composite — 1 call, consumer knows nothing about internals
executor.attachRecorder(agentObservability());
```

### Snapshot format

```typescript
{
  name: 'Composite',
  data: {
    children: [
      { id: 'metrics-1', name: 'Metrics', data: { stages: {...}, totalDuration: 42 } },
      { id: 'debug-1',   name: 'Debug',   data: [...entries] },
    ]
  }
}
```

## KeyedRecorder<T> — Base Class for Map-Based Recorders

Abstract base class that provides typed key-value storage keyed by `runtimeStageId`. Recorder implementations extend this and call `store()` from their event hooks.

```typescript
import { KeyedRecorder } from 'footprintjs/advanced';

class TokenRecorder extends KeyedRecorder<LLMCallEntry> {
  readonly id = 'token-recorder';

  onLLMCall(event: LLMCallEvent) {
    this.store(event.runtimeStageId, { model: event.model, tokens: event.usage });
  }

  getStats() {
    return { totalCalls: this.size, calls: this.values() };
  }
}
```

Methods: `store(key, entry)`, `getByKey(key)`, `getMap()`, `values()`, `size`, `clear()`.

## Three Operations on Auto-Collected Data

Data is automatically collected during the single DFS traversal. The consumer chooses the operation at read time:

| Operation | Method | Use case |
|-----------|--------|----------|
| **Translate** (raw) | `getByKey(id)` | Per-step value for time-travel detail |
| **Accumulate** (progressive) | `accumulate(fn, initial, keys?)` | Running total up to slider position |
| **Aggregate** (summary) | `aggregate(fn, initial)` | Grand total for dashboards/export |

```typescript
// Translate: what happened at this step?
const step = recorder.getByKey('call-llm#5');

// Accumulate: running total up to slider position
const visibleKeys = collectKeysUpTo(snapshots, selectedIndex);
const tokensUpToHere = recorder.accumulate((sum, e) => sum + e.tokens, 0, visibleKeys);

// Aggregate: grand total
const totalTokens = recorder.aggregate((sum, e) => sum + e.tokens, 0);

// Filter: entries up to slider position (for display)
const entries = recorder.filterByKeys(visibleKeys);
```

**How this differs from Prometheus/OTel:** They aggregate across thousands of requests (cross-request). We operate within a single request's execution steps (per-request). Our `aggregate()` produces ONE data point that feeds their collection pipeline via OTelRecorder.

## Custom Recorders

### Scope Recorder (data ops)

```typescript
import type { Recorder, WriteEvent } from 'footprintjs';

class AuditRecorder implements Recorder {
  readonly id = 'audit';
  private writes: Array<{ stage: string; key: string }> = [];

  onWrite(event: WriteEvent): void {
    this.writes.push({ stage: event.stageName, key: event.key });
  }

  toSnapshot() {
    return { name: 'Audit', data: this.writes };
  }

  clear() {
    this.writes = [];
  }
}
```

### Flow Recorder (control flow)

```typescript
import type { FlowRecorder, FlowDecisionEvent } from 'footprintjs';

class DecisionTracker implements FlowRecorder {
  readonly id = 'decisions';
  private decisions: Array<{ decider: string; chosen: string }> = [];

  onDecision(event: FlowDecisionEvent): void {
    this.decisions.push({ decider: event.decider, chosen: event.chosen });
  }

  toSnapshot() {
    return { name: 'Decisions', data: this.decisions };
  }

  clear() {
    this.decisions = [];
  }
}
```

### Domain Preset (composite)

```typescript
import { CompositeRecorder, MetricRecorder } from 'footprintjs';
import { TokenRecorder, ToolUsageRecorder } from 'agentfootprint';

export interface AgentObservabilityOptions {
  stageFilter?: (name: string) => boolean;
}

export function agentObservability(options?: AgentObservabilityOptions): CompositeRecorder {
  return new CompositeRecorder('agent-observability', [
    new MetricRecorder(options?.stageFilter ? { stageFilter: options.stageFilter } : undefined),
    new TokenRecorder(),
    new ToolUsageRecorder(),
  ]);
}
```

## Design Principles

1. **Never extend a generic recorder with domain concepts.** Cost tracking belongs in agentfootprint, not footprintjs. Use composition instead.
2. **Recorders are single-responsibility.** MetricRecorder does timing. DebugRecorder does diagnostics. They don't overlap.
3. **Composition > inheritance.** CompositeRecorder bundles recorders without subclassing. Domain libraries build presets, consumers call one function.
4. **IDs enable idempotent attach.** Same ID replaces, different IDs coexist. Framework uses well-known IDs, consumer uses auto-increment.
5. **All recorders should implement `toSnapshot()`.** Snapshot is the serialization boundary — if a recorder doesn't snapshot, its data is invisible to downstream systems (Gantt chart, ELK, Datadog).
6. **All recorders should implement `clear()`.** The executor calls `clear()` before each `run()` to prevent cross-run accumulation.

## Dependency Position

```
memory ← scope ← reactive ← engine ← runner
                    ↑
                 recorder/     ← NEW: composition primitives
                    ↑
              scope/recorders/ ← MetricRecorder, DebugRecorder
              engine/narrative/ ← FlowRecorder strategies
```

`recorder/` imports types from `scope/types` and `engine/narrative/types` but has no runtime dependency on either system. It's pure composition infrastructure.
