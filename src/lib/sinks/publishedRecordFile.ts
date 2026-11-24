import { type FoldedState, type LogAddress, type StoredLog, readStoredRecord, stateAt } from 'foottrace';

import { checkSignal, IndexedRefusal, invalidIndexedData, refused } from './indexedAdmission.js';
import { assertIdentity } from './indexedIO.js';
import { type IndexedReadContext, type IndexedReadStats, openIndexedSession } from './indexedSession.js';
import type { IndexedRecordUnknown } from './indexedTypes.js';
import { readPublication } from './publishedRecordIndex.js';
import { type PublishedOmissionReason, readPublishedRows } from './publishedRecordRows.js';
import {
  type PublishedRecordFileOptions,
  type PublishedScope,
  prefixRanges,
  publishedLimits,
  readPublishedIndex,
} from './publishedRecordSelection.js';
import type { PublishedRecordFile } from './publishedRecordWriter.js';

export interface PublishedScopeResult {
  readonly status: 'loaded';
  /** All selected ranges and native rows were admitted. Foottrace still owns native completion. */
  readonly coverage: 'whole';
  readonly entries: readonly unknown[];
}

export interface PublishedStateResult {
  readonly status: 'loaded';
  readonly coverage: 'prefix' | 'whole';
  readonly state: FoldedState;
  /** Genuine pause closing positions visible in the selected prefix. */
  readonly pauses: readonly number[];
}

export interface PublishedRecordUnknown extends IndexedRecordUnknown {
  /** Distinct reasons from this authorized selection. Directory positions remain private. */
  readonly omissions?: readonly { readonly reason: PublishedOmissionReason }[];
}

export interface PublishedRecordReader {
  readScope(address: LogAddress, context?: IndexedReadContext): Promise<PublishedScopeResult | PublishedRecordUnknown>;
  readState(
    address: LogAddress,
    throughCommit: number,
    context?: IndexedReadContext,
  ): Promise<PublishedStateResult | PublishedRecordUnknown>;
  close(): Promise<void>;
}

export type PublishedRecordFileResult =
  | {
      readonly status: 'ready';
      readonly reader: PublishedRecordReader;
      /** Physical I/O is for the trusted host. Serve only results from the reader. */
      readonly diagnostics: { readonly stats: Readonly<IndexedReadStats> };
    }
  | PublishedRecordUnknown;

function unavailable(reasons: readonly PublishedOmissionReason[]): PublishedRecordUnknown {
  return {
    status: 'unknown',
    reason: reasons[0],
    omissions: Object.freeze(reasons.map((reason) => Object.freeze({ reason }))),
  };
}

function admitNativeLog(rows: StoredLog['entries'], maxEntries: number): StoredLog {
  const first = rows[0];
  if (first === undefined) throw new IndexedRefusal('unavailable');
  const stored = readStoredRecord(rows, {
    entries: maxEntries,
    missingCommits: rows.length,
  });
  const log = stored.log(first.address);
  if (stored.unread.length || log?.initialState === undefined) throw new IndexedRefusal('unavailable');
  return log;
}

/** Open an authorized local publication. The trusted host supplies the independent binding, never the sidecar. */
export async function openPublishedRecordFile(
  dataPath: string,
  indexPath: string,
  publication: PublishedRecordFile,
  options: PublishedRecordFileOptions,
): Promise<PublishedRecordFileResult> {
  const limits = publishedLimits(options);
  let binding: PublishedRecordFile;
  try {
    binding = readPublication(publication, limits.audience);
  } catch (error) {
    return refused(error);
  }
  const opened = await openIndexedSession(
    dataPath,
    limits,
    (_fd, identity, signal, stats) => readPublishedIndex(indexPath, identity, binding, limits, signal, stats),
    (fd, identity, scopes, session) => {
      const scopeFor = (key: string): PublishedScope => {
        const scope = scopes.get(key);
        if (!scope) throw new IndexedRefusal('no-match');
        return scope;
      };
      const load = async (key: string, ranges: PublishedScope['ranges'], signal: AbortSignal, stopAt?: number) => {
        const result = await readPublishedRows(
          fd,
          key,
          ranges,
          limits,
          signal,
          session.count,
          session.submitted,
          stopAt,
        );
        assertIdentity(fd, identity);
        checkSignal(signal);
        return result.status === 'omitted' ? unavailable(result.reasons) : result;
      };
      const reader: PublishedRecordReader = Object.freeze({
        readScope(address: LogAddress, context?: IndexedReadContext) {
          return session.read(address, context, async (key, signal) => {
            const result = await load(key, scopeFor(key).ranges, signal);
            if (result.status === 'unknown') return result;
            const log = admitNativeLog(result.rows, limits.maxEntries);
            if (log.gaps.length) throw new IndexedRefusal('unavailable');
            return Object.freeze({
              status: 'loaded' as const,
              coverage: 'whole' as const,
              entries: log.entries,
            });
          });
        },
        readState(address: LogAddress, throughCommit: number, context?: IndexedReadContext) {
          return session.read(address, context, async (key, signal) => {
            if (!Number.isSafeInteger(throughCommit) || throughCommit < -1) invalidIndexedData();
            if (throughCommit >= limits.maxEntries) throw new IndexedRefusal('too-large');
            const scope = scopeFor(key);
            const ranges = prefixRanges(scope, throughCommit);
            const close = ranges.at(-1)?.closedThrough;
            const stopAt = close !== undefined && close <= throughCommit ? undefined : throughCommit;
            const result = await load(key, ranges, signal, stopAt);
            if (result.status === 'unknown') return result;
            const log = admitNativeLog(result.rows, limits.maxEntries);
            const folded = stateAt(log.source(), throughCommit);
            if (folded.throughCommitIdx !== throughCommit || folded.skipped?.length)
              throw new IndexedRefusal('unavailable');
            const pauses = log.entries.flatMap((row) =>
              row.kind === 'closed' && row.outcome === 'paused' && row.commits - 1 <= throughCommit
                ? [row.commits - 1]
                : [],
            );
            return Object.freeze({
              status: 'loaded' as const,
              coverage: result.rows.length === scope.rowCount ? ('whole' as const) : ('prefix' as const),
              state: folded,
              pauses: Object.freeze(pauses),
            });
          });
        },
        close: session.close,
      });
      const diagnostics = Object.freeze({
        get stats() {
          return session.stats();
        },
      });
      return { reader, diagnostics };
    },
  );
  return opened.status === 'ready' ? { status: 'ready', ...opened.reader } : opened;
}
