/**
 * commitIndexOf / buildCommitIndex — the address translation between the id an
 * event carries (`runtimeStageId`) and the index every commit-log query speaks.
 *
 * FIRST occurrence is the contract, and it is load-bearing: a subflow mount and
 * a parallel fork child each commit more than one bundle under one id, and a
 * cursor asks "where does this stage START?".
 */

import fc from 'fast-check';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import type { CommitBundle } from '../../../src/lib/memory/types.js';
import { buildCommitIndex, commitIndexOf, stateAt } from '../../../src/trace.js';

function bundle(stageId: string, idx: number, rtid?: string): CommitBundle {
  return {
    idx,
    stage: stageId,
    stageId,
    runtimeStageId: rtid ?? `${stageId}#${idx}`,
    trace: [],
    redactedPaths: [],
    overwrite: {},
    updates: {},
  };
}

describe('commitIndexOf', () => {
  const log = [bundle('a', 0), bundle('sf', 1, 'sf#1'), bundle('sf', 2, 'sf#1'), bundle('b', 3)];

  it('finds a stage by its runtimeStageId', () => {
    expect(commitIndexOf(log, 'b#3')).toBe(3);
  });

  it('returns the FIRST bundle when a stage committed more than one', () => {
    expect(commitIndexOf(log, 'sf#1')).toBe(1);
  });

  it('returns -1 for a stage that is not in this log', () => {
    expect(commitIndexOf(log, 'sf/inner#9')).toBe(-1);
    expect(commitIndexOf([], 'a#0')).toBe(-1);
  });
});

describe('buildCommitIndex', () => {
  it('agrees with commitIndexOf for every id in the log', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('a', 'b', 'c', 'sf'), { minLength: 1, maxLength: 40 }), (stages) => {
        // Ids repeat on purpose — mounts and fork children do exactly this.
        const log = stages.map((s, i) => bundle(s, i, `${s}#${Math.floor(i / 2)}`));
        const index = buildCommitIndex(log);
        for (const b of log) {
          expect(index.get(b.runtimeStageId)).toBe(commitIndexOf(log, b.runtimeStageId));
        }
        expect(index.size).toBe(new Set(log.map((b) => b.runtimeStageId)).size);
      }),
      { numRuns: 50 },
    );
  });

  it('hands back a fresh map the caller owns', () => {
    const log = [bundle('a', 0)];
    const first = buildCommitIndex(log);
    first.set('spoof', 99);
    expect(buildCommitIndex(log).has('spoof')).toBe(false);
  });

  it('translates a real run’s ids into indices a fold can use', async () => {
    const chart = flowChart<any>(
      'One',
      async (scope: any) => {
        scope.a = 1;
      },
      'one',
    )
      .addFunction(
        'Two',
        async (scope: any) => {
          scope.b = 2;
        },
        'two',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const snapshot = executor.getSnapshot();

    const idx = commitIndexOf(snapshot.commitLog, snapshot.commitLog[0].runtimeStageId);
    expect(stateAt(snapshot, idx).state).toEqual({ a: 1 });
  });
});

describe('security — a log cannot reach through a fold', () => {
  it('a `__proto__` trace path does not pollute Object.prototype', () => {
    const evil: CommitBundle = {
      idx: 0,
      stage: 'evil',
      stageId: 'evil',
      runtimeStageId: 'evil#0',
      trace: [{ path: '__proto__', verb: 'set' }],
      redactedPaths: [],
      overwrite: { __proto__: { polluted: true } } as never,
      updates: {},
    };
    const folded = stateAt({ commitLog: [evil], initialState: {} }, 0);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(folded.state)).toBe(Object.prototype);
  });
});
