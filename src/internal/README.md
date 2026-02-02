# Internal Module

## Purpose

The internal module contains **library implementation details** that are not part of the public API. These modules are used by the core module but should not be imported directly by consumers.

## Key Concepts

- **WriteBuffer**: Transaction buffer that accumulates mutations before commit. Enables atomic state updates and rollback on error.

- **ExecutionHistory**: Immutable history of committed state changes. Enables time-travel debugging and state replay.

## Design Decisions

1. **Separation from Public API**: Internal modules are kept separate to clearly communicate what is stable vs implementation detail.

2. **Re-exports for Backward Compatibility**: Old import paths re-export from here to maintain backward compatibility during migration.

3. **Minimal Surface Area**: Only essential functionality is exposed. Complex logic is encapsulated.

## Files Overview

| Folder | Purpose |
|--------|---------|
| `memory/` | WriteBuffer and utilities for buffered state mutations |
| `history/` | ExecutionHistory for committed state tracking |

## Usage

**DO NOT import directly from internal/**. Use the public API from `src/index.ts` instead.

If you need WriteBuffer or ExecutionHistory, import from the root:
```typescript
import { WriteBuffer, ExecutionHistory } from 'footprint';
```

## Related Modules

- `../core/memory/` - Public memory API (StageContext, GlobalStore)
- `../core/executor/` - Uses internal modules for state management
