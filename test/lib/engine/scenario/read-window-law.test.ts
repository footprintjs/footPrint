/**
 * The read-window law's own checks (`read-window-law.ts`): the byte pins that take the stamps out must be
 * able to go red, so each refusal is tried on a hand-made log, and a real fork run is taken out exactly.
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { takeReadWindows, withoutReadWindowsText } from './read-window-law.js';

const bundle = (runtimeStageId: string, idx: number, extra: Record<string, unknown> = {}) => ({
  overwrite: {},
  updates: {},
  trace: [],
  runtimeStageId,
  ...extra,
  idx,
});

describe('read-window law — takeReadWindows', () => {
  it('takes a valid stamp out, in place, and returns it', () => {
    const log = [bundle('seed#0', 0), bundle('a#1', 1), bundle('b#2', 2, { beganAt: 1, sawUntil: 2 })];
    expect(takeReadWindows(log)).toEqual([{ runtimeStageId: 'b#2', beganAt: 1, sawUntil: 2 }]);
    expect(log[2]).toEqual(bundle('b#2', 2));
  });

  it('refuses a stamp where no other step committed inside the window (the step ran alone)', () => {
    const own = [bundle('a#0', 0), bundle('b#1', 1), bundle('b#1', 2, { beganAt: 1 })];
    expect(() => takeReadWindows(own)).toThrow(/no other step committed inside \[1, 2\)/);
    expect(() => takeReadWindows([bundle('a#0', 0), bundle('b#1', 1, { beganAt: 1 })])).toThrow(/before idx 1/);
  });

  it('refuses a stamp on a continuation bundle, bad numbers, and a stamp outside a log', () => {
    expect(() => takeReadWindows([bundle('a#0', 0), bundle('b#1', 1, { phase: 'repeat', beganAt: 0 })])).toThrow(
      /'repeat' bundle/,
    );
    expect(() => takeReadWindows([bundle('a#0', 0), bundle('b#1', 1, { beganAt: 0.5 })])).toThrow(/whole number/);
    expect(() => takeReadWindows([bundle('a#0', 0), bundle('b#1', 1, { beganAt: 0, sawUntil: 0 })])).toThrow(
      /sawUntil 0/,
    );
    expect(() => takeReadWindows({ only: bundle('b#1', 1, { beganAt: 0 }) })).toThrow(/outside a log/);
  });
});

describe('read-window law — on a real fork', () => {
  const run = async () => {
    const chart = flowChart<any>('Seed', (s) => s.$setValue('n', 1), 'seed')
      .addListOfFunction([
        { id: 'a', name: 'A', fn: (s: any) => s.$setValue('x', 1) },
        {
          id: 'b',
          name: 'B',
          fn: async (s: any) => {
            const n = s.$getValue('n');
            await new Promise((resolve) => setTimeout(resolve, 0));
            s.$setValue('y', n);
          },
        },
      ])
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    return JSON.stringify(executor.getSnapshot().commitLog, null, 2);
  };

  it('a sibling that read before the other committed carries beganAt; the text loses exactly that line', async () => {
    const text = await run();
    const taken = takeReadWindows(JSON.parse(text));
    expect(taken).toHaveLength(1);
    expect(taken[0]!.runtimeStageId).toMatch(/^b#/);
    const without = withoutReadWindowsText(text, taken);
    const removed = text.split('\n').filter((line) => !without.split('\n').includes(line));
    expect(removed).toEqual([`    "beganAt": ${taken[0]!.beganAt},`]);
    expect(() => withoutReadWindowsText(text, [])).toThrow(/the record carries/);
  });
});
