# FootPrint Demos

Progressive examples showcasing FlowChartBuilder - from simple linear flows to advanced async patterns with LLM integration.

## Purpose

This demo folder serves as **persistent memory for LLMs** and a comprehensive learning resource for developers. Each demo builds on concepts from previous demos, allowing incremental understanding of the library's capabilities.

## Learning Path

Follow these demos in order to master FootPrint:

There are two demo tracks: a **quick-start track** (concise, pattern-focused) and a **domain track** (detailed, real-world domains with tests).

### Quick-Start Track

| # | Demo | Pattern | Complexity | Key Concepts |
|---|------|---------|------------|--------------|
| 1 | [Payment](./src/1-payment/) | Linear | ⭐ | `start()`, `addFunction()`, scope basics |
| 2 | [LLM Tool Loop](./src/2-llm-tool-loop/) | Decider | ⭐⭐ | `addDeciderFunction()`, conditional branching |
| 3 | [Parallel](./src/3-parallel/) | Fork | ⭐⭐ | `addListOfFunction()`, parallel execution |
| 4 | [Selector](./src/4-selector/) | Selector | ⭐⭐⭐ | `addSelector()`, multi-choice parallel |
| 5 | [Composed](./src/5-composed/) | Composition | ⭐⭐⭐⭐ | `addSubFlowChart()`, apps as building blocks |
| 6 | [Subflow Extractor](./src/6-subflow-extractor/) | Subflow | ⭐⭐⭐ | `TraversalExtractor`, subflow step numbers |
| 7 | [Build vs Runtime](./src/7-build-vs-runtime/) | Extraction | ⭐⭐⭐ | `toSpec()` vs runtime extraction |

### Domain Track (with tests)

| # | Demo | Domain | Pattern | Complexity | Key Concepts |
|---|------|--------|---------|------------|--------------|
| 1 | [Linear Payment](./src/1-linear-payment/) | Payment | Linear | ⭐ | `start()`, `addFunction()`, `scope.setValue/getValue` |
| 2 | [Parallel Shipping](./src/2-parallel-shipping/) | Shipping | Fork-Join | ⭐⭐ | `addListOfFunction()`, parallel execution, timing |
| 3 | [Decider Order](./src/3-decider-order/) | Order Processing | Decider | ⭐⭐ | `addDeciderFunction()`, single-choice branching |

---

## Prerequisites (Quick-Start Track)

```
Demo 1 (Payment/Linear)
    ↓
Demo 2 (LLM Tool Loop/Decider) ← Builds on: scope operations
    ↓
Demo 3 (Parallel/Fork) ← Builds on: linear + branching concepts
    ↓
Demo 4 (Selector) ← Builds on: decider + parallel concepts
    ↓
Demo 5 (Composed) ← Builds on: all branching patterns
    ↓
Demo 6 (Subflow Extractor) ← Builds on: subflow composition
    ↓
Demo 7 (Build vs Runtime) ← Builds on: extraction concepts
```

---

## Quick Start

```bash
# From FootPrint root directory

# Quick-Start Track
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/1-payment/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/2-llm-tool-loop/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/3-parallel/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/4-selector/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/5-composed/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/6-subflow-extractor/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/7-build-vs-runtime/index.ts

# Domain Track
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/1-linear-payment/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/2-parallel-shipping/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/3-decider-order/index.ts

# Run demo tests
npm test -- --testPathPattern="demo/src"
```

---

## Pattern Overview

### 1. Linear (Demo 1)

Sequential execution: `A → B → C → D`

```typescript
new FlowChartBuilder()
  .start('ValidateCart', validateCart)
  .addFunction('ProcessPayment', processPayment)
  .addFunction('UpdateInventory', updateInventory)
  .addFunction('SendReceipt', sendReceipt);
```

**WHY**: The foundation of all pipelines. Understand scope operations before adding complexity.

### 2. Fork-Join / Parallel (Demo 2)

Parallel execution: `A → [B1, B2, B3] → C`

```typescript
new FlowChartBuilder()
  .start('PrepareShipment', prepareShipment)
  .addListOfFunction([
    { id: 'rate', name: 'CalculateRate', fn: calculateRate },
    { id: 'inventory', name: 'CheckInventory', fn: checkInventory },
    { id: 'address', name: 'ValidateAddress', fn: validateAddress },
  ])
  .addFunction('CreateLabel', createLabel);
```

**WHY**: Enables concurrent operations. Total time = max(child times), not sum.

### 3. Decider (Demo 3)

Single-choice branching: `A → ? → (B1 OR B2 OR B3)`

```typescript
new FlowChartBuilder()
  .start('AnalyzeOrder', analyzeOrder)
  .addDeciderFunction('FulfillmentDecider', (scope) => scope.getValue('fulfillmentType'))
    .addFunctionBranch('standard', 'StandardFulfillment', standardFulfillment)
    .addFunctionBranch('express', 'ExpressFulfillment', expressFulfillment)
    .addFunctionBranch('digital', 'DigitalDelivery', digitalDelivery)
    .end();
```

**WHY**: Routes execution based on runtime conditions. Exactly ONE branch executes.

### 4. Selector (Demo 4)

Multi-choice parallel: `A → ? → [selected subset] → C`

```typescript
new FlowChartBuilder()
  .start('AnalyzeTicket', analyzeTicket)
  .addSelector((output) => output.actions) // Returns array of branch IDs
    .addFunctionBranch('notify', 'NotifyAgent', notifyAgent)
    .addFunctionBranch('reply', 'SendAutoReply', sendAutoReply)
    .addFunctionBranch('escalate', 'EscalateManager', escalateManager)
    .addFunctionBranch('log', 'LogAnalytics', logAnalytics)
    .end()
  .addFunction('CloseTicket', closeTicket);
```

**WHY**: When multiple actions should happen based on conditions. Zero, one, or many branches execute in parallel.

### 5. Composition (Demo 5)

Mount entire flowcharts as nodes in larger workflows:

```typescript
const subflow = new FlowChartBuilder()
  .start('SubEntry', subEntryFn)
  .addFunction('SubProcess', subProcessFn)
  .build();

new FlowChartBuilder()
  .start('MainEntry', mainEntryFn)
  .addSubFlowChart('sub', subflow, 'SubflowName')
  .addFunction('Aggregate', aggregateFn);
```

**WHY**: Enables modular, testable pipeline components. Apps become reusable building blocks.

### 6. Subflow Extractor (Demo 6)

TraversalExtractor with subflow step numbering:

```typescript
const chart = flowChart('PrepareRequest', prepareFn)
  .addSubFlowChart('llm', llmSubflow, 'LLM Core')
  .addFunction('AggregateResults', aggregateFn)
  .addTraversalExtractor((snapshot) => ({
    stageName: snapshot.node.name,
    stepNumber: snapshot.stepNumber,
  }))
  .build();
```

**WHY**: Step numbers increment through subflows, enabling unified execution tracing.

### 7. Build vs Runtime (Demo 7)

Two types of extraction:

```typescript
// Build-time: static structure (no functions)
const spec = chart.toSpec();

// Runtime: dynamic execution data
const executor = new FlowChartExecutor(chart, scopeFactory);
await executor.run();
const results = executor.getExtractedResults();
```

**WHY**: `toSpec()` gives you JSON-serializable structure for FE-BE transport. Runtime extraction gives you actual execution data.

---

## Key Concepts Reference

### Scope Operations

```typescript
// Write to scope (buffered until commit)
scope.setValue('key', value);

// Read from scope
const value = scope.getValue('key');

// Commit writes (usually automatic at stage end)
scope.commit();
```

### GlobalStore & pipelineId

```typescript
// GlobalStore provides shared state across stages
// pipelineId creates isolated namespaces for concurrent executions

const store = new GlobalStore('unique-pipeline-id');
// All scope operations are namespaced by pipelineId
```

### SubflowInputMapper

```typescript
// Controls what data flows from parent to subflow
const inputMapper = (parentScope: BaseState) => ({
  // Extract specific values from parent scope
  orderId: parentScope.getValue('orderId'),
  customerId: parentScope.getValue('customerId'),
});

// Subflow starts with these values in its isolated scope
```

### Recorders

```typescript
// MetricRecorder: Captures timing and operation counts
// DebugRecorder: Captures detailed operation logs

scope.addRecorder(new MetricRecorder());
scope.addRecorder(new DebugRecorder());
```

---

## Demo Structure

Each demo folder contains:

```
demo/src/{n}-{name}/
├── index.ts           # Runnable demo code with comprehensive JSDoc
├── index.test.ts      # Tests using GIVEN/WHEN/THEN format
├── index.property.test.ts  # Property-based tests (for complex demos)
└── README.md          # Explanation with WHY, KEY CONCEPTS, BUILDS ON
```

---

## Shared Test Utilities

Located in `demo/shared/test-utils.ts`:

```typescript
import {
  createTestScopeFactory,    // Scope factory with optional recording
  createExecutionTracker,    // Track stage execution order/timing
  assertExecutionOrder,      // Verify linear execution order
  assertAllStagesExecuted,   // Verify all stages ran (order doesn't matter)
  assertParallelExecution,   // Verify parallel timing
  createDelayedOperation,    // Create async operations with known delay
} from '../shared/test-utils';
```

---

## Related Documentation

- [Architecture Overview](../docs/architecture/) - System design documents
- [Memory Model](../docs/architecture/MEMORY_MODEL.md) - Scope and GlobalStore details
- [API Reference](../src/index.ts) - Public API exports
