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

Use `ScopeFacade` directly with string keys by supplying a custom scope factory. The executor default is TypedScope over a facade, not a raw facade:

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

Field handles provide runtime validation (`scope.creditScore.set(700)`, `scope.creditScore.get()`). They are not plain typed state properties. Use `{ strict: 'deny' }` to throw on an invalid write; the default warns and drops it. Generic `setValue` is an unvalidated escape hatch. Classic Zod 3/4 wrappers retain their field operations; original-schema validation is preserved, but parsed defaults/transforms are not stored and nested writes do not revalidate parent-object cross-field rules.

### Custom scope runtime capabilities

Built-in scopes register their infrastructure capabilities automatically. Custom factory objects and strict proxies must register separately from their data fields. The executor and `decide`/`select` use this registration for recorders, redaction, lifecycle and filter reads; they no longer look for method names on the user object.

```typescript
import { registerScopeRuntime, ScopeFacade, type ScopeFactory } from 'footprintjs/advanced';

const customFactory: ScopeFactory<{ read(key: string): unknown; write(key: string, value: unknown): void }> =
  (ctx, name, input, env) => {
    const facade = new ScopeFacade(ctx, name, input, env);
    const view = { read: facade.getValue.bind(facade), write: facade.setValue.bind(facade) };
    return registerScopeRuntime(view, { target: facade, handlesAssignments: false });
  };
```

Use `handlesAssignments: true` only when your proxy already routes assignments into managed state. An optional `setBreak` callback receives the current stage's stop function. A deliberately data-only scope may register `target: {}` but offers no scope-level events or filter reads. An unregistered scope fails with migration guidance. `attachScopeMethods(target, ctx, name, input, env)` is the simpler route when standard facade method names fit: it registers and binds one facade for you. Both forms require a real `StageContext`; only low-level state adapters accept `StageContextLike`.

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
import { flowChart, FlowChartExecutor, DebugRecorder, MetricRecorder } from 'footprintjs';

const chart = flowChart<{ count: number }>('Count', (scope) => {
  scope.count = 1;
}, 'count').build();
const executor = new FlowChartExecutor(chart);
executor.attachScopeRecorder(new DebugRecorder({ verbosity: 'verbose' }));
executor.attachScopeRecorder(new MetricRecorder());
await executor.run();
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
import { createProtectedScope, ScopeFacade, StageContext, SharedMemory } from 'footprintjs/advanced';

class ConfigScope extends ScopeFacade {
  declare config: Record<string, unknown>;
}
const context = new StageContext('scope-example', 'myStage', 'my-stage', new SharedMemory());
const scope = new ConfigScope(context, 'myStage');
const protectedScope = createProtectedScope(scope, {
  mode: 'error',        // 'error' | 'warn' | 'off'
  stageName: 'myStage',
});

try {
  protectedScope.config = {};  // Throws: "Direct property assignment detected"
} catch (error) {
  console.log(String(error));
}
protectedScope.setValue('config', {});  // Works correctly
```

Three protection modes:
- `'error'` — Throws on direct assignment (recommended for development)
- `'warn'` — Logs a warning (lenient for migration)
- `'off'` — No protection (testing only)

---

## Redaction (PII Protection)

Protect named data in the run's recorded state and boundary payloads. Two approaches: manual per-key and declarative policy. This is key/path-based masking, not automatic sensitive-content detection or a safe-export guarantee for the whole snapshot.

### The one law — what a policy covers

A redaction policy covers named values in the commit log (both encodings), the redacted mirror (`getSnapshot({ redact: true }).sharedState`), each stage's `stageReads` / `stageWrites`, corresponding read/write recorder events and narrative, a subflow's `inputMapper` seed and `outputMapper` merge-back, and its **served state**. `subflowResults[*].treeContext.globalContext` under `getSnapshot({ redact: true })` and `onSubflowExit.outputState` use the subflow's own redacted mirror (9.20.0). Root `onRunStart` / `onRunEnd` payloads now use the same rule at dispatch time, before either inline observers or deferred capture receives them. Actual execution inputs, returned results, live state and resume checkpoints remain unchanged.

**Root payload contract:** `keys` and `patterns` match the payload's own enumerable string keys at EVERY depth — a nested key is masked when its own name or its dotted path matches, so `keys: ['secret']` masks `{ wrapper: { secret } }` and the elements of a root array are walked the same way. `fields` names paths inside a top-level keyed value. For example, `fields: { customer: ['email'] }` masks `customer.email`. A root scalar or `null` is unchanged. The same walk covers a subflow's mapped seed and its exit state as recorders see them; the committed state itself keeps its path verdicts. A terminal fork returns child-ID envelopes, so mask the child key or address its result explicitly, for example `fields: { branchA: ['result.secret'] }`. Root output is the chart's return, not a substitute copy of shared state. Manual marks made during a run apply to later boundary events, not retroactively to the entry event. A failed scrub rejects the run rather than dispatching the raw payload.

**Outside the state-key contract:** diagnostic values need explicit `diagnostics` selectors (below). `emitPatterns` masks matching emitted-event payloads only; it does not sanitize the corresponding bags. Pause payloads, custom recorder snapshot data/metadata and unrelated event fields remain separate surfaces. `getSnapshot({ redact: true })` selects recorded redacted state where available, not a recursive sanitizer over every snapshot field. Review or separately project these surfaces before sharing a recording. Old recordings are not repaired by upgrading.

**Repeated emitted events:** each `emitPatterns` test starts global/sticky regexes at index zero, so `/secret/g` masks every matching event, not alternating occurrences. A sticky `/secret/y` still matches only at the start of the name. Matching happens once before the event reaches inline or deferred observers and narrative; unmatched payloads keep their original reference. Event names do not inherit the state-key length cap. Non-stateful regexes may be frozen; global/sticky regexes need a writable `lastIndex`, and a frozen one throws before event dispatch instead of exposing its payload.

One owner keeps it. Every staged write and every tracked read passes through `StageContext`, which decides with the run's `RedactionRule` (`memory/redaction.ts`) — so a write that never passes the scope object (a subflow seed, an `outputMapper` merge-back, a resume re-seed) is retained under the same verdict as `scope.ssn = …`. Two placeholders, both historical: the log and the mirror carry `'REDACTED'`; every scope-tier view (recorder events, `stageReads`/`stageWrites`, narrative) carries `'[REDACTED]'`.

#### Explicit diagnostic redaction

Set `diagnostics: { keys, patterns, fields }` inside `RedactionPolicy` to mask values as the diagnostic writer receives them. Selectors use the existing path rules in a separate namespace: `logs`, `errors`, `metrics`, `evals`, or the text fields `flowMessages.description` and `flowMessages.rationale`. State selectors and per-call state marks do not apply here. For example, `diagnostics: { keys: ['errors.secret'], fields: { logs: ['profile.token'] } }` masks a named error and a token inside a logged profile.

`DiagnosticCollector` asks the current run rule before each add/set, then performs the existing merge or replacement. Entry keys remain present so consumers can still locate errors. An internal retained-write bridge supplies the scope helpers with that same incoming value for emission, preserving their wrappers; legacy context/collector methods still return nothing. `emitPatterns` can additionally mask the whole wrapper. Direct context/collector writes and engine-generated descriptions also pass through this owner. Flow-message type, targets, timestamp, count and iteration are metadata and remain unchanged, even when all `flowMessages` text is selected. No recorder-local filter or post-run tree walk is involved.

Fields address each incoming value, not the accumulated bag. `$log(value)` writes a one-item array to `logs.messages`; `fields: { logs: ['messages.0.token'] }` therefore masks the token on **every incoming message**. Selecting `logs.messages` masks the whole incoming value. The emitted message still uses `{ value, level }`, not an extra array wrapper. A field scrub clones its value and rejects an uncloneable value before storage/emission; clear values retain their existing borrowed-reference behavior.

This protects future writes only. Changing policy on resume does not rescrub older entries; checkpoints copy diagnostic values already retained, while operational state, pause data and subflow state stay real for resumption. Retry diagnostics remain retained as before. Do not mutate public bags, retained clear objects or replace the collector to bypass the supported writers. This is path masking, not a search for secrets in free text. A failed stage's text is retained once at its error site: when `errors.stageExecutionError` is masked, the flow `onError` and `onRunFailed` events carry the placeholder as `message`/`structuredError.message`, keep `name`/`code`, and carry no `raw` error or `issues` — so the narrative and recorder rows never see it. Logger output, custom emits, retry/throttle events and other recorder metadata still need their own sharing policy. Masking `logs.deciderRationale` intentionally also masks the rationale reused by decision events/narrative; selecting only flow-message text does not mask independent control-flow events. `getRedactionReport()` remains a **state-only** report, not an audit of diagnostic or emit redaction.

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
import { flowChart, FlowChartExecutor, type RedactionPolicy } from 'footprintjs';

// Synthetic values only: no real patient or credential data.
const chart = flowChart<{ ssn: string; dbPassword: string }>('Load', (scope) => {
  scope.ssn = 'example-ssn';
  scope.dbPassword = 'example-password';
}, 'load').build();

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
import { toScopeFactory, registerScopeResolver, ScopeFacade, type ScopeFactory } from 'footprintjs/advanced';
import { defineScopeSchema, ZodScopeResolver } from 'footprintjs/zod';
import { z } from 'zod';

class UserScope extends ScopeFacade {
  get name(): string { return this.getValue('name') as string; }
}

// Class-based
const factory1 = toScopeFactory(UserScope);

// Factory-based
const customFactory: ScopeFactory<ScopeFacade> = (ctx, name, input, env) =>
  new ScopeFacade(ctx, name, input, env);
const factory2 = toScopeFactory(customFactory);

// Zod-based
registerScopeResolver(ZodScopeResolver); // Once during application setup.
const factory3 = toScopeFactory(defineScopeSchema({ name: z.string() }));
```

Custom resolvers can be registered via `registerScopeResolver()` — checked before built-in resolvers.

---

For architecture details, see [src/lib/scope/README.md](../../src/lib/scope/README.md).
