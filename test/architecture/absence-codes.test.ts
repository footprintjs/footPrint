/**
 * Architecture — every reader that can answer `undefined` (or empty) for a KEY says why (F4b, 9.33.0).
 *
 * The packet's review question — "find a reader that returns `undefined` for a key without a code saying
 * why" — answered as a table and pinned:
 *
 *   1. EVERY function `footprintjs/trace` hands out is on one of the two lists below: a KEY READER (with the
 *      place its code lives), or NOT one (with the reason). A new export that is on neither fails here.
 *   2. Each key reader is asked, on one log, for a key that was never written, one that was deleted and one
 *      that was written only through rows inside it — and each answer that is `undefined`, empty or partial
 *      carries a registered code (`HONESTY_CODES`), or names the twin / sibling query that carries it.
 *
 * Where the code lives, per reader:
 *   commitValueAt          → its twin `commitValueAtWithBasis` (`basis`; same value, pinned by a property)
 *   findLastWriter         → its twin `findLastWriterWithBasis` (`basis`)
 *   sliceForKey            → `missing` (empty-log | never-written), `notes` ('nested-rows')
 *   causalChain            → per edge `basis` ('nested-rows'); `undefined` only for an id not in the log
 *   arrayProvenance        → `missing`, and `basis` (the value twin's codes)
 *   elementProvenance      → `arrayProvenance` (documented: the Map.get-like convenience; ask it for `missing`)
 *   keyTimeline / forwardSliceForKey → `missing`, `notes`
 *   stateAt                → `FoldedState.basis` ('log-only' | 'initial+log'), `redactedPaths`, `skipped`
 *   findCommit(log, stageId, key) → a MEMBERSHIP question: `undefined` means exactly "no commit of that
 *                            stage wrote the key" — the question states its own answer; `findLastWriterWithBasis`
 *                            says why a key has no writer at all.
 */
import { describe, expect, it } from 'vitest';

import { HONESTY_CODES } from '../../src/lib/memory/honesty';
import type { CommitBundle } from '../../src/lib/memory/types';
import * as trace from '../../src/trace';

const KEY_READERS = [
  'commitValueAt',
  'commitValueAtWithBasis',
  'findLastWriter',
  'findLastWriterWithBasis',
  'findCommit',
  'sliceForKey',
  'causalChain',
  'arrayProvenance',
  'elementProvenance',
  'keyTimeline',
  'forwardSliceForKey',
  'stateAt',
];

const NOT_KEY_READERS: Record<string, string> = {
  BoundaryStateStore: 'a recorder store keyed by runtimeStageId, not a log reader',
  CommitRangeIndex: 'commit-index ranges, no state key',
  ControlDepRecorder: 'a recorder (decider per step), no state key',
  InOutRecorder: 'a recorder (subflow boundaries), no state key',
  KeyedStore: 'a recorder store keyed by runtimeStageId',
  QualityRecorder: 'a recorder (per-step quality), no state key',
  SequenceStore: 'a recorder store (ordered events)',
  TopologyRecorder: 'a recorder (graph shape)',
  UnknownVerbError: 'an error class',
  buildBranchSegment: 'id grammar',
  buildCommitIndex: 'runtimeStageId → commit index, no state key',
  buildRuntimeStageId: 'id grammar',
  commitIndexOf: 'runtimeStageId → commit index (-1 = not in this log, its documented indexOf answer)',
  commitStops: 'the time-travel axis, no state key',
  controlDepRecorder: 'recorder factory',
  createExecutionCounter: 'id grammar',
  filterStops: 'the time-travel axis',
  findCommits: 'by stageId only, no state key',
  flattenCausalDAG: 'a projection of a causalChain answer',
  formatCausalChain: 'a rendering of a causalChain answer',
  formatForwardSlice: 'a rendering (it prints the notes and missing reason)',
  formatQualityTrace: 'a rendering of a quality trace',
  formatSlice: 'a rendering (it prints the missing reason and, since 9.33.0, the notes)',
  formatTimeline: 'a rendering (it prints the notes and missing reason)',
  forwardSliceToJSON: 'a serialization (it carries the notes and missing reason)',
  hasBranchSegmentMarker: 'id grammar',
  inOutRecorder: 'recorder factory',
  isBranchSegment: 'id grammar',
  isCommitBundle: 'a shape guard',
  keysReadFromExecutionTree: 'a reads provider, not an answer about a key',
  keysReadFromMap: 'a reads provider',
  normaliseStateKey: 'key spelling',
  parseBranchSegment: 'id grammar',
  parseRuntimeStageId: 'id grammar',
  pathSegments: 'key spelling',
  qualityTrace: 'a quality projection, no state key',
  resolveKeysReadSource: 'a reads provider',
  sliceToJSON: 'a serialization (it carries missing, notes and edge basis)',
  splitAxis: 'the time-travel axis',
  splitStageId: 'id grammar',
  tagStops: 'the time-travel axis',
  timeTravel: 'a cursor over stops; its fold is stateAt',
  topologyRecorder: 'recorder factory',
  walkSubflowSpec: 'a chart-spec walker',
};

const D = '\u001F';
function bundle(idx: number, trace: CommitBundle['trace'], overwrite: Record<string, unknown>): CommitBundle {
  return {
    idx,
    stage: `S${idx}`,
    stageId: `s${idx}`,
    runtimeStageId: `s${idx}#${idx}`,
    trace,
    overwrite,
    updates: {},
    redactedPaths: [],
  } as CommitBundle;
}

/** x set; gone set then deleted; cfg written ONLY through a row inside it (a subflow seed's shape); y read cfg. */
const LOG: CommitBundle[] = [
  bundle(
    0,
    [
      { path: 'x', verb: 'set' },
      { path: 'gone', verb: 'set' },
    ],
    { x: 1, gone: [1] },
  ),
  bundle(1, [{ path: 'gone', verb: 'delete' }], { gone: undefined }),
  bundle(2, [{ path: `cfg${D}a`, verb: 'set' }], { cfg: { a: 1 } }),
  bundle(3, [{ path: 'y', verb: 'set' }], { y: 2 }),
];
const READS = trace.keysReadFromMap(new Map([['s3#3', ['cfg']]]));
const registered = (code: string) => Object.prototype.hasOwnProperty.call(HONESTY_CODES, code);

describe('every reader that can answer undefined for a key says why', () => {
  it('every function on footprintjs/trace is classified: a key reader, or not one with its reason', () => {
    const fns = Object.keys(trace).filter((k) => typeof (trace as Record<string, unknown>)[k] === 'function');
    const unclassified = fns.filter(
      (k) => !KEY_READERS.includes(k) && !Object.prototype.hasOwnProperty.call(NOT_KEY_READERS, k),
    );
    expect(unclassified, 'classify the new export here').toEqual([]);
    for (const name of [...KEY_READERS, ...Object.keys(NOT_KEY_READERS)]) expect(fns, name).toContain(name);
  });

  it('commitValueAt / commitValueAtWithBasis: never written, deleted, nested — each with its code', () => {
    const never = trace.commitValueAtWithBasis(LOG, 3, 'never');
    expect(trace.commitValueAt(LOG, 3, 'never')).toBeUndefined();
    expect(never).toEqual({ value: undefined, basis: ['never-written', 'from-initial-state'] });
    expect(trace.commitValueAtWithBasis(LOG, 3, 'gone')).toEqual({ value: undefined, basis: ['deleted'] });
    expect(trace.commitValueAtWithBasis(LOG, 3, 'cfg')).toEqual({
      value: { a: 1 },
      basis: ['nested-rows', 'from-initial-state'],
    });
    expect(trace.commitValueAtWithBasis(LOG, 3, 'x')).toEqual({ value: 1, basis: [] }); // exact: no code
    // With the base, the partial answer is whole, and says what it rests on.
    expect(trace.commitValueAtWithBasis(LOG, 3, 'cfg', { initialState: { cfg: { z: 0 } } })).toEqual({
      value: { z: 0, a: 1 },
      basis: ['nested-rows', 'from-initial-state'],
    });
    expect(trace.commitValueAtWithBasis(LOG, 3, 'never', { initialState: {} })).toEqual({
      value: undefined,
      basis: ['never-written'],
    });
  });

  it('findLastWriter / findLastWriterWithBasis', () => {
    expect(trace.findLastWriter(LOG, 'never')).toBeUndefined();
    expect(trace.findLastWriterWithBasis(LOG, 'never')).toEqual({ basis: ['never-written'] });
    expect(trace.findLastWriterWithBasis(LOG, 'cfg')).toEqual({ writer: LOG[2], basis: ['nested-rows'] });
    expect(trace.findLastWriterWithBasis(LOG, 'x')).toEqual({ writer: LOG[0], basis: [] });
  });

  it('findCommit: a membership question — undefined means exactly "that stage did not write the key"', () => {
    expect(trace.findCommit(LOG, 's3', 'x')).toBeUndefined();
    expect(trace.findCommit(LOG, 's0', 'x')).toBe(LOG[0]);
  });

  it('sliceForKey: missing for no writer, a nested-rows note for a writer inside the key (and on the wire + the string)', () => {
    expect(trace.sliceForKey(LOG, 'never', READS).missing).toBe('never-written');
    expect(trace.sliceForKey([], 'never', READS).missing).toBe('empty-log');
    const nested = trace.sliceForKey(LOG, 'cfg', READS);
    expect(nested.notes?.map((n) => n.code)).toEqual(['nested-rows']);
    expect(trace.sliceToJSON(nested).notes?.map((n) => n.code)).toEqual(['nested-rows']);
    expect(trace.formatSlice(nested)).toContain('⚠');
    expect(trace.sliceForKey(LOG, 'x', READS)).not.toHaveProperty('notes'); // exact: the 9.32.0 shape
  });

  it('causalChain: an edge to a writer inside the key carries basis nested-rows; undefined only for an unknown id', () => {
    const root = trace.causalChain(LOG, 's3#3', READS.lookup)!;
    expect(root.parentEdges.map((e) => [e.key, e.basis])).toEqual([['cfg', 'nested-rows']]);
    expect(trace.sliceToJSON({ key: 'y', keysReadKind: 'map', writer: LOG[3], root }).edges?.[0].basis).toBe(
      'nested-rows',
    );
    expect(trace.causalChain(LOG, 'nope#9', READS.lookup)).toBeUndefined();
  });

  it('arrayProvenance / elementProvenance: missing, and the value basis', () => {
    expect(trace.arrayProvenance(LOG, 'never')).toEqual({ key: 'never', missing: 'never-written' });
    expect(trace.arrayProvenance(LOG, 'gone')).toEqual({ key: 'gone', missing: 'not-an-array', basis: ['deleted'] });
    expect(trace.arrayProvenance(LOG, 'x')).toEqual({ key: 'x', missing: 'not-an-array' });
    expect(trace.elementProvenance(LOG, 'gone', 0)).toBeUndefined(); // the convenience; arrayProvenance says why
  });

  it('keyTimeline / forwardSliceForKey / stateAt', () => {
    expect(trace.keyTimeline(LOG, 'never', READS).missing).toBe('never-written');
    expect(trace.keyTimeline(LOG, 'cfg', READS).notes.map((n) => n.code)).toContain('nested-rows');
    expect(trace.forwardSliceForKey(LOG, 'never', READS).missing).toBe('never-written');
    const folded = trace.stateAt({ commitLog: LOG }, 3);
    expect((folded.state as Record<string, unknown>).never).toBeUndefined();
    expect(folded.basis).toBe('log-only');
  });

  it('every code these answers carry is registered', () => {
    const codes = [
      ...trace.commitValueAtWithBasis(LOG, 3, 'cfg').basis,
      ...trace.findLastWriterWithBasis(LOG, 'cfg').basis,
      ...(trace.arrayProvenance(LOG, 'gone').basis ?? []),
    ];
    for (const code of codes) expect(registered(code), code).toBe(true);
  });
});
