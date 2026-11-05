import type { NativeFact, Receipt } from '../observationTypes.js';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const positive = (id: number | undefined): id is number => Number.isSafeInteger(id) && id! > 0;
const bad = (): never => {
  throw new Error('Unjoined original heap-call evidence.');
};

/** Explicit known tier: every original memory call joins its actual parent read, owner and clock. */
export function memoryCallsOf(receipt: Receipt, read: NativeFact): readonly NativeFact[] {
  if (!Array.isArray(read.memoryGets)) return bad(); // Absent profile is not evidence of no fallback.
  if (
    read.tier !== 'stage-call' ||
    read.phase !== 'read' ||
    !['getValue', 'getValueDirect'].includes(read.method) ||
    !positive(read.frame) ||
    !read.header ||
    read.leg !== receipt.leg ||
    !receipt.events.includes(read) ||
    !read.heapBefore ||
    !read.heapAfter ||
    !(read.start < read.heapBefore.at && read.heapBefore.at < read.heapAfter.at && read.heapAfter.at < read.end)
  )
    return bad();
  const indexed = new Map<number, NativeFact>();
  for (const event of receipt.events) {
    if (indexed.has(event.id)) return bad();
    indexed.set(event.id, event);
  }
  if (new Set(read.memoryGets).size !== read.memoryGets.length) return bad();
  const result = read.memoryGets.map((id) => {
    const call = indexed.get(id);
    if (
      !call ||
      call.tier !== 'memory-get' ||
      call.method !== 'getValue' ||
      call.phase !== 'read' ||
      call.parentRead !== read.id ||
      call.frame !== read.frame ||
      call.leg !== receipt.leg ||
      !same(call.header, read.header) ||
      !same(call.operation, read.operation) ||
      !positive(call.receiverObject) ||
      !call.heapBefore ||
      !call.heapAfter ||
      call.heapBefore.memory !== call.receiverObject ||
      call.heapAfter.memory !== call.receiverObject ||
      !(
        read.heapBefore!.at < call.start &&
        call.start < call.heapBefore.at &&
        call.heapBefore.at < call.heapAfter.at &&
        call.heapAfter.at < call.end &&
        call.end < read.heapAfter!.at
      )
    )
      return bad();
    return call;
  });
  const actuallyOwned = receipt.events.filter((event) => event.tier === 'memory-get' && event.parentRead === read.id);
  if (actuallyOwned.length !== result.length || actuallyOwned.some((event) => !result.includes(event))) return bad();
  return Object.freeze(result);
}

/** This does not allow an unknown tier to disappear from the semantic comparison. */
export function validateHeapLinks(receipt: Receipt): void {
  const calls = receipt.events.filter((event) => event.tier === 'memory-get');
  const reads = receipt.events.filter((event) => event.tier === 'stage-call' && event.memoryGets !== undefined);
  for (const read of reads) memoryCallsOf(receipt, read);
  for (const call of calls) {
    const parents = reads.filter((read) => read.id === call.parentRead && read.memoryGets!.includes(call.id));
    if (parents.length !== 1) return bad();
  }
}
