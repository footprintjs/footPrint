import { EventLog } from 'foottrace/write';

import type { RuntimeRecord } from './ExecutionRuntime.js';

/**
 * The runtime's log: with a record, the log that writes to the sink as it lands. A base the sink cannot carry (it
 * must be a plain object) is the sink's loss, never the run's — the log is then the plain one, and the loss is
 * reported to the sink like any other (`RecordSink.onFailure`), so the run's accounting names it.
 */
export function openLog(base: Record<string, unknown>, record: RuntimeRecord | undefined): EventLog {
  if (record)
    try {
      return new EventLog(base, record);
    } catch (error) {
      try {
        record.sink.onFailure?.({
          entry: { kind: 'opened', address: record.address, at: Date.now(), initialState: {} },
          error,
        });
      } catch {
        // The run's own sink isolates its listener; an app's raw adapter here is told once, best effort.
      }
    }
  return new EventLog(base);
}
