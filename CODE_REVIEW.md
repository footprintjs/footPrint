# FootPrint Library - Platform-Level Code Review

**Reviewer**: Platform Engineer
**Date**: 2026-03-05
**Codebase**: ~13,500 lines TypeScript across 65 source files
**Scope**: Full library architecture, design, and implementation review

---

## Executive Summary

FootPrint is a flowchart-based pipeline execution engine with built-in observability, narrative generation, and time-travel debugging. The architecture is well-decomposed with clear separation of concerns. The code quality is generally high, with thorough documentation and consistent patterns. However, there are several platform-level concerns around **dual state management systems**, **constructor parameter sprawl**, **memory safety**, **missing error boundaries**, and **code duplication in subflow execution** that should be addressed before this library is production-hardened.

**Verdict**: Solid foundation with strong design principles. Needs targeted fixes in 5-6 areas before it's production-grade.

---

## 1. Architecture Assessment

### 1.1 Layer Structure (Good)

The 4-layer architecture is clean and well-enforced:

```
src/
  core/       - Public API (builder, executor, memory)
  internal/   - Library internals (WriteBuffer, ExecutionHistory)
  scope/      - Consumer extensibility (BaseState, recorders, providers)
  utils/      - Shared utilities
```

**Positive**: `internal/` is not re-exported from the root index, maintaining proper encapsulation. The barrel exports at each level are well-organized.

### 1.2 Builder-Executor Separation (Good)

The `FlowChartBuilder` (build-time) / `FlowChartExecutor` (run-time) split is a strong design choice. Build-time produces a compiled `FlowChart` object; runtime consumes it. This enables:
- Static analysis of pipeline structure before execution
- Serialization of build-time structure for frontend visualization
- Clear lifecycle boundary

### 1.3 Handler Decomposition (Good)

Extracting `StageRunner`, `NodeResolver`, `ChildrenExecutor`, `SubflowExecutor`, `LoopHandler`, `DeciderHandler`, `SelectorHandler`, `ExtractorRunner`, and `RuntimeStructureManager` from `Pipeline.ts` follows SRP well. Each has a clear, testable responsibility.

---

## 2. Critical Issues

### 2.1 Dual State Management Systems (HIGH PRIORITY)

**Files**: `src/scope/Scope.ts` vs `src/core/memory/StageContext.ts` + `src/internal/memory/WriteBuffer.ts`

There are **two completely independent state management implementations** that serve the same purpose:

| Concern | `Scope.ts` (scope layer) | `StageContext.ts` + `WriteBuffer` (core layer) |
|---------|--------------------------|--------------------------------------------------|
| Read-after-write | `localCache` Map | `WriteBuffer.get()` on `workingCopy` |
| Staged writes | `stagedWrites[]` array | `WriteBuffer.overwritePatch` + `updatePatch` |
| Commit | Manual `finalValues` loop | `WriteBuffer.commit()` atomic bundle |
| Time-travel | `snapshots[]` full copies | `ExecutionHistory.materialise()` from diffs |
| Recorders | Full recorder system | None (uses `StageMetadata` instead) |

**The actual Pipeline execution uses StageContext + WriteBuffer, NOT Scope.ts.** The `Scope` class appears to be an alternative/newer implementation that is **never used in the execution path**. The `ScopeFactory` type signature (`(core: StageContext, ...) => TScope`) feeds a `StageContext` to consumer scope factories, which typically wrap it in `BaseState` - never `Scope`.

**Impact**:
- `Scope.ts` is 847 lines of dead code in the execution path
- Confusion for contributors about which system to use
- Two different time-travel implementations with different trade-offs

**Recommendation**: Either integrate `Scope.ts` as the canonical runtime scope replacing `StageContext`'s read/write methods, or remove it. If it's a planned migration, document it clearly. Currently it introduces cognitive overhead without being used.

### 2.2 WriteBuffer Stale-Read Bug After Commit (HIGH PRIORITY)

**File**: `src/internal/memory/WriteBuffer.ts:140`

```typescript
commit(): { ... } {
  // ...
  // Reset for next stage - defensive programming
  this.workingCopy = structuredClone(this.baseSnapshot);  // <-- BUG
  return payload;
}
```

After `commit()`, the `workingCopy` resets to the **original** `baseSnapshot` from construction time, not the post-commit state. This means:

1. Stage writes `A=1`, commits (applied to GlobalStore)
2. Stage writes `B=2` (workingCopy now has `B=2` but `A` is gone - reverted to baseSnapshot)
3. `buffer.get(['A'])` returns the stale base value, NOT the committed `1`

This is **partially mitigated** because `StageContext.getValue()` falls back to `GlobalStore` when the buffer returns `undefined`. But it's a correctness trap - the comment in `DeciderHandler.ts:346-348` explicitly calls this out as a known bug:

```typescript
// the WriteBuffer has a stale-read bug: after commit() resets the
// buffer's workingCopy to baseSnapshot, getValue reads the stale baseSnapshot
// value from a previous iteration instead of falling through to GlobalStore.
```

**Recommendation**: After commit, reset `baseSnapshot` to the current GlobalStore state (or at minimum, to the post-commit state). This would eliminate an entire class of subtle bugs.

### 2.3 Constructor Parameter Sprawl in Pipeline (HIGH PRIORITY)

**File**: `src/core/executor/Pipeline.ts` (constructor), `src/core/executor/FlowChartExecutor.ts:169-179`

The `Pipeline` constructor takes **15 positional parameters**:

```typescript
constructor(
  root, stageMap, scopeFactory, defaultValuesForContext,
  initialContext, readOnlyContext, throttlingErrorChecker,
  streamHandlers, extractor, scopeProtectionMode,
  subflows, enrichSnapshots, enableNarrative,
  buildTimeStructure, logger
)
```

And `FlowChartExecutor` takes **9 positional parameters**. This leads to call sites like:

```typescript
new FlowChartExecutor(chart, scopeFactory, undefined, undefined, undefined, undefined, undefined, undefined, true);
```

**Impact**: Extremely error-prone, unreadable, and fragile when adding new parameters.

**Recommendation**: Use an options object pattern:

```typescript
interface PipelineOptions<TOut, TScope> {
  root: StageNode<TOut, TScope>;
  stageMap: Map<string, PipelineStageFunction<TOut, TScope>>;
  scopeFactory: ScopeFactory<TScope>;
  // ... remaining fields with sensible defaults
}
```

---

## 3. Design Concerns

### 3.1 Massive Code Duplication in SubflowExecutor (MEDIUM)

**File**: `src/core/executor/handlers/SubflowExecutor.ts`

`SubflowExecutor.executeSubflowInternal()` (lines 398-573) duplicates ~80% of the logic from `Pipeline.executeNode()`:
- Stage function execution with error handling
- Dynamic stage detection (`isStageNodeReturn`)
- Children execution (fork, decider, selector patterns)
- Linear next continuation
- Node resolution

Similarly, `executeNodeChildrenInternal()` (lines 604-639) and `executeSelectedChildrenInternal()` (lines 656-702) duplicate `ChildrenExecutor`'s logic.

**Impact**: Every bug fix or feature in `Pipeline.executeNode()` must be duplicated in `SubflowExecutor`. The two implementations can drift apart silently. The subflow executor is already missing some features (no `RuntimeStructureManager` updates, no break propagation from children to parent).

**Recommendation**: Refactor to have `SubflowExecutor` use the same `executeNode` callback pattern used by `ChildrenExecutor`. The subflow should swap the `PipelineContext` (with its own `PipelineRuntime`) and then delegate to the main `Pipeline.executeNode()`.

### 3.2 Non-Deterministic Parallel Execution with Shared Mutable State (MEDIUM)

**File**: `src/core/executor/handlers/ChildrenExecutor.ts:104-131`

Children execute in parallel via `Promise.allSettled()`, but they all share the **same GlobalStore**. Each child's `commit()` applies patches to the GlobalStore in non-deterministic order (whichever settles first wins).

```typescript
// Child A writes: scope.setValue('count', 1)
// Child B writes: scope.setValue('count', 2)
// Result: whoever commits last wins
```

This is a **last-writer-wins** race condition with no conflict detection.

**Impact**: Parallel children that write to overlapping keys produce non-deterministic results. This is documented implicitly (pipeline-namespaced isolation), but the namespace mechanism (`pipelines/{id}/`) only helps when children have different pipelineIds.

**Recommendation**: Either:
1. Document the constraint explicitly ("parallel children MUST NOT write to the same keys")
2. Add conflict detection that logs a warning when overlapping writes are detected during parallel execution
3. Consider copy-on-write semantics for parallel branches

### 3.3 Memory: Excessive Deep Cloning (MEDIUM)

**File**: `src/internal/memory/WriteBuffer.ts:66-69`

```typescript
constructor(base: any) {
  this.baseSnapshot = structuredClone(base);
  this.workingCopy = structuredClone(base);
}
```

Every `StageContext.getWriteBuffer()` call (lazy, but happens for any read/write) creates **two** `structuredClone()` copies of the entire GlobalStore state. For a 10-stage pipeline with 1MB of state, that's ~20MB of cloning just for the write buffers.

Additionally, `WriteBuffer.commit()` does `structuredClone()` on the patches again, and `applySmartMerge()` does another `structuredClone()` of the base. And `ExecutionHistory.materialise()` does `structuredClone()` and replays all commits.

**Impact**: Linear memory growth with pipeline depth and state size. For AI agent pipelines that accumulate conversation history (which can be large), this will cause significant GC pressure.

**Recommendation**:
- Consider structural sharing (immutable data patterns) instead of full deep clones
- The `WriteBuffer` only needs to clone paths that are actually written to, not the entire state
- Consider using a COW (copy-on-write) proxy for the working copy

### 3.4 Unbounded Loop Execution (MEDIUM)

**File**: `src/core/executor/handlers/LoopHandler.ts`

There is no maximum iteration limit on loops. A dynamic next that always loops back will run forever:

```typescript
// This runs forever with no guard:
const stageFn = (scope) => {
  return { name: 'askLLM', id: 'askLLM', next: { name: 'askLLM', id: 'askLLM' } };
};
```

**Recommendation**: Add a configurable `maxIterations` (default: 100 or 1000) to `LoopHandler`. Throw a clear error when exceeded: `"Maximum loop iterations exceeded for node '${nodeId}'. Set maxIterations to increase the limit."`

### 3.5 Type Safety Gaps (MEDIUM)

**File**: `src/scope/BaseState.ts:91-128`

```typescript
getInitialValueFor(key: string) {
  return (this._stageContext as any).getFromGlobalContext?.(key);
}
// ...
setValue(key: string, value: unknown, shouldRedact?: boolean, description?: string) {
  return (this._stageContext as any).setObject([], key, value, shouldRedact, description);
}
```

Multiple methods cast `this._stageContext` to `any` to access methods that exist on `StageContext` but aren't in the type. These methods (`setObject`, `setGlobal`, `getGlobal`, `setRoot`, `getFromGlobalContext`) are all public on `StageContext` - the `as any` casts are unnecessary and hide type errors.

**Impact**: Breakage when `StageContext` API changes won't be caught at compile time.

**Recommendation**: Remove all `as any` casts in `BaseState.ts`. The methods already exist on `StageContext`.

### 3.6 Inconsistent Error Handling in SubflowExecutor Output Mapping (LOW-MEDIUM)

**File**: `src/core/executor/handlers/SubflowExecutor.ts:295-321`

Output mapping errors are silently swallowed:

```typescript
} catch (error: any) {
  parentContext.addError('outputMapperError', error.toString());
  this.ctx.logger.error(`Error in outputMapper for subflow (${subflowId}):`, { error });
  // Don't re-throw - output mapping errors are non-fatal
}
```

But input mapping errors ARE re-thrown (line 196-198). This asymmetry is confusing. If the output mapper fails, the parent flow continues with stale data, potentially causing silent data loss.

**Recommendation**: Either make both fatal or both non-fatal with configurable behavior. At minimum, document the asymmetry clearly.

---

## 4. Code Quality Observations

### 4.1 Excellent Documentation (Positive)

Every file has a clear header explaining WHY, DESIGN DECISIONS, RESPONSIBILITIES, and RELATED modules. The `WHY` annotations on individual code blocks are particularly valuable. This is best-in-class internal documentation.

### 4.2 Null Object Pattern for NarrativeGenerator (Positive)

The `NullNarrativeGenerator` is a textbook application of the Null Object pattern. Zero branching in handlers, zero cost when disabled. Well done.

### 4.3 Consistent Module Structure (Positive)

Every module follows the same pattern: header comment, imports, types, class, exports. Barrel exports are consistent. The `PipelineContext` interface for dependency injection across handlers eliminates circular dependencies cleanly.

### 4.4 `console.warn` in RuntimeStructureManager (LOW)

**File**: `src/core/executor/handlers/RuntimeStructureManager.ts:150-155`

```typescript
// eslint-disable-next-line no-console
console.warn(
  `[RuntimeStructureManager] updateDynamicChildren: parent "${parentNodeId}" not found`,
);
```

Three places in this file use `console.warn` directly instead of `this.ctx.logger.warn()`. This is because `RuntimeStructureManager` doesn't receive a logger instance.

**Recommendation**: Pass `ILogger` to `RuntimeStructureManager` constructor.

### 4.5 FlowChartBuilder `FlowChart` Type Duplication (LOW)

The `FlowChart` type is defined in **two places**:
- `src/core/builder/FlowChartBuilder.ts:166-190`
- `src/core/executor/FlowChartExecutor.ts:38-88`

These have different fields (builder version has `description`, `stageDescriptions`; executor version has `enrichSnapshots`). This creates confusion about which is the canonical type.

**Recommendation**: Define one canonical `FlowChart` type in a shared types file and import it in both places.

### 4.6 lodash Individual Imports (Positive)

Using individual lodash imports (`lodash.get`, `lodash.set`, etc.) instead of the full lodash is good for bundle size. However, consider that modern bundlers tree-shake `lodash-es` effectively, and the individual packages are less maintained.

---

## 5. Dependency and Build Concerns

### 5.1 Outdated Dev Dependencies (LOW)

Several devDependencies are significantly outdated:
- `eslint: ^8.44.0` (current: v9.x, flat config)
- `@typescript-eslint/*: ^5.61.0` (current: v8.x)
- `eslint-config-standard: ^17.0.0` (deprecated in favor of `eslint-config-standard` for v9)
- `prettier: ^2.8.1` (current: v3.x)

**Impact**: Missing newer lint rules, incompatibility with newer tooling.

### 5.2 Zod v4 Dependency (NOTE)

```json
"zod": "^4.0.16"
```

Zod v4 is relatively new. Ensure the zod integration (`src/scope/state/zod/`) is stable and tested against this version.

### 5.3 Coverage Thresholds (OBSERVATION)

```json
"coverageThreshold": {
  "global": {
    "statements": 65,
    "branches": 52,
    "functions": 64,
    "lines": 71
  }
}
```

52% branch coverage is low for a library that manages execution state. The `WriteBuffer`, `StageContext`, and `SubflowExecutor` modules in particular need higher coverage given the stale-read bug and race condition risks identified above.

---

## 6. Security Review

### 6.1 Prototype Pollution Protection (Positive)

`src/internal/memory/utils.ts:128-139`:

```typescript
if (node !== null && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, field)) {
  return node[field];
}
```

The `getNestedValue` function correctly guards against prototype pollution by checking `hasOwnProperty`. Good.

### 6.2 Scope Protection Proxy (Positive)

`src/scope/protection/createProtectedScope.ts` provides a Proxy-based guard against accidental direct property assignment. The allowlist for internal properties is reasonable.

### 6.3 Redaction Support (Positive)

The `shouldRedact` flag on write operations and the `redactPatch` utility properly handle sensitive data in debug output.

---

## 7. Priority Recommendations

| Priority | Issue | Effort | Impact |
|----------|-------|--------|--------|
| P0 | Fix WriteBuffer stale-read after commit | S | Eliminates known bug class |
| P0 | Resolve dual state management (Scope vs StageContext) | M | Reduces confusion, dead code |
| P1 | Refactor constructor parameter sprawl to options object | M | API usability, maintainability |
| P1 | Add max iteration limit to LoopHandler | S | Prevents infinite loops |
| P1 | Reduce SubflowExecutor code duplication | L | Maintainability |
| P2 | Add parallel write conflict detection | M | Prevents silent data corruption |
| P2 | Remove `as any` casts in BaseState | S | Type safety |
| P2 | Optimize deep cloning in WriteBuffer | M | Memory/performance |
| P3 | Unify FlowChart type definition | S | Code clarity |
| P3 | Pass logger to RuntimeStructureManager | S | Logging consistency |
| P3 | Update dev dependencies | S | Tooling currency |

**S** = Small (< 1 day), **M** = Medium (1-3 days), **L** = Large (3-5 days)

---

## 8. Summary

FootPrint has a **thoughtful, well-documented architecture** with strong design patterns (Null Object, Builder, Strategy via PipelineContext DI). The handler decomposition and narrative generation system show careful engineering.

The main risks are:
1. **The WriteBuffer stale-read bug** is a ticking time bomb acknowledged in comments but not fixed
2. **The dual state system** (Scope.ts vs StageContext+WriteBuffer) adds ~850 lines of confusion
3. **SubflowExecutor's duplicated execution logic** will inevitably drift from Pipeline.ts
4. **No loop guards** means a production infinite loop is one dynamic next away

Fix these four issues, and the library is in very strong shape for production use.

---

## 9. Deep Dive: Memory Architecture & The Scope/Pipeline Disconnection

This section provides line-by-line analysis of the three-layer memory system and the critical architectural gap between the Scope+Recorder system and the Pipeline+StageContext execution path.

### 9.1 The Three Memory Layers — What Works Well

**GlobalStore** (`src/core/memory/GlobalStore.ts`)

The GlobalStore is well-designed as a single source of truth. Specific observations:

- **Line 41-47**: The `mergeWith` constructor logic correctly handles defaults vs initial context. The merge callback (`typeof objValue === 'undefined' ? srcValue : objValue`) ensures existing values survive, which is the right semantic for "defaults are overridable."
- **Line 89-93**: The `getValue` fallback chain (pipeline-scoped → global) is clean. It means any pipeline can read global state that wasn't explicitly set in its namespace. This is a good design for shared configuration (e.g., API keys, model settings) without copy overhead.
- **Line 99-101**: `getState()` returns the raw `this.context` object — no clone. This is intentional for performance but means any consumer holding a reference sees mutations in real-time. The code relies on this being read-only in practice. Consider `Object.freeze` in dev mode for safety, or document the contract explicitly.

**WriteBuffer** (`src/internal/memory/WriteBuffer.ts`)

- **Line 56-63**: The two-patch-bucket design (`overwritePatch` + `updatePatch`) with a chronological `opTrace` is clever. It allows `applySmartMerge` to replay operations in order while maintaining type semantics (set vs merge). This is essentially a WAL (write-ahead log) pattern from databases.
- **Line 79-86**: The `set()` method correctly clones values going into the overwrite patch (`structuredClone(value)`) to prevent aliasing. Good defensive programming.
- **Line 97-106**: The `merge()` method accumulates into `updatePatch` via `deepSmartMerge`, meaning multiple merges to the same path within a single buffer lifecycle produce the correct cumulative result. This is the right behavior.
- **Line 155-174**: The `deepSmartMerge` function has a subtle behavior worth noting: array union uses `Set` which means `[{a:1}, {a:1}]` would NOT deduplicate objects (since object identity differs). This is correct for most cases but could surprise users merging arrays of objects. Document this.

**StageContext** (`src/core/memory/StageContext.ts`)

- **Line 99-104**: Lazy WriteBuffer creation (`getWriteBuffer()`) is a good optimization — stages that only read pay zero cost. But there's a subtlety: once created, the WriteBuffer snapshots the **current** GlobalStore state. If two stages run sequentially and the first commits before the second creates its buffer, the second will see committed changes. If the buffer was created before the first commits, it sees stale state. The execution model handles this correctly (commit → then create next context), but it's fragile.
- **Line 139-159**: The `commit()` method does three things: (1) applies patches to GlobalStore, (2) redacts and records to ExecutionHistory, (3) logs write trace to debug. This is well-structured. However, note that the `commit()` doesn't clear the WriteBuffer — the buffer's own `commit()` method handles that. This two-level commit (StageContext.commit → WriteBuffer.commit → GlobalStore.applyPatch) is correct but adds one level of indirection that could confuse new contributors.

**ExecutionHistory** (`src/internal/history/ExecutionHistory.ts`)

- **Line 76-83**: The `materialise()` method replays all commits up to `stepIdx` — O(n) time complexity. The comment says "memory footprint stays < 100KB for typical pipelines" which assumes small state objects. For AI agent pipelines with full conversation histories (easily 50KB+ per step), this assumption breaks. Consider a checkpoint strategy: store full snapshots every N commits and replay only the tail.
- **Line 91-95**: The `record()` method mutates the bundle's `idx` in place (`bundle.idx = this.steps.length`). This mutates the caller's object, which is a side-effect. Defensively copy the bundle or document that it's mutated.

### 9.2 The Disconnection: Scope + Recorders vs Pipeline + StageContext

This is the central architectural issue. There are two completely parallel state management paths:

```
Path A (Pipeline execution):
  FlowChartExecutor → Pipeline → StageRunner → ScopeFactory(StageContext) → BaseState
    ↓ writes go to ↓
  StageContext → WriteBuffer → GlobalStore
    ↓ observability via ↓
  StageMetadata (logs, errors, metrics, flowMessages)
  ExecutionHistory (commit bundles for time-travel)

Path B (Scope standalone):
  new Scope({ globalStore, pipelineId, stageName }) → Scope
    ↓ writes go to ↓
  Scope.stagedWrites[] → localCache → GlobalStore.setValue()
    ↓ observability via ↓
  Recorder hooks (onRead, onWrite, onCommit, onStageStart, onStageEnd)
  Scope.snapshots[] (full-state snapshots for time-travel)
```

**These paths never intersect.** Here's why:

1. **`ScopeFactory` signature** (`src/core/memory/types.ts:10`): `(core: StageContext, stageName: string, readOnlyContext?: unknown) => TScope`. The factory receives a `StageContext`, not a `Scope`. The typical consumer wraps it in `BaseState`.

2. **`BaseState`** (`src/scope/BaseState.ts:94-107`): Delegates `getValue`, `setValue`, `updateValue` to `StageContext` methods. No `Scope` involved. No recorder hooks fire.

3. **`Scope` is not exported from the public API** (`src/index.ts`): `Scope` class is absent from the barrel exports. Only `NarrativeRecorder` (and its types) are exported from the recorder system. `DebugRecorder` and `MetricRecorder` aren't even exported!

4. **Pipeline never creates a `Scope`** (`src/core/executor/handlers/StageRunner.ts:85`): `const rawScope = this.ctx.ScopeFactory(context, node.name, ...)` — passes `StageContext` to the factory. The result is whatever the consumer's factory returns (typically `BaseState` subclass or the raw `StageContext` itself).

### 9.3 Line-by-Line: Where Scope.ts Diverges from StageContext

**Scope.ts commit vs StageContext commit — different algorithms**:

`Scope.commit()` (lines 353-421):
```
1. Builds a Map<cacheKey, {key, value}> from stagedWrites
2. For 'update' operations: deep-merges with existing (from finalValues or GlobalStore)
3. Calls GlobalStore.setValue() for each final value individually
4. Creates a full-state snapshot via createSnapshot()
5. Invokes onCommit hook
6. Clears stagedWrites[] and localCache
```

`StageContext.commit()` (lines 139-159):
```
1. Gets commit bundle from WriteBuffer.commit() (patches + trace)
2. Calls GlobalStore.applyPatch() with overwrite + updates + trace (single atomic operation)
3. Redacts sensitive paths
4. Records to ExecutionHistory
5. Logs writeTrace to debug metadata
```

**Key differences**:
- Scope applies individual `setValue()` calls — NOT atomic. If it fails mid-way, partial writes persist.
- StageContext applies a single `applyPatch()` — atomic via trace replay.
- Scope stores full-state snapshots (expensive). StageContext stores diff bundles (cheap, replay needed).
- Scope fires recorder hooks. StageContext records to ExecutionHistory.

**Scope.ts deep merge vs WriteBuffer deep merge — subtly different semantics**:

`Scope.deepMerge()` (line 40-65): Array union via `new Set()`.
`WriteBuffer.deepSmartMerge()` (line 155-174): Array union via `new Set()`.

These happen to be identical today, but they're separate implementations. If one changes, the other won't. This is a DRY violation that will eventually cause a divergence bug.

### 9.4 Recorder System — Well-Designed but Orphaned

The Recorder interface (`src/scope/types.ts:160-224`) is a clean observer pattern:

- **All hooks optional**: Allows partial implementations (e.g., MetricRecorder doesn't need onError)
- **Error isolation** (Scope.ts:759-783): Recorder errors don't break scope operations. Errors are forwarded to `onError` hooks on other recorders. This is production-grade resilience.
- **Stage-level scoping**: `attachStageRecorder()` allows targeted observation per stage without global noise. Smart design.

The three recorder implementations are solid:

- **MetricRecorder**: Clean, minimal overhead per-hook. The `getMetrics()` aggregation is O(stages), which is fine. One note: `stageStartTimes` uses a `Map<string, number>` keyed by stage name, which means re-entrant stages (loops) will overwrite the start time. For loops, duration tracking gives you the LAST iteration's time, not cumulative. This may be surprising.

- **DebugRecorder**: Verbosity toggle is clean. Stores full event payloads in the `data` field which means it holds references to potentially large values (entire LLM responses). Consider storing summarized values like NarrativeRecorder does.

- **NarrativeRecorder**: The best-designed of the three. `summarizeValue()` (lines 457-486) is smart about token budget — truncates strings, shows array lengths, shows object key counts. The interleaved `operations[]` timeline with `stepNumber` is well-thought-out for debugging.

**But none of this fires during actual pipeline execution.** That's the problem.

### 9.5 Bridging Strategy — Concrete Recommendation

The cleanest bridge would be to make `BaseState` (which IS used during pipeline execution) optionally fire recorder hooks. Here's the minimal change:

**Option A: Add recorder support to BaseState (Minimal, ~50 LOC)**

```typescript
// In BaseState constructor:
constructor(context: StageContext, stageName: string, readOnlyValues?: unknown, recorders?: Recorder[]) {
  // ... existing code ...
  this._recorders = recorders ?? [];
}

// In BaseState.getValue():
getValue(key?: string) {
  const value = this._stageContext.getValue([], key);
  for (const r of this._recorders) {
    r.onRead?.({ stageName: this._stageName, pipelineId: this.getPipelineId(), timestamp: Date.now(), key, value });
  }
  return value;
}
```

This preserves the existing StageContext+WriteBuffer execution path (which is correct and battle-tested) while enabling recorders to observe operations. The ScopeFactory can pass recorders through when creating BaseState instances.

**Option B: Wrap StageContext in Scope (Medium, ~100 LOC)**

Create a `ScopeFactory` that wraps `StageContext` in a `Scope` instance which delegates to `StageContext` for actual I/O but fires recorder hooks. This requires making `Scope` use `StageContext` as its backing store instead of its own `stagedWrites[]` + `localCache`.

**Option C: Add recorder hooks directly to StageContext (Largest change)**

This would make StageContext aware of recorders. It's the most integrated but changes the core layer, which affects all consumers.

**My recommendation: Option A.** It's additive, doesn't change the proven execution path, and enables the full recorder ecosystem with minimal risk.

### 9.6 What Should Be Removed

If Option A is adopted, `Scope.ts` can be kept as a standalone utility (for users who want a simpler API without Pipeline), but the following should happen:

1. **Export it** from `src/index.ts` if it's intended for consumer use, or **delete it** if it's dead code
2. **Export DebugRecorder and MetricRecorder** from `src/index.ts` — they're currently not exported, which means consumers can't use them even with Scope
3. **Delete the duplicate `deepMerge`** in `Scope.ts` and import the one from `WriteBuffer.ts`, or extract both to a shared utility
4. **Remove the time-travel snapshots** from Scope.ts (`createSnapshot`, `getSnapshots`, `getStateAt`, `getCurrentSnapshotIndex`) — this duplicates ExecutionHistory with worse performance characteristics (full snapshots vs diff replay)

### 9.7 Summary Table

| Component | Status | Verdict |
|-----------|--------|---------|
| GlobalStore | Used in production path | Keep as-is |
| WriteBuffer | Used in production path, has stale-read bug | Fix the bug (Section 2.2) |
| StageContext | Used in production path, no recorder hooks | Add recorder bridge via BaseState |
| ExecutionHistory | Used in production path | Keep, add checkpoint strategy for large state |
| PipelineRuntime | Used in production path | Keep as-is |
| Scope.ts | NOT used in production path | Either integrate as BaseState's backing store or delete |
| Recorder interface | Well-designed, orphaned | Bridge to BaseState (Option A) |
| DebugRecorder | Not exported, orphaned | Export or delete |
| MetricRecorder | Not exported, orphaned | Export or delete |
| NarrativeRecorder | Exported but only works with Scope | Bridge to BaseState |
| BaseState | Used in production path, no recorder hooks | Add optional recorder support |
| StageMetadata | Used in production path | Keep, this serves a different purpose (debug metadata vs data-level observability) |
