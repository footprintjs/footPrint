import type { LogAddress } from 'foottrace';
import type { ReadSourceSnapshot } from 'foottrace/write';
import { createReadSourceRecord, decodeReadSourceSnapshot, SharedMemory } from 'foottrace/write';

let emptyNativeBook: ReadSourceSnapshot | undefined;

/** Native structural admission only: no user heap, options, sink or source selection participates. */
export function supportsNativeSourceAddress(address: LogAddress): boolean {
  if (!emptyNativeBook) {
    // Let the published writer supply its own wire version, limits and empty envelope.
    // Lazy: default-off executions never allocate this inert validation fixture.
    const book = createReadSourceRecord(new SharedMemory(), { logRunId: 'source-address-admission', drillPath: [] });
    emptyNativeBook = book.snapshot();
    book.retire();
  }
  // The native codec owns all address bounds. This candidate is never served as observed evidence.
  return decodeReadSourceSnapshot({ ...emptyNativeBook, address }) !== undefined;
}
