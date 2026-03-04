# Getting Started with FootPrint

## Installation

```bash
npm install footprint
```

## Basic Usage

```typescript
import { FlowChartBuilder, BaseState } from 'footprint';

// 1. Create a scope factory
const scopeFactory = (ctx: any, stageName: string) => new BaseState(ctx, stageName);

// 2. Build your flow
const builder = new FlowChartBuilder()
  .start('Step1', async (scope) => {
    scope.setValue('message', 'Hello');
  })
  .addFunction('Step2', async (scope) => {
    const msg = scope.getValue('message');
    console.log(msg); // "Hello"
  });

// 3. Execute
const result = await builder.execute(scopeFactory);
```

## Understanding the Basics

### Stages

A stage is a single function in your pipeline. Each stage:
- Receives a `scope` object for state management
- Receives a `breakFn` to stop execution
- Optionally returns a value (see below)

```typescript
async function myStage(scope: BaseState, breakFn: () => void) {
  // Do work — use scope to pass data between stages
  scope.setValue('output', { data: 'value' });

  // Optionally stop the pipeline
  if (shouldStop) breakFn();
}
```

> **Note**: Return values are only needed when returning a `StageNode` for [dynamic flow](./DYNAMIC_CHILDREN.md). In all other cases, use `scope.setValue()` / `scope.getValue()` for inter-stage communication.

### Scope Communication

⚠️ **CRITICAL**: Each stage gets its own scope instance. Direct property assignment does NOT persist!

```typescript
// ❌ WRONG - Data is LOST
scope.myData = { result: 'hello' };

// ✅ CORRECT - Data persists
scope.setValue('myData', { result: 'hello' });
const data = scope.getValue('myData');
```

See [Scope Communication](./SCOPE_COMMUNICATION.md) for full details.

## Next Steps

- [Core Concepts](./CORE_CONCEPTS.md) - Understand the architecture
- [Patterns](./PATTERNS.md) - Learn Fork, Decider, Selector patterns
- [FlowChartBuilder API](./FLOWCHART_BUILDER.md) - Full API reference
