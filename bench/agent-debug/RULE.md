# The rule of this benchmark (written before any paid run)

Version 1, 12 November 2026. This file is committed before the harness exists and before any model is called, so that the result cannot shape the test. A change after results are seen is a new version with a new run, and the old results stay in the folder.

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

Every tool answer is bounded in size and says when it was cut. The tool descriptions are part of every request and count as tokens. There is no fourth set-up with the same program as ordinary code yet; that is the next version, because it needs a twin program.

## The program and the faults

One program in the flowchart pattern, 18 to 24 steps, each step in its own file, the chart file holding only the wiring. It has at least: two decisions, one loop, one sub-flowchart with mappers, one parallel fork. It has fixtures, visible tests the agent may run, and hidden tests it cannot see.

Ten faults, each one small edit applied by a script to a fresh copy, each making at least one hidden test fail and no visible test fail:

| Class | Count | What it is |
|---|---|---|
| Data flow and decisions | 7 | a wrong key read, a missing write, a wrong default branch, a wrong rule, a wrong mapper key across the sub-flowchart, a swapped key in a parallel branch, a loop that stops one early |
| Inside one step (controls) | 3 | a wrong constant in a formula, rounding at the wrong place, a wrong threshold in an `if` inside a step's function |

Each fault records how many steps lie between the faulty step and the first wrong value an agent is shown (its distance). The seven are spread over distances of 0 to 1, 2 to 4, and 5 or more, and include the sub-flowchart, the fork and the loop.

The three controls are faults the record should not help with. If set-up 3 does clearly better on them, the harness is leaking the answer and the run is void.

The list of the ten concrete faults (file, edit, class, distance, the hidden test that fails) is added to this file as version 1.1 before the first paid run.

## The task the agent gets

The same words in every set-up:

> Order fixture `<name>` gives `<key> = <actual>`. It should be `<expected>`. Find the cause and fix it. You may edit files under `src/` only. When you are done, call `done` with one sentence naming the step you changed.

The agent's working folder holds the program's `src/`, its fixtures and the visible tests. It does not hold the hidden tests, the fault list, this file or the harness.

## The model and the budget

- Model: Claude Haiku 5.5, `claude-haiku-5-5`, with the model's default thinking and effort. No sampling parameter is set. No prompt caching, so that tokens are counted the same way in every set-up.
- One run ends when the agent calls `done`, after 30 model requests, when a request would send more than 90,000 input tokens, or when the run has used 400,000 input tokens in total. A run that ends without `done` is unsolved.
- Each fault is run 3 times in each set-up: 10 × 3 × 3 = 90 runs.
- Prices used for the spend estimate (read 12 Nov 2026): 0.10 dollars per million input tokens and 0.50 per million output tokens, for requests up to 100,000 input tokens. The harness adds up `usage.input_tokens` and `usage.output_tokens` from every response and stops before a run when the estimate has reached 15 dollars.

## What is counted

For every run, from the API's own `usage` fields and the harness's log:

- solved or not: every hidden test passes on the agent's edited copy, and no file outside `src/` changed;
- input tokens, output tokens, model requests;
- tool calls by name; bytes returned by `read_file`; number of `run_order` and `run_tests` calls; number of edits;
- whether the step the agent named, and the file it edited, are the faulty one;
- wall time.

The headline number is **tokens per solved task** (all tokens of all runs of a set-up, solved or not, divided by the number of solved runs), reported for the seven data-flow faults and for the three controls separately. Mean tokens per run alone is not reported as a headline: an agent that gives up early looks cheap.

## What decides the next step

Written now, read after the run:

- **Go on to the full study** (more programs, one not written by us, the ordinary-code twin, more runs) if, on the seven data-flow faults, set-up 3 solves at least as many runs as set-up 1 and uses at least 25% fewer tokens per solved task, and shows no advantage on the three controls beyond one run.
- **Stop and look** if set-up 3 solves fewer, or is not cheaper: read the transcripts and say why before building anything else.
- **Void** if set-up 3 is clearly better on the controls, or a transcript shows a tool handing over the answer.
- Set-up 2 against set-up 1 is reported the same way and decides nothing by itself.

## Rules that keep it honest

1. This file is committed before the harness. The fault list is committed before the first paid run.
2. Every paid run is kept: the full transcript, the tool calls, the usage numbers. Nothing is deleted or rerun to get a better number; a rerun is a new, named batch.
3. The report is generated from the run files by a script. No number is typed by hand.
4. A rehearsal with a scripted stand-in for the model must pass before any paid run, and spends nothing.
5. The baseline is given a fair chance: it can read, search, run, add logs and run tests. If a reviewer can show the baseline is hobbled, the batch is void.
6. The instructions that teach the model the tools count as tokens.
