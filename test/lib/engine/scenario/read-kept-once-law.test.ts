/**
 * The read-kept-once law takes a named difference out of a comparison (`read-kept-once-law.ts`). A law
 * that accepted anything would make that comparison worthless, so the law itself is tested here on
 * small hand-built records: it takes out exactly its own facts, and refuses everything else.
 */
import { describe, expect, it } from 'vitest';

import { withoutKeptOnce } from './read-kept-once-law.js';

type Json = Record<string, any>;

/** A two-step record: Seed writes `box`, then S0 writes `w0` and is said to have read `box` as `read`. */
function record(read: unknown, warnings: string[] = [], also: Json = {}): Record<string, string> {
  const tree = {
    id: 'seed',
    runtimeStageId: 'seed#0',
    name: 'Seed',
    stageWrites: { box: { n: 1 } },
    next: {
      id: 's0',
      runtimeStageId: 's0#1',
      name: 'S0',
      stageWrites: { w0: 0 },
      stageReads: { box: read, ...also },
    },
  };
  const log = [
    { runtimeStageId: 'seed#0', trace: [] },
    { runtimeStageId: 's0#1', trace: [] },
  ];
  const folds = [
    { box: { n: 1 }, other: { m: 1 } },
    { box: { n: 1 }, other: { m: 1 }, w0: 0 },
  ];
  return {
    runError: '',
    stageErrors: '',
    warnings: warnings.join('\n'),
    commitLog: JSON.stringify(log),
    sharedState: JSON.stringify(folds[1]),
    executionTree: JSON.stringify(tree),
    folds: folds.map((fold) => JSON.stringify(fold)).join('\n'),
  };
}
const report = (stage: string, where: string) =>
  `[footprint] Stage "${stage}" changed \`${where}\` IN PLACE, on a value it only read. footprint never saw that write.`;

describe('the read-kept-once law', () => {
  it('moves nothing when the two records are the same', () => {
    const old = record({ n: 1 });
    const build = record({ n: 1 });
    expect(withoutKeptOnce(old, build)).toEqual({ build, moved: [], reported: [], reportedBefore: [] });
  });

  it('takes out a read the build kept as the stage began with it, and hands back the reports on it', () => {
    const old = record({ n: 1, edited: true });
    const build = record({ n: 1 }, [report('S0', 'box.edited')]);
    const law = withoutKeptOnce(old, build);
    expect(law.moved).toEqual(['S0 box']);
    expect(law.reported).toEqual(['S0 box']);
    expect(law.reportedBefore).toEqual([]);
    // What is left is the older engine's record, byte for byte.
    expect(law.build).toEqual(old);
  });

  it('refuses a read that differs and is NOT what the stage began with', () => {
    const old = record({ n: 1, edited: true });
    const build = record({ n: 2 });
    expect(() => withoutKeptOnce(old, build)).toThrow(/'box' is kept as \{"n":2\}, the stage began with \{"n":1\}/);
  });

  it('refuses a report that differs on a read it did not move', () => {
    const old = record({ n: 1, edited: true }, [], { other: { m: 1 } });
    const build = record({ n: 1 }, [report('S0', 'other.m')], { other: { m: 1 } });
    expect(() => withoutKeptOnce(old, build)).toThrow(/a warning differs outside the reads it moved \[S0 box\]/);
    // And when no read moved at all, a report alone is refused too.
    const same = record({ n: 1 });
    expect(() => withoutKeptOnce(same, record({ n: 1 }, [report('S0', 'box.n')]))).toThrow(/warning/);
  });

  it('refuses a stage that read other keys than the older engine says', () => {
    const old = record({ n: 1 }, [], { other: { m: 1 } });
    const build = record({ n: 1 });
    expect(() => withoutKeptOnce(old, build)).toThrow(/reads \[box\], the older engine \[box,other\]/);
  });

  it('leaves alone two records that differ in what was committed: that is another law', () => {
    const old = record({ n: 1, edited: true });
    const build = { ...record({ n: 1 }), sharedState: '{"elsewhere":true}' };
    expect(withoutKeptOnce(old, build)).toEqual({ build, moved: [], reported: [], reportedBefore: [] });
  });

  it('touches nothing else in the tree: another difference stays for the comparison to find', () => {
    const old = record({ n: 1, edited: true });
    const build = record({ n: 1 });
    const tampered = { ...build, executionTree: build.executionTree.replace('"w0":0', '"w0":1') };
    const law = withoutKeptOnce(old, tampered);
    expect(law.moved).toEqual(['S0 box']);
    expect(law.build.executionTree).not.toBe(old.executionTree);
    expect(law.build.executionTree).toContain('"w0":1');
  });
});
