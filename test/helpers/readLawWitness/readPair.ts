import type { NativeTraceComparison } from '../nativeTraceFacts.js';
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

/** Declared comparison domain, not an admission. Callers attach it only AFTER their existing closed proof succeeds. */
export function nativeTraceComparison(pairs: readonly ReadPair[]): NativeTraceComparison {
  const windows: NativeTraceComparison['windows'][number][] = [];
  const byCoordinate = new Map<string, string>();
  for (const pair of pairs) {
    if (
      !pair.baseline.coordinate.length ||
      !equal(pair.baseline.coordinate, pair.build.coordinate) ||
      pair.baseline.coordinate.some(
        (part) => typeof part !== 'string' && !(typeof part === 'number' && Number.isSafeInteger(part)),
      )
    )
      return refuse('unreadable native comparison coordinate');
    for (const bound of [pair.baseline, pair.build]) {
      if (!Number.isFinite(bound.start) || !Number.isFinite(bound.end) || bound.start < 0 || bound.end <= bound.start)
        return refuse('unreadable native comparison window');
    }
    const coordinate = JSON.stringify(pair.baseline.coordinate);
    const window = {
      coordinate: Object.freeze([...pair.baseline.coordinate]),
      baseline: Object.freeze({ start: pair.baseline.start, end: pair.baseline.end }),
      build: Object.freeze({ start: pair.build.start, end: pair.build.end }),
    };
    const bytes = JSON.stringify(window);
    const prior = byCoordinate.get(coordinate);
    if (prior !== undefined) {
      if (prior !== bytes) return refuse('same comparison coordinate has another actual window');
      continue; // Multiple native reads in one actual operation share ONE window.
    }
    for (const earlier of windows) {
      if (
        ['baseline', 'build'].some((side) => {
          const key = side as 'baseline' | 'build';
          return window[key].start < earlier[key].end && earlier[key].start < window[key].end;
        })
      )
        return refuse('overlapping independent native comparison windows');
    }
    byCoordinate.set(coordinate, bytes);
    windows.push(Object.freeze(window));
  }
  return Object.freeze({
    windows: Object.freeze(windows),
    crossEngineFields: 'semantic',
    actorIdentity: 'record-level (r13 view)',
  });
}

/** ONE comparator: exact operation-window evidence; elsewhere semantics, with actor placement judged by the record/R13 view. */
export function equalNativeTrace(
  a: Receipt,
  b: Receipt,
  pairs: readonly ReadPair[],
  provenBaselineAuxiliaries?: ReadonlySet<NativeFact>,
): boolean {
  for (const receipt of [a, b]) {
    if (receipt.issues.length) return refuse('unsupported native observation');
    validateHeapLinks(receipt); // ORIGINAL full receipts, including every auxiliary stage parent and memory child.
  }
  const comparison = nativeTraceComparison(pairs);
  const checked = pairs.map((pair) => checkedPair(a, b, pair));
  const view = (receipt: Receipt, side: 'baseline' | 'build') => {
    const selected = new Set(pairs.map((pair) => pair[side].nativeId));
    if (selected.size !== pairs.length) return refuse('native read claimed twice');
    const exclusions = new Set<NativeFact>();
    if (side === 'baseline' && provenBaselineAuxiliaries !== undefined) {
      for (const row of provenBaselineAuxiliaries) {
        if (
          exclusions.has(row) ||
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
        exclusions.add(row);
      }
      if (exclusions.size !== provenBaselineAuxiliaries.size) return refuse('semantic exclusion set is not unique');
    }
    // Maps are LOCAL TO EACH proved window. An outside R13 actor can never shift a window's ordinal.
    const owners = comparison.windows.map((window) => {
      const indices = pairs.flatMap((pair, index) =>
        equal(pair.baseline.coordinate, window.coordinate) ? [index] : [],
      );
      const first = checked[indices[0]][side === 'baseline' ? 0 : 1];
      for (const index of indices) {
        const owner = checked[index][side === 'baseline' ? 0 : 1];
        if (
          owner.read.frame !== first.read.frame ||
          owner.get.buffer !== first.get.buffer ||
          owner.get.epoch !== first.get.epoch ||
          !equal(owner.read.header, first.read.header)
        )
          return refuse('one proved operation window has different native owners');
      }
      return { owner: first, frames: new Map<number, number>(), buffers: new Map<number, number>() };
    });
    const local = (map: Map<number, number>, id: number | undefined) => {
      if (id === undefined) return undefined;
      if (!map.has(id)) map.set(id, map.size);
      return map.get(id);
    };
    const ordered = receipt.events.filter((event) => {
      if (!['stage-call', 'buffer-call', 'memory-get'].includes(event.tier ?? ''))
        return refuse('native origin tier was not observed');
      if (event.tier === 'memory-get') return false; // Full original parent/receiver/clock validation ran above.
      return (
        (event.tier === 'stage-call' && ['read', 'write'].includes(event.phase ?? '')) ||
        (event.tier === 'buffer-call' &&
          event.phase === 'write' &&
          ['set', 'merge', 'delete'].includes(event.method)) ||
        (event.tier === 'buffer-call' && event.method === 'commit')
      );
    });
    let previous = 0;
    const ids = new Set<number>();
    return ordered.flatMap((event: NativeFact) => {
      if (event.leg !== receipt.leg || event.start <= previous || event.end <= event.start || ids.has(event.id))
        return refuse('unordered, duplicate or foreign native occurrence');
      previous = event.start;
      ids.add(event.id);
      const window = comparison.windows.findIndex(
        (candidate) => candidate[side].start < event.start && event.end < candidate[side].end,
      );
      if (
        window < 0 &&
        comparison.windows.some((candidate) => event.start < candidate[side].end && candidate[side].start < event.end)
      )
        return refuse('native observation straddles a proved operation window');
      const labelled = comparison.windows.findIndex((candidate) => equal(event.operation, candidate.coordinate));
      if (labelled >= 0 && window !== labelled)
        return refuse('operation-bound native observation escaped its actual window');
      let actor: unknown;
      if (window >= 0) {
        const scoped = owners[window];
        const expected = scoped.owner;
        if (
          labelled !== window ||
          event.frame !== expected.read.frame ||
          !event.header ||
          !equal(event.header, expected.read.header)
        )
          return refuse('wrong frame/header/coordinate inside proved window');
        if (event.tier === 'buffer-call') {
          if (event.buffer !== expected.get.buffer || event.epoch !== expected.get.epoch)
            return refuse('wrong buffer/epoch inside proved window');
          const parents = receipt.events.filter(
            (parent) =>
              parent.tier === 'stage-call' &&
              parent.start < event.start &&
              event.end < parent.end &&
              parent.frame === event.frame &&
              parent.phase === event.phase &&
              equal(parent.operation, event.operation) &&
              equal(parent.header, event.header),
          );
          if (!parents.length) return refuse('window native child has no actual same-frame parent');
        }
        actor = {
          frame: local(scoped.frames, event.frame),
          buffer: local(scoped.buffers, event.buffer),
          epoch: event.epoch,
          header: { stageId: event.header.stageId, runtimeStageId: event.header.runtimeStageId },
        };
      }
      // Excluded auxiliary rows remain subject to ORIGINAL origin/order/window/owner validation.
      if (exclusions.has(event)) return [];
      const encoder = event.tier === 'buffer-call' && event.method === 'commit' ? event.encoder : undefined;
      if (
        event.tier === 'buffer-call' &&
        event.method === 'commit' &&
        (!encoder ||
          encoder.start <= event.start ||
          encoder.end >= event.end ||
          encoder.method !== (encoder.mode === 'full' ? 'toChangeOnlyPayload' : 'toDeltaPayload'))
      )
        return refuse('native commit lacks its original encoder');
      return [
        {
          method: event.method,
          outcome: event.outcome,
          phase: event.phase,
          operation: event.operation,
          arguments: event.call?.args,
          address: event.address,
          value: event.value,
          base: event.base && { found: event.base.found, value: event.base.value },
          gets: event.gets?.length,
          result: selected.has(event.id) ? { selectedRead124: true } : event.result,
          ...(window < 0 ? {} : { window, actor }),
          ...(encoder === undefined
            ? {}
            : { encoder: { method: encoder.method, mode: encoder.mode, bytes: encoder.bytes } }),
        },
      ];
    });
  };
  return equal(view(a, 'baseline'), view(b, 'build'));
}
