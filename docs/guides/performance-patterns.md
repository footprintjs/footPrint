# Performance patterns, with numbers

Every speed-up in footprintjs is a named pattern, a measurement before and
after, and a test that pins the answer did not change. This page collects
them so an engineer (or a student) can see the pattern in a real codebase
rather than a slide: the problem, the pattern, the number, the file. The
bench that produced each number is checked in; run it, do not quote it.

All numbers: Apple M5 Pro, Node 22, `npm run bench:*`, median of several
rounds. They are this machine's numbers, not a promise.

## 1. Clone once, apply into — the read-side fold (9.25.0)

**Problem.** To show the state at a stop, the reader replays the record:
the base state plus every stage's delta up to that stop. The replay handed
each delta to `applySmartMerge`, which clones the whole state before
applying the delta's rows. One clone per delta: a fold over N deltas cost
N clones of a state that itself grows with N — quadratic.

**Pattern.** *Amortised copy* (copy-on-write, collapsed). Clone the base once
into a private working copy, apply every delta into it, clone once more to
hand out a frozen result. The verb law stayed where it was
(`applySmartMergeInto` is the same fold `applySmartMerge` clones for —
`verbs · foldRows`) so there is still one replay implementation — the "no
fifth replica" rule in CLAUDE.md.

| At 10 000 commits | Before | After |
|---|---|---|
| fold at the last stop | 8.13 s | 2.8 ms |
| fold at the middle stop | 1.78 s | 0.9 ms |

Where: `src/lib/time-travel/stateAt.ts · foldLegsFrom`,
`src/lib/memory/utils.ts · applySmartMergeInto`.
Pinned: `test/lib/time-travel/fold-memo.test.ts` — the new fold equals a
fresh 9.17.0 fold at every stop, and the log is byte-identical before and
after (a fold never touches the record).
Bench: `npm run bench:time-travel`.

## 2. Remember the last fold — stepping (9.25.0)

**Problem.** A lens moves one stop at a time, and every stop refolded from
the base.

**Pattern.** *Incremental computation* (a memo on the cursor). The cursor
keeps the working copy of its last fold (`FoldMemo`); a step forward on the
same leg applies only the deltas after it. Any other ask — an earlier
stop, another leg — folds from scratch. The memo is a cache, never a claim:
the answer is defined by the fold from the base, and the test says so.

| At 10 000 commits | Before | After |
|---|---|---|
| one step forward | 15.6 s | 4.8 ms |

Where: `src/lib/time-travel/timeTravel.ts · stateAt` (the memo field).
Pinned: the same `fold-memo` test, including a backward jump after a
forward run.

## 3. Your own stack, not the engine's — the record as JSON (9.26.0)

**Problem.** A linear run's `executionTree` links stages by `next`, one
level per stage. `JSON.stringify` is recursive and threw
`RangeError: Maximum call stack size exceeded` at about ten thousand
stages; the record could not be saved. Measured first: V8's `JSON.parse`
reads a chain twelve thousand deep without complaint — only the encoder
recurses. That fact decided the fix: keep the shape, change the writer.

**Pattern.** *Explicit stack* (iterative depth-first traversal). The
encoder walks with its own frame stack and emits the same bytes
`JSON.stringify` would — `toJSON` honoured, absent values dropped from
objects and `null` in arrays, non-finite numbers `null`, cycles and BigInt
throw the same `TypeError`. Byte identity is the whole contract; readers
never know the writer changed.

| At 10 000 commits | Measured |
|---|---|
| record size | 4.6 MB |
| `stringifySnapshot` | 84 ms |
| `JSON.parse` | 17 ms |

Where: `src/lib/runner/stringifySnapshot.ts`.
Pinned: `test/lib/runner/stringifySnapshot.test.ts` — byte-identical on a
real snapshot and on a fast-check property over JSON values; a 20 000-deep
chain encodes and parses back.

## 4. Work lists, not recursion — walking the run tree

**Problem.** The same chain overflows any recursive walker, in any package.

**Pattern.** *Work list* (an explicit queue or a loop over `next`).
footprintjs's `commitStops` always walked with a work list. The lens's step
graph builder recursed and was fixed in agentfootprint-lens 0.58.2 by
turning the tail call into a loop — the parent path is constant along a
`next` chain, so the loop is the recursion exactly. Pinned there by a
20 000-stage chain.

## 5. Clone once at commit — the write side (9.23.0)

The same amortised-copy pattern, applied earlier and on the other side of
the record: a stage's writes used to be cloned at write time and again at
commit; now the buffer holds references and clones once when the payload
leaves it. The full story, with its numbers (a thousand writes 609 ms → 5.7
ms), is in [the fold and how it got fast](./the-fold-and-how-it-got-fast.md).
Beside it, `supersededByNextSet` is *work skipping*: a `set` the next row
re-sets is never applied, and the rows stay in the log untouched.

## 6. Share what you did not write — the commit (9.29.0)

**Problem.** Every stage that wrote anything deep-cloned the whole committed
state three times (twice to build its transaction buffer, once to apply its
commit). One changed number paid for an agent's whole conversation.

**Pattern.** *Copy-on-write with structural sharing* — the persistent-data-
structure idea, applied to plain objects. A generation is never edited; a
write copies the root and the containers on its own path and shares every
other subtree. The diff base becomes a bare reference (nothing may move it: a
read the stage's working copy cannot answer, served from live state, first gives
the base a private copy at that path), and a read after the first write copies
only what it reads. One verb law still
(`verbs · foldRows`); the public `applySmartMerge` keeps its detached
contract.

| One-number stage beside a 10 000-item history | Before | After |
|---|---|---|
| `structuredClone` calls · bytes per stage | 8 · 3.05 MB | 5 · 29 B |
| CPU per stage | 18.7 ms | 0.018 ms |

Where: `src/lib/memory/utils.ts · nextGeneration`, `src/lib/memory/pathOps.ts · ownSpine`,
`src/lib/memory/TransactionBuffer.ts · privatise` / `detachBase`.
Pinned: `test/lib/memory/boundary/commit-cost-independent-of-state.test.ts`
(counted: the same clone work at N = 100 and 10 000 — red before), and
`test/lib/memory/property/copy-on-write-differential.property.test.ts` (every
byte identical to the published 9.28.0).
Bench: `npx tsx bench/commit-clones.ts` (`--src <tree>` measures another tree).

## 7. Keep only what the next leg reads — the pause checkpoint (format 2)

**Problem.** A pause checkpoint is persisted — Redis, Postgres, a file — and
read back by `resume()`. Format 1 carried the run's whole execution tree and
the finished subflows' results beside the state. A resume read neither, and
both grew with every finished iteration, so a long agent run paid megabytes
per pause for a state of kilobytes. Building them was work too: the pause built
the root's tree, plus a tree for each subflow on the pause path, only to read
its state.

**Pattern.** *Carry what the consumer reads; serve the rest on demand.* A
resume reads the cursor, the state (the root's, plus one capture per subflow
on the pause path), the counters, the waiting siblings and the redaction names.
That, with the pause's own record (the question, the link, the time), is the
checkpoint. The run's history is the snapshot's, so a reader who wants it
takes it from the paused executor. The format moved from 1 to 2, and the ONE
codec's upcaster drops the two fields, so a stored format 1 checkpoint resumes
into the same run.

| 60-turn agent run (`bench/checkpoint-size.ts`) | Format 1 (9.43.0) | Format 2 |
|---|---|---|
| checkpoint, 15 / 60 / 240 turns | 3.93 / 19.27 / 80.61 MB | 0.134 / 0.134 / 0.134 MB |
| of which the execution tree (60 turns) | 18.68 MB (97%) | — |
| state the resume reads (`sharedState` + `subflowStates`) | 0.133 MB | 0.133 MB |

Where: `src/lib/runner/checkpoint.ts · buildPauseCheckpoint`,
`src/lib/engine/handlers/SubflowExecutor.ts` (the capture reads the store, not
a snapshot), `src/lib/pause/record.ts · upcastCheckpoint`.
Pinned: `test/lib/pause/checkpoint-size.test.ts` (the same checkpoint up to its
counters' digits after 3 turns or 40, and after a finished subflow of 2 steps
or 60; a pause builds zero tree nodes; red on 9.43.0), and
`test/lib/pause/resume-real-chart.property.test.ts` (a paused-and-resumed run
equals the never-paused one).
Bench: `npx tsx bench/checkpoint-size.ts` (`--src <tree>` measures another tree).

## 8. What decides, and what does not

Two rules run through all of the above.

- **Measure before you optimise, then let the number decide.** The read-side
  bench was written first. It said the fold was the wall and the record was
  not, so checkpoints and chunking — real patterns from the big-data world —
  stayed on the shelf. They return only when a run shows record size, not
  fold time, as the cost.
- **Same answer, less work, or it is not an optimisation.** Every pattern
  here is pinned by a test against the slow, obviously-correct version. An
  optimisation that changes what is recorded (a checkpoint, a chunk) is a
  configured dial the consumer turns, never a silent decision, because the
  honesty basis of a fold has to say where it came from.

## The big-data frame, for the curious

If you know lakehouse storage, the record is the same idea at a smaller
scale: a frozen base plus deltas (storage), structural statistics —
tags, paths, verbs, hashes, epochs — that let a reader pick stops without
scanning (the index), and references handed across a boundary instead of
bytes (the ticket). The differences are as instructive as the likeness: a
run is bounded and append-only, so there is no compaction; one reader walks
one run, so there is no commit protocol; and the model is handed a ref with
its meaning, never rows. Chunking the record would complete the likeness,
and it waits for a measured need.
