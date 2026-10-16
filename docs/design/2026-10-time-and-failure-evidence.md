# Time and failure evidence — deadlines, attempts, side effects, correlation, a crash-safe record, and the numbers that lead back to it (design, 2026-10-15)

**Decision (owner, 2026-10-15):** go on items 1–5; items 6 and 7 added; then two more rulings the same day — a
retry LIVES IN THE FLOWCHART as a loop (three shapes, one record, §3.8) and the Flow Lens must DRAW it as one (the
visual contract, §3.9). This page is the field-level design the implementation PRs follow. Read on footprintjs `origin/main` 69a54c06 (10.0.1), foottrace 1.0.3 (the installed
package; the source checkout is not at `~/github/footprintjs/foottrace` — see Q4), agentfootprint 9.135.1.

**Status:** design only. No code. Where a packet finds the code's existing law overrides this page, the packet's
PR names the override in a status addendum here, the way `2026-09-declared-tags.md` did.

**Status addendum — P1a (the attempt runner, 2026-10-15).** Shipped as §3.1, §3.8, §3.9, §4 and §5 say, with these
overrides, each forced by the code's law or by a gap this page left:

1. **Layering.** `attempt/types.ts` is an L0 leaf, and `decide/types.ts` (types and one Symbol, no imports) with it:
   `StageSnapshot` (`memory/frameTypes.ts`, L4) names `AttemptRecord`, and the fence refuses an upward type
   reference (`TYPE_ONLY_ALLOWANCES` only shrinks). The runner, the rule table and the classifier are L5, as §7 says.
   `RetryPolicy` is declared in `attempt/types.ts`; `engine/types.ts` re-exports it, so no import site moved.
2. **No `id` on `AttemptRecord` yet.** The attempt-id grammar is foottrace's (P0, §3.4) and P1a depends on nothing,
   so a record is identified by `series` + `attempt` until the engine stamps `buildAttemptId` in the packet that
   adopts foottrace 1.1.0. Building the id locally would have made the engine a second owner of an id grammar.
3. **Rule 6 is a filter over one derived input**, `timeLeftAfterWaitMs ≤ 0` (`= timeLeftMs − delayMs`, `Infinity`
   without a deadline): a `decide()` filter compares an input with a CONSTANT, and `delayMs` varies per attempt.
   `AttemptInputs` gains that input; the property test runs `decide()` over it.
4. **Each rule's label is the reason it names** (`succeeded`, `paused`, `aborted`, `exhausted`, `declined`,
   `no-time-left`; default `retryable`), so `reason` is a projection of the evidence. Rule 5's label is `declined`.
5. **The evidence carries no error row**: no default rule reads the error, so a decision holds names, numbers and the
   `retryOn` verdict only. The error rides the record SERVED (`error`, no `raw`) and as its `category`.
6. **`category` is absent on an `ok` or `paused` attempt** (a category is a failure's), and
   `AttemptSummary.last.next` is typed `'done' | 'stop'`.
7. **The abort decides first; otherwise the 9.15 order holds.** Rule 3 precedes rule 5, so a run already aborted when
   an attempt fails no longer consults `retryOn` (the 9.15 loop asked it, then threw the same error anyway) — the one
   behavioural difference, named in CHANGELOG. Everything else keeps the 9.15 order of a failed attempt: `retryOn` →
   the abort check → the discard (`between`) → `backoffMs` → the served error → `onStageRetry` → the wait → the abort
   check. So an abort raised inside `retryOn` stops the series before the discard and `backoffMs` is never asked (the
   decision is taken again, and rule 3 now matches); an abort raised inside `backoffMs` comes after the discard, so
   the failed attempt's writes are discarded, `onStageRetry` still fires and the series ends at the wait (#8); and
   the served error (and the category) are read after `retryOn` ran, so an edit it makes to the thrown value shows.
   Rule 6 needs no wait to decide while there is no deadline (the time left is `Infinity` either way), which is
   what lets `backoffMs` wait for the discard; the deadline packet must keep that order. All three are pinned in
   `test/lib/attempt/unit/runner.test.ts`, and on a real chart in `test/lib/attempt/boundary`.
8. **A wait cut by the run's signal records no phantom attempt**: the last record keeps its `retry` decision (it was
   true when made) and `attemptSummary.last` says `stop` / `aborted`. The §10 series invariant ("exactly one record
   with `next ≠ 'retry'`") holds for every series the signal did not cut.
9. **A failed stage's attempt lines.** The combined narrative never narrated a failed stage's buffered ops (its
   `[Error]` line stands for it); attempt lines are now the exception and follow that line, so an exhausted or
   declined stop is told. The flow-only narrative (`NarrativeFlowRecorder` and its strategies) puts them in the same
   place: it holds a stage's attempt sentences until the stage's outcome is known, tells them beneath the error
   sentence of a stage that failed, and before the completing sentence of one that did not (where they always
   stood). A stage with no policy narrates byte-identically in both.
10. **`executeStage` is no longer `async`**: a policy stage runs on the runner's promise (one await per attempt, as
    in 9.15) and a no-policy stage keeps its pre-10.1 async frame, so microtask order — and parallel siblings' settle
    order — does not move. Pinned by `test/lib/attempt/scenario/attempt-settle-order.test.ts`: a fork of [a retried
    child, a plain child, a subflow child] commits in 10.0.1's order, whether the retried child succeeds first time
    or recovers.
11. **`renderAttempt` returns `string | null | undefined`** (the `renderOp` / `renderEmit` contract). The
    `'retry'` entry type stays declared, so a narrative stored by 9.15–10.0 still type-checks. What no longer has a
    caller is REMOVED, not kept declared (the owner's no-shim rule): `NarrativeFormatter.renderRetry` and its
    `RetryRenderContext`, `CombinedNarrativeRecorder.onStageRetry` and `NarrativeFlowRecorder.onStageRetry`. The
    attempt sentence replaces all of them; the CHANGELOG names each.
12. **Fixed contradictions in this page**: law 2 and the §1 "Retry evidence" row said the retry narrative stays
    byte-identical; §5, §8 and §9 replace it with the attempt line. They now agree with §5.
13. **A record never rewrites what the attempt did.** An attempt that threw its own error is `failed`, with the
    category of that error, even when the run aborted around it; the abort is the series' stop reason. So rule 3
    reads a new input, `aborted` (the run's signal, read live), not `outcome = aborted` (§3.1). Only an attempt that
    threw the run's own abort reason — what `StageRunner`'s race rejects with — is `aborted` (category `unknown`,
    §3.9).
14. **A throwing `retryOn` is recorded apart from a real `false`.** The decision is unchanged (a throw is "do not
    retry", reason `declined`, rule 5's input reads `false`); the record and `attemptSummary.last` add
    `retryOnThrew: true`, and the attempt line says `stopped: retryOn threw`.
15. **One reading of the ceiling, one validity rule.** `attempt/policy.ts · attemptCeiling` (a whole number ≥ 1;
    `NaN`, `Infinity` and `0` are `1`) is shared by the engine's gate, the runner and `retryRules`, so they can never
    disagree. `retryPolicyProblem` is the builder's refusal (`attempts` a whole number ≥ 1), now also applied to a
    StageNode a stage returns at run time (`FlowchartTraverser · admitDynamicNodes`, the R5 door), on the stage's
    error path.

**Status addendum — P4 (correlation, 2026-10-16).** Shipped as §3.4 says, with these overrides:

1. **Layering.** `RunCorrelation` is declared in `attempt/types.ts` (L0), beside `AttemptRecord`, because
   `RuntimeSnapshot` (`runner/ExecutionRuntime.ts`, L4) names it; the codec and the resolution are
   `attempt/correlation.ts` (L5). `resolveCorrelation` reads a structural `CorrelationEnv`, so the L5 file names
   nothing of the engine's `ExecutionEnv`.
2. **Scope and emit events carry `correlation` as their own key.** §3.4 wrote `event.traversalContext?.correlation`
   "on every flow and scope event", but a scope event has no `TraversalContext` (it carries `RecorderContext`).
   So: `TraversalContext.correlation` on flow events; `RecorderContext.correlation` on every scope event and
   `EmitEvent.correlation` on emits — the same frozen object, stamped last and only when present, by
   `ScopeFacade · _correlated` (installed per leg by `RunObservers · composeScopeFactory`, the redaction
   modifier's precedent). The executor-made `onResume` pair and the deferred tier's synthesized `onError`
   (`DeferredObserverTier · deliverListenerError`, read off the captured event) carry it too.
3. **Three emitters carry no correlation** — they carry no `TraversalContext` at all (engine/narrative/README.md):
   `onSubflowRegistered`, an `onLoop` fired for a decider's own `loopTo` or a dynamic next, and the `onPause`
   re-raised for a waiting parallel sibling on resume. Giving them a stamp changes recorder rows and the narrative
   for runs WITHOUT a correlation (law 2), so it is a separate packet; pinned by
   `test/lib/attempt/scenario/run-correlation.test.ts`.
4. **A refused header refuses the run.** `run()` / `resume()` resolve the correlation once, before any state moves
   (after the input check; on resume after the plan, before the counters are seeded), and reject with
   `TraceparentError` — `reason` one of `not-a-string`, `length`, `version`, `characters`, `zero-trace-id`,
   `zero-parent-id`; the header is never in the message or on the error. Explicit ids do not rescue a bad header.
   W3C's "start a new trace" is the caller's choice (parse first, drop on refusal) — shown in
   `examples/integrations/traceparent.ts`.
5. **The reading rules.** Version `00` is exactly 55 characters; a future version (not `ff`) is read by its first
   four fields and must continue with `-`; nothing longer than 256 characters is scanned. Only the sampled bit is
   carried. Explicit ids are 1–256 printable ASCII characters with no space (refused by field name, never echoed —
   they ride every event, so a control character or a megabyte must not); an empty one is no id; `operationId`
   with no trace is refused. Explicit ids win, and the header's `sampled` and `traceparent` ride ONLY while the
   trace is the header's: `traceparent` is rebuilt from the EFFECTIVE ids (`formatTraceparent`), omitted when the
   operation is not a W3C parent-id — so the record never names one trace while propagating another, and no
   received byte beyond the canonical header is kept. `sampled` is the caller's hint, never a retention policy.
6. **One read of the env.** `attempt/correlation.ts · admitRunEnv` takes ONE own-field snapshot of the env (every
   getter runs once; nothing is read off the prototype), resolves the correlation from it, and puts the canonical
   header in it as `traceparent`; that snapshot is what the stages' `$getEnv()` returns, so stage code never holds
   the received bytes. The composed scope factory installs the correlation on every target even when absent, so a
   target a custom factory re-uses is cleared.
7. **Per leg, never carried.** The checkpoint carries no correlation (lean format 2 unchanged): a resume takes ITS
   env's, and a resume without one has none. The header is not turned into `env.traceId`. The correlation lives on the leg's traverser and composed scope factory, never on the built chart,
   so concurrent executors of one chart keep their own (`test/lib/attempt/security/correlation-isolation.test.ts`).

## 0. On one screen

Today a stage's retry is the ONE thing the engine makes visible about time and failure: `FlowchartTraverser ·
executeStage` runs the declared `RetryPolicy`, fires `onStageRetry` per absorbed failure, and nothing else is
recorded — not how long an attempt took, not why retrying stopped, not a deadline, not a retry that happened inside an
HTTP client. A real incident in a consuming app showed the gap: the record said "one stage, one error"; the truth was
four attempts of 40 s each inside an SDK, past a 120 s caller budget.

This design adds ONE primitive and composes everything else from it:

- **An attempt runner** (`src/lib/attempt/`, a leaf beside `decide/`): runs a function under a policy, a deadline and a signal,
  and produces one `AttemptRecord` per try with start, duration, outcome and — on the last — why the series stopped.
  The engine's stage retry loop moves onto it (byte-identical behaviour), `scope.$call()` and the standalone
  `attempt()` are the same runner for calls INSIDE a stage, and an SDK's own retries are reported INTO it as
  observed attempts. One loop, one record shape, one hook (`onAttempt`).
- **A deadline** the whole run sees: `run({ deadline })` / `timeoutMs` → `env.deadline`; every attempt is capped by
  the time left; the run's signal ends the stage at the deadline.
- **A side-effect law**: a stage that `.touches()` an outside system and retries must declare an idempotency key; a
  timed-out attempt on it is recorded `effect: 'unknown'` and the stage fails with `UnknownEffectError` so the next
  step reconciles.
- **Correlation**: `env.traceparent` (W3C) or `env.traceId` + `env.operationId`, kept on the snapshot, stamped on
  every event; every attempt has an id under its `runtimeStageId`.
- **A crash-safe record**: foottrace owns a `RecordSink` port (opened / commit / closed entries) and the reader that
  says "this run has no closing entry"; the engine wires it and ships the file adapter on a Node-only door.
- **A static budget**: `.budget(ms)` on the chart and `timeBudget(chart)` compute the worst case per path from the
  declared policies and name every stage that makes it unbounded.
- **A metric layer**: the `attempts()` recorder aggregates per target and per run with p50/p90/p95/max, accumulates
  across runs through a store port, exports an OTLP-shaped document — and every number carries exemplar attempt ids,
  worst first.
- **A retry is a loop, in three shapes, one record** (§3.8): a declared policy is a COMPACT loop whose every
  retry-or-stop decision is recorded in the shape `decide()` produces; a side-effecting retry is a REAL chart loop
  built by pure sugar (`addRetryLoop`: attempt → reconcile → decide → loopTo); a call inside a stage is the same
  record under the stage. One `AttemptRecord` with one `DecisionEvidence`, so an agent navigates every retry the
  same way, and the Flow Lens draws every one as a loop arrow with an attempt badge (§3.10).
- **Every recorder accounts for it** (§5): the attempt event is ONE entry in the hook registry; the narrative gets
  one line per attempt and per stop reason; attempts appear under their stage execution in Topology and InOut; the
  metric recorder counts them by a fixed set of failure categories (§3.9) with exemplar ids; snapshot rows carry
  them; redaction covers the attempt's error text.

Evidence lives on the EXECUTION TREE (`StageSnapshot.attempts`), in the hook, in the sink and in the recorder's
store — never on the commit bundle. Every log stays byte-identical; the fold is untouched (Q1).

## 1. What exists (read on main; reuse, do not re-derive)

| Need | Exists today | Reuse / gap |
|---|---|---|
| Retry loop | `FlowchartTraverser · executeStage` — the ONE funnel; `resolveBackoffMs`, `sleep(ms, signal)`, `shouldRetry`; `StageContext · discardStaged` keeps `debug` so earlier attempts' diagnostics stay | The loop moves into the leaf runner; discard stays the engine's between-attempt hook |
| Retry evidence | `FlowStageRetryEvent` + `onStageRetry` (buffered by `CombinedNarrativeRecorder · bufferOp`); arithmetic pinned in `docs/guides/error-handling.md` and `test/lib/engine/property/retry-invariants.test.ts` | `onStageRetry` unchanged in signature and arithmetic; `onAttempt` is added beside it; the built-in narrative renders the attempt line instead of the retry sentence (§5, §8) |
| Cancellation | `RunOptions.signal` / `timeoutMs` (an `AbortController` in `FlowChartExecutor · run`); `StageRunner · raceAbort`; abort check before Phase 3; backoff cut short by the signal | The deadline reuses this controller; the per-attempt signal is composed over it |
| Env | `ExecutionEnv { signal?, timeoutMs?, traceId? }` — a closed type, propagated to subflows by `HandlerDeps.executionEnv`; `ScopeFacade · getEnv` marks `untrackedSources: ['env']` | `deadline`, `operationId`, `traceparent` are additive fields; `env.signal` is honoured by the engine (today it is only readable) |
| Hooks | `recorder/hooks.ts · HOOKS` — one registry; `fire` isolates; `test/architecture/hook-registry-compile.test.ts` | `onAttempt` is one new entry (the `onStageRetry` worked example) |
| Dials/policy | `memory/runPolicy.ts · RunPolicy` — frozen per leg, by reference | No new dial: a deadline is per RUN (options), not a retention policy |
| Deadline precedent | `detach/flush.ts · flushAllDetached` (drain under `timeoutMs`); `executor.drainObservers` | Same shape for `executor.flushRecord()` |
| Recorders | `scope/recorders/MetricRecorder` (`KeyedStore` by runtimeStageId, aggregate on read), `src/recorders.ts` factories, `recorder/snapshot.ts · copyBundle` | `attempts()` composes a `KeyedStore` the same way; `meta` is its free-form slot |
| Redaction | `memory/redaction.ts · RedactionRule` — `retainStageError`, `retainDiagnostic`, `retainBoundary` | Every new value goes through one of these three; a name never does |
| Record | foottrace: `CommitBundle` (`CommitStamp` is the engine's identity for it), `EventLog · record` (freeze + append), `LogAddress { logRunId, drillPath }`, `serveRecord`, `timeTravel` | The sink is attached to `EventLog`; the stored-record reader lives beside `timeTravel` |
| Ids | foottrace `buildRuntimeStageId / parseRuntimeStageId` (`#`, `/` reserved); engine `ids/branchSegment.ts` (`~`) | The attempt suffix is a foottrace codec; it reserves NO new byte (§3.4) |
| Spec | `FlowChartSpec.retryAttempts` (count only) | `timeoutMs`, `budgetMs`, `touches` ride the spec the same way (JSON-safe facts only) |
| agentfootprint | `src/resilience/withRetry` (decorator, stream law, `statedWait`, `defaultShouldRetry`), `withFallback`, `withCircuitBreaker`; `recorders/core/resilienceHooks` (report → `typedEmit`), `ResilienceRecorder`; `adapters/observability/otel.ts` (Tracer API, spans + span events); `adapters/llm/retryAfter.ts` | `withRetry`'s loop becomes `attempt()`; its policy inputs (stated wait, default predicate) are kept as agentfootprint's; §12. `src/resilience/replayAttempt.ts · replayAttempts` (on `origin/main`) carries a leaf-approved thinking-replay retirement from one attempt to the next — request state, not a loop: kept (§12) |

## 2. Laws

1. **One runner, one record.** Every attempt the library runs or is told about — a stage attempt, a `$call`
   attempt, a standalone `attempt()`, an SDK retry reported as observed — is an `AttemptRecord` of the same shape,
   produced by `attempt/runner.ts`, fired through `onAttempt`. No second loop anywhere in the engine.
2. **Absent when not asked for.** A chart with no retry policy, no budget, no `$call`, no `touches`, no sink and no
   correlation produces bytes identical to 10.0.1 — log, snapshot, checkpoint, narrative, recorder rows. A stage WITH
   a policy gains `attempts` on its execution-tree node (not its bundle); its built-in narrative renders one attempt
   line per attempt instead of the retry sentence (§5) — the one narrative change, named in §8.
3. **Time is read, never guessed.** The deadline is one number on the env (`env.deadline`, epoch ms). A stage that
   asks for the time left is reading an untracked source (`'env'`, the existing marker).
4. **A timeout is not a failure of the outside system; it is the absence of an answer.** Outcome `'timeout'`; on a
   touching target `effect: 'unknown'`. Nothing in the library maps it to `'failed'`.
5. **A name rides the record; a value is retained.** `target`, `system`, stage ids, stop reasons, outcomes are names.
   The error, the idempotency key and anything an SDK reports are values and pass through the redaction rule.
6. **The record is the record's.** foottrace's sink entries are record facts (a log opened with its base at an
   address; a bundle landed; a log closed with an outcome). Engine facts ride `meta`, opaque to foottrace. No foottrace
   file imports the engine.
7. **A budget is a declared contract.** A declared budget the chart cannot keep is refused at `build()`; an
   unbounded stage is reported by name, never guessed around.
8. **Every number leads to its evidence.** An aggregate without exemplar attempt ids is not served.
9. **A retry is a loop; the record shows it as one.** Whether the engine ran it (a policy), the chart ran it
   (`addRetryLoop`) or a stage ran it (`$call`), every attempt is an `AttemptRecord` and every retry-or-stop
   decision is a `DecisionEvidence` — the shape `decide()` produces — evaluated from ONE rule table
   (`attempt/decision.ts · retryRules`). No second decision vocabulary.
10. **Every recorder sees every attempt, through one registry.** `onAttempt` is one entry in `HOOKS`; the composite
    fan-out, the deferred tier, the snapshot rows and every recorder derive from it. A failure's category is one of a
    FIXED set (§3.9); a recorder never invents its own.

## 3. Public API (plain names; follow the existing doors)

### 3.1 Time budget

```ts
// The run's deadline — either form; both stamp env.deadline (epoch ms) and arm the run's AbortController.
await executor.run({ input, deadline: Date.now() + 120_000 });
await executor.run({ input, timeoutMs: 120_000 }); // existing option, now also visible to stages

// Inside a stage
const t = scope.$attempt();          // AttemptContext — the current attempt of THIS stage
t.timeLeftMs();                      // Infinity without a deadline; marks untracked source 'env'
t.signal;                            // aborts at min(deadline, this attempt's timeoutMs) — pass it to fetch/SDKs
t.id; t.attempt; t.of;               // 'charge#4@2', 2, 4
```

`RetryPolicy` (engine/types.ts) gains two additive members:

| Field | Meaning |
|---|---|
| `timeoutMs?: number` | Cap per attempt. The attempt runs under `min(timeoutMs, timeLeft)`; absent = the time left alone |
| `backoffMs?: number \| ((attempt: number, error: unknown) => number)` | The function form gains a second argument. A one-argument function is unchanged. This is where a stated wait (`Retry-After`) plugs in without the engine parsing anything (§12) |

`ExecutionEnv` (closed type, additive): `deadline?: number`. `RunOptions`: `deadline?: number`. The engine composes the
run's effective signal from `options.signal`, `env.signal` and the deadline timer (a small `anySignal` helper in the
leaf — not `AbortSignal.any`, so browsers without it work) and puts THAT on `env.signal`, so a stage reads one signal
that means "stop". Honouring `env.signal` for cancellation is a fix (today it is only readable); named in CHANGELOG.

**The runner's loop, stated exactly** (`attempt/runner.ts · runAttempts`):

```text
for n = 1 .. policy.attempts:
  left     = deadline ? deadline - now : ∞
  cap      = min(policy.timeoutMs ?? ∞, left)
  signal   = anySignal(runSignal, timer(cap))        // the attempt's own
  record.startedAt = now; run fn(ctx); race against signal
  outcome  : ok | failed | timeout (our timer fired) | aborted (the run's signal) | paused (PauseSignal)
  category : §3.9 — from the error; 'timeout' / 'aborted' follow the outcome
  delay    = backoffMs(n, error)   (non-finite / negative / a throw → 0)
  decision = retryRules(policy) evaluated IN ORDER over the inputs
             { outcome, category, attempt: n, of, timeLeftMs, delayMs, retryOn (a throw → false), keyPresent }
             — the first matching rule wins; the default branch is 'retry':
      1  outcome = ok                         → done   reason 'succeeded'
      2  outcome = paused                     → stop   reason 'paused'
      3  outcome = aborted                    → stop   reason 'aborted'
      4  attempt ≥ of                         → stop   reason 'exhausted'
      5  retryOn = false                      → stop   reason 'declined'        ← the case that emits nothing today
      6  timeLeftMs ≤ delayMs (deadline set)  → stop   reason 'no-time-left'
      default                                 → retry  reason 'retryable'
  onAttempt(record n)                                // every attempt, every outcome, with its decision
  done  → return the value
  stop  → rethrow the attempt's own error (UnknownEffectError on a touching target, §3.3)
  retry → between(n) (the engine's discardStaged; a $call has none) → onStageRetry(n, delay) → sleep(delay, runSignal)
```

As shipped (P1a, status addendum #3, #7, #13): rule 3 reads `aborted` (the run's signal), never a rewritten
`outcome`; rule 6 reads `timeLeftAfterWaitMs`; and a retried attempt asks `backoffMs` AFTER `between(n)`, the 9.15
order — the record and `onAttempt` follow, then `onStageRetry` and the wait.

Every record carries its `decision: DecisionEvidence` — rules 1–4 and 6 as `FilterRuleEvidence` rows (`key`, `op`,
`threshold`, `actualSummary`, `result`), rule 5 as a `FunctionRuleEvidence` labelled `retryOn` with the inputs it saw,
`chosen` = the branch (`'done' | 'stop' | 'retry'`), `default: 'retry'`, `defaultLabel: 'retryable'` — exactly what a
decider stage records through `decide()`, built by the same rule table (§3.8). `next` and `reason` on the record are
the compact projection of it (the Lens badge reads them; the click opens the evidence). The inputs name the
idempotency key only as `keyPresent: true | false` — never its value. A timeout attempt is retried like any error
(`retryOn` sees an `AttemptTimeoutError`); on a touching target the key makes that safe (§3.3). The resumed leg of a
pause has its own deadline (per leg, like the loop budget) — pass it again to `resume()`.

What the engine stops is the WAITING. The stage's own work stops only if it passes `t.signal` on; the guide says so
plainly. `StageRunner · raceAbort` races the attempt's signal instead of `deps.signal` (the run's is inside it).

### 3.2 A static budget check

```ts
const chart = flowChart('Quote', readFn, 'read')
  .addFunction('Charge', chargeFn, 'charge').retry({ attempts: 4, timeoutMs: 40_000, backoffMs: 1_000 })
  .budget(120_000)         // the caller's contract, on the spec root (budgetMs)
  .build();                // REFUSES: charge worst case 4 × 40 000 + 3 × 1 000 = 163 000 ms > 120 000 (Q2)

import { timeBudget } from 'footprintjs';
const report = timeBudget(chart, { budgetMs: 120_000, assume: { loops: { 'ask-again': 3 } } });
report.worstCaseMs;        // number, or null when unbounded
report.criticalPath;       // [{ stageId, attempts, timeoutMs, backoffMs, worstMs }] — the slowest path
report.unbounded;          // [{ stageId, why: 'no-timeout' | 'loop' | 'dynamic-next' | 'lazy-subflow' | 'items' }]
report.over;               // true when bounded and > budgetMs
```

Rules of the computation (`src/lib/builder/budget.ts`, L7 — it walks the built `StageNode` graph):

- stage: `attempts × timeoutMs + Σ backoffMs(n)` for n = 1..attempts−1 — a function backoff is CALLED at build
  (`resolveBackoffMs`'s defensive law: throw/non-finite → 0); no `timeoutMs` → `unbounded: 'no-timeout'`;
- linear `next`: sum; decider/selector: max over branches; fork (`addListOfFunction`, `Promise.allSettled`): max over
  children; `parallelForEach`: max × ⌈items / maxBranches⌉ with `assume.items[stageId]`, else `'items'`;
- loop: per pass × `assume.loops[stageId]`, else `'loop'`; a dynamic-next return → `'dynamic-next'`; eager subflow:
  recurse; lazy → `'lazy-subflow'` unless `assume.lazy[subflowId]` names a chart;
- `build()` refuses a declared budget only on a BOUNDED over-budget path; unbounded stages are a dev-mode warning;
  `RunnableChart.timeBudget()` delegates; at run start, `timeoutMs`/`deadline` shorter than the declared budget is a
  dev-mode warning once. The spec root carries `budgetMs`; each node carries `timeoutMs` beside `retryAttempts`.

### 3.3 Side-effect safety

```ts
.addFunction('Charge card', chargeFn, 'charge')
  .touches('stripe', { idempotencyKey: (args) => `order-${args.orderId}` })   // a NAME + a key rule
  .retry({ attempts: 3, timeoutMs: 20_000 })

const chargeFn = async (scope) => {
  const { idempotencyKey, signal } = scope.$attempt();
  scope.charge = await stripe.charges.create({ ... }, { idempotencyKey, signal });
};
```

- `StageNode.touches?: { system: string; idempotencyKey?: (ctx: { args: unknown; runId: string; runtimeStageId:
  string }) => string }` — a POLICY-like field (the `retry`/`tags` precedent: no node kind, no `computeNodeType`
  edit; `prefixNodeTree` spreads it). ONE landing site `FlowChartBuilder · applyTouches`, twin of
  `applyRetryPolicy`; the spec carries `touches: system` (the name only).
- **Build law:** `touches` + `attempts > 1` + no `idempotencyKey` → refused at the declaration site, by name.
  A library-made default key (`runId:runtimeStageId`) was rejected: it changes across a resume's re-run and across a
  caller's whole-run retry — the two cases where a double charge actually happens.
- The key is computed once per EXECUTION (not per attempt), before attempt 1, retained under the diagnostic rule as
  `{ idempotencyKey }` (so a policy can scrub it by name), stamped on every attempt record and on the `$attempt()`
  context.
- `AttemptRecord.effect` (touching targets only): `ok → 'applied'`; `timeout`/`aborted → 'unknown'`; `failed →
  'none'` only when the error declares `effect: 'none'` (the adapter's word: nothing was sent — the `retryable:
  false` convention agentfootprint already uses), otherwise `'unknown'`.
- When a touching stage's LAST attempt ends `unknown`, the stage throws `UnknownEffectError { system,
  idempotencyKey, attempts, cause }` (the engine's own value, so `run()` rejects with it) — "reconcile, do not retry
  blindly" is on the error, not in prose. A non-touching timeout throws `AttemptTimeoutError { attempt, timeoutMs }`.
  Both from `attempt/errors.ts`, exported from the root.

### 3.4 Correlation

```ts
await executor.run({ input, env: { traceparent: req.headers['traceparent'] } });
// or
await executor.run({ input, env: { traceId, operationId } });

executor.getSnapshot().correlation;   // { traceId, operationId?, sampled?, traceparent? } — absent when none given
event.traversalContext?.correlation;  // the same frozen object, by reference, on every flow and scope event
```

- `ExecutionEnv` gains `operationId?: string` and `traceparent?: string` beside the existing `traceId`. The engine
  parses `traceparent` once (`attempt/correlation.ts · parseTraceparent` / `formatTraceparent`, both exported) into
  one frozen `RunCorrelation`; explicit `traceId`/`operationId` win over the header's. `operationId` is the owner's
  word for W3C's parent-id: the caller's unit of work.
- Kept: `RuntimeSnapshot.correlation?`, `TraversalContext.correlation?` (one object per run; absent → byte-identical),
  the sink's `opened.meta.correlation` (§3.5), every attempt row of the recorder (§3.7). Never a commit bundle.
- **Attempt ids** (foottrace root door, `buildAttemptId` / `parseAttemptId`, brand `AttemptId`):
  `<runtimeStageId>@<n>` for a stage attempt, `<runtimeStageId>@<n>.<k>@<m>` for attempt `m` of the `k`-th `$call`
  made during stage attempt `n`. No new byte is reserved for stage ids: a `runtimeStageId` always ends in
  `#<digits>`, so the parser strips `@<digits>` (and `.<digits>@<digits>`) from the RIGHT and is unambiguous whatever
  the stage id contains. `@` stays legal in stage ids; `refuseReservedId` is untouched.

### 3.5 A crash-safe record

**foottrace 1.1.0** (`foottrace/write` for the port, `foottrace` for the reader):

```ts
interface RecordSink {
  opened(entry: { address: LogAddress; initialState: Record<string, unknown>; at: number; meta?: Meta }): void;
  commit(entry: { address: LogAddress; bundle: CommitBundle; at: number }): void;
  note(entry: { address: LogAddress; kind: string; at: number; meta: Meta }): void;   // opaque to foottrace
  closed(entry: { address: LogAddress; outcome: 'ok' | 'failed' | 'paused'; at: number; meta?: Meta }): void;
  flush?(): Promise<void>;            // an adapter that queues drains here
}
type RecordEntry = { kind: 'opened' | 'commit' | 'note' | 'closed'; ... };   // the discriminated union of the four
memorySink(): RecordSink & { entries: readonly RecordEntry[] };
readStoredRecord(entries: Iterable<RecordEntry>): StoredRecord;
interface StoredRecord {
  logs: ReadonlyMap<string /* logRunId + drillPath joined */, StoredLog>;
  root(logRunId: string): StoredLog | undefined;
}
interface StoredLog {
  address: LogAddress; initialState; commitLog: CommitBundle[];
  complete: boolean;                  // a 'closed' entry exists for this address
  outcome?: 'ok' | 'failed' | 'paused';
  meta?: Meta;                        // whatever the writer put on 'opened' / 'closed'
  source(): TimeTravelSource;         // { initialState, commitLog } — timeTravel() runs on it; drill() per mount
}
```

- `EventLog` takes an optional second argument `{ sink, address }` (the one-argument form is unchanged; bytes are
  unchanged). `record()` calls `sink.commit` AFTER `freezeRecord` with the log's own frozen bundle (`serveRecord`
  for the copy law). The constructor calls `sink.opened` with the base; `close(outcome, meta?)` calls `sink.closed`.
  A sink throw never reaches the writer's caller: it is counted on the log (`log.sinkFailures`) and reported to a
  `sink.onFailure?` callback — the record's law is "the run goes on" (Q3).
- `Meta` is `Readonly<Record<string, unknown>>`, structuredClone-safe, opaque to foottrace (law 6).
- **A note (owner change, 2026-10-15).** The sink gains an opaque `note` entry: `kind` is a NAME, `meta` the
  writer's payload, neither read by foottrace; `readStoredRecord` keeps a log's notes in order
  (`StoredLog.notes`). The engine writes `kind: 'attempt'` notes (`meta: { record }`, the served `AttemptRecord`) AS
  EACH ATTEMPT ENDS — so a hard kill mid-retry keeps the attempts of a stage that never committed, which no
  commit entry could carry (Q1: attempts never ride the bundle). The wiring is P6 (the engine) over P0 (the port);
  P1a only makes `AttemptRecord` ready for it: frozen, `structuredClone`-safe, and holding the error as the run
  SERVES it (no `raw`), so the note needs no second redaction pass.

**footprintjs** (the writer of the lifecycle):

```ts
const sink = fileSink('/var/footprint/run.jsonl');          // 'footprintjs/sinks' — a Node-only door (node:fs)
const executor = new FlowChartExecutor(chart, { sink });     // or { sink: { adapter, onFailure: 'report' | 'fail' } }
await executor.run({ input });                               // awaits sink.flush() in its finally (default)
executor.getSnapshot().sink;                                 // { entries, failed, lastError? } — absent without a sink
await executor.flushRecord();                                // for { flush: 'manual' } (the drainObservers shape)
```

- `ExecutionRuntime` constructs the root `EventLog` with the sink and the root `LogAddress`; `SubflowExecutor ·
  executeSubflow` hands the nested runtime the same sink with `drillPath: [...parent, mountRuntimeStageId]`
  (the address law `RuntimeSnapshot.logAddress` already states) and closes the mount's log at exit.
- `FlowChartExecutor · run` writes `opened.meta = { runId, chart: { id, name }, correlation?, deadline?,
  budgetMs? }` before traversal and `closed` in `finally` with `outcome` (`'paused'` on a pause, `'failed'` with the
  served error on a throw). `resume()` opens a NEW root address (a new runId; the chain is the reader's, as
  `timeTravel([paused, resumed])`).
- A stored run with no `closed` for its root address reads `complete: false` — that is the visible incompleteness; a
  lens shows it before any fold.
- Apps bring S3/DynamoDB by implementing the three methods; the memory adapter is the contract test's reference.

### 3.6 One attempt contract for retries anywhere

```ts
// Inside a stage — the stage's deadline and signal, the stage's record, the run's hooks
const quote = await scope.$call('stripe.quotes.create', (t) => stripe.quotes.create(body, { signal: t.signal }),
  { attempts: 3, timeoutMs: 10_000, backoffMs: (n, err) => Math.max(500 * n, statedWaitMs(err) ?? 0) });

// Anywhere — no scope: the same runner, records go to `onAttempt` only
import { attempt } from 'footprintjs';
const res = await attempt((t) => fetch(url, { signal: t.signal }), { attempts: 3, timeoutMs: 5_000 },
  { deadline, signal, target: 'inventory.lookup', onAttempt: (record) => log(record) });

// An SDK that retries on its own: report what it did as OBSERVED attempts (same shape, source: 'sdk')
scope.$attempt().observed({ target: 'stripe', attempt: 2, outcome: 'failed', durationMs: 812, error });
```

- `$call(target, fn, policy?, options?)` and `$attempt()` are two new `$`-methods — the four-file checklist
  (`ScopeFacade` + `ReactiveTarget`, `ScopeMethods`, `METHOD_ROUTES`, `SCOPE_METHOD_NAMES`). The facade reads the
  attempt context off its `StageContext` (`context.attempt`, set by `executeStage` before the scope factory runs —
  a fresh scope per attempt is already the law). A `$call` with no policy is `{ attempts: 1 }`: a single call still
  gets a record — timing and outcome evidence with no retry.
- `AttemptPolicy` IS `RetryPolicy` (one type, one name on the root).
- **Adapter advice** (the guide's section "Retries you did not run"): prefer ONE loop — set the SDK's own retries to
  zero (`maxNetworkRetries: 0`, `maxRetries: 0`) and run the call under `$call`, so the deadline, the record and
  the idempotency key are one thing. Where an SDK must keep its retries, report each as `observed` from whatever
  the SDK exposes (a request/response event with a request id and elapsed time, a logger line, a retry callback);
  what it exposes nothing for is recorded as ONE attempt with `source: 'sdk'` and `of` absent — the record says
  "the SDK ran this, count unknown" rather than pretending. An observed attempt never changes control flow.

### 3.7 A metric layer

```ts
import { attempts } from 'footprintjs/recorders';
const rec = attempts({ exemplars: 10, store: dynamoStore });   // store optional; memoryStore() for tests
executor.attachFlowRecorder(rec);
await executor.run({ input, env: { traceparent } });

rec.byTarget();          // Map<target, AttemptStats>  — a stage id, or a $call / observed target name
rec.byRun();             // Map<runId, RunStats>       — attempts, retries, gave-ups, budgetUsedMs / budgetMs, outcome
rec.slowest('stripe.quotes.create', 5);   // AttemptRef[] — worst first
rec.series('charge#4');  // every attempt of one operation + its decisions, whatever shape ran it (§3.8)
await rec.aggregate({ since: t0 });       // the same stats over store rows (cross-run)
rec.toOTel();            // OTLP-JSON ResourceMetrics (histogram + sum, exemplars on every data point)
```

```ts
interface AttemptStats {
  target: string; count: number;
  byOutcome: Record<AttemptOutcome, number>;
  byCategory: Record<AttemptCategory, number>;             // §3.9 — the fixed set
  retries: number; seriesRetried: number; gaveUp: number;  // gaveUp = series whose last decision is 'stop'
  effectUnknown: number;                                   // touching targets only
  latencyMs: { p50: number; p90: number; p95: number; max: number; mean: number };
  budgetUsedMs: number;                                    // Σ durationMs
  exemplars: { slowest: AttemptRef[]; timeout: AttemptRef[]; failed: AttemptRef[]; unknown: AttemptRef[];
               gaveUp: AttemptRef[] };                     // worst first, each capped at `exemplars`
}
interface AttemptRef { id: AttemptId; series: string; runId: string; runtimeStageId: string; traceId?: string;
  startedAt: number; durationMs: number; outcome: AttemptOutcome; category: AttemptCategory;
  next: 'retry' | 'done' | 'stop'; reason: AttemptReason }
```

- A FlowRecorder (`src/lib/recorder/AttemptRecorder.ts`, L5) on `onRunStart`, `onAttempt`, `onRunEnd`,
  `onRunFailed`; composes a `KeyedStore<AttemptRow>` keyed by attempt id (Convention 1); aggregates on read.
  Percentiles are exact nearest-rank over the rows held (no sketch — the honest cost: one sort per `byTarget()`,
  over at most the rows the store's query window returns). `toSnapshot()` → `{ data: { byTarget, byRun }, meta: {
  projection: 'per-target', exemplars: 10, rows: n, window? } }`; rows survive `structuredClone`.
- `AttemptStore { append(rows: AttemptRow[]): void | Promise<void>; read(query: { since?, until?, target?, runId?
  }): Promise<AttemptRow[]> }` — rows are appended AS EACH ATTEMPT ENDS (the sink's "as it lands" law, so a crash
  keeps the attempts of landed stages); `memoryStore()` is the reference; apps bring DynamoDB.
- `toOTel()` follows the OTLP metrics data model: `footprint.attempt.duration` (Histogram, unit `ms`, explicit
  bounds, attributes `footprint.target`, `footprint.outcome`, `footprint.category`), `footprint.attempt.count` (Sum,
  by outcome and category), `footprint.attempt.gave_up` (Sum, by target), each data point carrying `exemplars[]` with
  `asDouble`, `timeUnixNano`, `traceId` (from correlation) and `filteredAttributes['footprint.attempt.id']`,
  `['footprint.runtime_stage_id']`, `['footprint.series']`. Quantiles are not OTLP; the document carries buckets,
  our own shape carries p50/p90/p95.
- **The AI-first path, end to end:** `rec.slowest('stripe.quotes.create')` → an `AttemptRef` → `runId` +
  `runtimeStageId` → `readStoredRecord(sink entries).root(runId).source()` → `causalChain(source, runtimeStageId)`
  and `stateAt(...)` at that stop. Every hop is a public door; the example in P7 walks it.

### 3.8 Retries in the flowchart — three shapes, one record

A retry is a loop. The engine already treats a declared policy as one (attempts are re-entries of one stage); this
section makes the record say so, and gives side-effecting retries a REAL loop in the chart. The three shapes differ in
who runs the loop; they share one `AttemptRecord`, one `DecisionEvidence` and one rule table, so a reader, an agent
and the Lens navigate every retry the same way.

| Shape | Who loops | Where the attempt lives | Where the decision lives | When to use |
|---|---|---|---|---|
| **Compact loop** — `.retry(policy)` | the engine's runner | `StageSnapshot.attempts[n]` under ONE stage execution (`charge#4@1`, `@2`, …) | `attempts[n].decision` (built by the runner from `retryRules(policy)`) | reads and idempotent calls: no outside state to reconcile |
| **Explicit loop** — `addRetryLoop(id, …)` | the chart (`loopTo`) | one stage execution PER pass (`charge#4`, `charge#9`, …), each with its own commit, attempt record and causal chain | the decide stage's own evidence (`FlowDecisionEvent.evidence`, recorded as any decider's) — the same rules, through `decide()` | payment, order, email: the outcome is state the next step reasons about |
| **In-stage call** — `scope.$call(target, …)` | the runner, inside a stage | `StageSnapshot.attempts[]` with `kind: 'call'`, under the stage that made the call | `attempts[n].decision` | SDK / HTTP wrappers (item 6): there is no chart node, so the evidence hangs under the stage |

**The one rule table.** `attempt/decision.ts · retryRules(policy): DecideRule<AttemptInputs>[]` returns the seven
rules of §3.1 as ordinary `decide()` rules over an `AttemptInputs` object (`outcome`, `category`, `attempt`, `of`,
`timeLeftMs`, `delayMs`, `retryOn`, `keyPresent`). The decide stage of an explicit loop calls `decide(scope,
retryRules(policy), { branch: 'retry', label: 'retryable' })` over the outcome state; the runner evaluates the same
table itself (`decide()` needs a registered scope; the runner has none) and builds the identical evidence rows. A
property test pins that both paths produce equal `DecisionEvidence` for equal inputs (§10).

**`addRetryLoop` — pure sugar, the `addDetachAndForget` precedent.** No engine kind, no `computeNodeType` edit; four
ordinary nodes the builder already knows how to make, under declared tags `retry-loop:<id>` so the Map advertises the
loop and the record groups it:

```ts
.addRetryLoop('charge', {
  touches: 'stripe',
  idempotencyKey: (args) => `order-${args.orderId}`,
  retry: { attempts: 4, timeoutMs: 20_000, backoffMs: (n) => 1_000 * n },
  attempt:   async (scope, t) => stripe.charges.create(body(scope), { idempotencyKey: t.idempotencyKey, signal: t.signal }),
  reconcile: async (scope, t) => (await stripe.charges.search({ idempotencyKey: t.idempotencyKey })).total ? 'applied' : 'none',
  into: 'charge',                 // the ONE state key the loop owns (default: the id)
  onStop: 'throw',                // default; 'continue' lets the chart route a stopped loop itself
})
```

| Node (id) | Kind | What it does | Writes |
|---|---|---|---|
| `charge` (attempt) | `addFunction` | On the first pass seeds `scope.charge = { series: runtimeStageId, attempt: 1, idempotencyKey }`; runs the user's `attempt` under `scope.$call('stripe', fn, { attempts: 1, timeoutMs })` with the KEY FROM STATE; writes ONLY the outcome (`outcome`, `category`, `effect`, served `error`, `durationMs`, `attemptId`). It never throws: footprintjs commits a failing stage's writes, and the decision belongs to the decide stage | `charge.*` |
| `charge-reconcile` | `addFunction` | Runs only when `effect === 'unknown'`; calls the user's `reconcile`; writes `effect` (`'applied'` turns the pass into `done`) and `reconciled: true` | `charge.effect` |
| `charge-decide` | `addDeciderFunction` | `decide(scope, retryRules(policy), …)` over `scope.charge` — the SAME rules; branches `retry` / `done` / `stop` | the decider's evidence (`onDecision`), and `charge.decision` |
| `charge-wait` (branch `retry`) | `addFunctionBranch` + `.loopTo('charge')` | Sleeps `delayMs` under the run's signal (a visible stage: "waited 2 s"), bumps `charge.attempt`, loops back | `charge.attempt` |
| branch `done` | `addFunctionBranch` (no-op) | continues to the decider's `next` — the stage after the helper | — |
| branch `stop` | `addFunctionBranch` | `onStop: 'throw'` (default): throws `UnknownEffectError` when `effect` is unknown, else the last error; `'continue'`: falls through to `next` with `charge.decision.chosen === 'stop'` | — |

Laws of the explicit loop:

- **Iterations count.** Each `retry` pass is one `loopTo` iteration of the attempt stage, counted per node id by
  `ContinuationResolver · getAndIncrementIteration` against `maxIterations` (default 1000; `RunOptions.maxIterations`).
  N attempts = N−1 iterations; `timeBudget()` reports the loop with `assume.loops[id] = attempts − 1` filled in from the
  policy, so it is BOUNDED by declaration, unlike a hand-written loop. Every pass bumps the execution index, so each
  attempt has its own `runtimeStageId`, commit and `causalChain`.
- **Pause and resume.** The attempt stage may `interrupt()` (ask a human before trying again after `unknown`): the
  ordinary M2 pause; resume re-runs the attempt stage from its top and reads the key and the attempt number FROM STATE
  (`scope.charge`), so the resumed try carries the same key — this is why the loop keeps its key in state, and why
  the policy case refuses a library default key (§3.3). A loop back to a paused stage pauses again (the existing law).
  The wait stage is a plain timer like a policy backoff; `wait: 'pause'` makes it an `addPausableFunction` that pauses
  with `{ resumeAt }` so a durable scheduler can resume a long wait — a checkpointable backoff, which the policy's
  cannot be.
- **The record.** `scope.charge` is the loop's state (keys, outcome, decision — a per-pass commit); the attempt
  stage's `StageSnapshot.attempts` carries the `$call` record of that pass (`series` = the first pass's
  runtimeStageId, `attempt` = the pass number); the decide stage's evidence is the decider's own. The `attempts()`
  recorder joins the three by `series` and the `retry-loop:<id>` tag on `traversalContext.tags` (§3.7 · `series(id)`).
- **Budget and side effects compose.** `touches` + `idempotencyKey` are required by the same build law as §3.3;
  `timeoutMs` caps each pass by the time left; the loop's decide stage sees `timeLeftMs` like the runner does.
- **Hooks and narrative per pass.** `onStageRetry` never fires for an explicit loop (the engine ran no retry); what
  fires is what any chart loop fires — `onAttempt` under the attempt stage (its `$call` record, `next` = the pass's
  own call-level decision), `onDecision` with the evidence at the decide stage, `onLoop` on the `retry` branch —
  and the narrative reads as the loop it is: the attempt line under `Charge card`, the decider's sentence, `Looping
  back to Charge card (iteration 2)`, the wait stage, and so on. The `attempts()` recorder's `series(id)` folds it
  into the same view the compact loop gets.

**One record shape.** `AttemptRecord.series` groups the attempts of one operation whatever the shape: the stage's
`runtimeStageId` (compact loop), the first pass's `runtimeStageId` (explicit loop), the call id (`$call`). `attempt`
is 1-based within the series, `decision` is the evidence, `next`/`reason` its projection. An agent asks
`attempts().series(id)` and gets `{ attempts: AttemptRecord[], decisions: DecisionEvidence[], ended: reason }` for all
three shapes.

### 3.9 Failure categories — one fixed set

`AttemptRecord.category` (and the metric breakdown) is one of SEVEN values, classified by `attempt/category.ts ·
errorCategory(error, outcome)` — the one classifier, borrowed from agentfootprint's `classifyRetryReason` and widened,
so agentfootprint's decorators adopt it rather than keep their own (§12):

| Category | When |
|---|---|
| `timeout` | the attempt's own timer fired (outcome `timeout`) |
| `rate-limited` | `status`/`statusCode` 429, or the error declares `retryAfterMs` / `retryAfterSeconds` |
| `server` | status 5xx |
| `network` | no status and the error is a transport failure: `code` in `ECONNRESET`, `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `EAI_AGAIN`, `EPIPE`, a `fetch` `TypeError`, an `AbortError` that is not the run's signal |
| `auth` | status 401 / 403 |
| `permanent` | any other 4xx, a validation error, or the error declares `retryable: false` |
| `unknown` | anything else (an error with no status and no recognised code), and outcome `aborted` (the run ended it) |

Series-level, the recorder also counts **gave up** = a series whose last decision is `stop` (reasons `exhausted`,
`declined`, `no-time-left`), apart from `aborted` and `paused`, so "how often do we give up on Stripe" is one number.
The default `retryOn` stays "every error"; `category` is evidence, not policy — a chart that wants "never retry
`permanent`" declares it: `retryOn: (e) => errorCategory(e) !== 'permanent'` (`errorCategory` is exported).

### 3.10 The visual contract — what the Lens needs to draw a retry as a loop

The Flow Lens (`footprint-explainable-ui`) draws a loop arrow on the stage with an attempt badge — `×3 (2 failed,
1 ok)`, coloured by the series' end — and a click opens each attempt with its decision. Policy retries, explicit
loops and in-stage calls are drawn the same way. The record carries everything below so the Lens derives NOTHING
(today it infers `retryAttempts` by counting `onStageRetry` events — `createTraceRuntimeOverlay`; that inference
retires):

| The Lens draws | It reads | Static (the Map) | Live (the hook) |
|---|---|---|---|
| the loop arrow on a stage | `StageSnapshot.attempts.length > 1`, or `attemptSummary` | `retryAttempts` + `timeoutMs` on the spec node (policy); `loopTarget` + tag `retry-loop:<id>` (explicit loop) | first `onAttempt` with `attempt ≥ 2`, or a `retry` decision |
| the badge `×N (f failed, k ok)` | `StageSnapshot.attemptSummary: { count, ok, failed, timeout, aborted, paused, last: { next, reason, category? } }` — stamped by the runner when the series ends; for an explicit loop, per pass on each attempt node and whole on the series (`attempts().series(id)`) | — | the running count from `onAttempt` events (`attempt`, `outcome`) |
| the badge colour | `attemptSummary.last.next`: `done` green, `stop` red, in flight amber — the SERIES' end; a stage whose execution failed after a `done` series (below) is red by its own error | — | the last `onAttempt.record.next`, until the stage's `onError`, which ends a live series as failed whatever the last record said |
| one arrow per target for in-stage calls | `attempts` filtered `kind: 'call'`, grouped by `target` | — | same |
| the attempt list on click | `attempts[]`: `id`, `attempt`, `of`, `outcome`, `category`, `durationMs`, `delayMs`, `timeLeftMs` | — | — |
| the decision on click | `attempts[n].decision` (a `DecisionEvidence` — the SAME component that renders a decider's evidence); for an explicit loop the decide stage's own `FlowDecisionEvent.evidence` | — | — |
| the explicit loop as one operation | `series` on every record + the `retry-loop:<id>` tag on the four nodes' bundles (`tagStops` filters them) | the tag on the spec nodes | `traversalContext.tags` |

Rules: the Lens never counts events to find a number the record stamps; ids join (`series`, `runtimeStageId`,
`attemptId`); a stored run (snapshot or sink) draws without any recorder attached. The Lens change is a follow-up
packet in that repository (P9).

**The series' outcome is not the stage's.** `attemptSummary.last.next: 'done'` says the stage function returned; the
stage can still fail after that — its commit can fail (a value nothing can clone), or a StageNode it returned can be
refused at the run-time door (R5, and an invalid `retry` on it) — and then its `onError` fires with the summary
unchanged. So the Lens reads a stage's failure from the execution's own error, never from the summary. The live
rule follows: the stage's `onError` ends a live series, as failed, whatever its last `onAttempt` said — a series
cut during its wait (status addendum #8) last said `retry`, and one whose commit failed last said `done`.

## 4. Record shapes and where each lives

| Shape | Owner | Lives | Notes |
|---|---|---|---|
| `AttemptRecord` (§3.1, §3.8; fields: `id, series, kind: 'stage'\|'call'\|'observed', target?, attempt, of?, startedAt, durationMs, outcome, category, decision: DecisionEvidence, next: 'retry'\|'done'\|'stop', reason, timeoutMs?, timeLeftMs?, delayMs?, error?, system?, idempotencyKey?, effect?, source?`) | engine, `attempt/types.ts` (`decision` is `decide/types.ts · DecisionEvidence`) | `StageSnapshot.attempts?: readonly AttemptRecord[]` + `StageSnapshot.attemptSummary?` (both absent when empty); `FlowAttemptEvent.record`; the recorder's store rows. Attempts never enter the record's (foottrace's) entries | `error` is the SERVED `StructuredErrorInfo` without `raw` (snapshot rows must survive `structuredClone`); the hook's event carries `structuredError` with `raw` like `FlowStageRetryEvent` |
| `AttemptSummary` (`count`, per-outcome counts, `last: { next, reason, category? }`) | engine | `StageSnapshot.attemptSummary?`; `attempts().series(id).ended` | stamped once when a series ends — the Lens badge (§3.10) |
| `AttemptInputs`, `retryRules(policy)`, `errorCategory()` | engine, `attempt/decision.ts`, `attempt/category.ts` | root exports | the one rule table and the one classifier, shared by the runner, `addRetryLoop`'s decide stage and agentfootprint |
| `AttemptContext` (§3.1) | engine | `scope.$attempt()`, `fn(ctx)` | never serialised |
| `AttemptId` + codec | foottrace root | ids | §3.4 |
| `RunCorrelation` | engine, `attempt/correlation.ts` | `RuntimeSnapshot.correlation?`, `TraversalContext.correlation?`, sink `opened.meta` | one frozen object per leg |
| `RecordSink`, `RecordEntry`, `StoredRecord`, `StoredLog` | foottrace | `foottrace/write` (port, `memorySink`), `foottrace` (`readStoredRecord`) | record facts only |
| `fileSink` | engine | `footprintjs/sinks` (new Node-only door) | JSON lines, one entry per line; `flush` = `fsync` |
| `BudgetReport` | engine, `builder/budget.ts` | `timeBudget()` return | `FlowChartSpec.budgetMs`, node `timeoutMs`, `touches` on the spec |
| `AttemptStats`, `AttemptRef`, `AttemptRow`, `AttemptStore` | engine recorder | `/recorders` | `toOTel()` document is plain JSON |
| `UnknownEffectError`, `AttemptTimeoutError` | engine, `attempt/errors.ts` | root | both `Error` subclasses with `cause` |

`StageSnapshot.attempts` is built by `StageContext · snapshotSelf` from `context.attempts` (appended by the runner's
`onAttempt`; NOT cleared by `discardStaged` — the same reason `debug` survives it: the earlier attempts are the point).
The commit bundle is untouched; `CommitStamp` is untouched; `ExecutionTree` (foottrace's read-only supertype) needs
nothing.

## 5. Hook additions

- `FlowRecorder.onAttempt?(event: FlowAttemptEvent)` — `FlowAttemptEvent { stageName, stageId, record:
  AttemptRecord, structuredError?: StructuredErrorInfo, traversalContext?, channel?: 'flow' }`. Fires at every
  attempt END, for every kind, BEFORE `onStageRetry` for a retried stage attempt (a monitor sees "attempt 1 failed in
  40 s" and then "retrying in 500 ms") and before `onError` / `onStageExecuted` for the last. A `$call`'s attempts
  fire DURING the stage, like `onStageRetry`.
- The `onStageRetry` worked example, step by step: `IControlFlowNarrative.onAttempt` (required; no-op in
  `NullControlFlowNarrativeGenerator`) → `FlowRecorderDispatcher.onAttempt` → `HOOKS.onAttempt: { on: { flow:
  'FlowAttemptEvent' }, executorMade: false }` → `NarrativeFlowRecorder.onAttempt` → `CombinedNarrativeRecorder`
  buffers it with `bufferOp` (it fires during a stage; pushing it to the store would place it above its stage) →
  `CombinedNarrativeEntry.type: 'attempt'` + `NarrativeFormatter.renderAttempt` → barrels. The composite fan-out
  is generated from `HOOK_NAMES`; the deferred tier's `'clone'` capture works because the record is clone-safe.
- **What the narrative says: one line per attempt, and one per stop reason.** Rendered from `onAttempt` (the record
  carries the outcome, the category, the time left and the decision, so one sentence says it all), in order inside
  the stage: `Attempt 2 of 3 at Fetch rate timed out after 40s (70s left), retrying in 2s.` · `Attempt 1 of 4 at
  Charge card failed in 812ms (rate-limited: 429), retrying in 4s.` · `Attempt 3 of 3 at Fetch rate succeeded in
  31ms.` · `Attempt 1 of 4 at Charge card failed in 120ms (permanent: card declined); stopped: retryOn declined.` ·
  `Attempt 2 of 4 at Charge card timed out after 20s; stopped: no time left (300ms left, next wait 2s).` · `Call
  stripe.quotes.create, attempt 1 of 3, failed in 812ms (rate-limited), retrying in 4s.` · `Observed: the stripe SDK
  made attempt 2, failed in 600ms (server).` The built-in narrative no longer renders a separate `[Retry]` sentence —
  the attempt line carries "retrying in …" — so the narrative of a chart WITH a policy changes (named in §8); a chart
  without one is byte-identical. `NarrativeFormatter.renderAttempt?(ctx)` is the consumer's formatter hook;
  `renderRetry?` was designed to stay declared and uncalled — as shipped it is removed with its last caller
  (status addendum #11).
- `onStageRetry` is unchanged in signature and arithmetic and still FIRES (recorders that count on it keep working);
  only the built-in narrative stops rendering it. `onRunStart` gains nothing; the deadline and correlation ride
  `traversalContext`.
- The three `toSnapshot?()` signature sites and `copyBundle` need nothing: the recorder's bundle uses `data` + `meta`.

### 5.1 Each built-in recorder's behaviour (every recorder accounts for retries, timeouts and failures)

| Recorder | Gets the attempt from | What it does with it |
|---|---|---|
| `CombinedNarrativeRecorder` / `NarrativeFlowRecorder` + the 8 loop strategies | `onAttempt` (buffered by `bufferOp`) | one line per attempt (above), placed between that attempt's own reads/writes; the stop reason on the last line; the error text is the served one |
| `TopologyRecorder` | `onAttempt` | a stage execution that attempted ≥ 2 times, or whose series ended `stop`, becomes a node `kind: 'attempt-series'` under its parent (subflow / fork-branch / decision-branch), with `attemptSummary` and the ordered attempt ids; an explicit loop's passes hang under one series node by `series`; edges `kind: 'retry'` between passes. Plain single-attempt stages stay out, as today |
| `InOutRecorder` | `onAttempt` | the `exit` entry of the subflow (or the root `__root__#0` pair) carries `attempts: { count, byOutcome, gaveUp }` summed over the executions inside it, and `attemptIds` of the failed ones — so a boundary pair says what it cost to get through |
| `QualityRecorder` | `onAttempt` | a timed-out or gave-up series is a quality drop at that stage (`drop: 'attempts'`), paired with its causal parents the way `qualityTrace()` already pairs drops |
| `MetricRecorder` (scope channel) | `onStageStart` / `onStageEnd` (unchanged: one per attempt — a fresh scope per attempt) | `StepMetrics.attempts` = the count of `onStageStart` it saw for the runtimeStageId; `duration` stays the whole execution |
| `DebugRecorder` | `onError` (unchanged) + `onAttempt` | one debug row per attempt with id, outcome, category, duration; a declined/no-time-left stop row |
| `ManifestFlowRecorder` | `onAttempt` | the manifest row of the stage gains `attempts: AttemptSummary` |
| `ControlDepRecorder` | `onAttempt` | a stage with a `stop` decision records a control dependency `attempt-stop` on the stage, so `causalChain` reads it as a control edge |
| `attempts()` (new) | `onAttempt`, `onRunStart`, `onRunEnd`, `onRunFailed`, `onDecision` (explicit loops, by tag) | §3.7: per target and per run, by outcome AND by category, gave-up count, latency p50/p90/p95/max, budget used, exemplar ids worst first, `series(id)` |
| snapshot rows (`toSnapshot`) | each recorder's own store | rows carry the attempt fields they hold; everything above survives `structuredClone` (the served error has no `raw`) |
| the deferred tier | `hooksOn('flow')` | `'clone'` capture of `FlowAttemptEvent` works as for every flow event; `'summary'` digests the record |

Nothing on this list is a second source: every row traces back to one `onAttempt` through `HOOKS`.

## 6. Redaction — the one law applied to each new value

| Value | Named by | Retained through |
|---|---|---|
| an attempt's `error` | the stage's error | `RedactionRule.retainStageError` (already the law for `onError` / `onStageRetry`) |
| `idempotencyKey` | the diagnostic name `idempotencyKey` | `retainDiagnostic({ idempotencyKey })` — scrubbed by a key rule of that name or `policy.diagnostics` |
| an observed attempt's `error` and any extra fields | the diagnostic name `attempts` | `retainDiagnostic({ attempts: report })` — only `target`, `attempt`, `of`, `outcome`, `durationMs`, `startedAt`, `source` and the served error are kept; anything else an adapter passes is dropped (the record never carries a payload it did not name) |
| `target`, `system`, stage ids, outcomes, stops | names | never a value — the `.tag()` stance; the guide says "never put a value in a target" |
| the sink's `opened.meta.correlation` and `closed.meta.error` | boundary records handed out whole | `retainBoundary` (the root input/output precedent) |
| `initialState` in `opened` | the fold base | already the record's retained base (the mirror's seed under a policy: the sink receives what the log keeps) |
| `AttemptStats` / `AttemptRef` | numbers and names | nothing to scrub; a recorder row's `error` is the served form it received |
| narrative attempt lines, Topology / InOut / Debug / Manifest rows | the served error message and category | the line and every row are built from `AttemptRecord.error` as served — a redacted stage error reads redacted everywhere, including `attempts().series(id)` |
| `DecisionEvidence` inside an attempt | `ReadInput.valueSummary` / `FilterCondition.actualSummary` | the inputs are numbers, enum names and `keyPresent` — the error enters only as its category and served message; `redacted: true` is set on the error row when the stage's rule scrubbed it |

The deadline and the time left are numbers the caller gave; not a policy's business. The checkpoint carries no
attempt evidence (lean format 2), so nothing new must survive it; a resumed leg records its own attempts.

## 7. The engine/record boundary

foottrace receives exactly three things, none of which names the engine: the attempt-id codec (ids are the record's
grammar), the sink port with its memory adapter and the `EventLog` option that calls it, and the stored-record reader.
`Meta` is opaque. The engine composes: `ExecutionRuntime` passes the sink; `FlowChartExecutor` writes the lifecycle
entries; `attempt/` sits at L5 beside `decide/` (it imports `decide/types.ts` for the evidence shape, `errors/` and
`devMode`; nothing from `scope/` or `engine/`), so `scope/` (L5) and `engine/` (L6) both reach it; `builder/budget.ts`
and `builder/retryLoop.ts` (the sugar) are L7; `recorder/AttemptRecorder.ts` is L5; `fileSink` is on its own door and
imports `node:fs` — the first Node import in `src/`, which is why it cannot sit on the root (the worker-thread driver
avoids `node:` by injection). `scripts/layering.config.cjs` gains `src/lib/attempt/**` at rank 5 and the door at rank
8; `test/architecture/layering.test.ts` and `published-doors.test.ts` are extended, not relaxed.

## 8. Minor or breaking

Everything here is a MINOR release: footprintjs 10.1.0 over foottrace ^1.1.0; agentfootprint minor. No export is
removed; every new field is optional and absent when unused; `RetryPolicy.backoffMs`'s second argument is additive;
`EventLog`'s second constructor argument is optional. Three behaviour changes are named in CHANGELOG, none breaking a
documented contract: the engine now honours `env.signal` for cancellation (it was documented as the cancellation
signal and never raced); a stage WITH a retry policy now carries `attempts` and `attemptSummary` on its
execution-tree node; and the built-in narrative of such a stage renders one attempt line per attempt instead of the
`[Retry]` sentence (the `record-bytes` pins and the narrative references that include a retry chart are re-pinned
under the "intended change" clause of the re-pin policy, with the reason in the PR). The `retryOn → false emits
nothing` law becomes "fires no `onStageRetry` and ONE `onAttempt` whose decision is `stop: declined`"; the retry
arithmetic table in the guide gains an `onAttempt` column (always = the number of attempts).

## 9. Byte identity — what stays identical, what changes

| Surface | No policy / budget / call / sink / correlation | A chart with a retry policy |
|---|---|---|
| commit log (both encodings), fold base, mirror | identical | identical |
| execution tree | identical | `attempts` + `attemptSummary` on the policy's stage node |
| checkpoint | identical | identical |
| narrative | identical | one attempt line per attempt replaces the `[Retry]` sentence (§5) |
| `getSnapshot()` top level | identical | identical (`correlation` / `sink` only when given) |
| recorder rows of existing recorders | identical | identical |

Pinned by: `test/fixtures/record-bytes` (26 scenarios), `declared-tags-byte-identity.test.ts`,
`redaction-no-policy-byte-identity.test.ts`, `retry-invariants.test.ts` ("one bundle however many attempts"; "a
retried stage is indistinguishable, in the log") and `retry-cost.test.ts` (no policy → one call).

## 10. Test plan (the repo's seven types per packet, plus the three gates)

Every packet carries its tests under `test/lib/<area>/{unit,scenario,property,boundary,security}/` and names its types
in the file header the way `retry-execution.test.ts` does; examples are the integration tier (`npm run test:examples`).

| Type | What this feature pins (by packet) |
|---|---|
| **Unit** | runner: cap = min(timeoutMs, timeLeft); the decision per rule of §3.1's table (`next`, `reason`, the evidence rows' `key`/`op`/`threshold`/`actualSummary`); `errorCategory` over every row of §3.9 (status, code, declared fields, our timer, the run's signal); `anySignal` cleanup; `parseAttemptId` from the right on ids containing `@`, `.`, `~`; `parseTraceparent` (valid, bad version, bad length, mixed with explicit ids); budget arithmetic per node kind, the explicit loop bounded by its policy; `readStoredRecord` grouping by address; percentile nearest-rank on 0/1/N rows; OTLP document shape; `addRetryLoop` builds exactly four nodes with the `retry-loop:<id>` tag and refuses a missing key (P0–P7) |
| **Functional** | stage retry over the runner on every stage kind (linear, streaming, pausable, decider, selector, fork child, subflow inner — `retry-execution.test.ts`'s matrix stays green); `$call` inside each kind; `observed()`; `touches` key per execution; `addRetryLoop`: one pass per attempt with its own runtimeStageId, the decide stage's evidence equals the runner's for the same inputs, `onStop: 'throw'` / `'continue'`, reconcile turning `unknown` into `done`; each built-in recorder's row (§5.1) on one chart; the sink's three entries per log; `flushRecord` |
| **Integration** (examples) | `runtime-features/retry/03-deadline-and-timeout.ts`, `04-side-effects-and-idempotency.ts`, `05-attempts-inside-a-stage.ts`, `06-retry-loop-in-the-chart.ts` (attempt → reconcile → decide → loopTo, the narrative and the evidence per pass); `build-time-features/budget/01-time-budget.ts`; `integrations/traceparent.ts`; `runtime-features/crash-safe-record/01-sink-and-incomplete-run.ts`; `recorders/attempts/01-per-target-latency.ts` (the AI-first path of §3.7 end to end, by category) |
| **Scenario** | event ORDER on a real chart: `onStageStart → onAttempt(1) → onStageRetry(1) → … → onError → onStageExecuted`; narrative: one line per attempt, in order inside the stage, the stop line last; a 2-deep subflow with a deadline (env propagation); a pause inside a retried stage (decision `stop: paused`, no retry); a pause inside `addRetryLoop`'s attempt stage and a resume that reuses the key from state; resume with a fresh deadline; a fork of three children each timing out; a run that crashes mid-flight (the sink shows `complete: false`, `stateAt` folds what landed); cross-executor `timeTravel([paused, resumed])` over two stored root logs; `tagStops(['retry-loop:charge'])` isolates one loop's passes |
| **Property** (fast-check) | the series invariant: `attempts.length ≤ policy.attempts`, exactly one record with `next ≠ 'retry'` (the last), `onAttempt` count = `attempts.length`, `onStageRetry` count = `attempts.length − 1` when exhausted or recovered and 0 when declined, `attemptSummary` counts equal the records; the evidence-equality law: for random `AttemptInputs`, the runner's hand-built `DecisionEvidence` deep-equals `decide(scope, retryRules(policy), …)`'s on a registered scope holding the same inputs; the explicit-loop law: for random failure sequences, `addRetryLoop` and `.retry(policy)` on the same stage make the same number of attempts and end with the same `reason`; the deadline invariant: no attempt STARTS after the deadline and no backoff ends past it; `parseAttemptId(buildAttemptId(x)) = x` over `fc.string()` stage ids with `#`/`/` excluded; `readStoredRecord` over a random interleaving of entries from N logs regroups each log in order; percentiles equal a reference sort; budget worst case ≥ measured duration on a deterministic chart |
| **Boundary** | `attempts: 1` with `timeoutMs`; `timeoutMs: 0`; a deadline already past at run start (the existing abort check, no attempt); a backoff that throws; `retryOn` that throws (declined, as today); an error with `status: 429` AND `retryable: false` (rate-limited wins: the category is what it looked like, the decision is `declined`); an observed report with hostile keys and a null-prototype error; `addRetryLoop` with `attempts: 1` (no wait node ever runs) and with `maxIterations` below `attempts − 1` (the loop guard's error, named); a sink that throws on `commit` / rejects on `flush`; `exemplars: 0`; an empty recorder's `toOTel()`; budget on a chart with a loop and no assumption (`unbounded: 'loop'`) |
| **Security** | attempt isolation unchanged (`retry-isolation.test.ts` + the runner); the idempotency key scrubbed by a key rule and by `policy.diagnostics`, and never present in a decision's inputs (only `keyPresent`); an observed attempt's extra fields never reach the record; a redacted stage error is served redacted on `AttemptRecord.error`, the hook, the narrative line, every §5.1 row and `series()`; the sink receives the mirror's base under a policy; `correlation` never contains the header's unparsed bytes beyond `traceparent` itself; a hostile `target` string is a name — no path write, no prototype key (`hostile-keys-no-pollution` precedent); `addRetryLoop`'s state key under a redaction rule keeps the outcome and scrubs the key |
| **Gates** | architecture: layering (`attempt/` at L5 importing only `decide/types`, `errors/`, `devMode`; `node:fs` only on `/sinks`), `hook-registry-compile` (`onAttempt`), `published-doors` / `exports` (new door and names), `write-address`; byte identity (§9); bench: `retry-cost.test.ts` and a new `attempt-cost.test.ts` (the runner adds no clone per attempt; a `$call` with `{ attempts: 1 }` costs one record; building the evidence rows is O(rules)) |

## 11. PR packets, in dependency order (each small, each merges on its own)

| # | Repo · version | Packet | Depends on |
|---|---|---|---|
| P0 | foottrace 1.1.0 | `buildAttemptId` / `parseAttemptId` / `AttemptId`; `RecordSink` (opened / commit / note / closed), `RecordEntry`, `memorySink` on `/write`; `EventLog(base, { sink, address })` + `close()` + `sinkFailures`; `readStoredRecord` / `StoredRecord` / `StoredLog.source()` on the root; README sections with examples; tests (unit, property, boundary); fixture bytes untouched | — |
| P1a | footprintjs | `src/lib/attempt/` (`types`, `runner`, `decision` = `retryRules` + the evidence builder, `category` = `errorCategory`, `errors`, `anySignal`); `executeStage` on the runner (byte-identical behaviour; `retry-cost` green); `StageContext.attempts` / `attemptSummary` + `snapshotSelf`; `onAttempt` through the whole `onStageRetry` chain (`HOOKS`, dispatcher, Null, narrative); the narrative's one-line-per-attempt rendering (`CombinedNarrativeEntry.type: 'attempt'`, `renderAttempt`); `declined` recorded; re-pins named; CLAUDE.md module row + hook example; guide: the arithmetic table gains a column | — |
| P1b | footprintjs | `run({ deadline })`, `env.deadline`, `env.signal` honoured, `RetryPolicy.timeoutMs`, `backoffMs(n, error)`, the attempt signal in `StageRunner`, `AttemptTimeoutError`, `$attempt()` (four-file checklist), `timeLeftMs()` marking `'env'`; example 03; guide "Time budget"; `execution.md` deadline section | P1a |
| P1c | footprintjs | every built-in recorder accounts for attempts (§5.1): Topology `attempt-series` nodes, InOut boundary counts, Quality drop, Debug rows, Manifest summary, ControlDep `attempt-stop`, `MetricRecorder.attempts`; snapshot rows; one scenario test over one chart asserting each row | P1a |
| P2 | footprintjs | `$call()` (four-file checklist), standalone `attempt()`, `observed()`; `src/lib/attempt/README.md`; example 05; guide "Retries you did not run" (adapter advice) | P1b |
| P3 | footprintjs | `.touches()` + `applyTouches`, build refusal, key per execution, `effect`, `UnknownEffectError`; spec `touches`; example 04; guide "Side effects" | P1b |
| P3b | footprintjs | `addRetryLoop` (`builder/retryLoop.ts`, pure sugar: four nodes, `retry-loop:<id>` tags, `into` state key, `onStop`, `wait: 'pause'`); the decide stage over `retryRules(policy)`; `timeBudget` bounds the loop by its policy; example 06; guide "A retry that is a workflow" | P2, P3 |
| P4 | footprintjs | correlation: `parseTraceparent` / `formatTraceparent`, `RunCorrelation` on snapshot + `TraversalContext`; example `integrations/traceparent.ts` | P1a |
| P5 | footprintjs | `.budget(ms)`, `builder/budget.ts · timeBudget`, `RunnableChart.timeBudget()`, spec `budgetMs` / `timeoutMs`, build refusal, run-start warning; example; guide | P1b |
| P6 | footprintjs | sink wiring: executor option, lifecycle entries, `kind: 'attempt'` notes as each attempt ends (§3.5), `ExecutionRuntime` / `SubflowExecutor` addresses, `flushRecord`, `getSnapshot().sink`; `footprintjs/sinks` door with `fileSink`; package.json exports + `published-doors`; example; guide "A crash-safe record" | P0, P4 |
| P7 | footprintjs | `attempts()` recorder, `AttemptStore` + `memoryStore`, by outcome and category, gave-ups, exemplars, `series(id)` (joins the explicit loop by tag), `aggregate()`, `toOTel()`; example (the AI-first path); `/recorders` README | P1a, P1c, P2, P3b, P4 (P6 for the example's stored-record hop) |
| P8 | agentfootprint | `withRetry` over `attempt()` (stream law kept as a wrapper around "open + first chunk"); `withFallback` reports the primary's failed call and the fallback's call as two attempts of one series (`reason: 'fell-back'`); `withCircuitBreaker`'s refusal is an attempt with `outcome: 'failed'`, `category: 'permanent'`, `reason: 'declined'` and no wire call; provider adapters set SDK retries to 0 under `$call` or report `observed`; `executeWithReliability` runs each iteration as a `$call` with `attempts: 1`; `classifyRetryReason` replaced by `errorCategory`; `resilienceHooks` derives `error.retried` / `error.recovered` / `fallback.triggered` from `onAttempt` records (one source; `ResilienceRecorder` unchanged for consumers); `otelObservability` AND `xrayObservability` emit one span event `agentfootprint.attempt` per attempt on the active span (`footprint.attempt.id`, `footprint.series`, `footprint.outcome`, `footprint.category`, `footprint.reason`, `http.request.resend_count` = attempt − 1) — never a count the adapter infers | P2, P7, fp release |
| P9 | footprint-explainable-ui | the Flow Lens: `createTraceRuntimeOverlay` reads `onAttempt` (the `onStageRetry` count inference retires); `StageNode` draws the loop arrow + badge from `attempts` / `attemptSummary`; `NodeInspector` lists attempts; a click opens `decision` in the existing evidence view; explicit loops grouped by `series` / tag; in-stage calls one arrow per target (§3.10) | fp release with P1a, P3b, P7 |

Release order: P0 ships first (foottrace 1.1.0; footprintjs's range moves to `^1.1.0` in P6). P1a–P5 and P7 can land
on footprintjs main as separate PRs and ship as ONE minor (10.1.0) once the consumer sweep (`consumers.yml`) is green
on the RC; P8 and P9 follow the release. Each packet: tests red before, example, the governed README's rule with an
example, CHANGELOG WHY + example, CLAUDE.md line — then review, then merge.

## 12. agentfootprint — reuse, replace, keep

| agentfootprint piece | Ruling |
|---|---|
| `withRetry` loop (`backOffOrThrow`, `openStream`) | REPLACE the loop with `attempt()`; KEEP the stream law (retry before the first chunk) as the wrapper's own rule; KEEP `defaultShouldRetry` as its `retryOn` and `statedRetryAfterMs` inside its `backoffMs(n, err)` — footprintjs never parses a header or prose; `classifyRetryReason` → `errorCategory` (one classifier) |
| `withFallback`, `fallbackProvider` | KEEP the decorator; REPORT through the attempt contract: the primary's failed call and the fallback's call are two attempts of one series, the first with `next: 'retry'`, `reason: 'fell-back'`, the second on the fallback `target` — so a fallback IS visible as a retry on another target, which is what it is |
| `withCircuitBreaker` | KEEP; an open breaker's refusal is an attempt record with no wire call (`outcome: 'failed'`, `category: 'permanent'`, `reason: 'declined'`, `durationMs: 0`); state changes stay the typed `circuit_changed` event |
| `resilienceHooks` → `typedEmit` | KEEP the event vocabulary (`error.retried` / `recovered` / `fallback.triggered`) for existing consumers and the adapters; SOURCE it from `onAttempt` so there is one loop and one count |
| `ResilienceRecorder`, `ReliabilityRecorder` | KEEP (bridges) |
| `executeWithReliability` (rules loop) | Each iteration under `$call(…, { attempts: 1 })` — the rules decide, the record shows every try |
| every provider call site (`LLMCall`, `callLLM`, the two message-API charts) | the call runs under `$call(provider.name, …)`, so a provider that never retries still records one attempt with its duration, outcome and category |
| `adapters/llm/retryAfter.ts` | KEEP — the adapter that knows its wire declares `retryAfterMs`; the policy reads it |
| `adapters/observability/otel.ts` and `xray.ts` | BOTH emit one span event per attempt (`agentfootprint.attempt`, from `onAttempt`, with the attempt id, series, outcome, category, reason and `http.request.resend_count`); the footprintjs recorder's `toOTel()` is the METRICS document, the adapters stay the TRACES path — no overlap, no inferred counts |
| `Agent.traceId` / `env.traceId` | KEEP; `env.traceparent` is accepted by footprintjs and agentfootprint forwards the header unchanged |
| `replayAttempts` (`src/resilience/replayAttempt.ts`, on `origin/main`) | KEEP — it carries a leaf-approved thinking-replay retirement across one call's attempts (what the NEXT attempt sends; `withRetry`, `withFallback`, `callLLM` and `reliabilityExecution` use it). It is request state, not a loop and not evidence: under P8 the attempt function reads `attempts.request` on each try and `attempt()` records the try. (Corrected 2026-10-15: an earlier draft said the file did not exist.) |

## 13. Open questions for the owner — ANSWERED (owner, 2026-10-15)

- **Q1 — Where attempts live. ANSWERED: the execution tree, the hook and the recorders' store — never the commit
  bundle.** Every log stays byte-identical, the fold and foottrace's bundle are untouched, and `retry-invariants`'
  "indistinguishable in the log" law holds. (P1a proved it: the `retry` record-bytes pin moved only inside the
  stage's execution-tree node.) The `CommitBundle.attempts?` alternative is rejected.
- **Q2 — Budget at build. ANSWERED: `.budget()` REFUSES at `build()`** when a bounded path exceeds it; unbounded
  stages warn (P5).
- **Q3 — A failing sink. ANSWERED: the default is `onFailure: 'report'`** — the run goes on, failures are counted on
  `getSnapshot().sink` with a dev-mode warning; `'fail'` opts into failing the run at the first lost entry.
- **Q4 — Where the foottrace checkout is. ANSWERED: P0 clones foottrace from GitHub** (`footprintjs/foottrace`);
  nothing is read from a local path that does not exist.

## 14. Rejected

A `$timeLeft()` / `$deadline()` pair of scope methods (two more `$` names for what `$attempt()` already carries) ·
a library-made default idempotency key (§3.3: wrong across resume and caller retries) · a new reserved byte for the
attempt suffix (parse from the right; `#<digits>` anchors it) · `AbortSignal.any` as a hard requirement (browsers) ·
a quantile sketch in the recorder (exact over the window; the store's query bounds the cost) · attempts as a
diagnostic channel (`$metric`) — it would have no shape, no hook and no stop reason · a second retry loop in
`ScopeFacade.call` (law 1) · a run-level `deadline` dial on `RunPolicy` (a deadline is per run, not a retention
policy; the frozen policy stays four dials) · the sink as a scope recorder on `onCommit` (it receives mutations, not
the landed bundle; the record's writer is the only one that has it) · a retry decision vocabulary of its own (the
`decide()` shape is reused, so the Lens's evidence view draws it unchanged) · a new engine node kind for the explicit
loop (`addRetryLoop` is four nodes the builder already makes — the `addDetachAndForget` precedent) · the loop's key in
the attempt CONTEXT only (a resumed pass must find it in state) · an open-ended category string (seven values, one
classifier, or every recorder breaks down differently) · keeping the `[Retry]` sentence beside the attempt line (two
lines for one fact).
