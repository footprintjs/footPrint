import type { LogAddress } from 'foottrace';

/** Host authorization is fixed before any stored entry is read. It is never inferred from the index. */
export interface IndexedRecordFileOptions {
  readonly allowedScopes: readonly LogAddress[];
  /** Preparation scans at most this many file bytes. Default 64 MiB, maximum 256 MiB. */
  readonly maxBytes?: number;
  /** Maximum encoded JSON line. Default 8 MiB, maximum 8 MiB. */
  readonly maxEntryBytes?: number;
  /** Maximum entries indexed across the file. Default 16,384, maximum 65,536. */
  readonly maxEntries?: number;
  /** Maximum bytes read by one selected-scope request. Default 8 MiB, maximum 64 MiB. */
  readonly maxScopeBytes?: number;
  /** Bounds each preparation/read wait; unfinished filesystem work retains its slot. Default 10s, maximum 30s. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type IndexedRecordFileReason =
  | 'cancelled'
  | 'timeout'
  | 'unavailable'
  | 'invalid-data'
  | 'too-large'
  | 'not-permitted'
  | 'no-match'
  | 'stale'
  | 'busy'
  | 'closed';

export interface IndexedRecordUnknown {
  readonly status: 'unknown';
  readonly reason: IndexedRecordFileReason;
}

export interface IndexedRecordScope {
  readonly status: 'loaded';
  /** Raw untrusted entries for public readStoredRecord/readStoredCapture; loading grants no completeness. */
  readonly entries: readonly unknown[];
  readonly bytesRead: number;
}

/** One immutable-file selection capability. No path, descriptor, mutable index or discovered run catalog is served. */
export interface IndexedRecordFile {
  /** Returned-byte counters and actual scope-read submissions (including failed and pending requests). */
  readonly stats: { readonly preparationBytes: number; readonly scopeBytes: number; readonly readCalls: number };
  readScope(
    address: LogAddress,
    context?: { readonly signal?: AbortSignal },
  ): Promise<IndexedRecordScope | IndexedRecordUnknown>;
  /** Stop new work immediately, release the descriptor after in-flight work settles. Idempotent. */
  close(): Promise<void>;
}

export type IndexedRecordFileResult =
  | { readonly status: 'ready'; readonly reader: IndexedRecordFile }
  | IndexedRecordUnknown;

/** @internal Only the preparation pass produces ranges; they never cross the public boundary. */
export interface IndexedRange {
  readonly offset: number;
  readonly bytes: number;
  readonly digest: string;
}

export interface IndexedLimits {
  readonly allowed: ReadonlySet<string>;
  readonly maxBytes: number;
  readonly maxEntryBytes: number;
  readonly maxEntries: number;
  readonly maxScopeBytes: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}
