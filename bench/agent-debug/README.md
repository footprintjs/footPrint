# agent-debug: does an agent fix a fault with fewer tokens when it has the map and the record?

A benchmark with a model in the loop. It is a small package of its own (its own `package.json` and lock) so that it runs on the PUBLISHED `footprintjs` and `foottrace`, the ones a user installs, and so that a model SDK never becomes a dependency of the engine.

**Why it exists.** The library's central claim is that a run recorded by the flowchart lets an agent find the cause of a wrong value without reading everything and without adding logs. Until a checked-in run with a real model shows it, that is a claim and not a result. `bench/fault-finding.ts` shows that the walk back contains the faulty step; it does not show that a model using it spends less.

**Read [RULE.md](RULE.md) first.** It says what is tested, what is counted and what decides the next step, and it was committed before the harness and before any model was called.

## State

RULE.md is at version 1.5 (12 November 2026). Version 1.2 brought hidden fixtures judged by the harness, the controls as a smaller help, the three decision faults reported apart, the context at the end of a run, a system prompt that does not repeat the tool descriptions, and a smoke batch. Version 1.3, after an independent reader tried to break the harness, adds: no file time singles out the faulty file; a stopped run is kept as `interrupted` and an API failure after 4 logged retries as `error`, both counted in the spend and left out of every number; no decision from an incomplete batch or a smoke batch; "go" must not hang on one fault or one run; logs left in a fix do not cost the score; `run_order` shows the result first. No model has been called.

Built: the program, the ten faults (each going wrong on at least one hidden order the agent never sees), the tools, the confined children, the parent-side judge, the harness, the report to version 1.3, the smoke flag, and a rehearsal with a scripted stand-in that passes.

Version 1.4 adds: the harness refuses to start without `--disable-sigusr1`; one batch per folder; the agent's code cannot make its own run `interrupted`; shares of finished runs, not counts; a 15% margin in every left-out row; copies made from `program/MANIFEST.json`. Version 1.5 writes down what the smoke batch must show; its report ends with that checklist.

This package pins footprintjs 12.1.0, the release with the fix of footPrint pull request 202 (RULE.md 1.3 needs 12.0.1 or later): a step after a loop is no longer recorded under one of the loop's own decisions, and a decision made by the default carries its `defaultLabel`, which `why` and `step` show as `default: "…"`. foottrace stays at 1.14.0.

Run on 12 November 2026: the smoke batch (three runs) and then the 90 paid runs, both inside the session sandbox with the key in the environment of that one command. The result by the rule is "Stop and look": the saving is not shown on this program. Both batches are kept under [batches/](batches/README.md); read [the result](batches/2026-11-12-batch-1/RESULT.md) before quoting any number.

## Part 2 (RULE-2.md): understanding questions, and the same program as ordinary code

[RULE-2.md](RULE-2.md) is the rule of part 2, written before it was built. Part 2 adds thirty understanding questions with closed answers (`questions/`), a fourth set-up `P` that runs an ordinary twin of the program (`twin/`, written blind from `twin/SPEC.md`), and its own command line and report. Part 1's command line (`harness/run.mjs`), its report and its kept batches are unchanged, except two fixes of part 1's harness named in batch 1's result: "named the faulty step" is no longer counted (a step id matched as a word anywhere in the `done` sentence, and the twin has no step ids; "edited the faulty file" stays), and the report reads RULE.md's version from RULE.md instead of typing it.

- A task is a fault (part 1's, unchanged) or a question. For a question the working folder is the unfaulted program, the task text is the question (`harness/prompt.mjs · questionText`), and the agent ends with `answer` (`tools/answer.mjs`) in place of `done`: one answer, its input schema the question's answer shape, no second try. A question is scored in the parent against `hidden/answers.json` (`harness/score-question.mjs`, `harness/shapes.mjs`).
- One system text for all four set-ups and both kinds of task (`harness/prompt.mjs · SYSTEM_PROMPT_2`). It drops part 1's "fixing a fault … written as a flowchart with the footprintjs library", which is false for a question and for the twin. A fault task in part 2 therefore differs from part 1's in that one sentence; its task text and tools are part 1's.
- Which program a set-up runs is one table, `harness/programs.mjs`; the working-folder copy, `run_order`, `run_tests`, the manifest check and the scoring child read the program root from it. Set-up P would be refused by name ("the twin is not built yet") if `twin/src` were missing, and every plan that includes it would fail at the start; the twin is in place, so it runs (`test/twin.test.mjs` shows the refusal still fires for a table whose twin has no `src/`). The record tools are marked `NEEDS_RECORD` and a set-up table that hands one to P does not load; the probe refuses a program without a record as a second wall.
- Every row carries `newTokens` and `resentTokens` (`harness/tokens.mjs`, the rule of part 1's second reader).
- `harness/plan2.mjs`: 30 questions and 10 faults, set-ups P, 1, 2, 3, 5 repeats (800 runs), one shuffled order with its seed; the smoke batch is one question of each kind and `wrong-key-read`, once per set-up (16 runs). The per-run limits, prices and the 15-dollar stop are part 1's (`harness/budget.mjs`); "No decision" past 20 unfinished runs (`harness/compare2.mjs`).
- `harness/report2.mjs` (with `harness/compare2.mjs`): claims A (3 against P), B (3 against 1) and C (1 against P) on the 30 questions, each kind of ten, the seven data-flow faults and the three controls, with the left-out rows, the decision as RULE-2.md words it, and the transcripts the reviewer reads.

Commands (from this folder, inside the session sandbox, like part 1's):

- Rehearsal, spends nothing: `node --disable-sigusr1 harness/run2.mjs --rehearse --out <folder>` (all four set-ups, every question and fault, 5 times; the scripts answer a question right, wrong or never, by its place in the list; a fault is solved). `--setups`, `--tasks` and `--repeats` narrow it.
- Smoke batch: `node --disable-sigusr1 harness/run2.mjs --smoke --out <new folder>`, with the key as for part 1.
- Paid batch: `node --disable-sigusr1 harness/run2.mjs --out <new folder>`.
- A report from any part 2 folder: `node harness/report2.mjs <folder>`.
- The expected answers: `node questions/generate.mjs` (writes `hidden/answers.json`), `--check` (compares).

### How the twin plugs in (set-up P)

The twin was written blind (`twin/BRIEF.md` is what its writer was given, `twin/SPEC.md` the prose it was written from). Nobody who has seen the flowchart program edits it: not one character of `twin/src/`, `twin/README.md` or `twin/test/visible.test.mjs`. Whatever did not fit was solved on the harness's side.

- **Its files are the writer's.** `twin-proof/frozen.mjs` checks every file against the hash list frozen when the writer stopped (`twin-proof/twin-manifest-as-built.txt`); `twin/fixtures/` equals `program/fixtures/` byte for byte; `twin-proof/compare-all.mjs` shows both command lines print the same bytes for all 31 orders (13 fixture files, 18 hidden-set orders). All three run in `npm test` (`test/twin.test.mjs`).
- **What a working folder holds:** `twin/MANIFEST.json` (written by `node harness/manifest.mjs --write P`) lists `src/**`, the thirteen fixtures, `README.md` and `twin/test/visible.test.mjs`, nothing else. `SPEC.md`, `BRIEF.md`, the writer's `package.json` and the manifest stay in `twin/` and are never copied; the twin's own tests and the expected results it was built against are in `twin-proof/`, outside every program root.
- **Its entry point is not F's.** F exports `async runOrder(order)` giving the nine keys; the twin exports `runOrder({ order })` giving every figure and `toResult(figures)` giving the nine keys, both synchronous. The one owner of each calling convention is `harness/scoring-child/result-of.mjs · RESULT_OF`, pointed at by `harness/programs.mjs` (`resultOf`) and imported by the confined scoring child, which is told the program's id. Why not run both through their command lines: the scoring child may start no process, and its result channel must not carry what the copy prints. Both command lines already print the same bytes, so `run_order` needed nothing.
- **The ten faults in the twin:** each `faults/<id>.json` has a `twin` block (one edit under the twin's `src/`, applied to a copy) and a `twinWhy` line. `test/twin-faults.test.mjs` proves, for each, that the faulted twin prints the faulted F's bytes on all 18 hidden orders, that the same eight visible tests pass, and that unfaulted the two are equal.
- **The thirty answers, proved against the twin:** `questions/observe-twin.mjs` builds the twin's view from what it computes and from four prints added to a temporary copy of its `src/`; `test/twin-answers.test.mjs` derives all thirty answers from it and compares them with `hidden/answers.json` (computed from F).
- **Leak walls for P:** `test/leak.test.mjs` (each faulted twin, every tool of set-up P) and `test/question-leak.test.mjs` (confined code in the twin's copy cannot read `hidden/`, the questions, `twin-proof/`, `SPEC.md` or `BRIEF.md`; no tool of P answers an expected answer the folder does not hold).
- Node built-ins only: a confined child may read only the working copy and the runtime folder.
- No file of the working folder other than the visible tests states a run or why answer (`test/questions.test.mjs`).

What each folder holds:

- `program/`: the application under test, an order desk of 24 steps (one folder each), two business decisions and a loop decision made with `decide()`, a line loop, a tax sub-flowchart with mappers, a stock and credit fork. This folder, with one fault applied, is all an agent ever sees.
- `faults/`: one JSON file per planted fault; `apply.mjs` applies one; `measure.mjs` takes every number a fault file holds from real runs.
- `tools/`: one small module per tool the model may call; `tools/record/` is the back end of `map`, `step`, `why` and `story`, run in a child process.
- `harness/`: the loop (`agent.mjs`), the limits and prices (`budget.mjs`), the model port (`model.mjs`), the prompts (`prompt.mjs`), working folders (`workdir.mjs`), confined children (`child.mjs`, `runtime.mjs`), the judge (`score.mjs`), a batch (`batch.mjs`), the command line (`run.mjs`) and the report (`report.mjs`).
- `hidden/`: the judge's data: hidden orders and their expected results, and part 2's expected answers. Never copied into a working folder and never read by a child.
- `questions/` (part 2): the thirty questions, their answer functions and the generator of `hidden/answers.json` (its README).
- `twin/` (part 2): the ordinary twin, set-up P's program, with the specification it is written from and its writer's brief.
- `twin-proof/` (part 2): what proves the twin and is never in a working folder: its own tests and expected results, the frozen hash list, `compare-all.mjs`, `paths-touched.py` and the line counter (its README).

## Running it

Install once in this folder (it is its own package, with its own lock): `npm ci`.

- The tests: `npm test` (`node --disable-sigusr1 --test` over `test/`; about a minute, most of it real child processes).
- The rehearsal, which spends nothing: `node --disable-sigusr1 harness/run.mjs --rehearse --out <folder>`. It runs all ten faults in all three set-ups, three times each, with a scripted model that knows the fault, and writes `order.json`, `runs.jsonl`, one transcript per run and `report.md` into `<folder>`.
- The smoke batch, before the paid one (RULE.md 1.2 and 1.5). From `bench/agent-debug`, inside the session sandbox, into a new empty folder OUTSIDE the repository (a folder inside it would count as an uncommitted change):

  ```
  env -u NODE_OPTIONS -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_LOG \
    ANTHROPIC_API_KEY=<set by the owner for this command only> \
    node --disable-sigusr1 harness/run.mjs --smoke --out <the new folder>
  ```

  The `-u` list drops a negated sigusr1 flag, a second credential, a redirected host and the SDK's debug log. It runs the fault `wrong-key-read` once in each set-up, refuses `--faults`, `--repeats` and `--setups`, and titles its report as a smoke batch that is not part of the result. The report ends with the smoke batch's pass (RULE.md 1.5), each line "yes" or "no" with its numbers (`harness/smoke-check.mjs`): usage numbers on every response, thinking included; no run at the output limit; every retry in its transcript; the commit, a clean tree and the installed footprintjs version in `order.json`; the spend equal to the transcripts' usage. A "no" does not change the exit code.
- The paid batch: `node --disable-sigusr1 harness/run.mjs --out <new folder>`, started inside the session sandbox (below). The paid and smoke batches need `ANTHROPIC_API_KEY` in the environment of that one command, and only that variable: do not load a whole file of secrets into the harness's environment. Without the variable the command prints one sentence and exits 1. It never reads a file to find a key. Options: `--setups 1,2,3`, `--faults <id,id>`, `--repeats N`, `--seed N`. A batch started again on the same folder skips the runs it already has; a rerun to get a better number is a new folder (RULE.md, rule 2).
- A report from any folder: `node harness/report.mjs <folder>`.

### How model-edited code is confined

Every child process that runs the working copy (`run_order`, `run_tests`, the record probe behind `map`/`step`/`why`/`story`, the scoring run) and the `search` worker runs under Node's permission model (`--permission` on Node 24, `--experimental-permission` on older Node 22 lines), with an empty environment, no shell, a time limit and an output cap (`harness/child.mjs`):

- it may READ only its working copy and the runtime folder (the two published libraries, the import hook, the probe and the scoring child);
- it may WRITE only its working copy; the probe and the scoring run may write nothing;
- it may start no child process, no worker and no native addon;
- if the running Node has no permission model, the harness refuses to start the child. There is no unconfined fallback.

- `process.kill`, `process._kill` and `process._debugProcess` (which sends SIGUSR1) refuse in every confined child (`harness/deps/guard.mjs`, loaded before the copy's code); `process.binding`, `process._linkedBinding` and native addons are already refused by the permission model. This is a speed bump: Node's permission model does not stop a process from signalling another, and code that finds another way to send a signal is not stopped by it.

The runtime folder is made fresh for each process with `mkdtemp` (owner only, mode 0700), is never reused, and no child may write to it (`harness/runtime.mjs`).

### Start the paid batch inside a sandbox

Every batch, rehearsed or paid, is started as `node --disable-sigusr1 harness/run.mjs …`; without the flag `run.mjs` refuses (exit 2). On POSIX, SIGUSR1 makes a Node process open its debugger on 127.0.0.1:9229, and the harness holds the API key; with the flag the signal is ignored (measured in `test/signals.test.mjs`). Node has no API that reports the flag back, so `harness/sigusr1.mjs` reads it from `process.execArgv` and `NODE_OPTIONS`.

The paid and smoke batches must be started inside the working session's sandbox (RULE.md, rule 8), and that sandbox must refuse listening on a local port (do not set `allowLocalBinding`). The wall against signals is the sandbox, not Node: inside it a signal to a process outside the sandbox is refused, so the most the agent's code can stop is the batch itself. If it does, the run is kept as `interrupted` with its tokens, and the batch started again on the same folder never reruns it (rule 2).

### Temporary folders

Every temporary folder of a harness process (working copies, scoring copies, staging copies, the runtime folder) lives in one session folder, `<tmp>/agent-debug-session-<pid>-XXXXXX`, next to an `owner.json` naming the process (`harness/temp.mjs`). It is removed when the process ends, fails, or is stopped by SIGINT, SIGTERM or SIGHUP. A SIGKILL cannot be caught: then the session folder stays behind, and the next harness process sweeps it. The sweep removes a session folder only when its `owner.json` names a process that is gone (`process.kill(pid, 0)` answers ESRCH) AND the folder and its owner's start are older than the sweeping process's own start. Any other answer counts as alive: in the session sandbox every live process outside it, the user's own included, answers EPERM (measured over pids 1 to 99,999), so a batch in another sandbox is never swept. A folder without `owner.json` (such as folders left by versions before 1.3, named `agent-debug-run-*` or `agent-debug-runtime-*`) is never touched; those can be removed by hand.

### Known limits

- Taking over a dead lock is a race: with a stale `lock.json` and two starts in the same instant, both could hold the folder (the reader's R3-2; not hit in five tries).
- Writing and memory inside a confined child are bounded only by its time limit: about 20 s of writing per `run_order` call, and no memory cap (R3-4; not tested, it would fill this machine).

### One batch per folder

A batch folder holds one batch. `lock.json` (created exclusively) names the process running it: a second start on that folder refuses and names that process; a lock whose owner is gone is taken over, and the takeover is written to `lock.jsonl`. A start with other flags than the folder's `order.json` (label, seed, set-ups, faults, repeats) is refused. `order.json` records the commit and whether this folder had uncommitted changes. The report gives a decision only when the rows are exactly the plan.

The judge cannot be fooled by the code it judges (`harness/score.mjs`): the scoring child silences the copy's printing, runs the hidden orders and writes one JSON document to its result channel (fd 3); the harness compares it with `hidden/expected.json`, which no child can read. Solved means exit code 0, the result channel not cut, exactly one results document with exactly the expected names, every result equal to its expected value, and no file outside `src/` changed. Logs left in a correct fix do not matter.

Not confined: the network. Node's permission model on these versions does not restrict sockets. With nothing readable outside the working copy and the published libraries, a confined child has nothing secret to send. `test/confinement.test.mjs` proves the rest with real child processes.

### Checks of the engine repository

This folder lives in the engine's repository but is not part of its build: `vitest` (root `test/**`, `src/**`) does not collect `bench/agent-debug/test/*.test.mjs`; `npm run lint` covers `{src,test}/**/*.ts`; `bench/tsconfig.json` (`**/*.ts`) finds no file here (there is none, and it skips `node_modules`); this folder's own `node_modules` is ignored by its `.gitignore`. A CI job for it would need Node 22.15 or later (for `module.registerHooks` and the permission model), `npm ci` in this folder, and `npm test`.
