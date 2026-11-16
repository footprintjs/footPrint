---
paths:
  - ".claude/rules/feature-work/architecture.md"
---

# Architecture — contributor reference

Read the relevant section before changing its owner. These constraints and qualifications were moved from the root work map; dated examples retain their original wording. Code and the current owner rulings remain authoritative.

<a id="cl-001"></a>

<!-- analyzed-at: 22953d9 @ 2026-07-02 | model: fable-5 -->
# footprintjs — feature-work map

<a id="cl-002"></a>

Self-explaining flowchart engine: a fluent builder emits a static chart; one DFS pass executes it while observer channels + a commit log capture everything ("collect during traversal, never post-process"). This file maps seams and blast radius; for API description read the code/README — **trust the code** where any doc disagrees.

<a id="cl-003"></a>

## Module map

<a id="cl-004"></a>

Entry points: `footprintjs` (engine API), `/recorders`, `/trace` (engine recorders, stores and structure walkers), `/advanced` (engine internals), `/detach`, `/zod`, `/sinks` (10.1, NODE ONLY — `fileSink`, the one door that imports `node:fs`). The separate `foottrace` package owns records: root for readers/types/IDs, `/write` for writer primitives, `/paths` for path rules and nested diagnostic writes. No record declaration is re-exported by FootPrint 10. See `docs/design/2026-10-trace-extraction.md` for the extraction design and migration map.

<a id="cl-006"></a>

|<a id="cl-005"></a> src/lib/ | one job |
|---|---|
|<a id="cl-007"></a> capture/ | engine retention policies, bounded payload summarization, hook invocation and dev-mode helpers. Value-kind classification and record freezing now belong to foottrace. |
|<a id="cl-008"></a> memory/ | engine composition and policy: StageContext composes `RecordFrame` from `foottrace/write`; run addresses, redaction verdicts, frame types and diagnostics remain here. DiagnosticCollector uses `foottrace/paths`; replay/write rules are not copied here. |
|<a id="cl-009"></a> schema/ | duck-typed validation (`.safeParse/.parse` ⇒ 'parseable') |
|<a id="cl-010"></a> builder/ | fluent DSL → FlowChartSpec → StageNode graph; build-time StructureRecorder channel. NOT standalone: imports runner's makeRunnable (FlowChartBuilder.ts) `build()` SEALS the builder (`_refuseIfSealed`, asked by `_needCursor`, `BranchCursor · assertOpen` and the config doors): the chart shares the graph by reference. A door that attaches a continuation right after `loopTo()` refuses (`_needContinuationCursor`), `end()` refuses a `setDefault` id that names no branch, every mount door (eager through `_mountSubflow`, lazy) and `addParallelForEach` claim their id in `_claimFreshId`, which every stage door consults, so a mount and a stage cannot share an id in either order; `_assertLoopTarget` is the one loop-target check (`loopTo()` and a branch loop) and refuses a fork child by name (no continuation of its own) |
|<a id="cl-011"></a> builder/retryLoop.ts | `addRetryLoop` (10.1, P3b) composes ordinary attempt/reconcile/decide/wait/done/stop nodes over the shared `retryRules` table. One operation key survives passes and pause/resume; native physical calls stay unchanged and `retryLoop` metadata links logical passes/decisions. The helper declares conservative total-pass budget metadata, preserved through subflow prefixing; see src/lib/builder/README.md. |
|<a id="cl-012"></a> budget/ | the static time budget (10.1, P5): `timeBudget(chart)` walks the BUILT graph once (explicit stack, each chain memoised per start, capped at `MAX_WALK` visits, saturating sums) — stage = attempts × timeoutMs + waits, sequence = sum, decider/selector/fork = own stage + slowest child, `parallelForEach` = one branch; a FUNCTION backoff is never called (counted at `RetryPolicy.maxBackoffMs`, which `attempt/policy.ts · cappedWaitMs` makes the runner enforce; else unbounded `'backoff'`); loops NEVER iterated (unbounded unless `assume.loops` or an explicit helper's declared pass bound). Read by the builder (`.budget(ms)` refuses at `build()` when `knownMs > budgetMs`) and the runner (`chart.timeBudget()`, the run-start warning) — its own module because a runner → builder edge closes the builder ⇄ runner cycle; see src/lib/budget/README.md |
|<a id="cl-013"></a> scope/ | ScopeFacade per stage (tracked get/set, $emit, frozen args/env); built-in ScopeRecorders in scope/recorders/ |
|<a id="cl-014"></a> reactive/ | TypedScope deep Proxy over the facade — four write laws + the honest boundary (what `find`/`for…of` hands back is raw and WARNED ABOUT in dev mode, not intercepted; a proxy held past its stage IS refused — `ScopeFacade` · `assertLive`); handles.ts = the registry of every proxy the factories built → the value behind it, asked wherever an app value enters the record (the set traps since 9.24.0 — no JSON round-trip any more; fan-out `resolveItems`, subflow in/out mappers, `$setValue`/`$update`/`$batchArray` since 9.23.3, after a fan-out over object items seeded the handle and lost every child); see src/lib/reactive/README.md |
|<a id="cl-015"></a> decide/ | decide()/select() evidence capture |
|<a id="cl-016"></a> filter/ | `evaluator.ts · evaluateFilter` — the ONE filter-rule law, shared by decide() and the attempt rule table; its own leaf module since P2 (10.1), because in decide/ it made attempt/ reach scope/ and `scope.$call` closed an attempt ⇄ decide ⇄ scope module cycle It also owns the two comparison laws (11.x audit): ORDER (`gt`/`gte`/`lt`/`lte`) holds only between two values of one kind — two numbers, two bigints, two strings, two Dates — with no coercion, so a missing value satisfies none of them; SAME VALUE (`eq`/`ne`/`in`/`notIn`) is `===` plus `NaN` with `NaN` and two Dates at one time. A Date is told by `timeOf` (`Date.prototype.getTime.call`), never `instanceof`: no author code and no Proxy trap runs. See src/lib/decide/README.md |
|<a id="cl-017"></a> attempt/ | the ONE retry loop and its record (10.1, docs/design/2026-10-time-and-failure-evidence.md): `runner.ts · runAttempts` runs a policy and makes one frozen `AttemptRecord` per try (timing, outcome, category, the retry-or-stop decision as `DecisionEvidence`) + an `AttemptSummary`; `decision.ts · retryRules` = the one rule table as `decide()` rules (first match, labels ARE the reasons) + `decideAttempt`, decide()'s evaluation without a scope (filter rows from `filter/evaluator`; a property test pins equal evidence); `category.ts · errorCategory` = the one classifier (seven fixed values); `errors.ts`, `anySignal.ts`; `backoff.ts · exponentialBackoff` / `statedWaitFirst` build the function `RetryPolicy.backoffMs` takes (exponential ceiling, `'none'`/`'equal'`/`'full'` jitter from an injectable `random`, a stated wait first — the cap stays `maxBackoffMs`, so the budget still counts it). L5 beside decide/, but `types.ts` (with `decide/types.ts`) is an L0 leaf because `StageSnapshot` (L4) names it. `RetryPolicy` is declared here, re-exported by engine/types.ts |
|<a id="cl-018"></a> timers/ | the ONE long-timer law, a neutral L0 leaf folder (like `ids/`): `longTimeout.ts · setLongTimeout(fn, ms, { unref? })` — `Infinity` arms no timer; a delay past 2^31 − 1 ms is waited in chunks, never 1 ms; anything not a number > 0 is due at once. Every caller-supplied wait in `src/` arms it (the runner's caps, waits and deadline, the observer queue's `drain` at L1, `flushAllDetached`, `flushRecord`, the file sink, the indexed reader, the `attempts()` recorder, capture history, the `setTimeout` detach driver). `test/architecture/timer-law.test.ts` refuses, outside it: a raw `setTimeout` / `setInterval` whose delay is not a literal a host timer holds (or a constant on its named allow-list), any indirect reach of one (alias, `globalThis['setTimeout']`, `.call`, destructuring, `Reflect.apply`), a `timers` / `timers/promises` import, `scheduler.wait`, and `AbortSignal.timeout` past 2^31 − 1 or non-literal; see src/lib/timers/README.md |
|<a id="cl-019"></a> recorder/ | engine stores (KeyedStore/SequenceStore/BoundaryStateStore), CombinedRecorder routing, and built-in Topology/InOut/ControlDep/Quality recorders. `CommitRangeIndex` is owned and exported by foottrace. `attemptSeries.ts` = the ONE predicate every built-in recorder uses for attempt rows (P1c, 10.1: a series that RETRIED, GAVE UP or TIMED OUT; a first-time success adds no row anywhere, so no-retry runs stay byte-identical) — it lives here, not in attempt/, because a recorder → attempt runtime edge closes the attempt⇄decide⇄recorder⇄scope module cycle. Quality/Debug see `onAttempt` only through `attachCombinedRecorder` |
|<a id="cl-020"></a> pause/ | PauseSignal / FlowchartCheckpoint types + `interrupt(scope, payload)` (throws InterruptSignal; converted to PauseSignal at the StageRunner boundary, `pausedBy:'interrupt'`) |
|<a id="cl-021"></a> engine/ | FlowchartTraverser + handlers/; narrative/ = the whole FlowRecorder channel (dispatcher + 9 strategies), not just text; `lib/ids/branchSegment.ts` (moved to the `ids/` leaf in 9.37.0) = the ONE owner of the generated-segment grammar (`<stageId>~<index>`, marker `~` RESERVED); `executeStage` = the ONE funnel every stage fn passes through — and therefore the ONE owner of the declarative `retry` loop; `handlers/ResumeEntry.ts` = the ONE owner of a resume's ONE-SHOT re-entry (M2, 9.28.0: start + one hop per subflow on the pause path, each level's dispatcher continuation read from the chart, waiting sibling pauses queued at their fan-out) |
|<a id="cl-022"></a> runner/ | FlowChartExecutor wiring — composes `attach.ts` (RunObservers) · `resume.ts` · `checkpoint.ts` · `snapshot.ts` · `options.ts` (F9, 9.41.0); `ExecutionRuntime.ts` owns run state and observer wiring; (runtime, recorders, pause/resume, snapshot, DeferredObserverTier). RunContext.ts is a fluent run builder, NOT the threaded per-run context `RunContext · run` (the short form `chart.run()`) returns `paused: true` + `checkpoint` and no `output` for a run that paused |
|<a id="cl-023"></a> observer-queue/ | pure deferred-delivery pipeline (engine imports IT, never reverse) |
|<a id="cl-024"></a> sinks/ | (10.1, P6) `fileSink` / `readRecordFile` — the crash-safe record on a Node host: one JSON line per entry, each written asynchronously at its own offset, only the path given (O_NOFOLLOW, 0o600; hard links / foreign / shared-writable refused), every resource bounded. The ONLY `node:` importer in src/ (layering.test pins it and that only `src/sinks.ts` reaches it). The run's side is `runner/recordSink.ts · RunRecord` |
|<a id="cl-025"></a> contract/, detach/ | I/O schema normalization (OpenAPI generation belongs to runner/RunnableChart); fire-and-forget child charts (drivers passed explicitly) |

<a id="cl-026"></a>

**The fence:** engine files import only their own layer or below, using `scripts/layering.config.cjs` as the single table for lint, the checker and architecture tests. Named engine exceptions remain explicit and live-checked. The record is no longer a local L0–L3 subset: it lives in the standalone foottrace repository, whose closed source graph cannot import this engine, Node APIs or other packages. All engine access to the record uses named imports from `foottrace`, `foottrace/write` or `foottrace/paths`, never package internals. Export tests reject any FootPrint door handing out a declaration owned by foottrace. See the extraction plan for the E3/E6 published-door gate.

<a id="cl-089"></a>

## Pointers

<a id="cl-090"></a>

- [.claude/rules/backtracking.md](../../../.claude/rules/backtracking.md) — the 7 mechanisms with step tables + pseudocode

<a id="cl-091"></a>

- [docs/guides/](../../../docs/guides/) (error-handling, observers-deferred) · [examples/](../../../examples/) — mandatory integration tests (Convention 2); 7 test types per feature (Convention 3)

<a id="cl-092"></a>

- Build/test: `npm run build` (CJS+ESM+types), `npm test`
