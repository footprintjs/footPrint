# The fairness reading of part 2, round 1 (before any paid run)

Read at head `4a683edb0a4cf205be61fa44bfbd92fe9c0ece69` of `bench/agent-debug-part-2` (footPrint pull request 207) by an independent reader that built none of it (an Opus agent given only the brief `REVIEW-BRIEF-P2-FAIRNESS.md`). Saved from the reader's final message, unedited. 13 November 2026.

**Fair after fixes.**

Four small fixes are needed before any paid run: three are blocking and one is a wording correction. On top of that, the fault comparison leans toward P (the twin), which works against the claim, and the report should show that. The main decision is fair to run once the blocking items are done.

I read head `4a683edb0a4cf205be61fa44bfbd92fe9c0ece69`, checked out detached in `S/agents/p2-fairness-read/repo`, and ran `npm ci --ignore-scripts` there. My scripts are in `S/agents/p2-fairness-read/scripts/`. Nothing was pushed, no comments were posted, no model was called, no money was spent and no `.env` file was read. The scratch copies I made for the fault comparison have been deleted; the clone is clean.

What I ran, with results:
- `npm test`: 277 of 277 passed.
- `node twin-proof/compare-all.mjs program twin hidden/orders.json`: 31 of 31 orders print the same bytes.
- `node twin-proof/frozen.mjs`: 50 of 50 files match.
- The committed `twin/` (src, README, visible tests, fixtures) is byte-identical to `twin-as-built-2.tgz`. Between the two archives only comments and the README changed.

## Findings, most serious first

**1. BLOCKING: the `read_file` tool description names a file that only F has.**
- Where: `tools/read-file.mjs · definition`, the example "such as `src/chart.mjs`".
- How I know: read.
- Which side it favours: F. In set-ups 1 to 3 it points straight at F's wiring file, which is a map in all but name. In set-up P it suggests a file that does not exist, which can cost P a wasted call.
- `RULE-2.md` removed part 1's system sentence for exactly this reason ("false for the twin"), so the same logic applies here.
- Smallest fix: use an example both programs have, such as `README.md` or `src/run-order.mjs`.
- The other tool texts are neutral: `search` uses "grandTotal" / "tax|shipping", which match both programs. `done` still says "naming the step you changed"; that is an F word, but it is not scored and the rule already discloses it.

**2. BLOCKING: question `program-rejection-checks` can be read two ways.**
- The option "the grand total is more than 2000" is meant as "not a rejection". But for customers C-300 and C-500 (order limits 1,500 and 800), a grand total over 2000 always breaks the order limit, so the order is rejected. A careful reader could tick it.
- It affects both sides equally, but a question can never change after the first paid run.
- Fix: "Which of these, each one on its own while every other check passes, makes the desk reject an order?"
- How I know: read.

**3. BLOCKING: "right at least as often" means two things, and I built a case where the code's decision and the rule's words disagree.**
- `harness/compare2.mjs · claim` compares the share of finished runs that were right. `RULE-2.md` says "right at least as often" and does not list this choice under "Decided while building".
- How I know: ran `scripts/decision-case.mjs`. Set-up 3 has 116 right of 146 finished (4 runs ended in error), set-up P has 117 right of 150. `report2.mjs · decision2` prints "Go on", although set-up 3 was right fewer times.
- Up to 20 unfinished runs are allowed. API errors are also likelier on long runs, so unfinished runs tend to drop the expensive ones.
- Fix: one line in `RULE-2.md`. Either say it is the share of finished runs, or take the stricter reading (right answers over planned runs, with an unfinished run counting as wrong).
- I found no other disagreement between the code and the rule: the left-out rows, the 25% and 15% margins, the 20-unfinished limit, the plan check and the transcripts the reviewer must read all match.

**4. Not blocking, favours P: the fault pairs lean toward the twin.**
- All ten pairs are the same business fault. I ran both faulted programs on the 18 hidden orders plus 56 edge orders of my own, and they print the same bytes on all of them. The only exceptions are three prototype-name inputs, which also differ unfaulted (see finding 7).
- But how easy each fault is to see is uneven:
  - **`loop-stops-early`:** P's plant is `lines.slice(0, lines.length - 1 || 1)`, an odd expression right in the loop.
  - **`missing-write`:** P's plant is `creditOk: true`, a literal sitting beside a `creditOk` computed one line above.
  - **`wrong-default-branch`:** P's plant is a `const fee = …` that is never used, followed by `return 0;`.
  - **Less glaring:** `wrong-key-read` and `wrong-mapper-key` (as well as `missing-write`) sit in `src/order-desk.mjs`. That file is about 115 lines, and the README tells every reader to open it first. For `wrong-mapper-key`, P's `taxRateFor` doc even says "The billing region is never used".
- In F, each of these faults is one token in one of 35 files.
- Part of this is simply what ordinary code looks like (orchestration in one file). The three conspicuous plants are design choices.
- Fix: in the report, show claim A on the data-flow faults both with and without these three pairs. Better, re-plant them less visibly (fault files may change; twin files may not).

**5. Not blocking, favours P: P carries clearly more comments than F, not "about as much".**
- This helps P state its rules plainly, on both the program questions and the faults. Total bytes are close, so reading cost is about the same.
- Fix: none is possible without the blind writer. Disclose the numbers in the report (they are in the size table below).

**6. Not blocking: the disclosure about the writer's standing notes is not quite true.**
- The writer was blind as far as tools go. I checked all 64 calls in its record with `paths-touched.py` (0 outside its folder) and with my own listing of every call; all stayed in `od-build/order-desk`. Its thinking text is empty in the record, so I could not read its reasoning.
- `RULE-2.md` says the standing notes "say nothing about … how this experiment is built". In fact the notes index it carried includes "logs-vs-trace benchmark", "my benchmark plan", "walk-back claim = NORTH STAR" and "build every feature as a footprintjs flowchart … the run record = the LLM's debug log".
- That could have told the writer which side the owner hopes wins. The result shows no sign of it: P is strong, not a straw man.
- Fix: correct the sentence in `RULE-2.md`.

**7. Not blocking: the specification passes on a little of F's shape.**
- Section 6.12 of `twin/SPEC.md` lists F's intermediate values, including `linesPriced` and `headroom`. Section 6 runs in the chart's order, and it says both checks are made "after the grand total is known".
- So P computes `linesPriced` and `headroom` and never uses them.
- It is harmless, and it also gives P a single object that holds every figure. F has the same thing in `getSnapshot().sharedState`, so the two are symmetric.
- I found no fault, no question and no hidden order's values in `SPEC.md` or `BRIEF.md`. None of the 30 answers appears in either working folder (grep).
- Unfaulted, the only differences in my edge orders are prototype names (`toString` as region or item, `constructor` as customer). No question or fault reaches them.
- Refusal messages differ (F prints a stack trace, P one line). Both exit with 1, so a model sees "refused" either way.

**8. Not blocking: question wording is slightly closer to P's comments.**
- I searched every 2-to-4-word phrase of the questions and options in both working folders. Phrases found on one side only: about 25 on F's side ("the customer collects", "five years or more", "rate of the region", "sent for review") and about 35 on P's ("open balance", "credit check", "fee per kilogram", "shelf holds fewer units", "not in the catalog").
- Cause: P was written from the specification's business words, which the questions share. It is a small advantage for P's `search`.

**9. On claim A's meaning (item 14 of the brief).**
- Set-up 3 against set-up P changes two things at once: the program and four extra tools. Part 1 measured about 900 extra input tokens per request for those tool definitions.
- A result that holds supports only "this flowchart program with its tools against this twin", not "the record saves tokens". The report should print claims B and C beside A and say this in its first lines.
- The biases go both ways:
  - **Toward F:** 7 of the 20 run and why questions ask for a value F keeps under a named key (rate, weight, line total, net amount, headroom, the shipping rule that matched). The record prints these almost directly.
  - **Toward P:** the extra comments (finding 5) and the faults (finding 4).

**What holds (ran):**
- Prints added with `edit_file` come back through `run_order` in both programs (`scripts/probe-tools.mjs`).
- Leaks are blocked in both programs:
  - `..` paths, absolute paths and `SPEC.md` are refused by the file tools.
  - When the program's own code reads `hidden/`, `twin/SPEC.md`, the other program, `faults/` or `questions/`, it gets `ERR_ACCESS_DENIED`.
  - The program's environment holds one harmless variable.
  - The record tools run under the same confinement.
- The two READMEs are the same kind of thing. P's maps rules to files; F's points at `chart.mjs`, which is itself a map.
- The two visible test files match assertion by assertion.
- Scoring calls each program's entry module the same way (`result-of.mjs`). A business-correct fix scores the same in both; a fix made in the command-line file is ignored equally in both.

## The thirty questions
I recomputed all 30 expected answers by hand from the tables; all match `hidden/answers.json`.

| id | verdict | note |
|---|---|---|
| program-free-shipping | ok | {after discounts ≥100, collected at the store}; the subtotal option is a fair distractor |
| program-bulk-discount | ok | 10 units, 5% |
| program-outcome-order | ok | on-hold, rejected, review, approved |
| program-tax-region | ok | delivery region |
| program-default-tax-rate | ok | 8 |
| program-loyalty | ok | 5 years, 2%, on the subtotal |
| program-unknown-item | ok | refused; both visible tests already show it |
| program-shipping-charge | ok | 4.95 / 0.85 / 2 |
| program-rejection-checks | **fix wording** | the ">2000" option can read as true for C-300 and C-500 (finding 2) |
| program-fixed-coupon-cap | ok | the whole subtotal |
| run-tax-rate | ok | 6 (south) |
| run-weight | ok | 13 + 1.8 + 56 = 70.8 |
| run-line-total | ok | 4 × 389 = 1556 |
| run-net-amount | ok | 2334 − 46.68 = 2287.32 |
| run-loyalty | ok | 2.05, printed |
| run-coupon | ok | 5.25, printed |
| run-shipping | ok | 25.35, printed |
| run-grand-total | ok | 57.59, printed |
| run-short-units | ok | 6 − 4 = 2 |
| run-headroom | ok | 5000 − 1200 − 1864.08 = 1935.92 |
| why-rejected-limits | ok | both limits; 437.02 |
| why-review-not-rejected | ok | 2600 − 2554.52 = 45.48 |
| why-review-amount | ok | 470.31 |
| why-held-otherwise | ok | approved (269.89, within limits) |
| why-approved-credit | ok | 900 + 105.47 = 1005.47 |
| why-free-by-amount | ok | net 100.45; the subtotal and 5-years options are true but not the cause, which tests the rule |
| why-free-by-pickup | ok | pickup (net 47.25) |
| why-charged-weight | ok | 0.85 × 24 = 20.4 |
| why-express-standard | ok | 6.48 |
| why-free-with-coupon | ok | false (95.45) |

## The ten fault pairs

| id | same fault | easier side | why |
|---|---|---|---|
| wrong-key-read | yes | about even | F has a comment beside the line; P has none, but the line sits in the hub file next to three uses of `net` |
| wrong-rule | yes | even | both comments say 2000 |
| missing-write | yes | **P** | `creditOk: true` literal next to an unused computed value, in the hub file |
| wrong-default-branch | yes | **P** | unused `fee`, then `return 0;` |
| swapped-key-in-fork | yes | even | the same swap with the same comment |
| wrong-mapper-key | yes | P | hub file; the doc says "billing region is never used"; F's fault is at distance 5 inside the tax sub-flowchart |
| loop-stops-early | yes | **P** | `slice(0, n - 1 \|\| 1)` is glaring; F's is `gt: 1` against an example in the comment |
| wrong-constant | yes | even | both have the 0.85 rule nearby in a comment |
| rounding-misplaced | yes | even (P slightly) | both comments state "rounded once after the discount" |
| wrong-threshold | yes | even (P slightly) | P's comment adds "exactly 5 is inside" |

## Counts for item 8 of the brief (read, with hand arithmetic)
- **Program questions (10):** all 10 can be answered by reading code and tables; no run is needed.
- **Run and why questions (20):**
  - All 20 can be answered from the printed result, the fixture and the tables with arithmetic; none needs a print or the record.
  - 5 are in the printed result directly: run-loyalty, run-coupon, run-shipping, run-grand-total and, after subtracting 2000, why-review-amount.
  - 15 need a value that is not printed (computed by hand, by a print, or from the record).
  - 3 are "what if" questions that take two runs if done by running (why-held-otherwise, why-express-standard, why-free-with-coupon); all three can also be reasoned out.
  - The record prints the answer, or one subtraction from it, for about 10 of the 20.
- So the set is not one the record must win, but it does contain the record's easiest cases. Reporting by kind, as the rule does, is needed.

## Size and comments
Counted with my own string-aware counter (`scripts/count.py`). It agrees with `count-lines.mjs`, whose rules I checked.

| | F | P |
|---|---|---|
| files under src/ | 35 | 17 |
| code lines | 333 | 278 (3 of them carry a trailing comment) |
| comment lines | 306 | 380 |
| comment lines per code line | 0.92 | 1.37 |
| comment words | 1,587 | 2,465 |
| comment words per code token | 0.88 | 2.00 |
| src bytes | 25,337 | 26,652 |

Without `data/`: F 0.88 and P 1.40 comment lines per code line.

## What I could not verify
- The writer's reasoning: its thinking is empty in the record.
- Whether the specification's writer saw the fault files.
- How a real model behaves: no rehearsal or smoke run was made.
- Whether the plain-agent counts in item 8 hold for Haiku's arithmetic in practice.

Every finding above is either from a command I ran or from reading, as marked.
