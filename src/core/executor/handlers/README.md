# Executor Handlers

## Purpose

This folder contains extracted handler modules that implement specific execution behaviors for the Pipeline. Each handler follows the Single Responsibility Principle, making the codebase more testable and maintainable.

The handlers were extracted from the monolithic `Pipeline.ts` to enable:
- Independent unit testing of each behavior
- Easier reasoning about specific execution patterns
- Better code organization following SRP

## Key Concepts

- **StageRunner**: Executes individual stage functions with streaming support
- **NodeResolver**: Resolves stage functions and subflow references
- **ChildrenExecutor**: Handles parallel children execution (fork pattern)
- **SubflowExecutor**: Executes subflows with isolated contexts
- **SubflowInputMapper**: Maps data between parent and subflow scopes
- **LoopHandler**: Handles dynamic next and loop-back logic
- **DeciderHandler**: Evaluates deciders and routes to chosen branches

## Design Decisions

1. **Dependency Injection via PipelineContext**: All handlers receive a `PipelineContext` object containing shared state (stageMap, pipelineRuntime, etc.). This avoids circular dependencies and enables testing with mock contexts.

2. **Callback Pattern for Recursion**: Handlers that need to recurse back into Pipeline (e.g., ChildrenExecutor calling executeNode) receive callbacks rather than direct Pipeline references. This maintains loose coupling.

3. **Stateless Handlers**: Handlers are designed to be stateless - all state lives in PipelineContext or is passed as parameters. This makes them easier to test and reason about.

4. **Extracted from Pipeline.ts**: These modules were extracted during the pipeline-modular-refactor and pipeline-phase2-handlers specs to improve testability and maintainability.

## Files Overview

| File | Purpose |
|------|---------|
| `StageRunner.ts` | Executes individual stage functions with streaming support |
| `NodeResolver.ts` | Resolves stage functions from stageMap and subflow references |
| `ChildrenExecutor.ts` | Executes parallel children (fork pattern) with throttling support |
| `SubflowExecutor.ts` | Executes subflows with isolated nested contexts |
| `SubflowInputMapper.ts` | Maps input/output data between parent and subflow scopes |
| `LoopHandler.ts` | Handles dynamic next nodes and loop-back iteration counting |
| `DeciderHandler.ts` | Evaluates decider functions and routes to chosen branches |
| `ExtractorRunner.ts` | Runs traversal extractors to capture per-stage snapshots |
| `RuntimeStructureManager.ts` | Manages runtime structure resolution for subflows and dynamic children |
| `index.ts` | Barrel export for all handlers |

## Usage Example

```typescript
// Handlers are typically used internally by Pipeline, but can be tested directly:
import { StageRunner, NodeResolver, PipelineContext } from './handlers';

// Create a mock context for testing
const mockContext: PipelineContext = {
  stageMap: new Map(),
  root: { name: 'root' },
  pipelineRuntime: mockRuntime,
  ScopeFactory: mockFactory,
  scopeProtectionMode: 'error',
};

// Test a handler in isolation
const stageRunner = new StageRunner(mockContext);
const result = await stageRunner.run(node, stageFunc, stageContext, breakFn);
```

## Related Modules

- `../Pipeline.ts` - Core execution engine that coordinates these handlers
- `../FlowChartExecutor.ts` - Public API wrapper around Pipeline
- `../types.ts` - Type definitions used by handlers
- `../../memory/` - StageContext and PipelineRuntime used by handlers
