# FootPrint Demos

Progressive examples showcasing FlowChartBuilder - from simple linear flows to advanced async patterns with LLM integration.

## Purpose

This demo folder serves as **persistent memory for LLMs** and a comprehensive learning resource for developers. Each demo builds on concepts from previous demos, allowing incremental understanding of the library's capabilities.

## Learning Path

Follow these demos in order to master FootPrint:

| # | Demo | Domain | Pattern | Complexity | Time | Key Concepts |
|---|------|--------|---------|------------|------|--------------|
| 1 | [Linear Payment](./src/1-linear-payment/) | Payment | Linear | ⭐ | 5 min | `start()`, `addFunction()`, `scope.setValue/getValue` |
| 2 | [Parallel Shipping](./src/2-parallel-shipping/) | Shipping | Fork-Join | ⭐⭐ | 10 min | `addListOfFunction()`, parallel execution, timing |
| 3 | [Decider Order](./src/3-decider-order/) | Order Processing | Decider | ⭐⭐ | 10 min | `addDecider()`, single-choice branching |
| 4 | [Selector Support](./src/4-selector-support/) | Customer Support | Selector | ⭐⭐⭐ | 15 min | `addSelector()`, multi-choice parallel |
| 5 | [Subflow Inventory](./src/5-subflow-inventory/) | Inventory | Subflow | ⭐⭐⭐ | 15 min | `addSubFlowChart()`, SubflowInputMapper, scope isolation |
| 6 | [Subflow Decider Fulfillment](./src/6-subflow-decider-fulfillment/) | Fulfillment | Subflow+Decider | ⭐⭐⭐⭐ | 20 min | Complex subflows with internal branching |
| 7 | [Nested Subflows Checkout](./src/7-nested-subflows-checkout/) | E-commerce | Nested Subflows | ⭐⭐⭐⭐ | 20 min | Subflows containing subflows, scope inheritance |
| 8 | [Async Race Multi-Tenant](./src/8-async-race-multitenant/) | Multi-Tenant | Async/Race | ⭐⭐⭐⭐⭐ | 25 min | pipelineId isolation, race conditions, GlobalStore |
| 9 | [Metrics Debug LLM](./src/9-metrics-debug-llm/) | AI Assistant | Advanced | ⭐⭐⭐⭐⭐ | 30 min | MetricRecorder, DebugRecorder, LLM tool loop |

**Total learning time: ~2.5 hours**

---

## Prerequisites by Demo

```
Demo 1 (Linear)
    ↓
Demo 2 (Parallel) ← Builds on: scope operations
    ↓
Demo 3 (Decider) ← Builds on: parallel concepts
    ↓
Demo 4 (Selector) ← Builds on: decider concepts
    ↓
Demo 5 (Subflow) ← Builds on: all branching patterns
    ↓
Demo 6 (Subflow+Decider) ← Builds on: subflow basics
    ↓
Demo 7 (Nested Subflows) ← Builds on: subflow composition
    ↓
Demo 8 (Async/Race) ← Builds on: all composition patterns
    ↓
Demo 9 (Metrics/LLM) ← Builds on: async patterns
```

---

## Quick Start

```bash
# From FootPrint root directory

# Run any demo
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/1-linear-payment/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/2-parallel-shipping/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/3-decider-order/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/4-selector-support/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/5-subflow-inventory/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/6-subflow-decider-fulfillment/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/7-nested-subflows-checkout/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/8-async-race-multitenant/index.ts
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/9-metrics-debug-llm/index.ts

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
  .addDecider((output) => output.fulfillmentType)
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

### 5. Subflow (Demo 5)

Reusable pipeline composition:

```typescript
// Define reusable subflow
const inventoryAuditSubflow = new FlowChartBuilder()
  .start('ScanItems', scanItems)
  .addFunction('VerifyCounts', verifyCounts)
  .build();

// Mount in parent pipeline
new FlowChartBuilder()
  .start('CheckStock', checkStock)
  .addSubFlowChart('audit', inventoryAuditSubflow, 'InventoryAudit', {
    inputMapper: (parentScope) => ({
      warehouseId: parentScope.getValue(['pipeline'], 'warehouseId'),
    }),
  })
  .addFunction('UpdateRecords', updateRecords);
```

**WHY**: Enables modular, testable pipeline components. SubflowInputMapper controls what data flows into subflow.

### 6. Subflow with Decider (Demo 6)

Complex subflows with internal branching:

```typescript
const fulfillmentSubflow = new FlowChartBuilder()
  .start('ValidateOrder', validateOrder)
  .addDecider((output) => output.shippingMethod)
    .addFunctionBranch('ground', 'GroundShipping', groundShipping)
    .addFunctionBranch('air', 'AirShipping', airShipping)
    .end()
  .build();

new FlowChartBuilder()
  .start('ProcessOrder', processOrder)
  .addSubFlowChart('fulfill', fulfillmentSubflow, 'Fulfillment')
  .addFunction('ConfirmShipment', confirmShipment);
```

**WHY**: Subflows can contain any pattern, enabling sophisticated reusable components.

### 7. Nested Subflows (Demo 7)

Subflows containing subflows:

```typescript
const fraudCheckSubflow = new FlowChartBuilder()
  .start('AnalyzeRisk', analyzeRisk)
  .build();

const paymentSubflow = new FlowChartBuilder()
  .start('ValidateCard', validateCard)
  .addSubFlowChart('fraud', fraudCheckSubflow, 'FraudCheck')
  .addFunction('ChargeCard', chargeCard)
  .build();

new FlowChartBuilder()
  .start('InitiateCheckout', initiateCheckout)
  .addSubFlowChart('payment', paymentSubflow, 'Payment')
  .addFunction('CompleteOrder', completeOrder);
```

**WHY**: Scope isolation propagates through all nesting levels. Each subflow has its own isolated scope.

### 8. Async & Race Conditions (Demo 8)

**CRITICAL CONCEPT**: pipelineId for namespace isolation

```typescript
// WITHOUT pipelineId - RACE CONDITION!
const store = new GlobalStore(); // Shared across all pipelines
// Concurrent pipelines can overwrite each other's data

// WITH pipelineId - SAFE
const store1 = new GlobalStore('tenant-A-request-123');
const store2 = new GlobalStore('tenant-B-request-456');
// Each pipeline has isolated namespace in GlobalStore
```

**WHY**: In multi-tenant systems, concurrent pipeline executions MUST use unique pipelineIds to prevent data corruption.

### 9. Metrics, Debug & LLM Integration (Demo 9)

Observability and AI patterns:

```typescript
import { MetricRecorder, DebugRecorder } from 'footprint';

// Attach recorders for observability
const metricRecorder = new MetricRecorder();
const debugRecorder = new DebugRecorder();

const scopeFactory = (ctx, stageName, readOnly) => {
  const scope = new BaseState(ctx, stageName, readOnly);
  scope.addRecorder(metricRecorder);
  scope.addRecorder(debugRecorder);
  return scope;
};

// After execution
console.log('Metrics:', metricRecorder.getMetrics());
console.log('Debug entries:', debugRecorder.getEntries());
```

**WHY**: Production pipelines need observability. Recorders capture timing, read/write counts, and debug info.

---

## Key Concepts Reference

### Scope Operations

```typescript
// Write to scope (buffered until commit)
scope.setObject(['pipeline'], 'key', value);

// Read from scope
const value = scope.getValue(['pipeline'], 'key');

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
  orderId: parentScope.getValue(['pipeline'], 'orderId'),
  customerId: parentScope.getValue(['pipeline'], 'customerId'),
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
