# Demo 1: Payment Flow

**Pattern:** Linear  
**Complexity:** ⭐  
**Time:** 5 minutes

## What You'll Learn

- Basic `FlowChartBuilder` usage
- Chaining stages with `start()` and `addFunction()`
- Scope communication with `setValue()` and `getValue()`

## The Flow

```
┌──────────────┐     ┌────────────────┐     ┌─────────────────┐     ┌─────────────┐
│ ValidateCart │────▶│ ProcessPayment │────▶│ UpdateInventory │────▶│ SendReceipt │
└──────────────┘     └────────────────┘     └─────────────────┘     └─────────────┘
```

## Key Concepts

### 1. Building a Linear Flow

```typescript
new FlowChartBuilder()
  .start('ValidateCart', validateFn)      // Entry point
  .addFunction('ProcessPayment', payFn)   // Chain next
  .addFunction('UpdateInventory', invFn)  // Chain next
  .addFunction('SendReceipt', receiptFn); // Chain next
```

### 2. Passing Data Between Stages

```typescript
// Stage 1: Write data
const validateCart = async (scope: BaseState) => {
  scope.setValue('cartTotal', 79.98);
  return { valid: true };
};

// Stage 2: Read data
const processPayment = async (scope: BaseState) => {
  const total = scope.getValue('cartTotal');
  return { success: true, amount: total };
};
```

## Run It

```bash
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/1-payment/index.ts
```

## Expected Output

```
=== Payment Demo (Linear Pattern) ===

  [1] Validating cart...
  [2] Processing payment...
  [3] Updating inventory...
  [4] Sending receipt...

✓ Payment flow complete!
  Final result: { "sent": true, "txId": "TX-...", "total": 79.98 }
```

## Next Steps

→ [Demo 2: LLM Tool Loop](../2-llm-tool-loop/) - Learn conditional branching
