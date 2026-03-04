# Scope Communication in FootPrint

> **CRITICAL**: This document describes how to properly share data between stages. Incorrect usage will result in data loss.

## The Problem

Each stage in FootPrint receives its own `scope` instance. **Direct property assignment on scope does NOT propagate to subsequent stages.**

```typescript
// ❌ WRONG - This data will be LOST
async function stageA(scope: MyScope) {
  scope.myData = { result: 'hello' };  // Only exists in stageA's scope instance
  return { success: true };
}

async function stageB(scope: MyScope) {
  console.log(scope.myData);  // undefined! Different scope instance
}
```

## The Solution: GlobalContext Methods

Use `setValue()`, `updateValue()`, and `getValue()` to communicate between stages. These methods write to and read from the shared `GlobalContext`.

```typescript
// ✅ CORRECT - Data persists across stages
async function stageA(scope: MyScope) {
  scope.setValue('myData', { result: 'hello' });  // Writes to GlobalContext
  return { success: true };
}

async function stageB(scope: MyScope) {
  const myData = scope.getValue('myData');  // Reads from GlobalContext
  console.log(myData);  // { result: 'hello' }
}
```

## API Reference

### Writing Data

#### `setValue(key: string, value: unknown)`
Hard overwrite - replaces any existing value.

```typescript
scope.setValue('settings', { theme: 'dark' });
```

#### `updateValue(key: string, value: unknown)`
Deep merge - merges value with existing data.

```typescript
scope.updateValue('toolA', { output: 'data' });
scope.updateValue('toolB', { output: 'more' });
// Results in: { toolA: { output: 'data' }, toolB: { output: 'more' } }
```

### Reading Data

#### `getValue(key?: string)`
Reads from GlobalContext. Supports read-after-write within the same stage.

```typescript
const settings = scope.getValue('settings');
const allState = scope.getValue();  // Returns entire scope state
```

## Parallel Children (Fork) Communication

When using parallel children (fork), each child gets its own scope instance. Use `updateValue()` to aggregate results:

```typescript
// Parent stage creates children
function createChildHandlers(items: Item[]): StageNode[] {
  return items.map((item, i) => ({
    name: `process_${i}`,
    id: `child_${item.id}`,
    fn: async (scope) => {
      const result = await processItem(item);

      // ✅ Write to shared GlobalContext - all children merge into same object
      scope.updateValue(item.id, {
        itemId: item.id,
        output: result,
      });

      return { itemId: item.id, result };
    },
  }));
}

// Aggregation stage reads all results
async function aggregateStage(scope: MyScope) {
  // Read merged results from all children
  const childResults = scope.getValue() as Record<string, ChildResult>;

  const allResults = Object.values(childResults);
  // Process aggregated results...
}
```

## Commit Lifecycle

Pipeline automatically calls `commitPatch()` after each stage completes:

1. Stage handler runs
2. All `setValue()`/`updateValue()` calls are batched in `PatchedMemoryContext`
3. `commitPatch()` flushes patches to `GlobalContext`
4. Next stage can read the committed values via `getValue()`

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Stage A   │     │   Stage B   │     │   Stage C   │
│             │     │             │     │             │
│ setValue()  │────▶│ getValue()  │────▶│ getValue()  │
│             │     │ setValue()  │     │             │
└─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │
       ▼                   ▼                   ▼
   commitPatch()      commitPatch()      commitPatch()
       │                   │                   │
       └───────────────────┴───────────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │GlobalContext│
                    │  (shared)   │
                    └─────────────┘
```

## BaseState Integration

When extending `BaseState` for your scope class, these methods are automatically available:

```typescript
import { BaseState, StageContext } from 'footprint';

class MyScope extends BaseState {
  // Instance properties for type safety (NOT for cross-stage communication)
  currentItem?: Item;
  
  constructor(context: StageContext, stageName: string, readOnlyContext?: unknown) {
    super(context, stageName, readOnlyContext);
  }
}

// Usage in stage handler
async function myStage(scope: MyScope) {
  // ✅ Use inherited methods for cross-stage communication
  scope.setValue('sharedData', { value: 123 });
  const data = scope.getValue('sharedData');
  
  // Instance properties are fine for stage-local data
  scope.currentItem = { id: 'local' };
}
```

## Common Patterns

### Pattern 1: LLM Response → Route Decision

```typescript
// askLLM stage
async function askLLM(scope: AgentScope) {
  const response = await callLLM(scope.conversationHistory);
  
  // Store in GlobalContext for downstream stages
  scope.setValue('llmResponse', response);
  if (response.toolCalls?.length > 0) {
    scope.setValue('toolCalls', response.toolCalls);
  }
  
  return { response };
}

// routeDecider stage
async function routeDecider(scope: AgentScope) {
  // Read from GlobalContext
  const toolCalls = scope.getValue('toolCalls') as ToolCall[] | undefined;
  
  const hasToolCalls = toolCalls && toolCalls.length > 0;
  return { selectedBranch: hasToolCalls ? 'tool_branch' : 'direct_branch' };
}
```

### Pattern 2: Parallel Tool Execution → Aggregation

```typescript
// Tool child handler
const toolHandler = async (scope: AgentScope) => {
  const result = await executeTool(toolCall);
  
  // Merge into shared results object
  scope.updateValue(toolCall.id, {
    toolCallId: toolCall.id,
    output: result.output,
    isError: result.isError,
  });
  
  return { toolCallId: toolCall.id, result };
};

// Aggregation stage
async function aggregateTools(scope: AgentScope) {
  const toolResultsMap = scope.getValue() as Record<string, ToolResult>;
  const results = Object.values(toolResultsMap || {});
  
  return { aggregatedResults: results, hasErrors: results.some(r => r.isError) };
}
```

## Debugging Tips

1. **Check commitPatch was called**: Pipeline logs patch commits. Look for `writeTrace` in debug output.

2. **Verify namespacing**: Values are stored under `pipelines/<pipelineId>/<key>`. Use `getValue` with the correct key.

3. **Read-after-write**: Within the same stage, `getValue` returns uncommitted values from the patch.

4. **Time-travel debugging**: All commits are recorded in `MemoryHistory`. Use the debug UI to inspect state at each step.

## Summary

| Method | Use Case | Behavior |
|--------|----------|----------|
| `scope.property = value` | Stage-local data only | ❌ Lost after stage |
| `scope.setValue(key, value)` | Cross-stage data (overwrite) | ✅ Persists in GlobalContext |
| `scope.updateValue(key, value)` | Cross-stage data (merge) | ✅ Merges into GlobalContext |
| `scope.getValue(key)` | Read shared data | ✅ Reads from GlobalContext |

**Remember**: If you need data in a subsequent stage, use `setValue()`/`updateValue()`. Direct property assignment is only for stage-local convenience.
