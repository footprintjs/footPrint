# Scope vs Emit — the rule for where state lives

Last revised: post-Observatory design (consequence of the v6 architecture review).

Read in conjunction with:
- `footprintjs/CLAUDE.md` — the "Three access tiers" + "Emit Channel" sections
- `agentfootprint/src/core/agent/types.ts` — `AgentState` (canonical
  example of scope-based business state)
- `agentfootprint/src/core/agent/stages/callLLM.ts` — the canonical
  "scope writes business, emit fires observation" stage

---

## 1. The rule (one sentence)

**Business state goes in scope; pure observation goes in emit.** When
both, scope is canonical and emit mirrors.

This is the foundational separation between the two channels footprintjs
exposes for consumer-owned data. Get it wrong and you reinvent half the
library in your consumer.

---

## 2. Why this matters

There are two ways a consumer might carry state through a flowchart run:

1. **Scope** — `scope.x = value` reads/writes on the typed scope, captured
   in the commit log, queryable as state-at-cursor.
2. **Emit** — `scope.$emit('name', payload)` fires a one-shot observation
   event on the EmitRecorder channel.

Both look like "store some data." The temptation is to reach for emit +
a fold-style reducer to derive accumulated values ("total tokens =
fold(emits where name = 'tokens')"). This is **almost always wrong**.

If the business logic of your flowchart needs the value — to decide, to
branch, to break — it must be in scope. Period. A reducer that lives
outside the chart can't influence in-flight decisions; the chart can't
read it without re-implementing the fold. You end up writing the same
accumulation logic twice (once in the reducer, once in the chart) and
keeping them in sync forever.

Conversely: high-frequency events (stream chunks at sub-millisecond
intervals), cross-stage timing markers, and audit trails are noisy in
scope. They pollute the typed state, bloat the commit log, and force
business stages to ignore fields they don't care about.

---

## 3. Decision tree

```
Does the BUSINESS LOGIC of the flowchart read this value?
  (branch on it, break on it, decide with it, accumulate it as part
   of the chart's purpose)
│
├── YES  ──►  SCOPE (mandatory). Update via stage logic. Period.
│             Optionally ALSO emit a mirror event so observers see it
│             without re-deriving from commit log.
│
└── NO   ──►  Is the data high-frequency, cross-stage, or audit-only?
              │
              ├── YES  ──►  EMIT only. Don't pollute scope.
              │
              └── NO   ──►  Default to SCOPE. Easier to query, type-safe,
                            visible in narrative.
```

The default bias should be SCOPE. Emit is the exception, justified by
either "observers only" or "too noisy for scope" — never by "I want a
reducer to fold this later."

---

## 4. Canonical example — `callLLM` stage

[callLLM.ts:270-273](../../agentfootprint/src/core/agent/stages/callLLM.ts#L270-L273)
demonstrates the rule in action:

```ts
// Scope writes — BUSINESS state. Used by route deciders, budget
// checks, the final-answer assembly. Captured in commit log so
// state-at-cursor queries return the right value at any point in time.
scope.totalInputTokens = scope.totalInputTokens + response.usage.input;
scope.totalOutputTokens = scope.totalOutputTokens + response.usage.output;
scope.llmLatestContent = response.content;
scope.llmLatestToolCalls = response.toolCalls;
```

```ts
// Emit fires — OBSERVATION events. Carry the same numbers AS A MIRROR
// so observers (telemetry exporters, lens UI, dashboards) see them
// without re-deriving from commit log. Do not drive business
// decisions from these events.
typedEmit(scope, 'agentfootprint.stream.llm_end', {
  iteration, content, toolCallCount, usage, stopReason, durationMs,
});
```

Both channels carry the token counts. Scope is canonical: deciders
branch on `scope.totalInputTokens`. Emit is a mirror: a LangSmith
exporter reads the same number from the event payload without scanning
the commit log.

The `AgentState` interface in
[types.ts:143-244](../../agentfootprint/src/core/agent/types.ts#L143-L244)
lists 30+ scope fields covering iteration counts, token totals, cost
accounting, decision state, cache state, policy halts, and injection
state. Every one of these is business state that lives in scope because
the chart reads it.

---

## 5. Anti-patterns

### 5.1 Reducer-as-business-state

```ts
// WRONG — using emit + reducer to track business state
scope.$emit('agent.tokens', response.usage);
// ... later, observer folds emits into total
const total = observer.aggregate((sum, e) => sum + e.payload.input, 0);

// Chart can't read `total` to make decisions. Have to re-emit, or
// re-fold, or write it back to scope anyway. Two sources of truth.
```

**Fix:** put it in scope first, mirror to emit if observers need it.

### 5.2 Putting stream chunks in scope

```ts
// WRONG — stream chunks pollute scope
scope.chunks = [...scope.chunks, chunk];
// 1000 chunks per call × 10 calls × 100 runs = scope state explosion
```

**Fix:** emit per chunk; observers index by `runtimeStageId` if they
need to replay.

### 5.3 Auditing via scope

```ts
// WRONG — using scope as an audit log
scope.events = [...scope.events, { kind: 'tool_called', ... }];
// Audit trail belongs in emit; scope is for state the chart REASONS
// about, not for "everything that happened."
```

**Fix:** emit audit events; index them via an EmitRecorder.

---

## 6. When you need both — the mirror pattern

For values that drive business decisions AND are needed by external
observers, both channels carry the same value. The discipline:

- **Scope is canonical.** Stages write to scope. Deciders read from
  scope. Commit log is source of truth.
- **Emit mirrors.** The same stage that writes scope also fires an emit
  event with the same value. Observers consume the emit without scanning
  the commit log.
- **No drift.** A single line of stage code writes both; they cannot
  disagree. Never derive emit values from a different source than scope
  values.

`emitCostTick` in [callLLM.ts:292](../../agentfootprint/src/core/agent/stages/callLLM.ts#L292)
is the model:

```ts
emitCostTick(scope, deps.pricingTable, deps.costBudget, deps.model, response.usage);
// Internally: updates scope.cumEstimatedUsd + scope.costBudgetHit,
// AND fires `agentfootprint.cost.tick` with the same numbers.
```

One call, both channels, no drift.

---

## 7. Consequences for consumer architecture

If you follow this rule:

- **State-at-cursor queries are free.** `commitLog[cursor].state.X` is
  the value at time `cursor`. No fold needed.
- **Observatory shrinks.** It only indexes emit-only data (chunks,
  timing markers, audit) — not "fold these emits into a payload." That
  fold logic lives in the stage that wrote scope.
- **Telemetry exporters are pure projections.** Read scope fields from
  commit log, read emit events from emit log, ship to backend. No
  derivation, no business logic.
- **The chart is the single source of truth for business state.**
  Anything important enough to be in a typed scope field is anything
  important enough for the chart to own.

If you violate this rule:

- You'll write the same accumulation twice (scope + reducer).
- You'll discover business logic can't read the reducer's output.
- You'll add a "sync reducer back to scope" stage as a workaround.
- You'll have two sources of truth and they will drift.

---

## 8. TL;DR

| Question | Answer |
|---|---|
| Does the chart's business logic read it? | SCOPE (mandatory) |
| High-frequency stream / audit / cross-stage timing? | EMIT (only) |
| Default if unsure? | SCOPE |
| Need both for observers? | SCOPE canonical, EMIT mirror, write both in same line |
| Want a reducer to fold emits into business state? | NO — make it a scope update in the stage |

Three words: **scope owns business**.
