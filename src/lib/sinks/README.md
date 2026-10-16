# sinks/ — the crash-safe record on a Node host (10.1, P6)

The ONLY place in `src/` that imports a Node built-in, reached only through the `footprintjs/sinks` door
(`test/architecture/layering.test.ts` pins both). The port (`RecordSink`, `memorySink`) is foottrace's; the run's side
— serving every entry under the redaction rule, counting losses, the `'fail'` mode, flushing — is
`runner/recordSink.ts · RunRecord`.

## The rule

A file sink writes ONLY the path it was given, opened once; each entry is ONE JSON line, encoded whole and written
with ONE append before the call returns; it never grows past `maxBytes`. A process killed at any instant leaves every
entry it was told about — at worst a torn last line, which `readRecordFile` names by number and which never swallows
the next entry.

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
