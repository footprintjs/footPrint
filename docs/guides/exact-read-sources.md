# Exact read sources: engine wiring (packet 3)

This implementation of issue #113 uses the published native writer API from
Foottrace 1.7.0. Development and CI lock that exact version; the runtime range
requires `^1.7.0`. No unpublished package or local override is shipped.

```ts
const executor = new FlowChartExecutor(chart, {
  initialContext: { count: 1 },
  readSources: true,
  readTracking: 'off', // source occurrences do not require retained read values
});
await executor.run();
const evidence = executor.getSnapshot().readSources;
```

With the option absent or false, existing record, snapshot and sink bytes remain
unchanged. `true` opts into a bounded `readSources` observation and a
version-2 `capture` note. Strict version-1 readers must continue refusing version 2;
consumer adoption is separate. `captureCoverage` alone still produces version 1.

The envelope identifies the current run and half-open commit range. Its optional
`record` is Foottrace's own detached, versioned source book, including native log
address, segment, limits and gaps. An absent book means unknown ownership, **not**
an observed-empty book. `captured` describes this channel, not whole-workflow
completeness or a guaranteed root cause. Read the other capture channels too.

Each tracked occurrence has its native execution identity, optional official
attempt identity, ordinal, canonical state address, root key, disposition and
source descriptor. Uninstrumented attempts explicitly have unavailable identity.
Foottrace selects sources during the actual native read; the engine never guesses
from the final log or stage's last-value read view. The descriptor can identify a
base, committed version or staged generation, or say unavailable with a reason.
A staged generation may later be discarded or produce no committed change.
Reading a value before writing an unrelated constant proves no semantic derivation.

## Deliberate limits in this slice

- Exact candidates are scalar root observations. Undefined presence, nested or
  composite values, untracked mutation and exhausted budgets remain named gaps.
  Foottrace's finite default limits apply; there is no model-selected budget. The
  host may explicitly set `readSources: { limits: { maxOccurrences: 16000,
  maxBytes: 8 * 1024 * 1024 } }` within the immutable wire-v1 ceilings. Settings
  are copied and frozen from plain data at setup, using only the five declared
  native fields. Reclamation frees live metadata, never retained occurrences;
  reaching the default 4,096 occurrences/1 MiB still discloses counted omissions.
- Privacy retains its existing **read, then one verdict** order. The native port's
  additive value-free callback evaluates the existing rule once per selected key,
  after the native read. Its decision is pure and name-only: read-prefix and
  coverage-gap bookkeeping run immediately after the callback, before returning
  to stage code, including when a verdict throws. A failed native read adds no
  read-prefix entry. The default-off path keeps its existing ordering. The same
  verdict governs retained values. Selected keys withhold source precision and record `privacy-active`;
  unrelated clear keys keep their native candidate. It never repeats the read or
  implements a second matcher. Candidate/frame/owner identity is pinned before
  verdict reentrancy; a thrown verdict preserves its original error and records a gap.
  Source evidence contains no values or fingerprints; root-key names retain the
  existing record law. A redacted snapshot withholds the entire reference channel,
  including references captured before a later mark.
- Custom scopes cannot claim observed-empty capture. Untracked reads and unsupported
  scope paths are disclosed. A child's book is never borrowed from its parent:
  child invocations explicitly report `child-source-ownership` unknown for now.
- Fresh root runtimes also support sink-backed native source capture. The record's
  public writer port owns the same source book and log; opened metadata, native
  commit delivery and sink failure accounting retain their existing owners.
  An unsupported or mismatched sink scope remains unknown.
- Both kinds of resume report `resumed-source-ownership` unknown. Same-executor
  resume retires the previous binding instead of retrofitting a reused log. Version-2
  pause checkpoints keep a summary with `source-history-not-included`, downgrade
  source coverage to unknown, and copy no occurrences. Checkpoints never enable
  capture or restore old origins.
- Completed books are sealed and retired, so late work cannot extend a terminal
  observation. Prefix snapshots remain detached.
- With explicit `captureCoverage: true` and `sink.capture`, the saved evidence includes
  the original `readSources` envelope in its digest and storage receipt. Reload it
  with `readStoredCapture` from `footprintjs/trace`; a verified result exposes it as
  `history.readSources`. See [saved capture history](saved-capture-history.md).
  The native observation still says `persistence: 'memory-only'`: storage authority
  belongs only to the separate receipt. Partial, failed and unknown observations
  retain those statuses even when their bytes were durably acknowledged.

The stored-history reader is extended; cause/PROV readers, applications and UI
are not upgraded here. Issue #124's existing
read-after-delete bug remains a separate fix; this feature records native selection
without treating that defect as a promise. No model call is needed for these facts.
