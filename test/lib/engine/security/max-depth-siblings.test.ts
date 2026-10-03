/**
 * The depth cap counts NESTING, never parallel siblings.
 *
 * Before the fix the cap was one counter per traverser, bumped by every
 * in-flight `executeNode` call, so a fork or selector with 500+ children
 * ran 499 and turned the rest into result entries reading "maximum
 * traversal depth exceeded" — `onError` silent, `run()` RESOLVED. Two laws:
 *
 *   1. Depth is a property of the call PATH: siblings share their parent's
 *      depth + 1, so a 520-child fork runs every child.
 *   2. If the cap IS reached, the run fails loudly: `onError` fires and
 *      `run()` rejects with the error naming the cap — never a resolved run
 *      with dropped work, whatever the fork's error mode.
 */

import type { FlowErrorEvent } from '../../../../src/index';
import { flowChart, FlowChartExecutor } from '../../../../src/index';

const WIDE = 520;

function wideFork(ran: Set<string>, failFast = false) {
  const children = Array.from({ length: WIDE }, (_, i) => ({
    id: `c${i}`,
    name: `C${i}`,
    fn: async () => {
      ran.add(`c${i}`);
    },
  }));
  return flowChart<any>('Seed', async () => {}, 'seed')
    .addListOfFunction(children, { failFast })
    .addFunction('After', async () => {}, 'after')
    .build();
}

function wideSelector(ran: Set<string>) {
  let b = flowChart<any>('Seed', async () => {}, 'seed').addSelectorFunction(
    'Pick',
    async () => Array.from({ length: WIDE }, (_, i) => `s${i}`),
    'pick',
  );
  for (let i = 0; i < WIDE; i++) {
    b = b.addFunctionBranch(`s${i}`, `S${i}`, async () => {
      ran.add(`s${i}`);
    }) as typeof b;
  }
  return b.end().build();
}

function withErrors(ex: FlowChartExecutor): FlowErrorEvent[] {
  const errors: FlowErrorEvent[] = [];
  ex.attachFlowRecorder({ id: 'errors', onError: (e) => errors.push(e) });
  return errors;
}

describe('depth cap — siblings do not consume depth', () => {
  it('a 520-child fork runs every child at the default maxDepth', async () => {
    const ran = new Set<string>();
    const ex = new FlowChartExecutor(wideFork(ran));
    const errors = withErrors(ex);
    await ex.run();
    expect(ran.size).toBe(WIDE);
    expect(errors).toHaveLength(0);
  });

  it('a 520-child failFast fork runs every child', async () => {
    const ran = new Set<string>();
    await new FlowChartExecutor(wideFork(ran, true)).run();
    expect(ran.size).toBe(WIDE);
  });

  it('a selector that picks 520 branches runs every branch', async () => {
    const ran = new Set<string>();
    await new FlowChartExecutor(wideSelector(ran)).run();
    expect(ran.size).toBe(WIDE);
  });

  it('a fork admits as many children as it has at maxDepth = 2 (one nesting level)', async () => {
    const ran = new Set<string>();
    await new FlowChartExecutor(wideFork(ran)).run({ maxDepth: 2 });
    expect(ran.size).toBe(WIDE);
  });
});

describe('depth cap — a reached cap fails the run loudly', () => {
  it('fork children past the cap: onError fires and run() rejects naming the cap', async () => {
    const ran = new Set<string>();
    const ex = new FlowChartExecutor(wideFork(ran));
    const errors = withErrors(ex);
    await expect(ex.run({ maxDepth: 1 })).rejects.toThrow(/maximum traversal depth exceeded \(1\)/);
    expect(ran.size).toBe(0);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toMatch(/maximum traversal depth exceeded \(1\)/);
    expect(errors[0].structuredError.name).toBe('TraversalDepthError');
  });

  it('the same under failFast', async () => {
    const ran = new Set<string>();
    const ex = new FlowChartExecutor(wideFork(ran, true));
    const errors = withErrors(ex);
    await expect(ex.run({ maxDepth: 1 })).rejects.toThrow(/maximum traversal depth exceeded \(1\)/);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('a selector fan-out past the cap rejects too', async () => {
    const ran = new Set<string>();
    const ex = new FlowChartExecutor(wideSelector(ran));
    const errors = withErrors(ex);
    await expect(ex.run({ maxDepth: 1 })).rejects.toThrow(/maximum traversal depth exceeded/);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('an ordinary child error is still contained in the result bundle (unchanged)', async () => {
    const chart = flowChart<any>('Seed', async () => {}, 'seed')
      .addListOfFunction([
        { id: 'ok', name: 'Ok', fn: async () => {} },
        {
          id: 'bad',
          name: 'Bad',
          fn: async () => {
            throw new Error('boom');
          },
        },
      ])
      .build();
    await expect(new FlowChartExecutor(chart).run()).resolves.toBeDefined();
  });
});
