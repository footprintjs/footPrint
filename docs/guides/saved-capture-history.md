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
recorder snapshot rows. It does not copy shared state, subflow results or a second
commit log. Reads and values follow the existing redaction law before dispatch.
The evidence is detached as inert JSON data: accessors and `toJSON` never run;
cycles, rich values such as Dates and Maps, non-finite numbers, negative zero and
other JSON losses refuse the whole export. Only the known optional frame/bundle fields use the existing omitted-field JSON
representation. Undefined retained values, read/write keys, recorder data and array
values refuse the export rather than silently removing evidence.

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

## Bounds and failures

The capability accepts `maxBytes` (default 1 MiB, 1–8 MiB) and `timeoutMs`
(default 10,000, 1–30,000 milliseconds). The byte cap applies to the evidence plus
target, and separately to the commit/base digest input. The reader admits at most
four times `maxBytes` of inert entry data in addition to Foottrace's existing
`StoredRecordLimits`, and retains the same per-component cap. Copying has a
100,000-node, depth-256 bound. Evidence is refused whole rather than trimmed.

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
root. Exact read sources remain `not-collected` pending #113. Child scopes and
resumed segments are not admitted as complete root histories by this slice;
legacy records without the protocol stay unknown. Checkpoints remain lean and
carry their existing memory-only observation, not a storage receipt. No second
causal walker, AgentFootprint adoption or application deployment is included.
