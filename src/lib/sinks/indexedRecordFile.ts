import type { LogAddress } from 'foottrace';

import { ownData } from '../capture/noteShape.js';
import {
  checkSignal,
  indexedAddress,
  indexedJson,
  indexedLimits,
  IndexedRefusal,
  indexedText,
} from './indexedAdmission.js';
import { assertIdentity, digest, readBytes } from './indexedIO.js';
import { scanIndexedFile } from './indexedScan.js';
import { type IndexedReadContext, openIndexedSession } from './indexedSession.js';
import type { IndexedRecordFile, IndexedRecordFileOptions, IndexedRecordFileResult } from './indexedTypes.js';

/** Explicit bounded whole-file preparation, followed by authorized positional scope reads from that immutable file. */
export async function openIndexedRecordFile(
  path: string,
  options: IndexedRecordFileOptions,
): Promise<IndexedRecordFileResult> {
  const limits = indexedLimits(options);
  return openIndexedSession(
    path,
    limits,
    (fd, identity, signal, stats) =>
      scanIndexedFile(fd, identity, limits, signal, (bytes) => (stats.preparationBytes += bytes)),
    (fd, identity, index, session): IndexedRecordFile =>
      Object.freeze({
        get stats() {
          return session.stats();
        },
        readScope(address: LogAddress, context?: IndexedReadContext) {
          return session.read(address, context, async (key, signal) => {
            const ranges = index.get(key);
            if (!ranges) throw new IndexedRefusal('no-match');
            const entries: unknown[] = [];
            for (const range of ranges) {
              checkSignal(signal);
              const bytes = await readBytes(fd, range.offset, range.bytes, signal, session.count, session.submitted);
              if (digest(bytes) !== range.digest) throw new IndexedRefusal('stale');
              const entry = indexedJson(indexedText(bytes));
              if (indexedAddress(ownData(entry, 'address')) !== key) throw new IndexedRefusal('invalid-data');
              entries.push(entry);
            }
            assertIdentity(fd, identity);
            checkSignal(signal);
            return {
              status: 'loaded' as const,
              entries,
              bytesRead: ranges.reduce((total, range) => total + range.bytes, 0),
            };
          });
        },
        close: session.close,
      }),
  );
}
