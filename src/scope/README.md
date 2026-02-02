# Scope Module

## Purpose

The scope module provides the **consumer extensibility layer** for the library. It allows consumers to define custom scope classes, use pluggable recorders for monitoring, and protect scopes from accidental direct mutation.

## Key Concepts

- **Scope**: Runtime memory container that wraps StageContext with a consumer-friendly API. Provides getValue, setValue, updateValue, and commit operations.

- **BaseState**: Base class that consumers extend to create custom scope classes with domain-specific properties and methods.

- **Recorder**: Plugin interface for observing scope operations (reads, writes, commits, errors). Used for metrics, debugging, and auditing.

- **Provider System**: Plugin architecture for resolving different input types (classes, factories, schemas) into scope factories.

- **Scope Protection**: Proxy-based protection that prevents direct property assignment, enforcing use of setValue/updateValue.

## Design Decisions

1. **BaseState Pattern**: Consumers extend BaseState to create typed scopes with getters/setters that map to path-based storage.

2. **Pluggable Recorders**: Recorders are injected at runtime, enabling different monitoring strategies (metrics, debug, custom).

3. **Provider Plugins**: The provider system allows adding support for new scope definition formats (e.g., Zod schemas) without modifying core code.

4. **Protection by Default**: Scope protection catches common mistakes (direct assignment) early in development.

## Files Overview

| File/Folder | Purpose |
|-------------|---------|
| `Scope.ts` | Core runtime memory container |
| `BaseState.ts` | Base class for custom scope classes |
| `types.ts` | Recorder interface and event types |
| `providers/` | Provider system for scope resolution |
| `recorders/` | Built-in recorders (Metric, Debug) |
| `protection/` | Scope protection proxy |
| `state/` | State definition helpers (Zod integration) |

## Usage Example

```typescript
import { BaseState, Scope, MetricRecorder, DebugRecorder } from './scope';

// Define a custom scope class
class MyScope extends BaseState {
  get userName(): string {
    return this.getValue(['user'], 'name') as string;
  }
  set userName(value: string) {
    this.setObject(['user'], 'name', value);
  }
}

// Use with recorders
const scope = new Scope({
  recorders: [new MetricRecorder(), new DebugRecorder()],
});
```

## Related Modules

- `../core/memory/StageContext.ts` - Underlying context that Scope wraps
- `../core/builder/FlowChartBuilder.ts` - Accepts scope factories
- `../core/executor/Pipeline.ts` - Creates scopes during execution
