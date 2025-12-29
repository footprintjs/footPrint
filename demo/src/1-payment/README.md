# Demo 1: Payment Flow (Linear Pattern)

The simplest FlowChartBuilder pattern - a linear chain of functions.

## Pattern: `start()` → `addFunction()` → `addFunction()` → ...

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ ValidateCart │ -> │ ProcessPay   │ -> │ UpdateInv    │ -> │ SendReceipt  │
└──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
```

## Key Concepts

1. **`start(name, fn)`** - Define the root node
2. **`addFunction(name, fn)`** - Chain the next step
3. **`build()`** - Compile to executable tree
4. **`execute(scopeFactory)`** - Run the pipeline

## When to Use

- Sequential workflows where each step depends on the previous
- Simple request/response pipelines
- ETL processes with ordered stages

## Run

```bash
npx ts-node demo/src/1-payment/index.ts
```
