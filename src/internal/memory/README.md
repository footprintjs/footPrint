# Internal Memory Module

## Purpose

The internal memory module provides the **transaction buffer** for accumulating state mutations before they are committed. This enables atomic updates, rollback on error, and efficient batching of writes.

## Key Concepts

- **WriteBuffer**: Accumulates mutations (patches) during stage execution. On commit, patches are applied atomically to the global store.

- **MemoryPatch**: A single mutation operation (set, update, delete) with path, key, value, and metadata.

- **Buffered Writes**: Mutations are not immediately visible. They become visible only after commit, enabling isolation between stages.

## Design Decisions

1. **Patch-Based Mutations**: Instead of direct object mutation, we record patches. This enables:
   - Atomic commits (all-or-nothing)
   - Rollback on error
   - History tracking for time-travel

2. **Path-Based Addressing**: Values are addressed by `[path, key]` pairs, enabling nested object structures without deep cloning.

3. **Redaction Support**: Patches can be marked as redacted for sensitive data that shouldn't appear in debug output.

## Files Overview

| File | Purpose |
|------|---------|
| `WriteBuffer.ts` | Transaction buffer for accumulating mutations |
| `utils.ts` | Utility functions for path manipulation |
| `index.ts` | Barrel export |

## Usage Example

```typescript
import { WriteBuffer } from './WriteBuffer';

const buffer = new WriteBuffer();

// Accumulate mutations
buffer.set(['user'], 'name', 'Alice');
buffer.set(['user'], 'age', 30);

// Get pending patches
const patches = buffer.getPatches();

// Commit patches to global store
globalStore.applyPatches(patches);
buffer.clear();
```

## Related Modules

- `../history/` - Stores committed patches for time-travel
- `../../core/memory/StageContext.ts` - Uses WriteBuffer for stage mutations
- `../../core/memory/GlobalStore.ts` - Receives committed patches
