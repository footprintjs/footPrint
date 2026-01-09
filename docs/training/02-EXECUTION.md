# Module 2: Execution

> **How does a function execute? What happens when you call a function?**

Understanding execution is crucial for debugging and reasoning about program behavior. This module explains what happens under the hood when functions run.

## Prerequisites

- [Module 1: Functions](./01-FUNCTIONS.md)

---

## The Call Stack

When you call a function, the runtime creates a **stack frame** to track the execution:

```typescript
function main() {
  const result = outer(5);
  console.log(result);
}

function outer(x: number): number {
  return inner(x) + 1;
}

function inner(x: number): number {
  return x * 2;
}

main();
```

The **call stack** grows and shrinks as functions are called and return:

```
Step 1: main() called
┌─────────────┐
│    main     │
└─────────────┘

Step 2: outer(5) called
┌─────────────┐
│   outer     │  ← current
├─────────────┤
│    main     │
└─────────────┘

Step 3: inner(5) called
┌─────────────┐
│   inner     │  ← current
├─────────────┤
│   outer     │
├─────────────┤
│    main     │
└─────────────┘

Step 4: inner returns 10
┌─────────────┐
│   outer     │  ← current (inner popped)
├─────────────┤
│    main     │
└─────────────┘

Step 5: outer returns 11
┌─────────────┐
│    main     │  ← current (outer popped)
└─────────────┘

Step 6: main completes
(stack empty)
```

---

## Stack Frame Contents

Each stack frame contains:

```
┌─────────────────────────────────────┐
│           STACK FRAME               │
├─────────────────────────────────────┤
│  Function name: outer               │
│  Parameters: x = 5                  │
│  Local variables: (none yet)        │
│  Return address: main:line 2        │
└─────────────────────────────────────┘
```

| Component | Purpose |
|-----------|---------|
| **Function name** | Which function is executing |
| **Parameters** | Input values for this call |
| **Local variables** | Variables declared in the function |
| **Return address** | Where to continue after returning |

---

## Execution Flow

Let's trace through a concrete example:

```typescript
function calculateOrder(items: Item[]): OrderSummary {
  const subtotal = calculateSubtotal(items);  // Step 1
  const tax = calculateTax(subtotal);          // Step 2
  const total = subtotal + tax;                // Step 3
  return { subtotal, tax, total };             // Step 4
}
```

```
Timeline:
─────────────────────────────────────────────────────────▶

│ calculateOrder │
│                │
│  ┌─────────────────────┐
│  │ calculateSubtotal   │
│  └─────────────────────┘
│                │
│  ┌─────────────────────┐
│  │ calculateTax        │
│  └─────────────────────┘
│                │
│  (compute total)
│                │
│  return        │
```

Execution is **sequential** — each step completes before the next begins.

---

## Async Execution

Async functions change the execution model. Instead of blocking, they **yield** control:

```typescript
async function fetchAndProcess(id: string): Promise<Result> {
  const data = await fetchData(id);    // Yields, waits for network
  const processed = process(data);      // Continues after data arrives
  return processed;
}
```

```
Timeline:
─────────────────────────────────────────────────────────▶

│ fetchAndProcess │
│                 │
│  fetchData ─────┐
│  (yields)       │ (waiting for network)
│                 │
│  ◀──────────────┘ (data arrives)
│                 │
│  process        │
│                 │
│  return         │
```

The key insight: **async execution is non-blocking**. Other code can run while waiting.

---

## Execution Context

Every function executes within a **context** that provides:

1. **Parameters** — Input values
2. **Local scope** — Variables declared in the function
3. **Outer scope** — Variables from enclosing functions (closures)
4. **Global scope** — Global variables

```typescript
const globalConfig = { debug: true };  // Global scope

function outer(x: number) {
  const outerVar = 'hello';            // Outer scope for inner
  
  function inner(y: number) {
    const localVar = x + y;            // Local scope
    console.log(outerVar);             // Access outer scope
    console.log(globalConfig.debug);   // Access global scope
    return localVar;
  }
  
  return inner(10);
}
```

---

## Execution Order Matters

The order of execution determines program behavior:

```typescript
// Order matters!
let value = 0;

function increment() { value++; }
function double() { value *= 2; }

increment();  // value = 1
double();     // value = 2

// vs

value = 0;
double();     // value = 0
increment();  // value = 1
```

This is why **control flow** is so important — it determines execution order.

---

## Error Propagation

When an error occurs, it **propagates up the call stack**:

```typescript
function main() {
  try {
    outer();
  } catch (e) {
    console.log('Caught:', e.message);
  }
}

function outer() {
  inner();  // Error propagates through here
}

function inner() {
  throw new Error('Something went wrong');
}
```

```
Error propagation:
┌─────────────┐
│   inner     │ ← Error thrown here
├─────────────┤
│   outer     │ ← Propagates through
├─────────────┤
│    main     │ ← Caught here
└─────────────┘
```

---

## Key Takeaways

| Concept | Description |
|---------|-------------|
| **Call Stack** | LIFO structure tracking active function calls |
| **Stack Frame** | Contains parameters, locals, return address |
| **Sequential Execution** | Steps complete in order |
| **Async Execution** | Non-blocking, yields control while waiting |
| **Execution Context** | Environment providing scope access |
| **Error Propagation** | Errors bubble up the call stack |

---

## Bridge to FootPrint

FootPrint replaces the implicit call stack with an **explicit execution tree**:

```
Traditional Call Stack:          FootPrint Execution Tree:
┌─────────────┐                  ┌─────────────┐
│   inner     │                  │  Validate   │
├─────────────┤                  └──────┬──────┘
│   outer     │                         │
├─────────────┤                  ┌──────▼──────┐
│    main     │                  │   Process   │
└─────────────┘                  └──────┬──────┘
                                        │
                                 ┌──────▼──────┐
                                 │   Notify    │
                                 └─────────────┘
```

The execution tree is:
- **Explicit** — You define the structure
- **Inspectable** — You can see the current position
- **Replayable** — You can step through execution

---

## Next Module

[Module 3: Memory](./03-MEMORY.md) — Where data lives during execution

