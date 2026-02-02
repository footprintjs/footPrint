# Utils Module

## Purpose

The utils module provides **shared utility functions** used across the library. These are internal helpers that don't belong to any specific domain.

## Key Concepts

- **scopeLog**: Structured logging for scope operations. Provides log, metric, and eval methods that record to StageContext.

- **logger**: Simple console logger with configurable log levels.

## Design Decisions

1. **Minimal Surface**: Only essential utilities are included. Domain-specific helpers belong in their respective modules.

2. **No External Dependencies**: Utils should not depend on external packages to keep the library lightweight.

3. **Pure Functions**: Utilities are pure functions where possible, making them easy to test and reason about.

## Files Overview

| File | Purpose |
|------|---------|
| `scopeLog.ts` | Structured logging for scope operations |
| `logger.ts` | Simple console logger |
| `index.ts` | Barrel export |

## Usage Example

```typescript
import { treeConsole } from './scopeLog';

// Log debug info
treeConsole.log(context, 'stageName', [], 'key', value);

// Log metrics
treeConsole.metric(context, 'stageName', [], 'latency', 150);

// Log evaluation results
treeConsole.eval(context, 'stageName', [], 'score', 0.95);
```

## Related Modules

- `../scope/BaseState.ts` - Uses scopeLog for debug/metric methods
- `../core/memory/StageContext.ts` - Receives log entries
