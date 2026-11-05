/** Existing original receipt joins for the finite declared projection rows. */
import { equal, refuse } from '../../../readLawWitness.js';
import type { HeapPoint, NativeFact, Receipt } from '../../../readWitness.js';
import { memoryCallsOf, requireDeletedReadInput, validateHeapLinks } from '../../../readWitness.js';
import type { Bound } from '../branchFacts.js';
import { objectId } from '../branchFacts.js';
import type { Profile } from './profiles.js';
import type { Projection } from './project.js';

type Input = { read: NativeFact; get: NativeFact; deletedBy?: NativeFact; route: 'direct' | 'own-base' | 'fallback' };
function input(receipt: Receipt, read: NativeFact, build: boolean): Input {
  member(receipt, read);
  if (read.gets?.length !== 1) return refuse('projection read has no one original native get');
  const get = receipt.events.find((row) => row.id === read.gets![0]);
  if (!get) return refuse('projection native get is missing');
  member(receipt, get);
  if (!objectId(get.buffer) || !Number.isSafeInteger(get.epoch) || get.epoch! < 0)
    return refuse('projection get has no admitted native buffer/epoch');
  if (!read.header) return refuse('projection read has no actual native owner header');
  if (read.memoryGets === undefined) {
    // The EXISTING canonical own-base input law, not an invented empty memory-call profile.
    if (
      get.result?.kind !== 'undefined' ||
      !get.base?.found ||
      get.base.value.kind === 'undefined' ||
      (build ? read.result?.kind !== 'undefined' : !equal(get.base.value, read.result))
    )
      return refuse('unprofiled read lacks the existing canonical own-base provenance');
    const original = deletedInput(receipt, read, get);
    return { ...original, route: 'own-base' };
  }
  const fallback = memoryCallsOf(receipt, read);
  if (!fallback.length) {
    if (!equal(get.result, read.result)) return refuse('direct native delivery differs from actual read');
    return { read, get, route: 'direct' };
  }
  const original = deletedInput(receipt, read, get);
  return { ...original, route: 'fallback' };
}
function deletedInput(receipt: Receipt, read: NativeFact, get: NativeFact) {
  const original = requireDeletedReadInput(receipt, read.id);
  const deleted = original.deletedBy;
  member(receipt, deleted);
  if (
    original.read !== read ||
    original.get !== get ||
    deleted.tier !== 'buffer-call' ||
    deleted.frame !== read.frame ||
    !equal(deleted.header, read.header) ||
    deleted.buffer !== get.buffer ||
    deleted.epoch !== get.epoch ||
    !equal(deleted.address, get.address)
  )
    return refuse('projection tombstone belongs to another original owner/address');
  return original;
}
function member(receipt: Receipt, row: NativeFact): void {
  if (
    receipt.events.filter((actual) => actual === row).length !== 1 ||
    receipt.events.filter((actual) => actual.id === row.id).length !== 1 ||
    !objectId(row.id) ||
    row.outcome !== 'returned' ||
    row.leg !== receipt.leg ||
    !(row.start < row.end)
  )
    return refuse('projection lacks one original successful native occurrence');
}
function unchanged(points: readonly (HeapPoint | undefined)[], first: HeapPoint | undefined): void {
  if (
    !first ||
    !objectId(first.memory) ||
    !objectId(first.generation) ||
    points.some(
      (point) =>
        !point ||
        point.layout !== first.layout ||
        point.memory !== first.memory ||
        point.generation !== first.generation ||
        !equal(point.facts, first.facts),
    )
  )
    return refuse('projection fallback has changed or absent own-heap provenance');
}
function delivery(receipt: Receipt, read: NativeFact, primary: Input, build: boolean): readonly NativeFact[] {
  member(receipt, read);
  const own = input(receipt, read, build);
  const get = own.get;
  member(receipt, get);
  if (own.deletedBy) member(receipt, own.deletedBy);
  if (
    own.read !== read ||
    own.deletedBy !== primary.deletedBy ||
    get.tier !== 'buffer-call' ||
    get.method !== 'get' ||
    get.phase !== 'read' ||
    !(read.start < get.start && get.end < read.end) ||
    get.frame !== primary.get.frame ||
    get.buffer !== primary.get.buffer ||
    get.epoch !== primary.get.epoch ||
    !equal(get.header, primary.get.header) ||
    !equal(get.address, primary.get.address) ||
    !equal(get.operation, read.operation) ||
    own.route !== primary.route ||
    !equal(read.call?.args, primary.read.call?.args) ||
    !equal(get.base, primary.get.base)
  )
    return refuse('projection native get is not the same original tombstone/address/owner');
  if (own.route === 'own-base') {
    if (
      read.resultObject !== primary.read.resultObject ||
      !equal(read.result, primary.read.result) ||
      !equal(read.resultIdentities, primary.read.resultIdentities)
    )
      return refuse('own-base receiver is not the primary SAME returned identity/value/graph');
    return [read, get]; // Any actual forwarded memory row remains unclaimed and makes coverage refuse.
  }
  const fallback = memoryCallsOf(receipt, read); // Explicit profile, never absent-as-empty.
  if (build) {
    if (
      fallback.length ||
      read.result?.kind !== 'undefined' ||
      read.resultObject !== undefined ||
      !equal(read.resultIdentities, [])
    )
      return refuse('projection candidate is not native undefined/no fallback');
    if (read.heapBefore?.layout !== 'build-record-state') return refuse('candidate has no admitted native heap layout');
    unchanged([read.heapBefore, read.heapAfter], read.heapBefore);
    return [read, get];
  }
  if (
    read.resultObject !== primary.read.resultObject ||
    !equal(read.result, primary.read.result) ||
    !equal(read.resultIdentities, primary.read.resultIdentities)
  )
    return refuse('projection receiver does not return the primary SAME identity/value/graph');
  if (primary.read.heapBefore?.layout !== 'baseline-stage-shared-memory')
    return refuse('baseline has no admitted native heap layout');
  if (own.route === 'direct') {
    if (fallback.length) return refuse('direct receiver unexpectedly called native fallback');
    unchanged([read.heapBefore, read.heapAfter], primary.read.heapBefore);
    return [read, get];
  }
  if (get.result?.kind !== 'undefined' || fallback.length !== 1 || !own.deletedBy)
    return refuse('projection fallback has no exact original tombstone return');
  const call = fallback[0];
  member(receipt, call);
  const args = call.call;
  if (
    call.method !== 'getValue' ||
    call.tier !== 'memory-get' ||
    !args ||
    args.args.length !== 3 ||
    !equal(args.args[0], { kind: 'string', value: read.header?.runId }) ||
    !equal(args.args.slice(1), read.call?.args) ||
    !objectId(args.objects[1]) ||
    args.objects[1] !== read.call?.objects[0] ||
    !(get.end < call.start) ||
    !equal(call.result, read.result) ||
    call.resultObject !== read.resultObject ||
    call.receiverObject !== primary.read.heapBefore?.memory
  )
    return refuse('projection fallback does not prove the actual run/path/receiver/returned identity');
  unchanged(
    [
      own.deletedBy.heapBefore,
      own.deletedBy.heapAfter,
      read.heapBefore,
      read.heapAfter,
      call.heapBefore,
      call.heapAfter,
    ],
    primary.read.heapBefore,
  );
  return [read, get, call];
}

/** A method-role table AND actual identity/native evidence; a matching count supplies no proof. */
export function nativeBranches(bound: Bound, profile: Profile, projection: Projection, build: boolean) {
  const receipt = bound.native;
  if (!receipt || receipt.issues.length) return refuse('declared projection requires the original native receipt');
  validateHeapLinks(receipt);
  const { branch, read } = bound;
  member(receipt, read);
  const primary = input(receipt, read, build);
  if (
    branch.edits.length ||
    primary.read !== read ||
    primary.get.address?.at(-1) !== read.call?.args[1].value ||
    primary.get.frame !== read.frame ||
    !equal(primary.get.header, read.header)
  )
    return refuse('projection primary read has no original canonical/user operand join');
  const methods = build || !projection.active ? ['getValue'] : profile.baselineReads;
  const reads = branch.calls.slice(0, methods.length);
  const writes = branch.calls.slice(methods.length);
  if (reads.length !== methods.length || writes.length !== projection.writes.length)
    return refuse('projection calls do not follow the closed method roles');
  const covered = new Set<NativeFact>();
  const cover = (rows: readonly NativeFact[]) => {
    for (const row of rows) {
      if (covered.has(row)) return refuse('projection native row claimed twice');
      covered.add(row);
    }
  };
  let end = branch.operation.start;
  for (const call of branch.calls) {
    member(receipt, call);
    if (
      call.tier !== 'stage-call' ||
      call.frame !== read.frame ||
      !equal(call.header, read.header) ||
      !equal(call.operation, branch.operation.coordinate) ||
      !(end < call.start && call.end < branch.operation.end)
    )
      return refuse('projection call ownership/order changed');
    end = call.end;
  }
  reads.forEach((call, index) => {
    if (call.method !== methods[index] || call.phase !== 'read' || !equal(call.call.args, read.call!.args))
      return refuse('projection has a foreign receiver or read method');
    cover(delivery(receipt, call, primary, build));
  });
  writes.forEach((call, index) => {
    const expected = projection.writes[index];
    const actual = receipt.events.filter(
      (row) => row.tier === 'buffer-call' && row.phase === 'write' && call.start < row.start && row.end < call.end,
    );
    if (call.phase !== 'write' || call.method !== expected.method || actual.length !== 1)
      return refuse('projection lacks its one actual declared physical producer');
    const row = actual[0];
    member(receipt, row);
    if (
      row.method !== (expected.method === 'setObject' ? 'set' : 'merge') ||
      row.frame !== read.frame ||
      !equal(row.header, read.header) ||
      !equal(row.operation, call.operation) ||
      row.buffer !== primary.get.buffer ||
      row.epoch !== primary.get.epoch ||
      !equal(row.address, primary.get.address) ||
      !equal(row.value, call.call.args[2]) ||
      row.valueObject !== call.call.objects[2]
    )
      return refuse('projection physical producer has different value/identity/address');
    cover([call, row]);
  });
  const actual = receipt.events.filter((row) => row.start < branch.operation.end && row.end > branch.operation.start);
  if (actual.length !== covered.size || actual.some((row) => !covered.has(row)))
    return refuse('projection has an unaccounted or straddling original native row');
  return writes;
}
