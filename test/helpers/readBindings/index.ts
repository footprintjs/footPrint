import { type JoinedRun, type ReadPair, checkedPair, projectSite } from '../readLawWitness.js';
import type { NativeFact, OperationSpan } from '../readWitness.js';
import { sameStageDeletedReadInputs } from '../readWitness.js';
import { retainedSites } from './retainedTrees.js';
import {
  type BasicFamily,
  type BindingResult,
  type ObservedKept,
  type QualifiedPair,
  type RetainedBindingResult,
  equal,
  own,
  stageReads,
} from './types.js';

export const joinedRun = (
  run: {
    value: unknown;
    commits: JoinedRun['commits'];
    native: JoinedRun['native'];
    operations: readonly OperationSpan[];
    program: string;
  },
  kept: Readonly<Record<string, string>>,
): ObservedKept => ({
  kept,
  commits: run.commits,
  native: run.native,
  operations: run.operations,
  program: run.program,
});
function appliedOperation(run: ObservedKept, span: OperationSpan): void {
  if (!span.programPath.length || !span.coordinate.length) throw new Error('Missing operation coordinate/pointer.');
  let at: unknown = JSON.parse(run.program);
  for (const part of span.programPath) at = own(at, part);
  if (at === null || typeof at !== 'object' || Array.isArray(at) || typeof own(at, 't') !== 'string')
    throw new Error('Operation pointer does not name actual applied program data.');
}
function spans(run: ObservedKept): Map<string, OperationSpan> {
  const result = new Map<string, OperationSpan>();
  for (const span of run.operations) {
    appliedOperation(run, span);
    const key = JSON.stringify(span.coordinate);
    if (result.has(key) || span.end <= span.start) throw new Error('Repeated/invalid actual operation span.');
    result.set(key, span);
  }
  return result;
}
function calls(run: ObservedKept, span: OperationSpan): NativeFact[] {
  const rows = run.native.events.filter(
    (event) =>
      event.tier === 'stage-call' &&
      event.operation !== undefined &&
      equal(event.operation, span.coordinate) &&
      (event.phase === 'read' || event.phase === 'write'),
  );
  if (
    rows.some(
      (event) =>
        !event.call ||
        event.frame === undefined ||
        !event.header ||
        !(span.start < event.start && event.end < span.end),
    )
  )
    throw new Error('Unjoined actual operation call.');
  if (new Set(rows.map((row) => row.frame)).size > 1)
    throw new Error('One operation has multiple native frame owners.');
  return rows;
}
function directReadLines(run: ObservedKept, family: BasicFamily): Map<number, number> {
  const found = new Map<number, number>();
  if (family === 'chart') return found;
  if (!Object.hasOwn(run.kept, 'reads')) throw new Error('Missing explicit read delivery field.');
  const lines = run.kept.reads === '' ? [] : run.kept.reads.split('\n');
  const reads = stageReads(run.native).filter((event) => event.method === 'getValue');
  if (reads.length !== lines.length || reads.some((event) => event.operation === undefined || !event.call))
    throw new Error('Explicit getValue/delivered-read count is not exact.');
  reads.forEach((event, i) => found.set(event.id, i));
  return found;
}
/** Pairs actual same-operation read occurrences; never searches another event by equal value/key. */
export function pairObservedReads(a: ObservedKept, b: ObservedKept): BindingResult {
  try {
    if (a.program !== b.program || a.native.leg !== b.native.leg || a.native.issues.length || b.native.issues.length)
      throw new Error('Unusable/different applied program or native leg.');
    const left = spans(a);
    const right = spans(b);
    const eligibleA = new Set(sameStageDeletedReadInputs(a.native).map(({ read }) => read.id));
    const eligibleB = new Set(sameStageDeletedReadInputs(b.native).map(({ read }) => read.id));
    const reads: QualifiedPair[] = [];
    for (const [key, spanA] of left) {
      const spanB = right.get(key);
      if (!spanB) continue; // A changed branch may omit a whole later operation; it cannot invent paired evidence.
      if (!equal(spanA.programPath, spanB.programPath))
        throw new Error('Same coordinate names another applied operation.');
      const callsA = calls(a, spanA);
      const callsB = calls(b, spanB);
      const rawA = callsA.filter((event) => event.phase === 'read' && event.outcome === 'returned');
      const rawB = callsB.filter((event) => event.phase === 'read' && event.outcome === 'returned');
      for (let occurrence = 0; occurrence < Math.min(rawA.length, rawB.length); occurrence++) {
        const x = rawA[occurrence];
        const y = rawB[occurrence];
        // A direct pair needs BOTH native witnesses. One-sided later rows stay in the exact trace.
        if (!eligibleA.has(x.id) || !eligibleB.has(y.id)) continue;
        if (x.method !== y.method || !equal(x.call!.args, y.call!.args))
          throw new Error('The same native read occurrence has different actual method/arguments.');
        // No #124 difference: both original native calls actually returned undefined.
        // Keep these rows/ordinals in the ordinary exact trace; stale nonundefined equality is NOT an exemption.
        if (x.result?.kind === 'undefined' && y.result?.kind === 'undefined') continue;
        const bound = (read: NativeFact, span: OperationSpan) => ({
          coordinate: span.coordinate,
          frame: read.frame!,
          start: span.start,
          end: span.end,
          nativeId: read.id,
          occurrence,
        });
        const pair: ReadPair = {
          baseline: bound(x, spanA),
          build: bound(y, spanB),
          sites: [],
          operationSpans: { baseline: spanA, build: spanB },
        };
        checkedPair(a.native, b.native, pair);
        reads.push({
          pair,
          baselineRead: x,
          buildRead: y,
          baselineSpan: spanA,
          buildSpan: spanB,
          baselineCalls: callsA,
          buildCalls: callsB,
        });
      }
    }
    return { kind: 'bindings', reads };
  } catch (error) {
    return { kind: 'unproven', reason: error instanceof Error ? error.message : 'Unreadable actual binding evidence.' };
  }
}

/** Shape1 only. A branch's primary read may be overwritten later; that does NOT invent final-slot ownership. */
export function bindRetainedPairs(
  a: ObservedKept,
  b: ObservedKept,
  family: BasicFamily,
  qualified: readonly QualifiedPair[],
): RetainedBindingResult {
  try {
    const linesA = directReadLines(a, family);
    const linesB = directReadLines(b, family);
    const pairs = qualified.map(({ pair, baselineRead: x, buildRead: y }) => {
      const [checkedA, checkedB] = checkedPair(a.native, b.native, pair);
      const sites = retainedSites(a, b, x, y);
      if (family !== 'chart') {
        const lineA = linesA.get(x.id);
        const lineB = linesB.get(y.id);
        if (lineA === undefined || lineA !== lineB)
          throw new Error('Paired explicit read has another delivery ordinal.');
        const site = { kind: 'read-line' as const, line: lineA };
        projectSite(a.kept.reads, 'build', site, checkedA);
        projectSite(b.kept.reads, 'build', site, checkedB);
        sites.unshift(site);
      }
      return { ...pair, sites };
    });
    return { kind: 'retained-bindings', pairs };
  } catch (error) {
    return {
      kind: 'unproven',
      reason: error instanceof Error ? error.message : 'Unreadable actual retention evidence.',
    };
  }
}
