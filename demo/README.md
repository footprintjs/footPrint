# FootPrint Demos

This folder contains progressive demos showcasing the power of FlowChartBuilder - from simple linear flows to complex composed applications.

## Demo Overview

| Demo | Pattern | Complexity | Key Concept |
|------|---------|------------|-------------|
| 1-payment | Linear | ⭐ | Basic chaining with `start()` → `addFunction()` |
| 2-llm-tool-loop | Decider | ⭐⭐ | Conditional branching with `addDecider()` |
| 3-parallel | Fork | ⭐⭐ | Parallel execution with `addListOfFunction()` |
| 4-selector | Selector | ⭐⭐⭐ | Multi-choice parallel with `addSelector()` |
| 5-composed | Composition | ⭐⭐⭐⭐ | Mount entire apps as subtrees |

## The Power of Composition

The final demo (5-composed) demonstrates the killer feature: **entire applications can be composed as nodes in a larger workflow**.

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

## Running the Demos

```bash
# From footprint root

# Run individual demo (uses tsconfig-paths to resolve footprint)
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/1-payment/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/2-llm-tool-loop/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/3-parallel/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/4-selector/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/5-composed/index.ts
```

## Learning Path

1. **Start with Payment Demo** - Understand basic linear flow
2. **Move to LLM Tool Loop** - Learn conditional branching
3. **Explore Parallel Demo** - See fork/join patterns
4. **Try Selector Demo** - Multi-choice parallel execution
5. **Study Composed Demo** - See how apps become building blocks
