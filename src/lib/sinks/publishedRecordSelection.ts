import { CommitRangeIndex } from 'foottrace';

import { ownData } from '../capture/noteShape.js';
import { indexedAddress, indexedLimits, IndexedRefusal, validIndexedAudience } from './indexedAdmission.js';
import { assertIdentity, closeDescriptor, fileIdentity, openIndexedDescriptor, readBytes } from './indexedIO.js';
import type { IndexedFileIdentity, IndexedReadStats } from './indexedSession.js';
import type { IndexedLimits, IndexedRecordFileOptions } from './indexedTypes.js';
import { decodePublishedRecordIndex } from './publishedRecordIndex.js';
import { type PublishedRecordFile, type PublishedRecordRange } from './publishedRecordWriter.js';

export interface PublishedRecordFileOptions extends IndexedRecordFileOptions {
  /** The audience selected by the trusted host for this request. */
  readonly audience: string;
  /** Limits encoded bytes of the selected native rows. The host also caps physical I/O at 16 MiB. */
  readonly maxScopeBytes?: number;
}

export interface PublishedScope {
  readonly ranges: readonly PublishedRecordRange[];
  readonly commits: CommitRangeIndex<number>;
  readonly rowCount: number;
}

export function publishedLimits(options: PublishedRecordFileOptions): IndexedLimits & { readonly audience: string } {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype)
    throw new TypeError('openPublishedRecordFile: explicit host authorization required');
  const audience = ownData(options, 'audience');
  if (!validIndexedAudience(audience)) throw new TypeError('openPublishedRecordFile: explicit audience required');
  return { ...indexedLimits(options, true), audience };
}

export async function readPublishedIndex(
  path: string,
  identity: IndexedFileIdentity,
  publication: PublishedRecordFile,
  limits: IndexedLimits,
  signal: AbortSignal,
  stats: IndexedReadStats,
): Promise<Map<string, PublishedScope>> {
  if (identity.size > limits.maxBytes) throw new IndexedRefusal('too-large');
  if (identity.key !== publication.payload.key || identity.size !== publication.payload.size)
    throw new IndexedRefusal('stale');
  const fd = openIndexedDescriptor(path);
  try {
    const indexIdentity = fileIdentity(fd);
    if (indexIdentity.size !== publication.indexBytes) throw new IndexedRefusal('stale');
    const data = await readBytes(fd, 0, indexIdentity.size, signal, (bytes) => (stats.preparationBytes += bytes));
    assertIdentity(fd, indexIdentity.key);
    const index = decodePublishedRecordIndex(data, publication, identity);
    return selectPublishedScopes(index.ranges, limits.allowed);
  } finally {
    await closeDescriptor(fd);
  }
}

function selectPublishedScopes(
  ranges: readonly PublishedRecordRange[],
  allowed: ReadonlySet<string>,
): Map<string, PublishedScope> {
  const scopes = new Map<
    string,
    { ranges: PublishedRecordRange[]; commits: CommitRangeIndex<number>; rowCount: number }
  >();
  for (const range of ranges) {
    const address = indexedAddress(range.address);
    if (!allowed.has(address)) continue;
    const scope = scopes.get(address) ?? { ranges: [], commits: new CommitRangeIndex<number>(), rowCount: 0 };
    const slot = scope.ranges.length;
    scope.ranges.push(range);
    scope.rowCount += range.rowCount;
    if (range.firstCommit !== undefined && range.lastCommit !== undefined)
      scope.commits.close(scope.commits.open(slot, range.firstCommit), range.lastCommit);
    scopes.set(address, scope);
  }
  return scopes;
}

/** Include the opening, commit prefix and eligible native closes in original producer order. */
export function prefixRanges(scope: PublishedScope, target: number): readonly PublishedRecordRange[] {
  let end = 0;
  if (target >= 0) {
    const matching = scope.commits.enclosing(target);
    if (!matching.length) throw new IndexedRefusal('unavailable');
    for (const commit of matching) end = Math.max(end, commit.label);
  }
  const ranges = scope.ranges;
  for (let i = end + 1; i < ranges.length; i++) {
    const row = ranges[i];
    if (row.firstCommit !== undefined && row.firstCommit > target) break;
    if (row.closedThrough !== undefined && row.closedThrough <= target) end = i;
  }
  return ranges.slice(0, end + 1);
}
