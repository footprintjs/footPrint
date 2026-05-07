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
| `CombinedNarrativeRecorder` | Merge flow + data inline (extends `SequenceRecorder`) | `renderer`, `maxValueLength` | LLM-readable narrative |
| `NarrativeFlowRecorder` | Full English sentences | — | Flow-only narrative |
| `ManifestFlowRecorder` | Subflow tree + specs | — | Subflow catalog |
| `TopologyRecorder` | Composition graph (nodes + edges) | `id` | Live sub-flow topology for streaming UIs |
| `SilentNarrativeFlowRecorder` | Suppress per-loop, summary at end | — | High-iteration loops |
| `WindowedNarrativeFlowRecorder` | First N + last M iterations | `head`, `tail` | Bounded loop detail |
| `AdaptiveNarrativeFlowRecorder` | Full detail then sample | `threshold`, `sampleRate` | Convergence loops |
| `ProgressiveNarrativeFlowRecorder` | Exponential intervals | `base` | Geometric taper |
| `MilestoneNarrativeFlowRecorder` | Every Nth iteration | `interval` | Progress markers |
| `RLENarrativeFlowRecorder` | Run-length compress | — | Collapse consecutive loops |

## TopologyRecorder (exported from `footprintjs/trace`)

**One-liner:** reconstructs a live, queryable mini-flowchart of what your run actually traced, built from the 3 primitive recorder channels during traversal.

**Mental model:**

```
flowChart() builder      →  STATIC flowchart (design-time)
                                       │
                                       ▼ executor runs it
                         Traversal emits events on 3 channels:
                            Recorder · FlowRecorder · EmitRecorder
                                       │
                                       ▼ TopologyRecorder listens
                         DYNAMIC flowchart (runtime shape):
                            Nodes = composition points
                            Edges = transitions
                            Queryable during or after run
```

**What it IS:** live composition graph derived from 3 primitive channels. Each node = one composition-significant moment. Each edge = a control-flow transition with a `runtimeStageId` timestamp. Works identically during or after a run.

**What it ISN'T:** not a full execution tree (that's `StageContext` / `executor.getSnapshot()`), not per-stage data (that's `MetricRecorder`), not agent-specific (agentfootprint composes it, footprintjs owns it).

**Why live consumers need it:** the executor already has the topology internally. But streaming consumers can't access that mid-run — they only see events. `TopologyRecorder` is "the tree, reconstructed from events, live-queryable."

Fills the gap for **streaming / live consumers** (agent UIs, in-flight visualizers) that don't have post-run snapshot access. Listens to `onSubflowEntry/Exit`, `onFork`, `onDecision`, `onLoop` and builds a queryable composition graph as events fire. Post-run consumers can walk `executor.getSnapshot()` directly; this recorder is for the streaming case (and works identically post-run).

```typescript
import { topologyRecorder } from 'footprintjs/trace';

const topo = topologyRecorder();
executor.attachCombinedRecorder(topo); // auto-routes to FlowRecorder channel

await executor.run({ input });

const { nodes, edges, activeNodeId, rootId } = topo.getTopology();
topo.getSubflowNodes();          // agent-centric filter
topo.getByKind('fork-branch');   // all parallel branches across the run
topo.getParallelSiblings(id);    // all fork-branches sharing a fork parent
```

### Three node kinds — complete composition coverage

| Kind | Synthesized from | Represents |
|---|---|---|
| `subflow` | `onSubflowEntry` | Mounted subflow boundary (with stable `subflowId`) |
| `fork-branch` | `onFork` (one per child) | One branch of a parallel fork — works for plain stages AND subflows |
| `decision-branch` | `onDecision` (chosen only) | The chosen branch of a conditional |

Fork-branch and decision-branch nodes are synthesized **immediately** when their events fire, regardless of whether the branch target is a subflow. If the target IS a subflow, the subsequent `onSubflowEntry` nests under the synthetic node — so the graph carries both "who branched" and "what the branch ran."

### Correlation rules

- `onFork({ parent, children })` — N `fork-branch` nodes created up-front. A `pendingFork` map tracks childName → synthetic nodeId. Subsequent `onSubflowEntry` with a matching name nests under the right fork-branch.
- `onDecision({ decider, chosen, rationale })` — `decision-branch` node created immediately. Metadata carries decider + rationale.
- `onSubflowExit` — clears pending fork/decision state so stale correlations don't leak across sibling scopes.
- `onLoop` — self-edge on the currently-active subflow. Synthetic nodes are instantaneous, so they don't participate in loop edges.
- Re-entry of same `subflowId` (e.g. loop body re-enters the same subflow) disambiguates via `id#n` suffix.

### Not tracked

Plain sequential stages are not topology nodes. Topology is a graph of control-flow branching points, not a full execution tree. Use `MetricRecorder` or `StageContext` for per-stage data.

### For downstream libraries (agentfootprint, etc.)

**Compose — don't duplicate.** Wrap `topologyRecorder()` inside your agent-shaped recorder and translate topology nodes into agent semantics. Without this, every domain library that needs "what's the shape of this run?" re-implements subflow-stack + fork-map + decision-tracker — slightly wrong in different ways each time.

Example: [examples/runtime-features/flow-recorder/06-topology.ts](../../../examples/runtime-features/flow-recorder/06-topology.ts)

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

## Recorder Storage Primitives — three bookkeeping shelves

Recorders have **two halves**:

- **Observer half** — *how* it hears events. Implements one of `Recorder` / `FlowRecorder` / `EmitRecorder` / `CombinedRecorder`.
- **Storage half** — *where* it keeps data. Extends one of three abstract base classes on the **storage shelf**.

Mental model: existing recorder *interfaces* are **observers**. Storage primitives are **bookkeeping shelves**. A real recorder picks ONE observer interface AND ONE storage shelf, combining via `extends + implements` in a single class. Same pattern that's already used by `BoundaryRecorder` (which extends `SequenceRecorder<DomainEvent>` AND implements `CombinedRecorder`).

The three storage primitives:

| Base Class | Relationship | Time scope | Memory | Use When |
|------------|-------------|------------|--------|----------|
| **`KeyedRecorder<T>`** | 1:1 Map | durable | O(N steps) | Each step produces exactly one record (MetricRecorder, TokenRecorder) |
| **`SequenceRecorder<T>`** | 1:N sequence + Map | durable | O(N events) | Multiple entries per step, ordering matters (CombinedNarrativeRecorder, BoundaryRecorder) |
| **`BoundaryStateTracker<TState>`** 🆕 | Map\<key, TState\> active stack | transient — clears on stop | O(K active) | Live state DURING a `[start, stop]` bracket (LLM stream partial, tool args streaming, agent turn state) |

All three are exported from `footprintjs/trace` and `footprintjs/advanced`.

### Decision tree

```
1. Is the data DURABLE (kept after the run completes)?
     yes → step 2
     no  → BoundaryStateTracker<TState>

2. Are there MULTIPLE entries per stage, and does ORDER matter?
     yes → SequenceRecorder<T>
     no  → KeyedRecorder<T>
```

### Shared operations (durable shelves only)

`KeyedRecorder<T>` and `SequenceRecorder<T>` share the same three read operations:

| Operation | KeyedRecorder | SequenceRecorder |
|-----------|--------------|-----------------|
| **Translate** (per-step) | `getByKey(id)` → `T` | `getEntriesForStep(id)` → `T[]` |
| **Aggregate** (reduce all) | `aggregate(fn, initial)` | `aggregate(fn, initial)` |
| **Accumulate** (progressive) | `accumulate(fn, initial, keys?)` | `accumulate(fn, initial, keys?)` |

### KeyedRecorder<T> — 1:1 Map-Based Recorders

```typescript
import { KeyedRecorder } from 'footprintjs/trace';

class TokenRecorder extends KeyedRecorder<LLMCallEntry> {
  readonly id = 'token-recorder';

  onLLMCall(event: LLMCallEvent) {
    this.store(event.runtimeStageId, { model: event.model, tokens: event.usage });
  }

  getTotalTokens() {
    return this.aggregate((sum, e) => sum + e.tokens, 0);
  }
}
```

Methods: `store(key, entry)`, `getByKey(key)`, `getMap()`, `values()`, `size`, `aggregate()`, `accumulate()`, `filterByKeys()`, `clear()`.

### SequenceRecorder<T> — 1:N Ordered Sequence Recorders

For recorders that implement **both** Recorder and FlowRecorder (merging data ops and control flow into a single interleaved sequence). Entries must satisfy `{ runtimeStageId?: string }`.

```typescript
import { SequenceRecorder } from 'footprintjs/trace';

interface AuditEntry {
  runtimeStageId?: string;
  type: 'read' | 'write' | 'decision';
  detail: string;
}

class AuditRecorder extends SequenceRecorder<AuditEntry> {
  readonly id = 'audit';

  // Scope hooks (fires during stage execution)
  onRead(event: ReadEvent) {
    this.emit({ runtimeStageId: event.runtimeStageId, type: 'read', detail: event.key });
  }
  onWrite(event: WriteEvent) {
    this.emit({ runtimeStageId: event.runtimeStageId, type: 'write', detail: event.key });
  }

  // Flow hooks (fires after stage execution)
  onDecision(event: FlowDecisionEvent) {
    this.emit({
      runtimeStageId: event.traversalContext?.runtimeStageId,
      type: 'decision',
      detail: `${event.decider} chose ${event.chosen}`,
    });
  }

  // Time-travel: entries up to slider position
  getAuditUpTo(visibleIds: ReadonlySet<string>) {
    return this.getEntriesUpTo(visibleIds);
  }
}
```

Methods: `emit(entry)`, `getEntries()`, `getEntriesForStep(id)`, `getEntriesUpTo(visibleIds)`, `getEntryRanges()`, `entryCount`, `stepCount`, `aggregate()`, `accumulate()`, `forEachEntry()`, `clear()`.

`getEntryRanges()` returns a precomputed `Map<runtimeStageId, {firstIdx, endIdx}>` maintained during `emit()`. Use for O(1) per-step lookups during time-travel slider scrubbing — same shape as `buildEntryRangeIndex()` in `footprint-explainable-ui`.

### BoundaryStateTracker<TState> — Transient Bracket-Scoped State 🆕

The third storage shelf — for **live transient state** that exists only while a matched `[start, stop]` event interval is open. Cleared on stop. Algorithmically: the **DFS bracket-sequence pattern** (stack-frame state during a graph-traversal interval). Same shape used by Tarjan's SCC algorithm, tree decomposition, and push-down automata.

**Use when:** "Is something happening RIGHT NOW? What's the partial value mid-stream?"

**Don't use when:** time-travel queries (state clears on stop — snapshot to a `SequenceRecorder<TState>` instead), run-wide aggregates (use `aggregate()` / `accumulate()`), stage-level concerns (use `Recorder.onStageStart` / `onStageEnd`).

```typescript
import { BoundaryStateTracker } from 'footprintjs/trace';
import type { EmitEvent, EmitRecorder } from 'footprintjs';

interface LLMLiveState {
  readonly partial: string;
  readonly tokens: number;
}

class LiveLLMTracker
  extends BoundaryStateTracker<LLMLiveState>      // STORAGE shelf
  implements EmitRecorder                          // OBSERVER interface
{
  readonly id = 'live-llm';

  // Observer half — translate events into bracket mutations.
  onEmit(e: EmitEvent): void {
    if (e.name === 'agentfootprint.stream.llm_start') {
      this.startBoundary(e.runtimeStageId, { partial: '', tokens: 0 });
    } else if (e.name === 'agentfootprint.stream.token') {
      const chunk = (e.payload as { content: string }).content;
      this.updateBoundary(e.runtimeStageId, (s) => ({
        partial: s.partial + chunk,
        tokens: s.tokens + 1,
      }));
    } else if (e.name === 'agentfootprint.stream.llm_end') {
      this.stopBoundary(e.runtimeStageId);
    }
  }

  // Public read API — O(1) at any moment during the run.
  isInFlight(): boolean { return this.hasActive; }
  getPartial(stageId: string): string {
    return this.getActive(stageId)?.partial ?? '';
  }
}

const tracker = new LiveLLMTracker();
executor.attachEmitRecorder(tracker);
await executor.run();

tracker.isInFlight();    // O(1) — true between llm_start and llm_end
tracker.getActive(rid);  // O(1) — current state of one boundary
tracker.activeCount;     // O(1) — concurrent active boundaries
```

**Public API:**

| Method | Visibility | Purpose |
|---|---|---|
| `startBoundary(key, initial)` | `protected` | Open a new boundary |
| `updateBoundary(key, updater)` | `protected` | Evolve in-flight state via pure function |
| `stopBoundary(key) → TState \| undefined` | `protected` | Close + return final state |
| `getActive(key) → TState \| undefined` | `public` | O(1) read of one boundary |
| `getAllActive() → ReadonlyMap` | `public` | All currently-active boundaries |
| `hasActive` (getter) | `public` | True if any boundary active |
| `activeCount` (getter) | `public` | Number of active boundaries |
| `clear()` | `public` | Lifecycle reset (called by executors before each run) |

**Lifecycle contract — STRICT:** every `startBoundary(key, ...)` MUST be paired with a `stopBoundary(key)`. Failure to wire stop is a memory leak — the active map grows unboundedly. Common cause: subclass wires `start` to one event handler and forgets to wire `stop`. Always wire both at the same time.

**Dev-mode safety** (`enableDevMode()`, zero overhead in production):
- `clear()` warns when residual active boundaries are detected at run boundaries — names the leaked keys
- `updateBoundary` before `startBoundary` warns at the 1st, 10th, 100th occurrence per key (rate-limited)
- `startBoundary` on an already-active key warns

**Key convention:** use `runtimeStageId` for boundaries that map 1:1 to a stage execution — gives free interop with `getEntriesForStep`, `getByKey`, `findCommit` / `findLastWriter`, and the rest of the trace ecosystem. Use a more granular key (e.g., `toolCallId`) only when there are multiple concurrent boundaries WITHIN one stage.

**Concurrency:** the same tracker handles N concurrent boundaries (parallel branches with multiple LLM calls) via independent keys in the active map. For DIFFERENT boundary kinds (e.g., LLM vs. Tool), use separate tracker instances — one per kind.

Example: [examples/runtime-features/data-recorder/06-boundary-state-tracker.ts](../../../examples/runtime-features/data-recorder/06-boundary-state-tracker.ts)

Doc-site: [Recorder storage primitives](https://footprintjs.github.io/footPrint/guides/features/recorder-storage-primitives/)

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
