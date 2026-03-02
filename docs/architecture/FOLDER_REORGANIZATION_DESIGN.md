# Folder Reorganization Design Document

This document captures the architectural analysis and design decisions for reorganizing the TreeOfFunctionsLib folder structure.

## Current State Analysis

### Current Folder Structure

```
src/
├── builder/
│   └── FlowChartBuilder.ts          # Build-time DSL for defining flows
├── core/
│   ├── context/                      # Memory management layer
│   │   ├── GlobalStore.ts            # Shared state container (heap)
│   │   ├── PipelineRuntime.ts        # Top-level runtime container
│   │   ├── StageContext.ts           # Per-stage memory engineer
│   │   ├── StageMetadata.ts          # Debug/error/metric collector
│   │   ├── scopeLog.ts               # Console logging utility
│   │   └── types.ts                  # ScopeFactory type
│   ├── logger/
│   │   └── index.ts                  # Simple logger
│   ├── pipeline/                     # Runtime execution engine
│   │   ├── GraphTraverser.ts         # Main Pipeline class + StageNode types
│   │   ├── FlowChartExecutor.ts      # Public API wrapper
│   │   ├── StageRunner.ts            # Single stage execution
│   │   ├── NodeResolver.ts           # Node lookup + subflow resolution
│   │   ├── ChildrenExecutor.ts       # Parallel children execution
│   │   ├── SubflowExecutor.ts        # Subflow execution with isolation
│   │   ├── LoopHandler.ts            # Loop/dynamic next handling
│   │   ├── DeciderHandler.ts         # Decider evaluation
│   │   ├── SubflowInputMapper.ts     # Input/output mapping for subflows
│   │   └── types.ts                  # All pipeline types
│   └── stateManagement/              # Write buffer + history
│       ├── WriteBuffer.ts            # Transaction buffer for mutations
│       ├── ExecutionHistory.ts       # Time-travel snapshot storage
│       └── utils.ts                  # Patch utilities
└── scope/
    ├── Scope.ts                      # Structured memory with recorders
    ├── types.ts                      # Recorder interface + event types
    ├── index.ts                      # Barrel export
    ├── core/                         # Consumer-facing scope classes
    │   ├── BaseState.ts              # Base class consumers extend
    │   ├── baseStateCompatible.ts    # Compatibility helpers
    │   ├── guards.ts                 # Type guards
    │   ├── providers.ts              # Scope providers
    │   ├── registry.ts               # Provider registry
    │   ├── resolve.ts                # Provider resolution
    │   └── types.ts                  # StageContextLike, ScopeFactory
    ├── protection/                   # Proxy-based scope protection
    │   ├── createProtectedScope.ts   # Protection implementation
    │   ├── index.ts                  # Barrel export
    │   └── types.ts                  # Protection types
    ├── recorders/                    # Pluggable observability
    │   ├── MetricRecorder.ts         # Production metrics
    │   ├── DebugRecorder.ts          # Development debugging
    │   └── index.ts                  # Barrel export
    └── state/                        # Schema-backed scopes (future)
        ├── installResolvers.ts
        └── zod/                      # Zod integration
```

---

## Key Finding 1: Two Distinct Layers

The codebase has two clearly separated layers:

### Engine Layer (Internal)
- **StageContext**: Memory engineer - creates execution tree, manages namespacing, handles commits
- **GlobalStore**: The actual heap - holds all state
- **WriteBuffer**: Transaction buffer for atomic commits
- **ExecutionHistory**: Time-travel snapshot storage
- **Pipeline/GraphTraverser**: Execution engine that traverses the flow graph

### Consumer Layer (Public API)
- **FlowChartBuilder**: DSL for defining flows at build time
- **FlowChartExecutor**: Public API for running flows
- **BaseState**: Base class consumers extend for typed scopes
- **Scope + Recorders**: Structured memory with pluggable observability

**Key Insight**: Consumers never directly instantiate StageContext. They work with BaseState/custom scopes that wrap it via ScopeFactory.

---

## Key Finding 2: ScopeFactory Bridge Pattern

The library uses a bridge pattern to connect engine and consumer layers:

```typescript
// Engine creates StageContext
const context = new StageContext(pipelineId, stageName, globalStore, ...);

// ScopeFactory (provided by app) converts to consumer scope
const scope = scopeFactory(context, stageName, readOnlyContext);

// Stage function receives consumer scope
await stageFunc(scope, breakFn, streamCallback);
```

**Implication**: The library doesn't need changes for new Scope + Recorders. The app owns ScopeFactory and decides what to return.

---

## Key Finding 3: Import Dependency Graph

Critical import relationships that constrain reorganization:

```
FlowChartBuilder
    └── imports from: core/pipeline/types, core/pipeline/GraphTraverser, scope/protection

FlowChartExecutor
    └── imports from: core/pipeline/GraphTraverser, core/context/types

Pipeline (GraphTraverser)
    └── imports from: core/context/*, core/stateManagement/*, scope/protection

StageRunner
    └── imports from: core/context/StageContext, scope/protection

BaseState
    └── imports from: core/context/StageContext, core/context/scopeLog

Scope (new)
    └── imports from: core/stateManagement/WriteBuffer, core/context/GlobalStore
```

**Challenge**: Moving files requires updating all import paths. Need to maintain backward compatibility.

---

## Key Finding 4: Public API Surface

From `src/index.ts`, the public API includes:

**Build-time (FlowChartBuilder)**:
- `flowChart()`, `FlowChartBuilder`, `FlowChart`, `FlowChartSpec`
- `DeciderList`, `SelectorList`
- `specToStageNode()`

**Runtime (Execution)**:
- `FlowChartExecutor`
- `Pipeline`, `StageNode`, `Decider`, `Selector`

**Memory/Context**:
- `StageContext`, `PipelineRuntime`, `GlobalStore`
- `WriteBuffer`, `ExecutionHistory`
- `StageMetadata`

**Scope (Consumer)**:
- `BaseState`
- `createProtectedScope`
- `Scope`, `Recorder`, `MetricRecorder`, `DebugRecorder`

**Types**:
- `ScopeFactory`, `PipelineStageFunction`, `StreamHandlers`
- `SubflowResult`, `RuntimeStructureMetadata`, `TraversalExtractor`

---

## Key Finding 5: Test Structure Mirrors Source

```
test/
├── builder/           # FlowChartBuilder tests
├── core/
│   ├── context/       # StageContext, GlobalStore tests
│   ├── pipeline/      # Pipeline, handlers tests
│   └── stateManagement/  # WriteBuffer, ExecutionHistory tests
└── scope/
    ├── core/          # BaseState tests
    ├── protection/    # Protection tests
    └── recorders/     # MetricRecorder, DebugRecorder tests
```

**Implication**: Folder reorganization must update both src/ and test/ in parallel.

---

## Proposed Folder Structure

Based on the analysis, here's the proposed reorganization:

```
src/
├── core/                             # PUBLIC API (what consumers import)
│   ├── builder/                      # Build-time: Define flows
│   │   └── FlowChartBuilder.ts
│   ├── memory/                       # Memory management
│   │   ├── StageContext.ts
│   │   ├── GlobalStore.ts
│   │   ├── PipelineRuntime.ts
│   │   └── StageMetadata.ts
│   └── executor/                     # Runtime: Execute flows
│       ├── FlowChartExecutor.ts
│       ├── Pipeline.ts               # (renamed from GraphTraverser)
│       └── handlers/                 # Node type handlers
│           ├── StageRunner.ts
│           ├── NodeResolver.ts
│           ├── ChildrenExecutor.ts
│           ├── SubflowExecutor.ts
│           ├── LoopHandler.ts
│           ├── DeciderHandler.ts
│           └── SubflowInputMapper.ts
│
├── internal/                         # PRIVATE: Library internals
│   ├── memory/
│   │   ├── WriteBuffer.ts
│   │   └── utils.ts
│   └── history/
│       └── ExecutionHistory.ts
│
├── scope/                            # CONSUMER: Scope implementations
│   ├── Scope.ts                      # Core Scope with recorders
│   ├── BaseState.ts                  # Legacy base class
│   ├── protection/                   # Proxy protection
│   │   └── createProtectedScope.ts
│   ├── recorders/                    # Pluggable observability
│   │   ├── MetricRecorder.ts
│   │   └── DebugRecorder.ts
│   ├── providers/                    # Scope providers
│   │   ├── registry.ts
│   │   └── resolve.ts
│   └── types.ts                      # Scope types
│
├── plugins/                          # EXTENSIBILITY (future)
│
├── utils/                            # SHARED: Utilities
│   ├── logger.ts
│   └── scopeLog.ts
│
└── index.ts                          # Root barrel (re-exports)
```

---

## Test Structure

Tests are organized into three categories:

```
test/
├── unit/                                    # 1. UNIT TESTS (mirrors src/)
│   ├── core/
│   │   ├── builder/
│   │   │   ├── FlowChartBuilder.test.ts
│   │   │   └── scenarios/                   # Builder-specific scenarios
│   │   │       └── subflow-options.test.ts
│   │   │
│   │   ├── memory/
│   │   │   ├── StageContext.test.ts
│   │   │   ├── GlobalStore.test.ts
│   │   │   └── scenarios/                   # Memory-specific scenarios
│   │   │       └── context-lifecycle.test.ts
│   │   │
│   │   └── executor/
│   │       ├── FlowChartExecutor.test.ts
│   │       ├── Pipeline.test.ts
│   │       ├── handlers/
│   │       │   ├── StageRunner.test.ts
│   │       │   ├── NodeResolver.test.ts
│   │       │   ├── ChildrenExecutor.test.ts
│   │       │   ├── SubflowExecutor.test.ts
│   │       │   ├── LoopHandler.test.ts
│   │       │   ├── DeciderHandler.test.ts
│   │       │   └── SubflowInputMapper.test.ts
│   │       └── scenarios/                   # Executor-specific scenarios
│   │           └── handler-composition.test.ts
│   │
│   ├── internal/
│   │   ├── memory/
│   │   │   ├── WriteBuffer.test.ts
│   │   │   └── utils.test.ts
│   │   └── history/
│   │       └── ExecutionHistory.test.ts
│   │
│   └── scope/
│       ├── Scope.test.ts
│       ├── BaseState.test.ts
│       ├── recorders/
│       │   ├── MetricRecorder.test.ts
│       │   └── DebugRecorder.test.ts
│       ├── protection/
│       │   └── createProtectedScope.test.ts
│       └── scenarios/                       # Scope-specific scenarios
│           └── recorder-composition.test.ts
│
├── scenarios/                               # 2. CROSS-FOLDER SCENARIOS
│   ├── subflow-with-scope/                  # Tests executor + scope together
│   │   └── subflow-scope-isolation.test.ts
│   ├── memory-with-history/                 # Tests memory + internal/history
│   │   └── time-travel.test.ts
│   └── end-to-end/                          # Full pipeline: builder + executor + scope
│       └── full-pipeline.test.ts
│
└── properties/                              # 3. PROPERTY-BASED TESTS
    ├── FlowChartBuilder.property.test.ts
    ├── FlowChartBuilderSimplified.property.test.ts
    ├── RuntimeStructureMetadata.property.test.ts
    ├── Phase2Handlers.property.test.ts
    ├── ModuleComposition.property.test.ts
    ├── SubflowInputMapper.property.test.ts
    ├── Scope.property.test.ts
    ├── MetricRecorder.property.test.ts
    ├── DebugRecorder.property.test.ts
    └── ConsumerRecorder.property.test.ts
```

**Key Rule**: Folder-specific scenario tests stay in their folder's `scenarios/` subfolder. Only cross-folder scenarios go to `test/scenarios/`.

---

## Migration Challenges

### Challenge 1: Circular Dependencies

Current circular dependency risk:
- `Pipeline` imports `StageContext`
- `StageContext` imports `WriteBuffer`
- `WriteBuffer` is standalone (good)

**Solution**: Keep memory/ and executor/ separate. Use types.ts for shared interfaces.

### Challenge 2: Backward Compatibility

Many consumers import from current paths:
```typescript
import { StageContext } from 'tree-of-functions-lib/core/context/StageContext';
```

**Solution**: 
1. Keep old paths working via re-exports
2. Add deprecation warnings
3. Remove in next major version

### Challenge 3: Test File Updates

Every test file has imports that need updating.

**Solution**: 
1. Update test imports in same PR as source moves
2. Use find-and-replace for bulk updates
3. Run full test suite after each batch

### Challenge 4: Documentation Updates

README files, architecture docs, and code comments reference current paths.

**Solution**: Update docs as part of the migration PR.

---

## Migration Strategy

### Phase 1: Create New Structure (Non-Breaking)
1. Create new folders: `core/`, `internal/`, `utils/`
2. Add barrel exports that re-export from old locations
3. No file moves yet - just new entry points

### Phase 2-3: Move Internal Files
1. Move `core/stateManagement/WriteBuffer.ts` → `internal/memory/WriteBuffer.ts`
2. Move `core/stateManagement/utils.ts` → `internal/memory/utils.ts`
3. Move `core/stateManagement/ExecutionHistory.ts` → `internal/history/ExecutionHistory.ts`
4. Update internal imports
5. Add re-exports from old paths

### Phase 4-5: Move Core Memory and Utils
1. Move `core/context/` → `core/memory/`
2. Move `core/logger/` → `utils/`
3. Move `core/context/scopeLog.ts` → `utils/`
4. Update imports

### Phase 6-7: Move Core Executor and Builder
1. Move `core/pipeline/` → `core/executor/`
2. Move handlers to `core/executor/handlers/`
3. Move `builder/` → `core/builder/`
4. Update imports

### Phase 8: Consolidate Scope
1. Move `scope/core/BaseState.ts` → `scope/BaseState.ts`
2. Flatten `scope/core/` into `scope/providers/`
3. Update imports

### Phase 9: Reorganize Tests
1. Create `test/scenarios/` for integration tests
2. Create `test/properties/` for property-based tests
3. Move tests to appropriate categories

### Phase 10-11: Update Exports and Documentation
1. Update `src/index.ts`
2. Add deprecation warnings
3. Update all documentation

### Phase 12: Final Verification
1. Run full test suite
2. Verify build
3. Check for circular dependencies

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Breaking consumer imports | High | Re-export from old paths |
| Test failures | Medium | Run tests after each batch |
| Circular dependencies | Medium | Careful import ordering |
| Documentation drift | Low | Update docs in same PR |

---

## Success Criteria

1. ✅ All tests pass after reorganization
2. ✅ No breaking changes to public API
3. ✅ Clear separation between core/, internal/, scope/
4. ✅ Reduced cognitive load for new contributors
5. ✅ Documentation updated to reflect new structure

---

## Current State (After Reorganization)

The reorganization has been completed. The current folder structure is:

```
src/
├── core/                             # PUBLIC API
│   ├── builder/                      # (planned - FlowChartBuilder still in src/builder/)
│   ├── memory/                       # ✅ StageContext, GlobalStore, PipelineRuntime, StageMetadata
│   ├── executor/                     # ✅ FlowChartExecutor, Pipeline
│   │   └── handlers/                 # ✅ StageRunner, NodeResolver, handlers
│   ├── context/                      # Deprecated re-exports → core/memory/
│   ├── pipeline/                     # Deprecated re-exports → core/executor/
│   └── index.ts                      # Barrel export
│
├── internal/                         # ✅ PRIVATE: Library internals
│   ├── memory/                       # ✅ WriteBuffer, utils
│   └── history/                      # ✅ ExecutionHistory
│
├── scope/                            # ✅ CONSUMER: Scope implementations
│   ├── Scope.ts
│   ├── BaseState.ts                  # ✅ Moved from scope/core/
│   ├── providers/                    # ✅ registry, resolve, guards, providers
│   ├── protection/
│   ├── recorders/
│   └── types.ts
│
├── utils/                            # ✅ SHARED: Utilities
│   ├── logger.ts
│   └── scopeLog.ts
│
├── builder/                          # FlowChartBuilder (not yet moved to core/builder/)
│
└── index.ts                          # Root barrel

test/
├── unit/                             # ✅ Unit tests mirroring src/
│   ├── core/
│   │   ├── builder/
│   │   ├── memory/
│   │   └── executor/
│   ├── internal/
│   │   └── memory/
│   └── scope/
│       ├── providers/
│       ├── recorders/
│       └── state/
├── properties/                       # ✅ Property-based tests
└── scenarios/                        # ✅ Cross-module integration tests
```

### Backward Compatibility

All old import paths continue to work via re-exports with `@deprecated` JSDoc comments:
- `src/core/context/*` → re-exports from `src/core/memory/*`
- `src/core/pipeline/*` → re-exports from `src/core/executor/*`
- `src/core/stateManagement/*` → re-exports from `src/internal/memory/*`
- `src/scope/core/*` → re-exports from `src/scope/providers/*` and `src/scope/BaseState.ts`

---

## Related Documents

- [MEMORY_MODEL.md](./MEMORY_MODEL.md) - Why we use structured memory
- [SCOPE_INTEGRATION_PROPOSAL.md](./SCOPE_INTEGRATION_PROPOSAL.md) - Scope + Recorders design
