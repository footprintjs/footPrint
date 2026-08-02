# Execution control — DynamicParallel and interrupt()

Status: DESIGN (Round A). Nothing here is built; Round B builds exactly this and
nothing beyond it. Names are working names until a release ships them.

## Why now

Two independent consumers converged on the same two engine asks: a Parallel
whose branch COUNT is decided at runtime from the payload (dynamic fan-out),
and a stage-level pause callable inside any stage body (interrupt-with-answer).
The market's most-adopted orchestrators ship both; ours come out more honest
if — and only if — the identity and replay questions are settled first. This
document settles them.

## The parser audit (run 2026-08-02, the gate for everything below)

Every site that parses the `runtimeStageId` grammar (`[subflowPath/]stageId#executionIndex`):

| site | mechanism |
|---|---|
| engine/runtimeStageId.ts (canonical) | `lastIndexOf('#')`, then `lastIndexOf('/')` |
| runner/DeferredObserverTier.ts:407 | `lastIndexOf('#')` |
| scope/ScopeFacade.ts:399-403 | `lastIndexOf('#')` + `split('/')` |
| recorder/InOutRecorder.ts:279 | `split('/')` |
| runner/getSubtreeSnapshot.ts:70,74,140 | `split('/')` ×3 |
| builder/structure/StructureRecorder.ts | consumes parseRuntimeStageId |

Two findings with teeth:

1. **Mechanical tolerance.** All parsing is last-delimiter-based. A marker
   embedded in the stageId segment (e.g. `fanout[3]#12`) parses "correctly"
   at every site without modification — stageId comes back as `fanout[3]`.
2. **The collision hole.** Stage ids are user-authored free-form strings and
   the builder validates NO reserved characters. Any marker we choose can
   collide with a user's literal id, and the loop-ref precedent proves this
   codebase already tolerates deliberate id-collision classes — meaning a
   collision would not crash; it would silently corrupt attribution, which
   is worse. Finding 1 is therefore a trap: the grammar ACCEPTS a third
   delimiter class; the ID SPACE does not.

## D1 — dynamic branches are SUBFLOWS, not a new id grammar

Rejected: `<stageId>[i]#<executionIndex>` (the outside proposal). It mints a
third delimiter class into an unvalidated id space (finding 2), and every
id-map lookup that expects the authored stage id would need an index-stripping
rule replicated at each site — a new lockstep family, which this codebase has
enough of.

Decided instead: a dynamic branch executes as a **generated subflow** whose
path segment is derived from the parent stage id plus the branch index, using
the grammar that already exists (`parent-fanout.3/inner#12`-shaped: the
branch is a subflowPath segment, `#` and `/` keep their one meaning each).
What this buys, for free, because subflows already have it:
- fresh isolated ExecutionRuntime per branch (branches cannot corrupt each
  other's in-flight state — the invariant DynamicParallel needs anyway);
- inputMapper/outputMapper seams for feeding the item in and merging results
  out (ordered-array merge = the existing arrayMerge law);
- resume drilling and checkpoint filtering that already speak subflow paths;
- causalChain / slice / lens read branch commits with zero changes, because
  the id shape IS the shipped shape.
Cost, named: the duplicated prefixers (builder `_prefixNodeTree` and traverser
`prefixNodeTree` are byte-twins) both learn the generated-segment rule — the
audit's one true lockstep edit, and Round B pins them with a byte-equivalence
test rather than hoping.

Collision law: the generated segment includes a marker character that the
builder REFUSES in user-authored subflow ids from this release forward — a
new validation on NEW charts only (an id that was legal stays legal at run
time; it is refused at BUILD time with a sentence naming the reservation and
this document). The marker is chosen in Round B from bytes no shipped
example, test, or known consumer uses.

## D2 — DynamicParallel surface

`items(input) => readonly T[]` + `branch(item, index) => subchart` +
`maxBranches` REQUIRED (an unbounded fan-out from model output is a resource
attack; absence refuses at build, naming this doc). Branch results commit as
one ordered array write on the parent; a failed branch follows Parallel's
existing failure policy (failFast vs best-effort — and the best-effort
which-branch-failed gap is pre-existing, not this feature's to widen).

## D3 — interrupt(payload) rides the pause machinery

`interrupt({ reason, expects? })` throws an InterruptSignal; the traverser
catches it at the stage boundary, commits the checkpoint WITH the payload
(M2's one detached structuredClone — no second checkpoint shape), surfaces
the existing paused outcome. Resume re-enters THAT stage from its top —
stages are atomic; the same law resumeOnError states, restated here because
hiding it once already cost a consumer. The InvokerStamp rule holds: a pause
inside a decider-dispatched stage must keep its invoker or resume loses it
(the traverser invariant the phase chain already guards).

Not decided here (Round B, with evidence): whether askHuman-style sugar in
downstream libraries re-implements over interrupt — that is their call, made
against their own pause vocabulary.

## D4 — what this round refuses

- A third delimiter class in runtimeStageId (D1's rejection, recorded).
- Unbounded fan-out, in any spelling.
- Durability policy (exit/async/sync persistence cadence) — that is a
  DOWNSTREAM sessions concern; the engine's deliverable is that
  FlowchartCheckpoint remains one detached clone that a host can persist on
  whatever cadence it chooses.

## Round B test list (minimum)

1. Prefixer byte-equivalence: builder and traverser produce identical trees
   for a generated branch segment (the lockstep pin).
2. A user chart using the reserved marker in a subflow id refuses at build,
   sentence pinned.
3. Branch commits read back through parseRuntimeStageId, causalChain,
   sliceForKey and forwardSliceForKey unmodified (the zero-changes claim,
   proven not asserted).
4. maxBranches absent → build refusal; exceeded → bounded execution with the
   truncation stated.
5. interrupt: payload survives the checkpoint round-trip; resume re-enters
   the stage top; a pause under a decider keeps its InvokerStamp; executionIndex
   monotonicity holds across the resume (the existing invariant, re-pinned
   against the new entry path).
6. Ordered-array result law: branch order == items order, independent of
   completion order.
