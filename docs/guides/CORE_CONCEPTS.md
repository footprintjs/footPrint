# Core Concepts

## Pipeline Architecture

FootPrint executes a tree of stages with a unified execution order:

```
stage → commit → children (parallel) → next
```

### Execution Order

1. **Linear node**: Run stage → commit → next
2. **Fork-only**: Run stage → commit → ALL children in parallel → return bundle
3. **Fork + next**: Run stage → commit → ALL children in parallel → next
4. **Decider**: Run stage → commit → decider picks ONE child → execute chosen child

## StageNode

The fundamental unit of a pipeline:

```typescript
type StageNode = {
  name: string;                    // Stage name (stageMap key)
  id?: string;                     // Unique identifier
  fn?: PipelineStageFunction;      // Stage function
  next?: StageNode;                // Linear continuation
  children?: StageNode[];          // Parallel children (fork)
  nextNodeDecider?: Decider;       // Single-choice branching
  nextNodeSelector?: Selector;     // Multi-choice branching
};
```

## Memory Model

FootPrint uses a three-level memory scope:

```
┌─────────────────────────────────────┐
│           GlobalContext             │  ← Shared across all stages
├─────────────────────────────────────┤
│           Path Context              │  ← Shared within a branch
├─────────────────────────────────────┤
│           Node Context              │  ← Stage-local only
└─────────────────────────────────────┘
```

### Patch-Based Updates

Stages write to a local patch. After each stage completes, `commitPatch()` flushes to GlobalContext:

```
Stage A writes → Patch A → commitPatch() → GlobalContext
Stage B reads from GlobalContext
```

## Scope Factory

You provide a factory function that creates scope instances:

```typescript
const scopeFactory = (context: StageContext, stageName: string, readOnly?: unknown) => {
  return new BaseState(context, stageName, readOnly);
};
```

## Break Semantics

Calling `breakFn()` stops execution at the current node:
- Children do NOT run
- Next does NOT run
- Returns the stage's output immediately

```typescript
async function myStage(scope, breakFn) {
  if (shouldStop) {
    breakFn();
    return { stopped: true };
  }
  return { continue: true };
}
```

## Error Handling

When a stage throws:
1. Patch is committed (for forensic data)
2. Error info is added to context
3. Error propagates up

For parallel children, errors are captured per-child:

```typescript
{
  child1: { result: data, isError: false },
  child2: { result: Error, isError: true }
}
```
