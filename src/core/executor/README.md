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

### Standard Execution

```typescript
import { FlowChartExecutor } from './FlowChartExecutor';
import { flowChart } from '../builder/FlowChartBuilder';

const chart = flowChart('entry', async (scope) => {
  scope.message = 'Hello';
  return scope.message;
})
  .addFunction('process', async (scope) => {
    return scope.message + ' World';
  })
  .build();

const executor = new FlowChartExecutor(chart, MyScopeFactory);
const result = await executor.run();

const extractedData = executor.getExtractedResults();
```

### Enriched Snapshots (Recommended for Debug UIs)

When you need per-stage scope state, debug metadata, stage output, and history index, enable `enrichSnapshots` to capture everything during traversal.

```typescript
const chart = flowChart('entry', entryFn)
  .addFunction('process', processFn)
  .addTraversalExtractor((snapshot) => {
    // With enrichSnapshots enabled, snapshot includes extra fields:
    const { node, stepNumber, structureMetadata, scopeState, debugInfo, stageOutput, historyIndex } = snapshot;
    return { stageName: node.name, stepNumber, scopeState, debugInfo, stageOutput, historyIndex };
  })
  .build();

const executor = new FlowChartExecutor(chart, MyScopeFactory, undefined, undefined, undefined, undefined, undefined, undefined, true);
const result = await executor.run();

const enriched = executor.getEnrichedResults();
```

### When to Use Which Method

| Method | Use Case |
|--------|----------|
| `getExtractedResults()` | Custom extractor results without enrichment |
| `getEnrichedResults()` | Full debug data captured during traversal (recommended for debug UIs when `enrichSnapshots: true`) |

## Related Modules

- `../builder/` - Constructs the FlowChart structure that this module executes
- `../memory/` - Provides StageContext and PipelineRuntime for state management
- `../../internal/memory/` - WriteBuffer for transaction-based mutations
- `../../scope/` - Scope system for consumer-facing state access
