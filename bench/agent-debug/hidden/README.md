# hidden: the judge's data

Three files, never copied into an agent's working folder and never read by a child process that runs model-edited code:

- `orders.json`: the hidden orders, by name. The thirteen fixtures the agent can see, and five it cannot (`hidden-*`), so an edit that special-cases a visible fixture does not pass: every fault goes wrong on at least one `hidden-*` order (`test/faults.test.mjs` fails otherwise, RULE.md 1.2).
- `expected.json`: the full expected result of each order. Each was worked out from the business rules in the steps and checked against the unmodified program. Example: `small-pickup` → 5 pens at 1.20 = 6.00, south tax 6% = 0.36, collected at the store → 6.36.

How they are used (`harness/score.mjs · judgeCopy`): the scored copy runs every hidden order in a confined, read-only child (`harness/scoring-child/run-orders.mjs`), which prints one JSON document of results. The PARENT compares them with `expected.json`. Solved means: exit code 0, output not cut, exactly one results document holding exactly the expected names, every result equal to its expected value, and no file outside `src/` changed. The child computes; the parent judges. Edited code never sees an expected value, so it cannot forge a pass without producing the right results.

- `answers.json` (part 2): the expected answer of each of the thirty questions, by question id. It is computed, never typed: `node questions/generate.mjs` runs the flowchart program and each question's answer function (`questions/`), and `test/questions.test.mjs` computes it again and must get the same file. `test/twin-answers.test.mjs` derives all thirty from the ordinary twin with the same answer functions and must get the same answers. The harness parent reads it to score an answer (`harness/score-question.mjs`); no working folder holds it and no child may read it (`test/question-leak.test.mjs`).
