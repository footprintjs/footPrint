/**********************************************************************
 ExecutionHistory – unit test coverage
 -------------------------------------------------------------------
 • Ensures materialise() reproduces the exact state after N stages
 • Confirms list()
 • Verifies clear() wipes history between runs (important for tests)
 *********************************************************************/
import { CommitBundle, ExecutionHistory, TraceItem } from '../../../../src/internal/history/ExecutionHistory';
import { applySmartMerge, MemoryPatch } from '../../../../src/internal/memory/WriteBuffer';
/* ------------------------------------------------------------------ *
Helpers
------------------------------------------------------------------ */
function makeBundle(
  stage: string,
  trace: TraceItem[],
  overwrite: MemoryPatch,
  updates: MemoryPatch,
  redactedPaths: string[] = [],
): CommitBundle {
  return { stage, trace, overwrite, updates, redactedPaths };
}
const DELIM = '\u001F'; // delimiter used in path normaliser
/* Base snapshot for all tests */
const base = {
  cfg: { num: 1, tags: ['a'] },
};
/* Stage 0 patch – merge tags */
const b0Updates = { cfg: { tags: ['b'] } };
const b0Overwrite = {};
const b0Trace: TraceItem[] = [{ path: `cfg${DELIM}tags`, verb: 'merge' }];
/* Stage 1 patch – set num */
const b1Updates = {};
const b1Overwrite = { cfg: { num: 2 } };
const b1Trace: TraceItem[] = [{ path: `cfg${DELIM}num`, verb: 'set' }];
/* Expected materialised snapshots */
const snap0 = applySmartMerge(structuredClone(base), b0Updates, b0Overwrite, b0Trace);
const snap1 = applySmartMerge(snap0, b1Updates, b1Overwrite, b1Trace);

describe('ExecutionHistory', () => {
  it('materialise(n) reproduces exact state after n commits', () => {
    const hist = new ExecutionHistory(base);
    hist.record(makeBundle('Stage‑0', b0Trace, b0Overwrite, b0Updates));
    expect(hist.materialise()).toEqual(snap0); // latest (idx 0)
    expect(hist.materialise(1)).toEqual(snap0); // explicit idx
    hist.record(makeBundle('Stage‑1', b1Trace, b1Overwrite, b1Updates));
    expect(hist.materialise()).toEqual(snap1); // latest (idx 1)
    expect(hist.materialise(2)).toEqual(snap1); // explicit idx 2
  });
  it('list() returns  timeline', () => {
    const hist = new ExecutionHistory(base);
    hist.record(makeBundle('Stage‑0', b0Trace, b0Overwrite, b0Updates));
    hist.record(makeBundle('Stage‑1', b1Trace, b1Overwrite, b1Updates));
    const timeline = hist.list();
    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toEqual({
      idx: 0,
      stage: 'Stage‑0',
      trace: b0Trace,
      overwrite: b0Overwrite,
      updates: b0Updates,
      redactedPaths: [],
    });
  });
  it('clear() wipes history for a fresh run', () => {
    const hist = new ExecutionHistory(base);
    hist.record(makeBundle('Stage‑0', b0Trace, b0Overwrite, b0Updates));
    expect(hist.list().length).toBe(1);
    hist.clear();
    expect(hist.list().length).toBe(0);
    expect(hist.materialise()).toEqual(base); // back to initial snapshot
  });
});
