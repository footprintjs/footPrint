import type { CommitBundle } from 'foottrace';

import { HistoryDataError } from './historyData.js';

/** Conservative work cap before each distinct public value query, including shared-root replay/cloning. */
export class SourceReferenceBudget {
  private rows = 0;
  private bytes = 0;
  private readonly queryRows: number;
  private readonly queryBytes: number;

  constructor(commitLog: readonly CommitBundle[], initialState?: Record<string, unknown>) {
    this.queryRows = 1 + commitLog.length + commitLog.reduce((count, bundle) => count + bundle.trace.length, 0);
    this.queryBytes = new TextEncoder().encode(JSON.stringify({ commitLog, initialState })).length;
  }

  spend(): void {
    // The entire admitted basis is an upper estimate for each query; repeat (commit,key) hits spend nothing.
    // Refuse before calling the reader, never after doing unaccounted work or silently cutting evidence.
    if (this.queryRows > 1_000_000 - this.rows || this.queryBytes > 64 * 1024 * 1024 - this.bytes)
      throw new HistoryDataError('source-validation-limit');
    this.rows += this.queryRows;
    this.bytes += this.queryBytes;
  }
}
