/**
 * Unit tests — `memory/keyPaths.ts`, the path half of "which rows touch a key" (F3, 9.33.0).
 *
 *   unit      `relation` is a SEGMENT prefix on DELIM paths (exact / inside / around / disjoint, never a
 *             string prefix); `rootOf`; `ascendingUnion`
 *   boundary  `buildWriterIndex` — a path trie: one position per commit per path, its totals, its subtree;
 *             `writerCandidates` splits the commits a key may have been written by into the ones its PATH
 *             decides and the ones the fold must decide (a row only AROUND the key)
 *
 * The writer rule's fold half (`commitLogUtils · writersOf`) and the value rule (`commitValueAt`) are pinned
 * against `stateAt` in test/lib/memory/property/keyed-fold-differential.property.test.ts.
 */
import {
  ancestorNodes,
  ascendingUnion,
  between,
  buildWriterIndex,
  lastBefore,
  nodeAt,
  pathsWritten,
  relation,
  rootOf,
  subtreePositions,
  writerCandidates,
} from '../../../../src/lib/memory/keyPaths';
import { DELIM } from '../../../../src/lib/memory/paths';
import type { CommitBundle, TraceEntry } from '../../../../src/lib/memory/types';

const at = (...segments: string[]) => segments.join(DELIM);

function bundle(n: number, ...paths: string[]): CommitBundle {
  const trace: TraceEntry[] = paths.map((path) => ({ path, verb: 'set' }));
  return {
    idx: n,
    stage: `S${n}`,
    stageId: `s${n}`,
    runtimeStageId: `s${n}#${n}`,
    trace,
    overwrite: {},
    updates: {},
    redactedPaths: [],
  };
}

describe('relation — how a row path sits against a key path', () => {
  it('is exact on the key, inside below it, around above it', () => {
    expect(relation('cfg', 'cfg')).toBe('exact');
    expect(relation(at('cfg', 'b'), 'cfg')).toBe('inside');
    expect(relation(at('cfg', 'b', 'c'), 'cfg')).toBe('inside');
    expect(relation('cfg', at('cfg', 'a'))).toBe('around');
    expect(relation(at('cfg', 'a'), at('cfg', 'a', 'x'))).toBe('around');
    expect(relation(at('cfg', 'a'), at('cfg', 'a'))).toBe('exact');
  });

  it('is a SEGMENT prefix, never a string prefix: cfg is not around cfgX, cfg.a is not inside cfg.ab', () => {
    expect(relation('cfgX', 'cfg')).toBeUndefined();
    expect(relation('cfg', 'cfgX')).toBeUndefined();
    expect(relation(at('cfg', 'ab'), at('cfg', 'a'))).toBeUndefined();
    expect(relation(at('cfg', 'a'), at('cfg', 'ab'))).toBeUndefined();
    // a dot is part of a key, not a separator: a top-level key named 'cfg.a' is not inside 'cfg'
    expect(relation('cfg.a', 'cfg')).toBeUndefined();
  });

  it('is disjoint for siblings and for other top-level keys', () => {
    expect(relation(at('cfg', 'a'), at('cfg', 'b'))).toBeUndefined();
    expect(relation('a', 'b')).toBeUndefined();
    expect(relation(at('runs', 'c0', 'x'), 'x')).toBeUndefined();
  });
});

describe('rootOf / ascendingUnion', () => {
  it('rootOf is the first segment', () => {
    expect(rootOf('cfg')).toBe('cfg');
    expect(rootOf(at('cfg', 'a', 'b'))).toBe('cfg');
    expect(rootOf('a.b')).toBe('a.b');
  });

  it('ascendingUnion merges ascending lists without duplicates', () => {
    expect(ascendingUnion([])).toEqual([]);
    expect(ascendingUnion([[2, 5]])).toEqual([2, 5]);
    expect(ascendingUnion([[1, 4, 9], [4, 6], [0]])).toEqual([0, 1, 4, 6, 9]);
  });
});

describe('buildWriterIndex / writerCandidates', () => {
  const log = [
    bundle(0, 'cfg'),
    bundle(1, at('cfg', 'b'), at('cfg', 'b')), // two rows on one path in one commit: one position
    bundle(2, 'other'),
    bundle(3, at('cfg', 'a', 'x')),
    bundle(4, at('runs', 'c0', 'x')),
  ];
  const index = buildWriterIndex(log);

  it('is a path trie: one position per commit per path, totals beside them, every path under its top-level key', () => {
    expect(nodeAt(index, at('cfg', 'b'))?.positions).toEqual([1]);
    expect(nodeAt(index, 'cfg')?.positions).toEqual([0]);
    expect(nodeAt(index, 'cfg')?.totals).toEqual([0]); // the rows here are all `set`
    expect(nodeAt(index, at('cfg', 'a'))?.positions).toEqual([]); // a prefix, never written itself
    expect(subtreePositions(nodeAt(index, 'cfg')!)).toEqual([0, 1, 3]);
    expect(pathsWritten(index).sort()).toEqual(
      ['cfg', at('cfg', 'a', 'x'), at('cfg', 'b'), 'other', at('runs', 'c0', 'x')].sort(),
    );
    expect(index.roots.has('x')).toBe(false);
    expect(ancestorNodes(index, at('cfg', 'a', 'x')).map((n) => n.path)).toEqual(['cfg', at('cfg', 'a')]);
    expect(ancestorNodes(index, 'cfg')).toEqual([]);
  });

  it('lastBefore / between are binary searches over an ascending list', () => {
    expect(lastBefore([1, 4, 9], 9)).toBe(4);
    expect(lastBefore([1, 4, 9], 1)).toBe(-1);
    expect(between([1, 4, 9, 12], 1, 12)).toEqual([4, 9]);
    expect(between([1, 4, 9, 12], -1, Number.POSITIVE_INFINITY)).toEqual([1, 4, 9, 12]);
  });

  it('a top-level key: every commit with a row on it or inside it, and nothing around it', () => {
    expect(writerCandidates(index, 'cfg')).toEqual({ atOrInside: [0, 1, 3], aroundOnly: [] });
    expect(writerCandidates(index, 'other')).toEqual({ atOrInside: [2], aroundOnly: [] });
    expect(writerCandidates(index, 'never')).toEqual({ atOrInside: [], aroundOnly: [] });
  });

  it('a nested key: the commits its path decides, and the commits only AROUND it that the fold must decide', () => {
    // cfg.a: commit 3 wrote inside it; commit 0 set its container (around) — the fold decides whether that changed it.
    expect(writerCandidates(index, at('cfg', 'a'))).toEqual({ atOrInside: [3], aroundOnly: [0] });
    // cfg.b: commit 1 is on it; commit 0 is around it; commit 3 is a sibling (cfg.a.x) — not a candidate.
    expect(writerCandidates(index, at('cfg', 'b'))).toEqual({ atOrInside: [1], aroundOnly: [0] });
  });
});
