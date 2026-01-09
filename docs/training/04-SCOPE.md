# Module 4: Scope

> **How do functions access data? Understanding local, protected (closure), and global scope.**

Scope determines what data a function can see and modify. This module explains how scope controls visibility and lifetime.

## Prerequisites

- [Module 1: Functions](./01-FUNCTIONS.md)
- [Module 2: Execution](./02-EXECUTION.md)
- [Module 3: Memory](./03-MEMORY.md)

---

## What is Scope?

**Scope** defines the visibility of variables — which parts of your code can access which data.

```typescript
const global = 'visible everywhere';

function outer() {
  const outerVar = 'visible in outer and inner';
  
  function inner() {
    const innerVar = 'visible only in inner';
    console.log(global);    // ✅ Can access
    console.log(outerVar);  // ✅ Can access
    console.log(innerVar);  // ✅ Can access
  }
  
  console.log(global);      // ✅ Can access
  console.log(outerVar);    // ✅ Can access
  console.log(innerVar);    // ❌ Cannot access
}

console.log(global);        // ✅ Can access
console.log(outerVar);      // ❌ Cannot access
```

---

## The Three Scope Levels

### 1. Local Scope (Function Scope)

Variables declared inside a function are **local** to that function:

```typescript
function processOrder(orderId: string) {
  const order = fetchOrder(orderId);  // Local to processOrder
  const total = calculateTotal(order); // Local to processOrder
  return { order, total };
}

// order and total don't exist here
```


```
┌─────────────────────────────────────┐
│         processOrder                │
│  ┌───────────────────────────────┐  │
│  │  order (local)                │  │
│  │  total (local)                │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

### 2. Closure Scope (Protected Scope)

Inner functions can access variables from outer functions — this is called a **closure**:

```typescript
function createCounter(initial: number) {
  let count = initial;  // Protected by closure
  
  return {
    increment: () => ++count,
    decrement: () => --count,
    getValue: () => count,
  };
}

const counter = createCounter(10);
counter.increment();  // 11
counter.increment();  // 12
counter.getValue();   // 12

// count is not directly accessible!
```

```
┌─────────────────────────────────────┐
│         createCounter               │
│  ┌───────────────────────────────┐  │
│  │  count (protected)            │  │
│  │                               │  │
│  │  ┌─────────────────────────┐  │  │
│  │  │  increment (can access) │  │  │
│  │  │  decrement (can access) │  │  │
│  │  │  getValue  (can access) │  │  │
│  │  └─────────────────────────┘  │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

### 3. Global Scope

Variables declared at the top level are **global** — accessible everywhere:

```typescript
const CONFIG = { maxRetries: 3 };  // Global

function makeRequest() {
  for (let i = 0; i < CONFIG.maxRetries; i++) {
    // Can access CONFIG from anywhere
  }
}
```

---

## Scope Chain

When you access a variable, JavaScript searches up the **scope chain**:

```typescript
const a = 'global';

function outer() {
  const b = 'outer';
  
  function inner() {
    const c = 'inner';
    
    console.log(c);  // Found in inner scope
    console.log(b);  // Found in outer scope
    console.log(a);  // Found in global scope
  }
}
```

```
Scope Chain (search order):
┌─────────────────┐
│  inner scope    │  ← Search starts here
│  (c)            │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  outer scope    │  ← Then here
│  (b)            │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  global scope   │  ← Finally here
│  (a)            │
└─────────────────┘
```

---

## Scope and Lifetime

Scope affects how long variables exist:

| Scope | Lifetime |
|-------|----------|
| **Local** | Until function returns |
| **Closure** | Until all closures are garbage collected |
| **Global** | Until program ends |

```typescript
function createLogger(prefix: string) {
  // prefix lives as long as the returned function exists
  return (message: string) => {
    console.log(`[${prefix}] ${message}`);
  };
}

const logger = createLogger('APP');
// prefix = 'APP' is kept alive by the closure

logger('Starting...');  // [APP] Starting...
```

---

## Scope Problems

### Problem 1: Accidental Global

```typescript
function bad() {
  result = 'oops';  // Missing 'const' — creates global!
}

bad();
console.log(result);  // 'oops' — leaked to global scope
```

### Problem 2: Closure Confusion

```typescript
// ❌ Classic bug
for (var i = 0; i < 3; i++) {
  setTimeout(() => console.log(i), 100);
}
// Prints: 3, 3, 3 (not 0, 1, 2!)

// ✅ Fix with let (block scope)
for (let i = 0; i < 3; i++) {
  setTimeout(() => console.log(i), 100);
}
// Prints: 0, 1, 2
```

### Problem 3: Shared Mutable State

```typescript
// ❌ Dangerous: multiple functions share mutable state
const state = { count: 0 };

function increment() { state.count++; }
function reset() { state.count = 0; }

// Hard to track who modified state
```


---

## Key Takeaways

| Scope Level | Visibility | Lifetime | Use Case |
|-------------|------------|----------|----------|
| **Local** | Within function | Function call | Temporary computation |
| **Closure** | Inner functions | Until closures released | Encapsulated state |
| **Global** | Everywhere | Program lifetime | Configuration, constants |

| Concept | Description |
|---------|-------------|
| **Scope** | Rules for variable visibility |
| **Scope Chain** | Search path for variable lookup |
| **Closure** | Function capturing outer variables |
| **Lifetime** | How long a variable exists |

---

## Bridge to FootPrint

FootPrint makes scope **explicit and structured**:

```
Traditional Scope:               FootPrint Scope:
┌─────────────────┐             ┌─────────────────┐
│  Global Scope   │             │  Global Context │  ← scope.setObject(['global'], ...)
├─────────────────┤             ├─────────────────┤
│  Closure Scope  │             │  Path Context   │  ← scope.setObject(['pipeline'], ...)
├─────────────────┤             ├─────────────────┤
│  Local Scope    │             │  Node Context   │  ← scope.setObject([], ...)
└─────────────────┘             └─────────────────┘
```

Instead of implicit scope rules, FootPrint uses explicit methods:

```typescript
// Traditional: implicit scope
function processOrder() {
  const orderId = '123';           // Local
  sharedState.lastOrder = orderId; // Global (implicit)
}

// FootPrint: explicit scope
async function processOrder(scope: OrderScope) {
  const orderId = '123';
  scope.setObject([], 'orderId', orderId);           // Node context
  scope.setObject(['pipeline'], 'lastOrder', orderId); // Path context
}
```

Benefits of explicit scope:
- **No accidental globals** — You must specify where data goes
- **Clear data flow** — Easy to trace where data comes from
- **Inspectable** — Debug tools can show scope contents
- **Predictable** — Same input → same scope state

---

## Next Module

[Module 5: Flowchart Execution](./05-FLOWCHART_EXECUTION.md) — How FootPrint maps these concepts to flowchart-based execution

