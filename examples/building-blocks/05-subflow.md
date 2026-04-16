---
name: Subflow
group: Building Blocks
guide: https://footprintjs.github.io/footPrint/guides/building-blocks/subflows/
---

# Subflow (Nested Pipeline)

A **subflow** is a complete flowchart mounted inside another. The parent runs it as a single stage, then continues after it finishes.

```
Parent:  CreateOrder → [PaymentSubflow] → ShipOrder
                        │
Child:   ValidateCard → ChargeCard → SendReceipt
```

## When to use

- You have a **reusable pipeline** (payment processing, inventory check, risk scoring) that multiple workflows need.
- You want **drill-down visualization** — the child's internals appear as an expandable node in the parent's trace.
- You want to **own and version** pipelines independently — one team owns payments, another owns shipping, composed by a third.

This is how teams scale footprintjs: build a library of reusable pipelines, own them separately, compose them into parent workflows. The parent sees the full execution tree, not a black box.

## Input/output mapping

Subflows have **isolated scopes** — they don't see the parent's state by default. Use `inputMapper` and `outputMapper` to pass data in and out:

```typescript
.addSubFlowChartNext('payment', paymentSubflow, 'ProcessPayment', {
  inputMapper: (parentScope) => ({
    orderTotal: parentScope.orderTotal,
    cardLast4: parentScope.cardLast4,
  }),
  outputMapper: (subflowOutput) => ({
    paymentStatus: subflowOutput.paymentStatus,
    transactionId: subflowOutput.transactionId,
  }),
})
```

This forces you to be explicit about the contract between parent and child — no accidental coupling via shared state.

## Subflow vs. inline stages

| | Inline stages | Subflow |
|---|---|---|
| Scope | Shared with parent | Isolated (mapped in/out) |
| Reusable across pipelines | No | Yes |
| Visualization | Flat | Drill-down |
| Best for | One-off logic | Reusable, owned by a team |

## What you'll see in the trace

The parent's narrative shows the subflow as a single step:

```
Stage 2: Next step: ProcessPayment.
  ↓ Entering Payment subflow
    Stage 1: ValidateCard
      Step 1: Write cardValid = true
    Stage 2: ChargeCard
      Step 1: Write paymentStatus = "charged"
    Stage 3: SendReceipt
      Step 1: Write receiptSent = true
  ↑ Exiting Payment subflow
Stage 3: Next step: ShipOrder.
```

Use `getSubtreeSnapshot(snapshot, 'payment')` to extract just the subflow's execution tree post-run.

## Key API

- `.addSubFlowChartNext(id, chart, 'Name', { inputMapper, outputMapper })` — mount sequentially.
- `.addSubFlowChartBranch(...)` — mount as a decider/selector branch.
- `.addLazySubFlowChartBranch(id, resolverFn, 'Name')` — deferred mounting for graph-of-services patterns.
- `getSubtreeSnapshot(snapshot, subflowId)` — extract the child's execution tree.

## Related concepts

- **[Lazy Subflow](./07-lazy-subflow.md)** — defer subflow resolution to runtime (useful when you have 50+ branches but only run 2).
- **[Decider](./03-decider.md)** — route to one of many branches (each branch can be a subflow).
- **[Full guide](https://footprintjs.github.io/footPrint/guides/building-blocks/subflows/)** — covers mounting, snapshots, `ComposableRunner`, and `ManifestFlowRecorder`.
