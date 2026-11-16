import type { Meta } from 'foottrace';
import type { LogCollects, RecordSink } from 'foottrace/write';

import type { ReadTrackingMode } from '../memory/frameTypes.js';
import { bindResumedEvidence } from '../memory/storedEvidence/index.js';
import type { RuntimeRecord } from './ExecutionRuntime.js';
import type { ResolvedRecordSink } from './recordSink.js';

/** Native declaration preparation only; the log owns its version and enabled collection. */
export function recordCollects(
  sink: ResolvedRecordSink,
  readTracking: ReadTrackingMode,
): Pick<LogCollects, 'reads'> | undefined {
  return sink.evidence === 'off' ? undefined : { reads: readTracking === 'off' ? 'off' : 'keys' };
}

/** The root writer's existing address/meta plus the declaration fixed from its admitted sink option. */
export function rootRecord(
  record: { readonly link: { readonly sink: RecordSink }; readonly meta?: Meta },
  sink: ResolvedRecordSink,
  runId: string,
  readTracking: ReadTrackingMode,
): RuntimeRecord {
  return {
    sink: record.link.sink,
    address: { logRunId: runId, drillPath: [] },
    collects: recordCollects(sink, readTracking),
    ...(record.meta && { meta: record.meta }),
  };
}

/** Native re-entry only: no checkpoint field, stage lookup or inferred mount identity. */
export function resumeEvidence(frame: object, execution: string | undefined): void {
  bindResumedEvidence(frame, execution);
}
