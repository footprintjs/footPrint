# Saved capture history

`captureCoverage` observes native capture in memory. It does not prove storage.
To save that observation together with its evidence, explicitly configure a
capture-capable sink. Existing sink streams and ordinary snapshots are unchanged
when `sink.capture` is absent. No model calls are involved.

```typescript
import { FlowChartExecutor, flowChart } from 'footprintjs';
import { fileSink, readRecordFile } from 'footprintjs/sinks';
import { controlDepRecorder, readStoredCapture } from 'footprintjs/trace';

async function saveHistory(path: string): Promise<void> {
const sink = fileSink(path);
try {
  const chart = flowChart('Work', () => undefined, 'work').build();
  const executor = new FlowChartExecutor(chart, {
    captureCoverage: true,
    writeProvenance: 'reads-prefix',
    sink: { adapter: sink, capture: sink },
  });
  executor.attachFlowRecorder(controlDepRecorder({ captureCoverage: true }));
  await executor.run();
  const file = readRecordFile(sink.path);
  if (file.unreadable.length) throw new Error('Unreadable stored entries');
  const saved = await readStoredCapture(file.entries, { runId: executor.getSnapshot().runId });
  console.log(saved.status);
} finally {
  await sink.close();
}
}
```

The local file capability acknowledges after draining and `fsync`. It retains the
file adapter's existing one-writer, filesystem and process-kill limits. This is
not a claim about replication, a remote cloud service or a filesystem's power-loss
guarantees. A host brings another vendor by implementing the same
`CaptureHistoryOptions.acknowledge(target, { signal })` capability alongside its
`RecordSink`. It must resolve a receipt only after that exact target's evidence,
commits, starting state and end entry are durably stored. A void return, a drain,
a promise that only queued work, or a normal `flush()` is not that assertion.
Use the same storage prefix for both capabilities. The host owns authorization,
retention, tenant isolation and the truth of the storage assertion.

## What is saved

After the normal run settles and its end entry is flushed, the engine writes one
`capture-history` opaque note. It carries the bounded native note, the existing
execution-tree projection (including retained reads, writes and attention), and
recorder snapshot rows. With `readSources` enabled it also carries the source
observation, ordered occurrences and explicit omissions. It does not copy shared
state, subflow results or a second
commit log. Reads and values follow the existing redaction law before dispatch.
The evidence is detached as inert JSON data: accessors and `toJSON` never run;
cycles, rich values such as Dates and Maps, non-finite numbers, negative zero and
other JSON losses refuse the whole export. Undefined object properties follow standard JSON omission, without a snapshot-field allow-list.
For immediate `stageReads` / `stageWrites` entries, the export instead saves
`absent`: a sorted, unique list of literal path segments, for example
`["executionTree", "next", "stageReads", "count"]`. The list is inside the evidence
digest. It preserves the fact that an own tracked entry held `undefined`; it does
**not** prove the underlying state property never existed. Exact read sources
remain separate (#113). Nested undefined business-object properties and optional
metadata follow ordinary JSON absence. Array undefined values and holes remain refused.

`readStoredCapture` returns this list as `history.absent`, detached and frozen.
Consumers must read it alongside `executionTree`, rather than casting the JSON
projection alone to an ordinary complete native snapshot. No undefined values are
silently restored into the maps. Canonical Foottrace commit operations retain
undefined-write semantics; use `stateAt` / `commitValueAt` instead of enumerating
raw JSON `overwrite` keys, which do not preserve undefined members. Older evidence
without an absent list remains readable. Invalid, duplicate, unsorted, conflicting
or out-of-scope markers are refused, even if their digest was rewritten.

The target binds the native run, root address, half-open commit range, evidence
identity and a SHA-256 digest of the exact JSON evidence plus the served starting
state and canonical commit log. This is representation integrity, not a value
fingerprint standard, signature or proof against an authorized writer forging
records. Reordering object keys can make an externally rewritten export unknown;
ordinary JSON round trips preserve the representation. The redaction policy active when each write or record was served governs those
bytes. Capture does not retroactively scrub historical sink entries. Values
already redacted when served contribute only their redacted representation. A
later policy change can therefore make admission unknown. A later trimmed,
changed or redacted export cannot reuse the original digest unnoticed.

After evidence delivery, the explicit adapter acknowledges that target. Only then
is its fixed-field `capture-receipt` note written. The receipt attests the preceding
evidence and end entry, not its own delivery. The final flush determines the live
`snapshot.sink.capture` result. A missing receipt after reload is always unknown.
A receipt actually recovered from authorized storage records the adapter's prior
assertion; the reader cannot independently audit that adapter or infer durability
from a memory buffer. Adapter errors never enter the receipt or reader reason. With `onFailure: 'fail'`,
a later required storage-delivery loss rejects the leg with its own unknown-stage
failure diagnostic. The immutable native note still describes the preceding
execution prefix, which may have completed before persistence failed.
The native `capture.persistence` stays `memory-only` and keeps
`storage-not-attested`: storage authority lives in this separate envelope.

With the local file adapter, capture adds three fsync operations: evidence delivery,
explicit acknowledgement and receipt delivery. These are in addition to the existing
automatic closing-entry flush/fsync. The acknowledgement is intentionally separate
from an arbitrary adapter's flush promise. Disk latency therefore affects save latency;
measure on the deployment's storage before choosing a tighter `timeoutMs`. No slow-disk
measurement is claimed here.

## Bounds and failures

The capability accepts `maxBytes` (default 1 MiB, 1–8 MiB) and `timeoutMs`
(default 10,000, 1–30,000 milliseconds). The byte cap applies to the evidence plus
target, and separately to the commit/base digest input. The reader admits at most
four times `maxBytes` of inert entry data in addition to Foottrace's existing
`StoredRecordLimits`, and retains the same per-component cap. Copying has a
100,000-node, depth-256 bound. The absent list has at most 4096 paths, each at most 256 segments;
its UTF-8 bytes and the evidence share the same byte cap. Exceeding these size
limits refuses the whole export rather than trimming observations. A size-budget
refusal reports `evidence-too-large` (or `history-too-large` on reload), identifying
a size limit rather than presenting malformed data as the cause.

The total persistence wait has one timeout, signals cancellation to the adapter,
and never blindly retries. An unsettled timed-out operation retains its executor's
single lease until it really settles; later runs report `acknowledgement-pending`
instead of accumulating more calls. Late callbacks cannot write receipts or
change a later run's result. The execution guard stays held while persistence is
being awaited. Capture-specific refusal is reported in `sink.capture` without
turning a successful business operation into a failed operation; ordinary sink
entry/flush losses still follow the configured sink failure mode.

`readStoredCapture` first admits bounded inert entries, then uses Foottrace's
existing `readStoredRecord` for address, sequence, end coverage, gaps and unread
entries. It checks one unambiguous matching evidence/receipt pair and its digest.
Missing commits, receipts or endings, conflicts, reader limits and unsupported
metadata return a fixed `unknown` reason, never inferred completion. Returned
history is detached and frozen. A closed log alone is insufficient: the killed
writer test has a closed run and saved evidence but no receipt, and stays unknown.

An acknowledged paused, failed or cancelled prefix keeps that native boundary.
Disabled/summary/unknown channels and redaction limitations remain as observed.
Acknowledgement is not full capture, business health or a guarantee of a unique
root. With `readSources` disabled, version-1 notes still report `not-collected`. Source-enabled
histories retain the version-2 note and expose `history.readSources` only after its
scope, descriptor format, commit references, status and digest pass admission. The
original source envelope remains `memory-only`; its recovered receipt records the
storage adapter's assertion. A stored `captured` channel does not prove semantic
use or make a partial run complete. Child scopes and
resumed segments are not admitted as complete root histories by this slice;
legacy records without the protocol stay unknown. Checkpoints remain lean and
carry their existing memory-only observation, not a storage receipt. No second
causal walker, AgentFootprint adoption or application deployment is included.


## Durable exact read-source history

The [runnable local example](../../examples/runtime-features/crash-safe-record/03-exact-read-history.ts)
is checked against the built package.

Configure `readSources: true` alongside `captureCoverage: true` and the explicit
`sink: { adapter, capture }` capability shown above. The source metadata and missing-value
markers share the existing evidence-byte and timeout limits. Ordinary flushes do
not acknowledge sources. Missing receipts, changed source metadata, source/header
scope conflicts, unrecognized descriptor fields and out-of-range or wrong-key
commit references return `unknown`. No URI or other run is fetched to resolve them.
The reader reuses Foottrace's public descriptor codec and path rules; it does not
reconstruct source choices from the log. Base and committed selections, staged
generations, retry-discarded occurrences and unavailable reasons keep their native
meaning. Staged generations are not joined to a later commit by comparing values.


An occurrence budget can produce an acknowledged **partial** history: the saved
subset and counted omissions survive intact. A total persistence-byte limit instead
refuses the history whole before requesting a receipt; it never truncates a source
list to make the save fit. Redaction runs before evidence leaves the engine. If it
masks protocol fields needed for admission, persistence stays unknown. The existing
read-time redacted snapshot still withholds its reference channel entirely.


The original observed-empty versus unobserved distinction is preserved. A healthy
fresh root with no tracked reads can save a captured empty book. A child or resumed
scope without proven ownership cannot acquire that claim. Lean checkpoints still
omit source history and cannot restore it or enable capture. Acknowledged failure
history records the failure boundary; it is not a successful workflow or a proven
root cause. Cause/PROV adapter adoption remains separate.


Stored admission verifies descriptor syntax, root identity/extent, and each occurrence's
execution-tree owner and independent native read counts. With source capture enabled,
each owned stage saves `readSourceCounts: { observed, retained, kinds }`, including zero.
The fixed `kinds` histogram counts the native writer’s returned base, committed,
staged and unavailable labels; it never classifies values itself. Both totals and
kind counts must agree with the occurrence list, so a single unavailable label
cannot be silently promoted to an exact base label.
The counters are collected during the native read, kept across discarded attempts,
and independent of `stageReads` deduplication and the `readTracking` dial. The retained
count must equal the number of saved occurrences for that execution, even when the
source book is partial; a dropped tail cannot silently become observed-empty.

A committed source must precede the reading execution's first own commit. Its
referenced value must be a supported scalar and not redacted; the public Foottrace
value reader owns set/merge/delta interpretation. Base selections must also point
to a scalar. These are consistency checks of already recorded labels, never a
reconstruction of which value was read. A failed-stage read without an own commit
cannot establish a committed-source claim. Advanced raw-context reads after the
execution's own commit are conservatively refused for saved source history in this
slice; a later `repeat`/`exit` continuation cannot loosen the cutoff for earlier reads.
Their persistence remains unknown, without changing the workflow's business result.
Staged generations still have no inferred link to a later committed entity.

### Integrity is not authentication

The SHA-256 checksum has **no secret key**. These checks detect corruption and
inconsistent edits, including when someone recomputes the checksum, but they are
**not tamper-proof**. Anyone able to rewrite storage can also rewrite counts,
commit labels, capture status, the digest and the receipt into a self-consistent
forgery. The reader cannot prove that such a record came from the engine. Storage
authorization remains the host's responsibility; deliberate-tampering resistance
needs a host-verified keyed MAC or signature with a separately trusted key and
verification policy. This API does not add or verify that authentication.

### Reference-validation work limits

Before each uncached `(commit index, canonical path)` value query, admission charges
a conservative whole-basis estimate: one plus the commit and trace-row counts,
and the encoded bytes of the admitted commit/base evidence. Cumulative ceilings
are 1,000,000 row-work units and 64 MiB of encoded-basis work. Repeated pairs reuse
the query-local result. Exceeding either cap returns `unknown` with
`source-validation-limit`, without truncating evidence or asking the producer’s
adapter to acknowledge it. Large valid histories can conservatively exceed this
validation limit even if they fit the persistence byte cap. These are work
estimates, not a measured latency or allocation guarantee.
