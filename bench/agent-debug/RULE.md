# The rule of this benchmark (written before any paid run)

Version 1.2, 12 November 2026. Version 1 was committed the same day, before the harness existed and before any model was called, so that the result cannot shape the test. Version 1.1 added the list of the ten faults. Version 1.2 changes six things after the rehearsal (which calls no model) and before any paid run; each change and its reason is at the end of this file. A change after results are seen is a new version with a new run, and the old results stay in the folder.

## The claim under test

> An agent that fixes a fault in a program written as a footprintjs flowchart needs fewer tokens when it is given the program's map and the run's record than when it has only the code, a way to run it, and logs.

This pilot cannot prove or refute that claim. It has one small program, ten planted faults and three runs of each, and the program was written by the people who make the library. It answers two smaller questions:

1. Does the harness measure what we mean? (No leaked answers, a competent baseline, numbers that add up.)
2. Which way does a first measurement point, and where does the record not help?

Nothing measured here may be quoted as "footprintjs saves N% tokens". The sentence a result supports is written in the report, next to its numbers.

## The three set-ups

The same task, the same model, the same budget. Only the tools differ.

| Set-up | Tools |
|---|---|
| 1. Code and logs | `list_files`, `read_file`, `search`, `run_order`, `run_tests`, `edit_file`, `done` |
| 2. Plus the map | set-up 1 and `map` |
| 3. Plus the record | set-up 2 and `step`, `why`, `story` |

- `run_order(fixture)` runs the program on a fixture and returns the final result and whatever the program printed (so an agent can add `console.log` and read it: that is "logs").
- `map(address?)` returns the chart one level deep: each step's id, kind and one-line purpose; a sub-flowchart is one collapsed line until its address is asked for.
- `step(address)` returns where a step's code is, what it read and wrote in a named fixture's run, and for a decision its rule labels.
- `why(fixture, key)` returns the chain of steps behind the key's final value, with the values read and written (summaries, bounded).
- `story(fixture, address?)` returns the run told step by step (bounded).

Every tool answer is bounded in size and says when it was cut. The tool descriptions are sent once with every request, as the tool definitions, and count as tokens; the system prompt does not repeat them. There is no fourth set-up with the same program as ordinary code yet; that is the next version, because it needs a twin program.

## The program and the faults

One program in the flowchart pattern, 18 to 24 steps, each step in its own file, the chart file holding only the wiring. It has at least: two decisions, one loop, one sub-flowchart with mappers, one parallel fork. It has fixtures, visible tests the agent may run, and hidden order fixtures it cannot see. The harness runs the agent's edited copy on the hidden fixtures and compares the results itself with expected values that no process running the agent's code can read.

Ten faults, each one small edit applied by a script to a fresh copy. Each makes at least one hidden fixture that the agent never sees give a wrong result, and makes no visible test fail:

| Class | Count | What it is |
|---|---|---|
| Data flow and decisions | 7 | a wrong key read, a missing write, a wrong default branch, a wrong rule, a wrong mapper key across the sub-flowchart, a swapped key in a parallel branch, a loop that stops one early |
| Inside one step (controls) | 3 | a wrong constant in a formula, rounding at the wrong place, a wrong threshold in an `if` inside a step's function |

Each fault records how many steps lie between the faulty step and the first wrong value an agent is shown (its distance). The seven are spread over distances of 0 to 1, 2 to 4, and 5 or more, and include the sub-flowchart, the fork and the loop.

The three controls are faults whose cause the record cannot show, because it lies inside one step's function: the record holds the step's inputs and outputs, not its arithmetic. The record can still shorten the search, because `why` names the step that wrote the wrong value. So the controls measure a smaller help, not none.

Three of the seven data-flow faults sit in a decision (a wrong rule, a wrong default branch, the loop's stop rule). For those the record prints the rule's operands and which rule matched, which is close to showing the cause. That is the mechanism under test and not a leak, but it is the record's easiest case. The report therefore gives the three decision faults and the other four apart as well as together.

The list of the ten concrete faults (class, kind, distance, step) is added to this file as version 1.1 before the first paid run.

## The task the agent gets

The same words in every set-up:

> Order fixture `<name>` gives `<key> = <actual>`. It should be `<expected>`. Find the cause and fix it. You may edit files under `src/` only. When you are done, call `done` with one sentence naming the step you changed.

The agent's working folder holds the program's `src/`, its fixtures and the visible tests. It does not hold the hidden fixtures, the expected results, the fault list, this file or the harness.

## The model and the budget

- Model: Claude Haiku 5.5, `claude-haiku-5-5`, with the model's default thinking and effort, and at most 8,000 output tokens per response. No sampling parameter is set. No prompt caching, so that tokens are counted the same way in every set-up.
- One run ends when the agent calls `done`, after 30 model requests, when a request would send more than 90,000 input tokens, when the run has used 400,000 input tokens in total, or when a response is cut at the output limit, is refused, or fails. A run that ends without `done` is unsolved, and its tokens still count.
- Each fault is run 3 times in each set-up: 10 × 3 × 3 = 90 runs, in one shuffled order whose seed is written into the batch folder before the first run, so that no set-up runs at a different hour than another.
- Before the 90 runs, a smoke batch of 3 runs (the fault `wrong-key-read`, once in each set-up) checks the connection to the real model: the usage numbers, the limits, the handling of errors. It has its own folder, it is kept, and it is not part of the result. If it leads to a change in the harness, the change is committed and the smoke batch is run again, in a new folder, before the 90.
- Prices used for the spend estimate (read 12 Nov 2026): 0.10 dollars per million input tokens and 0.50 per million output tokens, for requests up to 100,000 input tokens. The harness adds up `usage.input_tokens` and `usage.output_tokens` from every response and stops before a run when the estimate has reached 15 dollars.

## What is counted

For every run, from the API's own `usage` fields and the harness's log:

- solved or not: the agent's edited copy gives the expected result for every hidden fixture, and no file outside `src/` changed;
- input tokens, output tokens, model requests; the context at the end of the run (the last request's input tokens plus its output tokens);
- tool calls by name; bytes returned by `read_file`; number of `run_order` and `run_tests` calls; number of edits;
- whether the step the agent named, and the file it edited, are the faulty one;
- wall time.

The headline number is **tokens per solved task** (all tokens of all runs of a set-up, solved or not, divided by the number of solved runs), reported for the seven data-flow faults and for the three controls separately, and for every fault by itself. Mean tokens per run alone is not reported as a headline: an agent that gives up early looks cheap.

A second number stands beside it and decides nothing: the **context at the end of a run**. The headline adds up every request, and with caching off each request pays for the whole conversation again. An agent in real use caches the conversation, and its cost then follows the size of the final context more than that sum. The two numbers together show both ways of paying.

## What decides the next step

Written now, read after the run:

- **Go on to the full study** (more programs, one not written by us, the ordinary-code twin, more runs) if, on the seven data-flow faults, set-up 3 solves at least as many runs as set-up 1 and uses at least 25% fewer tokens per solved task. If that holds only because of the three decision faults (on the other four, set-up 3 is not cheaper than set-up 1), the report says so in its first lines, and the full study must use programs whose faults lie mostly outside decisions.
- **Stop and look** if set-up 3 solves fewer, or is not cheaper: read the transcripts and say why before building anything else.
- **Void** if a transcript shows a tool answer handing over the answer: the text of the fix, the fault's id or description, an expected value the task did not give, or the content of a hidden fixture. The leak tests check every tool for this before the run. After the run a reviewer reads every solved set-up 3 transcript of the three controls and of the three decision faults.
- Set-up 2 against set-up 1 is reported the same way and decides nothing by itself.

## Rules that keep it honest

1. This file is committed before the harness. The fault list is committed before the first paid run.
2. Every paid run is kept: the full transcript, the tool calls, the usage numbers. Nothing is deleted or rerun to get a better number; a rerun is a new, named batch.
3. The report is generated from the run files by a script. No number is typed by hand.
4. A rehearsal with a scripted stand-in for the model must pass before any paid run, and spends nothing. The smoke batch comes after it and before the 90 runs.
5. The baseline is given a fair chance: it can read, search, run, add logs and run tests. If a reviewer can show the baseline is hobbled, the batch is void.
6. The instructions that teach the model the tools count as tokens.
7. The key for a paid run is one environment variable of the harness process. No process that runs the agent's code can read the environment, a key file, the hidden folder or the harness.

## Version 1.1: the ten faults

Added before the first paid run. Each fault is one edit in `faults/<id>.json`, applied by `faults/apply.mjs` to a fresh copy; the edit itself is not repeated here. Distance is measured by `faults/measure.mjs` on the faulty run: the fewest steps on the walk back from the step that wrote the symptom key to the faulty step, following data reads and the decision that chose a branch (0: the faulty step wrote the key itself).

| Id | Class | Kind | Distance | Step |
|---|---|---|---|---|
| wrong-key-read | data-flow | a wrong key read | 0 | grand-total |
| wrong-rule | data-flow | a wrong rule | 1 | approval |
| missing-write | data-flow | a missing write | 2 | combine-checks |
| wrong-default-branch | data-flow | a wrong default branch | 2 | shipping-rule |
| swapped-key-in-fork | data-flow | a swapped key in a parallel branch | 3 | check-credit |
| wrong-mapper-key | data-flow | a wrong mapper key across the sub-flowchart | 5 | tax |
| loop-stops-early | data-flow | a loop that stops one early | 6 | more-lines |
| wrong-constant | inside-step | a wrong constant in a formula | 1 | standard-shipping |
| rounding-misplaced | inside-step | rounding at the wrong place | 2 | price-line |
| wrong-threshold | inside-step | a wrong threshold in an if inside a step | 2 | loyalty-discount |

## Version 1.2: what changed and why

Written after the rehearsal, which calls no model, and before any paid run.

1. **Hidden tests became hidden fixtures that the harness judges.** A security review of the first harness showed that a test file run inside the agent's edited code could be made to report a pass. Now the edited code only computes results; the harness compares them. Every fault must also go wrong on at least one fixture the agent never sees, so that a patch written for the one named fixture is not scored as solved.
2. **The controls are no longer "the record cannot help".** The rehearsal's real tool answers showed that `why` names the faulty step for an inside-step fault too. A small advantage on the controls is expected and is not a leak by itself. The void rule now says what a leak is.
3. **The three decision faults are also reported apart.** For them the record prints the rule's operands, which is nearly the cause. That is what the record is for, and it is its easiest case. A reader must be able to see the result without it.
4. **A second number, the context at the end of a run.** The headline is how an agent without caching pays. Agents in real use cache.
5. **The system prompt no longer repeats the tool descriptions.** The tool definitions already send them. In the first harness the larger tool sets paid for them twice on every request.
6. **A smoke batch of three runs comes first,** because the adapter to the real model had never been called. The output limit per response and what a cut response does are now written down.

