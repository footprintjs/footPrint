# Executor Module

## Purpose

This module contains the runtime execution engine for flowchart-based pipelines. It is responsible for traversing the node tree, executing stage functions, and coordinating the various execution patterns (linear, fork, decider, loop).

The executor is the "runtime" counterpart to the builder module - while the builder constructs the pipeline structure at build time, the executor runs it at runtime.

## Key Concepts

- **Pipeline**: The core execution engine that traverses StageNodes and executes stage functions in the correct order
- **FlowChartExecutor**: Public API wrapper around Pipeline that accepts a compiled FlowChart object
- **StageNode**: A node in the pipeline tree representing a stage to execute
- **Handlers**: Extracted modules that handle specific execution patterns (stages, children, loops, deciders)

## Design Decisions

1. **Pipeline vs FlowChartExecutor**: Pipeline is the internal engine with full control; FlowChartExecutor is the public API that accepts a FlowChart object from the builder. This separation allows the internal implementation to evolve without breaking the public API.

2. **Handler Extraction**: Execution logic is split into handler modules (StageRunner, ChildrenExecutor, etc.) following the Single Responsibility Principle. This makes the code more testable and maintainable.

3. **Unified Traversal Order**: All node shapes follow the same execution order: stage → commit → children → next. This predictable order makes the execution model easier to understand and debug.

4. **Dynamic Stage Detection**: Rather than requiring explicit flags, dynamic stages are detected via duck-typing (isStageNodeReturn). This allows any stage to return a StageNode for dynamic continuation.

## Files Overview

| File | Purpose |
|------|---------|
| `FlowChartExecutor.ts` | Public API wrapper - accepts FlowChart, provides run() method |
| `Pipeline.ts` | Core execution engine - traverses nodes, coordinates handlers |
| `handlers/` | Extracted handler modules for specific execution patterns |

## Usage Example

```typescript
import { FlowChartExecutor } from './FlowChartExecutor';
import { flowChart } from '../builder/FlowChartBuilder';

// Build a flowchart
const chart = flowChart('entry', async (scope) => {
  scope.message = 'Hello';
  return scope.message;
})
  .addFunction('process', async (scope) => {
    return scope.message + ' World';
  })
  .build();

// Create executor and run
const executor = new FlowChartExecutor(chart, MyScopeFactory);
const result = await executor.run();

// Access execution data
const contextTree = executor.getContextTree();
const extractedData = executor.getExtractedResults();
```

## Related Modules

- `../builder/` - Constructs the FlowChart structure that this module executes
- `../memory/` - Provides StageContext and PipelineRuntime for state management
- `../../internal/memory/` - WriteBuffer for transaction-based mutations
- `../../scope/` - Scope system for consumer-facing state access
