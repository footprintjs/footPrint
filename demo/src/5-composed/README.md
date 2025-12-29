# Demo 5: Composed Application (The Power Move)

Mount entire applications as subtrees with `addSubtreeChild()`.

## The Big Idea

**Every demo you've seen (1-4) is a complete application. Now watch them become nodes in a larger workflow.**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         MEGA ORCHESTRATOR APP                                │
│                                                                              │
│  ┌─────────────────┐                                                        │
│  │   Orchestrator  │  ← Entry point                                         │
│  └────────┬────────┘                                                        │
│           │                                                                  │
│     ┌─────┴─────┬─────────────┬─────────────┐                               │
│     ▼           ▼             ▼             ▼                               │
│ ┌───────┐  ┌─────────┐  ┌──────────┐  ┌──────────┐                         │
│ │Payment│  │LLM Loop │  │ Parallel │  │ Selector │  ← Each is a FULL APP!  │
│ │  App  │  │   App   │  │   App    │  │   App    │                         │
│ └───┬───┘  └────┬────┘  └────┬─────┘  └────┬─────┘                         │
│     │           │            │             │                                │
│     └─────┬─────┴────────────┴─────────────┘                               │
│           ▼                                                                  │
│  ┌─────────────────┐                                                        │
│  │    Aggregate    │  ← Receives results from ALL apps                      │
│  └─────────────────┘                                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Why This Matters

1. **Team Autonomy** - Each team owns their app (Payment, LLM, etc.)
2. **Composability** - Apps are building blocks, not monoliths
3. **Testability** - Test each app independently, then test composition
4. **Scalability** - Add new apps without touching existing ones

## Key Concepts

1. **`buildPaymentFlow()`** - Returns `{ root, stageMap }` (a BuiltFlow)
2. **`addSubtreeChild(id, builtFlow)`** - Mount as parallel child
3. **StageMap merging** - All functions from all apps are combined
4. **Result bundling** - Aggregate receives `{ payment: ..., llm: ..., ... }`

## The Code Pattern

```typescript
// Build individual apps
const paymentApp = buildPaymentFlow();
const llmApp = buildLLMToolLoop();
const parallelApp = buildParallelFlow();
const selectorApp = buildSelectorFlow();

// Compose into mega-app
new FlowChartBuilder()
  .start('Orchestrator', orchestrate)
  .addSubtreeChild('payment', paymentApp)
  .addSubtreeChild('llm', llmApp)
  .addSubtreeChild('parallel', parallelApp)
  .addSubtreeChild('selector', selectorApp)
  .addFunction('Aggregate', aggregate)
  .build();
```

## Run

```bash
npx ts-node demo/src/5-composed/index.ts
```
