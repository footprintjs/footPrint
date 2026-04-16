---
name: Linear Pipeline
group: Building Blocks
guide: https://footprintjs.github.io/footPrint/guides/building-blocks/stages/
defaultInput: |
  { "userId": 42 }
---

# Linear Pipeline

A **linear pipeline** is the simplest flowchart — stages run one after another in order. No branching, no loops, no parallelism. Just a chain.

```
FetchUser → EnrichProfile → SendWelcomeEmail
```

## When to use

- You have a straight-line workflow: each step depends on the previous one.
- You want the narrative to read top-to-bottom like a story.
- You're just getting started with footprintjs — this is the foundation.

## What you'll see in the trace

When this runs, the narrative tells a story:

```
The process began with FetchUser.
  Step 1: Write user = {...}
Next step: EnrichProfile.
  Step 1: Write displayName = "Alice"
  Step 2: Write memberDays = 42
Next step: SendWelcomeEmail.
  Step 1: Write emailStatus = "sent"
```

Every write is captured. Every stage is named. The flow is self-documenting.

## Key API

- `flowChart<TState>('StageName', fn, 'stage-id')` — declare the first stage and its typed state.
- `.addFunction('StageName', fn, 'stage-id', 'Description')` — chain more stages.
- `.build()` — freeze the definition into a runnable chart.

## Related concepts

- **[Fork](./02-fork.md)** — run stages in parallel instead of sequentially.
- **[Decider](./03-decider.md)** — branch based on a decision.
- **[Full guide](https://footprintjs.github.io/footPrint/guides/building-blocks/stages/)** — deeper dive into stages, TypedScope, and lifecycle.
