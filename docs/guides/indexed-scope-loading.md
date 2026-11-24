# Load one authorized saved scope

`openIndexedRecordFile` is an optional **Node-only** reader from `footprintjs/sinks`. It prepares an in-memory byte-range index for one immutable JSONL file written by `fileSink`. Query-time reads use only the selected scope's ranges. It does not load the whole archive and then filter it on each query.

## 1. Bind host authorization first

The host chooses a private file it is allowed to read and an explicit `allowedScopes` list of exact `LogAddress` values. The list is copied at setup. A request cannot supply a new filename, tenant, run or scope outside that list. Addresses contain the native log run ID and actual mount invocation IDs, not stage labels. The index never grants access merely because it contains a run.

Authorization to **prepare this entire file** belongs to the host. Preparation reads every byte once, including entries outside the selected scopes, to locate and validate the index. Do not hand an untrusted caller this capability. The reader returns no discovered run catalog, file descriptor or mutable index. Raw values are exposed only when the trusted host requests an authorized scope.

## 2. Prepare once, after closing the writer

The explicit preparation pass is bounded by file bytes, encoded line bytes and entry count. It stores only authorized byte ranges and SHA-256 digests, not the archive's values. A malformed line, hole, torn tail or exhausted limit refuses the entire preparation; it never silently builds an incomplete index.

The host path is opened once with no-follow/non-blocking flags where supported. Non-regular files, hard links, another owner's files and group/world-writable files are refused on POSIX. The reader keeps that descriptor until `close()`; it never constructs or reopens a path from recorded names. Windows ownership/mode/no-follow protections differ, as they do for `fileSink`.

## 3. Read only the selected ranges

```typescript
import { openIndexedRecordFile } from 'footprintjs/sinks';
import { readStoredRecord } from 'foottrace';

async function loadAuthorizedRoot(path: string, runId: string) {
  const address = { logRunId: runId, drillPath: [] };
  const opened = await openIndexedRecordFile(path, { allowedScopes: [address] });
  if (opened.status !== 'ready') return opened;
  try {
    const loaded = await opened.reader.readScope(address);
    if (loaded.status !== 'loaded') return loaded;
    return readStoredRecord(loaded.entries);
  } finally {
    await opened.reader.close();
  }
}
```

Every selected line's digest and exact address are checked again. File device/inode, size, modification and change times must remain unchanged before and after each read. A file modified after preparation is `stale`; close the session and prepare a fresh authorized one. Live-mutating archives, portable/persistent indexes and remote object stores are separate adapters, not supported by this file reader.

`reader.stats.preparationBytes` counts bytes returned during the one preparation scan. `scopeBytes` counts bytes returned by successful completed scope reads, including bytes later refused by validation. `readCalls` counts scope read submissions, including failed and still-pending requests; a short-read continuation counts as another submission. Repeated scope requests reread their bytes; the loader does not cache values. The offline tests independently count Node's read requests and prove that selecting one scope does not reread an unrelated scope.

## 4. Admit records and receipts separately

A `loaded` result means only **selected bytes were read and matched the prepared file**. Pass them to Foottrace's public `readStoredRecord` and FootPrint's `readStoredCapture`. Missing receipts, incomplete capture, unsupported source ownership and child scopes remain unknown. A parent's receipt never attests a child; the loader does not synthesize native capture notes or exact source bindings.

For cause/impact questions, the existing canonical `createStoredRecordGraph` accepts a host `loadLog(address, context)` callback that calls `readScope` and returns its raw entries. It owns graph preparation and traversal. An existing UI `InvestigationPort` may delegate `explain` to that graph; bind its identity to this authorized session and replace it when the run/scope changes. Do not label a raw graph complete when required attention/control/source projections have not been admitted. The runnable [indexed scope example](../../examples/runtime-features/crash-safe-record/04-indexed-scope-loading.ts) preserves those gaps explicitly.

The digests detect changes relative to preparation. **They are not keyed signatures, producer authentication or protection against deliberate edits made before preparation.** A host that controls the file can rewrite it and prepare a new index. Storage acknowledgement and producer truth remain separate trust decisions.

## Bounds and cancellation

All limits are positive whole numbers; invalid, null, excessive, accessor-backed or unknown options are refused before opening. There are at most 256 explicitly authorized scopes, each at most 64 address segments of 2,048 characters. Defaults and hard ceilings:

| Setting | Default | Maximum |
| --- | --- | --- |
| `maxBytes` | 64 MiB | 256 MiB |
| `maxEntryBytes` | 8 MiB | 8 MiB |
| `maxEntries` | 16,384 | 65,536 |
| `maxScopeBytes` | 8 MiB | 64 MiB |
| `timeoutMs` | 10,000 ms | 30,000 ms |

Each reader permits one in-flight scope read. A concurrent request returns `busy`. Cancellation is checked before opening and between I/O steps; `readScope` accepts `{ signal }`. A deadline bounds preparation/read waiting, with a final elapsed-time check after synchronous work. **Synchronous file opening, metadata checks and JSON parsing cannot be preempted by a timer.** A timed-out or cancelled filesystem read retains its slot and descriptor until it actually settles. Late bytes are never returned as a successful result.

`close()` immediately refuses new work and releases the descriptor after active work settles. It is idempotent. Fixed `unknown` reasons contain no path, payload or raw filesystem error: `cancelled`, `timeout`, `unavailable`, `invalid-data`, `too-large`, `not-permitted`, `no-match`, `stale`, `busy`, `closed`. None is a healthy/complete result.

## Publish an index with a new recording

A host that writes its own served record can use `indexedFileSink(dataPath, { audience })` and finish with `await sink.seal(indexPath)`. Both paths must be fresh, host-chosen files. Seal drains and synchronizes the data and its index. On POSIX it also synchronizes their parent directories. The host stores the returned publication in its authoritative recording catalog under the recording revision and serving policy. Keep it separate from the index. The publication binds the index digest and byte count to the immutable payload identity and size.

The indexed writer stores the existing native JSON lines, including optional capture evidence when supplied. The index records bounded byte ranges and names known omissions without storing state or event values itself. Use separate served recordings for different audiences, apply the existing producer's redaction before writing, and keep the index and its offsets private. Older records and the existing indexed scanner remain supported.

## Open the published recording

Resolve the data path, index path and independent publication from the host's authorized catalog. Call `openPublishedRecordFile(dataPath, indexPath, publication, { audience, allowedScopes })` from `footprintjs/sinks`. Opening reads the index and checks its binding to the pinned payload. Missing or replaced indexes produce an unknown result. The host controls the exact allowed log addresses.

- `readScope(address)` loads the authorized scope's complete stored rows. It verifies the selected ranges and refuses a missing native fold base or a native commit gap. Foottrace still owns native completion, including the distinction between an authentic pause and a terminal result.
- `readState(address, throughCommit)` returns state only if the native fold reaches that commit. It reports `prefix` or `whole` storage coverage and real pause positions. A cold seek can fetch the complete preceding range sequence. A supplied prefix cannot certify later ranges of the same log.
- `unknown` can include the distinct omission reasons for the authorized selection. Physical range IDs and positions stay private. The published path reads at most 16 MiB per selection and enforces the row, line, and nested-value budgets before interpreting payloads.

Close the published reader when it is no longer needed. An aborted or timed-out operation retains its slot until the I/O settles.
