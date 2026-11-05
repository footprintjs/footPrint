import type { HeapPoint, HeapProfile, NativeFact, Receipt } from '../readWitness.js';
import { memoryCallsOf } from '../readWitness.js';
import { type CheckedRead, equal, refuse } from './types.js';

export interface HeapFallbackProof {
  readonly name: 'original-heap-fallback';
  readonly baselineCall: number;
  readonly baselineReceiver: number;
  readonly baselineGeneration: number;
  readonly buildReceiver: number;
  readonly buildGeneration: number;
}
const positive = (id: number): boolean => Number.isSafeInteger(id) && id > 0;

function unchangedHeap(input: CheckedRead, calls: readonly NativeFact[], layout: HeapProfile): HeapPoint {
  const { read, deletedBy } = input;
  const points = [
    deletedBy.heapBefore,
    deletedBy.heapAfter,
    read.heapBefore,
    ...calls.flatMap((call) => [call.heapBefore, call.heapAfter]),
    read.heapAfter,
  ];
  const first = points[0];
  if (!first || !positive(first.memory) || !positive(first.generation)) return refuse('missing pre-delete heap point');
  if (
    !deletedBy.heapAfter ||
    !read.heapBefore ||
    !read.heapAfter ||
    !(
      deletedBy.start < first.at &&
      first.at < deletedBy.heapAfter.at &&
      deletedBy.heapAfter.at < deletedBy.end &&
      deletedBy.end < read.start &&
      read.start < read.heapBefore.at &&
      read.heapBefore.at < read.heapAfter.at &&
      read.heapAfter.at < read.end
    ) ||
    points.some(
      (point) =>
        !point ||
        point.layout !== layout ||
        point.memory !== first.memory ||
        point.generation !== first.generation ||
        !equal(point.facts, first.facts),
    )
  )
    return refuse('owning heap changed or lacks exact generation evidence');
  return first;
}

/** Alternative ONLY for an absent/undefined canonical base, after the ordinary local tombstone join. */
export function requireHeapFallback(
  baseline: Receipt,
  build: Receipt,
  x: CheckedRead,
  y: CheckedRead,
): HeapFallbackProof {
  if (
    !x.get.base ||
    !y.get.base ||
    x.get.base.value.kind !== 'undefined' ||
    y.get.base.value.kind !== 'undefined' ||
    x.get.base.found !== y.get.base.found ||
    !x.read.call ||
    !y.read.call ||
    !x.read.header ||
    !y.read.header ||
    x.read.header.runId !== y.read.header.runId ||
    !equal(x.read.call.args.slice(0, 2), y.read.call.args.slice(0, 2)) ||
    x.read.call.args.length < 2 ||
    y.read.call.args.length < 2 ||
    y.read.result?.kind !== 'undefined'
  )
    return refuse('not an unresolved canonical-base fallback pair');
  const before = memoryCallsOf(baseline, x.read);
  const after = memoryCallsOf(build, y.read);
  if (before.length !== 1 || after.length !== 0) return refuse('fallback was not one actual old call and no new call');
  const call = before[0];
  const callArgs = call.call;
  if (
    call.outcome !== 'returned' ||
    !callArgs ||
    callArgs.args.length !== 3 ||
    !equal(callArgs.args[0], { kind: 'string', value: x.read.header.runId }) ||
    !equal(callArgs.args[1], x.read.call.args[0]) ||
    !equal(callArgs.args[2], x.read.call.args[1]) ||
    !positive(callArgs.objects[1]!) ||
    callArgs.objects[1] !== x.read.call.objects[0] ||
    !(x.get.end < call.start) ||
    !call.result ||
    call.result.kind === 'undefined' ||
    !equal(call.result, x.read.result) ||
    call.resultObject !== x.read.resultObject ||
    (['array', 'object', 'date', 'ref'].includes(call.result.kind) && !positive(call.resultObject!))
  )
    return refuse('original heap call does not prove exact arguments and returned identity');
  const oldHeap = unchangedHeap(x, before, 'baseline-stage-shared-memory');
  const newHeap = unchangedHeap(y, after, 'build-record-state');
  if (call.receiverObject !== oldHeap.memory || !equal(oldHeap.facts, newHeap.facts))
    return refuse('different owning heap or unequal pre-delete heap facts');
  return Object.freeze({
    name: 'original-heap-fallback',
    baselineCall: call.id,
    baselineReceiver: oldHeap.memory,
    baselineGeneration: oldHeap.generation,
    buildReceiver: newHeap.memory,
    buildGeneration: newHeap.generation,
  });
}
