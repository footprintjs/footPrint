# twin-proof: what proves the twin, kept out of every working folder

The ordinary twin (`../twin/`) was written blind from `../twin/SPEC.md` (RULE-2.md). This folder holds what shows it is the writer's work and that it behaves as the flowchart program does. It sits BESIDE `twin/`, not in it: no manifest lists it, no working folder holds it, and confined code cannot read it (`../test/question-leak.test.mjs`). A test that pins every rule of the twin would name a planted fault at once, in one program only, so the twin's own tests live here and not in the agent's folder.

| File | Job |
|---|---|
| `twin-proof/test/rules.test.mjs`, `twin-proof/test/desk.test.mjs`, `twin-proof/test/kit.test.mjs` | the writer's own tests: every rule, the desk end to end, and the kit's acceptance test through the command line. They run in the bench's `npm test`, against `../twin/src` |
| `expected/` | the results the writer built against (what `kit.test.mjs` compares) |
| `twin-manifest-as-built.txt` | the sha256 of every file the writer left, frozen when it stopped |
| `frozen.mjs` | checks `../twin/` and this folder against that list; `node twin-proof/frozen.mjs` |
| `compare-all.mjs` | runs both command lines on all 31 orders and compares the bytes; `node twin-proof/compare-all.mjs program twin hidden/orders.json` |
| `paths-touched.py` | reads the writer's session record and lists every tool call that reached outside its folder (`python3 -I paths-touched.py <record> <folder>`; the record itself is not kept here) |
| `count-lines.mjs` | files, lines, code and comment lines of both programs, by one set of rules; `node twin-proof/count-lines.mjs` |

**How the writer's tests reach the twin.** They import `../src/…`, written for a folder where `test/` sat beside `src/`. Moved here, only their paths to the twin changed, and nothing else: `../src/` became `../../twin/src/` (in `rules.test.mjs` and `desk.test.mjs`), the fixtures folder `../fixtures/` became `../../twin/fixtures/` (`desk.test.mjs`), and in `kit.test.mjs` the root became `../../twin/` and the expected folder `../expected/`. `frozen.mjs · TEST_EDITS` lists exactly these, and the frozen check undoes them before hashing, so any other change fails it. The writer's `package.json` is in `twin/` beside `SPEC.md`, outside the manifest, so no working folder holds it; the bench's own `npm test` runs the writer's tests.

Example: `node twin-proof/frozen.mjs` → `50 of 50 listed files match the frozen hashes (3 of them after undoing the listed path edits); not copied: none.`
