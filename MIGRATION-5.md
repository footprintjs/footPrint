# footprintjs 5.0 Migration Guide

5.0 is a recorder-system rewrite. Three breaking changes, one additive.

| Change | Type | Description |
|---|---|---|
| `Recorder` → `ScopeRecorder` | Rename | Naming symmetry with `FlowRecorder` and `EmitRecorder` |
| `attachRecorder` → `attachScopeRecorder` | Rename | Same — explicit channel naming |
| Abstract bases → concrete stores | Composition | `SequenceRecorder<T>` → `SequenceStore<T>` (compose, don't extend) |
| `runId` on `TraversalContext` | Additive | Per-`executor.run()` identifier for scoping recorder state |

---

## 1. `Recorder` → `ScopeRecorder`

```diff
- import type { Recorder } from 'footprintjs';
+ import type { ScopeRecorder } from 'footprintjs';

- const r: Recorder = { ... };
+ const r: ScopeRecorder = { ... };

- executor.attachRecorder(r);
+ executor.attachScopeRecorder(r);
```

**Why:** `Recorder` was the historical name for the data-flow channel. `FlowRecorder` and `EmitRecorder` carry their channel as a prefix; `ScopeRecorder` restores symmetry. New consumers can guess the API from the name.

---

## 2. Concrete stores instead of abstract bases

```diff
- import { SequenceRecorder } from 'footprintjs/trace';
+ import { SequenceStore } from 'footprintjs/trace';

- class AuditRecorder extends SequenceRecorder<AuditEntry> {
-   readonly id = 'audit';
-   onWrite(e) { this.emit({...}); }
- }

+ class AuditRecorder implements ScopeRecorder {
+   readonly id = 'audit';
+   private readonly store = new SequenceStore<AuditEntry>();
+   onWrite(e) { this.store.push({...}); }
+   getEntries() { return this.store.getAll(); }
+   clear() { this.store.clear(); }
+ }
```

| Was (abstract base) | Now (concrete store) | API change |
|---|---|---|
| `extends SequenceRecorder<T>` | `private store = new SequenceStore<T>()` | `this.emit(x)` → `this.store.push(x)` |
| `extends KeyedRecorder<T>` | `private store = new KeyedStore<T>()` | `this.store(id, x)` → `this.store.set(id, x)` |
| `extends BoundaryStateTracker<T>` | `private store = new BoundaryStateStore<T>()` | `this.startBoundary(k, v)` → `this.store.start(k, v)`, `updateBoundary` → `update`, `stopBoundary` → `stop` |

**Method-name changes inside stores:**

| `SequenceRecorder` (old) | `SequenceStore` (new) |
|---|---|
| `protected emit(x)` | `push(x)` |
| `getEntries()` | `getAll()` |
| `entryCount` (getter) | `size` (getter) |
| `getEntriesForStep(rid)` | `getByKey(rid)` |
| `stepCount` (getter) | `keyCount` (getter) |
| `aggregate / accumulate` | unchanged |
| `getEntriesUpTo(keys)` | unchanged |
| `clear()` | unchanged |

| `KeyedRecorder` (old) | `KeyedStore` (new) |
|---|---|
| `protected store(id, x)` | `set(id, x)` |
| `getByKey(id)` | `get(id)` |
| `getMap() / values() / size` | unchanged |
| `aggregate / accumulate / filterByKeys` | unchanged |
| `clear()` | unchanged |

| `BoundaryStateTracker` (old) | `BoundaryStateStore` (new) |
|---|---|
| `protected startBoundary(k, v)` | `start(k, v)` |
| `protected updateBoundary(k, fn)` | `update(k, fn)` |
| `protected stopBoundary(k)` | `stop(k)` |
| `getActive(k)` | `get(k)` |
| `getAllActive()` | `getAll()` |
| `hasActive / activeCount` (getters) | unchanged |
| `clear()` | unchanged |

**Why:** abstract bases invited "kitchen sink" subclasses — one class doing storage + event handling + state machine + scope filtering. Composition forces one purpose per recorder. See `CLAUDE.md` Convention 1.

**Migration window:** the old abstract bases are STILL EXPORTED in 5.0 to give downstream consumers (agentfootprint, agentfootprint-lens) time to migrate. They're slated for removal in 5.0 final. Don't write new code against them.

---

## 3. `runId` on `TraversalContext` (additive — no migration needed)

Every event now carries `event.traversalContext.runId`. Recorders that accumulate state across multiple runs detect "new run" and reset:

```typescript
class CrossRunRecorder implements FlowRecorder {
  readonly id = 'cross-run';
  private lastRunId: string | undefined;
  private state = new Map<string, number>();

  onSubflowEntry(event) {
    const runId = event.traversalContext?.runId;
    if (runId && runId !== this.lastRunId) {
      this.state.clear();        // new run — reset transient state
      this.lastRunId = runId;
    }
    // ...accumulate
  }
}
```

Recorders that don't care about scoping ignore the field — fully backward-compatible at the type level.

See `examples/runtime-features/run-id/` for 4 canonical patterns:
- detect new run
- per-run scoping with reset
- nested runs (subflows inherit; nested executors get own)
- resume (gets a new runId)

---

## 4. Test files

Many test fixtures construct `TraversalContext` literals. Add `runId` field if your fixture is type-checked strictly:

```diff
  const ctx: TraversalContext = {
+   runId: 'test-run',
    stageId: 'a',
    runtimeStageId: 'a#0',
    stageName: 'A',
    depth: 0,
  };
```

Most existing fixtures pass partial objects via inference and don't need updating.

---

## 5. Version bumps in monorepo

footprintjs 5.0 → bump dependents in lockstep:

- `agentfootprint` → x.0.0 (consumes ScopeRecorder + abstract bases that need migration)
- `agentfootprint-lens` → x.0.0 (consumes runId for slider scoping; LensRecorder migration)
- `footprint-explainable-ui` → x.0.0 (consumer of ScopeRecorder + naming changes)
- `agent-playground` → updated, no version bump

---

## 6. Why no deprecation cycle?

footprintjs 4.x has no released external consumers. The migration is internal-only — agentfootprint, lens, explainable-ui, playground. Atomic update across the monorepo is cleaner than a months-long deprecation period when there are no third-party users to support.
