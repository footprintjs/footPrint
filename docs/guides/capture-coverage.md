# What the engine captured

For an optional separately copied terminal native prefix, see [closed native capture](closed-native-capture.md). A live snapshot, native invocation counters and a storage acknowledgement remain distinct from that contract.

Capture coverage is an opt-in engine observation, not a promise that a business
operation succeeded or that an external service was observed. It costs no model
calls. Missing collection must stay unknown.

Normal snapshots carry the stage-1 observation. The first persistence slice also
keeps that observation in a lean pause checkpoint. **This does not complete #111
stage 2:** sink capture notes, durable acknowledgements, saved-history admission
and child-log attestations remain separate work. Reader adoption is a separate
consumer contract; neither serialization nor a completed `run()` supplies it.

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';
import { controlDepRecorder } from 'footprintjs/trace';

const chart = flowChart<{ n: number }>('Set', (scope) => {
  scope.n = 1;
}, 'set').build();
const executor = new FlowChartExecutor(chart, {
  captureCoverage: true,
  writeProvenance: 'reads-prefix',
});
executor.attachFlowRecorder(controlDepRecorder({ captureCoverage: true }));
await executor.run();
const snapshot = executor.getSnapshot();
console.log(snapshot.capture?.boundary.status); // completed
console.log(snapshot.capture?.channels.control); // captured
```

Without `captureCoverage`, or with `false`, no capture note is added. Existing
record bytes and observer payloads stay unchanged. The recorder's separate option
adds a public snapshot acknowledgement; a recorder attached without it does not
assert coverage. Custom producers can use the same `RecorderSnapshot.capture`
contract. The engine never checks recorder classes or reads their private state.
Only a successfully copied, current-run acknowledgement from the exact inline
flow-recorder object is used; a deferred recorder does not attest complete
control delivery. Missing, malformed or wrong-run acknowledgements stay unknown.

## Read the scope before the status

`capture.version` is 1. `runId` is this invocation's native logical run identity.
`logAddress` uses Foottrace's native address; it is stable across a same-executor
resume, while `runId` changes. `commits.from` and `commits.to` are **half-open
native commit offsets** covering this leg in that log. No second timeline is
created. The note covers only the **root log**, not nested subflow logs, the
entire accumulated tree, other runs or remote services. A drilled child has no
note in this stage and cannot borrow its parent's.

`boundary.status` distinguishes running, completed, failed, paused and cancelled.
A prefix sampled during execution has no terminal statement. The failure is the
existing safe native `getFailureContext()` result, not a new error correlator.
It contains a category and, when owned, native stage references, never an error
message, stack or payload. Overlong stage references are omitted with a gap.
Cancellation is named only for the exact native cancellation reason; a coincident
abort cannot relabel an unrelated failure, and the engine's own time limit is
not cancellation. A completed prefix after `$break()` has `execution-broken`.
Neither pause nor a handled/recovered failure impersonates terminal failure.
Rejected admission creates no new log: the prior snapshot retains its prior
identity and ending, while `getFailureContext()` describes the rejected call.

## Collected is different from missing

The four `modes` are the effective read retention, write retention, commit-value
encoding and per-write provenance of this segment. The read/write channels describe
**retained per-stage key views**, not ordered read occurrences, arbitrary property
accesses, discarded retry-attempt views or complete raw values. Summary retention
is collected as a summary; off is disabled. Inputs and environment reads are not
tracked-state reads. Exact read versions are explicitly `not-collected` pending
#113. Per-write `reads-prefix` describes possible dependencies, never semantic
proof that the read affected a subsequently written constant.

Engine attention can be captured and empty. Omitted references or attempt evidence
make it partial. Failed read/commit retention, custom data-only scope ports and
recorder snapshot failures remain explicit limitations. A recorder's `clear()`
during a covered leg makes its acknowledgement partial; a new leg starts fresh.
Resume is marked `resumed-segment`, so a consumer cannot use it to certify earlier
commits or pre-pause governing decisions. Redacted exports disclose that limitation;
the note copies only fixed mode fields, never the redaction policy or selected
key names.

## Keep persistence honest

`persistence` remains **memory-only**, even when a sink is configured.
The note is detached, frozen and JSON-safe, so the note itself survives a normal
snapshot JSON round trip. That is not a storage acknowledgement. No capture note
is added to a sink, no durable end marker is manufactured and no
stored prefix is upgraded. Old records remain unattested. A trimmed projection
must drop the note or preserve explicit limitations; this stage supplies no
arbitrary export/trim admission function.

A host remains responsible for authorization and record integrity. An attacker can
forge JSON, including these fields: the note is not a signature. General Foottrace
and AgentFootprint consumers must validate identity, extent and available channels
before using a later supported admission contract; they must **not** blindly turn
`complete: true` on. Existing redaction, conservative attribution, untracked-input,
missing-link, tie and query-budget gaps still withhold a unique root. The consumer
test demonstrates the narrow one-step fixture through public Foottrace functions;
it is not a general saved-record adapter.

## A checkpoint keeps an observation, not the history

With `captureCoverage: true`, `getCheckpoint().capture` describes the paused
root-log segment: native identity, extent, effective modes and a paused boundary.
It survives JSON and the existing checkpoint decoder. The checkpoint still omits
the commit log, execution tree and recorder contents. Its note therefore adds
`checkpoint-history-not-included`, retains all base limitations, and never claims
durable delivery. Control is `unknown` because recorder history is not included;
known failed/partial/disabled control observations are not erased when decoding.
An active policy or per-write redaction mark is disclosed as `redaction-active`
even if no snapshot was requested before pausing.
It does not call recorder serialization or build a snapshot to make this note.

```typescript
import { flowChart, FlowChartExecutor, type FlowchartCheckpoint } from 'footprintjs';

const chart = flowChart<{ n: number }>('Seed', (s) => { s.n = 1; }, 'seed')
  .addPausableFunction('Review', {
    execute: () => ({ question: 'Continue?' }),
    resume: () => undefined,
  }, 'review').build();
const executor = new FlowChartExecutor(chart, { captureCoverage: true });
await executor.run();
const stored = JSON.stringify(executor.getCheckpoint());
const checkpoint = JSON.parse(stored) as FlowchartCheckpoint;
console.log(checkpoint.capture?.boundary.status); // paused
console.log(checkpoint.capture?.persistence); // memory-only
await new FlowChartExecutor(chart, { captureCoverage: true }).resume(checkpoint, true);
```

Both same- and fresh-executor resume start a new observed segment and disclose
`resumed-segment`; they never seed collection facts from the stored note or enable
capture from it. Keep the original checkpoint/record if you need the prior leg.
Nested pause metadata still covers only the root, not the paused child's log.

The codec reads own data properties, bounds each identity to 2,048 characters and
the limitation list to 32 entries, and copies only recognized facts. It refuses
malformed metadata with fixed wording before changing resume state, without
evaluating getters. Legacy/default/off checkpoints remain without a note. A
well-formed note is still untrusted data, not authentication or proof that its
referenced record was stored. Missing or incomplete durable history stays unknown.


## Observe native work without claiming closure

`captureExtent: true` adds a separate, versioned `snapshot.captureExtent` sidecar.
It requires `captureCoverage: true` and is off by default. The existing version-1
and version-2 capture notes keep their meanings.

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';

const failure = new Error('synthetic rejection');
const chart = flowChart('Reject', () => { throw failure; }, 'reject').build();
const executor = new FlowChartExecutor(chart, {
  captureCoverage: true,
  captureExtent: true,
});
try {
  await executor.run();
} catch (error) {
  console.log(error === failure); // true
}
const snapshot = executor.getSnapshot();
console.log(snapshot.capture?.boundary.status); // failed
console.log(snapshot.captureExtent?.status); // unverified
console.log(snapshot.captureExtent?.invocations.pending); // 0
```

The [runnable example](../../examples/runtime-features/crash-safe-record/05-native-capture-extent.ts)
checks the same behavior using a local synthetic stage.

The sidecar contains the native leg's run identity, root-log address and half-open
commit range. Its bounded counters are collected where the engine actually calls
a stage function:

| Counter | Observation |
| --- | --- |
| `started` | The engine entered a stage function, including each retry invocation. |
| `settled` | The engine observed a synchronous return/throw, or Promise settlement through an existing native continuation. |
| `pending` | No settlement had been observed for an entered function at the sampled cut. |
| `abandoned` | The native wait ended on an abort race before settlement was observed. |

The counters describe what the existing native continuations observed. A Promise
may already have settled internally while its continuation is still queued;
`pending` does not inspect that internal state. No extra handler or microtask is
added to sharpen this distinction.

When the signal is already aborted as a stage returns its Promise, the engine
keeps its existing rejection-only `catch` observer. Rejection can be observed;
fulfillment remains unobserved and may stay `pending`. Counting more precisely
must not change which Promise methods or callbacks execute.

The function's original Promise and the engine's wait are separate observations.
An abort can end the wait while a callback or remote operation keeps running.
`abandoned` records that local race; it does not prove remote cancellation. These
are native stage-function counters, not an inventory of arbitrary JavaScript
callbacks, SDK work, helper calls or external effects.

`OwnedRun.finish()` joins the owner's cleanup; it does not certify capture
closure. An owned body can still fail after `finish()` while its native leg
remains recorded as completed. This sidecar stays `unverified` in either case;
owned-body and finalizer work are outside its stage-invocation counts.

A running observation has `status: 'running'`. At native terminal settlement the
sidecar fixes its range, counters and limitations and becomes `unverified`. Later
settlement of an original Promise cannot change that terminal sidecar or a new
leg's counters. This is a frozen observation of work at a cut. It does not seal
the execution tree, recorder snapshots or other evidence channels. Zero pending
invocations therefore does not prove a closed capture.
Version 1 has no closed state. A future closure attestation needs a separately
reviewed version and consumer contract.

The first slice conservatively discloses observed child logs, fan-out, detach,
custom scopes and resume. Counter saturation and missing coverage remain explicit
limitations. A failed run remains failed and keeps its original escaping error.
The sidecar does not change error handling, enable a consumer's completeness gate,
or establish a semantic root cause. Proven immutable evidence closure and consumer
admission require a separate contract.

At most 1,000,000 invocations are counted per leg. Once that ceiling is reached,
`counter-saturated` discloses that later invocations were omitted; the counters
remain bounded observations, not exact totals. The collector keeps no owner map,
stage names, values or exceptions.

Native protocol identities and counts remain visible in `getSnapshot({ redact:
true })`, consistently with the existing native capture note. No business values
or key names enter this sidecar. Stored export uses the existing redaction rule;
if that rule masks a required protocol field, persistence refuses the sidecar
and does not request a durability acknowledgement for malformed evidence.
