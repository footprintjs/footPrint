# Module 5: Flowchart Execution

> **How FootPrint maps traditional programming concepts to flowchart-based execution.**

This module bridges everything you've learned to FootPrint's execution model. You'll see how functions, execution, memory, and scope translate to stages, the execution tree, and scope objects.

## Prerequisites

- [Module 1: Functions](./01-FUNCTIONS.md)
- [Module 2: Execution](./02-EXECUTION.md)
- [Module 3: Memory](./03-MEMORY.md)
- [Module 4: Scope](./04-SCOPE.md)

---

## The Mental Model Shift

Traditional programming hides control flow in code structure. FootPrint makes it **explicit as a flowchart**:

```
Traditional Code:                    FootPrint Flowchart:
                                     
async function process() {           ┌─────────────┐
  const valid = await validate();    │  Validate   │
  if (!valid) return;                └──────┬──────┘
                                            │
  const result = await compute();    ┌──────▼──────┐
  await notify(result);              │   Compute   │
}                                    └──────┬──────┘
                                            │
                                     ┌──────▼──────┐
                                     │   Notify    │
                                     └─────────────┘
```

---

## Concept Mapping

| Traditional | FootPrint | Description |
|-------------|-----------|-------------|
| Function | Stage | Unit of computation |
| Call Stack | Execution Tree | Tracks active execution |
| Local Variables | Node Context | Private to one stage |
| Closure Variables | Path Context | Shared within a branch |
| Global Variables | Global Context | Shared across all stages |
| Return Value | Stage Output | Used for dynamic flow and decider/selector input (not needed in linear flows) |
| Function Call | Stage Transition | Moving to next node |


---

## Functions → Stages

In traditional code, functions are called directly:

```typescript
// Traditional
function validateCart(cart: Cart): ValidationResult {
  // ... validation logic
  return { valid: true, total: 79.98 };
}

const result = validateCart(myCart);
```

In FootPrint, stages receive a **scope object**:

```typescript
// FootPrint Stage
async function validateCart(scope: CartScope) {
  const cart = scope.getValue('cart');
  // ... validation logic
  scope.setValue('cartTotal', 79.98);
  // No return needed — scope carries data to the next stage
}
```

Key differences:
- Input comes from **scope**, not parameters
- Output goes to **scope**, not return value
- Stage is **registered** in a flowchart, not called directly
- Return values are only needed for [dynamic stages](../guides/DYNAMIC_CHILDREN.md) (returning a `StageNode`) or when feeding into a decider/selector

---

## Call Stack → Execution Tree

Traditional call stack is **implicit and linear**:

```
Call Stack:
┌─────────────┐
│   inner     │
├─────────────┤
│   outer     │
├─────────────┤
│    main     │
└─────────────┘
```

FootPrint execution tree is **explicit and can branch**:

```
Execution Tree:
                    ┌─────────────┐
                    │  Validate   │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
       ┌──────▼──────┐ ┌───▼───┐ ┌──────▼──────┐
       │  Process A  │ │   B   │ │  Process C  │
       └──────┬──────┘ └───┬───┘ └──────┬──────┘
              │            │            │
              └────────────┼────────────┘
                           │
                    ┌──────▼──────┐
                    │  Aggregate  │
                    └─────────────┘
```

Benefits:
- **Visible** — You can see the execution structure
- **Parallel** — Multiple branches execute concurrently
- **Inspectable** — Debug tools show current position

---

## Memory → Scope Contexts

Traditional memory is **implicit**:

```typescript
// Where does each variable live?
const config = { debug: true };  // Global (implicit)

function outer() {
  const data = [];               // Closure (implicit)
  
  function inner() {
    const temp = 'local';        // Local (implicit)
  }
}
```

FootPrint scope is **explicit**:

```typescript
async function myStage(scope: MyScope) {
  // Explicit scope levels
  scope.setGlobal('config', { debug: true });              // Global Context
  scope.setValue('data', []);                              // Scoped state
  scope.setValue('temp', 'local');                         // Scoped state
}
```

```
┌─────────────────────────────────────────────────────────┐
│                    SCOPE HIERARCHY                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │              GLOBAL CONTEXT                      │   │
│  │  • Shared across ALL stages                      │   │
│  │  • Lives for entire pipeline execution           │   │
│  │  • scope.setGlobal(key, value)                  │   │
│  └─────────────────────────────────────────────────┘   │
│                         │                               │
│  ┌─────────────────────────────────────────────────┐   │
│  │              PATH CONTEXT                        │   │
│  │  • Shared within a branch/path                   │   │
│  │  • Lives for the branch execution                │   │
│  │  • scope.setValue(key, value)                    │   │
│  └─────────────────────────────────────────────────┘   │
│                         │                               │
│  ┌─────────────────────────────────────────────────┐   │
│  │              NODE CONTEXT                        │   │
│  │  • Private to one stage                          │   │
│  │  • Lives for stage execution only                │   │
│  │  • scope.setValue(key, value)                    │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```


---

## Building a Flowchart

FootPrint uses a **fluent builder API** to construct flowcharts:

```typescript
import { FlowChartBuilder, BaseState } from 'footprint';

// Scope factory creates scope instances for each stage
const scopeFactory = (ctx, stageName) => new BaseState(ctx, stageName);

// Build the flowchart
const builder = new FlowChartBuilder()
  .start('Validate', async (scope) => {
    scope.setValue('cartTotal', 79.98);
  })
  .addFunction('Process', async (scope) => {
    const total = scope.getValue('cartTotal');
    scope.setValue('paymentStatus', 'charged');
  })
  .addFunction('Notify', async (scope) => {
    const status = scope.getValue('paymentStatus');
    // ... send notification
  });

// Execute
const result = await builder.execute(scopeFactory);
```

This creates:

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Validate   │────▶│   Process   │────▶│   Notify    │
└─────────────┘     └─────────────┘     └─────────────┘
```

---

## Execution Patterns

### Linear (Sequential)

```typescript
builder
  .start('A', fnA)
  .addFunction('B', fnB)
  .addFunction('C', fnC);
```

```
┌───┐     ┌───┐     ┌───┐
│ A │────▶│ B │────▶│ C │
└───┘     └───┘     └───┘
```

### Fork (Parallel)

```typescript
builder
  .start('A', fnA)
  .addListOfFunction('parallel', [
    { name: 'B1', fn: fnB1 },
    { name: 'B2', fn: fnB2 },
    { name: 'B3', fn: fnB3 },
  ])
  .addFunction('C', fnC);
```

```
         ┌────┐
    ┌───▶│ B1 │───┐
    │    └────┘   │
┌───┐    ┌────┐   │    ┌───┐
│ A │───▶│ B2 │───┼───▶│ C │
└───┘    └────┘   │    └───┘
    │    ┌────┐   │
    └───▶│ B3 │───┘
         └────┘
```

### Decider (Conditional)

```typescript
builder
  .start('A', fnA)
  .addDecider('route', deciderFn, [
    { name: 'path1', fn: fnPath1 },
    { name: 'path2', fn: fnPath2 },
  ])
  .addFunction('C', fnC);
```

```
         ┌───────┐
    ┌─?─▶│ path1 │───┐
    │    └───────┘   │
┌───┐                │    ┌───┐
│ A │                ├───▶│ C │
└───┘                │    └───┘
    │    ┌───────┐   │
    └─?─▶│ path2 │───┘
         └───────┘
```

---

## The Execution Artifact

Every execution produces an **artifact** — a complete record of what happened:

```typescript
const result = await builder.execute(scopeFactory);

// result.artifact contains:
// - Every stage that executed
// - Input/output for each stage
// - Scope state at each step
// - Timing information
// - Any errors that occurred
```

This enables:
- **Time-travel debugging** — Step through execution
- **Replay** — Re-run with same inputs
- **Inspection** — See exactly what happened

---

## Key Takeaways

| Traditional | FootPrint | Benefit |
|-------------|-----------|---------|
| Implicit call stack | Explicit execution tree | Visible, debuggable |
| Implicit scope | Explicit scope contexts | No accidental globals |
| Hidden control flow | Visible flowchart | Easy to understand |
| Scattered state | Centralized scope | Predictable data flow |
| Lost execution history | Execution artifact | Time-travel debugging |

---

## What You've Learned

After completing this training, you understand:

1. **Functions** are the building blocks — stages are functions
2. **Execution** follows a path — the flowchart defines that path
3. **Memory** has levels — scope contexts make them explicit
4. **Scope** controls visibility — FootPrint makes it structured
5. **Flowcharts** are executable — your whiteboard becomes code

---

## Next Steps

You're ready to build with FootPrint!

1. [Getting Started](../guides/GETTING_STARTED.md) — Build your first pipeline
2. [Demo Examples](../../demo/) — See patterns in action
3. [Core Concepts](../guides/CORE_CONCEPTS.md) — Deep dive into architecture
4. [Patterns](../guides/PATTERNS.md) — Fork, Decider, Selector patterns

