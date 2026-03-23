# scope/

The data layer library. Depends on `memory/` (Phase 1). Zero dependencies on any other footprint library.

> **For new code, use TypedScope<T> (from `reactive/`) instead of ScopeFacade directly.**
> TypedScope wraps ScopeFacade in a Proxy for typed property access: `scope.creditTier`
> instead of `scope.getValue('creditTier') as string`. See `src/lib/reactive/README.md`.

---

## Why This Exists

Scope is the **data layer** of footPrint — the managed trunk through which all stage state flows.

Like React's state system sits between components and the DOM, scope sits between stage functions and shared memory. Stages don't read or write memory directly. Every read, every write, every commit passes through scope.

This positioning is deliberate. Because all data flows through one trunk, we get a natural interception point. That interception point gives us three capabilities raw memory access can't provide:

1. **Recording** — capture every state change as it happens, including custom recorders
2. **Protection** — catch the #1 footPrint bug (direct property assignment) at runtime
3. **Validation** — Zod-driven schemas that reject bad writes immediately, not three stages later

The data layer design also connects to builder/ (Phase 2). Builder descriptions are **static decoration** — they tell the LLM what a tool *does*, defined at build time. Recorders are **runtime decoration** — they tell the LLM what actually *happened* during execution. Together: full decoration. The LLM gets both the manual and the play-by-play.

---

## The Data Layer Primitives

### 1. ScopeFacade — "The Access Layer"

Base class that library consumers extend to create custom scope classes. Wraps `StageContext` from the memory library. This is where reads and writes enter the data layer.

**Why a class, not a plain object?** Two reasons:
1. **Extensibility** — consumers add domain-specific getters/setters as class properties
2. **Brand detection** — the static `BRAND` symbol lets the provider system detect ScopeFacade subclasses reliably at runtime

```typescript
class UserScope extends ScopeFacade {
  get name(): string { return this.getValue('name') as string; }
  set name(v: string) { this.setValue('name', v); }
}

const factory = toScopeFactory(UserScope);
const scope = factory(stageContext, 'processUser') as UserScope;
scope.name = 'Alice'; // writes to shared memory
```

---

### 2. Recorders — "The Change Capture"

Because all state flows through the data layer, we can observe every change. That's what recorders are — hooks at the interception point that capture reads, writes, commits, errors, and stage lifecycle events.

Recorders don't exist *on top of* the data layer. They exist *because of* it. The trunk design is what makes universal observation possible without per-stage instrumentation.

**Three built-in recorders:**

| Recorder | Captures | Audience |
|---|---|---|
| `MetricRecorder` | Timing + read/write/commit counts per stage | Ops / monitoring |
| `DebugRecorder` | Errors (always) + mutations + reads (verbose mode) | Developer |
| `NarrativeRecorder` | Per-stage data sentences for trace enrichment | **The LLM** |

**NarrativeRecorder is the unique one.** It produces runtime decoration — per-stage sentences like *"Stage 'fetchUser' read 'userId' and wrote 'userName', 'userEmail'"*. This is the runtime counterpart to builder's static tool descriptions. Builder tells the LLM what the tool does. NarrativeRecorder tells it what data flowed, what changed, what conditions were hit, and why a stage backtracked. Together they give the LLM full context without re-running the pipeline.

**Build your own recorder.** The Recorder interface is all-optional — implement only the hooks you need. An error tracker only needs `onError`. A timing recorder only needs `onStageStart`/`onStageEnd`. Because the data layer captures everything, any recorder you attach automatically sees all state changes. No instrumentation needed.

**Error isolation:** If a recorder throws, the error is caught and forwarded to `onError` hooks of other recorders. Scope operations continue normally. Recorders can never break execution.

```typescript
const executor = new FlowChartExecutor(chart);
executor.attachRecorder(new MetricRecorder());
executor.attachRecorder(new NarrativeRecorder({ detail: 'full' }));

await executor.run();

const metrics = executor.getRecorders().find(r => r instanceof MetricRecorder);
console.log(metrics.getMetrics().totalReads);
```

**Custom recorder example:**

```typescript
const auditRecorder: Recorder = {
  id: 'audit',
  onWrite: (event) => auditLog.append(event.key, event.value),
  onError: (event) => alerting.fire(event.error),
};
executor.attachRecorder(auditRecorder);
```

---

### 2b. Redaction — "The PII Shield"

Redaction sits between the data layer and recorders. Two mechanisms:

**Manual:** `setValue(key, value, true)` marks a key as redacted. All recorders see `[REDACTED]` for that key's reads and writes. Runtime always gets the real value.

**Policy-based:** `RedactionPolicy` is a declarative config object with three dimensions:
- `keys: string[]` — exact key names to always redact
- `patterns: RegExp[]` — any key matching a pattern is auto-redacted
- `fields: Record<string, string[]>` — field-level scrubbing within objects (supports dot-notation for nested paths, e.g. `'address.zip'`)

The policy is injected via `useRedactionPolicy()` on ScopeFacade, or at the executor level via `executor.setRedactionPolicy(policy)`. Cross-stage persistence is automatic via `useSharedRedactedKeys()`.

`getRedactionReport()` returns a compliance-friendly audit trail: which keys were redacted, which fields were scrubbed, which patterns were active. Never includes actual values.

---

### 3. Protection — "The Guard Rail"

Proxy-based protection layer that intercepts direct property assignment on scope objects.

The #1 footPrint bug is `scope.config = { foo: 'bar' }` instead of `scope.setValue('config', { foo: 'bar' })`. Direct assignments bypass the data layer — they're lost when the next stage creates a new scope. Protection catches this at runtime with a clear error message.

```typescript
const protected = createProtectedScope(scope, {
  mode: 'error',        // 'error' | 'warn' | 'off'
  stageName: 'myStage',
});

protected.config = {};  // Throws: "Direct property assignment detected"
protected.setValue('config', {});  // Works correctly — goes through the data layer
```

---

### 4. Providers — "The Factory System"

Resolves arbitrary inputs (factory functions, classes, Zod schemas) into the `ScopeFactory` type that the pipeline expects.

Consumers bring different scope definitions — some use classes, some use factories, some use Zod schemas. The provider system normalizes all of them to a single interface, so the engine doesn't care which approach the consumer chose.

**Resolution order:** Custom resolvers (registered via `registerScopeResolver`) are checked first. Built-in resolvers (class detection via `isSubclassOfScopeFacade`, factory detection via `looksLikeFactory`) are fallbacks.

```typescript
// Class-based
const factory1 = toScopeFactory(UserScope);

// Factory-based
const factory2 = toScopeFactory((ctx, name) => ({ name }));

// Zod-based (requires ZodScopeResolver to be registered)
const factory3 = toScopeFactory(defineScopeSchema({ name: z.string() }));
```

---

### 5. Zod Integration — "The Schema-Driven Scope"

Creates lazy, copy-on-write proxies driven by Zod object schemas. Validates writes at runtime.

Schema-driven scopes give you compile-time type safety AND runtime validation. If a stage writes `{ retries: "three" }` to a `z.number()` field, the validation catches it immediately — not three stages later when something reads the bad value.

```typescript
const schema = defineScopeSchema({
  name: z.string(),
  config: z.object({
    retries: z.number(),
    metadata: z.record(z.string()),
  }),
});

const factory = defineScopeFromZod(schema, { strict: 'warn' });
const scope = factory(ctx, 'myStage');

scope.name.set('Alice');        // validated
scope.config.retries.set(3);    // validated
scope.config.retries.set('x');  // warns: invalid value
```

---

## How They Work Together

```
Consumer defines scope (class, factory, or Zod schema)
     |
     toScopeFactory() → normalizes to ScopeFactory
     |
     Engine calls factory(stageContext, stageName)
     |
     +-→ ScopeFacade wraps StageContext (the access layer)
     |     +-→ getValue/setValue delegate to memory layer
     |     +-→ Recorder hooks fire on each operation (change capture)
     |
     +-→ createProtectedScope wraps the scope in a Proxy (guard rail)
     |     +-→ Direct assignments blocked
     |     +-→ Method calls pass through the data layer
     |
     Stage function receives the protected scope
     |
     Stage reads/writes via scope methods
     |
     Recorders observe every change → metrics, debug logs, LLM narrative
```

**The static + runtime decoration picture:**

```
Builder (Phase 2)                    Scope Recorders (Phase 3)
─────────────────                    ─────────────────────────
Build time                           Runtime
"This tool fetches user data"        "Stage read userId=42, wrote userName='Alice'"
Static decoration                    Runtime decoration
         \                              /
          \                            /
           → LLM gets full context ←
             (manual + play-by-play)
```

---

## Design Decisions

| Decision | Why | How it serves the data layer |
|---|---|---|
| ScopeFacade wraps StageContext | Consumers get clean API, internals stay hidden | Single trunk — all state flows through one place |
| Recorder interface is all-optional | Partial implementations are the common case | Easy to build custom recorders (error-only, timing-only, audit) |
| Recorder errors caught + forwarded to onError | Observers must never break the observed system | Production safety — bad recorder can't crash pipeline |
| NarrativeRecorder summarizes values | Raw values can be huge (LLM responses, arrays) | Runtime decoration stays concise for LLM context windows |
| Protection uses Proxy, not linting | Runtime catch is more reliable than build-time | Catches bypasses even in JS (non-TypeScript) consumers |
| Three protection modes (error/warn/off) | Different needs for dev vs prod vs testing | Strict in dev, lenient where needed |
| Provider system with pluggable resolvers | New scope types (Zod) don't require engine changes | Plugin architecture — extend without modifying core |
| Guards use heuristics (stringify, prototype) | Must work with transpiled code, not just native classes | Reliable detection across CJS/ESM/bundlers |
| Zod proxy uses copy-on-write | Only clone when writing, reads are lazy | Performance — no upfront cost for unused fields |
| Zod validation is configurable (off/warn/deny) | Some contexts need performance, others need safety | Consumer chooses the right tradeoff |
| ScopeFacade uses BRAND symbol | Prototype chain checking alone fails with some bundlers | Reliable detection even with module duplication |

---

## Dependency Graph

```
This library depends ONLY on memory/.

  ScopeFacade ──────────→ memory/StageContext
       |
  protection/             (zero deps on other scope modules)
       |
  recorders/              (depends on types.ts only)
       |
  providers/              (depends on ScopeFacade for guards)
       |
  state/zod/              (depends on providers/types)
```

External dependencies: `zod` (peer dependency, only for state/zod/).

---

## Test Coverage

Four test tiers, 113 tests across 14 suites:

| Tier | What it proves | Example |
|---|---|---|
| **unit/** | Individual class/function correctness | ScopeFacade.getValue reads from StageContext |
| **scenario/** | Multi-step workflow correctness | recorder observes real writes → class vs factory scope → Zod validated scope |
| **property/** | Invariants hold for random inputs (fast-check) | throwing recorders never break execution, Zod rejects invalid writes |
| **boundary/** | Edge cases and extremes | 50 recorders, deeply nested Zod schema, error conditions |

### Tested Capacity (Boundary Results)

| What | Tested at | Detail |
|---|---|---|
| Concurrent recorders | **100** | 100 MetricRecorders all track independently |
| Mixed throwing recorders | **50** | 25 throwing + 25 normal, execution continues |
| Zod schema depth | **5 levels** | 5-level nested object with set/get at leaf |
| Zod object fields | **20** | 20 fields in single schema, all accessible |
| Zod record keys | **50** | 50 dynamic keys in z.record |
| Zod array elements | **100** | 100-element array set/get |
