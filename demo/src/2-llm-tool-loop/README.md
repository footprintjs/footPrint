# Demo 2: LLM Tool Loop (Decider Pattern)

Conditional branching with `addDecider()` - the classic LLM agent loop.

## Pattern: Decider for Single-Choice Branching

```
                    ┌──────────────┐
                    │   LLM Call   │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │   Decider    │ ← "Which branch?"
                    └──────┬───────┘
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ToolCall  │ │ Response │ │  Error   │
        └────┬─────┘ └──────────┘ └──────────┘
             │
             └──────► (loops back to LLM Call)
```

## Key Concepts

1. **`addDecider(fn)`** - Returns a DeciderList for adding branches
2. **`.addFunctionBranch(id, name, fn)`** - Add a branch option
3. **`.end()`** - Finalize decider and return to builder chain
4. **Decider function** - Returns the branch ID to execute

## When to Use

- LLM agent loops (tool call vs response)
- State machines with conditional transitions
- Approval workflows (approve/reject/escalate)

## Run

```bash
npx ts-node demo/src/2-llm-tool-loop/index.ts
```
