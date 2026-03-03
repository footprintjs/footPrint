# Core Module

## Purpose

This folder contains the public API layer of FootPrint. It provides the primary building blocks for constructing and executing flowchart-based pipelines. Consumers should import from this module for all core functionality.

The core module is the "what you use" layer - it exposes stable APIs that consumers depend on, while hiding implementation details in the `internal/` module.

## Key Concepts

- **Builder**: FlowChartBuilder for constructing pipeline structures
- **Executor**: FlowChartExecutor for running pipelines
- **Memory**: StageContext, GlobalStore, PipelineRuntime for state management
- **Handlers**: Extracted execution handlers (StageRunner, NodeResolver, etc.)

## Design Decisions

1. **Public API Layer**: This module contains only exports intended for consumer use. Internal implementation details live in `../internal/`.

2. **Barrel Exports**: Each submodule has an `index.ts` barrel export, and `core/index.ts` re-exports everything. Consumers can import from `core/` or from specific submodules.

3. **Backward Compatibility**: Old import paths (e.g., `src/builder/`, `src/core/pipeline/`) have re-exports pointing to the new locations. This allows gradual migration.

4. **Separation of Concerns**:
   - `builder/` - Pipeline construction (build-time)
   - `executor/` - Pipeline execution (run-time)
   - `memory/` - State management (shared)

## Files Overview

| Folder | Purpose |
|--------|---------|
| `builder/` | FlowChartBuilder for constructing pipelines |
| `executor/` | FlowChartExecutor, Pipeline, and execution handlers |
| `memory/` | StageContext, GlobalStore, PipelineRuntime |
| `index.ts` | Barrel export for all core exports |

## Usage Example

```typescript
// Import everything from core
import {
  flowChart,
  FlowChartExecutor,
  StageContext,
} from './core';

// Or import from specific submodules
import { flowChart } from './core/builder';
import { FlowChartExecutor } from './core/executor';
import { StageContext } from './core/memory';

// Build a pipeline
const chart = flowChart('entry', async (ctx) => {
  ctx.setGlobal('started', true);
  return { success: true };
})
.addFunction('process', processFn)
.build();

// Execute
const executor = new FlowChartExecutor(chart, scopeFactory);
const result = await executor.run();
```

## Related Modules

- `../internal/` - Internal implementation details (WriteBuffer, ExecutionHistory)
- `../scope/` - Consumer extensibility layer (Scope, recorders, providers)
- `../utils/` - Shared utilities (logger, scopeLog)
