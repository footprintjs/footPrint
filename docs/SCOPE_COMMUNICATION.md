# Scope Communication in TreeOfFunctions

> **CRITICAL**: This document describes how to properly share data between stages. Incorrect usage will result in data loss.

## The Problem

Each stage in TreeOfFunctions receives its own `scope` instance. **Direct property assignment on scope does NOT propagate to subsequent stages.**

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

Use `setObject()`, `updateObject()`, and `getValue()` to communicate between stages. These methods write to and read from the shared `GlobalContext`.

```typescript
// ✅ CORRECT - Data persists across stages
async function stageA(scope: MyScope) {
  scope.setObject([], 'myData', { result: 'hello' });  // Writes to GlobalContext
  return { success: true };
}

async function stageB(scope: MyScope) {
  const myData = scope.getValue([], 'myData');  // Reads from GlobalContext
  console.log(myData);  // { result: 'hello' }
}
```

## API Reference

### Writing Data

#### `setObject(path: string[], key: string, value: unknown)`
Hard overwrite - replaces any existing value at the path.

```typescript
scope.setObject(['config'], 'settings', { theme: 'dark' });
// Writes to: pipelines/<pipelineId>/config/settings
```

#### `updateObject(path: string[], key: string, value: unknown)`
Deep merge - merges value with existing data at the path.

```typescript
scope.updateObject(['results'], 'toolA', { output: 'data' });
scope.updateObject(['results'], 'toolB', { output: 'more' });
// Results in: { toolA: { output: 'data' }, toolB: { output: 'more' } }
```

### Reading Data

#### `getValue(path: string[], key?: string)`
Reads from GlobalContext. Supports read-after-write within the same stage.

```typescript
const settings = scope.getValue(['config'], 'settings');
const allResults = scope.getValue(['results']);  // Returns entire object at path
```

## Parallel Children (Fork) Communication

When using parallel children (fork), each child gets its own scope instance. Use `updateObject()` to aggregate results:

```typescript
// Parent stage creates children
function createChildHandlers(items: Item[]): StageNode[] {
  return items.map((item, i) => ({
    name: `process_${i}`,
    id: `child_${item.id}`,
    fn: async (scope) => {
      const result = await processItem(item);
      
      // ✅ Write to shared GlobalContext - all children merge into same object
      scope.updateObject(['childResults'], item.id, {
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
  const childResults = scope.getValue(['childResults']) as Record<string, ChildResult>;
  
  const allResults = Object.values(childResults);
  // Process aggregated results...
}
```

## Commit Lifecycle

Pipeline automatically calls `commitPatch()` after each stage completes:

1. Stage handler runs
2. All `setObject()`/`updateObject()` calls are batched in `PatchedMemoryContext`
3. `commitPatch()` flushes patches to `GlobalContext`
4. Next stage can read the committed values via `getValue()`

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Stage A   │     │   Stage B   │     │   Stage C   │
│             │     │             │     │             │
│ setObject() │────▶│ getValue()  │────▶│ getValue()  │
│             │     │ setObject() │     │             │
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
import { BaseState, StageContext } from '@amzn/tree-of-functions';

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
  scope.setObject([], 'sharedData', { value: 123 });
  const data = scope.getValue([], 'sharedData');
  
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
  scope.setObject([], 'llmResponse', response);
  if (response.toolCalls?.length > 0) {
    scope.setObject([], 'toolCalls', response.toolCalls);
  }
  
  return { response };
}

// routeDecider stage
async function routeDecider(scope: AgentScope) {
  // Read from GlobalContext
  const toolCalls = scope.getValue([], 'toolCalls') as ToolCall[] | undefined;
  
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
  scope.updateObject(['toolResults'], toolCall.id, {
    toolCallId: toolCall.id,
    output: result.output,
    isError: result.isError,
  });
  
  return { toolCallId: toolCall.id, result };
};

// Aggregation stage
async function aggregateTools(scope: AgentScope) {
  const toolResultsMap = scope.getValue(['toolResults']) as Record<string, ToolResult>;
  const results = Object.values(toolResultsMap || {});
  
  return { aggregatedResults: results, hasErrors: results.some(r => r.isError) };
}
```

## Debugging Tips

1. **Check commitPatch was called**: Pipeline logs patch commits. Look for `writeTrace` in debug output.

2. **Verify path namespacing**: Values are stored under `pipelines/<pipelineId>/<path>/<key>`. Use `getValue` with correct path.

3. **Read-after-write**: Within the same stage, `getValue` returns uncommitted values from the patch.

4. **Time-travel debugging**: All commits are recorded in `MemoryHistory`. Use the debug UI to inspect state at each step.

## Summary

| Method | Use Case | Behavior |
|--------|----------|----------|
| `scope.property = value` | Stage-local data only | ❌ Lost after stage |
| `scope.setObject(path, key, value)` | Cross-stage data (overwrite) | ✅ Persists in GlobalContext |
| `scope.updateObject(path, key, value)` | Cross-stage data (merge) | ✅ Merges into GlobalContext |
| `scope.getValue(path, key)` | Read shared data | ✅ Reads from GlobalContext |

**Remember**: If you need data in a subsequent stage, use `setObject()`/`updateObject()`. Direct property assignment is only for stage-local convenience.
