/**
 * The record contract, as the reader enforces it (docs/guides/record-contract.md).
 *
 * Test types: Contract (a hand-built record with no executor folds, stops
 * and tags exactly as the page promises) · Refusal vocabulary (every shape
 * the reader cannot read becomes a GAP with the reason the page names —
 * never a silent coercion, never a refusal of the whole record) · Law (the
 * four verbs are the only verbs; an unknown one is a gap, not a merge).
 */
import { describe, expect, it } from 'vitest';

import { bundleRefusal } from '../../../src/lib/time-travel/bundles.js';
import { stateAt, tagStops, timeTravel } from '../../../src/trace.js';

/** A record written by hand — the shape the contract page describes. */
function handBuiltRecord() {
  const bundle = (
    runtimeStageId: string,
    trace: readonly { path: string; verb: 'set' | 'merge' | 'append' | 'delete' }[],
    overwrite: Record<string, unknown>,
    updates: Record<string, unknown>,
    tags?: readonly string[],
  ) => ({
    runtimeStageId,
    stage: runtimeStageId.split('#')[0],
    stageId: runtimeStageId.split('#')[0],
    trace,
    overwrite,
    updates,
    redactedPaths: [],
    ...(tags ? { tags } : {}),
  });
  return {
    initialState: { count: 0, items: [] as number[], profile: { name: 'a' } },
    commitLog: [
      bundle('seed#0', [{ path: 'count', verb: 'set' }], { count: 1 }, {}),
      bundle('grow#1', [{ path: 'items', verb: 'append' }], { items: [10] }, {}, ['milestone:step']),
      bundle('enrich#2', [{ path: 'profile', verb: 'merge' }], {}, { profile: { age: 3 } }),
      bundle('forget#3', [{ path: 'count', verb: 'delete' }], { count: undefined }, {}, ['milestone:step']),
    ],
  };
}

describe('a record built by hand, read by the library', () => {
  it('folds at every stop from the frozen base through the four verbs', () => {
    const record = handBuiltRecord();
    const tt = timeTravel(record);
    expect(tt.stops.length).toBeGreaterThanOrEqual(4);
    expect(stateAt(record, 0).state).toEqual({ count: 1, items: [], profile: { name: 'a' } });
    expect(stateAt(record, 1).state).toEqual({ count: 1, items: [10], profile: { name: 'a' } });
    expect(stateAt(record, 2).state).toEqual({ count: 1, items: [10], profile: { name: 'a', age: 3 } });
    expect(stateAt(record, 3).state).toEqual({ items: [10], profile: { name: 'a', age: 3 } });
    expect(stateAt(record, 3).basis).toBe('initial+log');
    expect(stateAt(record, 3).skipped).toBeUndefined();
  });

  it('a base is optional: without one the fold says so (log-only)', () => {
    const { commitLog } = handBuiltRecord();
    expect(stateAt({ commitLog }, 1).basis).toBe('log-only');
    expect(stateAt({ commitLog }, 1).state).toEqual({ count: 1, items: [10] });
  });

  it('declared tags on bundles give a tag axis with no tree at all', () => {
    const record = handBuiltRecord();
    const tt = timeTravel(record, { strategy: tagStops(['milestone:step']) });
    expect(tt.stops.filter((s) => s.kind === 'commit').map((s) => s.commitIdx)).toEqual([1, 3]);
  });
});

describe('the reader’s refusal vocabulary — a gap with a reason, never a coercion', () => {
  const good = handBuiltRecord().commitLog[0]!;
  it.each([
    [null, 'not an object (null)'],
    [[], 'not an object (array)'],
    ['x', 'not an object (string)'],
    [{ ...good, runtimeStageId: undefined }, 'runtimeStageId is missing, not a string'],
    [{ ...good, runtimeStageId: 7 }, 'runtimeStageId is a number, not a string'],
    [{ ...good, trace: undefined }, 'trace is missing, not an array'],
    [{ ...good, trace: {} }, 'trace is a object, not an array'],
    [{ ...good, updates: 'no' }, 'updates is not a plain object'],
    [{ ...good, overwrite: [] }, 'overwrite is not a plain object'],
    [
      { ...good, trace: [{ path: 'count', verb: 'upsert' }] },
      'trace[0].verb is "upsert", not set | merge | append | delete',
    ],
    [{ ...good, trace: [{ path: 'count' }] }, 'trace[0].verb is missing, not set | merge | append | delete'],
  ])('%#: names the gap', (row, reason) => {
    expect(bundleRefusal(row)).toBe(reason);
  });

  it('a bundle with an unknown verb is skipped and reported, the rest of the record still folds', () => {
    const record = handBuiltRecord();
    const broken = { ...record.commitLog[1]!, trace: [{ path: 'items', verb: 'upsert' }] };
    const log = [record.commitLog[0], broken, record.commitLog[2], record.commitLog[3]];
    const folded = stateAt({ initialState: record.initialState, commitLog: log }, 3);
    expect(folded.skipped).toEqual([
      { index: 1, reason: 'trace[0].verb is "upsert", not set | merge | append | delete' },
    ]);
    expect(folded.state).toEqual({ items: [], profile: { name: 'a', age: 3 } });
  });
});
