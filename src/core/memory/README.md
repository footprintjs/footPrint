# Core Memory Module

## Purpose

The core memory module provides the **runtime memory system** for flow execution. It manages the scope that stages read from and write to, providing structured storage with stage namespacing for observability and time-travel debugging.

## Key Concepts

- **Scope**: Runtime memory that stages read from and write to. Think of it like function variables - each stage can access and modify data in scope.

- **ScopeType vs Scope**: ScopeType is the interface (blueprint) defined at build time; Scope is the runtime memory instance (actual data).

- **Stage Namespacing**: Each stage's writes are stored under its own namespace, enabling observability ("which stage wrote what?") and preventing collisions.

- **Schema-Guided Dynamic Memory**: We use a hybrid approach - schemas exist for documentation and IDE autocomplete, but runtime is dynamic (stages can write any key).

## Design Decisions

1. **Structured Memory over Key-Value**: Unlike simple key-value stores, we use structured memory with stage namespacing for:
   - Observability - Know which stage wrote what
   - Time-travel debugging - Reconstruct state at any point
   - Branching - Prevent collisions when parallel branches write same keys

2. **Separation of Concerns**: 
   - `GlobalStore` - Central storage with namespacing
   - `StageContext` - Stage's view of scope (read/write methods)
   - `PipelineRuntime` - Execution context managing GlobalStore lifecycle

3. **Protection Modes**: Configurable protection levels (none, warn, error) to prevent accidental overwrites.

## Files Overview

| File | Purpose |
|------|---------|
| `GlobalStore.ts` | Central storage - holds all scope data with namespacing |
| `StageContext.ts` | Stage's view of scope - provides read/write methods |
| `PipelineRuntime.ts` | Execution context - manages GlobalStore lifecycle |
| `StageMetadata.ts` | Metadata about stage execution (timing, status) |
| `types.ts` | Type definitions |
| `index.ts` | Barrel export |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Core Memory System                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐   │
│  │ StageContext │───▶│  GlobalStore │◀───│PipelineRuntime│  │
│  └──────────────┘    └──────────────┘    └──────────────┘   │
│         │                   │                    │           │
│         │                   │                    │           │
│         ▼                   ▼                    ▼           │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐   │
│  │  getValue()  │    │   Patches    │    │  Snapshots   │   │
│  │  setObject() │    │   History    │    │  Time-travel │   │
│  │  setGlobal() │    │   Namespacing│    │              │   │
│  └──────────────┘    └──────────────┘    └──────────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Usage Example

```typescript
// Reading from scope
const question = scope.getValue([], 'userQuestion');

// Writing to scope (current stage's namespace)
scope.setObject([], 'expandedQuestion', expanded);

// Writing to global (root level)
scope.setGlobal('sharedConfig', config);
```

## Related Modules

- `../../internal/memory/` - Transaction buffer (WriteBuffer) for atomic commits
- `../../internal/history/` - Execution history for time-travel debugging
- `../executor/handlers/SubflowInputMapper.ts` - How subflows get isolated scope
- `../../../docs/architecture/MEMORY_MODEL.md` - Detailed memory model documentation

