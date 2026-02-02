# Providers Module

## Purpose

The providers module implements the **scope provider system** - a plugin architecture that allows the library to accept different types of scope inputs (factory functions, classes, schemas) and normalize them into a consistent `ScopeFactory` type that the pipeline expects.

## Key Concepts

- **ScopeProvider**: A strategy object that knows how to create a scope instance from a `StageContext`. Each provider has a `kind` (e.g., 'factory', 'class', 'zod') and a `create` method.

- **ProviderResolver**: A plugin that can detect and handle specific input types. Resolvers are registered globally and checked in order when resolving inputs.

- **ScopeFactory**: The normalized function type `(ctx, stageName, readOnly?) => TScope` that the pipeline uses internally.

- **Guards**: Heuristic functions that detect whether an input is a class constructor, factory function, or BaseState subclass.

## Design Decisions

1. **Plugin Architecture**: Resolvers are registered globally, allowing plugins (like Zod support) to be added without modifying core code.

2. **First Match Wins**: Resolvers are checked in registration order. Built-in resolvers (class, factory) are checked last as fallback.

3. **Minimal StageContextLike**: The `StageContextLike` interface defines only the methods needed by scope providers, avoiding tight coupling with the full `StageContext`.

4. **BaseState Compatibility**: The `attachBaseStateCompat` function allows non-class scopes to gain BaseState-like methods.

## Files Overview

| File | Purpose |
|------|---------|
| `registry.ts` | Central registry for resolvers, resolution logic |
| `resolve.ts` | Public API: `toScopeFactory`, `registerScopeResolver` |
| `guards.ts` | Heuristics for detecting classes vs factories |
| `providers.ts` | Factory functions for creating providers |
| `baseStateCompatible.ts` | Attach BaseState methods to any object |
| `types.ts` | Type definitions for the provider system |
| `index.ts` | Barrel export |

## Usage Example

```typescript
import { toScopeFactory, registerScopeResolver } from './providers';
import { BaseState } from '../BaseState';

// Using a class that extends BaseState
class MyScope extends BaseState {
  get userName(): string {
    return this.getValue(['user'], 'name') as string;
  }
}
const factory1 = toScopeFactory(MyScope);

// Using a factory function
const factory2 = toScopeFactory((ctx, stageName) => ({
  getValue: (key: string) => ctx.getValue([stageName], key),
}));

// Registering a custom resolver (e.g., for Zod schemas)
registerScopeResolver({
  name: 'zod',
  canHandle: (input) => isZodSchema(input),
  makeProvider: (input, options) => createZodProvider(input, options),
});
```

## Related Modules

- `../BaseState.ts` - Base class that consumers extend for class-based scopes
- `../Scope.ts` - Runtime memory container that uses providers
- `../../core/memory/StageContext.ts` - The context passed to scope factories
- `../state/zod/` - Zod schema resolver plugin (uses this provider system)
