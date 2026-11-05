/** Closed original CHART operation joins. No staged-state reconstruction or new observation port. */
import type { PropagationFact } from '../nativeTraceFacts.js';
import type { ReadPair } from '../readLawWitness.js';
import { checkedPair, equal, refuse } from '../readLawWitness.js';
import type { NativeFact, OperationSpan, ValueFact } from '../readWitness.js';
import { validateHeapLinks } from '../readWitness.js';
import {
  branchAt,
  getOf,
  noIntervening,
  operation,
  pairedSpan,
  producers,
  readRows,
  wholeRows,
} from './propagationRows.js';
import { requireOwnStagedRead } from './recordValue.js';
import { chartBranchPair } from './strategies/chartBranch.js';
import type { BranchPlan, BranchReceipt, Context, FixtureCall } from './types.js';
import { args } from './valueFacts.js';

interface Anchor {
  readonly from: readonly (string | number)[];
  readonly to: readonly (string | number)[];
  readonly oldId: number;
  readonly oldValue: ValueFact;
  readonly newId?: number;
  readonly newValue: ValueFact;
  readonly oldProducer: NativeFact;
  readonly newProducer: NativeFact;
  readonly oldEnd: number;
  readonly newEnd: number;
}
export interface Propagations {
  readonly baseline: ReadonlySet<NativeFact>;
  readonly build: ReadonlySet<NativeFact>;
  readonly facts: readonly PropagationFact[];
  readonly earliestRead?: readonly (string | number)[];
}
const object = (value: ValueFact) => ['array', 'object', 'date'].includes(value.kind);
const root = (read: FixtureCall) => {
  const roots = read.resultIdentities?.filter((entry) => entry.path.length === 0);
  if (
    !object(read.result!) ||
    !Number.isSafeInteger(read.resultObject) ||
    read.resultObject! <= 0 ||
    roots?.length !== 1 ||
    roots[0].object !== read.resultObject
  )
    return refuse('propagation input has no actual returned root identity');
  return read.resultObject!;
};
const closed = (op: Readonly<Record<string, unknown>>, fields: readonly string[]) =>
  equal(Object.keys(op).sort(), [...fields].sort());

/** No admitted hop can omit a source row. All other rows remain with the ONE comparator. */
export function proveChartPropagation(context: Context, plan: BranchPlan): Propagations {
  const baseline = new Set<NativeFact>();
  const build = new Set<NativeFact>();
  const declared: { start: number; fact: PropagationFact }[] = [];
  if (context.family !== 'chart' || !['copy', 'selfMerge', 'mergeFirst'].includes(String(context.op.t)))
    return { baseline, build, facts: [] };
  // Other primary branches keep their prior exact outside comparison. No scalar gets a propagation grant.
  if (!context.reads[0].read.result || !object(context.reads[0].read.result)) return { baseline, build, facts: [] };
  if (!context.a.operations && !context.b.operations) return { baseline, build, facts: [] };
  if (!context.a.operations || !context.b.operations) return refuse('propagation operation observations are missing');
  validateHeapLinks(context.a.native);
  validateHeapLinks(context.b.native);
  const [x, y] = context.reads;
  const oldPrimary = context.cause.baseline;
  const newPrimary = context.cause.build;
  const oldProducers = producers(context, 'baseline', oldPrimary, x.read as FixtureCall, x.get, plan.baselineWrites);
  const newProducers = producers(context, 'build', newPrimary, y.read as FixtureCall, y.get, plan.buildWrites);
  const acceptedOld = new Set([context.reads[0].deletedBy, ...oldProducers]);
  const acceptedNew = new Set([context.reads[1].deletedBy, ...newProducers]);
  const recordJoins: { side: 'baseline' | 'build'; read: FixtureCall; get: NativeFact; producer: NativeFact }[] = [];
  const used = new Set<OperationSpan>();
  const claim = (side: 'baseline' | 'build', rows: Iterable<NativeFact>) => {
    const target = side === 'baseline' ? baseline : build;
    for (const row of rows) {
      if (target.has(row)) return refuse('one native propagation row was claimed twice');
      target.add(row);
    }
  };
  const paired = (span: OperationSpan) => {
    const next = pairedSpan(context, span);
    const old = branchAt(context, 'baseline', span);
    const now = branchAt(context, 'build', next);
    if (!equal(old.path, now.path)) return refuse('propagation has different actual user paths');
    return { old, now, next, op: operation(context, old, now) };
  };
  const note = (
    start: number,
    branch: BranchReceipt,
    from: Anchor['from'],
    to: Anchor['to'],
    read: FixtureCall,
    output: ValueFact,
    via: PropagationFact['via'],
    producer?: NativeFact,
  ) => {
    declared.push({
      start,
      fact: {
        operation: branch.operation.coordinate,
        fromAddress: from,
        toAddress: to,
        baselineIdentity: root(read),
        buildValue: output,
        via,
        ...(producer ? { baselineProducer: producer.id } : {}),
      },
    });
  };
  const input = (anchor: Anchor, oldRead: FixtureCall, newRead: FixtureCall) => {
    const oldGet = getOf(context, 'baseline', oldRead, true);
    const newGet = getOf(context, 'build', newRead, true);
    if (
      !equal(oldGet.address, anchor.to) ||
      !equal(newGet.address, anchor.to) ||
      !equal(oldRead.call.args, newRead.call.args)
    )
      return refuse('propagation input is on another address/operand');
    noIntervening(context.a, anchor.oldProducer, oldRead, anchor.to);
    noIntervening(context.b, anchor.newProducer, newRead, anchor.to);
    const oldChanged = root(oldRead) !== anchor.oldId || !equal(oldRead.result, anchor.oldValue);
    const newChanged = !equal(newRead.result, anchor.newValue) || newRead.resultObject !== anchor.newId;
    if ((oldChanged && anchor.oldProducer.method !== 'merge') || (newChanged && anchor.newProducer.method !== 'merge'))
      return refuse('propagation input is not SAME and has no joined native merge producer');
    if (oldChanged || newChanged) {
      // Actual staged-value joins are checked AFTER every later overlapping producer is accounted.
      recordJoins.push({ side: 'baseline', read: oldRead, get: oldGet, producer: anchor.oldProducer });
      recordJoins.push({ side: 'build', read: newRead, get: newGet, producer: anchor.newProducer });
    }
    return { oldGet, newGet, bridge: oldChanged || newChanged };
  };
  const writes = (
    old: BranchReceipt,
    now: BranchReceipt,
    oldRead: FixtureCall,
    newRead: FixtureCall,
    oldGet: NativeFact,
    newGet: NativeFact,
    a: readonly FixtureCall[],
    b: readonly FixtureCall[],
  ) => {
    const ap = producers(context, 'baseline', old, oldRead, oldGet, a);
    const bp = producers(context, 'build', now, newRead, newGet, b);
    for (const row of ap) acceptedOld.add(row);
    for (const row of bp) acceptedNew.add(row);
    claim('baseline', wholeRows(context.a, old, [...readRows(context.a, oldRead, oldGet), ...a, ...ap]));
    claim('build', wholeRows(context.b, now, [...readRows(context.b, newRead, newGet), ...b, ...bp]));
    return { ap, bp };
  };

  const source: Anchor = {
    from: x.get.address!,
    to: x.get.address!,
    oldId: root(x.read as FixtureCall),
    oldValue: x.read.result!,
    newId: y.read.resultObject,
    newValue: y.read.result!,
    oldProducer: x.deletedBy,
    newProducer: y.deletedBy,
    oldEnd: oldPrimary.operation.end,
    newEnd: newPrimary.operation.end,
  };

  function follow(initial: Anchor, depth = 0): void {
    if (depth > context.a.operations!.length) return refuse('propagation repeats an original operation');
    let anchor = initial;
    for (const span of context.a.operations!) {
      if (used.has(span) || span.start <= anchor.oldEnd || span.end >= context.cause.baselineCommit.start) continue;
      const stageCalls = context.a.native.events.filter(
        (row) => row.tier === 'stage-call' && equal(row.operation, span.coordinate),
      );
      if (!stageCalls.length || stageCalls[0].frame !== x.read.frame) continue;
      const matching = stageCalls.filter(
        (row) =>
          row.method === 'getValue' &&
          row.gets?.length === 1 &&
          equal(context.a.native.events.find((get) => get.id === row.gets![0])?.address, anchor.to),
      );
      if (!matching.length) continue;
      if (matching.length !== 1) return refuse('one propagation operation reads its source ambiguously');
      const { old, now, next, op } = paired(span);
      if (next.start <= anchor.newEnd) return refuse('build propagation order differs');
      const oldRead = matching[0] as FixtureCall;
      const index = old.calls.indexOf(oldRead);
      const newRead = now.calls[index];
      if (!newRead || newRead.method !== 'getValue') return refuse('corresponding propagation read is missing');
      const joined = input(anchor, oldRead, newRead);
      const via = joined.bridge ? 'native-producer-readback' : 'branch';
      used.add(span);
      if (op.t === 'readAll') {
        if (!closed(op, ['t']) || old.calls.length !== 5 || now.calls.length !== 5)
          return refuse('unknown readAll propagation shape');
        const keys = ['a', 'b', 'list', 'obj', 'hist'];
        for (const [i, name] of keys.entries()) {
          if (
            !equal(old.calls[i].call.args, args(old.path, name)) ||
            !equal(now.calls[i].call.args, args(now.path, name))
          )
            return refuse('readAll changed a non-source operand or order');
        }
        const aRows = old.calls.flatMap((read) => readRows(context.a, read, getOf(context, 'baseline', read)));
        const bRows = now.calls.flatMap((read) => readRows(context.b, read, getOf(context, 'build', read)));
        wholeRows(context.a, old, aRows);
        wholeRows(context.b, now, bRows);
        claim('baseline', readRows(context.a, oldRead, joined.oldGet));
        claim('build', readRows(context.b, newRead, joined.newGet));
        note(span.start, old, anchor.from, anchor.to, oldRead, newRead.result!, via, anchor.oldProducer);
        anchor = {
          ...anchor,
          oldId: root(oldRead),
          oldValue: oldRead.result!,
          newId: newRead.resultObject,
          newValue: newRead.result!,
          oldEnd: span.end,
          newEnd: next.end,
        };
        continue;
      }
      if (index !== 0) return refuse('propagation source is not its declared first read');
      if (op.t === 'elem') {
        if (
          !closed(op, ['t', 'k', 'i', 'p', 'v']) ||
          typeof op.k !== 'string' ||
          !equal(oldRead.call.args, args(old.path, op.k)) ||
          !Number.isSafeInteger(op.i) ||
          (op.i as number) < 0 ||
          (op.i as number) > 3 ||
          !['x', 'y', 'n'].includes(op.p as string) ||
          old.calls.length !== 1 ||
          now.calls.length !== 1
        )
          return refuse('unknown read-only elem tail');
        for (const read of [oldRead, newRead])
          if (
            read.result?.kind === 'array' &&
            read.result.entries?.some(
              (row) => Array.isArray(row) && row[0] === String(op.i) && row[2]?.kind === 'object',
            )
          )
            return refuse('elem would take an unproved writing branch');
        writes(old, now, oldRead, newRead, joined.oldGet, joined.newGet, [], []);
        note(span.start, old, anchor.from, anchor.to, oldRead, newRead.result!, via, anchor.oldProducer);
        anchor = { ...anchor, oldEnd: span.end, newEnd: next.end };
        continue;
      }
      let aWrites: readonly FixtureCall[], bWrites: readonly FixtureCall[];
      if (op.t === 'copy') {
        if (
          !closed(op, ['t', 'k', 'k2']) ||
          typeof op.k !== 'string' ||
          !equal(oldRead.call.args, args(old.path, op.k)) ||
          old.calls.length !== 2 ||
          now.calls.length !== 2 ||
          typeof op.k2 !== 'string' ||
          !['a', 'b', 'list', 'obj', 'hist'].includes(op.k2)
        )
          return refuse('unknown explicit copy hop');
        for (const [branch, read] of [
          [old, oldRead],
          [now, newRead],
        ] as const) {
          const write = branch.calls[1];
          if (
            write.method !== 'setObject' ||
            !equal(write.call.args.slice(0, 2), args(branch.path, op.k2)) ||
            write.call.args.length !== 5 ||
            !equal(write.call.args[2], read.result) ||
            !equal(write.call.args.slice(3), args(undefined, undefined)) ||
            write.call.objects[2] !== read.resultObject
          )
            return refuse('copy did not write that actual input identity/value');
        }
        aWrites = [old.calls[1]];
        bWrites = [now.calls[1]];
      } else {
        const proof = chartBranchPair(
          op as Parameters<typeof chartBranchPair>[0],
          { branch: old, read: oldRead, native: context.a.native },
          { branch: now, read: newRead, native: context.b.native },
        );
        if (proof.kind !== 'declared-chart-branches') return refuse(proof.reason);
        aWrites = proof.baselineWrites;
        bWrites = proof.buildWrites;
      }
      const physical = writes(old, now, oldRead, newRead, joined.oldGet, joined.newGet, aWrites, bWrites);
      const destination = physical.ap.at(-1)?.address ?? anchor.to;
      if (physical.bp.length && !equal(physical.bp.at(-1)?.address, destination))
        return refuse('derived producers name different canonical addresses');
      note(
        span.start,
        old,
        anchor.to,
        destination,
        oldRead,
        bWrites.at(-1)?.call.args[2] ?? newRead.result!,
        op.t === 'copy' ? 'copy' : via,
        physical.ap.at(-1),
      );
      const write = aWrites.at(-1);
      if (!write || !Number.isSafeInteger(write.call.objects[2])) {
        anchor = { ...anchor, oldEnd: span.end, newEnd: next.end };
        continue;
      }
      const edge: Anchor = {
        from: anchor.to,
        to: destination,
        oldId: write.call.objects[2]!,
        oldValue: write.call.args[2],
        newId: bWrites.at(-1)?.call.objects[2],
        newValue: bWrites.at(-1)?.call.args[2] ?? newRead.result!,
        oldProducer: physical.ap.at(-1)!,
        newProducer: physical.bp.at(-1) ?? anchor.newProducer,
        oldEnd: span.end,
        newEnd: next.end,
      };
      if (equal(destination, anchor.to)) anchor = edge;
      else follow(edge, depth + 1); // ONE explicit copy edge; no address/value state table.
    }
  }

  // Earliest readAll slot is retained as evidence, not discarded as an earlier prefix (corpus97).
  let earliest: { start: number; operation: readonly (string | number)[] } | undefined;
  for (const span of context.a.operations) {
    if (!(x.deletedBy.end < span.start && span.end < oldPrimary.operation.start)) continue;
    const calls = context.a.native.events.filter(
      (row) => row.tier === 'stage-call' && equal(row.operation, span.coordinate),
    );
    if (!calls.length || calls[0].frame !== x.read.frame) continue;
    const at = calls.findIndex(
      (read) =>
        read.method === 'getValue' &&
        read.gets?.length === 1 &&
        equal(context.a.native.events.find((get) => get.id === read.gets![0])?.address, source.to),
    );
    if (at < 0) continue;
    const { old, now, next, op } = paired(span);
    if (op.t !== 'readAll' || !closed(op, ['t']) || old.calls.length !== 5 || now.calls.length !== 5)
      return refuse('preceding changed source read is not closed readAll evidence');
    const keys = ['a', 'b', 'list', 'obj', 'hist'];
    for (const [i, name] of keys.entries())
      if (
        old.calls[i].method !== 'getValue' ||
        now.calls[i].method !== 'getValue' ||
        !equal(old.calls[i].call.args, args(old.path, name)) ||
        !equal(now.calls[i].call.args, args(now.path, name))
      )
        return refuse('earlier readAll changed another key or order');
    const bound = (branch: BranchReceipt, read: FixtureCall) => ({
      ...branch.operation,
      nativeId: read.id,
      occurrence: at,
    });
    const pair: ReadPair = {
      baseline: bound(old, old.calls[at]),
      build: bound(now, now.calls[at]),
      sites: [],
      operationSpans: { baseline: span, build: next },
    };
    const [a, b] = checkedPair(context.a.native, context.b.native, pair);
    if (
      a.deletedBy !== x.deletedBy ||
      b.deletedBy !== y.deletedBy ||
      root(a.read as FixtureCall) !== source.oldId ||
      !equal(a.read.result, x.read.result) ||
      !equal(a.read.resultIdentities, x.read.resultIdentities)
    )
      return refuse('earlier readAll does not join the same tombstone and stale identity');
    noIntervening(context.a, a.deletedBy, x.read, source.to);
    noIntervening(context.b, b.deletedBy, y.read, source.to);
    wholeRows(
      context.a,
      old,
      old.calls.flatMap((read, i) => readRows(context.a, read, i === at ? a.get : getOf(context, 'baseline', read))),
    );
    wholeRows(
      context.b,
      now,
      now.calls.flatMap((read, i) => readRows(context.b, read, i === at ? b.get : getOf(context, 'build', read))),
    );
    claim('baseline', readRows(context.a, old.calls[at], a.get));
    claim('build', readRows(context.b, now.calls[at], b.get));
    note(span.start, old, source.to, source.to, old.calls[at], now.calls[at].result!, 'read-only-prelude');
    if (!earliest || span.start < earliest.start) earliest = { start: span.start, operation: span.coordinate };
    used.add(span);
  }
  if (context.op.t === 'copy' && oldProducers.length === 1 && newProducers.length === 1) {
    if (
      plan.baselineWrites[0].call.objects[2] !== source.oldId ||
      !equal(plan.buildWrites[0].call.args[2], source.newValue) ||
      !equal(oldProducers[0].address, newProducers[0].address)
    )
      return refuse('primary copy has no exact derived producer');
    const derived: Anchor = {
      ...source,
      from: source.to,
      to: oldProducers[0].address!,
      oldProducer: oldProducers[0],
      newProducer: newProducers[0],
    };
    note(
      oldPrimary.operation.start,
      oldPrimary,
      source.to,
      derived.to,
      x.read as FixtureCall,
      source.newValue,
      'copy',
      oldProducers[0],
    );
    follow(derived);
    follow(source);
  } else if (context.op.t === 'selfMerge' && oldProducers.length === 1 && oldProducers[0].method === 'merge') {
    if (oldProducers[0].valueObject !== source.oldId || newProducers.length)
      return refuse('primary merge input is not identity-joined to the cause');
    follow({ ...source, oldProducer: oldProducers[0] });
  }
  for (const join of recordJoins)
    requireOwnStagedRead(
      context,
      join.side,
      join.read,
      join.get,
      join.producer,
      join.side === 'baseline' ? acceptedOld : acceptedNew,
    );
  return {
    baseline,
    build,
    facts: declared.sort((a, b) => a.start - b.start).map(({ fact }) => fact),
    ...(earliest ? { earliestRead: earliest.operation } : {}),
  };
}
