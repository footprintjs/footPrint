# Scope Isolation Design Decision

## Overview

This document explains why FootPrint uses **isolated scopes for subflows** instead of parent scope traversal, and why this is the recommended pattern for modular, reusable pipelines.

## The Design Decision

**FootPrint intentionally does NOT implement parent scope traversal for subflows.**

When a subflow executes, it gets its own isolated `PipelineRuntime` with its own `GlobalStore`. Subflows cannot implicitly read values from their parent flow's scope.

## Why Not Parent Traversal?

### What Parent Traversal Would Look Like

```
Parent Flow Scope
├── userQuery: "What step are we on?"
├── sessionId: "abc123"
└── config: { timeout: 5000 }
    │
    └── Subflow Scope (would inherit parent values)
        ├── tierExecutionState: {...}
        └── (reads userQuery from parent automatically)
```

### Why We Rejected This

| Concern | Parent Traversal | Isolated Scopes (Current) |
|---------|------------------|---------------------------|
| **Predictability** | Value could come from anywhere up the chain | Value comes from ONE place |
| **Testability** | Must mock entire parent hierarchy | Test subflow in complete isolation |
| **Reusability** | Subflow depends on parent's scope shape | Same subflow works in ANY parent |
| **Debugging** | "Where did this value come from?" | Clear data origin |
| **Name Collisions** | Parent's `config` vs subflow's `config` | No collision - isolated |

## The Correct Pattern: Explicit Data Passing

### How Subflows Get Parent Data

Data flows into subflows explicitly via the scope factory or initial context:

```typescript
// Parent flow mounts subflow with explicit inputs
.addSubFlowChartNext('smart-context-finder', smartContextFinderFlow, {
  // Explicitly pass what the subflow needs
  userQuery: parentScope.userQuery,
  sessionContexts: parentScope.sessionContexts,
})
```

### How Subflows Read Their Inputs

Subflows read from their own scope, with clear expectations:

```typescript
// In subflow's extractInput stage
async function extractInputStage(scope: SmartContextFinderScope): Promise<void> {
  // Read from OWN scope - data was passed in explicitly
  const userQuery = scope.getValue?.([], 'userQuery') ?? scope.userQuery;
  const sessionContexts = scope.getValue?.([], 'sessionContexts') ?? scope.sessionContexts;
  
  // Process inputs...
}
```

## Industry Precedents

This pattern follows established software design principles:

| System | Pattern | Analogy |
|--------|---------|---------|
| **React** | Props down, events up | No implicit parent state access |
| **Microservices** | Explicit API contracts | Services don't share memory |
| **Unix Pipes** | stdin/stdout | Not shared memory |
| **Function Calls** | Parameters, not globals | Explicit arguments |

## Namespace-Based Scoping vs Parent Traversal

These are often confused but serve different purposes:

### Namespace-Based Scoping (What We Have)

Within a SINGLE flow, stages share state via `pipelineId` namespace:

```typescript
// Stage A writes
scope.setValue('result', { value: 42 });

// Stage B reads (same flow)
const result = scope.getValue('result'); // Gets { value: 42 }
```

The lookup is flat: `WriteBuffer → GlobalStore[pipelineId]`

### Parent Traversal (What We Don't Have)

Would allow subflows to read from parent's namespace:

```typescript
// Parent flow has
parentScope.userQuery = "Hello";

// Subflow would automatically see it (NOT IMPLEMENTED)
const query = subflowScope.getValue('userQuery'); // Would find parent's value
```

The lookup would be chained: `local → parent → grandparent → global`

## Common Pitfall: Read-After-Write

A related but different issue is read-after-write within the SAME scope:

```typescript
// ❌ WRONG - reads initial value, ignores staged writes
const state = scope.tierExecutionState ?? scope.getValue?.([], 'tierExecutionState');

// ✅ CORRECT - reads staged writes first
const state = (scope.getValue?.([], 'tierExecutionState') as TierExecutionState | undefined) 
  ?? scope.tierExecutionState;
```

This is about read order within ONE scope, not parent-child traversal.

## Example: SmartContextFinder Subflow

### Subflow Definition

```typescript
// Creates an isolated, reusable subflow
export function createSmartContextFinderSubGraph(): FlowChart<Output, Scope> {
  return new FlowChartBuilder<any, SmartContextFinderScope>()
    .start('extractInput', extractInputStage)
    .addFunction('keywordMatcher', keywordMatcherStage)
    .addDeciderFunction('DecideKeywordMatch', (scope) => scope.get('keywordMatchResult'))
      .addFunctionBranch('matched', 'finalize', finalizeResultStage)
      .addFunctionBranch('not_matched', 'checkPinned', checkPinnedContextStage)
    .end()
    .build();
}
```

### Mounting in Parent Flow

```typescript
// Parent flow explicitly provides inputs
const chatFlow = new FlowChartBuilder()
  .start('parseInput', parseInputStage)
  .addFunction('prepareContext', (scope) => {
    // Prepare data for subflow
    scope.setObject([], 'userQuery', scope.rawInput);
    scope.setObject([], 'sessionContexts', scope.contexts);
  })
  .addSubFlowChartNext('smart-context-finder', createSmartContextFinderSubGraph())
  .addFunction('handleResult', handleResultStage)
  .build();
```

### Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      Parent Flow                            │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │ parseInput  │───►│prepareContext│───►│handleResult │     │
│  └─────────────┘    └──────┬──────┘    └─────────────┘     │
│                            │                                │
│                   Explicit Data Pass                        │
│                   (userQuery, contexts)                     │
│                            │                                │
│                            ▼                                │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              SmartContextFinder Subflow              │   │
│  │              (Isolated PipelineRuntime)              │   │
│  │  ┌───────────┐  ┌─────────────┐  ┌──────────────┐   │   │
│  │  │extractInput│─►│keywordMatcher│─►│finalizeResult│   │   │
│  │  └───────────┘  └─────────────┘  └──────────────┘   │   │
│  │                                                      │   │
│  │  Own scope: userQuery, sessionContexts,              │   │
│  │             tierExecutionState, resolvedContext      │   │
│  └─────────────────────────────────────────────────────┘   │
│                            │                                │
│                   Result returned                           │
│                            ▼                                │
│                     handleResult                            │
└─────────────────────────────────────────────────────────────┘
```

## Benefits Summary

1. **Testability** - Test subflows in complete isolation
2. **Reusability** - Same subflow works in any parent flow
3. **Predictability** - Data origin is always clear
4. **No Name Collisions** - Parent and subflow can use same property names
5. **Explicit Contracts** - Data dependencies are visible in code
6. **Debugging** - No "where did this value come from?" mysteries

## When You Might Think You Need Parent Traversal

| Scenario | Solution |
|----------|----------|
| Subflow needs parent's config | Pass config explicitly when mounting |
| Subflow needs user input | Pass via scope factory |
| Subflow needs session data | Include in initial context |
| Multiple subflows need same data | Pass to each explicitly |

## Technical References

- `src/core/pipeline/Pipeline.ts` - `executeSubflow()` creates isolated context
- `src/core/context/StageContext.ts` - `getValue()` lookup implementation
- `src/core/context/PipelineRuntime.ts` - Runtime isolation
- `docs/SUBGRAPH_ARCHITECTURE.md` - Subflow mounting patterns

## Conclusion

**Explicit data passing > Implicit parent traversal**

The isolated subflow design makes FootPrint pipelines more modular, testable, and maintainable. While it requires slightly more explicit code when mounting subflows, the benefits in clarity and reusability far outweigh the cost.
