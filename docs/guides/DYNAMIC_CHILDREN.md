# Dynamic Children Pattern

FootPrint supports **dynamic children** - the ability for stage handlers to create child nodes at runtime. This enables patterns like parallel tool execution where the number and type of children are determined during execution.

## Overview

Unlike static patterns (Fork, Decider, Selector) where children are defined at pipeline creation time, dynamic children are created by the stage handler itself by returning a `StageNode` object.

```
Static Children:                    Dynamic Children:
┌─────────────────┐                 ┌─────────────────┐
│  Defined at     │                 │  Created at     │
│  build time     │                 │  runtime        │
└─────────────────┘                 └─────────────────┘
        │                                   │
        ▼                                   ▼
┌───┬───┬───┐                       ┌───┬───┬───┬───┐
│ A │ B │ C │ (known)               │ ? │ ? │ ? │...│ (unknown)
└───┴───┴───┘                       └───┴───┴───┴───┘
```

## How It Works

Any stage function can return a `StageNode` object instead of a regular output. FootPrint detects this via duck-typing and executes the returned node as a continuation.

### Detection Rules

A return value is treated as a dynamic `StageNode` if it:
1. Is a non-null object
2. Has a `name` property (string)
3. Has at least one continuation property:
   - `children` (non-empty array)
   - `next` (StageNode)
   - `nextNodeDecider` (function)
   - `nextNodeSelector` (function)

## Dynamic Children (Fork Pattern)

Return a `StageNode` with `children` to create parallel children at runtime:

```typescript
async function toolBranchHandler(scope: Scope) {
  const toolCalls = scope.getValue([], 'toolCalls');
  
  if (!toolCalls?.length) {
    return { message: 'No tools to execute' }; // Regular output
  }

  // Create child nodes dynamically
  const toolNodes = toolCalls.map(call => ({
    id: `tool_${call.id}`,
    name: call.name,
    fn: async (s: Scope) => {
      // Execute the tool
      return await executeTool(call);
    },
  }));

  // Return StageNode - FootPrint will execute these children
  return {
    name: 'dynamicTools',
    children: toolNodes,
  };
}
```

### Execution Flow

```
1. toolBranch stage executes
2. Handler returns StageNode with children
3. FootPrint detects dynamic children
4. Children execute in parallel
5. Results aggregated as { childId: { result, isError } }
```

### Context Tree

Dynamic children appear in the context tree like static children:

```json
{
  "toolBranch": {
    "debug": { "isDynamic": true, "dynamicChildCount": 2 }
  },
  "toolBranch.tool_search": { "output": { "results": [...] } },
  "toolBranch.tool_calc": { "output": { "answer": 42 } }
}
```

## Dynamic Next (Linear Continuation)

Return a `StageNode` with `next` to create a linear continuation:

```typescript
async function processHandler(scope: Scope) {
  const needsValidation = scope.getValue([], 'needsValidation');
  
  if (needsValidation) {
    // Return dynamic next node
    return {
      name: 'dynamicContinuation',
      next: {
        name: 'Validate',
        fn: async (s: Scope) => {
          return await validateData(s);
        },
      },
    };
  }
  
  return { status: 'complete' }; // Regular output
}
```

## Dynamic Decider (Single-Choice)

Return a `StageNode` with `children` and `nextNodeDecider` for runtime single-choice branching:

```typescript
async function routerHandler(scope: Scope) {
  const options = await fetchAvailableOptions();
  
  return {
    name: 'dynamicRouter',
    children: options.map(opt => ({
      id: opt.id,
      name: opt.name,
      fn: opt.handler,
    })),
    nextNodeDecider: (output: any) => {
      // Pick one child based on some criteria
      return output.selectedOption;
    },
  };
}
```

## Dynamic Selector (Multi-Choice)

Return a `StageNode` with `children` and `nextNodeSelector` for runtime multi-choice branching:

```typescript
async function toolDispatchHandler(scope: Scope) {
  const toolCalls = scope.getValue([], 'toolCalls');
  
  // Create all possible tool nodes
  const toolNodes = toolRegistry.getAllTools().map(tool => ({
    id: tool.id,
    name: tool.name,
    fn: tool.execute,
  }));

  return {
    name: 'toolDispatch',
    children: toolNodes,
    nextNodeSelector: () => {
      // Select which tools to execute based on toolCalls
      return toolCalls.map(call => call.toolId);
    },
  };
}
```

## Use Cases

### 1. LLM Tool Execution

The primary use case - execute tools requested by an LLM:

```typescript
async function toolBranch(scope: Scope) {
  const llmResponse = scope.getValue([], 'llmResponse');
  const toolCalls = llmResponse.tool_calls || [];
  
  if (toolCalls.length === 0) {
    return { noTools: true };
  }

  const toolNodes = toolCalls.map(call => ({
    id: `tool_${call.id}`,
    name: call.function.name,
    fn: async (s: Scope) => {
      const tool = toolRegistry.get(call.function.name);
      const args = JSON.parse(call.function.arguments);
      return await tool.execute(args);
    },
  }));

  return {
    name: 'toolExecution',
    children: toolNodes,
  };
}
```

### 2. Dynamic Workflow Steps

Create workflow steps based on runtime data:

```typescript
async function workflowBuilder(scope: Scope) {
  const config = scope.getValue([], 'workflowConfig');
  
  const steps = config.steps.map((step, i) => ({
    id: `step_${i}`,
    name: step.name,
    fn: createStepHandler(step),
  }));

  return {
    name: 'dynamicWorkflow',
    children: steps,
  };
}
```

### 3. Conditional Parallel Processing

Process items in parallel based on runtime conditions:

```typescript
async function batchProcessor(scope: Scope) {
  const items = scope.getValue([], 'items');
  const processableItems = items.filter(item => item.status === 'pending');
  
  if (processableItems.length === 0) {
    return { processed: 0 };
  }

  return {
    name: 'batchProcess',
    children: processableItems.map(item => ({
      id: `item_${item.id}`,
      name: 'ProcessItem',
      fn: async () => processItem(item),
    })),
  };
}
```

## Debug Information

When a stage returns dynamic children, FootPrint records debug metadata:

| Key | Description |
|-----|-------------|
| `isDynamic` | `true` - indicates dynamic continuation |
| `dynamicPattern` | `'StageNodeReturn'` - detection method |
| `dynamicChildCount` | Number of dynamic children |
| `dynamicChildIds` | Array of child IDs |
| `hasSelector` | `true` if selector was provided |
| `hasDecider` | `true` if decider was provided |
| `hasDynamicNext` | `true` if next was provided |

## Best Practices

### 1. Always Provide IDs

Dynamic children should have unique `id` properties for result aggregation:

```typescript
// ✅ Good
children: items.map(item => ({
  id: `item_${item.id}`,  // Unique ID
  name: 'ProcessItem',
  fn: processFn,
}))

// ❌ Bad - no IDs
children: items.map(item => ({
  name: 'ProcessItem',
  fn: processFn,
}))
```

### 2. Handle Empty Cases

Return regular output when no dynamic children are needed:

```typescript
if (toolCalls.length === 0) {
  return { noTools: true };  // Regular output, not StageNode
}
```

### 3. Keep Handlers Pure

Dynamic handlers should be pure functions - create new nodes rather than mutating existing ones:

```typescript
// ✅ Good - return new StageNode
return {
  name: 'dynamic',
  children: [...],
};

// ❌ Bad - mutating node
node.children = [...];  // Don't do this
```

## Comparison: Static vs Dynamic

| Aspect | Static Children | Dynamic Children |
|--------|-----------------|------------------|
| Definition time | Build time | Runtime |
| Known at start | Yes | No |
| Use case | Fixed workflows | Variable workflows |
| Builder API | `addListOfFunction()` | Return `StageNode` |
| Visualization | Always visible | Visible after execution |

## Related Patterns

- [Fork Pattern](./PATTERNS.md#2-fork-pattern-parallel) - Static parallel execution
- [Selector Pattern](./PATTERNS.md#4-selector-pattern-multi-choice) - Static multi-choice
- [Decider Pattern](./PATTERNS.md#3-decider-pattern-single-choice) - Static single-choice
