# Exact read sources — #113 implementation contract

Status: **design and executable witnesses only; no source channel is implemented by this PR.**
Based on FootPrint main `3078a560` (includes #122) and its locked Foottrace 1.3.0.
The same resolution boundary was checked against Foottrace main `bb437dc6`.
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

## 3. Existing laws, with executable witnesses

`test/lib/runner/read-source-witnesses.test.ts` exercises public
`foottrace/write` APIs and the engine's current frame. It asserts actual values
and recorded rows, without implementing a source finder.

| Witness | Consequence for the new channel |
| --- | --- |
| A first-touch read keeps 1 after a sibling commits 2 | The latest preceding commit is not necessarily the source |
| A key absent from that pinned view later reads a sibling's 2 | A first-touch generation alone is not enough either |
| Identical commit logs accompany different observed read values | Commit-log-only reconstruction is underdetermined |
| Reads see 1, staged 2 and staged 3; the commit retains the final change | Keep each occurrence and intermediate generation |
| Staged 2 followed by a revert to 1 emits no changed row | A staged source cannot be assigned a fictitious commit entity |
| A no-op write also produces no changed row | Equal values are not proof of identical provenance |
| A parent read combines an untouched base field with a changed child | A single last writer cannot describe every container |
| Array/object merges combine portions | Unsupported composition must stay a gap |
| An addressed undefined falls back to the global root | Record the selected physical address, not just the requested one |
| A staged unset/delete can read the live value again | Staging does not prove the read selected that staged value |
| Literal `a.b` and nested `a` → `b` collapse to one display prefix today | Retain canonical segments; never split or parse the display name |
| Discard reanchors on current live state | Attempts need distinct provenance ownership |
| Release reanchors even a reused frame | Frame identity alone is not a source version |
| Repeated engine reads leave one last value in `stageReads` | The old per-key view cannot substitute for an occurrence channel |

These tests prove the design constraints, **not** that source capture exists.
Further lifecycle, security, bounds and persistence tests below are release
gates for implementation, not claimed passing feature tests in this PR.

## 4. Proposed record facts

Names below describe a proposed contract; public declarations and codecs
must be owned by Foottrace, reviewed there before FootPrint imports them.
Do not add a second runtime-stage, attempt, path or log-ID grammar in FootPrint.

Each occurrence needs:

- A versioned, scope-local ordinal in actual read order; repeated reads remain
  repeated. The native log address, invocation/segment and execution identify
  its scope. Use the canonical attempt reference when an attempt exists;
  an uninstrumented attempt is explicitly unavailable, not a made-up attempt 0.
- Requested canonical path segments and the actually selected address/path
  **only when privacy permits**. A root object read followed by ordinary
  property access is one root read, not fabricated nested reads.
- One bounded resolution descriptor, separate from values, and a distinction
  between exact, composite and unavailable evidence. No values, fingerprints,
  error strings, credential material or user-key-derived IDs.

| Source form | Evidence required | What a consumer may conclude |
| --- | --- | --- |
| Recorded base | Exact scope/base identity and selected portion from an admitted initial state | This read selected that base portion; not a committed write |
| Committed version | Same-scope recorded commit and representable row/portion identity, captured when applied | This read selected that recorded version |
| Staged generation | Frame incarnation, attempt and monotonic staging generation, captured when staged | The read selected that generation; it need not survive commit |
| Composite | Explicit disjoint contributing portions and each portion's source, within limits | Only the supported portions are known; never substitute one whole-value writer |
| Unavailable | A fixed reason and known scope/order facts, without hidden path/name | Missing, redacted, unsupported, untracked, trimmed or otherwise unknown evidence |

An occurrence selecting JavaScript `undefined` is not by itself proof of a
missing property. The resolver must distinguish an absent property from an own
undefined property only where it can establish that without executing extra
user code. Otherwise say `undefined-presence-unknown`. Inherited properties,
accessors and externally mutated borrowed objects are not assumed to have a
tracked writer. Inspecting state twice to make this distinction is forbidden.

A committed generation can contain many writers. A heap generation ID is not
a write ID. A source portion records the relevant origin, not merely the
generation counter. Direct heap writes and mapper changes without an admitted
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
   Reads resolve from its actual working copy and fallback branch. A parent
   and its changed descendants need portion metadata, not a boolean flag.
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
value-free privacy instruction. Whole/field-level marks, identity inheritance
and a mark added mid-run must affect every later retained projection of the
new channel, including earlier occurrences. If a portion cannot be safely
separated, withhold that occurrence's source details rather than leak it.

No keyed object table or ID may expose hidden names. Opaque ordinals must not
be hashes of paths or values. With a changing redaction rule, do not emit
named read-source facts to an irreversible sink before privacy is final.
An interim export must withhold those names or use opaque facts with explicit
gaps; it cannot promise to retract an already exported name. Existing sink
base/commit privacy laws are unchanged by #113. Live provenance is separate.

Proposed finite default budgets, to be measured and fixed in the writer-port PR:

| Resource | Proposed ceiling |
| --- | --- |
| Retained occurrences | 1,024 per execution and 10,000 per native log segment |
| Contributing portions | 16 per read |
| Canonical path | 64 segments, 256 UTF-8 bytes per segment |
| Identity string | Reuse canonical validators, additionally capped at 1,024 UTF-8 bytes |
| Serialized source channel | 4 MiB per native log segment, including gaps |
| Retained source-index entries / staged generations | 10,000 / 4,096 per native log segment |

Hosts may reduce limits; invalid/non-finite/fractional limits are refused at
setup with fixed errors. Charge work, paths, index entries and bytes before
allocating retained evidence. Bound intermediate composition work too, not
just its output. Reserve space for named loss reasons and saturating omission
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
   default budgets and privacy policy before freezing new public shapes.
2. **Foottrace writer port:** public value-free types/codecs and opt-in
   instrumentation at heap/frame/buffer resolution, isolated from the engine.
   Capture an exact simple base/committed source and independent staged
   generations first; unsupported composition is explicit. Publish no
   precision that its tests cannot establish. New public API needs a minor
   release and deliberate FootPrint development-lock/export-test adoption.
3. **FootPrint integration:** one option/policy path, occurrence ownership,
   attempt/discard/release/subflow lifecycle, redaction and source coverage.
   The new channel is separate from existing final-attempt value views.
4. **Persistence and readers:** source-envelope admission, durable history,
   checkpoint omissions and same/fresh resume boundaries. Share validation
   rules and preserve #122's missing-value sidecar and timeout/lease laws.
5. **Consumer adoption:** Foottrace exact-`used`/gap tests, then AgentFootprint,
   Blueprint, Smallbusiness, investigator and Charming Cherubs only after
   reviewed releases. Local synthetic acceptance precedes Gamma.

No packet is called “#113 complete” until every acceptance row below is
implemented or explicitly reports its conservative unsupported gap. Optional
subsets can ship first with their limitations, not with false completeness.

## 10. Required implementation tests (not implemented by this contract PR)

- **Default-off identity:** old/new package comparisons of snapshot, history,
  observer and sink bytes for sequential, parallel, retry, loop, pause/resume,
  subflow and failure scenarios. Off allocates no origin book and adds no await.
- **Occurrence/source:** every witness in section 3 extended with actual source
  assertions; missing vs own undefined vs deleted; initial bases and direct
  unlogged mutations; repeated writes and discarded/no-op/reverted generations;
  parent/child overlap, arrays, merges and unsupported rich values.
- **Lifecycle:** deterministic signals for sibling interleavings; loops,
  drilled/repeated mounts, continuations, discarded retries, late abandoned
  attempt calls, pauses, both resume kinds, fresh runs and clear. No sleeps
  to arrange a race. No reference crosses its declared scope or incarnation.
- **Granularity:** a root object read followed by property access records one
  root occurrence; literal dotted/slashed/empty/unicode keys stay path segments.
- **Security:** late whole/field/identity redaction; hidden names absent from
  IDs/paths/maps/gaps; hostile stored getters, prototype keys and `toJSON`;
  two tenants/runs sharing an adapter; no values, digests or arbitrary errors
  in the channel; no extra getter invocation or observer-driven mutation.
- **Bounds:** each budget, repeated saturation, invalid setup, huge compositions,
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
