# Scope

Each stage in a FootPrint pipeline receives a **scope** — a transactional interface to shared state. Writes are buffered per stage and committed in one batch when the stage finishes (including when it throws — the staged writes are kept as audit evidence, not rolled back). Recorders observe every operation without modifying behavior.

---

## Three Ways to Define Scope

### 1. Typed Scope (Recommended)

Extend `ScopeFacade` with domain-specific getters for type-safe reads:

```typescript
import { ScopeFacade, toScopeFactory } from 'footprintjs/advanced';

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

Use `ScopeFacade` directly with string keys. When you pass no scope factory to `FlowChartExecutor`, this is what you get by default:

```typescript
import { ScopeFacade } from 'footprintjs/advanced';

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
import { defineScopeFromZod } from 'footprintjs/zod';

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

Writes go through `TransactionBuffer` — staged, then committed in one batch when the stage finishes. This gives you:

- **No mid-stage visibility** — Other stages and parallel siblings never see half-finished writes; everything lands in one commit
- **Read-after-write** — Within a stage, you see your own uncommitted writes immediately
- **Deterministic replay** — Every write recorded in an operation trace for time-travel

It is **not rollback**: when a stage throws, the engine still commits everything the stage staged before re-throwing — deliberately, so the audit trail records what the failing stage changed. A staging buffer with read-your-writes, not atomicity.

---

## Recorders

Recorders observe scope operations without modifying them. Attach multiple for different concerns:

```typescript
import { FlowChartExecutor, DebugRecorder, MetricRecorder } from 'footprintjs';

const executor = new FlowChartExecutor(chart);
executor.attachScopeRecorder(new DebugRecorder({ verbosity: 'verbose' }));
executor.attachScopeRecorder(new MetricRecorder());
```

**ID-based idempotency:** `attachScopeRecorder` replaces any existing recorder with the same ID. Each `new MetricRecorder()` gets a unique auto-increment ID (`metrics-1`, `metrics-2`, ...), so multiple instances with different configs coexist. To override a framework-attached recorder, pass the same ID: `new MetricRecorder('metrics')`.

### Built-in Recorders

| Recorder | Captures | Audience |
|---|---|---|
| `narrative()` | Per-stage data sentences + control flow for trace enrichment | The LLM |
| `MetricRecorder` | Timing + read/write/commit counts per stage | Ops / monitoring |
| `DebugRecorder` | Errors (always) + mutations + reads (verbose mode) | Developer |

> **Note:** `narrative()` from `footprintjs/recorders` produces the combined flow + data narrative — it is a `CombinedNarrativeRecorder` (spans the scope and flow channels). Attach it to an executor instance via `executor.attachCombinedRecorder(narrative())`, or call `executor.enableNarrative()` to wire the default one in a single step.

### Custom Recorders

Implement any subset of the `ScopeRecorder` hooks: `onRead`, `onWrite`, `onCommit`, `onError`, `onStageStart`, `onStageEnd`, `onPause`, `onResume`, `onEmit`.

```typescript
import type { ScopeRecorder, WriteEvent } from 'footprintjs';

class AuditRecorder implements ScopeRecorder {
  readonly id = 'audit';
  private writes: Array<{ stage: string; key: string; value: unknown }> = [];

  onWrite(event: WriteEvent) {
    this.writes.push({ stage: event.stageName, key: event.key, value: event.value });
  }
  getWrites() { return [...this.writes]; }
}
```

### Redaction (PII Protection)

When your pipeline handles sensitive data (passwords, API keys, credit card numbers, SSNs), you don't want those values leaking into recorder output — narratives, debug logs, or custom audit trails.

Pass `shouldRedact = true` as the third argument to `setValue()`:

```typescript
scope.setValue('creditCard', '4111-1111-1111-1111', true);
scope.setValue('apiKey', 'sk-secret-key-xyz', true);
scope.setValue('publicName', 'Alice'); // not redacted
```

**What happens:**

| Consumer | Sees |
|----------|------|
| Stage function (`getValue`) | Real value — runtime needs it |
| `narrative()` recorder | `[REDACTED]` |
| DebugRecorder | `[REDACTED]` |
| MetricRecorder | Counts only (safe by default) |
| Custom recorders | `[REDACTED]` |
| EventLog (time-travel) | `REDACTED` |
| Served state — the redacted mirror, `subflowResults[*].globalContext` and `onSubflowExit.outputState` under a policy | `REDACTED` (a per-call mark alone, with no policy, leaves the exit event carrying `[REDACTED]`) |

Redaction is **declare-once, applied everywhere**. Once a key is marked sensitive via `setValue(..., true)`, subsequent reads of that key also send `[REDACTED]` to recorders:

```typescript
// Write — recorders see [REDACTED]
scope.setValue('password', 'super-secret', true);

// Read — runtime gets 'super-secret', recorders see [REDACTED]
const pwd = scope.getValue('password'); // → 'super-secret'
```

Recorder events include a `redacted: true` flag so recorders can distinguish redacted values from literal `"[REDACTED]"` strings:

```typescript
class ComplianceRecorder implements ScopeRecorder {
  readonly id = 'compliance';
  onWrite(event: WriteEvent) {
    if (event.redacted) {
      console.log(`PII write detected: ${event.key}`);
    }
  }
}
```

`updateValue()` on a previously-redacted key stays redacted. `deleteValue()` clears the redaction status, so re-setting the same key without `shouldRedact` makes it visible again.

**Cross-stage redaction:** When running via `FlowChartExecutor`, redacted keys are automatically shared across all stages. A key marked redacted in stage 1 stays redacted in stage 5's reads — no extra configuration needed.

To redact keys declaratively across every stage, attach a policy to the executor:

```typescript
const executor = new FlowChartExecutor(chart);
executor.attachScopeRecorder(myRecorder);
executor.setRedactionPolicy({ keys: ['ssn', 'password'] });
```

Custom scope factories that maintain their own redaction set across stages can share it via the scope's `useSharedRedactedKeys(sharedSet)` method.

### Error Isolation

If a recorder throws, the error is routed to `onError` hooks of other recorders, and the scope operation continues normally. Recorders can never break execution.

---

## Scope Protection

The #1 FootPrint bug is `scope.config = { foo: 'bar' }` instead of `scope.setValue('config', { foo: 'bar' })`. Direct assignments bypass the data layer — they're lost when the next stage creates a new scope.

Protection catches this at runtime:

```typescript
import { createProtectedScope } from 'footprintjs/advanced';

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

## Redaction (PII Protection)

Protect sensitive data in everything the run keeps or shows. Two approaches: manual per-key and declarative policy.

### The one law — what a policy covers

A redaction policy covers **everything the run retains or serves** — the commit log (both encodings), the redacted mirror (`getSnapshot({ redact: true })`), each stage's `stageReads` / `stageWrites` in the execution tree, recorder events and the narrative, a subflow's `inputMapper` seed (its `history[0]` and its narrative `Input:` line), its `outputMapper` merge-back into the parent, and its **served state** — `subflowResults[*].treeContext.globalContext` under `getSnapshot({ redact: true })` and the `outputState` an `onSubflowExit` recorder receives are the subflow's own redacted mirror (9.20.0) — and **never** the live heap the run computes on (`getSnapshot().sharedState`, what your stage functions read) nor the resume checkpoint (resumption must replay real values; the checkpoint is handed to the runner, never served).

One owner keeps it. Every staged write and every tracked read passes through `StageContext`, which decides with the run's `RedactionRule` (`memory/redaction.ts`) — so a write that never passes the scope object (a subflow seed, an `outputMapper` merge-back, a resume re-seed) is retained under the same verdict as `scope.ssn = …`. Two placeholders, both historical: the log and the mirror carry `'REDACTED'`; every scope-tier view (recorder events, `stageReads`/`stageWrites`, narrative) carries `'[REDACTED]'`.

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';

interface Inner { apiKey: string; profile: { auth: { token: string }; name: string }; seen: number }
interface Outer { apiKey: string; profile: { auth: { token: string }; name: string }; seen?: number }

const inner = flowChart<Inner>('Inside', (scope) => {
  scope.seen = scope.apiKey.length; // the subflow computes on the REAL seed
}, 'inside').build();

const chart = flowChart<Outer>('Start', (scope) => {
  scope.apiKey = 'sk-live-…';
  scope.profile = { auth: { token: 'tok-…' }, name: 'Ada' };
}, 'start')
  .addSubFlowChartNext('sf', inner, 'Sub', {
    inputMapper: (parent) => ({ apiKey: parent.apiKey, profile: parent.profile }),
    outputMapper: (out) => ({ seen: out.seen }),
  })
  .build();

const executor = new FlowChartExecutor(chart);
executor.setRedactionPolicy({ keys: ['apiKey'], fields: { profile: ['auth.token'] } });
await executor.run();

const snapshot = executor.getSnapshot();
snapshot.sharedState.apiKey;                       // 'sk-live-…'  — the live heap, never scrubbed
snapshot.commitLog[0].overwrite.apiKey;            // 'REDACTED'   — the log
snapshot.commitLog[0].overwrite.profile;           // { auth: { token: 'REDACTED' }, name: 'Ada' }
executor.getSnapshot({ redact: true }).sharedState; // the mirror agrees with the log
const sub = snapshot.subflowResults!['sf'] as { treeContext: { history: Array<{ overwrite: Record<string, unknown> }> } };
sub.treeContext.history[0].overwrite.apiKey;       // 'REDACTED'   — the subflow's seed commit
const served = executor.getSnapshot({ redact: true }).subflowResults!['sf'] as { treeContext: { globalContext: Record<string, unknown> } };
served.treeContext.globalContext.apiKey;           // 'REDACTED'   — the subflow's own mirror (9.20.0); plain getSnapshot() serves its live heap
```

A consumer that sets no policy sees no change. A consumer with a policy now sees **more** scrubbed than before 9.19.0, when five paths bypassed it: an `outputMapper` merge-back, an `inputMapper` seed and its narrative `Input:` line, a tracked read's `stageReads` retention, and a `fields` (dot-path) policy, which scrubbed recorder events only while the log kept the field.

**A limit closed in 9.20.0:** until 9.19.x, `subflowResults[*].treeContext.globalContext` (and its per-iteration `#n` twin) was the subflow's raw heap even under `getSnapshot({ redact: true })`, because only the run-level runtime kept a mirror — a consumer had to refold the subflow's scrubbed `history` with `stateAt` to serve its final state. Each subflow now keeps its own mirror whenever the run does, and the served state IS that mirror: `stateAt(sub.treeContext, sub.treeContext.history.length - 1).state` equals it exactly, so the refold is no longer needed (it still works).

### Manual Redaction

Flag individual keys at write time:

```typescript
scope.setValue('creditCard', '4111-1111-1111-1111', true);
// Runtime getValue() → real value
// All recorders → [REDACTED]
```

Once redacted, the key stays redacted for all subsequent reads and across stages (when using `FlowChartExecutor`).

### RedactionPolicy (Recommended)

Define once, applied everywhere — no per-call flags needed:

```typescript
import { FlowChartExecutor, type RedactionPolicy } from 'footprintjs';

const policy: RedactionPolicy = {
  keys: ['ssn', 'creditCard'],               // exact key names
  patterns: [/password|secret|token/i],       // regex — any matching key auto-redacts
  fields: { patient: ['ssn', 'dob', 'address.zip'] }, // field-level — supports dot-notation for nested paths
};

const executor = new FlowChartExecutor(chart);
executor.setRedactionPolicy(policy);
await executor.run();
```

**Exact keys** — `setValue('ssn', ...)` auto-redacts without passing `true`.

**Patterns** — `setValue('dbPassword', ...)` matches `/password/i` and auto-redacts. For very long key names, use `keys` (exact match) instead of patterns — pattern matching is skipped for unusually long keys as a guard against regex backtracking.

**Field-level** — `setValue('patient', { name: 'Alice', ssn: '123', dob: '...' })` stores the full object in memory; recorders receive `{ name: 'Alice', ssn: '[REDACTED]', dob: '[REDACTED]' }`, and the commit log and mirror record `{ name: 'Alice', ssn: 'REDACTED', dob: 'REDACTED' }` (9.19.0 — before, the log kept the fields). Supports dot-notation for nested paths: `fields: { patient: ['address.zip'] }` scrubs `patient.address.zip` while preserving all other nested properties.

### Audit Trail

After a run, get a compliance-friendly report of what was redacted:

```typescript
const report = executor.getRedactionReport();
// {
//   redactedKeys: ['ssn', 'creditCard', 'dbPassword'],
//   fieldRedactions: { patient: ['ssn', 'dob'] },
//   patterns: ['password|secret|token']
// }
```

Never includes actual values — only key names, field names, and pattern sources.

### Class-Level Policy

Define a policy once in your scope subclass:

```typescript
class PatientScope extends ScopeFacade {
  static readonly REDACTION_POLICY: RedactionPolicy = {
    keys: ['ssn'],
    patterns: [/password/i],
    fields: { patient: ['dob', 'ssn', 'address.zip'] },
  };
}
```

Then apply it in the scope factory or via `executor.setRedactionPolicy(PatientScope.REDACTION_POLICY)`.

---

## Provider System

The provider system normalizes different scope definitions to a single `ScopeFactory` interface. `toScopeFactory` and `registerScopeResolver` are engine-level helpers from `footprintjs/advanced`; the Zod helper `defineScopeSchema` lives in the opt-in `footprintjs/zod` entry:

```typescript
import { toScopeFactory, ScopeFacade } from 'footprintjs/advanced';
import { defineScopeSchema } from 'footprintjs/zod';

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
