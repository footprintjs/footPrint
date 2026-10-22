# Exact read sources — #113 implementation contract

Status: **design and executable witnesses only; no source channel is implemented by this PR.**
Based on FootPrint main `3078a560` (includes #122) and its locked Foottrace 1.3.0.
The same 15 native-resolution witnesses were also checked against released Foottrace 1.6.0;
that verification does not change this repository's deliberate development lock.
This is the first reviewable slice of [issue #113](https://github.com/footprintjs/footPrint/issues/113).
It does not close that issue, change capture defaults, release either library or update an app.

## 1. The promise

For every tracked read occurrence we elect to capture, record what source the
native read operation actually selected. Preserve occurrence order and scope;
do not reconstruct the answer from the completed log. When the runtime cannot
establish a source, record a named gap. An exact source is evidence about a
read, not evidence that a later computation used it to produce another value.

The default remains off. No-option and explicit-off executions must keep the
same records, snapshots, observers, sink entries, outcomes and scheduling.
No model, remote lookup or network call belongs in capture or its tests.

## 2. Why this crosses the record/engine boundary

The existing source of truth is split as follows:

| Owner | Existing operation | What it knows that its caller does not |
| --- | --- | --- |
| Foottrace `RecordFrame` | `read`, `firstTouch`, `release`, `discard` | Whether a value came from its pinned view, working copy or live fallback, and when a view was replaced |
| Foottrace `SharedMemory` | `getValue`, `setValue`, `updateValue`, `applyPatch` | Address-to-root fallback and committed state generation changes, including direct writes without a log row |
| Foottrace `TransactionBuffer` | `get`, `set`, `merge`, `delete`, `commit` | Staged generations, contributing portions and net-change filtering |
| FootPrint `StageContext` | `readRetainedValue`, `discardStaged`, `snapshotSelf` | Which operation is a tracked read; execution, attempt, privacy and retention lifecycle |
| FootPrint runtime | root/subflow creation, resume, clear | Native log address, invocation/segment identity, mount and boundary |

`RecordFrame.read()` currently returns only the value. `SharedMemory.getValue()`
also returns only the value, hiding the addressed/root choice. `noteRead()` is
a deduplicated display-name registry for **possible** per-write dependencies.
Neither that registry nor `StageSnapshot.stageReads` is an occurrence list.

FootPrint cannot repair this by searching the log, comparing values,
interrogating private fields, or calling `wasStaged()`. It would duplicate the
record's law and still miss cases. The first implementation dependency is a
public, opt-in Foottrace writer port that reports resolution **inside these
operations**, with no reverse dependency on the engine.

There must still be one read: no diagnostic second call to `get`, no extra
getter invocation, and no change to when private copies are made. The port
must return the existing value with a bounded description, not let an observer
choose the value or alter execution. Disabled mode must bypass all new books.

## 3. Current behavior, with executable witnesses

`test/lib/runner/read-source-witnesses.test.ts` exercises public
`foottrace/write` APIs and the engine's current frame. It asserts actual values
and recorded rows, without implementing a source finder.

| Witness test name (verbatim) | Consequence for the new channel |
| --- | --- |
| `keeps a first-touch value even after another frame commits a newer version` | The latest preceding commit is not necessarily the source |
| `lets a first-touch-missing key see a sibling commit through the live fallback` | A first-touch generation alone is not enough either |
| `can produce identical commit logs after different observed read values` | Commit-log-only reconstruction is underdetermined |
| `serves several staged generations although the commit keeps only the final change` | Keep each occurrence and intermediate generation |
| `never has a committed entity for a staged write that is later reverted` | A staged source cannot be assigned a fictitious commit entity |
| `does not create a committed entity for a no-op write either` | Equal values are not proof of identical provenance |
| `composes a parent value from untouched base portions and a staged child` | Composite resolution is `unavailable: 'composite-unsupported'` in v1 |
| `composes arrays and object merges without making each element a separately observed read` | Unsupported composition must stay a gap |
| `falls from an undefined namespaced value back to the global root` | Record the selected physical address, not just the requested one |
| `BUG #124: an unset/delete in %s mode currently reads the old live value` | Today's behavior is a known read-your-writes defect, not a contract law; the parameterized witness runs once for `full` and once for `delta` |
| `does not use dotted display names as canonical paths` | A literal root-key name is not a nested path; nested reads stay unsupported in v1 |
| `discard drops staged state and reanchors the next attempt on live state` | Attempts need distinct provenance ownership |
| `release reanchors the same frame after its commit` | Frame identity alone is not a source version |
| `retains the last read value in the engine view rather than an ordered list of reads` | The old per-key view cannot substitute for an occurrence channel |

The read-after-delete behavior is tracked separately in [issue #124](https://github.com/footprintjs/footPrint/issues/124).
The scope guide promises that a stage sees its own uncommitted writes, so this
witness deliberately labels a defect. The source channel must report the source
the read actually selected (`committed` or `base` today), not infer `staged`
merely because a deletion was requested. When that defect is fixed, update the
witness to the corrected staged resolution; that is not a change to this
contract. The runtime fix is outside this PR.

These tests establish current observations and the known defect, **not** that source capture exists.
Further lifecycle, security, bounds and persistence tests below are release
gates for implementation, not claimed passing feature tests in this PR.

## 4. Proposed record facts

Names below describe a proposed contract; public declarations and codecs
must be owned by Foottrace, reviewed there before FootPrint imports them.
Do not add a second runtime-stage, attempt, path or log-ID grammar in FootPrint.

### 4.1 Frozen v1 — the only shape packet 2 may publish

One occurrence per tracked read of a **root key**, in actual read order, scoped
by the native log address and runtime-stage ID (plus the canonical attempt
reference when one exists). Repeated reads remain repeated. An uninstrumented
attempt is explicitly unavailable, never a made-up attempt 0.

`source` is exactly one of four forms:

| Source form | Evidence required | What a consumer may conclude |
| --- | --- | --- |
| `base` | Exact scope/base identity for the selected root key from an admitted initial state | This read selected that base; not a committed write |
| `committed` | Same-scope recorded commit index for the selected root key, captured when applied | This read selected that recorded version |
| `staged` | Frame incarnation and monotonic staging generation, captured when staged | The read selected that generation; it need not survive commit |
| `unavailable` | One fixed reason and known scope/order facts | Missing, redacted, unsupported, untracked, trimmed or otherwise unknown evidence |

Fixed unavailable reasons include `composite-unsupported`, `redacted`,
`untracked-write`, `undefined-presence-unknown`, `budget-exhausted` and
`capture-failed`. Nested and composite reads are
`unavailable: 'composite-unsupported'` in v1. A root object read followed by
ordinary property access is one root occurrence; never fabricate nested reads.
A literal root-key name containing dots or slashes stays one key, not a path to
split or parse. No values, fingerprints, error strings, credential material or
user-key-derived IDs belong in the descriptor.

### 4.2 After v1 — separate versions and consumer-driven PRs

Nested canonical paths, disjoint contributing portions and a composite source
shape are **after v1**. They may be added only in a new version in their own PR,
when a consumer test needs them. Packet 2 must not publish them. Until then,
parent/child overlap and merge composition report the fixed unsupported gap;
they must not borrow a whole-value writer. The native resolution port still
has to identify these unsupported cases without an extra read.

An occurrence selecting JavaScript `undefined` is not by itself proof of a
missing property. The resolver must distinguish an absent property from an own
undefined property only where it can establish that without executing extra
user code. Otherwise say `undefined-presence-unknown`. Inherited properties,
accessors and externally mutated borrowed objects are not assumed to have a
tracked writer. Inspecting state twice to make this distinction is forbidden.

A committed generation can contain many writers. A heap generation ID is not
a write ID. A v1 descriptor records the relevant root-key origin, not merely
the generation counter. Direct heap writes and mapper changes without an admitted
recorded row stay `untracked-write`; they cannot borrow an unrelated commit.

Read-before-write prefixes remain a different, weaker channel. Keep the
existing `readKeys` meaning and bytes; do not silently reinterpret it as exact
read versions or semantic derivation.

## 5. Capture at the native choice, not after it

1. Foottrace's opted-in heap maintains bounded origin metadata as writes land,
   alongside its existing state timeline. This is not another commit log or
   a reverse log scanner. First-touch frames retain the origin view associated
   with the generation they actually pinned, without cloning state.
2. The buffer assigns a new staged generation to each admitted operation.
   Reads resolve from its actual working copy and fallback branch. In v1, a
   parent combined with changed descendants is explicitly unsupported; portion
   metadata belongs to a later version, never a boolean shortcut.
3. The frame returns resolution information from that same read. FootPrint
   attaches native execution/attempt ownership only for the tracked operation
   and applies its redaction owner before retaining/serving metadata.
4. Commit admission records only surviving net changes. It must not relabel
   earlier staged reads as reads of the final committed value. A future
   representable relation between a surviving generation and a row is a
   separate explicit relation, never inferred from equal values or paths.
5. Retry discard drops active staging/first-touch source state. Earlier read
   occurrences remain evidence of the failed attempt, explicitly labelled as
   discarded. They cannot become dependencies of the succeeding attempt.
6. Release closes a frame incarnation; a later reuse gets a fresh source
   incarnation even under the same runtime-stage ID. A new run and clear
   cannot borrow prior ordinals, generation books, bases or coverage notes.

Source metadata must not keep every old state generation alive. Its bounded
origin structures may share metadata, never retain raw state or values as
source evidence. Saturation invalidates affected precision explicitly; it
must not silently reuse a stale origin after a newer write was not indexed.

## 6. Privacy and resource limits

Untrusted inputs include state keys, arbitrary values, user callbacks,
redaction marks, scope factories, stored records and checkpoint JSON.
Protect values, hidden names, credentials and separation among runs, attempts,
branches, repeated mounts and tenants. Metadata is not authorization.

Use FootPrint's existing `RedactionRule` as the decision owner. Do not add a
second key matcher in Foottrace. Foottrace accepts an already decided,
value-free privacy instruction.

The channel follows the record's existing redaction law: the decision is taken
when an occurrence is captured, using `RedactionRule` and the marks known at
that moment, and marks carry forward; nothing is scrubbed retroactively.
v1 records root-key names only; redaction masks values and named fields, never
a root key's name, which the served record already carries. A case this law
does not cover goes to the owner as a separate decision, not a second law
inside this channel.

IDs are opaque ordinals, never hashes of paths or values. A root-key name must
not encode values or redacted nested fields. A redacted or inseparable source
withholds its details with a fixed gap. Existing sink base/commit privacy laws
are unchanged by #113. A future nested channel or live provenance stream must
receive its own privacy review before exposing additional path information.

Proposed finite ceilings for measurement, **not frozen defaults**. Packet 2 must
set its v1 defaults from the checked-in benchmark below; it may not silently
retain these proposals without measurements:

| Resource | Proposed ceiling |
| --- | --- |
| Retained occurrences | 1,024 per execution and 10,000 per native log segment |
| Contributing portions (**after v1**) | 16 per read; no portion allocation in v1 |
| Nested canonical path (**after v1**) | 64 segments, 256 UTF-8 bytes per segment; v1 retains only its root-key name |
| Identity string | Reuse canonical validators, additionally capped at 1,024 UTF-8 bytes |
| Serialized source channel | 4 MiB per native log segment, including gaps |
| Retained source-index entries / staged generations | 10,000 / 4,096 per native log segment |

Hosts may reduce limits; invalid/non-finite/fractional limits are refused at
setup with fixed errors. Charge work, paths, index entries and bytes before
allocating retained evidence. v1 must bound unsupported-case detection work;
a future composite version must also bound intermediate composition work. Reserve space for named loss reasons and saturating omission
counts, so a full list cannot erase the fact it was truncated. Loss counts
must not expose hidden names or claim an exact count after counting stops.

Collector/index failure must not change business success, retry decisions,
exception identity or scheduling. Withhold precision and record a fixed
failure reason. A throwing privacy decision must follow the engine's
existing privacy/error law, never be treated as permission to disclose.

## 7. Completeness and persistence

The current `NativeCaptureNote` v1 still says `readSources: 'not-collected'`.
Do not change it in this design PR or interpret #122's receipt as source
capture. A completed run, a storage receipt and exact source resolution are
three separate facts.

An implementing FootPrint PR must introduce a versioned opt-in source-channel
envelope and an explicit coverage vocabulary. Its statuses distinguish at
least disabled, captured, partial, failed and unknown, and observed-empty from
not observed. It must not make existing v1 parsers accept new completeness
claims accidentally. Decide the capture-note version migration explicitly in
that PR; off-mode v1 records must remain byte-identical.

Snapshots must return detached immutable metadata, including mid-run snapshots.
Saved-history envelopes must preserve this metadata and its omissions under
#122's existing evidence digest and explicit adapter acknowledgement. Reuse
the bounded inert JSON admission and the note-validation owner; never run
getters, `toJSON`, coercion hooks or callbacks from stored data. Do not treat a
digest as proof of origin, authorization or honest coverage.

Checkpoints remain operational and small: no full history or state-generation
graph is copied in. They must carry an explicit source-history omission and
resume boundary when prior occurrences are not saved. A resumed segment gets
its own source ownership; it cannot present a prior checkpoint's base as a
recorded write in the new log. Same- and fresh-executor resumes need separate
tests. Child logs never borrow their parent's coverage note or source index.

Malformed, legacy, unscoped, unavailable or cross-run references stay unknown.
A reader validates identity, segment, occurrence order, row bounds, canonical
paths and declared omissions before admitting an exact reference. Trimming or
JSON loss must disclose the affected scope and withhold precise answers.

## 8. Consumer rules

Foottrace remains the sole owner of cause/impact traversal and PROV translation.
Consumers load only authorized records. No adapter may scan other runs or
fetch a URI to resolve a source reference automatically.

The PROV reader may emit `prov:used` only for an exact, retained, representable
source with its defining entity present in the admitted output. Staged,
composite, dropped, hidden, omitted or unavailable sources require gaps when
the exporter cannot represent them. Do not silently convert them to the
nearest committed writer. A source omitted by the export size limit cannot
leave a dangling exact `used` assertion.

Even a fully captured exact read followed by an unrelated constant write
does **not** justify `prov:wasDerivedFrom`. The existing possible-derivation
label remains weaker. The LLM can describe only validated evidence and gaps;
it does not recover missing reads or turn a candidate into a root.

## 9. Implementation packets and review gates

Each packet gets offline tests written before its code, then an independent
security review, then an independent code review. Send each final PR for the
owner's external review before merging. Do not bypass that gate by stacking
an unreviewed implementation under this contract PR.

1. **This PR:** contract and native-resolution witnesses; production/public
   bytes unchanged. Review the identities, conservative supported subset,
   the frozen v1 and privacy policy before implementing new public shapes.
2. **Foottrace writer port:** public value-free types/codecs and opt-in
   instrumentation at heap/frame/buffer resolution, isolated from the engine.
   Publish **only §4.1's frozen v1**: root-key ordered occurrences with `base`,
   `committed` (commit index), `staged` (frame incarnation/generation), or
   `unavailable` (fixed reason). Nested/composite cases are
   `composite-unsupported`; portions and deep-path budgets are after v1.
   Publish no precision that its tests cannot establish.

   Packet 2 ships (a) a counted off-mode test — option absent: zero origin-book
   allocations and zero added awaits per read, asserted by counters; and (b)
   a checked-in benchmark reporting time added per tracked read, bytes retained
   per 1,000 occurrences, and the origin index's time and retained-memory cost
   at its 10,000-entry ceiling. Record the baseline, setup, sample sizes and
   reproducible command; distinguish measurement from a guarantee. Set §6's
   v1 default budgets from those results. If cost is unacceptable, reduce the
   supported subset or budget before shipping, never hide the cost.

   New public API needs a minor release and deliberate FootPrint
   development-lock/export-test adoption. Persistence/checkpoint/consumer
   packets below are planning only: decide whether to build them after the
   measured packet-2 cost and a consumer test justify them.

3. **FootPrint integration:** one option/policy path, occurrence ownership,
   attempt/discard/release/subflow lifecycle, redaction and source coverage.
   The new channel is separate from existing final-attempt value views.
4. **Persistence and readers:** source-envelope admission, durable history,
   checkpoint omissions and same/fresh resume boundaries. Share validation
   rules and preserve #122's missing-value sidecar and timeout/lease laws.
5. **Consumer adoption:** Foottrace exact-`used`/gap tests, then consumer
   applications, only after reviewed releases. Local synthetic acceptance
   precedes a hosted test environment.

No packet is called “#113 complete” until every acceptance row below is
implemented or explicitly reports its conservative unsupported gap. Optional
subsets can ship first with their limitations, not with false completeness.

## 10. Required implementation tests (not implemented by this contract PR)

- **Default-off identity:** old/new package comparisons of snapshot, history,
  observer and sink bytes for sequential, parallel, retry, loop, pause/resume,
  subflow and failure scenarios. A counted test asserts zero origin-book
  allocations and zero added awaits per read with the option absent.
- **Enabled-mode cost:** the checked-in packet-2 benchmark reports time added
  per read, retained bytes per 1,000 occurrences, and the 10,000-entry origin
  index's cost; measured results determine the v1 default budgets.
- **Occurrence/source:** every witness in section 3 extended with actual source
  assertions; missing vs own undefined vs deleted; initial bases and direct
  unlogged mutations; repeated writes and discarded/no-op/reverted generations;
  parent/child overlap, arrays, merges and unsupported rich values.
- **Lifecycle:** deterministic signals for sibling interleavings; loops,
  drilled/repeated mounts, continuations, discarded retries, late abandoned
  attempt calls, pauses, both resume kinds, fresh runs and clear. No sleeps
  to arrange a race. No reference crosses its declared scope or incarnation.
- **Granularity:** a root object read followed by property access records one
  root occurrence; literal dotted/slashed/empty/unicode root keys stay intact.
  Nested/composite reads have `composite-unsupported` in v1; their later
  path/portion shapes require separate consumer-driven PRs.
- **Security:** capture-time whole/field/identity redaction and forward-only
  marks; root-key names follow the served record, redacted nested fields and
  values never enter IDs/maps/gaps; hostile stored getters, prototype keys and `toJSON`;
  two tenants/runs sharing an adapter; no values, digests or arbitrary errors
  in the channel; no extra getter invocation or observer-driven mutation.
- **Bounds:** each v1 budget, repeated saturation, invalid setup, unsupported compositions,
  UTF-8 sizes and hidden-name counting. Loss invalidates stale origin entries;
  a full occurrence list still reports omitted/unknown evidence.
- **Persistence:** JSON snapshot/history round trips, real file storage,
  receipt tampering/missing receipt, undefined-read/write sidecars, truncation,
  malformed and legacy notes, checkpoint history omissions and resumed scopes.
- **Consumer proof:** one exact committed source supports `used`; changing its
  scope or omitting its entity withholds it. Read-then-unrelated-constant never
  emits semantic `wasDerivedFrom`. Composite/staged/filtered cases stay honest.
- **Architecture:** one native resolution timeline; named public Foottrace
  imports; no engine-owned clone of source codecs, commit walker or record
  validation; no Foottrace → FootPrint import; no provider or model call.

The feature can then support “which recorded version did this read receive?”
It still cannot prove business causation, provider internals, that untracked
JavaScript did not run, or facts that were never captured.
