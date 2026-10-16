# sinks/ — the crash-safe record on a Node host (10.1, P6)

The ONLY place in `src/` that imports a Node built-in, reached only through the `footprintjs/sinks` door
(`test/architecture/layering.test.ts` pins both). The port (`RecordSink`, `memorySink`) is foottrace's; the run's side
— serving every entry under the redaction rule, counting losses, the `'fail'` mode, flushing — is
`runner/recordSink.ts · RunRecord`.

A failing adapter's `onFailure` receives the same served entry it was handed and a structured error with no raw payload. A refusal before dispatch is counted and honours `onFailure: 'fail'`, but is not forwarded to the adapter listener: no safe dispatched entry exists. The run retains sink-error text as `errors.recordSinkError`; `diagnostics: { keys: ['errors.recordSinkError'] }` masks it in warnings, stats and observers. Only the caller's `RecordSinkError.cause` keeps the real error.

## The rule

A file sink writes ONLY the path it was given, opened once; each entry is ONE JSON line, encoded whole and queued —
no method blocks; each line gets its own offset and its write is handed to the I/O pool at once. Every resource is bounded and
every refusal is named and counted by the run: `maxEntryBytes`, `maxQueuedBytes` (drop-and-count), `maxBytes` (then
full), `flushTimeoutMs`. An entry is on disk once a libuv pool thread wrote it — the pool is shared (DNS, zlib,
crypto), so a busy pool widens the window a kill can lose entries in; `readRecordFile` reports every hole. One sink
per file per PROCESS: two processes on one path overwrite each other (flush detects it, best effort). A torn line — a failed write, a process killed mid-write — is named by `readRecordFile` and
never swallows the next entry.

```typescript
import { flowChart, FlowChartExecutor } from 'footprintjs';
import { fileSink, readRecordFile } from 'footprintjs/sinks';
import { readStoredRecord } from 'foottrace';

const chart = flowChart<{ orderId?: string }>('Receive order', (scope) => {
  scope.orderId = 'A-17';
}, 'receive').build();

const sink = fileSink('/var/footprint/orders.jsonl', { maxBytes: 16 * 1024 * 1024 });
await new FlowChartExecutor(chart, { sink }).run();

const { entries, unreadable } = readRecordFile('/var/footprint/orders.jsonl');
const record = readStoredRecord(entries); // record.root(runId)?.complete — false for a run that never ended
```

Files: `fileSink.ts` (the sink and its reader), `node.d.ts` (the few `node:fs` / `node:path` declarations it uses;
the package ships no `@types/node` and no public signature names a Node type).
