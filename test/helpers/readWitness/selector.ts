/**
 * Dynamic native inputs only. No program, operation list, value replay or record comparison.
 *
 * TWO SELECTIONS, one law. The build's read law (#124, foottrace 1.11.1) is: a read the stage's own
 * buffer cannot answer falls back to live state only when no hard write of the same stage (a `set` or
 * a `delete`) owns the path or a path above it. Engine 9.28.0 always fell back.
 *
 *   - `sameStageDeletedReadInputs`: a read at or below a path the stage DELETED and did not write
 *     again. The first form of the rule, and the one whose counts are pinned for the fixed seeds.
 *   - `sameStageHardWrittenReadInputs`: a read the buffer could not answer, at or below ANY hard write
 *     of the stage. WHY it was added: a `set` hides the old value exactly as a `delete` does
 *     (`set list = 's'`, then read `list.y`: 9.28.0 answered the committed `list.y`, the build answers
 *     nothing). The first selection does not see that, no program at the fixed seeds has that shape,
 *     and a fresh seed made the differentials fail on it. It asks the buffer's own answer, which the
 *     first selection could not: "deleted and not written again" was its stand-in for "the buffer has
 *     nothing there".
 */
import { addressOf, bad, BUFFER, mutation, positive, readMethod, STAGE } from './data.js';
import type { DeletedReadInput, HardWrittenReadInput, NativeFact, Receipt, Segment } from './observationTypes.js';
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
/** One returned stage read, the one buffer `get` it made, and the buffer writes of the same round before it. */
type BoundRead = { readonly read: NativeFact; readonly get: NativeFact; readonly writes: readonly NativeFact[] };

/** Every returned stage read that asked its buffer, bound to that `get`. Anything it cannot bind is refused. */
function readsWithTheirGet(receipt: Receipt): readonly BoundRead[] {
  const byId = checkedEvents(receipt);
  const bound: BoundRead[] = [];
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
    bound.push({ read, get, writes });
  }
  return bound;
}

export function sameStageDeletedReadInputs(receipt: Receipt): readonly DeletedReadInput[] {
  const selected: DeletedReadInput[] = [];
  for (const { read, get, writes } of readsWithTheirGet(receipt)) {
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
/**
 * Does a write at `write` own a read at `read`: the read's path, or a path above it? Segments are
 * compared as text, as the buffer keeps its hard-write keys (`foottrace · hardWriteCovers` joins
 * `String(segment)`), so index `0` and key `'0'` are one path.
 */
const owns = (write: readonly Segment[], read: readonly Segment[]) =>
  write.length <= read.length && write.every((part, i) => String(part) === String(read[i]));

/**
 * Every read the stage's own buffer could NOT answer, at or below a hard write of the same stage, in
 * the same round of staging (between two commits of the buffer). The build's law says such a read is
 * `undefined`; what the engine under observation returned is on `read.result`.
 *
 * A hard write is a returned `set` or `delete`. A `merge` is not one: it adds to what is there, so a
 * read beside what it added may still be answered from live state, on both engines. A write that
 * threw staged nothing. Later writes do not matter: whatever they did, the buffer was asked and had
 * nothing, and the hard write still owns the path until the commit.
 */
export function sameStageHardWrittenReadInputs(receipt: Receipt): readonly HardWrittenReadInput[] {
  const selected: HardWrittenReadInput[] = [];
  for (const { read, get, writes } of readsWithTheirGet(receipt)) {
    if (get.result?.kind !== 'undefined') continue; // The buffer answered: the value is the stage's own.
    const writtenBy = writes
      .filter(
        (event) =>
          event.outcome === 'returned' &&
          event.phase === 'write' &&
          sameOwner(event, read) &&
          (event.method === 'set' || event.method === 'delete') &&
          owns(event.address!, get.address!),
      )
      .sort((a, b) => b.end - a.end)[0];
    if (writtenBy) selected.push(Object.freeze({ read, get, writtenBy }));
  }
  return Object.freeze(selected);
}
export function requireDeletedReadInput(receipt: Receipt, readId: number): DeletedReadInput {
  return sameStageDeletedReadInputs(receipt).find(({ read }) => read.id === readId) ?? bad();
}
