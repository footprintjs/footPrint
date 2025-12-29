# FootPrint

> **Connected execution logging model that transforms application execution into structured, causal, replayable context for AI reasoning.**

A tiny, production-minded runtime for building **flowchart-like pipelines** where each node is just a function. Supports **parallel children**, **scoped state**, **patch-based memory**, and **first-class observability**.

## Key Features

- **Not a DAG** - Supports loops, re-entry, and partial/resumed execution
- Parallel fan-out / structured fan-in
- `breakFn()` to stop a branch without affecting siblings
- Three-level memory scope: **Global → Path → Node**
- Patch-based state updates (snapshot + patch + safe merge)
- Hooks for connected logs, traces, and time-travel debugging

---

## Installation

```bash
npm install footprint
```

---

## ⚠️ CRITICAL: Scope Communication Between Stages

> **Each stage receives its own scope instance. Direct property assignment does NOT persist across stages.**

```typescript
// ❌ WRONG - Data is LOST after stage completes
scope.myData = { result: 'hello' };

// ✅ CORRECT - Data persists via GlobalContext
scope.setObject([], 'myData', { result: 'hello' });  // Write
const data = scope.getValue([], 'myData');           // Read
```

**You MUST use these methods for cross-stage data:**

| Method | Purpose |
|--------|---------|
| `scope.setObject(path, key, value)` | Write data (overwrites) |
| `scope.updateObject(path, key, value)` | Write data (deep merge) |
| `scope.getValue(path, key)` | Read data |

Direct property assignment (`scope.foo = bar`) is only for stage-local convenience data.

📖 **Full documentation:** [docs/SCOPE_COMMUNICATION.md](./docs/SCOPE_COMMUNICATION.md)

---

## When should I use FootPrint?

Use FootPrint if you need to:

1. **Turn a flowchart into running code**  
   Your problem naturally fits a tree: gather data in parallel leaves, aggregate, then continue.

2. **Mix parallel + serial steps with explicit control**  
   You want deterministic execution and don't want an opaque agent to "decide" structure for you.

3. **Keep state safe and sane**  
   You need scoped memory (global/path/node) and patch semantics that won't bite you during read-after-write.

4. **Observe and debug in production**  
   You want connected logs, causal traces, and time-travel style debugging built in.

5. **Build AI-compatible applications**  
   You want execution context that LLMs can reason over reliably.

---

## Quick Start

```typescript
import { FlowChartBuilder, BaseState } from 'footprint';

// Simple scope factory
const scopeFactory = (ctx: any, stageName: string) => new BaseState(ctx, stageName);

// Build a simple payment flow
const builder = new FlowChartBuilder()
  .start('ValidateCart', async (scope) => {
    console.log('Validating cart...');
    scope.setObject(['pipeline'], 'cartTotal', 79.98);
    return { valid: true };
  })
  .addFunction('ProcessPayment', async (scope) => {
    console.log('Processing payment...');
    const total = scope.getValue(['pipeline'], 'cartTotal');
    return { success: true, amount: total };
  })
  .addFunction('SendReceipt', async () => {
    console.log('Sending receipt...');
    return { sent: true };
  });

// Execute
const result = await builder.execute(scopeFactory);
```

---

## Core Concepts

### FootPrint vs Traditional Logs

Traditional logging systems were designed for humans and infrastructure diagnostics, not AI reasoning.

**FootPrint transforms:**
```
print("payment succeeded")
```

**Into connected context:**
```
PaymentAuthorized → OrderUpdated → NotificationSent
```

Each step is connected, typed, and traceable.

### Patterns

- **Linear**: `stage → next → next`
- **Fork (Parallel)**: `stage → [child1, child2, child3] → aggregate`
- **Decider (Single-choice)**: `stage → decider() → chosen child`
- **Selector (Multi-choice)**: `stage → selector() → [selected children in parallel]`

---

## License

MIT
