# FootPrint Demos

Progressive examples showcasing FlowChartBuilder - from simple linear flows to complex composed applications.

## Learning Path

Follow these demos in order to master FootPrint:

| # | Demo | Pattern | Complexity | Time | Key Concept |
|---|------|---------|------------|------|-------------|
| 1 | [Payment](./src/1-payment/) | Linear | ⭐ | 5 min | Basic chaining with `start()` → `addFunction()` |
| 2 | [LLM Tool Loop](./src/2-llm-tool-loop/) | Decider | ⭐⭐ | 10 min | Conditional branching with `addDecider()` |
| 3 | [Parallel](./src/3-parallel/) | Fork | ⭐⭐ | 10 min | Parallel execution with `addListOfFunction()` |
| 4 | [Selector](./src/4-selector/) | Selector | ⭐⭐⭐ | 15 min | Multi-choice parallel with `addSelector()` |
| 5 | [Composed](./src/5-composed/) | Composition | ⭐⭐⭐⭐ | 20 min | Mount entire apps as subtrees |
| 6 | [Subflow Extractor](./src/6-subflow-extractor/) | Extraction | ⭐⭐⭐ | 10 min | TraversalExtractor with subflows |
| 7 | [Build vs Runtime](./src/7-build-vs-runtime/) | Extraction | ⭐⭐⭐ | 10 min | Build-time vs runtime extraction |

**Total learning time: ~1.5 hours**

---

## Quick Start

```bash
# From footprint root directory

# Run any demo
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/1-payment/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/2-llm-tool-loop/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/3-parallel/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/4-selector/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/5-composed/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/6-subflow-extractor/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/7-build-vs-runtime/index.ts
```

---

## Pattern Overview

### 1. Linear (Demo 1)

Sequential execution: `A → B → C`

```typescript
new FlowChartBuilder()
  .start('A', aFn)
  .addFunction('B', bFn)
  .addFunction('C', cFn);
```

### 2. Decider (Demo 2)

Single-choice branching: `A → ? → (B1 OR B2)`

```typescript
new FlowChartBuilder()
  .start('A', aFn)
  .addDecider((output) => output.route)
    .addFunctionBranch('b1', 'B1', b1Fn)
    .addFunctionBranch('b2', 'B2', b2Fn)
    .end();
```

### 3. Fork (Demo 3)

Parallel execution: `A → [B1, B2, B3] → C`

```typescript
new FlowChartBuilder()
  .start('A', aFn)
  .addListOfFunction([
    { id: 'b1', name: 'B1', fn: b1Fn },
    { id: 'b2', name: 'B2', fn: b2Fn },
    { id: 'b3', name: 'B3', fn: b3Fn },
  ])
  .addFunction('C', cFn);
```

### 4. Selector (Demo 4)

Multi-choice parallel: `A → ? → [selected subset] → C`

```typescript
new FlowChartBuilder()
  .start('A', aFn)
  .addSelector((output) => output.selectedIds)
    .addFunctionBranch('b1', 'B1', b1Fn)
    .addFunctionBranch('b2', 'B2', b2Fn)
    .addFunctionBranch('b3', 'B3', b3Fn)
    .end()
  .addFunction('C', cFn);
```

### 5. Composition (Demo 5)

Apps as building blocks:

```typescript
const subApp = new FlowChartBuilder()
  .start('SubEntry', subFn)
  .build();

new FlowChartBuilder()
  .start('Main', mainFn)
  .addSubFlowChart('sub', subApp, 'SubApp')
  .addFunction('Aggregate', aggregateFn);
```

### 6. Subflow Extractor (Demo 6)

TraversalExtractor with subflows - stepNumber generation:

```typescript
const extractor: TraversalExtractor = (snapshot) => ({
  stageName: snapshot.node.name,
  stepNumber: snapshot.stepNumber, // 1-based execution order
  isSubflow: Boolean(snapshot.node.isSubflowRoot),
});

new FlowChartBuilder()
  .start('entry', entryFn)
  .addSubFlowChart('llm-core', llmCore, 'LLM Core')
  .addTraversalExtractor(extractor);
```

### 7. Build vs Runtime (Demo 7)

Structure vs execution separation:

```typescript
// Build-time: Static structure for FE→BE transport
const buildExtractor: BuildTimeExtractor = (metadata) => ({
  id: metadata.id,
  type: computeType(metadata),
});
const spec = builder.toSpec();

// Runtime: Execution metadata with stepNumber
const runtimeExtractor: TraversalExtractor = (snapshot) => ({
  stepNumber: snapshot.stepNumber,
  output: snapshot.context.getScope()?.output,
});
const results = pipeline.getExtractedResults();
```

---

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

---

## Demo Structure

Each demo folder contains:

```
demo/src/{n}-{name}/
├── index.ts    # Runnable demo code
└── README.md   # Explanation and key concepts
```

---

## Related Documentation

- [Getting Started](../docs/guides/GETTING_STARTED.md) - Installation and basics
- [Patterns](../docs/guides/PATTERNS.md) - Detailed pattern documentation
- [FlowChartBuilder API](../docs/guides/FLOWCHART_BUILDER.md) - Complete API reference
