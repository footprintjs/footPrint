# Module 6: Core Architecture

> **How FootPrint implements every concept from Modules 1-5. The precise mapping from theory to code.**

This module shows you exactly how FootPrint's source code implements the concepts you learned. Each section references the specific training module and shows the corresponding implementation.

## Prerequisites

Complete these modules first — this chapter assumes you understand them:

- [Module 1: Functions](./01-FUNCTIONS.md) — Functions as building blocks
- [Module 2: Execution](./02-EXECUTION.md) — Call stack and execution flow
- [Module 3: Memory](./03-MEMORY.md) — Stack, heap, and global memory
- [Module 4: Scope](./04-SCOPE.md) — Local, closure, and global scope
- [Module 5: Flowchart Execution](./05-FLOWCHART_EXECUTION.md) — Concept mapping to FootPrint

---

## The Implementation Map

Here's how each training concept maps to FootPrint's source code:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  TRAINING CONCEPT              →    FOOTPRINT IMPLEMENTATION               │
├─────────────────────────────────────────────────────────────────────────────┤
│  Module 1: Functions                                                        │
│    Function                    →    StageNode.fn (PipelineStageFunction)   │
│    Parameters                  →    scope.getValue()                        │
│    Return Value                →    Stage function return                   │
│    Encapsulation               →    Stage isolation via scope              │
├─────────────────────────────────────────────────────────────────────────────┤
│  Module 2: Execution                                                        │
│    Call Stack                  →    StageContext tree (parent/next/children)│
│    Stack Frame                 →    StageContext instance                   │
│    Sequential Execution        →    Pipeline.executeLinear()               │
│    Async Execution             →    async/await in Pipeline.execute()      │
├─────────────────────────────────────────────────────────────────────────────┤
│  Module 3: Memory                                                           │
│    Stack (local)               →    PatchedMemoryContext (per-stage)       │
│    Heap (shared)               →    GlobalContext (shared state)           │
│    Global                      →    GlobalContext root level               │
│    Lifetime                    →    commitPatch() flushes to global        │
├─────────────────────────────────────────────────────────────────────────────┤
│  Module 4: Scope                                                            │
│    Local Scope                 →    scope.setValue(key, value)             │
│    Closure Scope               →    scope.setValue(key, value)             │
│    Global Scope                →    scope.setGlobal(key, value)            │
│    Scope Chain                 →    StageContext.getValue() lookup         │
├─────────────────────────────────────────────────────────────────────────────┤
│  Module 5: Flowchart Execution                                              │
│    Stage                       →    StageNode in FlowChartBuilder          │
│    Execution Tree              →    StageContext.next / .children          │
│    Linear Flow                 →    FlowChartBuilder.addFunction()         │
│    Fork (Parallel)             →    FlowChartBuilder.addListOfFunction()   │
│    Decider (Conditional)       →    FlowChartBuilder.addDeciderFunction()  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Module 1 → Functions Implementation

### What You Learned

> "A function is a named block of code that receives input, performs computation, and produces output."

### How FootPrint Implements It

**Stage functions** are the FootPrint equivalent of functions:

```typescript
// From src/core/pipeline/types.ts
export type PipelineStageFunction<TOut, TScope> = (
  scope: TScope,                    // Input via scope object
  stageContext?: StageContext       // Execution context
) => Promise<TOut | void>;          // Output via return
```

**FlowChartBuilder** collects your stage functions into a graph:

```typescript
// From src/builder/FlowChartBuilder.ts
class _N<TOut, TScope> {
  name!: string;                    // Function name (Module 1: "Name")
  fn?: PipelineStageFunction;       // The actual function (Module 1: "Body")
  // ... graph structure
}
```

### The Precise Mapping

| Module 1 Concept | FootPrint Implementation | Source Location |
|------------------|-------------------------|-----------------|
| Function name | `StageNode.name` | `FlowChartBuilder.ts:_N.name` |
| Parameters | `scope.getValue(key)` | `BaseState.ts:getValue()` |
| Return value | `Promise<TOut>` from stage function | `types.ts:PipelineStageFunction` |
| Encapsulation | Stage only sees its scope | `StageContext` isolation |

### Code Example

```typescript
// Module 1 taught: function receives input, produces output
function calculateTotal(price: number, quantity: number): number {
  return price * quantity;
}

// FootPrint equivalent: stage receives scope, produces output
async function calculateTotal(scope: OrderScope): Promise<OrderResult> {
  // Input via scope (not parameters)
  const price = scope.getValue('price');
  const quantity = scope.getValue('quantity');

  // Computation (same as traditional function)
  const total = price * quantity;

  // Output via scope AND return
  scope.setValue('total', total);
  return { total };
}
```

---

## Module 2 → Execution Implementation

### What You Learned

> "The call stack tracks active function calls. Each stack frame contains parameters, local variables, and return address."

### How FootPrint Implements It

**StageContext** is the FootPrint equivalent of a stack frame:

```typescript
// From src/core/context/StageContext.ts
export class StageContext {
  public stageName = '';              // Which function is executing
  public pipelineId: string;          // Execution identifier
  
  // Links for walking the stage tree (explicit call stack)
  public parent?: StageContext;       // Return address equivalent
  public next?: StageContext;         // Linear successor
  public children?: StageContext[];   // Parallel branches
  
  // Memory management
  private patchedMemory?: PatchedMemoryContext;  // Local variables
  private globalContext: GlobalContext;           // Shared state
}
```

**The execution tree** replaces the implicit call stack:

```typescript
// From src/core/context/StageContext.ts

// Creating linear successor (like pushing to call stack)
createNextContext(path: string, stageName: string): StageContext {
  if (!this.next) {
    this.next = new StageContext(path, stageName, this.globalContext, ...);
    this.next.parent = this;  // Link back (return address)
  }
  return this.next;
}

// Creating parallel branches (fork)
createChildContext(pipelineId: string, branchId: string, stageName: string): StageContext {
  const childContext = new StageContext(pipelineId, stageName, this.globalContext, ...);
  childContext.parent = this;
  this.children.push(childContext);
  return childContext;
}
```

### The Precise Mapping

| Module 2 Concept | FootPrint Implementation | Source Location |
|------------------|-------------------------|-----------------|
| Call Stack | `StageContext` tree | `StageContext.ts` |
| Stack Frame | `StageContext` instance | `StageContext.ts:constructor` |
| Push to stack | `createNextContext()` | `StageContext.ts:createNextContext` |
| Pop from stack | Return from stage function | `Pipeline.ts:executeStage` |
| Return address | `StageContext.parent` | `StageContext.ts:parent` |
| Sequential execution | `Pipeline.executeLinear()` | `Pipeline.ts` |

### Visual Comparison

```
Module 2: Traditional Call Stack       FootPrint: StageContext Tree
                                       
┌─────────────┐                        StageContext {
│   inner     │  ← current               stageName: 'Validate',
├─────────────┤                          next: StageContext {
│   outer     │                            stageName: 'Process',
├─────────────┤                            parent: ↑,
│    main     │                            next: StageContext {
└─────────────┘                              stageName: 'Notify',
                                             parent: ↑
                                           }
                                         }
                                       }
```

---

## Module 3 → Memory Implementation

### What You Learned

> "Stack memory stores local variables (fast, automatic). Heap memory stores objects (flexible, persistent). Global memory stores shared state."

### How FootPrint Implements It

**PatchedMemoryContext** handles local (staged) writes:

```typescript
// From src/core/stateManagement/PatchedMemoryContext.ts
// This is the "stack" equivalent - per-stage local state

export class PatchedMemoryContext {
  private _overwrites: Map<string, unknown>;  // Staged writes
  private _updates: Map<string, unknown>;     // Staged merges
  
  set(path: string[], value: unknown) {
    // Write to local patch (not yet committed)
    this._overwrites.set(pathKey, value);
  }
  
  commit(): CommitBundle {
    // Flush local changes to global (like function return)
    return { overwrite: this._overwrites, updates: this._updates };
  }
}
```

**GlobalContext** handles shared (heap/global) state:

```typescript
// From src/core/context/GlobalContext.ts
// This is the "heap" + "global" equivalent - shared across stages

export class GlobalContext {
  private _state: Record<string, unknown>;
  
  applyPatch(overwrites, updates, trace) {
    // Apply committed changes from stages
    for (const [path, value] of overwrites) {
      this._set(path, value);
    }
  }
  
  getValue(pipelineId, path, key) {
    // Read from shared state
    return this._get([...path, key]);
  }
}
```

**StageContext** bridges local and global:

```typescript
// From src/core/context/StageContext.ts

// Write to local patch first
patch(path: string[], key: string, value: unknown) {
  this.getMemoryContext().set(this.withNamespace(path, key), value);
}

// Flush to global when stage completes
commitPatch(): void {
  const bundle = this.getMemoryContext().commit();
  this.globalContext.applyPatch(bundle.overwrite, bundle.updates, bundle.trace);
}
```

### The Precise Mapping

| Module 3 Concept | FootPrint Implementation | Source Location |
|------------------|-------------------------|-----------------|
| Stack (local) | `PatchedMemoryContext` | `PatchedMemoryContext.ts` |
| Heap (shared) | `GlobalContext` | `GlobalContext.ts` |
| Global | `GlobalContext` root | `GlobalContext.ts:getValue('', ...)` |
| Variable lifetime | `commitPatch()` flushes | `StageContext.ts:commitPatch` |
| Memory allocation | `getMemoryContext()` lazy init | `StageContext.ts:getMemoryContext` |

### Memory Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Stage Execution                                                        │
│                                                                         │
│  1. Stage writes to scope                                               │
│     scope.setValue('total', 100)                                       │
│              │                                                          │
│              ▼                                                          │
│  ┌─────────────────────────────────┐                                   │
│  │  PatchedMemoryContext           │  ← Local "stack" (staged writes)  │
│  │  _overwrites: { 'total': 100 }                                      │
│  └─────────────────────────────────┘                                   │
│              │                                                          │
│              │ commitPatch() (when stage completes)                     │
│              ▼                                                          │
│  ┌─────────────────────────────────┐                                   │
│  │  GlobalContext                  │  ← Shared "heap" (committed)      │
│  │  _state: { total: 100 }                                              │
│  └─────────────────────────────────┘                                   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Module 4 → Scope Implementation

### What You Learned

> "Local scope is visible within function. Closure scope is visible to inner functions. Global scope is visible everywhere."

### How FootPrint Implements It

**BaseState** provides the user-facing scope API:

```typescript
// From src/scope/core/BaseState.ts
export class BaseState {
  protected _stageContext: StageContext;
  protected _stageName: string;
  
  // Scoped state - read/write within pipeline namespace
  getValue(key?: string) {
    return this._stageContext.getValue([], key);
  }

  setValue(key: string, value: unknown) {
    return this._stageContext.setObject([], key, value);
  }
  
  // Global Context (global scope) - shared everywhere
  setGlobal(key: string, value: unknown) {
    return this._stageContext.setGlobal(key, value);
  }
  
  getGlobal(key: string) {
    return this._stageContext.getGlobal(key);
  }
}
```

**StageContext** implements the scope resolution:

```typescript
// From src/core/context/StageContext.ts

// Namespace resolution (scope chain)
private withNamespace(path: string[], key: string): string[] {
  if (!this.pipelineId || this.pipelineId === '') {
    return [...path, key];  // Global scope
  }
  return ['pipelines', this.pipelineId, ...path, key];  // Pipeline scope
}

// Read with scope chain lookup
getValue(path: string[], key?: string) {
  // 1. Check local patch first (read-after-write)
  const fromPatch = this.getMemoryContext().get(this.withNamespace(path, key));
  if (typeof fromPatch !== 'undefined') {
    return fromPatch;
  }
  // 2. Fallback to global context
  return this.globalContext.getValue(this.pipelineId, path, key);
}
```

### The Precise Mapping

| Module 4 Concept | FootPrint Implementation | Source Location |
|------------------|-------------------------|-----------------|
| Local scope | `scope.setValue(key, val)` | `BaseState.ts:setObject` |
| Closure scope | `scope.setValue(key, val)` | `BaseState.ts:setObject` |
| Global scope | `scope.setGlobal(key, val)` | `BaseState.ts:setGlobal` |
| Scope chain | `StageContext.getValue()` lookup | `StageContext.ts:getValue` |
| Scope resolution | `withNamespace()` path building | `StageContext.ts:withNamespace` |

### Scope Levels in Code

```typescript
async function myStage(scope: BaseState) {
  // Module 4: Local Scope → FootPrint: Scoped state
  // Only this stage can see 'temp' (until committed)
  scope.setValue('temp', 'local value');
  // Stored at: ['pipelines', pipelineId, 'temp']

  // Module 4: Closure Scope → FootPrint: Scoped state (after commit)
  // All stages in this pipeline can see 'sharedData'
  scope.setValue('sharedData', { items: [] });
  // Stored at: ['pipelines', pipelineId, 'sharedData']
  
  // Module 4: Global Scope → FootPrint: Global Context
  // All stages everywhere can see 'config'
  scope.setGlobal('config', { debug: true });
  // Stored at: ['config']
}
```

---

## Module 5 → Flowchart Execution Implementation

### What You Learned

> "FootPrint makes control flow explicit as a flowchart. Stages are functions, the execution tree replaces the call stack."

### How FootPrint Implements It

**FlowChartBuilder** constructs the graph:

```typescript
// From src/builder/FlowChartBuilder.ts
export class FlowChartBuilder<TOut, TScope> {
  private _root?: _N<TOut, TScope>;
  private _cursor?: _N<TOut, TScope>;
  private _stageMap = new Map<string, PipelineStageFunction>();
  
  // Linear flow (A → B)
  addFunction(functionName: string, fn?: PipelineStageFunction): this {
    const cur = this._needCursor();
    const n = new _N<TOut, TScope>();
    n.name = functionName;
    n.fn = fn;
    cur.next = n;  // Link linear edge
    this._cursor = n;
    return this;
  }
  
  // Fork flow (A → [B1, B2, B3])
  addListOfFunction(children: ParallelSpec[]): this {
    const cur = this._needCursor();
    for (const { id, name, fn } of children) {
      const n = new _N<TOut, TScope>();
      n.id = id;
      n.name = name;
      n.fn = fn;
      cur.children.push(n);  // Link parallel edges
    }
    return this;
  }
  
  // Decider flow (A → ? → [B1 or B2])
  addDeciderFunction(name: string, decider: (scope?) => string): DeciderList {
    const cur = this._needCursor();
    return new DeciderList(this, cur, name, decider);
  }
}
```

**StageNode** is the graph node structure:

```typescript
// From src/core/pipeline/Pipeline.ts
export interface StageNode<TOut, TScope> {
  name: string;                           // Stage identifier
  id?: string;                            // Unique ID
  fn?: PipelineStageFunction<TOut, TScope>; // Your function
  next?: StageNode<TOut, TScope>;         // Linear edge
  children?: StageNode<TOut, TScope>[];   // Parallel edges
  nextNodeDecider?: (out?: TOut) => string; // Routing function
}
```

### The Precise Mapping

| Module 5 Concept | FootPrint Implementation | Source Location |
|------------------|-------------------------|-----------------|
| Stage | `StageNode` | `Pipeline.ts:StageNode` |
| Linear flow | `StageNode.next` | `FlowChartBuilder.ts:addFunction` |
| Fork (parallel) | `StageNode.children` | `FlowChartBuilder.ts:addListOfFunction` |
| Decider (conditional) | `StageNode.nextNodeDecider` | `FlowChartBuilder.ts:addDeciderFunction` |
| Execution tree | `StageContext` tree | `StageContext.ts` |
| Graph construction | `FlowChartBuilder` | `FlowChartBuilder.ts` |

### Execution Patterns in Code

```typescript
// Module 5: Linear (A → B → C)
builder
  .start('A', fnA)
  .addFunction('B', fnB)
  .addFunction('C', fnC);

// Internal structure:
// { name: 'A', fn: fnA, next: { name: 'B', fn: fnB, next: { name: 'C', fn: fnC } } }

// Module 5: Fork (A → [B1, B2] → C)
builder
  .start('A', fnA)
  .addListOfFunction([
    { id: 'b1', name: 'B1', fn: fnB1 },
    { id: 'b2', name: 'B2', fn: fnB2 },
  ])
  .addFunction('C', fnC);

// Internal structure:
// { name: 'A', fn: fnA, children: [{ name: 'B1' }, { name: 'B2' }], next: { name: 'C' } }

// Module 5: Decider (A → ? → [B1 or B2] → C)
builder
  .start('A', fnA)
  .addDeciderFunction('Router', (scope) => scope.get('route'))
    .addFunctionBranch('b1', 'B1', fnB1)
    .addFunctionBranch('b2', 'B2', fnB2)
    .end()
  .addFunction('C', fnC);

// Internal structure:
// { name: 'Router', fn: deciderFn, children: [...], nextNodeDecider: (scope) => scope.get('route'), next: { name: 'C' } }
```

---

## Complete Execution Flow

Here's how all the concepts work together during execution:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  1. BUILD PHASE (FlowChartBuilder)                                         │
│                                                                             │
│     const builder = new FlowChartBuilder()                                 │
│       .start('Validate', validateFn)      // Module 1: Function            │
│       .addFunction('Process', processFn)  // Module 5: Linear flow         │
│       .addFunction('Notify', notifyFn);                                    │
│                                                                             │
│     Creates StageNode graph:                                               │
│     { name: 'Validate', fn: validateFn,                                    │
│       next: { name: 'Process', fn: processFn,                              │
│         next: { name: 'Notify', fn: notifyFn } } }                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  2. EXECUTE PHASE (Pipeline)                                               │
│                                                                             │
│     For each stage:                                                        │
│                                                                             │
│     a) Create StageContext                    // Module 2: Stack frame     │
│        ctx = new StageContext(pipelineId, stageName, globalContext)        │
│                                                                             │
│     b) Create scope via ScopeFactory          // Module 4: Scope           │
│        scope = scopeFactory(ctx, stageName)   // Returns BaseState         │
│                                                                             │
│     c) Execute stage function                 // Module 1: Function call   │
│        result = await stage.fn(scope, ctx)                                 │
│                                                                             │
│     d) Commit memory changes                  // Module 3: Memory flush    │
│        ctx.commitPatch()  // PatchedMemory → GlobalContext                 │
│                                                                             │
│     e) Move to next stage                     // Module 2: Execution flow  │
│        ctx = ctx.createNextContext(...)                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Source Code Reference

```
src/
├── builder/
│   └── FlowChartBuilder.ts      ← Module 5: Graph construction
│       • start()                   Creates root StageNode
│       • addFunction()             Linear edge (next)
│       • addListOfFunction()       Parallel edges (children)
│       • addDeciderFunction()      Conditional routing
│
├── core/
│   ├── pipeline/
│   │   ├── Pipeline.ts          ← Module 2: Execution engine
│   │   │   • execute()             Traverses StageNode graph
│   │   │   • executeStage()        Runs single stage function
│   │   └── types.ts             ← Module 1: Function types
│   │       • PipelineStageFunction  Stage function signature
│   │
│   ├── context/
│   │   ├── StageContext.ts      ← Module 2 + 3 + 4: Execution context
│   │   │   • createNextContext()   Linear successor (call stack push)
│   │   │   • createChildContext()  Parallel branch (fork)
│   │   │   • commitPatch()         Flush local → global (memory)
│   │   │   • getValue()            Scope chain lookup
│   │   └── GlobalContext.ts     ← Module 3: Shared memory
│   │       • applyPatch()          Apply committed changes
│   │       • getValue()            Read shared state
│   │
│   └── stateManagement/
│       └── PatchedMemoryContext.ts ← Module 3: Local memory
│           • set()                 Stage local write
│           • commit()              Flush to global
│
└── scope/
    └── core/
        └── BaseState.ts         ← Module 4: User-facing scope API
            • getValue()            Read from scope
            • setValue()            Write to scope
            • setGlobal()           Write to global scope
```

---

## Key Takeaways

| Training Module | Core Concept | Implementation Class | Key Method |
|-----------------|--------------|---------------------|------------|
| Module 1 | Function | `PipelineStageFunction` | `(scope) => Promise<T>` |
| Module 2 | Call Stack | `StageContext` | `createNextContext()` |
| Module 3 | Memory | `PatchedMemoryContext` + `GlobalContext` | `commitPatch()` |
| Module 4 | Scope | `BaseState` | `setValue(key, val)` |
| Module 5 | Flowchart | `FlowChartBuilder` | `addFunction()`, `addDeciderFunction()` |

---

## What's Next?

You now understand exactly how FootPrint implements the concepts from training. Next steps:

1. **Build something** — [Getting Started](../guides/GETTING_STARTED.md)
2. **See patterns** — [Demo Examples](../../demo/)
3. **Deep dive** — [Control-Flow Model](../internals/CONTROL_FLOW_MODEL.md)
4. **Execution details** — [Execution Artifact](../internals/EXECUTION_ARTIFACT.md)
