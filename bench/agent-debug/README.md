# agent-debug: does an agent fix a fault with fewer tokens when it has the map and the record?

A benchmark with a model in the loop. It is a small package of its own (its own `package.json` and lock) so that it runs on the PUBLISHED `footprintjs` and `foottrace`, the ones a user installs, and so that a model SDK never becomes a dependency of the engine.

**Why it exists.** The library's central claim is that a run recorded by the flowchart lets an agent find the cause of a wrong value without reading everything and without adding logs. Until a checked-in run with a real model shows it, that is a claim and not a result. `bench/fault-finding.ts` shows that the walk back contains the faulty step; it does not show that a model using it spends less.

**Read [RULE.md](RULE.md) first.** It says what is tested, what is counted and what decides the next step, and it was committed before the harness and before any model was called.

## State

RULE.md is at version 1.2 (12 November 2026): hidden fixtures judged by the harness, the controls as a smaller help, the three decision faults reported apart, the context at the end of a run as a second number, a system prompt that does not repeat the tool descriptions, and a smoke batch before the 90 runs. No model has been called.

Built: the program, the ten faults (each going wrong on at least one hidden order the agent never sees), the tools, the confined children, the parent-side judge, the harness, the report to version 1.2, the smoke flag, and a rehearsal with a scripted stand-in that passes.

Waiting: the smoke batch with the real model (three runs), then the 90 paid runs, both started by the owner with the key in the environment of that one command. Also waiting: a decision on how `why` shows the line loop's control edge ("under decision more-lines#4" on most lines), which may be a fault of the library.

What each folder holds:

- `program/`: the application under test, an order desk of 24 steps (one folder each), two business decisions and a loop decision made with `decide()`, a line loop, a tax sub-flowchart with mappers, a stock and credit fork. This folder, with one fault applied, is all an agent ever sees.
- `faults/`: one JSON file per planted fault; `apply.mjs` applies one; `measure.mjs` takes every number a fault file holds from real runs.
- `tools/`: one small module per tool the model may call; `tools/record/` is the back end of `map`, `step`, `why` and `story`, run in a child process.
- `harness/`: the loop (`agent.mjs`), the limits and prices (`budget.mjs`), the model port (`model.mjs`), the prompts (`prompt.mjs`), working folders (`workdir.mjs`), confined children (`child.mjs`, `runtime.mjs`), the judge (`score.mjs`), a batch (`batch.mjs`), the command line (`run.mjs`) and the report (`report.mjs`).
- `hidden/`: the judge's data: hidden orders and their expected results. Never copied into a working folder and never read by a child.

## Running it

Install once in this folder (it is its own package, with its own lock): `npm ci`.

- The tests: `npm test` (`node --test` over `test/`; about two minutes, most of it real child processes).
- The rehearsal, which spends nothing: `node harness/run.mjs --rehearse --out <folder>`. It runs all ten faults in all three set-ups, three times each, with a scripted model that knows the fault, and writes `order.json`, `runs.jsonl`, one transcript per run and `report.md` into `<folder>`.
- The smoke batch, before the paid one (RULE.md 1.2): `node harness/run.mjs --smoke --out <new folder>`. It runs the fault `wrong-key-read` once in each set-up, refuses `--faults`, `--repeats` and `--setups`, and titles its report as a smoke batch that is not part of the result.
- The paid batch: `node harness/run.mjs --out <new folder>`. The paid and smoke batches need `ANTHROPIC_API_KEY` in the environment of that one command, and only that variable: do not load a whole file of secrets into the harness's environment. Without the variable the command prints one sentence and exits 1. It never reads a file to find a key. Options: `--setups 1,2,3`, `--faults <id,id>`, `--repeats N`, `--seed N`. A batch started again on the same folder skips the runs it already has; a rerun to get a better number is a new folder (RULE.md, rule 2).
- A report from any folder: `node harness/report.mjs <folder>`.

### How model-edited code is confined

Every child process that runs the working copy (`run_order`, `run_tests`, the record probe behind `map`/`step`/`why`/`story`, the scoring run) and the `search` worker runs under Node's permission model (`--permission` on Node 24, `--experimental-permission` on older Node 22 lines), with an empty environment, no shell, a time limit and an output cap (`harness/child.mjs`):

- it may READ only its working copy and the runtime folder (the two published libraries, the import hook, the probe and the scoring child);
- it may WRITE only its working copy; the probe and the scoring run may write nothing;
- it may start no child process, no worker and no native addon;
- if the running Node has no permission model, the harness refuses to start the child. There is no unconfined fallback.

The runtime folder is made fresh for each process with `mkdtemp` (owner only, mode 0700), is never reused, is removed when the process exits, and no child may write to it (`harness/runtime.mjs`).

The judge cannot be fooled by the code it judges (`harness/score.mjs`): the scoring child only runs the hidden orders and prints one JSON document; the harness compares it with `hidden/expected.json`, which no child can read. Solved means exit code 0, output not cut, exactly one results document with exactly the expected names, every result equal to its expected value, and no file outside `src/` changed.

Not confined: the network. Node's permission model on these versions does not restrict sockets. With nothing readable outside the working copy and the published libraries, a confined child has nothing secret to send. `test/confinement.test.mjs` proves the rest with real child processes.

### Checks of the engine repository

This folder lives in the engine's repository but is not part of its build: `vitest` (root `test/**`, `src/**`) does not collect `bench/agent-debug/test/*.test.mjs`; `npm run lint` covers `{src,test}/**/*.ts`; `bench/tsconfig.json` (`**/*.ts`) finds no file here (there is none, and it skips `node_modules`); this folder's own `node_modules` is ignored by its `.gitignore`. A CI job for it would need Node 22.15 or later (for `module.registerHooks` and the permission model), `npm ci` in this folder, and `npm test`.
