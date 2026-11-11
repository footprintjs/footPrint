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
 * Test type: scenario (the two engines side by side, hand-written programs).
 */
import { describe, expect, it } from 'vitest';

import {
  assertBuildHardWrittenReadsUndefined,
  oracleDomain,
  staleReadsUnderHardWrite,
} from '../../../helpers/readWitness.js';
import {
  type NestedProgram,
  BASELINE,
  BUILD,
  firstDifference,
  observingSync,
  oracleVerdict,
  runNested,
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

  it('it never excuses the build: a build commit that does not fold back is still named', () => {
    const { a, b, aNative, bNative } = both(program([{ t: 'set', path: 0, k: 'list', v: 's' }, READ_LIST_Y]));
    expect(staleReadsUnderHardWrite(aNative)).toHaveLength(1);
    const lyingBuild = [{ bytes: 'x', foldsBack: false }];
    expect(oracleVerdict([], lyingBuild, aNative, bNative, () => firstDifference(a, b) !== '').broken).toMatch(
      /the build's commit 0 does not fold back/,
    );
  });
});
