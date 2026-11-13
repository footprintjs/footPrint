# The rule of part 2: understanding, and the same program as ordinary code (written before any paid run)

Part 1 (`RULE.md`, batch 1) asked one narrow question and got a plain answer: on this small program the record tools did not cut the tokens an agent needs to fix a planted fault (`batches/2026-11-12-batch-1/RESULT.md`). Two things were missing from that question, and the person who owns the claim named both:

1. **Fixing a fault is not the only work.** Understanding a program, and understanding what one run of it did, is work too, and it is the work a map and a run record are made for. Every fault of part 1 contradicted a comment beside it, so no agent ever needed to know what a run did.
2. **The comparison that matters to someone choosing how to build is not "the flowchart program with and without its tools". It is "the same program built the ordinary way, against the program built as a flowchart with its tools".** Part 1's baseline already had the flowchart program, whose wiring file reads like a map.

Part 2 tests both. It changes nothing in part 1 and reuses its harness, its model, its way of paying and its rules of honesty.

## The claims under test

- **A (the pattern with its tools against ordinary code):** an agent answers questions about a program, answers questions about one run of it, and fixes a planted fault, at least as correctly and with fewer tokens, when the program is built as a footprintjs flowchart and the agent has the map and the run record, than when the same program is ordinary code.
- **B (the tools on the pattern):** the same comparison between the flowchart program with the map and record tools and the flowchart program without them, now on understanding as well as on faults.
- **C (the pattern alone):** the flowchart program without its tools against ordinary code. Reported; it decides nothing by itself.

## The two programs

- **F, the flowchart program:** `program/`, unchanged from part 1.
- **P, the ordinary twin:** `twin/`. The same order desk with the same behaviour: for every fixture, visible and hidden, `run-order` prints the same result, byte for byte. It is written so that it cannot lean toward either answer:
  - A first writer turns F into a specification in prose (`twin/SPEC.md`): the business rules and the data tables, in the order a person would explain them, with no word about steps, stages, charts, branches as nodes, or files.
  - A second writer builds P from that specification, the data tables, the visible fixtures and their expected results, and nothing else. It never sees F's source, the faults, the questions, this file or `RULE.md`. It is told to write ordinary, maintained Node.js: modules and functions, `if` and loops, a doc comment on each exported function saying what it is for, the same test runner, no flowchart library.
  - A reader who built neither checks, before any paid run, that P is a fair ordinary program (not obfuscated, not flowchart-shaped, commented about as much as F: the count of comment lines per code line is reported for both) and that it equals F on all fixtures.
- **Both working folders hold the same kinds of thing and nothing more:** the program's `src/`, the fixtures, a short README that says what the program does, where things are and how to run it, and the same eight visible tests (part 1's, restated by the twin's writer against the twin's own entry point). Nothing in either folder states an expected result beyond those eight tests. The twin's own unit tests of its rules, and the expected results it was built against, are kept outside the working folder, exactly as F's hidden tests are: a test that pins every rule would name a planted fault at once, in one program only. (Added before the twin was integrated and before any paid run.)

## The four set-ups

| Set-up | Program | Tools |
|---|---|---|
| P. Ordinary code | P | `list_files`, `read_file`, `search`, `run_order`, `run_tests`, `edit_file`, and `answer` or `done` |
| 1. Flowchart code | F | the same |
| 2. Plus the map | F | set-up 1 and `map` |
| 3. Plus the record | F | set-up 2 and `step`, `why`, `story` |

The tools are part 1's, unchanged, so that part 2 can be read beside part 1. `run_order` returns what the program printed, in P as in F: an agent may add prints to either program and read them. What part 1 showed about the tools' own cost (their definitions on every request, no code path in their answers) is not corrected here; a changed tool set is a later, separate comparison.

## The tasks

**U. Thirty understanding questions,** each with a closed answer that is scored by exact comparison, so no judge is needed:

- **10 about the program** (no run named): what it does and in what order, in the program's business words. Example: "Which two conditions make shipping free?" with the answer chosen from a list the question gives.
- **10 about what one run did:** a named fixture and a value that run computed. Example: "For order fixture `clinic-monitors`, what tax rate was used?" Answer: a number.
- **10 about why one run ended as it did:** a named fixture and the reason for an outcome. Example: "Fixture `cafe-chairs` was rejected. Which check stopped it, and by how much is the order over the customer's credit limit?" Answer: one word from a list, and a number.

Rules for the questions:
- Every question is asked in business words that are true of both programs. No question names a step, a stage, a file or a function.
- Every answer has a fixed shape (a number, one or more words from a list printed in the question, yes or no), given through the `answer` tool. Numbers are compared exactly after rounding to the cent; lists as sets unless the question says "in order".
- The expected answers are computed by a script from F's real run records and F's chart, never typed by hand, and the same script proves each of them against P by running P with prints. A question whose answer cannot be established in P that way is not asked.
- The questions, their answer shapes and their expected answers are committed before the first paid run and not changed after it. Expected answers live with the hidden data: no tool can read them.
- Every run question names a fixture that is in the agent's working folder. Nothing about it is hidden except the expected answer.

**B. The ten faults of part 1,** each planted as the same logical fault in both programs: the same business rule broken in the same way, giving the same wrong results on the same fixtures. The reader checks each pair before any paid run. Scoring is part 1's: the edited copy gives the expected result for every hidden fixture.

The task text is the same in every set-up. For a question it is the question; the agent ends by calling `answer`. A wrong answer is wrong: there is no second try.

## The model and the budget

`claude-haiku-5-5`, no caching, the limits of part 1 (8,000 output tokens per request, 30 requests, 90,000 tokens per request, 400,000 per run). Each task is run 5 times in each set-up, in one shuffled order whose seed is written first: (30 questions + 10 faults) x 4 set-ups x 5 = 800 runs. The harness stops before a run when the estimated spend has reached 15 dollars. A smoke batch comes first (one question of each kind and one fault, once in each set-up: 16 runs) and must show what part 1's smoke batch had to show.

## What is counted

As in part 1: correct or not; input and output tokens; requests; tool calls by name; the context at the end. Two numbers are reported for every comparison: **tokens per correct answer** (all tokens of all runs, right or wrong, divided by the number of right ones) and, beside it, the **new tokens and the re-sent tokens** of each run (what any caching price would weigh). The first decides; the second decides nothing.

## What decides

Written now, read after the run. Each comparison is made separately on the 30 questions and on the seven data-flow faults; the three kinds of question are also reported apart.

- **Claim A holds on a task group** if set-up 3 is right at least as often as set-up P and uses at least 25% fewer tokens per correct answer, and still at least 15% fewer when any one task of the group is left out and when each set-up's most expensive run is left out.
- **Claim B holds on a task group** by the same test between set-up 3 and set-up 1.
- **Go on** (a larger program of our own, then a program we did not write, ported to the pattern) if claim A holds on the questions. The faults are reported and do not block.
- **Stop and look** if claim A does not hold on the questions: read the transcripts and say why before anything else is built or run.
- **No decision** if the rows are not exactly the planned runs, or more than 20 of the 800 ended as `error` or `interrupted`.
- **Void** if a tool answer hands over an expected answer from the hidden data, if a question turns out not to be answerable from what set-up P is given, or if the reader shows that P or a fault pair is unfair. After the run a reviewer reads, for each kind of question, the transcripts of the three cheapest correct runs of set-up 3 and of the three most expensive runs of set-up P.

Whatever the result, it is a result about this one small program, this model and this way of paying. Three things are named now so that nobody is surprised later: the program is small, so reading all of it is cheap for every set-up; both programs were written by people who make the library, one of them blind; and a record tool that prints a run's values answers a "what did this run do" question almost by definition, which is the mechanism under test and is exactly why the questions are reported by kind.

## Rules that keep it honest

All eight rules of `RULE.md` apply. In addition:

9. The twin is written blind, as described above, and the specification it is written from is kept in the repository.
10. The fairness reading (the twin, the questions, the fault pairs) is done by a reader who built none of them, before any paid run, and its report is kept with the batch.
11. A question or an expected answer is never changed after a paid run has seen it. A wrong expected answer found later voids that question in every set-up, and the report says so.

## Decided while building, before any paid run

Each of these settles something the text above left open. Where there was a choice, the stricter reading or the one against the claim was taken.

- **The left-out rows of a claim test** (one task left out; each set-up's most expensive run left out) must also be "right at least as often", not only 15% cheaper.
- **Rates are asked in percent.** Rounding to the cent cannot score a rate written as a fraction (0.0725 would become 0.07).
- **Where the expected answers come from:** the flowchart program's run records, and runs of extra orders made for one question (for example the same order with a coupon added). The chart is not read for them.
- **The system text is one sentence that is true of every run:** "You are working on a small Node.js program: an order desk. Your working folder holds the program's src/ folder, its fixtures and its visible tests. You can act only through the tools you are given; you cannot run other commands." Part 1's also said the program was a footprintjs flowchart. That is false for the twin, so it is gone for every set-up, which takes a hint away from set-ups 1 to 3.
- **The fault task text is part 1's, word for word,** so the faults can be read beside part 1. Its last sentence asks for "one sentence naming the step you changed"; that sentence is kept in every row and is not scored. The report's column "named the faulty step" is dropped: matching a step's name as a word could not tell naming from mentioning, and the twin has no step names.
- **What the twin's writer was shown.** The brief (kept as `twin/BRIEF.md`) and the kit. Its session also carried, as every session of this project does, the library's own project notes and a one-line-per-topic index of working notes. Those mention the flowchart library and the team's habits (small files, plain names). The index also named, in one line each, that a benchmark was planned, that the owner's claim about walking back through a run record is his main goal, and his rule to build every feature as a footprintjs flowchart because the run record serves as the model's debug log: so the writer could have guessed which side the makers hope wins. They say nothing about the order desk, about a flowchart version of it, or about faults or questions. The writer received three messages: the brief; a request for a README of its own, the eight visible tests and the tables under `src/`; and a request to make its comments and README stand alone, because they pointed at the specification, which a working folder does not hold (that last pass changed comment lines and one README line only: with the comments removed, every source file is the same before and after). All 64 of the writer's tool calls stayed inside its folder (checked from its record by `twin-proof/paths-touched.py`). This is as blind as a writer inside this project can be; the test on a program we did not write removes the rest of the doubt.

## Changed after the fairness reading, before any paid run

The independent reader's verdict on the first reading was "fair after fixes" (its report is kept with the batch). What changed because of it:

- **"Right at least as often" is counted over the PLANNED runs.** A run that ended in an error or was interrupted is a run that was not right. The first build compared shares of finished runs, and the reader built a case where that printed "Go on" although set-up 3 had fewer right answers. Unfinished runs are also more likely to be the long ones.
- **One tool text changed.** The tools are part 1's, except that `read_file`'s description gave `src/chart.mjs` as its example: a file only the flowchart program has, and its map in all but name. The example is now a file both programs have.
- **One question was reworded** before any model saw it, because one of its options could be read as true for two customers (`program-rejection-checks`).
- **The faults are also reported without three pairs.** The reader judged the planted fault easier to SEE in the twin for `loop-stops-early`, `missing-write` and `wrong-default-branch` (the edits that give the same results as the flowchart program's fault are odd-looking there). The plants stay, because both programs print the same bytes with them on every order tried; the report gives each comparison on the data-flow faults with these three and without them. Its per-pair table is kept with the batch.
- **What the reader found and nothing can change now,** so the report states it beside the result: the twin carries more comments than the flowchart program (1.37 against 0.92 comment lines per code line; 2.00 against 0.88 comment words per code token), which helps the twin; the questions share more phrases with the twin's comments than with the flowchart program's, which helps the twin's search; the specification passed on the names of the figures the flowchart program keeps, so the twin computes them too; seven of the twenty questions about a run ask for a value the flowchart program keeps under a name, which helps the record tools.
- **What claim A can and cannot show.** Set-up 3 against set-up P changes two things at once: the program and three more tools. If claim A holds, it supports "this flowchart program with its tools against this twin". It does not show that the record alone saves tokens: claims B and C are printed beside it to tell the two apart, and the report says so in its first lines.

