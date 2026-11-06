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

{{import-map}}

## Find your task

Read the first path in the row and stop when you have your answer. For a signature or an option's meaning, read the JSDoc in `node_modules/footprintjs/dist/types/*.d.ts`.

Paths are in the repository, not the npm package, except those under `node_modules`. Open them at `https://github.com/footprintjs/footPrint/blob/main/<path>`.

{{tasks}}

## Three canonical snippets

Each is a real file in `ai-instructions/source/snippets/`. `npm run check:doc-snippets` compiles it. `npm run test:examples` runs it and compares its output with the `// Output:` lines.

### Decide, then explain

{{snippet:01-decide-and-explain}}

`decide()` records each rule's values and thresholds as evidence, on the narrative line and on `onDecision`. `select()` is its twin: every matching rule picks a branch, and the picked branches run in parallel.

### Retry, and record each try

{{snippet:02-retry-and-record}}

`knownMs` counts only what declares a timeout. `Check stock` declares none, so it adds 0 and `worstCaseMs` is `null`. `timeBudget()` names every stage it cannot bound.

### Follow a value back

{{snippet:03-follow-a-value-back}}

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
- **Don't expect a policy to search text.** It selects by name, never by content. With `keys: ['token']`, `$debug('token', scope.token)` is masked; `$log('token=' + scope.token)` is not. Keep selected values out of free text
- **Don't read `threshold: '[REDACTED]'` as a value.** Under a policy it can be a hole, and `thresholdRedacted: true` says so. `matchError` and a `$break` reason can be masked too. A rule's `label` is author text: never build one from a selected value
- **Don't reach for `footprintjs/advanced` in app code.** It holds engine internals. Of its names, ordinary charts usually need only `ArrayMergeMode`.

## Full guide

Before writing code, read `node_modules/footprintjs/AGENTS.md`. It has the task table ("add a retry: read this page") and three canonical snippets, and it matches the installed version.

## Which copy to trust

This skill is a copy and can lag. `node_modules/footprintjs/AGENTS.md` holds the same text for the installed version, so trust it over this file.

## Working on this library

Read `CLAUDE.md` for the module map and `CONTRIBUTING.md` for the workflow. Neither ships in the npm package. This file is generated: edit `ai-instructions/source/`, then run `npm run ai:generate`.

```bash
npm run build
npm test
npm run test:examples
npm run lint
npm run check:layering
npm run check:doc-snippets
npm run check:ai-instructions
```
