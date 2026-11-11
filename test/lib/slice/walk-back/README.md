# walk-back

The claim under test: for an app written as a footprint chart, the run record supports a deterministic walk from any state value back to every stage and decision that could have produced it, and the walk never omits a cause that flowed through the scope.

The walk back is foottrace's `causalChain`: start at `findLastWriter(commitLog, key)`, expand through each stage's reads (`keysReadFromExecutionTree`) and the control edges of `controlDepRecorder()`.

## The model

- `programs.ts`: variables `v0..vN` hold numbers. Statements are `v = c`, `v = u`, `v = u + w` and `if (g > t) v = u; else v = w`. A program is a list of plain stages (statements cut at random points) and up to two decider diamonds (`decide()` on `g > t`, two branch stages of one statement each, both writing the same variable). The file imports no library code.
- `judge(program)` is a plain interpreter. For every written variable it returns the true cause set: every stage on a dynamic dependence path to the final value (data, the in-stage conditional's test, and a decider plus what its tested variable depends on).
- `toChart.ts` builds the real chart (`s0, s1, …`), runs it and walks back from each variable.

## The properties (`../walk-back-soundness.property.test.ts`)

- **Sound**: every true cause stage is inside the walk back.
- **Exact at one statement per stage**: the walk back equals the true cause set.
- **Deterministic**: the same chart run twice gives the same stages and edges.

## Known gaps (pinned as `KNOWN GAP` examples in the same file)

- A stage that writes the value a key already holds leaves no commit row; the walk back skips it. The same holds for a stage that moves a key away and back within itself (the commit is a net change). The generator excludes both with `isNoOpWrite` (`NO_OP_WRITE_GUARD`).
- A value from a closure variable is recorded with no read and no flag.
- Many assignments in one stage are one node with no inner edges, so the walk back can name a stage that is not a cause (the blur). This over-approximates; it never omits.
- A value built in steps: a stage that merges into a value or appends to it without reading it (`$update`) is named as the value's writer, and the stage that wrote the rest is left out, with no note.

## Closed gaps (pinned as `CLOSED` examples at the end of the same file)

Why they stay: a closed gap keeps its witness, now asking for the right answer, so it cannot come back unnoticed.

- Steps that run side by side (closed by foottrace 1.13.0). A log is ordered by commit, and a step that read a key early and finished late was dated at its commit: the walk back named the sibling that wrote the key in between and left out the real writer. The record now says when a step looked at state (`beganAt` / `sawUntil` on its bundle). Three examples: a branch beside a subflow branch, a mount beside a sibling mount, and a branch that looked at state again after the sibling committed (both writers are then named, each marked as possible).

## Rerun

```sh
WALK_BACK_SEED=<seed from the test name> npx vitest run test/lib/slice/walk-back-soundness.property.test.ts
WALK_BACK_SEED=<seed> WALK_BACK_PATH=<path from the report> npx vitest run test/lib/slice/walk-back-soundness.property.test.ts
```

The measurement that reuses this model: `npm run bench:fault-finding` (`SEED`, `PROGRAMS` env).
