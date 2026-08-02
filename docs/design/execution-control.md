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

---

## BUILT — Round B, shipped in 9.14.0 (2026-08-02)

Round A above is unchanged; this section records what Round B built and the
four places the build had to decide something Round A left open.

**Shipped surface.** `.addParallelForEach(name, id, config)` and
`interrupt(scope, payload)`.

**Names.** DynamicParallel stays the concept word in this document; the public
method is `addParallelForEach` — plain names win over working names, and the
rename cost is zero before first publish.

**The marker: `~` (U+007E).** Chosen from an audit of all 852 distinct id
literals in this repo's src/tests/examples/docs/bench plus every id in the
known consumer libraries: `~` appears in NONE of them. It is RFC-3986
*unreserved* (survives a URL unescaped — trace viewers put path segments in
links) and is not a regex metacharacter, so a consumer building a `RegExp`
from a segment cannot be silently surprised. The grammar lives in ONE module,
`src/lib/engine/branchSegment.ts`.

**Nine build-time refusals, not eight.** Round A reserved the marker in
user-authored subflow ids (8 mount entry points). Round B added a ninth: the
id passed to `addParallelForEach` itself, because the generated segment embeds
that id and a marker inside it would make `parseBranchSegment` ambiguous.
Refusing it on a brand-new method costs no back-compat and keeps the parse
rule a split at the last marker rather than a heuristic.

**Four decisions Round A under-specified, settled here.**
1. `into: string` is REQUIRED — a result key derived from the stage id could
   silently overwrite state the chart already owns.
2. `items: (scope) => readonly T[]` — scope-first, like every other
   user-supplied function in the builder.
3. `interrupt(scope, payload)` is scope-first for the same reason
   `decide(scope, …)` is: there is no ambient stage register in this library,
   and inventing one would be unsafe under parallel fan-out. The scope object
   identifies the stage; a WeakMap keyed by it carries the one-shot answer.
4. A failed branch in best-effort mode leaves `undefined` in its slot. The
   which-branch-failed gap stays exactly as wide as it already was.

**Two implementation laws with their own tests.**
- *Re-registration.* Generated segments are stable across loop iterations, so
  the usual first-write-wins subflow registration would make a LOOPING
  fan-out silently re-execute iteration 1's branch charts forever. Generated
  branches overwrite on every visit instead.
- *The prefixers needed no behavioural change.* Finding 1's mechanical
  tolerance covers prefixing too — a segment is just a prefix. So the lockstep
  deliverable is the pin plus centralisation, not invented behaviour:
  `test/lib/engine/branch-segment-prefixer-equivalence.test.ts` fails if either
  twin drifts, including drift that keeps them equal to each other.

**No parser site learned the marker.** All eight audited sites read a generated
branch as an ordinary path segment, unmodified — proven by test 3, not
asserted. The one visible consequence: an `interrupt()` inside a branch pauses
correctly but cannot be resumed, because a generated subflow is not in the
static chart. It refuses through the shipped "stage not found in flowchart"
message — no marker special-casing anywhere — and that refusal is documented
and pinned (`test/lib/pause/interrupt-in-parallel-branch.test.ts`).

**Not a new node type.** `isDynamicParallel` is a spec BOOLEAN and the
serialized `type` stays `'fork'` (following `isPausable`/`isLazy`/`isStreaming`,
which are all flags on a `'stage'`). A fan-out is what it is, and every
existing `switch (type)` consumer keeps working.

D4's refusals all held: no third delimiter class, no unbounded fan-out, no
durability policy.
