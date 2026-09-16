/**
 * The fold, resumable (9.25.0): one clone per fold, and a cursor stepping
 * forward applies one bundle instead of replaying from the base.
 *
 * Test types: Law (a memoised fold equals a fresh fold at EVERY stop — state,
 * basis, throughCommitIdx) · Law (an earlier stop after a later one folds
 * from scratch, same answer) · Invariant (the log is never touched by a fold:
 * byte-identical before and after) · Contract (the standalone `stateAt`
 * keeps its answer).
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { stateAt, timeTravel } from '../../../src/trace.js';

type State = {
  obj: { a?: number; b?: number; nested?: { x: number } };
  list: number[];
  n: number;
  [k: string]: unknown;
};

async function runFixture() {
  let builder = flowChart<State>(
    'Seed',
    async (scope) => {
      scope.$setValue('obj', { a: 1, nested: { x: 0 } });
      scope.$setValue('list', [0]);
      scope.$setValue('n', 0);
    },
    'seed',
  );
  for (let i = 1; i <= 24; i++) {
    builder = builder.addFunction(
      `S${i}`,
      async (scope) => {
        // set · merge · append · delete, in rotation, so every verb folds.
        if (i % 4 === 1) scope.$setValue('n', i);
        if (i % 4 === 2) scope.$update('obj', { b: i, nested: { x: i } });
        if (i % 4 === 3) scope.$update('list', [i]);
        if (i % 4 === 0) {
          const obj = { ...(scope.$getValue('obj') as State['obj']) };
          delete obj.b;
          scope.$setValue('obj', obj);
        }
        scope.$setValue(`k_${i}`, { i, tag: `v${i}` });
      },
      `s${i}`,
    );
  }
  const executor = new FlowChartExecutor(builder.build());
  await executor.run();
  return executor.getSnapshot();
}

describe('the resumable fold', () => {
  it('stepping forward equals a fresh fold at every stop — state, basis, throughCommitIdx', async () => {
    const snapshot = await runFixture();
    const stepping = timeTravel(snapshot);
    for (const stop of stepping.stops) {
      const fresh = timeTravel(snapshot).stateAt(stop);
      const memo = stepping.stateAt(stop);
      expect(memo.state).toEqual(fresh.state);
      expect(memo.basis).toBe(fresh.basis);
      expect(memo.throughCommitIdx).toBe(fresh.throughCommitIdx);
      expect(memo.redactedPaths).toEqual(fresh.redactedPaths);
    }
  });

  it('an earlier stop after a later one folds from scratch — same answer as fresh', async () => {
    const snapshot = await runFixture();
    const tt = timeTravel(snapshot);
    const stops = tt.stops;
    tt.stateAt(stops[stops.length - 1]!);
    const back = tt.stateAt(stops[3]!);
    expect(back.state).toEqual(timeTravel(snapshot).stateAt(stops[3]!).state);
    // and forward again from there
    const fwd = tt.stateAt(stops[9]!);
    expect(fwd.state).toEqual(timeTravel(snapshot).stateAt(stops[9]!).state);
  });

  it('a fold never touches the log: byte-identical before and after, and the state handed out is frozen', async () => {
    const snapshot = await runFixture();
    const before = JSON.stringify(snapshot.commitLog);
    const tt = timeTravel(snapshot);
    for (const stop of tt.stops) tt.stateAt(stop);
    tt.stateAt(tt.stops[2]!);
    expect(JSON.stringify(snapshot.commitLog)).toBe(before);
    const last = tt.stateAt(tt.stops[tt.stops.length - 1]!);
    expect(Object.isFrozen(last.state)).toBe(true);
    expect(Object.isFrozen((last.state as State).obj)).toBe(true);
  });

  it('the standalone stateAt(source, commitIdx) still answers as the cursor does', async () => {
    const snapshot = await runFixture();
    const tt = timeTravel(snapshot);
    const stop = tt.stops[7]!;
    expect(stateAt(snapshot, stop.lastCommitIdx).state).toEqual(tt.stateAt(stop).state);
  });
});
