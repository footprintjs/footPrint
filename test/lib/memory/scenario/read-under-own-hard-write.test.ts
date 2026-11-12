/**
 * A read below the stage's own hard write, on the two real engines (the #124 read law, for a `set` as
 * for a `delete`).
 *
 * THE LAW (foottrace 1.11.1): a read the stage's buffer cannot answer falls back to live state only
 * when no `set` or `delete` of the same stage owns the path or a path above it. Engine 9.28.0 always
 * fell back, so it handed a stage the committed value of a path the stage itself had just replaced.
 *
 * WHY THIS FILE EXISTS. The differentials compare this build with 9.28.0 byte for byte, and take a
 * program out of the comparison where 9.28.0's answer is the stale one. The first form of that rule
 * knew a delete only (`helpers/readWitness · oracleDomain`). A `set` hides the old value in exactly
 * the same way, no program at the fixed seeds has that shape, and the first fresh seed
 * (`COW_DIFF_SEED=11`) made the nested differential fail on one, shrunk to the first program below:
 * "the runs differ but every commit is byte-identical". These are the small programs behind the wider
 * rule (`staleReadsUnderHardWrite`, used by fixture · `oracleVerdict`), each on the real engines.
 *
 * The rule takes a program out only when the difference starts where a stale read could put it: at no
 * commit, or at the commit of the stage that made the read. It does not prove that the read made the
 * difference, and it judges nothing after the point where the difference starts. What it excuses and
 * what it still catches are both tests below.
 *
 * Test type: scenario (the two engines side by side, hand-written programs).
 */
import { describe, expect, it } from 'vitest';

import {
  assertBuildHardWrittenReadsUndefined,
  commitsOfStaleReads,
  oracleDomain,
  staleReadsUnderHardWrite,
} from '../../../helpers/readWitness.js';
import {
  type NestedProgram,
  type WriteBackProgram,
  BASELINE,
  BUILD,
  firstDifference,
  firstDifferingCommit,
  observingSync,
  oracleVerdict,
  runNested,
  runWriteBack,
  staleReadExplains,
} from '../property/copy-on-write-fixture.js';

/** Stage 1 writes `list.y = 's'`. Stage 2 does `ops`: a write, then a read of `list.y`. In contract: nothing is edited in place. */
const program = (ops: NestedProgram['stages'][number]['ops']): NestedProgram => ({
  initial: undefined,
  stages: [
    { runId: '', ops: [{ t: 'set', path: 3, k: 'y', v: 's' }] }, // path 3 is ['list']
    { runId: '', ops },
  ],
  commitValues: 'full',
  mutate: false,
});
const READ_LIST_Y = { t: 'read', path: 3, k: 'y' } as const;

function both(p: NestedProgram) {
  const [a, aSeen, aNative] = observingSync(BASELINE, () => runNested(BASELINE, p));
  const [b, bSeen, bNative] = observingSync(BUILD, () => runNested(BUILD, p));
  const verdict = (differs = () => firstDifference(a, b) !== '') =>
    oracleVerdict(aSeen, bSeen, aNative, bNative, differs);
  return { a, b, aNative, bNative, verdict };
}

describe('a read below the stage’s own hard write', () => {
  it.each([
    ['a set of a text over the list', { t: 'set', path: 0, k: 'list', v: 's' }, 'set', 'in-domain'],
    ['a set of another object over it', { t: 'set', path: 0, k: 'list', v: { z: 1 } }, 'set', 'in-domain'],
    ['a delete of it', { t: 'del', path: 0, k: 'list' }, 'delete', 'out-of-domain'],
  ] as const)('%s: 9.28.0 answers the old value, the build answers nothing', (_name, write, method, firstRule) => {
    const { a, b, aNative, bNative, verdict } = both(program([write, READ_LIST_Y]));

    // The one difference between the two runs is what the read returned. Every commit is the same.
    expect(a.reads).toBe('"s"');
    expect(b.reads).toBe('null');
    expect(b.commitLog).toBe(a.commitLog);
    expect(firstDifference(a, b)).toMatch(/^reads differs/);

    // 9.28.0 answered a read its own buffer could not, below its own hard write. The build did not.
    const stale = staleReadsUnderHardWrite(aNative);
    expect(stale).toHaveLength(1);
    expect(stale[0].writtenBy.method).toBe(method);
    expect(stale[0].get.result).toEqual({ kind: 'undefined' });
    expect(staleReadsUnderHardWrite(bNative)).toEqual([]);
    expect(() => assertBuildHardWrittenReadsUndefined(bNative)).not.toThrow();

    // The first rule sees the delete only. Either way the program is out of the old engine's domain.
    expect(oracleDomain(aNative).kind).toBe(firstRule);
    expect(verdict()).toEqual({ excluded: true, broken: '' });
  });

  it('a set that holds the path is answered by the stage’s own value on both engines, and stays compared', () => {
    const { a, b, aNative, verdict } = both(program([{ t: 'set', path: 0, k: 'list', v: { y: 1 } }, READ_LIST_Y]));
    expect(a.reads).toBe('1');
    expect(b.reads).toBe('1');
    expect(staleReadsUnderHardWrite(aNative)).toEqual([]);
    expect(verdict()).toEqual({ excluded: false, broken: '' });
  });

  it('a merge owns nothing: a read beside what it added falls back to live state on both engines', () => {
    const { a, b, aNative, verdict } = both(program([{ t: 'merge', path: 0, k: 'list', v: { z: 1 } }, READ_LIST_Y]));
    expect(a.reads).toBe('"s"');
    expect(b.reads).toBe('"s"');
    expect(staleReadsUnderHardWrite(aNative)).toEqual([]);
    expect(verdict()).toEqual({ excluded: false, broken: '' });
  });

  it('the wider rule is asked only to explain a difference: a program that matches stays compared', () => {
    // The same stale read, in a run whose kept bytes are said to match: nothing to explain, so nothing is excused.
    const { aNative, verdict } = both(program([{ t: 'set', path: 0, k: 'list', v: 's' }, READ_LIST_Y]));
    expect(staleReadsUnderHardWrite(aNative)).toHaveLength(1);
    expect(verdict(() => false)).toEqual({ excluded: false, broken: '' });
  });

  it('a fault of the build in a later stage is still caught while the stale-reading stage’s own commit is the same in both runs', () => {
    // 9.28.0 runs the program. The "build" runs the same program with ONE other value in a later
    // stage: a stand-in for a build that writes a wrong value and still folds back. The second reader
    // of this rule ran this case against its first form, which excused it.
    const then = (value: number): NestedProgram => {
      const p = program([{ t: 'set', path: 0, k: 'list', v: 's' }, READ_LIST_Y]);
      return { ...p, stages: [...p.stages, { runId: '', ops: [{ t: 'set', path: 0, k: 'b', v: value }] }] };
    };
    const [a, aSeen, aNative] = observingSync(BASELINE, () => runNested(BASELINE, then(1)));
    const [b, bSeen, bNative] = observingSync(BUILD, () => runNested(BUILD, then(2)));
    // The stale read was made by the second stage (commit 1). The runs first differ at the third (commit 2).
    expect(commitsOfStaleReads(aNative)).toEqual([1]);
    expect(firstDifferingCommit(aSeen, bSeen)).toBe(2);
    expect(staleReadExplains(aSeen, bSeen, aNative)).toBe(false);
    expect(oracleVerdict(aSeen, bSeen, aNative, bNative, () => firstDifference(a, b) !== '')).toEqual({
      excluded: false,
      broken: "commit 2 differs, but 9.28.0's bundle there folded back",
    });
  });

  it('a stale value written back: the first differing commit is that stage’s own, and the program is taken out', () => {
    // The shape a fresh seed made (COW_DIFF_SEED=555555, write-back family): the stage deletes
    // `obj.deep`, writes beside it, then reads `obj.deep.deep`, edits what it got and writes it back.
    // 9.28.0 got the committed list and wrote `[0]`. The build got nothing, so it wrote nothing.
    const p: WriteBackProgram = {
      initial: undefined,
      stages: [
        { runId: '', ops: [{ t: 'set', path: 2, k: 'deep', v: [] }] },
        {
          runId: '',
          ops: [
            { t: 'del', path: 1, k: 'deep' },
            { t: 'delReadBack', path: 2, k: 'x', n: 0, how: 'set' },
            { t: 'readBack', path: 2, k: 'deep', n: 0, how: 'set' },
          ],
        },
      ],
      commitValues: 'full',
      mutate: true,
    };
    const [a, aSeen, aNative] = observingSync(BASELINE, () => runWriteBack(BASELINE, p));
    const [b, bSeen, bNative] = observingSync(BUILD, () => runWriteBack(BUILD, p));
    expect(b.commitLog).not.toBe(a.commitLog);
    // The first rule steps back: the write beside the delete counts as writing the path again.
    expect(oracleDomain(aNative).kind).toBe('in-domain');
    expect(commitsOfStaleReads(aNative)).toEqual([1]);
    expect(firstDifferingCommit(aSeen, bSeen)).toBe(1);
    expect(oracleVerdict(aSeen, bSeen, aNative, bNative, () => firstDifference(a, b) !== '')).toEqual({
      excluded: true,
      broken: '',
    });
  });

  it('once the stale-reading stage’s commit differs, nothing after it is judged: a fault in a later stage passes', () => {
    // The same stale value written back, and one more stage. 9.28.0 runs the program. The "build" runs
    // it with ONE other value in that later stage: a stand-in for a fault of the build that still folds
    // back. The second reader of this rule ran this case. It passes, and that is the limit of the rule:
    // a stale value that was written back changes state, so later stages may differ for the law's own
    // reason, and the rule does not try to tell those apart.
    const then = (value: number): WriteBackProgram => ({
      initial: undefined,
      stages: [
        { runId: '', ops: [{ t: 'set', path: 2, k: 'deep', v: [] }] },
        {
          runId: '',
          ops: [
            { t: 'del', path: 1, k: 'deep' },
            { t: 'delReadBack', path: 2, k: 'x', n: 0, how: 'set' },
            { t: 'readBack', path: 2, k: 'deep', n: 0, how: 'set' },
          ],
        },
        { runId: '', ops: [{ t: 'set', path: 0, k: 'b', v: value }] },
      ],
      commitValues: 'full',
      mutate: true,
    });
    const [a, aSeen, aNative] = observingSync(BASELINE, () => runWriteBack(BASELINE, then(1)));
    const [b, bSeen, bNative] = observingSync(BUILD, () => runWriteBack(BUILD, then(2)));
    expect(commitsOfStaleReads(aNative)).toEqual([1]);
    expect(firstDifferingCommit(aSeen, bSeen)).toBe(1);
    expect(bSeen[2].bytes).not.toBe(aSeen[2].bytes); // the later stage's commit differs too
    expect(oracleVerdict(aSeen, bSeen, aNative, bNative, () => firstDifference(a, b) !== '')).toEqual({
      excluded: true,
      broken: '',
    });
  });

  it('what it excuses, said by a test: any difference that starts at the stale-reading stage, or at no commit', () => {
    // So that nobody reads more into the rule. 9.28.0 has a stale read in its second stage (commit 1).
    const { aNative, bNative } = both(program([{ t: 'set', path: 0, k: 'list', v: 's' }, READ_LIST_Y]));
    const same = [
      { bytes: 'first', foldsBack: true },
      { bytes: 'second', foldsBack: true },
    ];
    const otherSecond = [same[0], { bytes: 'another second', foldsBack: true }];
    const otherFirst = [{ bytes: 'another first', foldsBack: true }, same[1]];
    // No commit differs, the runs are SAID to differ elsewhere: excused.
    expect(oracleVerdict(same, same, aNative, bNative, () => true)).toEqual({ excluded: true, broken: '' });
    // The stale-reading stage's own commit differs, for whatever reason: excused.
    expect(oracleVerdict(same, otherSecond, aNative, bNative, () => true)).toEqual({ excluded: true, broken: '' });
    // And so is every commit after it: nothing past the first difference is judged.
    const third = { bytes: 'third', foldsBack: true };
    const otherThird = { bytes: 'another third', foldsBack: true };
    expect(oracleVerdict([...same, third], [...otherSecond, otherThird], aNative, bNative, () => true)).toEqual({
      excluded: true,
      broken: '',
    });
    // An earlier stage's commit differs: not this law's, and it fails.
    expect(oracleVerdict(same, otherFirst, aNative, bNative, () => true).excluded).toBe(false);
  });

  it('it never excuses the build: a build commit that does not fold back is still named', () => {
    const { a, b, aNative, bNative } = both(program([{ t: 'set', path: 0, k: 'list', v: 's' }, READ_LIST_Y]));
    expect(staleReadsUnderHardWrite(aNative)).toHaveLength(1);
    const lyingBuild = [{ bytes: 'x', foldsBack: false }];
    expect(oracleVerdict([], lyingBuild, aNative, bNative, () => firstDifference(a, b) !== '').broken).toMatch(
      /the build's commit 0 does not fold back/,
    );
  });
});
