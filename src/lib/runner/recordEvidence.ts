import type { LogCollects } from 'foottrace/write';

import type { ReadTrackingMode } from '../memory/frameTypes.js';
import type { ResolvedRecordSink } from './recordSink.js';

/** Native declaration preparation only; the log owns its version and enabled collection. */
export function recordCollects(
  sink: ResolvedRecordSink,
  readTracking: ReadTrackingMode,
): Pick<LogCollects, 'reads'> | undefined {
  return sink.evidence === 'off' ? undefined : { reads: readTracking === 'off' ? 'off' : 'keys' };
}
