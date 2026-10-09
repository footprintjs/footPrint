/**
 * The fold, resumable (9.25.0): one clone per fold, and a cursor stepping
 * forward applies one bundle instead of replaying from the base.
 *
 * Test types: Law (a memoised fold equals a fresh fold at EVERY stop — state,
 * basis, throughCommitIdx) · Law (an earlier stop after a later one folds
 * from scratch, same answer) · Invariant (the log is never touched by a fold:
 * byte-identical before and after) · Contract (the standalone `stateAt`
 * keeps its answer).
 *
 * The record is written through `footprintjs/write` (test/helpers/recordRun.ts): the same bytes the
 * chart's executor wrote, with no engine loaded.
 */
import { describe, expect, it } from 'vitest';

import { stateAt, timeTravel } from '../../../src/trace.js';
import { recordRun } from '../../helpers/recordRun.js';

type State = {
  obj: { a?: number; b?: number; nested?: { x: number } };
  list: number[];
  n: number;
  [k: string]: unknown;
};

/** Twenty-five stages, written through `footprintjs/write` — the record a 25-stage chart writes. */
function runFixture() {
  const run = recordRun();
  run.step(
    'seed',
    (s) => {
      s.set('obj', { a: 1, nested: { x: 0 } });
      s.set('list', [0]);
      s.set('n', 0);
    },
    { name: 'Seed' },
  );
  for (let i = 1; i <= 24; i++) {
    run.step(
      `s${i}`,
      (s) => {
        // set · merge · append · delete, in rotation, so every verb folds.
        if (i % 4 === 1) s.set('n', i);
        if (i % 4 === 2) s.merge('obj', { b: i, nested: { x: i } });
        if (i % 4 === 3) s.merge('list', [i]);
        if (i % 4 === 0) {
          const obj = { ...(s.read('obj') as State['obj']) };
          delete obj.b;
          s.set('obj', obj);
        }
        s.set(`k_${i}`, { i, tag: `v${i}` });
      },
      { name: `S${i}` },
    );
  }
  return run.snapshot();
}

describe('the resumable fold', () => {
  it('stepping forward equals a fresh fold at every stop — state, basis, throughCommitIdx', () => {
    const snapshot = runFixture();
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

  it('an earlier stop after a later one folds from scratch — same answer as fresh', () => {
    const snapshot = runFixture();
    const tt = timeTravel(snapshot);
    const stops = tt.stops;
    tt.stateAt(stops[stops.length - 1]!);
    const back = tt.stateAt(stops[3]!);
    expect(back.state).toEqual(timeTravel(snapshot).stateAt(stops[3]!).state);
    // and forward again from there
    const fwd = tt.stateAt(stops[9]!);
    expect(fwd.state).toEqual(timeTravel(snapshot).stateAt(stops[9]!).state);
  });

  it('a fold never touches the log: byte-identical before and after, and the state handed out is frozen', () => {
    const snapshot = runFixture();
    const before = JSON.stringify(snapshot.commitLog);
    const tt = timeTravel(snapshot);
    for (const stop of tt.stops) tt.stateAt(stop);
    tt.stateAt(tt.stops[2]!);
    expect(JSON.stringify(snapshot.commitLog)).toBe(before);
    const last = tt.stateAt(tt.stops[tt.stops.length - 1]!);
    expect(Object.isFrozen(last.state)).toBe(true);
    expect(Object.isFrozen((last.state as State).obj)).toBe(true);
  });

  it('the standalone stateAt(source, commitIdx) still answers as the cursor does', () => {
    const snapshot = runFixture();
    const tt = timeTravel(snapshot);
    const stop = tt.stops[7]!;
    expect(stateAt(snapshot, stop.lastCommitIdx).state).toEqual(tt.stateAt(stop).state);
  });
});
