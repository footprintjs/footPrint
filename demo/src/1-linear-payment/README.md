# Demo 1: Linear Flow (Payment Domain)

## Purpose

This demo introduces the **simplest pipeline pattern**: a linear chain of stages executing in sequence. Understanding this pattern is essential before tackling branching, parallel, or composition patterns.

## WHY This Pattern Exists

Linear flows are the foundation of all pipelines. They solve the problem of:
- **Sequential operations**: When step B must complete before step C can start
- **State sharing**: When later stages need data computed by earlier stages
- **Separation of concerns**: Each stage handles one responsibility

## Key Concepts

### 1. FlowChartBuilder

```typescript
new FlowChartBuilder()
  .start('ValidateCart', validateCart)      // Entry point
  .addFunction('ProcessPayment', processPayment)  // Chain stages
  .addFunction('UpdateInventory', updateInventory)
  .addFunction('SendReceipt', sendReceipt);
```

### 2. Scope Operations

```typescript
// Write to scope (buffered until commit)
scope.setObject(['pipeline'], 'cartTotal', total);

// Read from scope
const total = scope.getValue(['pipeline'], 'cartTotal');
```

### 3. Stage Function Signature

```typescript
const myStage = async (scope: BaseState) => {
  // Read from scope
  const input = scope.getValue(['pipeline'], 'key');
  
  // Do work...
  
  // Write to scope
  scope.setObject(['pipeline'], 'result', output);
  
  // Return value becomes stage output
  return { success: true, data: output };
};
```

## Flow Diagram

```
┌─────────────────┐
│  ValidateCart   │  ← Entry point (start)
│  - Calculate    │
│  - Store total  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ ProcessPayment  │  ← Reads total, stores txId
│  - Charge card  │
│  - Store txId   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ UpdateInventory │  ← Reads items, updates stock
│  - Reduce stock │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  SendReceipt    │  ← Reads txId + total, sends email
│  - Email user   │
└─────────────────┘
```

## Scope Data Flow

| Stage | Reads | Writes |
|-------|-------|--------|
| ValidateCart | - | cartTotal, itemCount, cartItems |
| ProcessPayment | cartTotal | transactionId, paymentStatus |
| UpdateInventory | cartItems | - |
| SendReceipt | transactionId, cartTotal, itemCount | - |

## Running the Demo

```bash
# From TreeOfFunctionsLib root
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/1-linear-payment/index.ts
```

## Running Tests

```bash
npm test -- --testPathPattern="1-linear-payment"
```

## What's Next?

After understanding linear flows, move to **Demo 2: Parallel Shipping** to learn how multiple stages can execute concurrently using `addListOfFunction()`.
