import { type FoldedState, type LogAddress, readStoredRecord, stateAt } from 'foottrace';

import { checkSignal, IndexedRefusal, refused } from './indexedAdmission.js';
import { assertIdentity } from './indexedIO.js';
import { type IndexedReadContext, type IndexedReadStats, openIndexedSession } from './indexedSession.js';
import type { IndexedRecordUnknown } from './indexedTypes.js';
import {
  type PublishedRecordFileOptions,
  type PublishedScope,
  prefixRanges,
  publishedLimits,
  readPublication,
  readPublishedIndex,
} from './publishedRecordIndex.js';
import { type PublishedOmission, planOmissions, readPublishedRows } from './publishedRecordRows.js';
import type { PublishedRecordFile } from './publishedRecordWriter.js';

export interface PublishedScopeResult {
  readonly status: 'loaded';
  /** Storage coverage of this scope. Native capture completeness and loss still come from Foottrace. */
  readonly coverage: 'whole';
  readonly entries: readonly unknown[];
  readonly bytesRead: number;
}

export interface PublishedStateResult {
  readonly status: 'loaded';
  readonly coverage: 'prefix' | 'whole';
  readonly state: FoldedState;
  /** Genuine pause closing positions visible in the selected prefix. */
  readonly pauses: readonly number[];
  readonly bytesRead: number;
}

export interface PublishedRecordUnknown extends IndexedRecordUnknown {
  readonly omissions?: readonly PublishedOmission[];
}

export interface PublishedRecordReader {
  readonly stats: Readonly<IndexedReadStats>;
  readScope(address: LogAddress, context?: IndexedReadContext): Promise<PublishedScopeResult | PublishedRecordUnknown>;
  readState(
    address: LogAddress,
    throughCommit: number,
    context?: IndexedReadContext,
  ): Promise<PublishedStateResult | PublishedRecordUnknown>;
  close(): Promise<void>;
}

export type PublishedRecordFileResult =
  | { readonly status: 'ready'; readonly reader: PublishedRecordReader }
  | PublishedRecordUnknown;

function unavailable(omissions: readonly PublishedOmission[]): PublishedRecordUnknown {
  return {
    status: 'unknown',
    reason: omissions[0].reason,
    omissions: Object.freeze(omissions.map((omission) => Object.freeze(omission))),
  };
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
  return openIndexedSession(
    dataPath,
    limits,
    (_fd, identity, signal, stats) => readPublishedIndex(indexPath, identity, binding, limits, signal, stats),
    (fd, identity, scopes, session): PublishedRecordReader => {
      const scopeFor = (key: string): PublishedScope => {
        const scope = scopes.get(key);
        if (!scope) throw new IndexedRefusal('no-match');
        return scope;
      };
      const load = async (key: string, ranges: PublishedScope['ranges'], signal: AbortSignal) => {
        const omissions = planOmissions(ranges, limits);
        if (omissions.length) return unavailable(omissions);
        const result = await readPublishedRows(
          fd,
          key,
          ranges,
          limits.maxEntryBytes,
          signal,
          session.count,
          session.submitted,
        );
        assertIdentity(fd, identity);
        checkSignal(signal);
        return result.status === 'omitted' ? unavailable([result.omitted]) : result;
      };
      return Object.freeze({
        get stats() {
          return session.stats();
        },
        readScope(address: LogAddress, context?: IndexedReadContext) {
          return session.read(address, context, async (key, signal) => {
            const result = await load(key, scopeFor(key).ranges, signal);
            if (result.status === 'unknown') return result;
            return {
              status: 'loaded' as const,
              coverage: 'whole' as const,
              entries: Object.freeze(result.rows),
              bytesRead: result.bytesRead,
            };
          });
        },
        readState(address: LogAddress, throughCommit: number, context?: IndexedReadContext) {
          return session.read(address, context, async (key, signal) => {
            if (!Number.isSafeInteger(throughCommit) || throughCommit < -1) throw new IndexedRefusal('invalid-data');
            if (throughCommit >= limits.maxEntries) throw new IndexedRefusal('too-large');
            const scope = scopeFor(key);
            const ranges = prefixRanges(scope, throughCommit);
            const result = await load(key, ranges, signal);
            if (result.status === 'unknown') return result;
            const stored = readStoredRecord(result.rows, {
              entries: limits.maxEntries,
              missingCommits: limits.maxEntries,
            });
            const log = stored.log(result.rows[0].address);
            if (stored.unread.length || !log?.initialState || log.gaps.some((gap) => gap.index <= throughCommit))
              throw new IndexedRefusal('unavailable');
            const folded = stateAt(log, throughCommit);
            if (folded.throughCommitIdx !== throughCommit) throw new IndexedRefusal('unavailable');
            const pauses = log.entries.flatMap((row) =>
              row.kind === 'closed' && row.outcome === 'paused' && row.commits - 1 <= throughCommit
                ? [row.commits - 1]
                : [],
            );
            return {
              status: 'loaded' as const,
              coverage: ranges.length === scope.ranges.length ? ('whole' as const) : ('prefix' as const),
              state: folded,
              pauses: Object.freeze(pauses),
              bytesRead: result.bytesRead,
            };
          });
        },
        close: session.close,
      });
    },
  );
}
