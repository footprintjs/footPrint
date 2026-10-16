/**
 * footprintjs/sinks — where a run's crash-safe record goes on a Node host (10.1, design §3.5).
 *
 * NODE ONLY. This door imports `node:fs`; it is the one door that does (`test/architecture/layering.test.ts`), so
 * every other door stays loadable in a browser. The port itself — `RecordSink`, and the reference `memorySink()` —
 * is foottrace's (`foottrace/write`); the reader is `readStoredRecord` (`foottrace`).
 *
 * @example
 * ```typescript
 * import { flowChart, FlowChartExecutor } from 'footprintjs';
 * import { fileSink, readRecordFile } from 'footprintjs/sinks';
 * import { readStoredRecord } from 'foottrace';
 *
 * const executor = new FlowChartExecutor(chart, { sink: fileSink('/var/footprint/orders.jsonl') });
 * await executor.run({ input });
 *
 * // After a crash — in another process:
 * const record = readStoredRecord(readRecordFile('/var/footprint/orders.jsonl').entries);
 * for (const log of record.logs.values()) if (!log.complete) console.log('never finished:', log.address);
 * ```
 */

export type { FileSink, FileSinkOptions, RecordFile } from './lib/sinks/fileSink.js';
export {
  DEFAULT_FILE_SINK_FLUSH_TIMEOUT_MS,
  DEFAULT_FILE_SINK_MAX_BYTES,
  DEFAULT_FILE_SINK_MAX_ENTRY_BYTES,
  DEFAULT_FILE_SINK_MAX_QUEUED_BYTES,
  fileSink,
  readRecordFile,
} from './lib/sinks/fileSink.js';
