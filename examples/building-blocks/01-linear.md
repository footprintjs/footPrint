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
Stage 1: The process began with FetchUser.
Step 1: Write user = {username, email, joinedAt}
Stage 2: Next, it moved on to EnrichProfile.
Step 1: Read user = {username, email, joinedAt}
Step 2: Read user = {username, email, joinedAt}
Step 3: Read user = {username, email, joinedAt}
Step 4: Write displayName = "Alice"
Step 5: Write memberDays = 1030
Step 6: Write tier = "veteran"
Stage 3: Next, it moved on to SendWelcomeEmail.
Step 1: Read tier = "veteran"
Step 2: Read displayName = "Alice"
Step 3: Read user = {username, email, joinedAt}
Step 4: Write emailSent = true
Step 5: Write greeting = "Welcome back, Alice! Thanks for being a loyal member."
```

(`memberDays` counts days since `joinedAt`, so it grows each day.)

Every write is captured. Every stage is named. The flow is self-documenting.

## Key API

- `flowChart<TState>('StageName', fn, 'stage-id')` — declare the first stage and its typed state.
- `.addFunction('StageName', fn, 'stage-id', 'Description')` — chain more stages.
- `.build()` — freeze the definition into a runnable chart.

## Related concepts

- **[Fork](./02-fork.md)** — run stages in parallel instead of sequentially.
- **[Decider](./03-decider.md)** — branch based on a decision.
- **[Full guide](https://footprintjs.github.io/footPrint/guides/building-blocks/stages/)** — deeper dive into stages, TypedScope, and lifecycle.
