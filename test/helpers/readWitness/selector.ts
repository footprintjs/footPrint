/** Dynamic native tombstone inputs only. No program, operation list, value replay or record comparison. */
import { addressOf, bad, BUFFER, mutation, positive, readMethod, STAGE } from './data.js';
import type { DeletedReadInput, NativeFact, Receipt, Segment } from './observationTypes.js';
const prefix = (a: readonly Segment[], b: readonly Segment[]) =>
  a.length <= b.length && a.every((part, i) => part === b[i]);
// Conservative property-overlap check: numeric 0 and string '0' cannot hide a re-establishing write.
const overlaps = (a: readonly Segment[], b: readonly Segment[]) => {
  const contains = (x: typeof a, y: typeof b) =>
    x.length <= y.length && x.every((part, i) => String(part) === String(y[i]));
  return contains(a, b) || contains(b, a);
};
const sameOwner = (a: NativeFact, b: NativeFact) =>
  a.frame === b.frame && JSON.stringify(a.header) === JSON.stringify(b.header);
function checkedEvents(receipt: Receipt): ReadonlyMap<number, NativeFact> {
  if (!receipt || typeof receipt.leg !== 'string' || !receipt.leg.length || receipt.issues.length) return bad();
  const byId = new Map<number, NativeFact>();
  for (const event of receipt.events) {
    if (
      !positive(event.id) ||
      byId.has(event.id) ||
      event.leg !== receipt.leg ||
      !Number.isSafeInteger(event.start) ||
      !Number.isSafeInteger(event.end) ||
      event.start >= event.end ||
      !['returned', 'threw'].includes(event.outcome)
    )
      return bad();
    const stage = event.tier === 'stage-call';
    if (
      stage
        ? !STAGE.some(([name]) => name === event.method)
        : event.tier !== 'buffer-call' || !(BUFFER as readonly string[]).includes(event.method)
    )
      return bad();
    if (stage && event.phase !== (event.method === 'commit' ? 'commit' : readMethod(event.method) ? 'read' : 'write'))
      return bad();
    if (!stage && (!positive(event.buffer) || !Number.isSafeInteger(event.epoch) || event.epoch! < 0)) return bad();
    if (!stage && event.method !== 'commit') addressOf(event.address);
    if (
      stage &&
      (!positive(event.frame) ||
        !event.header ||
        typeof event.header.stageId !== 'string' ||
        typeof event.header.runId !== 'string')
    )
      return bad();
    if ((stage && readMethod(event.method)) || (!stage && event.method === 'get')) {
      if (event.outcome === 'returned' && !['undefined', 'defined'].includes(event.result?.kind ?? '')) return bad();
    }
    if (
      !stage &&
      (event.method === 'set' || event.method === 'merge') &&
      !['undefined', 'defined'].includes(event.value?.kind ?? '')
    )
      return bad();
    byId.set(event.id, event);
  }
  return byId;
}
export function sameStageDeletedReadInputs(receipt: Receipt): readonly DeletedReadInput[] {
  const byId = checkedEvents(receipt);
  const selected: DeletedReadInput[] = [];
  for (const read of receipt.events) {
    if (read.tier !== 'stage-call' || !readMethod(read.method) || read.outcome !== 'returned') continue;
    if (!read.gets) return bad();
    if (read.gets.length === 0) continue; // No canonical buffer read was made by this native method.
    if (read.gets.length !== 1) return bad();
    const get = byId.get(read.gets[0]);
    if (
      !get ||
      get.tier !== 'buffer-call' ||
      get.method !== 'get' ||
      get.phase !== 'read' ||
      get.outcome !== 'returned' ||
      !sameOwner(get, read) ||
      !get.address ||
      !(read.start < get.start && get.end < read.end)
    )
      return bad();
    const writes = receipt.events.filter(
      (event) =>
        event.tier === 'buffer-call' &&
        mutation(event.method) &&
        event.buffer === get.buffer &&
        event.epoch === get.epoch &&
        event.address !== undefined &&
        event.end < read.start,
    );
    const tombstones = writes.filter(
      (event) =>
        event.outcome === 'returned' &&
        event.phase === 'write' &&
        sameOwner(event, read) &&
        prefix(event.address!, get.address!) &&
        (event.method === 'delete' || (event.method === 'set' && event.value?.kind === 'undefined')),
    );
    const deletedBy = tombstones.sort((a, b) => b.end - a.end)[0];
    if (!deletedBy) continue;
    // Any later overlapping mutation, even a throwing call, keeps the oracle comparison strict.
    const reestablished = receipt.events.some(
      (event) =>
        event !== deletedBy &&
        event.tier === 'buffer-call' &&
        mutation(event.method) &&
        event.buffer === get.buffer &&
        event.epoch === get.epoch &&
        event.address !== undefined &&
        event.start > deletedBy.end &&
        event.start < read.end &&
        (overlaps(event.address, deletedBy.address!) || overlaps(event.address, get.address!)),
    );
    if (!reestablished) selected.push(Object.freeze({ read, get, deletedBy }));
  }
  return Object.freeze(selected);
}
export function requireDeletedReadInput(receipt: Receipt, readId: number): DeletedReadInput {
  return sameStageDeletedReadInputs(receipt).find(({ read }) => read.id === readId) ?? bad();
}
