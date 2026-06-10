/**
 * Unit tests — `commitValueAt(commitLog, idx, key)` (#13c-B).
 *
 * The migration helper for the one real semantic break of delta mode:
 * "read `bundle.overwrite[key]` as the full value written". Folds
 * verb-qualified entries (set anchor + append tails + merge deltas +
 * delete resets) back into the full value at any commit index — the per-key
 * slice of `applySmartMerge` replay.
 */
import { commitValueAt } from '../../../../src/lib/memory/commitLogUtils';
import type { CommitBundle } from '../../../../src/lib/memory/types';

let nextIdx = 0;
function bundle(
  trace: CommitBundle['trace'],
  overwrite: Record<string, unknown> = {},
  updates: Record<string, unknown> = {},
): CommitBundle {
  return {
    idx: nextIdx,
    stage: `S${nextIdx}`,
    stageId: `s${nextIdx++}`,
    runtimeStageId: `s${nextIdx}#${nextIdx}`,
    trace,
    redactedPaths: [],
    overwrite,
    updates,
  };
}

beforeEach(() => {
  nextIdx = 0;
});

describe('Unit: commitValueAt (#13c-B)', () => {
  it('folds a set anchor plus append tails into the full array', () => {
    const log = [
      bundle([{ path: 'history', verb: 'set' }], { history: [1] }),
      bundle([{ path: 'history', verb: 'append' }], { history: [2] }),
      bundle([{ path: 'history', verb: 'append' }], { history: [3, 4] }),
    ];
    expect(commitValueAt(log, 0, 'history')).toEqual([1]);
    expect(commitValueAt(log, 1, 'history')).toEqual([1, 2]);
    expect(commitValueAt(log, 2, 'history')).toEqual([1, 2, 3, 4]);
  });

  it('a later set RE-ANCHORS — earlier appends are superseded', () => {
    const log = [
      bundle([{ path: 'tags', verb: 'set' }], { tags: ['a'] }),
      bundle([{ path: 'tags', verb: 'append' }], { tags: ['b'] }),
      bundle([{ path: 'tags', verb: 'set' }], { tags: ['z'] }), // e.g. a shrink fallback
      bundle([{ path: 'tags', verb: 'append' }], { tags: ['y'] }),
    ];
    expect(commitValueAt(log, 3, 'tags')).toEqual(['z', 'y']);
  });

  it('matches findLastWriter(...).overwrite[key] semantics on full-mode logs (set-only)', () => {
    const log = [bundle([{ path: 'k', verb: 'set' }], { k: 'v1' }), bundle([{ path: 'k', verb: 'set' }], { k: 'v2' })];
    expect(commitValueAt(log, 0, 'k')).toBe('v1');
    expect(commitValueAt(log, 1, 'k')).toBe('v2');
  });

  it('returns undefined for a never-written key and after a delete', () => {
    const log = [
      bundle([{ path: 'k', verb: 'set' }], { k: 1 }),
      bundle([{ path: 'k', verb: 'delete' }], { k: undefined }),
    ];
    expect(commitValueAt(log, 1, 'ghost')).toBeUndefined();
    expect(commitValueAt(log, 1, 'k')).toBeUndefined();
    expect(commitValueAt(log, 0, 'k')).toBe(1); // before the delete
  });

  it('a set after a delete re-establishes the value', () => {
    const log = [
      bundle([{ path: 'k', verb: 'set' }], { k: 1 }),
      bundle([{ path: 'k', verb: 'delete' }], { k: undefined }),
      bundle([{ path: 'k', verb: 'set' }], { k: 2 }),
    ];
    expect(commitValueAt(log, 2, 'k')).toBe(2);
  });

  it('folds merge deltas onto the set anchor with deepSmartMerge semantics', () => {
    const log = [
      bundle([{ path: 'cfg', verb: 'set' }], { cfg: { a: 1 } }),
      bundle([{ path: 'cfg', verb: 'merge' }], {}, { cfg: { b: 2 } }),
    ];
    expect(commitValueAt(log, 1, 'cfg')).toEqual({ a: 1, b: 2 });
  });

  it('merge with NO set anchor folds from absent (the documented initial-state blind spot)', () => {
    const log = [bundle([{ path: 'cfg', verb: 'merge' }], {}, { cfg: { b: 2 } })];
    expect(commitValueAt(log, 0, 'cfg')).toEqual({ b: 2 });
  });

  it('idx beyond the log clamps to the end; idx before the first touch returns undefined', () => {
    const log = [bundle([], {}), bundle([{ path: 'k', verb: 'set' }], { k: 1 })];
    expect(commitValueAt(log, 99, 'k')).toBe(1);
    expect(commitValueAt(log, 0, 'k')).toBeUndefined();
  });

  it('returns a DETACHED clone — mutating the result never edits the log', () => {
    const log = [bundle([{ path: 'list', verb: 'set' }], { list: [{ v: 1 }] })];
    const out = commitValueAt(log, 0, 'list') as Array<{ v: number }>;
    out[0].v = 99;
    expect((log[0].overwrite.list as Array<{ v: number }>)[0].v).toBe(1);
  });

  it('handles duplicate full-mode trace entries on one path (replays each, last value wins)', () => {
    // Full-mode bundles may carry duplicate {path, verb:'set'} entries — each
    // replays the same final value; the fold must stay correct.
    const log = [
      bundle(
        [
          { path: 'k', verb: 'set' },
          { path: 'k', verb: 'set' },
        ],
        { k: 'final' },
      ),
    ];
    expect(commitValueAt(log, 0, 'k')).toBe('final');
  });
});
