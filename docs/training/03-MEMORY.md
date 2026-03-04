# Module 3: Memory

> **Where does data live during execution? Understanding local, heap, and global memory.**

Memory management is fundamental to understanding how programs work. This module explains where data lives and how long it persists.

## Prerequisites

- [Module 1: Functions](./01-FUNCTIONS.md)
- [Module 2: Execution](./02-EXECUTION.md)

---

## Memory Regions

Programs use different memory regions for different purposes:

```
┌─────────────────────────────────────────────────────────┐
│                    PROGRAM MEMORY                       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────────┐                                    │
│  │     STACK       │  ← Function calls, local variables │
│  │  (grows down)   │                                    │
│  └─────────────────┘                                    │
│           ↓                                             │
│                                                         │
│           ↑                                             │
│  ┌─────────────────┐                                    │
│  │      HEAP       │  ← Dynamic allocations, objects    │
│  │   (grows up)    │                                    │
│  └─────────────────┘                                    │
│                                                         │
│  ┌─────────────────┐                                    │
│  │     GLOBAL      │  ← Global variables, constants     │
│  └─────────────────┘                                    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Stack Memory

**Stack memory** stores:
- Function parameters
- Local variables
- Return addresses

```typescript
function calculate(x: number, y: number): number {
  const sum = x + y;      // sum is on the stack
  const product = x * y;  // product is on the stack
  return sum + product;
}
```

Stack memory is:
- **Fast** — Simple push/pop operations
- **Automatic** — Cleaned up when function returns
- **Limited** — Fixed size, can overflow

```
Stack during calculate(3, 4):
┌─────────────────┐
│  product = 12   │
├─────────────────┤
│  sum = 7        │
├─────────────────┤
│  y = 4          │
├─────────────────┤
│  x = 3          │
├─────────────────┤
│  return addr    │
└─────────────────┘
```

---

## Heap Memory

**Heap memory** stores:
- Objects
- Arrays
- Dynamic data structures

```typescript
function createUser(name: string): User {
  // Object allocated on heap
  const user = {
    name: name,
    createdAt: new Date(),
    preferences: []
  };
  return user;  // Reference returned, object persists
}
```

Heap memory is:
- **Flexible** — Can grow as needed
- **Persistent** — Lives until garbage collected
- **Slower** — More complex allocation

```
Stack:                    Heap:
┌─────────────────┐      ┌─────────────────────────┐
│  user ──────────┼─────▶│  { name: 'Alice',       │
└─────────────────┘      │    createdAt: Date,     │
                         │    preferences: [] }    │
                         └─────────────────────────┘
```

---

## Global Memory

**Global memory** stores:
- Global variables
- Constants
- Module-level state

```typescript
// Global memory
const CONFIG = { maxRetries: 3 };
let requestCount = 0;

function makeRequest() {
  requestCount++;  // Modifies global state
  // ...
}
```

Global memory is:
- **Always accessible** — From any function
- **Long-lived** — Exists for program lifetime
- **Dangerous** — Can cause bugs if misused

---

## Variable Lifetime

Different variables have different lifetimes:

```typescript
const GLOBAL = 'always exists';  // Program lifetime

function outer() {
  const outerVar = 'exists while outer runs';  // outer's lifetime
  
  function inner() {
    const innerVar = 'exists while inner runs';  // inner's lifetime
    console.log(outerVar);  // Can access outer's variable
  }
  
  inner();
  // innerVar is gone here
}

// outerVar is gone here
// GLOBAL still exists
```

```
Timeline:
─────────────────────────────────────────────────────────▶
│ GLOBAL ─────────────────────────────────────────────────│
│                                                         │
│         │ outerVar ─────────────────────│               │
│         │                               │               │
│         │         │ innerVar ──│        │               │
│         │         │            │        │               │
│         outer()   inner()      │        │               │
│                                │        │               │
```

---

## Memory and Functions

When a function returns, its stack frame is destroyed:

```typescript
function createCounter(): () => number {
  let count = 0;  // Where does this live?
  
  return function increment(): number {
    count++;      // How can this still access count?
    return count;
  };
}

const counter = createCounter();
counter();  // 1
counter();  // 2
```

This works because of **closures** — the inner function captures a reference to `count`, keeping it alive on the heap.

---

## Memory Bugs

Common memory-related bugs:

### 1. Dangling References

```typescript
// ❌ Bug: returning reference to stack variable
function bad(): number[] {
  const arr = [1, 2, 3];
  return arr;  // In some languages, this is dangerous
}
// JavaScript handles this safely via heap allocation
```

### 2. Memory Leaks

```typescript
// ❌ Bug: accumulating data without cleanup
const cache: Map<string, Data> = new Map();

function processRequest(id: string) {
  const data = fetchData(id);
  cache.set(id, data);  // Never removed!
}
```

### 3. Shared Mutable State

```typescript
// ❌ Bug: multiple functions modifying same object
const state = { count: 0 };

function increment() { state.count++; }
function decrement() { state.count--; }

// Race condition if called concurrently!
```

---

## Key Takeaways

| Memory Type | Contents | Lifetime | Speed |
|-------------|----------|----------|-------|
| **Stack** | Local variables, parameters | Function call | Fast |
| **Heap** | Objects, arrays | Until garbage collected | Slower |
| **Global** | Global variables | Program lifetime | Fast |

| Concept | Description |
|---------|-------------|
| **Lifetime** | How long a variable exists |
| **Closure** | Function capturing outer variables |
| **Memory Leak** | Unreleased memory accumulation |
| **Shared State** | Multiple functions accessing same data |

---

## Bridge to FootPrint

FootPrint provides **explicit memory management** through scope levels:

```
Traditional Memory:              FootPrint Scope:
┌─────────────────┐             ┌─────────────────┐
│     Global      │             │  Global Context │  ← Shared across all stages
├─────────────────┤             ├─────────────────┤
│     Heap        │             │  Path Context   │  ← Shared within a branch
├─────────────────┤             ├─────────────────┤
│     Stack       │             │  Node Context   │  ← Private to one stage
└─────────────────┘             └─────────────────┘
```

Instead of implicit memory management, FootPrint makes it explicit:

```typescript
// FootPrint: explicit scope levels
scope.setGlobal('config', { ... });               // Global context
scope.setValue('data', { ... });                   // Scoped state
scope.setValue('local', { ... });                  // Scoped state
```

This eliminates:
- Accidental global state bugs
- Memory leaks from forgotten cleanup
- Race conditions from shared mutable state

---

## Next Module

[Module 4: Scope](./04-SCOPE.md) — How scope controls visibility and lifetime

