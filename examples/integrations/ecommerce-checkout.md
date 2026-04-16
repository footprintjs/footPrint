---
name: E-commerce Checkout
group: Use Cases
guide: https://footprintjs.github.io/footPrint/guides/patterns/real-world-composition/
---

# E-commerce Checkout — Composing Every Primitive

A real checkout flow puts footprintjs to work on all fronts. Each moving piece is a named stage; each decision leaves a paper trail; and when something goes wrong, you can trace exactly why.

```
ReceiveOrder
    ↓
InventoryCheck  ⫴  FraudCheck        ← parallel, both feed the decider
    ↓
Classify (decider)
    ├── Out of stock       → NotifyOutOfStock   ($break)
    ├── High fraud risk    → FlagForReview      ($break)
    └── All clear          → ChargePayment → FulfillOrder
```

## Why this matters

Checkout is where a **single bad trace** costs money. You need to answer every question the support team asks, six hours later, from the logs alone:

- *"Why did this order get flagged for manual review?"*
- *"Did the payment charge before or after we confirmed stock?"*
- *"Which inventory SKUs tripped the out-of-stock branch?"*

With footprintjs, every answer is in the narrative. No new instrumentation needed.

## What you'll learn

- **Fork for independent checks** — inventory and fraud are parallel because they don't depend on each other. Shaves tens-to-hundreds of ms off p99 latency at checkout.
- **decide() for audit-grade routing** — the rule that matched, the values that triggered it, all captured. Perfect for PCI compliance or chargeback disputes.
- **`$break` for terminal branches** — NotifyOutOfStock and FlagForReview are end-of-line; don't flow into payment.
- **Single linear chart, mixed concerns** — inventory, fraud, payment, fulfillment — one traceable story.

## Anatomy

```typescript
flowChart<CheckoutState>('ReceiveOrder', ...)            // seed order
  .addFunction('InventoryCheck', ...)                    // parallel
  .addFunction('FraudCheck', ...)                        // parallel
  .addDeciderFunction('Classify', (scope) =>
    decide(scope, [                                      // audit-grade routing
      { when: (s) => !s.inventoryOk,             then: 'reject', label: 'Out of stock' },
      { when: (s) => (s.fraudScore ?? 0) >= 0.5, then: 'manual', label: 'High fraud risk' },
    ], 'approve'))
    .addFunctionBranch('reject', 'NotifyOutOfStock', ...)  // $break inside
    .addFunctionBranch('manual', 'FlagForReview', ...)     // $break inside
    .addFunctionBranch('approve', 'ChargePayment', ...)
    .end()
  .addFunction('FulfillOrder', ...)                      // only reaches here on approve
  .build();
```

## Playing with it

Change the `INPUT` to trigger different branches:

```json
// triggers "Out of stock"
{ "items": [{ "sku": "WIDGET-OOS", "qty": 1, "unitPrice": 99 }] }

// triggers "High fraud risk" (amount > $5000)
{ "customerId": "new-bob", "items": [{ "sku": "WIDGET-A", "qty": 100, "unitPrice": 99 }] }

// default: approve + fulfill
{}
```

After each run, open **Inspector → Data Trace** and click a stage — see exactly which upstream stages contributed to the outcome.

## Real-world extensions

- **Tax calculation** as a subflow mounted before Classify (reusable across domestic/international flows).
- **Inventory reservation** using `.addPausableFunction` — reserve, pause, wait for payment confirmation, commit.
- **Loyalty points accrual** as a fork branch — runs alongside fulfillment, not blocking.
- **Webhook notifications** wired through a custom `FlowRecorder` — no stage clutter.

## Related

- **[Fork (Parallel)](../building-blocks/02-fork.md)** — the primitive powering the parallel checks.
- **[decide() / select()](../building-blocks/03-decider.md)** — how Classify captures WHY.
- **[Causal Chain](../post-execution/causal-chain/01-linear.md)** — trace any final value back to its source stage.
