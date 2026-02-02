# Scope Integration Proposal

This document captures the architectural findings about the scope system and proposes how to integrate the new `Scope` class with the existing pipeline execution.

## Current Architecture Analysis

### The Three Layers

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        CONSUMER LAYER                                    │
│  (What flow developers see and use)                                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   ┌──────────────────┐         ┌──────────────────┐                     │
│   │   BaseState      │         │   Custom Scope   │                     │
│   │   (extends)      │         │   (any shape)    │                     │
│   └────────┬─────────┘         └────────┬─────────┘                     │
│            │                            │                                │
│            └──────────┬─────────────────┘                                │
│                       │                                                  │
│                       ▼                                                  │
│            ┌──────────────────────┐                                     │
│            │    ScopeFactory      │  ← Consumer provides this           │
│            │  (ctx, name) => TScope                                     │
│            └──────────┬───────────┘                                     │
│                       │                                                  │
├───────────────────────┼──────────────────────────────────────────────────┤
│                       │         ENGINE LAYER                             │
│                       │  (What the pipeline engine manages)              │
├───────────────────────┼──────────────────────────────────────────────────┤
│                       ▼                                                  │
│            ┌──────────────────────┐                                     │
│            │    StageContext      │  ← Engine creates per stage         │
│            │  (memory engineer)   │                                     │
│            └──────────┬───────────┘                                     │
│                       │                                                  │
│                       ▼                                                  │
│            ┌──────────────────────┐                                     │
│            │    GlobalStore       │  ← Shared state container           │
│            │  (the actual heap)   │                                     │
│            └──────────────────────┘                                     │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Components

#### StageContext (Memory Engineer - Internal)

**Location:** `src/core/memory/StageContext.ts` (re-exported from `src/core/context/StageContext.ts` for backward compatibility)

StageContext is the **internal memory manager** - like a compiler's stack frame allocator:

| Responsibility | Method |
|---------------|--------|
| Create memory for stages | Constructor |
| Build execution tree | `createNext()`, `createChild()`, `createDecider()` |
| Namespace isolation | `withNamespace()` → `['pipelines', id, ...path, key]` |
| Buffer writes | Via `WriteBuffer` for atomic commits |
| Track metadata | `StageMetadata` for logs, errors, metrics |
| Commit to store | `commit()` → `GlobalStore.applyPatch()` |

**Key insight:** StageContext is **not consumer-facing**. Consumers never directly instantiate it.

#### BaseState (Consumer Interface)

**Location:** `src/scope/core/BaseState.ts`

BaseState is what **flow developers extend** to define their scope:

```typescript
class ChatScope extends BaseState {
  get userQuestion(): string | undefined {
    return this.getValue([], 'userQuestion') as string;
  }
  
  set userQuestion(value: string) {
    this.setObject([], 'userQuestion', value);
  }
}
```

**Key insight:** BaseState wraps StageContext but hides engine internals (no `createNext()`, no `WriteBuffer`).

#### ScopeFactory (Bridge)

**Location:** `src/core/context/types.ts`

The ScopeFactory bridges engine and consumer layers:

```typescript
type ScopeFactory<TScope> = (core: StageContext, stageName: string, readOnlyContext?: unknown) => TScope;

// Example usage
const scopeFactory = (ctx: StageContext, stageName: string) => new ChatScope(ctx, stageName);
```

### The New Scope Class

**Location:** `src/scope/Scope.ts`

The new `Scope` class adds **pluggable observability** via Recorders:

| Feature | Current (StageMetadata) | New (Scope + Recorders) |
|---------|------------------------|-------------------------|
| Debug logging | Fixed `addLog()` | Pluggable `DebugRecorder` |
| Metrics | Fixed `addMetric()` | Pluggable `MetricRecorder` |
| Custom hooks | ❌ | ✅ Consumer can implement `Recorder` |
| Time-travel | Via `ExecutionHistory` | Built-in `getSnapshots()` |
| Stage lifecycle | Implicit | Explicit `startStage()`/`endStage()` |

---

## Integration Proposal

### Option A: Scope as StageContext Replacement (Recommended)

Replace StageContext with Scope as the internal memory manager.

#### Architecture After Integration

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        CONSUMER LAYER                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   ┌──────────────────┐         ┌──────────────────┐                     │
│   │   BaseState      │         │   Custom Scope   │                     │
│   └────────┬─────────┘         └────────┬─────────┘                     │
│            │                            │                                │
│            └──────────┬─────────────────┘                                │
│                       ▼                                                  │
│            ┌──────────────────────┐                                     │
│            │    ScopeFactory      │                                     │
│            └──────────┬───────────┘                                     │
│                       │                                                  │
├───────────────────────┼──────────────────────────────────────────────────┤
│                       │         ENGINE LAYER                             │
├───────────────────────┼──────────────────────────────────────────────────┤
│                       ▼                                                  │
│            ┌──────────────────────┐                                     │
│            │       Scope          │  ← NEW: Replaces StageContext       │
│            │  + Recorder hooks    │                                     │
│            └──────────┬───────────┘                                     │
│                       │                                                  │
│         ┌─────────────┼─────────────┐                                   │
│         ▼             ▼             ▼                                   │
│   ┌───────────┐ ┌───────────┐ ┌───────────┐                            │
│   │DebugRec.  │ │MetricRec. │ │CustomRec. │  ← Pluggable               │
│   └───────────┘ └───────────┘ └───────────┘                            │
│                       │                                                  │
│                       ▼                                                  │
│            ┌──────────────────────┐                                     │
│            │    GlobalStore       │                                     │
│            └──────────────────────┘                                     │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

#### Migration Steps

**Phase 1: Add Tree Navigation to Scope**

The current Scope class lacks tree navigation. Add:

```typescript
// src/scope/Scope.ts - additions needed
class Scope {
  // Existing...
  
  // NEW: Tree navigation (from StageContext)
  public parent?: Scope;
  public next?: Scope;
  public children?: Scope[];
  
  createNext(pipelineId: string, stageName: string): Scope {
    if (!this.next) {
      this.next = new Scope({
        pipelineId,
        stageName,
        globalStore: this.globalStore,
        executionHistory: this.executionHistory,
        recorders: this.recorders, // Inherit recorders
      });
      this.next.parent = this;
    }
    return this.next;
  }
  
  createChild(pipelineId: string, branchId: string, stageName: string): Scope {
    // Similar to StageContext.createChild()
  }
}
```

**Phase 2: Update StageRunner**

Modify `StageRunner.run()` to use Scope:

```typescript
// src/core/pipeline/StageRunner.ts
async run(node: StageNode, stageFunc: PipelineStageFunction, scope: Scope, breakFn: () => void) {
  // Signal stage start (triggers recorders)
  scope.startStage(node.name);
  
  // Create consumer scope via ScopeFactory
  const rawScope = this.ctx.ScopeFactory(scope, node.name, this.ctx.readOnlyContext);
  const protectedScope = createProtectedScope(rawScope, { mode: this.ctx.scopeProtectionMode });
  
  // Execute stage
  const result = await stageFunc(protectedScope, breakFn, streamCallback);
  
  // Signal stage end (triggers recorders with duration)
  scope.endStage();
  
  return result;
}
```

**Phase 3: Update PipelineRuntime**

Replace `rootStageContext` with `rootScope`:

```typescript
// src/core/context/PipelineRuntime.ts
class PipelineRuntime {
  public globalStore: GlobalStore;
  public rootScope: Scope;  // NEW: replaces rootStageContext
  public executionHistory: ExecutionHistory;
  
  constructor(rootName: string, defaultValues?: unknown, initial?: unknown, recorders?: Recorder[]) {
    this.executionHistory = new ExecutionHistory(initial);
    this.globalStore = new GlobalStore(defaultValues, initial);
    this.rootScope = new Scope({
      pipelineId: '',
      stageName: rootName,
      globalStore: this.globalStore,
      executionHistory: this.executionHistory,
      recorders: recorders ?? [new DebugRecorder(), new MetricRecorder()], // Default recorders
    });
  }
}
```

**Phase 4: Deprecate StageContext**

1. Mark `StageContext` as `@deprecated`
2. Add adapter: `StageContext extends Scope` for backward compatibility
3. Update all internal usages to use `Scope`
4. Remove `StageContext` in next major version

---

### Option B: Scope as Adapter Layer

Keep StageContext as internal, wrap it with Scope for recorder hooks.

#### Architecture

```
Consumer Scope (BaseState)
        │
        ▼
    ScopeFactory
        │
        ▼
      Scope (adapter) ──────► Recorders
        │
        ▼
   StageContext (unchanged)
        │
        ▼
    GlobalStore
```

#### Implementation

```typescript
// src/scope/ScopeAdapter.ts
class ScopeAdapter {
  constructor(
    private readonly stageContext: StageContext,
    private readonly recorders: Recorder[],
  ) {}
  
  getValue(path: string[], key?: string): unknown {
    const value = this.stageContext.getValue(path, key);
    this.invokeHook('onRead', { path, key, value, ... });
    return value;
  }
  
  setObject(path: string[], key: string, value: unknown): void {
    this.stageContext.setObject(path, key, value);
    this.invokeHook('onWrite', { path, key, value, operation: 'set', ... });
  }
}
```

#### Pros/Cons

| Aspect | Option A (Replace) | Option B (Adapter) |
|--------|-------------------|-------------------|
| Code changes | More extensive | Minimal |
| Performance | Single layer | Extra indirection |
| Maintenance | One class to maintain | Two classes |
| Backward compat | Needs deprecation path | Fully compatible |
| Clean architecture | ✅ | ❌ (two similar classes) |

---

## Recommended Approach: Option A with Phased Migration

### Phase 1: Extend Scope (Low Risk)
- Add tree navigation to Scope (`createNext`, `createChild`)
- Add `getSnapshot()` for debug UI compatibility
- Keep StageContext unchanged

### Phase 2: Parallel Support (Medium Risk)
- Update `PipelineRuntime` to support both `rootStageContext` and `rootScope`
- Update `StageRunner` to accept either
- Add feature flag: `useNewScope: boolean`

### Phase 3: Migration (Higher Risk)
- Default to new Scope
- Deprecate StageContext
- Update all tests

### Phase 4: Cleanup
- Remove StageContext
- Remove feature flag
- Update documentation

---

## Files to Modify

| File | Change |
|------|--------|
| `src/scope/Scope.ts` | Add tree navigation, `getSnapshot()` |
| `src/core/memory/PipelineRuntime.ts` | Support `rootScope` alongside `rootStageContext` |
| `src/core/executor/handlers/StageRunner.ts` | Call `startStage()`/`endStage()` |
| `src/core/executor/Pipeline.ts` | Pass recorders to runtime |
| `src/core/builder/FlowChartBuilder.ts` | Add `recorders` option |
| `src/scope/BaseState.ts` | Update to work with Scope |

---

## Open Questions

1. **Should recorders be per-pipeline or per-stage?**
   - Current: Global recorders + stage-level recorders
   - Alternative: Only global, stages filter by name

2. **How to handle ExecutionHistory?**
   - Current: Separate from Scope snapshots
   - Proposal: Scope snapshots replace ExecutionHistory

3. **What about WriteBuffer?**
   - Current: StageContext uses WriteBuffer
   - Scope: Uses local cache + staged writes
   - Need to verify semantics match

---

## Related Documents

- [MEMORY_MODEL.md](./MEMORY_MODEL.md) - Why we use structured memory
- [Scope System README](../../src/scope/README.md) - Current scope architecture
- [Core Memory README](../../src/core/memory/README.md) - StageContext, GlobalStore, PipelineRuntime
- [Internal Memory README](../../src/internal/memory/README.md) - WriteBuffer internals
- [scope-recorder-pattern spec](../../.kiro/specs/scope-recorder-pattern/) - Recorder implementation details
