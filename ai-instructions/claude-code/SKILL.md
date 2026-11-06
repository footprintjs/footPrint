---
name: "footprint"
description: "Use when building flowchart pipelines with footprintjs: stages, decide and select branches, subflows, loops, retries, $call and $attempt, time budgets, pause and resume, recorders, narrative, redaction, contracts, saved records and foottrace queries. Also use when someone asks how FootPrint works or wants to understand the library."
---

# FootPrint: connected runtime logs for people and AI agents

<!-- Generated from ai-instructions/source by scripts/ai-instructions/generate.mjs. Edit the source, then run npm run ai:generate. -->

## Which copy to trust

This skill is a copy and can lag. `node_modules/footprintjs/AGENTS.md` holds the same text for the installed version, so trust it over this file.

## What FootPrint is

**Connected runtime logs for people and AI agents.**

FootPrint runs your logic as a flowchart of named stages. While it runs, it records what each stage read and wrote, which decision was taken and why, and every retry. No model is involved and nothing is rebuilt afterwards. A person or an agent follows a result back through the record instead of guessing from separate log lines.

The one law: collect during the run, and never walk the tree afterwards. Evidence that was not collected stays unknown. The record shows what the program did, not whether it was right.

## How a chart runs

- **Build:** `flowChart<T>()` starts a chart. `.addFunction()` and the branch methods add stages. `.build()` fixes its shape.
- **Run:** `FlowChartExecutor` walks the chart once with `run({ input, env })`. A stage's writes are staged, then committed when the stage ends.
- **Read:** recorders fire during the run. `getSnapshot()` and `getNarrativeEntries()` serve the result. `foottrace` queries the record afterwards.

## Import map

Import a name from the door that owns it. FootPrint does not re-export the record, so its readers come straight from `foottrace`. If you import it yourself, add it to your dependencies and keep one installed copy (`npm ls foottrace`).

| Import | What it is for | Common names |
| --- | --- | --- |
| `footprintjs` | The main door: build, run, decide, retry, pause. | `flowChart`, `FlowChartExecutor`, `decide`, `select`, `narrative`, `attempt`, `exponentialBackoff`, `timeBudget`, `interrupt`, `TypedScope`, `RetryPolicy`, `FlowRecorder`, `CombinedRecorder` |
| `footprintjs/recorders` | Recorder factories. | `narrative`, `attempts`, `metrics`, `debug`, `manifest`, `adaptive`, `milestone`, `windowed`, `memoryStore`, `CompositeRecorder` |
| `footprintjs/trace` | Engine recorders, recorder stores and structure walkers. Not the record. | `controlDepRecorder`, `topologyRecorder`, `inOutRecorder`, `QualityRecorder`, `KeyedStore`, `SequenceStore`, `BoundaryStateStore`, `walkSubflowSpec` |
| `footprintjs/detach` | Fire-and-forget child charts and their drivers. | `microtaskBatchDriver`, `immediateDriver`, `setTimeoutDriver`, `flushAllDetached`, `DetachHandle` |
| `footprintjs/sinks` | Node only. The crash-safe record as a JSON-lines file. | `fileSink`, `readRecordFile`, `openIndexedRecordFile` |
| `footprintjs/zod` | Opt-in zod scope helpers. zod is an optional peer. | `defineScopeFromZod`, `defineScopeSchema`, `ZodScopeResolver` |
| `footprintjs/advanced` | Engine internals. Use them to extend the engine, not to write a chart. | `ArrayMergeMode`, `SubflowMountOptions`, `StageSnapshot`, `ScopeFacade`, `registerScopeRuntime`, `SCOPE_METHOD_NAMES`, `StageContext`, `FlowchartTraverser` |
| `foottrace` | Read a record: shapes, runtime IDs, commit queries, slices, time travel, stored records. | `findLastWriter`, `findCommit`, `causalChain`, `formatCausalChain`, `sliceForKey`, `stateAt`, `timeTravel`, `readStoredRecord`, `parseRuntimeStageId`, `CommitBundle`, `HONESTY_CODES` |
| `foottrace/write` | Write a record yourself. | `SharedMemory`, `EventLog`, `RecordFrame`, `memorySink` |
| `foottrace/paths` | Record-path rules, safe nested access and diagnostic-bag writes. | `setNestedValue`, `updateNestedValue` |
| `foottrace/cause` | Optional bounded cause, impact and attention queries. | `explain`, `attentionList` |
| `foottrace/metadata` | Optional value-free queries over path occurrences. | `readTraceMetadata`, `traceMetadata` |
| `foottrace/prov` | Optional export of one recorded scope as PROV-O, without values. | `exportProv` |

## Find your task

Read the first path in the row and stop when you have your answer. For a signature or an option's meaning, read the JSDoc in `node_modules/footprintjs/dist/types/*.d.ts`.

Paths are in the repository, not the npm package, except those under `node_modules`. Open them at `https://github.com/footprintjs/footPrint/blob/main/<path>`.

| Task | Use | Read |
| --- | --- | --- |
| Write a first chart with typed state | `flowChart<T>()`, `.addFunction()`, `.build()`, `FlowChartExecutor` | `examples/getting-started/quick-start.ts`, `docs/guides/patterns.md#linear` |
| Read and write state, including dynamic keys | `scope.key`, `$setValue()`, `$update()`, `$batchArray()`, `$getArgs()`, `$getEnv()` | `src/lib/reactive/README.md`, `examples/runtime-features/typed-scope/01-structured-values.ts` |
| Choose branches and keep the evidence | `decide()`, `.addDeciderFunction()`, `.setDefault()`, `select()`, `.addSelectorFunction()` | `docs/guides/patterns.md#conditional-decider`, `examples/building-blocks/03-decider.ts`, `examples/building-blocks/04-selector.ts` |
| Run stages in parallel | `.addListOfFunction()`, `failFast` | `docs/guides/patterns.md#parallel-fork`, `examples/building-blocks/02-fork.ts` |
| Fan out one branch per item | `.addParallelForEach()` | `examples/runtime-features/parallel-for-each/01-fan-out-per-item.ts` |
| Compose charts | `.addSubFlowChartNext()`, `.addSubFlowChartBranch()`, `inputMapper`, `outputMapper` | `docs/guides/patterns.md#subflow-composition`, `examples/building-blocks/05-subflow.ts` |
| Loop, or stop early | `.loopTo()`, `scope.$break()`, `run({ maxIterations })` | `examples/building-blocks/06-loops.ts`, `docs/guides/patterns.md#loops` |
| Stream tokens from a stage | `.addStreamingFunction()` | `docs/guides/patterns.md#streaming-llm`, `examples/runtime-features/streaming/01-linear.ts` |
| Add a retry to a flaky stage | `.retry()`, `retryOn`, `errorCategory()` | `docs/guides/error-handling.md#declarative-retry`, `examples/runtime-features/retry/01-declare-a-retry.ts` |
| Choose a wait between tries | `exponentialBackoff()`, `statedWaitFirst()`, `maxBackoffMs` | `docs/guides/error-handling.md#backoff-schedules`, `examples/runtime-features/retry/08-backoff-helpers.ts` |
| Record calls made inside a stage | `scope.$call()`, `scope.$attempt()`, `attempt()` | `docs/guides/error-handling.md#retries-you-did-not-run`, `examples/runtime-features/retry/05-attempts-inside-a-stage.ts` |
| Retry a charge or other outside effect | `.touches()`, `idempotencyKey`, `UnknownEffectError` | `docs/guides/error-handling.md#side-effects`, `examples/runtime-features/retry/04-side-effects-and-idempotency.ts` |
| Check the outside system before resending | `.addRetryLoop()` | `src/lib/builder/README.md#explicit-retries-that-reconcile-an-outside-operation`, `examples/runtime-features/retry/06-explicit-reconciliation.ts` |
| Bound how long a run or a chart can take | `run({ deadline, timeoutMs, signal })`, `.budget()`, `timeBudget()` | `docs/guides/error-handling.md#time-budget`, `examples/runtime-features/retry/03-deadline-and-timeout.ts`, `examples/build-time-features/budget/01-time-budget.ts` |
| Handle a failed run | `getSnapshot()`, `getFailureContext()`, `onRunFailed` | `docs/guides/terminal-failure-context.md`, `docs/guides/error-handling.md#what-consumers-can-do-after-failure`, `examples/errors/04-terminal-failure-context.ts` |
| Pause for a person, then resume | `interrupt()`, `.addPausableFunction()`, `getCheckpoint()`, `resume()` | `docs/guides/execution-model.md#pause--resume--what-a-checkpoint-captures`, `examples/runtime-features/pause-resume/08-interrupt.ts` |
| Run work without waiting for it | `.addDetachAndForget()`, `.addDetachAndJoinLater()`, `scope.$detachAndForget()` | `examples/runtime-features/detach/README.md` |
| Get the run as sentences | `enableNarrative()`, `getNarrativeEntries()`, `narrative()` | `docs/guides/flow-recorders.md#quick-start`, `examples/runtime-features/flow-recorder/01-simple-observer.ts` |
| Keep a long loop's narrative short | `WindowedNarrativeFlowRecorder`, `RLENarrativeFlowRecorder` | `docs/guides/flow-recorders.md#built-in-loop-strategies`, `examples/runtime-features/flow-recorder/09-strategy-comparison.ts` |
| Write a recorder | `attachCombinedRecorder()`, `attachFlowRecorder()`, `attachScopeRecorder()`, `KeyedStore` | `docs/guides/flow-recorders.md#building-custom-flowrecorders`, `examples/recorders/README.md` |
| Emit your own events | `scope.$emit()`, `attachEmitRecorder()` | `examples/runtime-features/emit/01-custom-events.ts` |
| Keep a slow recorder off the run's path | `attachFlowRecorder(r, { delivery: 'deferred' })`, `drainObservers()` | `docs/guides/observers-deferred.md`, `examples/runtime-features/deferred-observers/01-basic.ts` |
| Measure attempts and latency | `attempts()`, `byTarget()`, `slowest()`, `toOTel()` | `docs/guides/attempt-metrics.md`, `examples/runtime-features/retry/07-attempt-metrics-and-trace.ts` |
| Show a viewer what needs a look | `StageSnapshot.attention` | `docs/guides/attention.md`, `examples/runtime-features/attention/01-stage-attention.ts` |
| Track the run's shape while it runs | `topologyRecorder()`, `inOutRecorder()` | `examples/runtime-features/flow-recorder/06-topology.ts`, `examples/runtime-features/flow-recorder/07-inout.ts` |
| Hide secrets | `setRedactionPolicy()`, `getRedactionReport()`, `getSnapshot({ redact: true })` | `docs/guides/scope.md#redaction-pii-protection`, `examples/runtime-features/redaction/01-linear.ts` |
| Find what caused a value | `findLastWriter()`, `causalChain()`, `sliceForKey()`, `controlDepRecorder()` | `examples/post-execution/causal-chain/01-linear.ts`, `examples/post-execution/variable-slice/01-why-is-this-value.ts` |
| Step through a finished run | `timeTravel()`, `stateAt()` | `examples/post-execution/time-travel/01-a-readers-cursor.ts`, `node_modules/foottrace/README.md` |
| Save a run and survive a crash | `fileSink()`, `readRecordFile()`, `readStoredRecord()` | `docs/guides/error-handling.md#a-crash-safe-record`, `examples/runtime-features/crash-safe-record/01-sink-and-incomplete-run.ts` |
| Say what a run captured, and save that | `captureCoverage`, `readStoredCapture()` | `docs/guides/capture-coverage.md`, `docs/guides/saved-capture-history.md` |
| Load one saved scope from a large file | `openIndexedRecordFile()` | `docs/guides/indexed-scope-loading.md`, `examples/runtime-features/crash-safe-record/04-indexed-scope-loading.ts` |
| Keep evidence of outside calls and their reads | `readSources`, `readAttempts` | `docs/guides/external-evidence.md`, `docs/guides/exact-read-sources.md` |
| Expose a chart as an API or an MCP tool | `.contract()`, `toOpenAPI()`, `toMCPTool()` | `docs/guides/contracts.md`, `examples/build-time-features/contract/01-zod-schema.ts` |
| Learn the supported limits |  | `docs/guides/execution-model.md#summary--the-envelope-in-one-box`, `docs/guides/performance.md` |
| Say what the record cannot prove |  | `docs/provenance-governance-and-limits.md` |

## Three canonical snippets

Each is a real file in `ai-instructions/source/snippets/`. `npm run check:doc-snippets` compiles it. `npm run test:examples` runs it and compares its output with the `// Output:` lines.

### Decide, then explain

```typescript
// Build a chart, run it, and read why it took a branch.
import { decide, flowChart, FlowChartExecutor } from 'footprintjs';

interface LoanState {
  creditScore: number;
  decision?: string;
}

const chart = flowChart<LoanState>('Intake', (scope) => {
    scope.creditScore = scope.$getArgs<{ score: number }>().score; // input is frozen and untracked; state is tracked
  }, 'intake')
  .addDeciderFunction('Route', (scope) => decide(scope, [
      { when: { creditScore: { gte: 700 } }, then: 'approve', label: 'Good credit' },
    ], { branch: 'review', label: 'No rule fired' }), 'route')
    .addFunctionBranch('approve', 'Approve', (scope) => { scope.decision = 'approved'; })
    .addFunctionBranch('review', 'Review', (scope) => { scope.decision = 'manual review'; })
    .end()
  .build();

const executor = new FlowChartExecutor(chart);
executor.enableNarrative(); // off until you ask, and must come before run()
await executor.run({ input: { score: 640 } });

console.log(executor.getSnapshot().sharedState.decision);
for (const entry of executor.getNarrativeEntries()) console.log('  '.repeat(entry.depth) + entry.text);

// Output:
// manual review
// Stage 1: The process began with Intake.
//   Step 1: Write creditScore = 640
// Stage 2: Next, it moved on to Route.
//   Step 1: Read creditScore = 640
//   [Condition]: No rules matched, fell back to default "No rule fired": Review.
// Stage 3: Next, it moved on to Review.
//   Step 1: Write decision = "manual review"
```

`decide()` records each rule's values and thresholds as evidence, on the narrative line and on `onDecision`. `select()` is its twin: every matching rule picks a branch, and the picked branches run in parallel.

### Retry, and record each try

```typescript
// Retry a stage, record a call inside a stage, and bound the time.
import { flowChart, FlowChartExecutor } from 'footprintjs';

interface QuoteState {
  rate?: number;
  stock?: number;
}

// Local stand-ins for outside services: busy once, then they answer.
const busyOnce = <T>(value: T) => {
  let calls = 0;
  return async (signal: AbortSignal): Promise<T> => {
    signal.throwIfAborted();
    if (++calls === 1) throw Object.assign(new Error('service busy'), { status: 503 });
    return value;
  };
};
const fetchRate = busyOnce(1.09);
const lookupStock = busyOnce(7);

const chart = flowChart<QuoteState>('Fetch rate', async (scope) => {
    // Pass the signal on, so a timeout stops the work and not only the wait.
    scope.rate = await fetchRate(scope.$attempt().signal);
  }, 'fetch-rate')
  .retry({ attempts: 3, backoffMs: 10, timeoutMs: 1_000 }) // attempts counts the first run too
  .addFunction('Check stock', async (scope) => {
    // Every attempt of a call is recorded, even with no policy.
    scope.stock = await scope.$call('inventory.lookup', (t) => lookupStock(t.signal), { attempts: 2, backoffMs: 10 });
  }, 'check-stock')
  .budget(5_000) // build() refuses a chart whose declared policies allow longer
  .build();

console.log('declared worst case', chart.timeBudget().knownMs);

const executor = new FlowChartExecutor(chart);
executor.attachFlowRecorder({
  id: 'attempts',
  onAttempt: ({ stageId, record }) =>
    console.log(stageId, record.kind, record.target ?? '-', `${record.attempt}/${record.of}`, record.outcome, record.reason),
});
await executor.run({ timeoutMs: 5_000 }); // one deadline for the whole run

// Output:
// declared worst case 3020
// fetch-rate stage - 1/3 failed retryable
// fetch-rate stage - 2/3 ok answered
// check-stock call inventory.lookup 1/2 failed retryable
// check-stock call inventory.lookup 2/2 ok answered
// check-stock stage - 1/1 ok answered
```

`knownMs` counts only what declares a timeout. `Check stock` declares none, so it adds 0 and `worstCaseMs` is `null`. `timeBudget()` names every stage it cannot bound.

### Follow a value back

```typescript
// Follow a value back to the decision and the data that produced it.
import { decide, flowChart, FlowChartExecutor } from 'footprintjs';
import { controlDepRecorder } from 'footprintjs/trace';
import { causalChain, findLastWriter, formatCausalChain, keysReadFromExecutionTree } from 'foottrace';

interface ExportState {
  width: number;
  status?: string;
}

const chart = flowChart<ExportState>('LoadImage', (scope) => { scope.width = 640; }, 'load-image')
  .addDeciderFunction('CheckResolution', (scope) => decide(scope, [
      { when: { width: { gte: 1280 } }, then: 'export', label: 'Wide enough' },
    ], 'reject'), 'check-resolution')
    .addFunctionBranch('export', 'ExportImage', (scope) => { scope.status = 'exported'; })
    .addFunctionBranch('reject', 'RejectExport', (scope) => { scope.status = 'rejected'; })
    .end()
  .build();

const executor = new FlowChartExecutor(chart);
const control = controlDepRecorder(); // connects a branch to the decision that chose it
executor.setReadTracking('full'); // data edges need the recorded reads; set both before run()
executor.attachCombinedRecorder(control);
await executor.run();

const { commitLog, executionTree } = executor.getSnapshot();
const writer = findLastWriter(commitLog, 'status');
const reads = keysReadFromExecutionTree(executionTree);
const chain = writer && causalChain(commitLog, writer.runtimeStageId, reads.lookup, { controlDeps: control.asLookup() });
if (chain) console.log(formatCausalChain(chain));

// Output:
// RejectExport (reject#2) [wrote: status]
//   CheckResolution (check-resolution#1) ← [control]
//     LoadImage (load-image#0) ← via width [wrote: width]
```

The rejecting stage reads nothing, so data edges alone would miss the decision. `controlDepRecorder()` supplies that edge. The chain shows the recorded path, not whether 1280 is the right rule.

## Anti-patterns

- **Don't walk the tree after a run.** Use a recorder during the run, or a `foottrace` query over the record.
- **Don't write a retry loop inside a stage.** The record shows one stage and hides the failed tries. Declare `.retry()` or use `scope.$call()`.
- **Don't leave an SDK retrying unseen.** Turn its retries off and run one loop under `scope.$call()`, or report each try with `scope.$attempt().observed()`.
- **Don't retry an outside effect without a key.** `build()` refuses `.touches()` plus a retry with no `idempotencyKey`. An unknown final effect fails the run with `UnknownEffectError`. Reconcile by the key, or use `.addRetryLoop()`.
- **Don't use `$getValue()` or `$setValue()` for keys you know.** Write `scope.amount = 1`. Those two are for dynamic keys.
- **Don't start a state key with `$`.** `scope.$break = 1` throws. `SCOPE_METHOD_NAMES` lists the reserved names.
- **Don't write a state key that is also an input key.** `run({ input })` keys are read-only for the run, and an `inputMapper`'s keys inside its subflow. The write throws.
- **Don't use `$getArgs()` for tracked data or `$getEnv()` for business data.** Both are frozen and untracked. Env is for signals, deadlines and trace IDs.
- **Don't edit a raw value in place.** What `$getValue()`, `$read()`, `$toRaw()`, `find()` or `for…of` hands back can be the committed object. Editing it changes past state with no row in the record. Assign a copy.
- **Don't store what `structuredClone` cannot copy.** A function or a foreign proxy fails the stage at commit, and none of that stage's writes land.
- **Don't expect a failed stage to roll back.** Its writes commit before `run()` rejects. `getSnapshot()` shows them.
- **Don't end a loop with `return`.** `.loopTo()` is unconditional, and after `.end()` every branch loops. Chain it on one decider branch, or exit with `scope.$break()`. With no exit the run rejects at `maxIterations`, default 1000.
- **Don't leave a decider without a way out.** An id that matches no branch throws unless `.setDefault()` names a fallback.
- **Don't read a parallel child's write as `scope.key`.** It lands under `runs/<childId>/`. Use `scope.$read('runs.<childId>.key')`, or make the child a subflow with an `outputMapper`.
- **Don't expect a subflow to see its parent.** With no `inputMapper` it starts empty. An inner `$break()` stops only the subflow unless the mount sets `propagateBreak: true`.
- **Don't return a whole array from `outputMapper`.** Arrays concatenate by default. Return the new items, or set `arrayMerge: ArrayMergeMode.Replace`.
- **Don't look for `.recorder()` on the executor.** It and `.redact()` are on the built chart. The executor has `enableNarrative()` and the `attach*Recorder()` methods.
- **Don't treat narrative entries as strings.** `getNarrativeEntries()` returns objects, and `[]` unless `enableNarrative()` ran before `run()`. Use `entry.text`.
- **Don't share an executor between concurrent runs.** A second `run()` rejects with `RunInFlightError`.
- **Don't do what cannot run twice before `interrupt()`.** Resume re-runs the stage from its top. A pause inside a lazy subflow or an `.addParallelForEach()` branch cannot resume.
- **Don't re-scrub in a recorder.** `setRedactionPolicy()` covers what the library keeps or serves, never live state or the checkpoint. `getSnapshot().sharedState` holds real values; `getSnapshot({ redact: true })` is the scrubbed copy.
- **Don't expect a policy to search text.** It selects by name and never reads a value's contents. With `keys: ['token']`, `$debug('token', scope.token)` is masked, but `$log('token=' + scope.token)` shows the secret in the emit event and the execution tree. Keep a selected value out of free text, and put a scalar you must log under a selected name
- **Don't read `threshold: '[REDACTED]'` as a value.** Under a policy a `decide()` or `select()` threshold can be a hole; `thresholdRedacted: true` says so, because the string can be a real threshold. `redacted` speaks only for the actual value. `matchError` and a `$break` reason can read as the placeholder too. A rule's `label` is author text, so never build one from a selected value
- **Don't reach for `footprintjs/advanced` in app code.** It holds engine internals. Of its names, ordinary charts usually need only `ArrayMergeMode`.
