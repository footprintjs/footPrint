# Demo 5: Composed Application

**Pattern:** Composition  
**Complexity:** ⭐⭐⭐⭐  
**Time:** 20 minutes

## What You'll Learn

- Mounting entire applications as subtrees with `addSubFlowChart()`
- Building mega-apps from smaller, tested components
- The "apps as building blocks" mental model

## The Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    COMPOSED APP                              │
│  ┌─────────────┐                                            │
│  │ Orchestrator│                                            │
│  └──────┬──────┘                                            │
│         │                                                    │
│    ┌────┴────┬────────┬────────┐                            │
│    ▼         ▼        ▼        ▼                            │
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                        │
│ │Payment│ │ LLM  │ │Parallel│ │Selector│  ← Each is a      │
│ │ App  │ │ App  │ │  App  │ │  App  │    complete app!    │
│ └──────┘ └──────┘ └──────┘ └──────┘                        │
│    │         │        │        │                            │
│    └────┬────┴────────┴────────┘                            │
│         ▼                                                    │
│  ┌─────────────┐                                            │
│  │  Aggregate  │                                            │
│  └─────────────┘                                            │
└─────────────────────────────────────────────────────────────┘
```

## Key Concepts

### 1. Apps as Building Blocks

Each sub-app is a complete, testable workflow:

```typescript
function buildPaymentApp(): BuiltFlow {
  return new FlowChartBuilder()
    .start('ValidateCart', validateFn)
    .addFunction('ProcessPayment', paymentFn)
    .build();
}

function buildLLMApp(): BuiltFlow {
  return new FlowChartBuilder()
    .start('CallLLM', llmFn)
    .addFunction('FormatResponse', formatFn)
    .build();
}
```

### 2. Composing with addSubFlowChart()

Mount pre-built apps as children in a larger workflow:

```typescript
const paymentApp = buildPaymentApp();
const llmApp = buildLLMApp();

new FlowChartBuilder()
  .start('Orchestrator', orchestrateFn)
  .addSubFlowChart('payment', paymentApp, 'PaymentApp')
  .addSubFlowChart('llm', llmApp, 'LLMApp')
  .addFunction('Aggregate', aggregateFn)
  .build();
```

### 3. StageMap Merging

All functions from all apps are merged into a single stageMap:

```typescript
const { root, stageMap } = buildMegaApp();

// stageMap contains functions from ALL apps:
// - Orchestrator
// - ValidateCart, ProcessPayment (from PaymentApp)
// - CallLLM, FormatResponse (from LLMApp)
// - Aggregate
```

### 4. Independent Development

Each app can be:
- Developed independently
- Unit tested in isolation
- Deployed as a standalone service
- Composed into larger systems

## Run It

```bash
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/5-composed/index.ts
```

## Expected Output

```
============================================================
  COMPOSED APPLICATION DEMO (The Power Move)
============================================================

  4 complete applications running as nodes in 1 mega-app!

  StageMap contains 12 functions from all apps:
    - Orchestrator
    - ValidateCart
    - ProcessPayment
    - CallLLM
    - FormatResponse
    - ParallelEntry
    - FetchA
    - FetchB
    - AnalyzeSelector
    - SendEmailSelector
    - SendPushSelector
    - Aggregate

------------------------------------------------------------
  EXECUTION
------------------------------------------------------------

  [Orchestrator] Starting mega workflow...
  [Orchestrator] Launching 4 sub-applications in parallel!

    [Payment] Validating cart...
    [Payment] Processing payment...
    [LLM] Calling LLM...
    [LLM] Formatting response...
    [Parallel] Fetching A...
    [Parallel] Fetching B...
    [Selector] Analyzing...
    [Selector] Sending email...
    [Selector] Sending push...

  [Aggregate] Collecting results from all apps...

------------------------------------------------------------
  RESULTS
------------------------------------------------------------

  Execution time: 45ms
  Final result: {
    "completed": true,
    "appsExecuted": ["payment", "llm", "parallel", "selector"]
  }

============================================================
  ✓ MEGA APP COMPLETE!
============================================================

  Key insight: Each "app" (Payment, LLM, Parallel, Selector)
  is a complete workflow that can be developed, tested, and
  deployed independently - then composed into larger systems.
```

## Real-World Use Cases

- **Microservice Orchestration**: Compose service calls into workflows
- **Multi-Tenant Systems**: Different apps for different customer tiers
- **Feature Modules**: Plug-and-play feature modules
- **Testing**: Mock entire sub-apps for integration testing

## The Power Move

This is FootPrint's killer feature:

1. **Build small, focused apps** - Each does one thing well
2. **Test them independently** - Unit tests, integration tests
3. **Compose into larger systems** - Apps become nodes
4. **Scale complexity** - Mega-apps from simple building blocks

```
Small App → Tested App → Composed App → Mega App
```

## Back to Start

← [Demo 1: Payment](../1-payment/) - Review the basics
