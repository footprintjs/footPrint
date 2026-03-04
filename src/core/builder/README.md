# Builder Module

## Purpose

This folder contains the FlowChartBuilder - the primary API for constructing flowchart-based pipelines. The builder provides a fluent interface for defining stage nodes, branching logic (deciders/selectors), and subflow composition.

The builder is the entry point for consumers who want to define pipeline structures. It produces a `FlowChart` object that can be executed by `FlowChartExecutor`.

## Key Concepts

- **FlowChartBuilder**: Main builder class with fluent API for constructing pipelines
- **StageNode**: The tree structure built by the builder (defined in executor module)
- **FlowChart**: Compiled output containing root node, stage map, and metadata
- **DeciderList/SelectorList**: Helper classes for defining branching logic
- **SerializedPipelineStructure**: JSON-serializable structure for frontend consumption

## Design Decisions

1. **Fluent Builder Pattern**: The builder uses method chaining (`start().addFunction().addDeciderFunction()...`) for ergonomic pipeline construction. This makes the code read like a description of the pipeline flow.

2. **Incremental Structure Building**: The builder constructs both `StageNode` (for execution) and `SerializedPipelineStructure` (for visualization) simultaneously. This ensures consistency between runtime and debug views.

3. **Subgraph Composition over Callbacks**: Instead of nested build callbacks, the builder promotes composing pre-built subflows via `addSubFlowChart()`. This makes pipelines more modular and testable.

4. **Build-Time Extractor**: An optional extractor can be passed to the constructor to transform node metadata as nodes are created. This enables custom metadata enrichment without post-processing.

5. **Import from Old Paths**: The builder imports from old paths (e.g., `../pipeline/`) which re-export from new locations. This maintains compatibility with existing test mocks.

## Files Overview

| File | Purpose |
|------|---------|
| `FlowChartBuilder.ts` | Main builder class, DeciderList, SelectorList, and factory functions |
| `index.ts` | Barrel export for all builder-related exports |

## Usage Example

```typescript
import { flowChart, FlowChartBuilder } from './core/builder';

// Using factory function (recommended)
const chart = flowChart('entry', entryFn, 'entry-id')
  .addFunction('process', processFn, 'process-id')
  .addDeciderFunction('Router', async (scope) => {
    return scope.get('success') ? 'success' : 'failure';
  }, 'router-id')
    .addFunctionBranch('success', 'handleSuccess', successFn)
    .addFunctionBranch('failure', 'handleFailure', failureFn)
    .end()
  .build();

// Using class directly
const builder = new FlowChartBuilder();
builder.start('entry', entryFn);
builder.addFunction('next', nextFn);
const chart = builder.build();

// Execute the chart
const executor = new FlowChartExecutor(chart, scopeFactory);
const result = await executor.run();
```

## Related Modules

- `../executor/` - FlowChartExecutor that runs the built flowchart
- `../executor/Pipeline.ts` - Core execution engine and StageNode type
- `../memory/` - StageContext and PipelineRuntime used during execution
- `../../scope/` - Scope system for consumer state management
