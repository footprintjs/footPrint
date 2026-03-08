# Scope

Each stage in a FootPrint pipeline receives a **scope** — a transactional interface to shared state. Writes are buffered and committed atomically after each stage completes. Recorders observe every operation without modifying behavior.

---

## Three Ways to Define Scope

### 1. Typed Scope (Recommended)

Extend `ScopeFacade` with domain-specific getters for type-safe reads:

```typescript
import { ScopeFacade, toScopeFactory } from 'footprintjs';

class LoanScope extends ScopeFacade {
  get creditScore(): number {
    return this.getValue('creditScore') as number;
  }
  get riskTier(): string {
    return this.getValue('riskTier') as string;
  }
  get dtiStatus(): string {
    return this.getValue('dtiStatus') as string;
  }
}

const scopeFactory = toScopeFactory(LoanScope);

// In stage functions:
const assessRisk = async (scope: LoanScope) => {
  if (scope.creditScore < 600 || scope.dtiStatus === 'excessive') {
    scope.setValue('riskTier', 'high');
  }
};
```

> **Why `getValue`/`setValue` instead of direct properties?** Scope protection blocks `scope.foo = bar` — those writes bypass transactional buffering and recorder hooks. Typed getters give you clean reads; `setValue` gives you tracked writes.

### 2. Raw Scope (Low-level)

Use `ScopeFacade` directly with string keys:

```typescript
import { ScopeFacade, toScopeFactory } from 'footprintjs';

const scopeFactory = toScopeFactory(ScopeFacade);

const myStage = (scope: ScopeFacade) => {
  scope.setValue('total', 79.98);              // overwrite
  scope.updateValue('config', { retries: 3 }); // deep merge
  const total = scope.getValue('total');       // read
};
```

### 3. Validated Scope (Zod)

Zod-driven schemas that reject bad writes immediately:

```typescript
import { z } from 'zod';
import { defineScopeFromZod } from 'footprintjs';

const schema = z.object({
  creditScore: z.number(),
  riskTier: z.string().optional(),
});

const scopeFactory = defineScopeFromZod(schema);
// Proxy-based: validates writes against the schema at runtime
```

Schema-driven scopes give you compile-time type safety AND runtime validation. If a stage writes `{ retries: "three" }` to a `z.number()` field, validation catches it immediately — not three stages later when something reads the bad value.

---

## How Scope Works Internally

```
Consumer defines scope (class, factory, or Zod schema)
     |
     toScopeFactory() → normalizes to ScopeFactory
     |
     Engine calls factory(stageContext, stageName)
     |
     +→ ScopeFacade wraps StageContext (the access layer)
     |     +→ getValue/setValue delegate to memory layer
     |     +→ Recorder hooks fire on each operation
     |
     +→ Protection Proxy wraps the scope (guard rail)
     |     +→ Direct assignments blocked at runtime
     |     +→ Method calls pass through to data layer
     |
     Stage function receives the protected scope
```

Writes go through `TransactionBuffer` — staged, then committed atomically when the stage completes. This gives you:

- **Atomicity** — If a stage sets 5 values and crashes on the 4th, none are visible
- **Read-after-write** — Within a stage, you see your own uncommitted writes immediately
- **Deterministic replay** — Every write recorded in an operation trace for time-travel

---

## Recorders

Recorders observe scope operations without modifying them. Attach multiple for different concerns:

```typescript
import {
  ScopeFacade, DebugRecorder, MetricRecorder,
} from 'footprintjs';

const scopeFactory = (ctx: any, stageName: string) => {
  const scope = new ScopeFacade(ctx, stageName);
  scope.attachRecorder(new DebugRecorder({ verbosity: 'verbose' }));
  scope.attachRecorder(new MetricRecorder());
  return scope;
};
```

### Built-in Recorders

| Recorder | Captures | Audience |
|---|---|---|
| `NarrativeRecorder` | Per-stage data sentences for trace enrichment | The LLM |
| `MetricRecorder` | Timing + read/write/commit counts per stage | Ops / monitoring |
| `DebugRecorder` | Errors (always) + mutations + reads (verbose mode) | Developer |

> **Note:** `NarrativeRecorder` is attached automatically when narrative is enabled via `setEnableNarrative()` or `executor.enableNarrative()`. You only need to attach it manually if you need custom options.

### Custom Recorders

Implement any subset of six hooks: `onRead`, `onWrite`, `onCommit`, `onError`, `onStageStart`, `onStageEnd`.

```typescript
import { Recorder, WriteEvent } from 'footprintjs';

class AuditRecorder implements Recorder {
  readonly id = 'audit';
  private writes: Array<{ stage: string; key: string; value: unknown }> = [];

  onWrite(event: WriteEvent) {
    this.writes.push({ stage: event.stageName, key: event.key, value: event.value });
  }
  getWrites() { return [...this.writes]; }
}
```

### Error Isolation

If a recorder throws, the error is routed to `onError` hooks of other recorders, and the scope operation continues normally. Recorders can never break execution.

---

## Scope Protection

The #1 FootPrint bug is `scope.config = { foo: 'bar' }` instead of `scope.setValue('config', { foo: 'bar' })`. Direct assignments bypass the data layer — they're lost when the next stage creates a new scope.

Protection catches this at runtime:

```typescript
import { createProtectedScope } from 'footprintjs';

const protected = createProtectedScope(scope, {
  mode: 'error',        // 'error' | 'warn' | 'off'
  stageName: 'myStage',
});

protected.config = {};  // Throws: "Direct property assignment detected"
protected.setValue('config', {});  // Works correctly
```

Three protection modes:
- `'error'` — Throws on direct assignment (recommended for development)
- `'warn'` — Logs a warning (lenient for migration)
- `'off'` — No protection (testing only)

---

## Provider System

The provider system normalizes different scope definitions to a single `ScopeFactory` interface:

```typescript
// Class-based
const factory1 = toScopeFactory(UserScope);

// Factory-based
const factory2 = toScopeFactory((ctx, name) => new ScopeFacade(ctx, name));

// Zod-based
const factory3 = toScopeFactory(defineScopeSchema({ name: z.string() }));
```

Custom resolvers can be registered via `registerScopeResolver()` — checked before built-in resolvers.

---

For architecture details, see [src/lib/scope/README.md](../../src/lib/scope/README.md).
