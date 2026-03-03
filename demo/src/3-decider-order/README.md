# Demo 3: Decider (Order Processing Domain)

## Purpose

This demo introduces **conditional branching** using the decider pattern. A decider examines the previous stage's output and routes execution to exactly ONE branch based on runtime conditions.

## WHY This Pattern Exists

Decider branching solves the problem of:
- **Conditional routing**: Different inputs require different processing paths
- **Single-choice selection**: Exactly one path must execute (unlike parallel)
- **Runtime decisions**: Branch selection happens at execution time, not build time

## Key Concepts

### 1. addDecider()

```typescript
new FlowChartBuilder()
  .start('AnalyzeOrder', analyzeOrder)
  .addDecider(fulfillmentDecider)
    .addFunctionBranch('standard', 'StandardFulfillment', standardFulfillment)
    .addFunctionBranch('express', 'ExpressFulfillment', expressFulfillment)
    .addFunctionBranch('digital', 'DigitalDelivery', digitalDelivery)
    .setDefault('standard')
    .end()
  .addFunction('ConfirmOrder', confirmOrder);
```

### 2. Decider Function

The decider function receives the previous stage's output and returns a branch ID:

```typescript
const fulfillmentDecider = (output: { fulfillmentType: string }): string => {
  return output.fulfillmentType; // Returns 'standard', 'express', or 'digital'
};
```

### 3. Decider vs Selector

| Decider | Selector |
|---------|----------|
| Returns single string (branch ID) | Returns array of strings (branch IDs) |
| Exactly ONE branch executes | MULTIPLE branches execute in parallel |
| Use for mutually exclusive paths | Use for optional/combinable paths |

## Flow Diagram

```
┌──────────────────┐
│  AnalyzeOrder    │  ← Determines fulfillment type
│ - Examine items  │
│ - Check priority │
└────────┬─────────┘
         │
         ▼
    ┌────────────┐
    │  Decider   │  ← Returns ONE branch ID
    │ (function) │
    └─────┬──────┘
          │
    ┌─────┼─────────────┐
    │     │             │
    ▼     ▼             ▼
┌────────┐ ┌────────┐ ┌────────┐
│Standard│ │Express │ │Digital │  ← Only ONE executes
│Fulfill │ │Fulfill │ │Delivery│
│ 5 days │ │ 2 days │ │ instant│
└────┬───┘ └────┬───┘ └────┬───┘
     │          │          │
     └────┬─────┴──────────┘
          │
          ▼
   ┌─────────────┐
   │ConfirmOrder │  ← Runs after selected branch
   └─────────────┘
```

## Scope Data Flow

| Stage | Reads | Writes |
|-------|-------|--------|
| AnalyzeOrder | - | order, fulfillmentType |
| StandardFulfillment | order | fulfillmentResult |
| ExpressFulfillment | order | fulfillmentResult |
| DigitalDelivery | order | fulfillmentResult |
| ConfirmOrder | order, fulfillmentResult | - |

## Branch Selection Logic

```typescript
// Order type determines fulfillment path
if (allItemsDigital) {
  return 'digital';      // → DigitalDelivery
} else if (expressPriority) {
  return 'express';      // → ExpressFulfillment
} else {
  return 'standard';     // → StandardFulfillment
}
```

## Running the Demo

```bash
# From FootPrint root
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/3-decider-order/index.ts
```

Expected output shows three different orders routing to different branches:
```
─── Standard Order ───
  [1] AnalyzeOrder: Analyzing order...
  [Decider] Routing to: standard
  [2] StandardFulfillment: Processing standard shipment...
  [3] ConfirmOrder: Finalizing order...

─── Express Order ───
  [Decider] Routing to: express
  [2] ExpressFulfillment: Processing express shipment...

─── Digital Order ───
  [Decider] Routing to: digital
  [2] DigitalDelivery: Processing digital delivery...
```

## Running Tests

```bash
# Unit tests
npm test -- --testPathPattern="3-decider-order/index.test"

# Property tests
npm test -- --testPathPattern="3-decider-order/index.property"
```

## Default Branch

The `.setDefault(id)` method specifies which branch executes if the decider returns an unknown ID:

```typescript
.addDecider(decider)
  .addFunctionBranch('a', 'BranchA', fnA)
  .addFunctionBranch('b', 'BranchB', fnB)
  .setDefault('a')  // If decider returns 'unknown', BranchA executes
  .end()
```

## When to Use Decider vs Selector

| Use Decider When | Use Selector When |
|------------------|-------------------|
| Paths are mutually exclusive | Paths can combine |
| Only one path should run | Multiple paths may run |
| if/else logic | checkbox-style selection |
| Order type routing | Feature flag combinations |

## Builds On

- **Demo 1**: Linear flow, scope operations
- **Demo 2**: Understanding that parallel children ALL execute (decider is the opposite)

## What's Next?

After understanding single-choice branching, move to **Demo 4: Selector Support** to learn how to select MULTIPLE branches that execute in parallel.
