# Saved external-call evidence

This feature shipped in footprintjs 11.0.0. It requires the published `foottrace` package at `^1.11.1`. That package's public record APIs supply the record writer and the per-write call-answer
sources described below. Testing against a local, unpublished copy of `foottrace` does not show that a normal install
from the npm registry works or that consumers stay compatible.

## One attempt, separate observations

A native `$call` records an `attempt-start` note immediately before invoking the supplied function. It records the
actual ending `AttemptRecord` in the existing `attempt` note. The start is an invocation observation; a wrapper may
perform local work without sending a network request. Neither note proves receiver acceptance or a committed write.

The existing canonical attempt identity and log address distinguish concurrent calls, retries and run legs.
Targets, payloads, timestamps and idempotency keys are not physical attempt identities. A start and an end are two
observations of one attempt; duplicate delivery is not a repeated provider effect. Conflicting terminal observations
remain ambiguous. An unmatched start leaves the outcome unknown.

The engine builds delivered-answer witness IDs with Foottrace's official `buildAttemptId`, using the owning
runtime stage, stage attempt, allocated call ordinal and actual call attempt. These are the same components held
by the matching saved ending record; a join must also retain its saved log address.

Capture is best-effort and adds no waiting for storage. Sink failure remains capture failure, not evidence that an
external effect failed or never happened. No persist-before-invoke durability profile is supplied. A sink or an
in-memory snapshot alone is not an authoritative receiver journal.

## Explicit adapter observations

`CallOptions.evidence` is an optional capture-only adapter seam. `inputRefs` names the actual retained request/input
references; synchronous `observe(answer)` receives the actual returned answer and reports `outputRefs` and an
optional observed `remoteRequestId`. The numerical or service adapter knows these values; the library does not
inspect arbitrary business answers to discover them. Keep the observation callback pure and synchronous and do not
mutate the answer. Capture observation is not response validation or a release decision.

Reference lists inspect at most the first 32 entries and keep only qualifying entries from that prefix. Entries
beyond that prefix are not inspected. For an admitted list, `inputRefsOmitted` and `outputRefsOmitted` count its
total length minus the retained count, including oversized and unexamined entries. Malformed examined entries
instead refuse capture; omission is not proof that an unexamined entry was valid. Each retained reference, and
an observed remote request ID, is bounded by 200 bytes of its serialized JSON string in UTF-8, including quotes
and escaping. Withhold an oversized ID rather than truncate it into another plausible ID.
Apply the existing redaction policy before retention. Do not replace missing or withheld data with a plausible
captured-empty list, and do not treat an omission count as proof of overall capture coverage.

For example, 198 ASCII `x` characters occupy exactly 200 bytes after the two JSON quotes; 199 occupy 201 and
are withheld. A string containing 99 quote characters also occupies 200 bytes because each quote is escaped;
100 occupy 202. A string of 49 emoji `😀` plus two ASCII characters occupies 200 bytes; adding one more ASCII
character crosses the limit. References must be strings: a numeric reference such as `42` is malformed and is
never coerced into an ID.

Absent `evidence`, explicit `evidence: undefined`, and absent or undefined optional fields mean not supplied.
An observation callback may return `{}` to supply no additional facts. Malformed descriptors/lists/IDs, refused
accessors, a thrown callback, or an unsupported asynchronous callback result instead mark affected notes with
`evidenceRefused: true`. Input refusal marks actual invocation starts and their ending notes; answer-observation
refusal marks only that ending note. An oversized remote ID is withheld and marked refused. Oversized or excess
artifact references use their exact omission counts rather than a refusal flag.

The flag passes the same redaction rule as other call metadata and can itself be withheld. With developer mode
enabled, a refused call series also emits at most one fixed warning with no target, ID, value or exception text.
A series that invokes no work emits no refusal warning. Production leaves these warnings off by default;
malformed evidence still receives the saved refusal disclosure. A throwing warning sink cannot change supplied
work or suppress its evidence note. Refusal is a capture fact, never an external effect outcome or response verdict.
Unsupported ordinary native Promise rejections, including another realm's native Promise, are consumed without
awaiting them; arbitrary Promise subclasses/proxies are outside the synchronous observation contract.

Use non-secret references into retained artifacts or an authorized resolver. Do not put tensors, response bodies,
credentials or live clients in this evidence. The shape or equality of a reference does not authenticate its source.

## Per-write call-answer sources

`writeProvenance: 'reads-prefix'` controls both `TraceEntry.readKeys` and its optional sibling `readAttempts`.
`readKeys` remains state paths; `readAttempts` contains canonical native call-attempt IDs. A business state key that
looks like an attempt ID remains a state key.

The call-answer prefix begins at the native facade's answer-delivery boundary within the owning live stage attempt.
Each write snapshots the prefix then present. An earlier write cannot inherit an answer delivered afterward.
This is a conservative may-have-used ceiling, not proof of arbitrary JavaScript semantic use: a delivered but
unused answer can over-approximate. Mere transport settlement, an unanswered cut, an SDK report or a late answer to
an expired frame does not establish a delivered-answer witness.

Empty or disabled call-source capture leaves the optional field absent. Discard clears that attempt's staged read
prefix; retained notes are not retracted. A later stage's dependencies flow through ordinary state reads rather
than carrying a previous stage's call IDs directly into its own prefix. Repeated-write/delta behavior follows the
existing reads-prefix law and must retain its conservative qualification.

## Interpret effects and old recordings honestly

- `outcome: 'ok'` means answered. A returned 503 is an answer, not success.
- For a touching target, `effect: 'applied'` means answered, not proof of commitment or a write count.
- `AttemptSummary.effect` retains unknown uncertainty from an earlier attempt after a later answer;
  `AttemptSummary.last.effect` describes only the last attempt. Reconcile through the receiver when required.
- A cut in flight has unknown effect and does not prove dispatch. A cut wait creates no extra attempt.
- Preserve pause control signals. An observed SDK attempt has no inferred effect.

11.0.0 replaces reason `succeeded` with `answered`. The stored-row reader admits the historical word as `answered`
at one boundary, with unreadable rows disclosed. It does not reinterpret old summary effects or add missing starts,
references or witnesses. Readable historical ending notes remain useful; missing channels mean no evidence was
recorded, not a complete empty external history. Source coverage remains unknown without retained coverage facts.

Standalone `attempt()` retains its callback reporting contract, including the shared runner's end summary. It has
no native saved-log ownership; the new saved native-call evidence does not invent a standalone run or stage.

## Saved investigation

Use Foottrace's stored notes, address/attempt codec and native value/slice readers. A host adapter can compose the
existing `CauseGraph` ports; no second workflow engine or operation graph is needed. Matching input/output IDs or
timestamps alone cannot create a dependency. Require the actual per-write witness and retain its conservative
ceiling; otherwise present related context and an explicit gap.

Reopening recorded data does not call the provider, resume numerical work, publish, cancel or reconcile anything.
Receiver history and current receiver state remain separate external evidence. The host owns safe source resolution,
normalization and presentation, including named investigation tools and access control.
