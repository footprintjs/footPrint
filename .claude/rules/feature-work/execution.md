---
paths:
  - "src/lib/engine/**"
  - "src/lib/runner/**"
  - "src/lib/attempt/**"
  - "test/lib/engine/**"
  - "test/lib/attempt/**"
---

# Execution — contributor reference

Read the relevant section before changing its owner. These constraints and qualifications were moved from the root work map; dated examples retain their original wording. Code and the current owner rulings remain authoritative.

<a id="cl-027"></a>

## Core state & flow

<a id="cl-028"></a>

Component lifecycle wiring: `runner/NativeRunLifecycle.ts` owns weak component-port
registration; retain the lifecycle strongly. A component slot enables `componentSetup`.
`recorder/ComponentRunControl.ts` selects inline component recorders; `FinalizationBook.ts`
joins cleanup after observation. Cleanup bounds its own time; failFast siblings can
finish after parent rejection, and a pause remains usable after counted cleanup failures.

<a id="cl-029"></a>

- `SharedMemory` (`foottrace/write`) is the copy-on-write live heap. StageContext decides the address with the engine's `runAddress` rule and composes a `RecordFrame`. Record encoding, staging, commit and replay laws are implemented only in foottrace; the engine supplies policy and commit identity.

<a id="cl-030"></a>

- `StageContext` (`memory/StageContext.ts`) owns per-stage run context. `stageWrite` decides redaction and identity inheritance, passes the resulting scrub bytes to `RecordFrame.write`, then records the engine's write marks. Commit delegates to the record frame, delivers engine hooks, and releases stage-local tracking. `runId` is readonly; the engine decides the record address once.

<a id="cl-031"></a>

- `CommitBundle` (`foottrace`) / `EventLog` (`foottrace/write`) retain the existing bundle/index and full/delta encoding law. Neither is a FootPrint export.

<a id="cl-032"></a>

- `TraversalContext` (engine/narrative/types.ts) — THE per-event context (runId, runtimeStageId, parentRuntimeStageId, subflowPath, loopIteration, and `correlation` when the env gave one — P4, `attempt/correlation.ts · resolveCorrelation`, one frozen object per leg, also on scope/emit events and `getSnapshot().correlation`); stamped on every FlowRecorder event.

<a id="cl-033"></a>

- `runtimeStageId` = `[subflowPath/]stageId#executionIndex`; counter shared by reference into subflow traversers → globally unique; NOT reset on resume.

<a id="cl-034"></a>

- Subflows get a fresh isolated ExecutionRuntime (`SubflowExecutor · executeSubflow`); inputMapper seeds, outputMapper merges back (arrays CONCAT unless `arrayMerge: Replace`). A mapper is handed `handlers/mapperScope.ts · mapperScope(mount)`, never the state object: a PROXY (built in constant time, registered as a handle so a view handed on whole is unwrapped to a plain record, CLOSED by `SubflowExecutor` once the mapper's result is taken: a later read throws). Each key it reads is a tracked read of the MOUNT (`StageContext · readLiveRoot`: the live root value, the read prefix, the redaction verdict and taint count, and in `stageReads` what the run's `readTracking` keeps of any read, a copy under `'full'`; a key the state does not hold records nothing). The merge-back's own reads of what it adds to (`applyOutputMapping`) are the mount's too: the list it appends to through `readLiveRoot`, the object its fields go into through `readOwnView` (the frame's own view, where those fields are written), so `causalChain` walks through a mount to the stages before it. A value the merge-back writes in PIECES (an object field by field, a list as a new array) is asked about whole first (`StageContext · inheritRule`), or a selected object would lose its rule there. No door hands user code the whole state past the tracked funnel (`getScope()` is gone).

<a id="cl-035"></a>

**Retry (9.15.0; on the attempt runner since 10.1):** `StageNode.retry` is a POLICY on a stage, not a kind — no new node type, no `computeNodeType` edit. `FlowchartTraverser.executeStage` is the one call site, so linear/streaming/pausable/decider/selector/fork-child/subflow-inner all get it from one implementation; the LOOP is `attempt/runner.ts · runAttempts`, handed the engine's half (one attempt = `StageRunner · run`, `between` = `discardStaged`, `serve` = `servedStageError`, the frame's `recordAttempt` / `endAttempts`, `onAttempt` / `onStageRetry`). `executeStage` is deliberately NOT async: a policy stage runs on the runner's promise (one await per attempt, the 9.15 shape) and a no-policy (or `attempts: 1`) stage on `runStageOnce`, the pre-10.1 async frame — so microtask order, hence parallel siblings' settle order, never moved. Every attempt is an `AttemptRecord` on `StageContext · recordAttempt` → `StageSnapshot.attempts` (+ `attemptSummary`), NOT cleared by `discardStaged`, NEVER on the commit bundle (Q1: logs byte-identical); a declined stop (`retryOn → false`) is now a record (`reason: 'declined'`). A failed non-final attempt calls `StageContext.discardStaged()` (`RecordFrame · discard`, which drops the buffer, the first-touch base and readKeys, plus _stageWrites/_stageReads + _untrackedSources); the final attempt is today's law untouched. PauseSignal and abort are NEVER retried. One runtimeStageId + one CommitBundle per stage regardless of attempts; retries do not consume `maxIterations`.

<a id="cl-036"></a>

**In-stage calls (10.1, P2):** `scope.$call(target, fn, policy?)` (four-file checklist: `ScopeFacade · call`, `ReactiveTarget.call`, `ScopeMethods.$call`, `METHOD_ROUTES.$call`, `SCOPE_METHOD_NAMES`) runs on the same runner via `attempt/call.ts · runCall` (kind `'call'`, `target` on every record, no policy = `{ attempts: 1 }` — still ONE record). The facade is the host: signal = its stage attempt's, deadline = `runner.ts · attemptEndsAt` (start + cap; the cap's reason is branded a time limit, `markTimeLimit`, so a cut call is `timeout`), series = `callSeries` (`<rsid>@<n>.<k>`, k from `StageContext · nextCallOrdinal`). Records land through `StageContext · reportCallAttempt` (bounded, `MAX_CALL_RECORDS` = 1000, the rest counted in `attemptsDropped`) → the reporter `executeStage` installs on every stage (`useAttemptReporter` → `onAttempt` with the stage's traversalContext/correlation). A call lives within its stage attempt: a record arriving after that attempt ended or committed is refused (`lateWrites`, channel `'attempt'`, `call:<target>`) and the call stops; a call attempt CUT by the stage attempt's own abort is admitted. `AttemptContext.observed(report)` (`attempt/observed.ts`) records kind `'observed'` (named fields only, read once; decision = the rule table under the default policy). `attempt/name.ts` = the one name rule (1–128, no Cc/Cf/Cs/Zl/Zp). Standalone `attempt()` = `attempt/standalone.ts` (records to `onAttempt` only, its own `armDeadline`).

<a id="cl-037"></a>

**Time budget (10.1, P1b):** `armRun` (`runner/deadline.ts`) composes `RunOptions.signal`, `env.signal` and the deadline (`deadline` / `timeoutMs` / `env.deadline`, earliest wins) into ONE signal and stamps `env.deadline` + `env.signal` (only when a deadline exists or the caller gave an env — an env-less signal-only run stays byte-identical). At the deadline the signal aborts with a BRANDED reason (`attempt/deadline.ts`): an attempt it ends is `timeout`, never `aborted`. `executeStage` runs a stage on the runner when its policy retries, declares `timeoutMs`, or the run has a deadline (so a lone stage records `attempts`, `of: 1`). The runner hands `StageRunner` an `AttemptContext` (`scope.$attempt()`; StageRunner races ITS signal) and calls `onAbandon(n)` synchronously when the attempt ends without an answer → `StageContext · endAttempt` fences that attempt's facade: later writes/emits/reads are refused, writes/emits recorded in `StageSnapshot.lateWrites`. Under a deadline `backoffMs` is asked before the discard (rule 6 needs the wait).

<a id="cl-038"></a>

**Declared tags (9.21.0):** `StageNode.tags?: readonly string[]` is a NAME on a stage, declared at build time — POLICY-like (the retry precedent): no node type, no `computeNodeType` edit, no type-union site, and the one prefixer (`engine/graph/prefixNodeTree.ts`, 9.37.0) spreads `{ ...node }` so it rides subflow prefixing untouched. ONE landing site `FlowChartBuilder.ts · applyTags` (twin of `applyRetryPolicy`) serves the `.tag(...names)` cursor modifier and every `options.tags` site; refuses empty/non-string/`~`/duplicate/double-declare at build. Stamp: `FlowchartTraverser.executeNodeStep` sets `context.tags = node.tags` beside `runtimeStageId` (unconditionally — a re-used context must not keep a prior node's names); foottrace's `memory/recordCommit.ts · recordCommit` (C1, 9.44.3; was `StageContext · bundleFor`) stamps `tags` beside `untrackedSources` on BOTH commit paths and `StageContext · commit` RELEASES them, so a double-commit path (fork child fan-out repeat, mount exit) records it once — absent when empty (`CommitBundle.tags?`; pinned byte-identical to 9.20.0 by test/lib/engine/scenario/declared-tags-byte-identity.test.ts). NOT inherited by createNext/createChild; the one synthetic node that could lose it is `FlowChartExecutor.resume`'s stand-in for the paused stage — built by `runner/resume.ts · standInFor` from the paused node ITSELF (fn swapped), so it keeps the tags on both re-entries; it runs ONCE — a later visit of the paused id runs the chart's real node, which carries its own tags. The spec carries `tags` as-is (Map advertises the vocabulary; `RuntimeStructureManager.stageNodeToStructure` copies it for run-time-resolved nodes). Reader: foottrace's `tagStops` = `filterStops(commitStops(...), any-of over log[stop.commitIdx].tags, meta = the array)`, exported from `foottrace`. Never a runtime `$tag()` — a value would ride past every redaction point. Design: docs/design/2026-09-declared-tags.md.

<a id="cl-039"></a>

**Event order (code-verified; older docs had 3/4 swapped):** onStageStart → onRead/onWrite (live, PRE-commit) → **onStageEnd (StageRunner.ts) →** [a retry policy: `onAttempt` per attempt, then `onStageRetry` for each one retried — both DURING the stage] **→ onCommit (`StageContext · commit`, after `RecordFrame · commit`)** → FlowRecorder onDecision/onFork/onSelected/onSubflowEntry → onStageExecuted (uniform, with stageType). Error path: commit STILL happens (`FlowchartTraverser · executeNodeStep` → `commitStageWrites`) before onError+rethrow — a failing stage's writes land. For ANY thrown value (null, null-prototype, hostile Proxy) catch blocks describe it with `errors/errorInfo · thrownText` (never throws), onError fires, and run() rejects with the ORIGINAL value; a failed commit (e.g. an uncloneable write) also fires onError (`handlers/commitStage.ts`, 9.40.0). `interrupt()` rides the ERROR path's shape, not the pausable one: the stage function threw, so onStageEnd does NOT fire (the `addPausableFunction` pause DOES fire it — there the function returned normally). `addParallelForEach` has both failure laws (`ParallelForEachHandler · endFailed`): the stage's OWN failure (items selector, branch factory, results write) takes the linear error path — commit, `onError`, rethrow, no `onStageEnd`; a BRANCH's failure was reported by the branch's stage, so the fan-out stage only commits (`commitStage`, at the first failing branch under `failFast`, possibly before slower siblings) and passes it on.
