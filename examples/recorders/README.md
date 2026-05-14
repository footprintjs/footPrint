---
name: Recorders — Compose Stores
group: Recorders
---

# Composing recorders from stores

In v5, build a recorder by COMPOSING one or more stores as class fields, NOT by extending an abstract base. One purpose per recorder.

## The 3 store primitives

| Store | Shape | Use when |
|---|---|---|
| `SequenceStore<T>` | append-only ordered + per-key index | recorder produces 1:N entries per `runtimeStageId`, ordering matters (audit log, narrative entries) |
| `KeyedStore<T>` | 1:1 Map by key | recorder produces 1:1 record per step (per-stage metric, token count) |
| `BoundaryStateStore<T>` | per-key transient state | recorder needs LIVE in-flight state during `[start, stop]` brackets (streaming LLM partial, upload progress) |

## The pattern

```typescript
import { SequenceStore } from 'footprintjs/trace';
import type { ScopeRecorder } from 'footprintjs';

class MyRecorder implements ScopeRecorder {
  readonly id = 'my-recorder';
  private readonly store = new SequenceStore<MyEntry>();

  // Event hooks — pure handler logic, delegate storage to the store.
  onWrite(event) { this.store.push({...}); }

  // Public read API — delegate to the store.
  getEntries() { return this.store.getAll(); }

  // Lifecycle — opt into reset on each run by implementing clear().
  clear() { this.store.clear(); }
}
```

## Examples

| File | What it shows |
|---|---|
| [01-compose-sequence-store.ts](./01-compose-sequence-store.ts) | Audit-log recorder — `SequenceStore` for read/write events |
| [02-compose-keyed-store.ts](./02-compose-keyed-store.ts) | Per-stage duration metric — `KeyedStore` for 1:1 records |
| [03-compose-boundary-state.ts](./03-compose-boundary-state.ts) | Upload-progress tracker — `BoundaryStateStore` for in-flight state |
| [04-multi-purpose-facade.ts](./04-multi-purpose-facade.ts) | Multi-channel recorder — composes 3 stores (one per channel) |
| [05-runtime-stage-id-scoping.ts](./05-runtime-stage-id-scoping.ts) | Cross-run-safe lookups — composite key `(runId, runtimeStageId)` |

## Why composition (not inheritance)

In v4, recorder classes extended `SequenceRecorder<T>`, `KeyedRecorder<T>`, or `BoundaryStateTracker<T>`. The pattern invited "kitchen sink" subclasses — one class doing storage + event handling + state machine + scope filtering. Each new feature added another concern to the same class. Each new bug required threading state through more concerns.

In v5: stores ARE storage; recorders ARE event handlers; consumers COMPOSE. One purpose per class.

The abstract bases are still exported during the v5 migration window for downstream consumers that haven't migrated yet, but they're slated for removal before 5.0 final.

Run any example with `npx tsx examples/recorders/<file>.ts`.
