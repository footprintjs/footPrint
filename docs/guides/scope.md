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
| Diagnostics of that name — `$debug('password', …)`, `$error`, `$metric`, `$eval` — and a pause payload's key of that name | `[REDACTED]` |
| A subflow key a mapper copied it into (`(p) => ({ pw: p.password })`) | `[REDACTED]` / `REDACTED` |
| The resume checkpoint and the live heap | Real value — resume and the run need it |

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

Protect named data everywhere the library keeps or shows it. Two approaches: manual per-key and declarative policy. Masking is by NAME — a key, a dotted path, a field — not a search for secrets in free text.

### The one law — what a policy covers

**A redaction policy covers everything the library retains or serves, and never the live heap or the resume checkpoint.** Served means anything a recorder, the narrative, a snapshot, an event, a log line or an answer exposes: the commit log (both encodings), the redacted mirror (`getSnapshot({ redact: true }).sharedState`), each stage's `stageReads` / `stageWrites`, every scope and flow recorder event — inline and deferred — and the recorder rows built from them, both narratives, `$debug` / `$error` / `$metric` / `$eval` / `$log` diagnostics, pause payloads, a subflow's seed, merge-back and **served state** (`subflowResults[*].treeContext.globalContext` under `redact: true` and `onSubflowExit.outputState` use the subflow's own mirror, 9.20.0), root `onRunStart` / `onRunEnd` payloads, and the chart logger's error lines. Execution computes on the real values: live state, the plain snapshot's `sharedState`, and the checkpoint `resume()` needs (its `sharedState`, subflow captures and `pauseData`) stay real. Two values are the caller's own and stay real too: the `run()` rejection (the thrown value itself) and the live fork result.

**What carries a name:**

- **State** — a key by its path; `fields` name paths inside a key's value.
- **A record handed out whole** — root input/output, a subflow's mapped seed and exit state, a pause payload, a thrown value: `keys` and `patterns` match its own enumerable keys at EVERY depth (a nested key by its own name or dotted path; `keys: ['secret']` masks `{ wrapper: { secret } }`, root array elements walked the same way), and a declared field under any key of that name is scrubbed (`fields: { customer: ['email'] }` masks `{ order: { customer: { email } } }` too). A terminal fork returns child-ID envelopes: mask the child key or address its result explicitly, for example `fields: { branchA: ['result.secret'] }`. A thrown value that carries a selected key is served masked — its text, `name` and `code` kept, no `raw` error. Each PATH is decided on its own: an object reachable at two paths is masked at the one a path rule (a dotted key, a pattern, a field path) names and served as it is at the other, while a key-name rule masks it at both; a cycle never leads back to an unmasked original.
- **A diagnostic entry** — its NAME is a state key, whatever its channel: under `keys: ['token']`, `$debug('token', v)`, `$error('token', v)` and `$metric('token', v)` are all masked, and so is a `token` inside any logged record (`$log({ request: { token } })`). See [explicit diagnostic redaction](#explicit-diagnostic-redaction) for selectors that apply to diagnostics only.
- **A subflow mapper's copy** — when an `inputMapper` or `outputMapper` copies a selected value under a NEW name (`(p) => ({ tok: p.token })`), the new key inherits the redaction, for the subflow, its merge-back and the rest of the run. The rule (the TAINT) is decided by which values the mapper READ: an object passed by reference keeps its exact verdict (`fields` included); anything the mapper computes after reading a selected value — a primitive copy, a value built from it — is selected whole. A value passed on under the name it was read under keeps that name's verdict — `(p) => ({ apiKey: p.apiKey, count: p.count })` and `{ ...p }` leave `count` visible — and the whole record handed on (`(p) => ({ ctx: p })`) hands every selected key of it to the new key (`ctx.token`). The computed half is **conservative**: the library cannot tell what a computed value carries, so `(p) => ({ apiKey: p.apiKey, next: p.count + 1 })` masks `next` in what is served too (the live value is unchanged). Values are never matched by equality across names. Reading a `fields`-selected record without reading its selected field (passing it on, testing its type) is not reading the secret. A `parallelForEach` items selector that reads a selected value masks each branch's `item` and the `into` key the same way. A mark is a NAME, run-wide: from the moment it is made, every key of that name — in the subflow, the parent, a sibling, every later stage — is selected in whatever is served, until the key is deleted.

A value with no name — a root scalar or `null`, a scalar pause payload, free error text — is selected by nothing; wrap it in a named record. Inside a stage function, an OBJECT read under a selected name and written under another (`scope.person = scope.profile`) keeps its rule; a PRIMITIVE copied under a new name (`scope.copy = scope.token`, `$debug('it', scope.item)`) or a new object built from a selected one (`{ ...scope.profile }`) is selected by its own name only — name it in the policy or mark it with `$setValue(key, value, true)`. Manual marks and taints apply from the moment they are made (not retroactively to an entry event), and a pause carries them — names only, never values — to the resumed run (`checkpoint.redactionMarks`), on the same or a fresh executor. A thrown value is checked with its `cause` and an `AggregateError`'s `errors`. A failed scrub rejects the run rather than dispatching the raw payload; a pause payload whose scrub cannot run is served as the placeholder. A pattern that names a KEY (`/password/i` — no `.`, no lookaround) is decided per object, so a linked agent history or any shared structure is walked in linear time; only a pattern that can match across the dots of a path (`/^auth\.token$/`) is tested path by path, and past 1,000,000 paths the rest of that value is served as the placeholder (one dev-mode warning) — never a failed run. A mapper that plants a selected value in an object it passes on by reference (`Object.assign(p.request, { auth: p.token })`) has that place masked too. Old recordings are not repaired by upgrading.

**`emitPatterns`** is the one separate scrub: a `$emit(name, payload)` event is selected by its event NAME and its whole payload replaced. Each test starts global/sticky regexes at index zero, so `/secret/g` masks every matching event, not alternating occurrences. A sticky `/secret/y` still matches only at the start of the name. Matching happens once before the event reaches inline or deferred observers and narrative; unmatched payloads keep their original reference. Event names do not inherit the state-key length cap. Non-stateful regexes may be frozen; global/sticky regexes need a writable `lastIndex`, and a frozen one throws before event dispatch instead of exposing its payload.

One owner keeps it. Every staged write and every tracked read passes through `StageContext`, which decides with the run's `RedactionRule` (`memory/redaction.ts`) — so a write that never passes the scope object (a subflow seed, an `outputMapper` merge-back, a resume re-seed) is retained under the same verdict as `scope.ssn = …`; the diagnostic collector, the pause path and every boundary producer ask the same rule before any observer sees a value. Two placeholders, both historical: the log and the mirror carry `'REDACTED'`; every scope-tier view (recorder events, `stageReads`/`stageWrites`, narrative, diagnostics, pause payloads) carries `'[REDACTED]'`.

#### Explicit diagnostic redaction

The state selectors already cover a diagnostic entry by its name. Set `diagnostics: { keys, patterns, fields }` inside `RedactionPolicy` IN ADDITION, for names you mask in diagnostics but not in state, or for flow-message text. Selectors use the existing path rules in a separate namespace: `logs`, `errors`, `metrics`, `evals`, or the text fields `flowMessages.description` and `flowMessages.rationale` (engine-composed text has no name of its own, so only these reach it). For example, `diagnostics: { keys: ['errors.secret'], fields: { logs: ['profile.token'] } }` masks a named error and a token inside a logged profile.

`DiagnosticCollector` asks the current run rule before each add/set, then performs the existing merge or replacement. Entry keys remain present so consumers can still locate errors. An internal retained-write bridge supplies the scope helpers with that same incoming value for emission, preserving their wrappers; legacy context/collector methods still return nothing. `emitPatterns` can additionally mask the whole wrapper. Direct context/collector writes and engine-generated entries also pass through this owner. Flow-message type, targets, timestamp, count and iteration are metadata and remain unchanged, even when all `flowMessages` text is selected. No recorder-local filter or post-run tree walk is involved.

Fields address each incoming value, not the accumulated bag. `$log(value)` writes a one-item array to `logs.messages`; `fields: { logs: ['messages.0.token'] }` therefore masks the token on **every incoming message**. Selecting `logs.messages` masks the whole incoming value. The emitted message still uses `{ value, level }`, not an extra array wrapper. A field scrub clones its value and rejects an uncloneable value before storage/emission; clear values retain their existing borrowed-reference behavior.

This protects future writes only. Changing policy on resume does not rescrub older entries; checkpoints copy diagnostic values already retained, while operational state, pause data and subflow state stay real for resumption. Retry diagnostics remain retained as before. Do not mutate public bags, retained clear objects or replace the collector to bypass the supported writers. A failed stage's text is decided once per thrown value: when `errors.stageExecutionError` is masked (by a diagnostic selector, or by a state selector that matches the name), flow `onError`, `onStageRetry`, `onThrottled` and `onRunFailed`, both narratives, a fork child's error inside the root boundary record (a thrown string or number becomes the placeholder, matched by value), redacted recorder rows and every chart-logger line all get the masked form — the placeholder as `message`, `name`/`code` kept, no `raw` error or `issues`. Masking `logs.deciderRationale` intentionally also masks the rationale reused by decision events/narrative; selecting only flow-message text does not mask independent control-flow events. `getRedactionReport()` lists marked keys (taints included) and the configured and inherited field paths — never values.

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
