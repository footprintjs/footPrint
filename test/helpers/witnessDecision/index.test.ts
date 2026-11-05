import { describe, expect, it } from 'vitest';

import type { Decision, DecisionPorts, Row } from './index.js';
import { decideWitness, formatWitnessDecision } from './index.js';

const row = (bytes: string, foldsBack = true): Row => ({ bytes, foldsBack });
const ports = (extra: Partial<DecisionPorts> = {}): DecisionPorts => ({
  differs: true,
  sameCommit: (a, b) => a === b,
  ...extra,
});
const coordinate = Object.freeze(['chart', 0, 'stage', 1, 'invocation', 0, 'op', 2]);

describe('FIRST-boundary decision ordering', () => {
  it('refuses a non-folding build even when every kept byte is otherwise unchanged', () => {
    expect(decideWitness([row('same')], [row('same', false)], ports({ differs: false }))).toEqual({
      kind: 'broken',
      code: 'build-fold-back',
      index: 0,
    });
  });

  it.each([false, true])('checks EVERY build foldback before differs=%s or any admission port', (differs) => {
    const touched: string[] = [];
    const result = decideWitness(
      [row('old', false), row('later')],
      [row('new'), row('later', false)],
      ports({
        differs,
        sameCommit: () => {
          touched.push('compare');
          return false;
        },
        firstReadCause: () => {
          touched.push('first');
          throw new Error('must not reach optional proof');
        },
        retainedReadCause: () => {
          touched.push('retained');
          throw new Error('must not reach optional proof');
        },
        coordinateOf: () => {
          touched.push('coordinate');
          return { kind: 'not-collected' };
        },
      }),
    );
    expect(result).toEqual({ kind: 'broken', code: 'build-fold-back', index: 1 });
    expect(touched).toEqual([]);
  });

  it('keeps the existing no-difference fast path after unconditional build validation', () => {
    expect(
      decideWitness(
        [row('different-old')],
        [row('different-new')],
        ports({
          differs: false,
          sameCommit: () => {
            throw new Error('no kept difference');
          },
          firstReadCause: () => {
            throw new Error('no kept difference');
          },
        }),
      ),
    ).toEqual({ kind: 'pass' });
  });

  it.each([
    { baseline: [row('a')], build: [row('a'), row('extra')], index: 1 },
    { baseline: [row('a'), row('extra')], build: [row('a')], index: 1 },
  ])('does not let optional proof admit a missing commit row', ({ baseline, build, index }) => {
    expect(
      decideWitness(
        baseline,
        build,
        ports({
          firstReadCause: () => {
            throw new Error('no two-sided commit');
          },
          retainedReadCause: () => {
            throw new Error('not retained-only');
          },
        }),
      ),
    ).toEqual({ kind: 'broken', code: 'commit-count', index });
  });

  it('keeps named 9.30 admission on the first differing baseline non-foldback commit', () => {
    const nativeCoordinate = Object.freeze({
      kind: 'native-commit' as const,
      leg: 'chart:0',
      id: 17,
      frame: 4,
      buffer: 2,
      epoch: 3,
      stageId: 'actual-stage',
      runtimeStageId: 'actual-instance',
    });
    const lookups: unknown[] = [];
    const result = decideWitness(
      [row('same'), row('old', false)],
      [row('same'), row('new')],
      ports({
        coordinateOf: (side, commit) => {
          lookups.push([side, commit]);
          return nativeCoordinate;
        },
        firstReadCause: () => {
          throw new Error('9.30 path does not borrow #124');
        },
        retainedReadCause: () => {
          throw new Error('not retained-only');
        },
      }),
    );
    expect(result).toEqual({
      kind: 'cause',
      name: 'admitted-record-9.30',
      shape: 'first-commit',
      commit: 1,
      coordinate: nativeCoordinate,
    });
    if (result.kind !== 'cause' || result.shape !== 'first-commit') throw new Error('Expected first-commit cause.');
    expect(result.coordinate).toBe(nativeCoordinate);
    expect(lookups).toEqual([['baseline', 1]]);
  });

  it('does not invent an operation coordinate for legacy hand-made 9.30 rows', () => {
    expect(decideWitness([row('old', false)], [row('new')], ports())).toEqual({
      kind: 'cause',
      name: 'admitted-record-9.30',
      shape: 'first-commit',
      commit: 0,
      coordinate: { kind: 'not-collected' },
    });
  });

  it('asks #124 only about the FIRST differing commit and carries the supplied exact coordinate as data', () => {
    const asked: number[] = [];
    const result = decideWitness(
      [row('same'), row('old'), row('downstream-old')],
      [row('same'), row('new'), row('downstream-new')],
      ports({
        firstReadCause: (first) => {
          asked.push(first);
          return { kind: 'cause', name: 'read-after-delete-124', commit: first, coordinate };
        },
        retainedReadCause: () => {
          throw new Error('changed commits are not retained-only');
        },
      }),
    );
    expect(result).toEqual({
      kind: 'cause',
      name: 'read-after-delete-124',
      shape: 'first-commit',
      commit: 1,
      coordinate: { kind: 'fixture-operation', at: coordinate },
    });
    if (result.kind !== 'cause' || result.shape !== 'first-commit' || result.coordinate.kind !== 'fixture-operation')
      throw new Error('Expected observed operation coordinate.');
    expect(result.coordinate.at).toBe(coordinate);
    expect(asked).toEqual([1]);
  });

  it('a later valid #124 claim cannot clear an earlier coherent difference', () => {
    expect(
      decideWitness(
        [row('old-first'), row('old-later')],
        [row('new-first'), row('new-later')],
        ports({
          firstReadCause: () => ({ kind: 'cause', name: 'read-after-delete-124', commit: 1, coordinate }),
          retainedReadCause: () => {
            throw new Error('no retained escape');
          },
        }),
      ),
    ).toEqual({ kind: 'broken', code: 'coherent-commit-difference', index: 0 });
  });

  it('does not admit a first-commit claim with no operation coordinate', () => {
    expect(
      decideWitness(
        [row('old')],
        [row('new')],
        ports({
          firstReadCause: () => ({ kind: 'cause', name: 'read-after-delete-124', commit: 0, coordinate: [] }),
        }),
      ),
    ).toEqual({ kind: 'broken', code: 'coherent-commit-difference', index: 0 });
  });

  it('does not let a retained-only proof bypass an unproved first changed commit', () => {
    expect(
      decideWitness(
        [row('old')],
        [row('new')],
        ports({
          retainedReadCause: () => {
            throw new Error('retained path must not run');
          },
        }),
      ),
    ).toEqual({ kind: 'broken', code: 'coherent-commit-difference', index: 0 });
  });

  it('retains the first proof refusal detail without weakening the old formatter', () => {
    const result = decideWitness(
      [row('old')],
      [row('new')],
      ports({
        firstReadCause: () => ({ kind: 'unproven', reason: 'wrong frame/leg/namespace/key or missing branch receipt' }),
      }),
    );
    expect(result).toEqual({
      kind: 'broken',
      code: 'coherent-commit-difference',
      index: 0,
      detail: 'wrong frame/leg/namespace/key or missing branch receipt',
    });
    expect(formatWitnessDecision(result)).toBe("commit 0 differs, but 9.28.0's bundle there folded back");
  });
});

describe('retained-only boundary', () => {
  it.each([
    { label: 'no commits', rows: [] },
    { label: 'matching commits', rows: [row('identical')] },
  ])('admits only the named retained relation when all commits match: $label', ({ rows }) => {
    const coordinates = Object.freeze([coordinate]);
    const result = decideWitness(
      rows,
      rows,
      ports({
        firstReadCause: () => {
          throw new Error('no differing commit');
        },
        retainedReadCause: () => ({ kind: 'related', name: 'read-after-delete-124', coordinates }),
      }),
    );
    expect(result).toEqual({ kind: 'cause', name: 'read-after-delete-124', shape: 'retained-only', coordinates });
    if (result.kind !== 'cause' || result.shape !== 'retained-only') throw new Error('Expected retained-only cause.');
    expect(result.coordinates).toBe(coordinates);
  });

  it('keeps no-commit differences broken without actual retained-slot proof', () => {
    expect(decideWitness([], [], ports())).toEqual({ kind: 'broken', code: 'identical-commits' });
  });

  it('keeps byte-identical commits broken when the retained relation reports an unrelated residual', () => {
    const result = decideWitness(
      [row('same')],
      [row('same')],
      ports({
        retainedReadCause: () => ({ kind: 'unproven', reason: 'kept.live.unrelated differs after exact slot checks' }),
      }),
    );
    expect(result).toEqual({
      kind: 'broken',
      code: 'identical-commits',
      detail: 'kept.live.unrelated differs after exact slot checks',
    });
    expect(formatWitnessDecision(result)).toBe('the runs differ but every commit is byte-identical');
  });

  it('does not accept an empty list of proved retained coordinates', () => {
    expect(
      decideWitness(
        [],
        [],
        ports({
          retainedReadCause: () => ({ kind: 'related', name: 'read-after-delete-124', coordinates: [] }),
        }),
      ),
    ).toEqual({ kind: 'broken', code: 'identical-commits' });
  });
});

describe('legacy exact diagnostic formatter', () => {
  const broken: readonly { decision: Decision; text: string }[] = [
    {
      decision: { kind: 'broken', code: 'build-fold-back', index: 3 },
      text: "the build's commit 3 does not fold back to what its stage read",
    },
    {
      decision: { kind: 'broken', code: 'commit-count', index: 2 },
      text: 'the engines made a different number of commits (2)',
    },
    {
      decision: {
        kind: 'broken',
        code: 'coherent-commit-difference',
        index: 1,
        detail: 'new detail stays beside text',
      },
      text: "commit 1 differs, but 9.28.0's bundle there folded back",
    },
    {
      decision: { kind: 'broken', code: 'identical-commits', detail: 'new detail stays beside text' },
      text: 'the runs differ but every commit is byte-identical',
    },
  ];
  it.each(broken)('preserves $decision.code bytes', ({ decision, text }) => {
    expect(formatWitnessDecision(decision)).toBe(text);
  });

  it.each<Decision>([
    { kind: 'pass' },
    {
      kind: 'cause',
      name: 'admitted-record-9.30',
      shape: 'first-commit',
      commit: 0,
      coordinate: { kind: 'not-collected' },
    },
    {
      kind: 'cause',
      name: 'read-after-delete-124',
      shape: 'first-commit',
      commit: 0,
      coordinate: { kind: 'fixture-operation', at: coordinate },
    },
    { kind: 'cause', name: 'read-after-delete-124', shape: 'retained-only', coordinates: [coordinate] },
  ])('returns the old empty diagnostic for $kind, with named cause retained separately', (decision) => {
    expect(formatWitnessDecision(decision)).toBe('');
  });
});
