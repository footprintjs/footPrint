# Module 1: Functions

> **What is a function? How do functions receive input and produce output?**

Functions are the fundamental building blocks of computation. Before understanding FootPrint, you need a solid mental model of what functions are and how they work.

## What is a Function?

A function is a **named block of code** that:
1. Receives input (parameters)
2. Performs computation
3. Produces output (return value)

```
┌─────────────────────────────────────┐
│            FUNCTION                 │
│                                     │
│   Input ──▶ [ Computation ] ──▶ Output
│                                     │
└─────────────────────────────────────┘
```

### The Mathematical View

In mathematics, a function maps inputs to outputs:

```
f(x) = x + 1

f(2) = 3
f(5) = 6
```

### The Programming View

In programming, functions do the same thing with more flexibility:

```typescript
function add(a: number, b: number): number {
  return a + b;
}

const result = add(2, 3);  // result = 5
```

---

## Anatomy of a Function

Every function has four parts:

```typescript
//  1. Name      2. Parameters        4. Return Type
//     ↓              ↓                    ↓
function calculateTotal(price: number, quantity: number): number {
  // 3. Body (computation)
  const subtotal = price * quantity;
  const tax = subtotal * 0.08;
  return subtotal + tax;  // Output
}
```

| Part | Purpose |
|------|---------|
| **Name** | Identifier to call the function |
| **Parameters** | Input values the function receives |
| **Body** | The computation performed |
| **Return** | Output value produced |

---

## Functions as Black Boxes

A key insight: **callers don't need to know how a function works internally**.

```
┌─────────────────────────────────────────────────────────┐
│                    BLACK BOX                            │
│                                                         │
│   price: 10  ──┐                                        │
│                │    ┌─────────────────┐                 │
│                ├───▶│ calculateTotal  │───▶  21.60     │
│                │    └─────────────────┘                 │
│   quantity: 2 ─┘                                        │
│                                                         │
│   (Caller doesn't know about tax calculation inside)    │
└─────────────────────────────────────────────────────────┘
```

This is called **encapsulation** — hiding implementation details behind a clean interface.

---

## Pure vs Impure Functions

### Pure Functions

A **pure function**:
- Always returns the same output for the same input
- Has no side effects (doesn't modify external state)

```typescript
// Pure: same input always gives same output
function double(x: number): number {
  return x * 2;
}

double(5);  // Always 10
double(5);  // Always 10
```

### Impure Functions

An **impure function**:
- May return different outputs for the same input
- May have side effects (modify external state, I/O, etc.)

```typescript
let counter = 0;

// Impure: modifies external state
function increment(): number {
  counter++;
  return counter;
}

increment();  // 1
increment();  // 2 (different output!)
```

---

## Functions Calling Functions

Functions can call other functions, creating a **call chain**:

```typescript
function validateEmail(email: string): boolean {
  return email.includes('@');
}

function validateUser(user: User): boolean {
  return validateEmail(user.email) && user.name.length > 0;
}

function registerUser(user: User): Result {
  if (!validateUser(user)) {
    return { success: false, error: 'Invalid user' };
  }
  // ... registration logic
  return { success: true };
}
```

```
registerUser
    │
    └──▶ validateUser
              │
              └──▶ validateEmail
```

This creates a **hierarchy** of function calls.

---

## Async Functions

In modern programming, functions can be **asynchronous** — they start work and return a promise of a future result:

```typescript
async function fetchUser(id: string): Promise<User> {
  const response = await fetch(`/api/users/${id}`);
  return response.json();
}

// Caller waits for the result
const user = await fetchUser('123');
```

Async functions are crucial for:
- Network requests
- File I/O
- Database queries
- Any operation that takes time

---

## Key Takeaways

| Concept | Description |
|---------|-------------|
| **Function** | Named block that transforms input to output |
| **Parameters** | Input values passed to the function |
| **Return Value** | Output produced by the function |
| **Encapsulation** | Hiding implementation behind interface |
| **Pure Function** | Same input → same output, no side effects |
| **Call Chain** | Functions calling other functions |

---

## Bridge to FootPrint

In FootPrint, **stages are functions**:

```typescript
// Traditional function
function processPayment(amount: number): PaymentResult {
  // ... process
  return { success: true };
}

// FootPrint stage (same concept!)
async function processPayment(scope: PaymentScope): Promise<PaymentResult> {
  const amount = scope.getValue([], 'amount');
  // ... process
  return { success: true };
}
```

The key difference: FootPrint stages receive a **scope** object instead of direct parameters. This enables the flowchart execution model.

---

## Next Module

[Module 2: Execution](./02-EXECUTION.md) — How functions execute and the call stack

