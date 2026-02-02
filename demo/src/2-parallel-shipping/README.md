# Demo 2: Parallel Children (Shipping Domain)

## Purpose

This demo introduces **parallel execution** using the fork-join pattern. Multiple independent operations run concurrently, reducing total execution time from the sum of all operations to the time of the slowest operation.

## WHY This Pattern Exists

Parallel execution solves the problem of:
- **Independent operations**: When operations don't depend on each other's results
- **Performance optimization**: Total time = max(child times) instead of sum
- **Resource utilization**: Multiple I/O operations can overlap

## Key Concepts

### 1. addListOfFunction()

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

### 2. Timing Benefit

```
Sequential (without parallel):
  CalculateRate (150ms) → CheckInventory (100ms) → ValidateAddress (80ms)
  Total: 330ms

Parallel (with addListOfFunction):
  CalculateRate (150ms) ─┐
  CheckInventory (100ms) ├─→ CreateLabel
  ValidateAddress (80ms) ─┘
  Total: ~150ms (max of children + overhead)
```

### 3. Scope Sharing

All parallel children can:
- **Read** from parent scope (data written before fork)
- **Write** to scope (aggregated for next stage)

## Flow Diagram

```
┌──────────────────┐
│ PrepareShipment  │  ← Entry point
│ - Store shipment │
│ - Store weight   │
└────────┬─────────┘
         │
    ┌────┴────┬────────────┐
    │         │            │
    ▼         ▼            ▼
┌────────┐ ┌────────┐ ┌────────┐
│ Calc   │ │ Check  │ │Validate│  ← Run in PARALLEL
│ Rate   │ │Inventory│ │Address │
│ 150ms  │ │ 100ms  │ │  80ms  │
└────┬───┘ └────┬───┘ └────┬───┘
     │          │          │
     └────┬─────┴──────────┘
          │
          ▼
   ┌─────────────┐
   │ CreateLabel │  ← Waits for ALL children
   │ - Aggregate │
   └─────────────┘
```

## Scope Data Flow

| Stage | Reads | Writes |
|-------|-------|--------|
| PrepareShipment | - | shipment, totalWeight |
| CalculateRate | totalWeight, shipment | shippingRate |
| CheckInventory | shipment | inventoryStatus |
| ValidateAddress | shipment | validatedAddress |
| CreateLabel | shippingRate, inventoryStatus, validatedAddress | - |

## Running the Demo

```bash
# From TreeOfFunctionsLib root
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/2-parallel-shipping/index.ts
```

Expected output shows timing proof:
```
✓ Parallel execution confirmed!
  Total time (180ms) << Sequential time (330ms)
```

## Running Tests

```bash
npm test -- --testPathPattern="2-parallel-shipping"
```

## When to Use Parallel vs Sequential

| Use Parallel When | Use Sequential When |
|-------------------|---------------------|
| Operations are independent | Operations depend on each other |
| I/O bound operations | CPU bound operations (limited benefit) |
| External API calls | Order matters for correctness |
| Database queries | Transactions requiring order |

## What's Next?

After understanding parallel execution, move to **Demo 3: Decider Order** to learn how to route execution to exactly one branch based on runtime conditions.
