# Subflow Input Mapping

This document describes the input/output mapping system for subflows in FootPrint.

## Overview

Subflow input mapping enables parent flows to explicitly declare what data flows into subflows at mount time. This provides:

- **Explicit data contracts** between parent and subflow
- **Scope isolation** - subflows don't automatically inherit parent scope
- **Type safety** - TypeScript generics provide compile-time validation
- **Testability** - subflows can be tested in isolation with mock inputs
- **Debuggability** - mapped values are logged for visibility

## Basic Usage

```typescript
import { flowChart, SubflowMountOptions } from 'footprint';

// Define the subflow
const processUserFlow = flowChart()
  .addStage('validate', async (scope) => {
    // Access mapped values via scope
    const userId = scope.getGlobal('userId');
    const name = scope.getGlobal('name');
    return { valid: true, userId, name };
  })
  .build();

// Mount subflow with input mapping
const mainFlow = flowChart()
  .addStage('fetchUser', async (scope) => {
    scope.setGlobal('currentUserId', 'user-123');
    scope.setGlobal('currentUserName', 'Alice');
    scope.setGlobal('secretToken', 'abc123'); // Won't be passed to subflow
    scope.commitPatch();
    return 'fetched';
  })
  .addSubFlowChartNext(processUserFlow, {
    inputMapper: (parentScope) => ({
      userId: parentScope.currentUserId,
      name: parentScope.currentUserName,
    }),
  })
  .build();
```

## SubflowMountOptions

The `SubflowMountOptions` interface provides three configuration options:

### inputMapper

A function that extracts data from the parent scope to seed the subflow's initial scope.

```typescript
{
  inputMapper: (parentScope) => ({
    // Return key-value pairs to seed in subflow
    userId: parentScope.userId,
    config: parentScope.appConfig,
  }),
}
```

### outputMapper

A function that extracts data from the subflow's output to write back to the parent scope.

```typescript
{
  outputMapper: (subflowOutput, parentScope) => ({
    // Return key-value pairs to write to parent scope
    processedResult: subflowOutput.result,
    timestamp: Date.now(),
  }),
}
```

### scopeMode

Controls how the subflow's initial scope is populated:

- `'isolated'` (default): Subflow gets only inputMapper values (or empty if no inputMapper)
- `'inherit'`: Subflow receives a shallow copy of parent scope, merged with inputMapper values

```typescript
// Isolated mode (default) - subflow only sees mapped values
{
  scopeMode: 'isolated',
  inputMapper: (scope) => ({ userId: scope.userId }),
}

// Inherit mode - subflow sees all parent values plus mapped overrides
{
  scopeMode: 'inherit',
  inputMapper: (scope) => ({ overrideValue: 'new' }),
}
```

## Builder Methods

All subflow builder methods accept `SubflowMountOptions`:

```typescript
// Linear continuation
.addSubFlowChartNext(subflow, options)

// Initial subflow
.addSubFlowChart(subflow, options)

// Decider branch
.addDeciderFunction('Decide', deciderFn)
  .addSubFlowChartBranch('branchA', subflowA, optionsA)
  .addSubFlowChartBranch('branchB', subflowB, optionsB)
  .done()

// Selector branch
.addSelector('select', selectorFn)
  .addSubFlowChartBranch('optionA', subflowA, optionsA)
  .done()
```

## Error Handling

### Input Mapper Errors

Input mapper errors are **fatal** - they stop subflow execution and propagate to the parent.

```typescript
{
  inputMapper: (scope) => {
    if (!scope.userId) {
      throw new Error('userId is required');
    }
    return { userId: scope.userId };
  },
}
```

### Output Mapper Errors

Output mapper errors are **non-fatal** - they are logged but don't stop execution.

```typescript
{
  outputMapper: (output) => {
    // If this throws, the error is logged but subflow result is preserved
    return { processed: output.data };
  },
}
```

## Debugging

Mapped values are logged in the stage's debug info:

```typescript
// Access via parentContext.debug.logContext
{
  scopeMode: 'isolated',
  mappedInput: { userId: 'user-123', name: 'Alice' },
  mappedOutput: { result: 'success' },
}
```

When no mappers are provided, these fields are omitted from debug info.

## Type Safety

Use TypeScript generics for compile-time type checking:

```typescript
interface ParentScope {
  userId: string;
  config: AppConfig;
}

interface SubflowInput {
  userId: string;
}

const options: SubflowMountOptions<ParentScope, SubflowInput> = {
  inputMapper: (scope) => ({
    userId: scope.userId,
    // TypeScript error: 'invalid' doesn't exist on ParentScope
    // invalid: scope.invalid,
  }),
};
```

## Advanced: Helper Functions

For advanced use cases, the helper functions are exported:

```typescript
import {
  extractParentScopeValues,
  getInitialScopeValues,
  seedSubflowGlobalStore,
  applyOutputMapping,
} from 'footprint';
```

These are primarily used internally by `SubflowExecutor` but can be useful for testing or custom implementations.
