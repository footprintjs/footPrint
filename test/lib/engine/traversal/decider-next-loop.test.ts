/**
 * A loop is a flat hop with zero stack — also when the decider it passes
 * through has a `next` of its own, and when the loop edge is a selector's.
 *
 * Before the fix a decider WITH a `next` ran its branch in a nested driver;
 * a branch that looped back through the decider nested one level per pass
 * (500 passes hit the depth cap) and the `next` ran once per pass on the way
 * out. A selector whose own continuation was a `loopTo` hopped into the bare
 * loop-ref stub: one extra run, no `onLoop`, then the run ended.
 *
 * The law: the loop re-enters its target at the level the target lives on
 * (the nested branch frame is LEFT, not stacked), and the decider's `next`
 * runs once — after the decision that does not loop.
 */

import type { FlowLoopEvent } from '../../../../src/index';
import { flowChart, FlowChartExecutor } from '../../../../src/index';

function deciderWithNextLoop(target: number, counts: { tick: number; after: number }, loopTarget = 'decide') {
  return flowChart<any>(
    'Seed',
    async (scope) => {
      scope.$setValue('i', 0);
    },
    'seed',
  )
    .addDeciderFunction(
      'Decide',
      async (scope) => ((scope.$getValue('i') as number) < target ? 'continue' : 'done'),
      'decide',
    )
    .addFunctionBranch(
      'continue',
      'Tick',
      async (scope: any) => {
        counts.tick++;
        scope.$setValue('i', (scope.$getValue('i') as number) + 1);
      },
      undefined,
      { loopTo: loopTarget },
    )
    .addFunctionBranch('done', 'Final', async (scope: any) => {
      scope.$setValue('final', true);
    })
    .end()
    .addFunction(
      'After',
      async () => {
        counts.after++;
      },
      'after',
    )
    .build();
}

describe('decider with its own next — the loop through it is flat', () => {
  it('1,000 passes complete at the default maxDepth and the next runs ONCE', async () => {
    const counts = { tick: 0, after: 0 };
    const ex = new FlowChartExecutor(deciderWithNextLoop(1_000, counts));
    await ex.run({ maxIterations: 1_001 });
    expect(counts.tick).toBe(1_000);
    expect(counts.after).toBe(1);
    expect((ex.getSnapshot().sharedState as any).final).toBe(true);
  }, 60_000);

  it('maxDepth = 2 is enough for any number of passes (one nesting level)', async () => {
    const counts = { tick: 0, after: 0 };
    await new FlowChartExecutor(deciderWithNextLoop(50, counts)).run({ maxDepth: 2 });
    expect(counts).toEqual({ tick: 50, after: 1 });
  });

  it('a 5-pass loop narrates the same stage order as the flat shape, then After once', async () => {
    const counts = { tick: 0, after: 0 };
    const ex = new FlowChartExecutor(deciderWithNextLoop(5, counts));
    const order: string[] = [];
    const loops: FlowLoopEvent[] = [];
    ex.attachFlowRecorder({
      id: 'order',
      onStageExecuted: (e) => order.push(e.stageName),
      onLoop: (e) => loops.push(e),
    });
    await ex.run();
    expect(order).toEqual([
      'Seed',
      ...Array.from({ length: 5 }, () => ['Decide', 'Tick']).flat(),
      'Decide',
      'Final',
      'After',
    ]);
    expect(loops.map((l) => l.iteration)).toEqual([1, 2, 3, 4, 5]);
  });

  it('a loop to a stage UPSTREAM of the decider also stays flat and runs the next once', async () => {
    const counts = { tick: 0, after: 0 };
    const ex = new FlowChartExecutor(
      flowChart<any>(
        'Seed',
        async (scope) => {
          if (scope.$getValue('i') === undefined) scope.$setValue('i', 0);
        },
        'seed',
      )
        .addDeciderFunction(
          'Decide',
          async (scope) => ((scope.$getValue('i') as number) < 600 ? 'continue' : 'done'),
          'decide',
        )
        .addFunctionBranch(
          'continue',
          'Tick',
          async (scope: any) => {
            counts.tick++;
            scope.$setValue('i', (scope.$getValue('i') as number) + 1);
          },
          undefined,
          { loopTo: 'seed' },
        )
        .addFunctionBranch('done', 'Final', async () => {})
        .end()
        .addFunction(
          'After',
          async () => {
            counts.after++;
          },
          'after',
        )
        .build(),
    );
    await ex.run();
    expect(counts).toEqual({ tick: 600, after: 1 });
  });

  it('a loop that stays INSIDE the branch keeps running in the branch, then the next once', async () => {
    let inner = 0;
    let after = 0;
    const branch = flowChart<any>(
      'Inner',
      async (scope) => {
        inner++;
        scope.$setValue('j', ((scope.$getValue('j') as number) ?? 0) + 1);
      },
      'inner',
    )
      .addDeciderFunction('Again', async (scope) => ((scope.$getValue('j') as number) < 3 ? 'more' : 'stop'), 'again')
      .addFunctionBranch('more', 'More', async () => {}, undefined, { loopTo: 'inner' })
      .addFunctionBranch('stop', 'Stop', async () => {})
      .end()
      .build();
    const chart = flowChart<any>('Seed', async () => {}, 'seed')
      .addDeciderFunction('Decide', async () => 'go', 'decide')
      .addSubFlowChartBranch('go', branch, 'Go')
      .end()
      .addFunction(
        'After',
        async () => {
          after++;
        },
        'after',
      )
      .build();
    await new FlowChartExecutor(chart).run();
    expect(inner).toBe(3);
    expect(after).toBe(1);
  });
});

describe("a selector's own loopTo loops", () => {
  it('fires onLoop each pass and re-enters its target until a stage breaks the loop', async () => {
    // Selector children write under their own `runs/<id>` namespace, so the
    // pass count is kept in the closure the stages share.
    let picks = 0;
    let work = 0;
    const chart = flowChart<any>(
      'Seed',
      async (scope) => {
        if (work >= 3) scope.$break('done');
      },
      'seed',
    )
      .addSelectorFunction(
        'Pick',
        async () => {
          picks++;
          return ['work'];
        },
        'pick',
      )
      .addFunctionBranch('work', 'Work', async () => {
        work++;
      })
      .end()
      .loopTo('seed')
      .build();
    const ex = new FlowChartExecutor(chart);
    const loops: FlowLoopEvent[] = [];
    ex.attachFlowRecorder({ id: 'loops', onLoop: (e) => loops.push(e) });
    await ex.run();
    expect(work).toBe(3);
    expect(picks).toBe(3);
    expect(loops.map((l) => l.iteration)).toEqual([1, 2, 3]);
    expect(loops.every((l) => l.target === 'Seed')).toBe(true);
  });

  it('is bounded by maxIterations like any loop', async () => {
    const chart = flowChart<any>('Seed', async () => {}, 'seed')
      .addSelectorFunction('Pick', async () => ['work'], 'pick')
      .addFunctionBranch('work', 'Work', async () => {})
      .end()
      .loopTo('seed')
      .build();
    await expect(new FlowChartExecutor(chart).run({ maxIterations: 20 })).rejects.toThrow(/20/);
  });
});

describe('decider with its own next — a pause inside the loop resumes flat', () => {
  it('pausing at pass 3 of 6 and resuming runs the remaining passes and the next once', async () => {
    let after = 0;
    let pauses = 0;
    const chart = flowChart<any>(
      'Seed',
      async (scope) => {
        scope.$setValue('i', 0);
      },
      'seed',
    )
      .addDeciderFunction(
        'Decide',
        async (scope) => ((scope.$getValue('i') as number) < 6 ? 'continue' : 'done'),
        'decide',
      )
      .addPausableFunctionBranch(
        'continue',
        'Tick',
        {
          execute: async (scope: any) => {
            const i = scope.$getValue('i') as number;
            if (i === 3 && pauses === 0) {
              pauses++;
              return { ask: 'go on?' };
            }
            scope.$setValue('i', i + 1);
            return undefined;
          },
          resume: async (scope: any) => {
            scope.$setValue('i', (scope.$getValue('i') as number) + 1);
          },
        },
        undefined,
        { loopTo: 'decide' },
      )
      .addFunctionBranch('done', 'Final', async (scope: any) => {
        scope.$setValue('final', true);
      })
      .end()
      .addFunction(
        'After',
        async () => {
          after++;
        },
        'after',
      )
      .build();
    const ex = new FlowChartExecutor(chart);
    await ex.run({ maxDepth: 2 });
    expect(ex.isPaused()).toBe(true);
    expect(after).toBe(0);
    const checkpoint = ex.getCheckpoint()!;
    const resumed = new FlowChartExecutor(chart);
    await resumed.resume(checkpoint, {}, { maxDepth: 2 });
    expect(after).toBe(1);
    const state = resumed.getSnapshot().sharedState as any;
    expect(state.i).toBe(6);
    expect(state.final).toBe(true);
  });
});

describe('decider with its own next — a jump by id from a branch', () => {
  async function jumpTo(target: string) {
    const chart = flowChart<any>('Seed', async () => {}, 'seed')
      .addDeciderFunction('D', async () => 'x', 'd')
      .addFunctionBranch('x', 'X1', async () => ({ name: 'jump', next: target } as any))
      .addFunctionBranch('y', 'Y', async () => {})
      .end()
      .addFunction('After', async () => {}, 'after')
      .addFunction('Later', async () => {}, 'later')
      .build();
    const ex = new FlowChartExecutor(chart);
    const seen: string[] = [];
    ex.attachFlowRecorder({ id: 'order', onStageExecuted: (e) => seen.push(e.stageName) });
    await ex.run();
    return seen;
  }

  it('sideways to a sibling branch: stays in the branch, then the decider next (as 9.39.0)', async () => {
    expect(await jumpTo('y')).toEqual(['Seed', 'D', 'X1', 'Y', 'After', 'Later']);
  });

  it("forward to the decider's own next: the tail runs ONCE (9.40.0 ran after,later twice)", async () => {
    expect(await jumpTo('after')).toEqual(['Seed', 'D', 'X1', 'After', 'Later']);
  });

  it('forward to a node further down the tail: the jump skips the rest, the tail runs once', async () => {
    expect(await jumpTo('later')).toEqual(['Seed', 'D', 'X1', 'Later']);
  });
});
