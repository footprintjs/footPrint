/** Closed root-array operand profile, recomputed from the original observed calls. */
import type { AuxiliaryProfile, AuxiliaryReceiverFact } from '../auxiliaryFacts.js';
import type { NativeFact, OperationSpan, ValueFact } from '../readWitness.js';
import { checkedPair } from './readPair.js';
import { type JoinedRun, type ReadPair, equal, refuse } from './types.js';

type Candidate =
  | { readonly kind: 'profile'; readonly evidence: AuxiliaryProfile; readonly reads: readonly NativeFact[] }
  | { readonly kind: 'unproven'; readonly reason: string };
const positive = (id: unknown): id is number => Number.isSafeInteger(id) && (id as number) > 0;

function memberSpan(run: JoinedRun, pair: ReadPair, side: 'baseline' | 'build'): OperationSpan {
  const span = pair.operationSpans?.[side];
  const bound = pair[side];
  if (
    !span ||
    !run.operations ||
    run.operations.filter((candidate) => candidate === span).length !== 1 ||
    run.operations.filter((candidate) => equal(candidate.coordinate, bound.coordinate)).length !== 1 ||
    !equal(span.coordinate, bound.coordinate) ||
    span.start !== bound.start ||
    span.end !== bound.end
  )
    return refuse('auxiliary profile lacks its actual by-reference member operation span');
  return span;
}
function readOperation(program: string, path: readonly (string | number)[]): string {
  if (!path.length || path.length > 128) return refuse('missing/bounded actual operation pointer');
  let value: unknown = JSON.parse(program);
  for (const segment of path) {
    if ((typeof segment !== 'string' && !Number.isSafeInteger(segment)) || value === null || typeof value !== 'object')
      return refuse('missing actual operation');
    const d = Object.getOwnPropertyDescriptor(value, segment);
    if (!d || !Object.hasOwn(d, 'value')) return refuse('actual operation is not own data');
    value = d.value;
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !equal(Object.keys(value).sort(), ['k', 't']) ||
    Object.getOwnPropertyDescriptor(value, 't')?.value !== 'read'
  )
    return refuse('not the closed unchanged read body');
  const key = Object.getOwnPropertyDescriptor(value, 'k')?.value;
  return typeof key === 'string' ? key : refuse('missing actual read key');
}
function flatArray(read: NativeFact): number {
  const value = read.result;
  const graph = read.resultIdentities;
  if (
    !positive(read.resultObject) ||
    value?.kind !== 'array' ||
    !Number.isSafeInteger(value.value) ||
    (value.value as number) < 0 ||
    !Array.isArray(value.entries) ||
    value.entries.length !== value.value ||
    !graph ||
    graph.length !== 1 ||
    graph[0].path.length !== 0 ||
    graph[0].object !== read.resultObject
  )
    return refuse('missing same-observer flat root-array identity');
  value.entries.forEach((entry, i) => {
    if (!Array.isArray(entry) || entry.length !== 3 || entry[0] !== String(i) || entry[1] !== true)
      return refuse('nested/sparse/expando array operand is unproven');
    const fact = entry[2] as ValueFact;
    if (!fact || !['undefined', 'null', 'string', 'number', 'boolean'].includes(fact.kind))
      return refuse('nested/opaque array operand is unproven');
  });
  return read.resultObject;
}
function calls(run: JoinedRun, span: OperationSpan): NativeFact[] {
  const rows = run.native.events.filter(
    (event) =>
      event.tier === 'stage-call' &&
      (event.phase === 'read' || event.phase === 'write') &&
      event.start < span.end &&
      event.end > span.start,
  );
  let end = span.start;
  const ids = new Set<number>();
  for (const row of rows) {
    if (
      !positive(row.id) ||
      ids.has(row.id) ||
      row.start <= end ||
      row.end <= row.start ||
      row.end >= span.end ||
      row.leg !== run.native.leg ||
      row.outcome !== 'returned' ||
      row.phase !== 'read' ||
      !equal(row.operation, span.coordinate)
    )
      return refuse('unreadable/overlapping/writing operation call');
    ids.add(row.id);
    end = row.end;
  }
  if (run.native.events.some((event) => event.phase === 'write' && event.start < span.end && event.end > span.start))
    return refuse('auxiliary profile contains a staged write');
  return rows;
}

/** Recomputed from original receipts and live member spans. Returned row references are internal, never authority from a caller. */
export function rootArrayAuxiliaryProfile(a: JoinedRun, b: JoinedRun, pair: ReadPair): Candidate {
  try {
    if (a.program !== b.program || a.native.issues.length || b.native.issues.length)
      return refuse('unusable actual program/native evidence');
    const [x, y] = checkedPair(a.native, b.native, pair);
    const oldSpan = memberSpan(a, pair, 'baseline');
    const nowSpan = memberSpan(b, pair, 'build');
    if (
      !equal(oldSpan.programPath, nowSpan.programPath) ||
      !equal(oldSpan.path, []) ||
      !equal(nowSpan.path, []) ||
      oldSpan.outcome !== 'returned' ||
      nowSpan.outcome !== 'returned' ||
      oldSpan.edits.length ||
      nowSpan.edits.length
    )
      return refuse('not the actual root read-only operation');
    const key = readOperation(a.program, oldSpan.programPath);
    if (readOperation(b.program, nowSpan.programPath) !== key) return refuse('different actual read operation');
    const args: readonly ValueFact[] = [
      { kind: 'array', value: 0, entries: [] },
      { kind: 'string', value: key },
    ];
    if (
      x.read.method !== 'getValue' ||
      y.read.method !== 'getValue' ||
      !equal(x.read.call?.args, args) ||
      !equal(y.read.call?.args, args) ||
      y.read.resultObject !== undefined ||
      !equal(y.read.resultIdentities, [])
    )
      return refuse('not the original root primary read/undefined pair');
    const object = flatArray(x.read);
    const old = calls(a, oldSpan);
    const now = calls(b, nowSpan);
    if (old[0] !== x.read || now.length !== 1 || now[0] !== y.read)
      return refuse('primary ownership/order or candidate auxiliary is not exact');
    const extra = old.slice(1);
    if (!extra.length || extra.length > 10_000) return refuse('absent/bounded actual auxiliary inventory');
    const receiverFacts = extra.map((read): AuxiliaryReceiverFact => {
      if (
        read.method !== 'getValueDirect' ||
        read.frame !== x.read.frame ||
        !equal(read.header, x.read.header) ||
        !equal(read.call?.args, args) ||
        flatArray(read) !== object ||
        !equal(read.result, x.read.result)
      )
        return refuse('auxiliary original return is not the SAME primary underlying-array operand');
      return Object.freeze({
        kind: 'original-getValueDirect-return',
        nativeReadId: read.id,
        primaryReadId: x.read.id,
        object,
      });
    });
    return {
      kind: 'profile',
      reads: Object.freeze(extra),
      evidence: Object.freeze({
        profile: 'root-array-json-operand-v1',
        coordinate: Object.freeze([...pair.baseline.coordinate]),
        primary: Object.freeze({ baselineNativeId: x.read.id, buildNativeId: y.read.id, baselineObject: object }),
        auxiliaryReadCount: extra.length,
        receiverFacts: Object.freeze(receiverFacts),
      }),
    };
  } catch (error) {
    return { kind: 'unproven', reason: error instanceof Error ? error.message : 'unreadable auxiliary profile' };
  }
}
