# Typed proxy observations and their dependency meaning

Status: **contract proposal and executable witnesses only**. No new observation
channel, setting, public type or runtime behavior is implemented by this PR.
The baseline is FootPrint 11.0.1 with Foottrace 1.11.1. The tests below describe
existing behavior; the future implementation gates are not claimed passing.

## 1. Goal

Capture useful facts when a scope operation happens, so a reader can distinguish
reading a value, asking about membership, inspecting structure and changing
state. Retain the actual operation and answer rather than turning every proxy
trap into a value read or an exact dependency edge.

The intended error explanation supplements the original error: where the failure
was reported, which evidence leads to it, a supported fault source when one is
established, and the missing boundary otherwise. More observed operations do
not by themselves establish a root cause.

This is the engine-side companion to Foottrace's read-occurrence/write evidence
work. It does not create a separate dependency package, graph walker or record
schema here. See [exact read sources](2026-10-exact-read-sources.md) for the
existing producer/record separation and
[the scope/emit rule](scope-vs-emit.md) for business state versus observations.

## 2. One owner per responsibility

| Owner | Responsibility |
| --- | --- |
| FootPrint | Proxy interception, execution/attempt identity, control and retry lifecycle, cancellation/late-write fencing, policy, privacy and capture coverage. |
| Foottrace | Generic frame/buffer observation ports, canonical evidence types and IDs, bounds, stored format/admission, cause/impact and PROV interpretation. |
| Consumers | Request and display admitted evidence with its basis and gaps. No source reconstruction or second walk. |
| Hosting/provider adapters | Supply explicit service/queue/gateway/effect receipts through the shared contract when those facts are available. A scope proxy cannot observe an operation that bypasses it. |

All engine integration uses named public Foottrace ports. A timestamp, display
name, equal value or last-writer scan must not manufacture a source identity.

## 3. What exists today

`createTypedScope` intercepts root get/set/delete, membership and key/descriptor
inspection. Nested and array proxies intercept writes and selected structural
operations too. Interception is not the same as retaining a distinct evidence
record for each operation.

| Operation | Current observation | Limitation |
| --- | --- | --- |
| `scope.amount` | One root value read; privacy and optional exact-source capture apply. | Primitive local arithmetic after the read is outside the proxy. |
| `scope.amount = value`, `delete scope.amount` | Canonical staging/write/commit funnel. | A commit may aggregate writes or omit net no-ops; a path alone is not an operation ID. |
| `'amount' in scope` | `hasKey` enters native read bookkeeping but does not dispatch `ScopeRecorder.onRead`. | It returns false for both undefined and never-set values. It is not JavaScript own-property existence proof. |
| `Object.keys(scope)`, descriptors | Inspection and per-key checks can enter native read bookkeeping without `onRead` dispatch. | Listing names is not receipt of all values. The existing record does not identify the inspection as a distinct typed operation. |
| `scope.order.shipping.postcode` | Root `order` is tracked; nested navigation uses the live view silently. | No separately retained field read or field-version proof. |
| Array mutation methods/index assignment | Copy-on-write through the owning root's write funnel. | The resulting root write does not itself record which method/arguments caused it. |
| Reserved promise/inspection probes | Guards avoid phantom reads, including an absent `toJSON` probe. | Real state keys and actual business reads must not be suppressed as noise. |

The native temporal-prefix setting `writeProvenance: 'reads-prefix'` already
stamps keys read before each write. It is a possible-contributor set, not a list
of exact read occurrences and not semantic expression dependence. A read that
is ignored before a constant write must not become an established derivation.

## 4. Executable witnesses

`test/lib/reactive/scenario/proxy-observation-witnesses.test.ts` uses the real
builder, executor and recorder path, without changing source behavior.

| Witness name | Design consequence |
| --- | --- |
| `membership answers do not dispatch value-read events but enter the native read prefix` | A recorder hook stream cannot substitute for native observations; preserve the returned membership semantics. |
| `listing keys does not dispatch value-read events although listed names enter read bookkeeping` | Preserve inspection kind separately from value delivery. |
| `a nested field read records its root without claiming a separate field read` | A root observation cannot be relabelled as exact field ancestry. |
| `a held nested handle reads its changed view without a new field-source observation` | Any future field observation must identify the actual view serving that access, not reuse the earlier root source blindly. |
| `array mutation methods use the root write funnel and retain the resulting array` | Add bounded operation metadata beside the existing write, with no duplicate mutation or array clone just for logging. |
| `reserved runtime probes do not become tracked business reads` | New capture must retain the existing runtime-probe guard behavior. |

These are observations and counterexamples for the proposed contract, not proof
that typed observation records exist. A future behavior change needs its own
red-first tests and compatibility decision; these witnesses must not be used to
turn a newly found bug into a permanent rule.

## 5. First supported slice: membership and structure

The first runtime slice should distinguish **value access**, **membership
answer** and **key listing**. Proposed concepts below are not public API names
or a frozen serialized shape. Foottrace must review and own any declarations
before the engine imports them.

Each elected observation needs its native record address/segment, execution and
attempt owner, actual operation order, requested path segments and the completed
answer. Keep segments separate: a literal key containing a dot is not a nested
path. Do not fetch a value a second time, invoke a getter again, or re-run a
predicate to improve its log.

- A value observation records which supported source was actually served, under
  the existing source contract.
- A membership observation records the boolean the current scope operation
  returned. Do not rename a false answer to "property never existed": today's
  API treats undefined as absent. Distinguishing own presence from an undefined
  value would require a deliberate native-resolution/API contract of its own.
- A listing observation records the bounded structural answer it actually
  exposed. Names, membership and topology can be private even without values.
  It does not assert that every listed value was read or used.

Observed-empty, uncollected, redacted, unsupported, truncated and failed capture
must remain distinct. In particular, an empty collection with a valid completion
fact is different from an omitted record. Capture failure or a full budget must
not change the business answer, raise a new business exception, or report an
apparently complete empty history.

Capture happens during the native operation. There is no post-run tree scan and
no inference of expression dependencies from the new observation kinds.

### Resolution and completion boundaries

An occurrence's entry ordinal is its identity, not a successful-completion
frontier. A synchronous native read or privacy callback can re-enter the writer:
read 2 may finish and a write may occur while read 1 is still pending. Only
completed observations belong to that write's immutable prefix. A per-owner
maximum ordinal is insufficient even without parallel branches. Test actual
writer callback reentrancy, thrown reads and a callback that discards or replaces
its frame; do not repeat the business read to repair the evidence.
The existing privacy verdict remains pure and name-only. An impure callback is
an adversarial robustness case, not newly supported business behavior; refuse or
withhold unsupported evidence rather than granting it authority.

Name the boundary being attested. Native resolution, returning from a proxy
handler and completing the outer JavaScript operation are different facts:
JavaScript can check a proxy invariant after its handler returns. This contract
does not turn a native observation into proof of a successfully delivered outer
operation. Existing owned proxies and supported operation kinds need explicit
tests; arbitrary reflective operations remain outside coverage.

Membership and listing keep their operation kind through capture, storage and
reader presentation. They must not become value-delivery evidence merely
because native read bookkeeping already contains their keys. A root output also
does not make its input source exact: held nested handles, raw-returning array
methods and intentionally unwrapped values retain their existing coverage gaps.

## 6. Later slices, each separately reviewed

### Field and index access

An optional field/index observation can report the path the proxy traversed.
That path is not field-version proof while the source contract only supports
root selections or reports `composite-unsupported`. A held proxy resolves a live
view: after an intervening write, a nested access may return a different view
from the earlier root read. The producer must bind the actual supported view at
that access or keep its source unknown.

Array elements reached by `find`, `filter`, iteration and other raw-returning
methods can bypass the indexed proxy path. Dates, Maps, class instances and
other intentionally unwrapped values also remain outside that coverage. Do not
add field-level completeness claims or wrap those values universally to hide
the boundary. Existing raw-mutation warnings are not interception or proof that
the mutation was captured.

### Mutation summaries

Retain a fixed operation kind and bounded structural summary beside the existing
write, such as an append, splice, index replacement or deletion. Reuse the one
write funnel and its privacy law. Do not copy the whole array again, retain raw
arguments, repeat a comparator/getter, or pretend an aggregate commit row is one
particular write event. Stable operation-to-row mapping and delta compaction
need Foottrace-owned semantics.

### Refused operations

Reuse the existing attempt/stale-handle fence and fixed refusal categories. Do
not retain arbitrary exception text. The current typed/nested proxy code does
not explicitly handle every reflective operation, such as `defineProperty`,
prototype replacement or extensibility changes. This document neither promises
they are captured/refused nor changes them silently. Probe and design their
supported/refused behavior separately before claiming coverage.

### Services, application logs and decisions

Use existing `$call` and adapter boundaries for actual service attempts and
answers, and `$emit`/`$debug`/`$error` for application observations. An unrelated
`fetch`, SDK retry, console call or remote side effect does not become visible
just because the stage has a scope proxy. A delivered answer is not customer
delivery, confirmed external effect or proof an output semantically used it.

Reuse `decide`/`select` evidence for supported decisions. A normal proxy cannot
recover arbitrary local arithmetic, closure values or why an `if` chose a
branch. A new callback that merely collects reads still cannot distinguish a
read that was ignored. Stronger explicit computation/evaluator contracts are a
separate design; this slice adds no `$derive` API.

## 7. Privacy, trust and bounds

Apply existing capture/export/query privacy and host authorization to both
endpoints, path segments, structural answers and evidence basis. Withhold
affected relationships and retain fixed gaps, including existing whole-channel
withholding where required. Do not add another privacy policy or assume opaque
presentation IDs authenticate evidence.

Structural validation, an unkeyed checksum and a storage acknowledgement do not
authenticate a saved producer. A coherent rewrite by a storage writer can pass
consistency checks. The host authorizes the source; deliberate-tampering
resistance requires a separately trusted MAC/signature policy. This proposal
adds no signing or key-management system.

The setting remains opt-in. Default-off execution, scheduling and bytes must
stay unchanged. Enabled mode needs limits on events, per-owner entries, paths,
key-list output, retained bytes and emitted references, with omission counts
that survive saving. Numeric defaults must follow measurement. Shared bounded
prefix/index structures are preferable to copying every prior read into every
write, but representation needs an oracle and cost evidence before selection.

Shared handles are not an end-to-end cost proof. Save/checksum/validation must
not expand a shared prefix into every write, and an emitted-edge cap does not
bound the candidate scans before emission. Charge work and bytes before bulk
allocation or traversal. Pin independent capture-global and per-owner limits,
plus pending work, write associations, serialized bytes, admission work and
query work. Retries must not reset the enclosing capture budget. After an
omitted observation, a later prefix cannot look observed-empty or complete;
retain a bounded, durable omission reason. Earlier closed prefixes need not be
upgraded or rewritten.

Measure incremental association cost and total enabled cost, including existing
key-prefix copying, active-frame pruning, discarded-attempt bookkeeping, save,
reopen and query. Retain value-free identities rather than frames, closures or
business-state generations. Defaults and performance claims wait for actual
implementation measurements; the review's operation-count model is not a
runtime benchmark.

Debuggers, serializers, matchers and proxy housekeeping can invoke traps. Keep
the existing reserved probes out of business reads; record actual exposed
listing/value operations honestly rather than claiming to infer their caller's
intent. A blanket "log every trap" mode must not create authoritative causal
edges or leak values through text formatting.

## 8. Implementation and consumer gates

1. Review the Foottrace-owned observation and occurrence/write contract first.
   Keep exact read source, observed-before-write contributor, recorded control
   and call/adapter evidence separate. No extra linking package or walker.
2. First freeze one public selected-failure/output query and its independently
   reviewed expected evidence. Read an old source, write one output, read the
   source again, then write another output: the first write can exclude the
   later occurrence. If both writes follow both reads, both prefixes remain
   possible contributors and cannot identify which primitive local was used.
   Check whether closed failed-capture admission and the existing execution
   query already meet the consumer's need before adding writer cost.
3. Add the bounded writer/codec/admission support, then engine integration using
   named public ports. Every runtime slice starts with red-first tests.
4. Preserve owner and attempt isolation across retry discard, loops, parallel
   branches, subflows, pauses and resumes. A global last-read pointer cannot
   supply that ownership. Missing, stale, foreign or unsupported ownership stays
   unknown.
5. Test feature-off identity, no added getter/predicate invocation, probe noise,
   redaction of names/structure as well as values, hostile stored data,
   truncation, storage-ack failure and save/reopen equivalence. Measure read,
   write, retained-byte and query costs on increasing workloads. No unbounded
   scans or accidental quadratic retention.
6. Update bounded readers and UI deliberately. Keep evidence basis and gaps;
   temporal prefixes are not promoted merely to obtain a root. Failed-run
   closed-extent admission is a separate contract: a failed execution stays
   failed, and unrecorded or unresolved external work stays unknown.

The generic graph's root currently means a unique earliest supported attention
candidate, not necessarily the cause of a selected thrown error. A failure-facing
consumer must state its selected native failure identity and eligible attention
policy. Freeze the relation/basis/coverage/root-presentation matrix with
Foottrace; complete enumeration of possible contributors must not become
semantic fault proof. A marked ignored read, a handled retry and a contained
sibling must not silently become that selected error's cause.

### Failed capture is closed separately from execution outcome

Version-1/2 native capture notes record an outcome and channel observations;
neither their terminal status nor a storage receipt proves that local evidence
can no longer change. In particular, fail-fast siblings or abandoned promises
can outlive the run's rejection. Component-run retirement is not an evidence
fence for every ordinary scope operation.

A new producer closure contract must explicitly identify the native log segment,
execution/attempt/incarnation extent, pending or abandoned work, covered channels
and the closure boundary. It must say how late observations are excluded or the
bound history is made immutable. Unsupported children, resumes, cancellation or
work that did not settle stay partial with a fixed reason. Local closure never
attests provider cancellation, customer delivery or external effect completion.

The consumer may admit a newly supported closed failed extent only through an
explicit version/capability contract; do not replace its completed-only gate
with a broad terminal-status check. Preserve the failed outcome, original
exception behavior and existing privacy rules even if capture, saving or the
explanation fails. Tests must check the original thrown identity or documented
wrapper behavior, rather than merely checking that some error occurred.

No release, application adoption, network/provider call or deployment is part of
this contract PR.
