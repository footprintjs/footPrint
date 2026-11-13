# questions: the thirty understanding questions of part 2

RULE-2.md, "The tasks": ten questions about the program, ten about what one run did, ten about why one run ended as it did. Each has a closed answer, scored by exact comparison (`../harness/shapes.mjs`), so no judge is needed.

**Why the answers are computed:** a typed answer can be wrong without anyone noticing. Each question carries an answer function (`derive`) that runs the flowchart program (F, `../program/`) on the question's fixture, or on probe orders that differ in one thing, and reads the answer from the run's record. `generate.mjs` writes them to `../hidden/answers.json`; `../test/questions.test.mjs` computes them again and must get the same file.

| File | Job |
|---|---|
| `program.mjs`, `run.mjs`, `why.mjs` | the questions of each kind: id, text, fixture, answer shape, the rules it asks about, whether the answer is a value the printed result does not show (`intermediate`), how an agent with only code and prints establishes it (`howWithPrints`, and `howWithPrintsTwin` where the twin's way differs: in the twin the order is read in `twin/src/cli.mjs`, not in the run script), and the answer function |
| `observe.mjs` | runs F and turns its record into a view in business words; the ONE place F's key names meet the questions' words |
| `observe-twin.mjs` | the same view of the twin, from the figures it computes and four prints added to a temporary copy of its `src/` (the twin itself is never edited): the proof of every answer against P (`../test/twin-answers.test.mjs`) |
| `probes.mjs` | probe orders and the shipping-charge reading the answer functions share |
| `rules.mjs` | the desk's business rules, one line each; every rule is asked about at least once |
| `wording.mjs` | prints a list of options the same way everywhere (text and schema come from one sorted array) |
| `index.mjs` | `loadQuestions()` |
| `generate.mjs` | `node questions/generate.mjs` writes the answers; `--check` compares |

Example: `run-tax-rate` asks "For order fixture `clinic-monitors`, what tax rate was applied, in percent?"; its answer function reads the rate F used (delivery region `south`, so 6, although the invoice goes to `north`).

**Proved against the twin:** the same answer functions run on the twin's view and give all thirty answers of `hidden/answers.json` (`../test/twin-answers.test.mjs`); none needed changing.

Who may import this folder: the harness parent (the batch, the rehearsal's scripts) and the generator. No tool and no child process: `../test/question-leak.test.mjs` walks the tools' imports and the runtime folder, and checks that confined code cannot read this folder or `../hidden/answers.json`.

**Wording rules** (all tested): business words true of any implementation of the order desk, no step, stage, file, function or library word, no key of the program; every option of a list printed once, in sorted order, the same in the text and in the `answer` tool's schema; no question holds its own answer; no file of a working folder except the visible tests holds a run or why answer (so no comment hands it over).

**A question is never changed after a paid run has seen it** (RULE-2.md, rule 11). A wrong expected answer found later voids that question in every set-up.
