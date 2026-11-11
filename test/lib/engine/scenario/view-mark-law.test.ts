/**
 * The view-mark law's own checks (`view-mark-law.ts`): the byte pins that take the mark out must be able
 * to go red, so each refusal is tried on a hand-made log, and two real commits are taken out exactly.
 */
import { EventLog, SharedMemory } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import { StageContext } from '../../../../src/advanced.js';
import { runPolicy } from '../../../../src/lib/memory/runPolicy';
import { takeViewMarks, withoutViewMarks } from './view-mark-law.js';

const row = (path: string, verb: string, extra: Record<string, unknown> = {}) => ({ path, verb, ...extra });
const bundle = (runtimeStageId: string, idx: number, trace: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  overwrite: {},
  updates: {},
  trace,
  runtimeStageId,
  ...extra,
  idx,
});
const marked = (path: string) => row(path, 'set', { builtOnView: true });

describe('view-mark law — takeViewMarks', () => {
  it('takes a mark and its stamp out, in place, and returns them; a bundle with neither is left alone', () => {
    const log = [
      bundle('seed#0', 0, [row('a', 'set')]),
      bundle('other#1', 1, [row('a', 'set')]),
      bundle('fill#2', 2, [row('a\u001fin', 'set'), marked('a')], { viewAt: 1 }),
    ];
    expect(takeViewMarks(log)).toEqual([{ runtimeStageId: 'fill#2', idx: 2, paths: ['a'], viewAt: 1 }]);
    expect(log[2]).toEqual(bundle('fill#2', 2, [row('a\u001fin', 'set'), row('a', 'set')]));
    expect(takeViewMarks(log)).toEqual([]);
  });

  it('a mark with no stamp is the common case: the view was the state just before the commit', () => {
    const log = [bundle('seed#0', 0, [row('a', 'set')]), bundle('fill#1', 1, [marked('a'), marked('b')])];
    expect(takeViewMarks(log)).toEqual([{ runtimeStageId: 'fill#1', idx: 1, paths: ['a', 'b'] }]);
  });

  it('refuses a marked bundle that does not say its place in a log', () => {
    const noPlace = { overwrite: {}, updates: {}, trace: [marked('a')], runtimeStageId: 'fill#0' };
    expect(() => takeViewMarks([noPlace])).toThrow(/a bundle whose idx is not its place in a log/);
  });

  it('refuses a mark that is not true, and a mark on a row that is not a set', () => {
    expect(() => takeViewMarks([bundle('fill#0', 0, [row('a', 'set', { builtOnView: 'yes' })])])).toThrow(
      /a mark that is not true on a/,
    );
    expect(() => takeViewMarks([bundle('fill#0', 0, [row('a', 'merge', { builtOnView: true })])])).toThrow(
      /the mark on a 'merge' row \(a\), not a set/,
    );
  });

  it('refuses a stamp with no marked row, bad numbers, and a stamp that no commit followed', () => {
    const seed = bundle('seed#0', 0, [row('a', 'set')]);
    expect(() => takeViewMarks([seed, bundle('fill#1', 1, [row('a', 'set')], { viewAt: 0 })])).toThrow(
      /viewAt on a bundle with no row built on the view/,
    );
    expect(() => takeViewMarks([seed, bundle('fill#1', 1, [marked('a')], { viewAt: 1 })])).toThrow(
      /viewAt 1 is not a whole number before idx 1/,
    );
    expect(() => takeViewMarks([seed, bundle('fill#1', 1, [marked('a')], { viewAt: 0.5 })])).toThrow(/whole number/);
    // A log with no commit inside [3, 5) refuses the stamp.
    const gap = [bundle('seed#0', 0, [row('a', 'set')]), bundle('fill#5', 5, [marked('a')], { viewAt: 3 })];
    expect(() => takeViewMarks(gap)).toThrow(/no other step committed inside \[3, 5\)/);
    // And so does a window that holds only the step's own earlier commit: a frame pins its view anew for
    // each commit it makes, so its own commit is never one that landed since the pin.
    const own = [bundle('fill#0', 0, [row('a', 'set')]), bundle('fill#0', 1, [marked('a')], { viewAt: 0 })];
    expect(() => takeViewMarks(own)).toThrow(/no other step committed inside \[0, 1\)/);
  });

  it('refuses a marked bundle outside a log, and leaves the original alone when asked for a copy', () => {
    expect(() => takeViewMarks({ only: bundle('fill#1', 1, [marked('a')]) })).toThrow(/outside a log/);
    const log = [bundle('fill#0', 0, [marked('a')])];
    const into: ReturnType<typeof takeViewMarks> = [];
    const copy = withoutViewMarks(log, into);
    expect(into).toEqual([{ runtimeStageId: 'fill#0', idx: 0, paths: ['a'] }]);
    expect(copy[0].trace).toEqual([row('a', 'set')]);
    expect(log[0].trace).toEqual([marked('a')]);
  });
});

describe('view-mark law — on the real writer', () => {
  /** One step on the engine's own stage context, under `commitValues: 'delta'`. */
  const world = () => {
    const state = new SharedMemory(undefined, {});
    const log = new EventLog(state.getState());
    let executed = 0;
    const step = (name: string) => {
      const ctx = new StageContext('', name, name, state, '', log);
      ctx.usePolicy(runPolicy({ commitValues: 'delta' }));
      // Named as the traverser names a step before it runs: the law tells steps apart by this name.
      ctx.runtimeStageId = `${name}#${executed++}`;
      return ctx;
    };
    return { log, step };
  };

  it('a step that merged into a key and wrote a path inside it: one marked set, and the record loses exactly that field', () => {
    const { log, step } = world();
    const start = step('start');
    start.setObject([], 'box', { s: 1 });
    start.commit();
    const fill = step('fill');
    fill.updateObject([], 'box', { m: 1 });
    fill.setObject(['box'], 'in', 1);
    fill.commit();
    const text = JSON.stringify(log.list());
    const parsed = JSON.parse(text);
    expect(parsed[1].trace.map((entry: any) => [entry.verb, entry.path, entry.builtOnView])).toEqual([
      ['set', 'box\u001fin', undefined],
      ['set', 'box', true],
    ]);
    const taken = takeViewMarks(parsed);
    expect(taken).toEqual([{ runtimeStageId: 'fill#1', idx: 1, paths: ['box'] }]);
    // Nothing else moved: the same record with that one field deleted by hand.
    const byHand = JSON.parse(text);
    delete byHand[1].trace[1].builtOnView;
    expect(parsed).toEqual(byHand);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(byHand));
  });

  it('a step whose view was pinned before a sibling committed carries viewAt as well', () => {
    const { log, step } = world();
    const start = step('start');
    start.setObject([], 'box', { s: 1 });
    start.commit();
    const fill = step('fill');
    fill.updateObject([], 'box', { m: 1 }); // pins fill's view: the log holds 1 commit
    const other = step('other');
    other.setObject([], 'side', 1);
    other.commit();
    fill.setObject(['box'], 'in', 1);
    fill.commit();
    const parsed = JSON.parse(JSON.stringify(log.list()));
    expect(takeViewMarks(parsed)).toEqual([{ runtimeStageId: 'fill#1', idx: 2, paths: ['box'], viewAt: 1 }]);
    expect(parsed[2].viewAt).toBeUndefined();
  });
});
