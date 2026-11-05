import type { NativeFact, Receipt } from '../readWitness.js';
import { requireDeletedReadInput, validateHeapLinks } from '../readWitness.js';
import { requireHeapFallback } from './heapFallback.js';
import { type CheckedRead, type OperationRead, type ReadPair, equal, refuse } from './types.js';

function owned(receipt: Receipt, bound: OperationRead): CheckedRead {
  if (
    !bound.coordinate.length ||
    bound.coordinate.some(
      (part) => typeof part !== 'string' && !(typeof part === 'number' && Number.isSafeInteger(part)),
    )
  )
    return refuse('missing operation occurrence');
  const input = requireDeletedReadInput(receipt, bound.nativeId);
  const { read, get, deletedBy } = input;
  if (bound.occurrence !== undefined) {
    const actual = receipt.events.filter(
      (event) =>
        Object.getOwnPropertyDescriptor(event, 'tier')?.value === 'stage-call' &&
        ['getValue', 'getValueDirect'].includes(event.method) &&
        event.outcome === 'returned' &&
        equal(Object.getOwnPropertyDescriptor(event, 'operation')?.value, bound.coordinate) &&
        bound.start < event.start &&
        event.end < bound.end,
    );
    if (!Number.isSafeInteger(bound.occurrence) || bound.occurrence < 0 || actual[bound.occurrence] !== read)
      return refuse('native read occurrence is not the actual ordered operation call');
  }
  if (
    !equal(Object.getOwnPropertyDescriptor(read, 'operation')?.value, bound.coordinate) ||
    bound.frame !== read.frame ||
    !(bound.start < read.start && read.end < bound.end) ||
    get.result?.kind !== 'undefined'
  )
    return refuse('unjoined operation/native tombstone/read');
  return { read, get, deletedBy };
}

/** Local IDs are joined inside their own receipt; never compared as cross-engine identity. */
export function checkedPair(a: Receipt, b: Receipt, pair: ReadPair): readonly [CheckedRead, CheckedRead] {
  if (
    a.leg !== b.leg ||
    !equal(pair.baseline.coordinate, pair.build.coordinate) ||
    pair.baseline.occurrence !== pair.build.occurrence
  )
    return refuse('different leg or operation occurrence');
  const x = owned(a, pair.baseline);
  const y = owned(b, pair.build);
  if (
    x.read.header?.stageId !== y.read.header?.stageId ||
    x.read.header?.runtimeStageId !== y.read.header?.runtimeStageId ||
    x.read.method !== y.read.method ||
    x.get.epoch !== y.get.epoch ||
    !equal(x.get.address, y.get.address) ||
    !equal(x.deletedBy.address, y.deletedBy.address) ||
    x.deletedBy.method !== y.deletedBy.method ||
    !equal(x.deletedBy.value, y.deletedBy.value) ||
    y.read.result?.kind !== 'undefined'
  )
    return refuse('native observations do not prove stale baseline to undefined');
  const canonical =
    x.get.base?.found &&
    y.get.base?.found &&
    x.get.base.value.kind !== 'undefined' &&
    y.get.base.value.kind !== 'undefined' &&
    equal(x.get.base.value, y.get.base.value) &&
    equal(x.read.result, x.get.base.value);
  if (!canonical) requireHeapFallback(a, b, x, y);
  return [x, y];
}

/** Exact ordered semantic trace. Internal exclusions are ORIGINAL, already-proved auxiliary STAGE rows only.
 * Origin validation always sees the complete original receipts, including each auxiliary's heap-call children. */
export function equalNativeTrace(
  a: Receipt,
  b: Receipt,
  pairs: readonly ReadPair[],
  provenBaselineAuxiliaries?: ReadonlySet<NativeFact>,
): boolean {
  const view = (receipt: Receipt, side: 'baseline' | 'build') => {
    if (receipt.issues.length) return refuse('unsupported native observation');
    validateHeapLinks(receipt);
    const selected = new Set(pairs.map((pair) => pair[side].nativeId));
    if (selected.size !== pairs.length) return refuse('native read claimed twice');
    const semanticExclusions = new Set<NativeFact>();
    if (side === 'baseline' && provenBaselineAuxiliaries !== undefined) {
      for (const row of provenBaselineAuxiliaries) {
        if (
          semanticExclusions.has(row) ||
          receipt.events.filter((actual) => actual === row).length !== 1 ||
          receipt.events.filter((actual) => actual.id === row.id).length !== 1 ||
          !Number.isSafeInteger(row.id) ||
          row.id <= 0 ||
          selected.has(row.id) ||
          row.tier !== 'stage-call' ||
          row.phase !== 'read' ||
          row.method !== 'getValueDirect' ||
          row.outcome !== 'returned' ||
          row.leg !== receipt.leg
        )
          return refuse('semantic exclusion is not a unique original auxiliary stage-read reference');
        semanticExclusions.add(row);
      }
      if (semanticExclusions.size !== provenBaselineAuxiliaries.size)
        return refuse('semantic exclusion set is not unique');
    }
    const frames = new Map<number, number>();
    const buffers = new Map<number, number>();
    const local = (map: Map<number, number>, id: number | undefined) => {
      if (id === undefined) return undefined;
      if (!map.has(id)) map.set(id, map.size);
      return map.get(id);
    };
    let previous = 0;
    const ids = new Set<number>();
    const ordered = receipt.events.filter((event) => {
      const tier = Object.getOwnPropertyDescriptor(event, 'tier')?.value;
      if (tier !== 'stage-call' && tier !== 'buffer-call' && tier !== 'memory-get')
        return refuse('native origin tier was not observed');
      // Original heap calls have their own strict parent/receiver/clock join above. They are not
      // extra stage operations; the complete Stage return remains exact except for proved pairs.
      if (tier === 'memory-get') return false;
      // These are actual stage-call inputs/returns and its staged writes. Buffer get/admit/replay/encoder
      // internals are a different port; selected gets are joined locally, commits by the producer proof.
      return (
        (tier === 'stage-call' && (event.phase === 'read' || event.phase === 'write')) ||
        (tier === 'buffer-call' && event.phase === 'write' && ['set', 'merge', 'delete'].includes(event.method))
      );
    });
    return ordered.flatMap((event: NativeFact) => {
      if (event.leg !== receipt.leg || event.start <= previous || event.end <= event.start || ids.has(event.id))
        return refuse('unordered, duplicate or foreign native occurrence');
      previous = event.start;
      ids.add(event.id);
      // Even excluded semantic rows were validated above in ORIGINAL order; heap origins were validated before this loop.
      if (semanticExclusions.has(event)) return [];
      return [
        {
          method: event.method,
          outcome: event.outcome,
          phase: event.phase,
          operation: Object.getOwnPropertyDescriptor(event, 'operation')?.value,
          arguments: Object.getOwnPropertyDescriptor(event, 'call')?.value?.args,
          frame: local(frames, event.frame),
          buffer: local(buffers, event.buffer),
          epoch: event.epoch,
          // Native run IDs are leg-local. Actual stage/runtime-stage identity is retained here.
          header: event.header && { stageId: event.header.stageId, runtimeStageId: event.header.runtimeStageId },
          address: event.address,
          value: event.value,
          base: event.base && { found: event.base.found, value: event.base.value },
          gets: event.gets?.length,
          result: selected.has(event.id) ? { selectedRead124: true } : event.result,
        },
      ];
    });
  };
  return equal(view(a, 'baseline'), view(b, 'build'));
}
