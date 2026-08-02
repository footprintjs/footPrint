/**
 * `addParallelForEach` at run time — the fan-out laws.
 *
 * Design: docs/design/execution-control.md — Round B tests 4 (second half) and
 * 6, plus the re-registration law the coordinator asked for its own tripwire.
 *
 * Test types: Unit (zero items, single branch) · Functional (ordering,
 * truncation, failure policy, loop re-entry) · Integration (branch stages land
 * in the real commit log under the generated segment) · Security (branch
 * isolation — one branch cannot see or corrupt another's memory) ·
 * Regression (the re-registration tripwire).
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';

interface ParentState {
  chunks?: string[];
  reviews?: unknown[];
  merged?: string;
  [key: string]: unknown;
}

interface BranchState {
  item?: string;
  index?: number;
  score?: string;
  [key: string]: unknown;
}

/** Run a chart and hand back its final shared state. */
async function runChart(chart: Parameters<typeof FlowChartExecutor.prototype.run> extends never ? never : any) {
  const executor = new FlowChartExecutor(chart);
  await executor.run();
  return executor.getSnapshot().sharedState as Record<string, unknown>;
}

/** A branch chart that reports the item it was given, after an optional delay. */
function scoreChart(label: string, delayMs = 0) {
  return flowChart<BranchState>(
    'Score',
    async (scope) => {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      scope.score = `scored:${label}`;
    },
    'score',
  ).build();
}

describe('addParallelForEach — ordered results', () => {
  it('writes ONE ordered array on the parent, in items order', async () => {
    const chart = flowChart<ParentState>(
      'Split',
      (scope) => {
        scope.chunks = ['a', 'b', 'c'];
      },
      'split',
    )
      .addParallelForEach('Review each chunk', 'review-chunks', {
        items: (scope) => scope.chunks ?? [],
        branch: (chunk: string) => scoreChart(chunk),
        maxBranches: 8,
        into: 'reviews',
      })
      .build();

    const reviews = (await runChart(chart)).reviews as BranchState[];

    expect(reviews).toHaveLength(3);
    expect(reviews.map((r) => r.score)).toEqual(['scored:a', 'scored:b', 'scored:c']);
  });

  it('ORDER IS ITEMS ORDER, not completion order (the D2 law)', async () => {
    const completionOrder: string[] = [];
    // Reverse the delays: 'c' finishes first, 'a' last.
    const delays: Record<string, number> = { a: 30, b: 15, c: 1 };

    const chart = flowChart<ParentState>(
      'Split',
      (scope) => {
        scope.chunks = ['a', 'b', 'c'];
      },
      'split',
    )
      .addParallelForEach('Review each chunk', 'review-chunks', {
        items: (scope) => scope.chunks ?? [],
        branch: (chunk: string) =>
          flowChart<BranchState>(
            'Score',
            async (scope) => {
              await new Promise((resolve) => setTimeout(resolve, delays[chunk]));
              completionOrder.push(chunk);
              scope.score = `scored:${chunk}`;
            },
            'score',
          ).build(),
        maxBranches: 8,
        into: 'reviews',
      })
      .build();

    const reviews = (await runChart(chart)).reviews as BranchState[];

    // Completion really did happen out of order …
    expect(completionOrder).toEqual(['c', 'b', 'a']);
    // … and the results are STILL in items order.
    expect(reviews.map((r) => r.score)).toEqual(['scored:a', 'scored:b', 'scored:c']);
  });

  it('zero items → an empty array, no fan-out', async () => {
    const chart = flowChart<ParentState>(
      'Split',
      (scope) => {
        scope.chunks = [];
      },
      'split',
    )
      .addParallelForEach('Review', 'review-chunks', {
        items: (scope) => scope.chunks ?? [],
        branch: () => scoreChart('never'),
        maxBranches: 4,
        into: 'reviews',
      })
      .build();

    expect((await runChart(chart)).reviews).toEqual([]);
  });

  it('a later stage reads the results array from scope', async () => {
    const chart = flowChart<ParentState>(
      'Split',
      (scope) => {
        scope.chunks = ['x', 'y'];
      },
      'split',
    )
      .addParallelForEach('Review', 'review-chunks', {
        items: (scope) => scope.chunks ?? [],
        branch: (chunk: string) => scoreChart(chunk),
        maxBranches: 4,
        into: 'reviews',
      })
      .addFunction(
        'Merge',
        (scope) => {
          scope.merged = (scope.reviews as BranchState[]).map((r) => r.score).join('|');
        },
        'merge',
      )
      .build();

    expect((await runChart(chart)).merged).toBe('scored:x|scored:y');
  });

  it('items() reading throws a NAMED error when it does not return an array', async () => {
    const chart = flowChart<ParentState>('Split', () => undefined, 'split')
      .addParallelForEach('Review', 'review-chunks', {
        items: () => 'not-an-array' as never,
        branch: () => scoreChart('never'),
        maxBranches: 4,
        into: 'reviews',
      })
      .build();

    await expect(new FlowChartExecutor(chart).run()).rejects.toThrow(
      /parallelForEach 'review-chunks': items\(\) must return an array/,
    );
  });
});

describe('addParallelForEach — maxBranches is a ceiling, and the truncation is stated', () => {
  it('runs the first maxBranches items and no more', async () => {
    const ran: number[] = [];
    const chart = flowChart<ParentState>(
      'Split',
      (scope) => {
        scope.chunks = ['a', 'b', 'c', 'd', 'e'];
      },
      'split',
    )
      .addParallelForEach('Review', 'review-chunks', {
        items: (scope) => scope.chunks ?? [],
        branch: (chunk: string, index: number) => {
          ran.push(index);
          return scoreChart(chunk);
        },
        maxBranches: 2,
        into: 'reviews',
      })
      .build();

    const state = await runChart(chart);
    expect(ran).toEqual([0, 1]);
    expect(state.reviews).toHaveLength(2);
  });

  it('STATES the truncation in the stage log — bounded execution is never silent', async () => {
    const chart = flowChart<ParentState>(
      'Split',
      (scope) => {
        scope.chunks = ['a', 'b', 'c', 'd', 'e'];
      },
      'split',
    )
      .addParallelForEach('Review', 'review-chunks', {
        items: (scope) => scope.chunks ?? [],
        branch: (chunk: string) => scoreChart(chunk),
        maxBranches: 2,
        into: 'reviews',
      })
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const tree = JSON.stringify(executor.getSnapshot().executionTree);

    expect(tree).toContain('parallelForEach');
    expect(tree).toContain('"truncated":true');
    expect(tree).toContain('maxBranches reached: running 2 of 5 items (3 not run)');
  });

  it('records truncated:false when everything fit', async () => {
    const chart = flowChart<ParentState>(
      'Split',
      (scope) => {
        scope.chunks = ['a'];
      },
      'split',
    )
      .addParallelForEach('Review', 'review-chunks', {
        items: (scope) => scope.chunks ?? [],
        branch: (chunk: string) => scoreChart(chunk),
        maxBranches: 4,
        into: 'reviews',
      })
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(JSON.stringify(executor.getSnapshot().executionTree)).toContain('"truncated":false');
  });
});

describe('addParallelForEach — failure policy is the existing parallel policy', () => {
  const failingBranch = (chunk: string) =>
    flowChart<BranchState>(
      'Score',
      () => {
        if (chunk === 'b') throw new Error('branch b failed');
      },
      'score',
    ).build();

  it('best-effort (default): every branch runs, the failed slot is undefined, order holds', async () => {
    const chart = flowChart<ParentState>(
      'Split',
      (scope) => {
        scope.chunks = ['a', 'b', 'c'];
      },
      'split',
    )
      .addParallelForEach('Review', 'review-chunks', {
        items: (scope) => scope.chunks ?? [],
        branch: failingBranch,
        maxBranches: 8,
        into: 'reviews',
      })
      .build();

    const reviews = (await runChart(chart)).reviews as unknown[];

    expect(reviews).toHaveLength(3);
    expect(reviews[1]).toBeUndefined(); // slot preserved — order is items order
    expect(reviews[0]).toBeDefined();
    expect(reviews[2]).toBeDefined();
  });

  it('failFast: the first failing branch rejects the whole stage', async () => {
    const chart = flowChart<ParentState>(
      'Split',
      (scope) => {
        scope.chunks = ['a', 'b', 'c'];
      },
      'split',
    )
      .addParallelForEach('Review', 'review-chunks', {
        items: (scope) => scope.chunks ?? [],
        branch: failingBranch,
        maxBranches: 8,
        into: 'reviews',
        failFast: true,
      })
      .build();

    await expect(new FlowChartExecutor(chart).run()).rejects.toThrow('branch b failed');
  });
});

describe('addParallelForEach — branch isolation', () => {
  it('each branch gets its own memory: a branch cannot read another branch or the parent', async () => {
    const seen: Array<Record<string, unknown>> = [];

    const chart = flowChart<ParentState>(
      'Split',
      (scope) => {
        scope.chunks = ['a', 'b'];
        scope.secret = 'parent-only';
      },
      'split',
    )
      .addParallelForEach('Review', 'review-chunks', {
        items: (scope) => scope.chunks ?? [],
        branch: (chunk: string, index: number) =>
          flowChart<BranchState>(
            'Score',
            (scope) => {
              // Snapshot everything this branch can see.
              seen.push({ ...(scope as unknown as Record<string, unknown>) });
              scope[`only-${index}`] = chunk;
              scope.score = `scored:${chunk}`;
            },
            'score',
          ).build(),
        maxBranches: 4,
        into: 'reviews',
      })
      .build();

    const state = await runChart(chart);

    // Seeded with item + index (D1's inputMapper seam) — and NOTHING else.
    for (const snapshot of seen) {
      expect(Object.keys(snapshot).sort()).toEqual(['index', 'item']);
      expect(snapshot.secret).toBeUndefined();
    }
    // Branch-private keys stayed private.
    const reviews = state.reviews as BranchState[];
    expect(reviews[0]['only-0']).toBe('a');
    expect(reviews[0]['only-1']).toBeUndefined();
    expect(reviews[1]['only-1']).toBe('b');
    expect(reviews[1]['only-0']).toBeUndefined();
    // The parent's own state is untouched by the branches.
    expect(state.secret).toBe('parent-only');
  });

  it('seeds each branch with its item and index (visible in the trace, not hidden in a closure)', async () => {
    const chart = flowChart<ParentState>(
      'Split',
      (scope) => {
        scope.chunks = ['first', 'second'];
      },
      'split',
    )
      .addParallelForEach('Review', 'review-chunks', {
        items: (scope) => scope.chunks ?? [],
        branch: () =>
          flowChart<BranchState>(
            'Echo',
            (scope) => {
              scope.score = `${scope.index}:${scope.item}`;
            },
            'echo',
          ).build(),
        maxBranches: 4,
        into: 'reviews',
      })
      .build();

    const reviews = (await runChart(chart)).reviews as BranchState[];
    expect(reviews.map((r) => r.score)).toEqual(['0:first', '1:second']);
  });
});

describe('addParallelForEach — LOOP RE-ENTRY re-registers the branch charts', () => {
  /**
   * THE TRIPWIRE for the re-registration law.
   *
   * Subflow registration is normally first-write-wins, and generated segments
   * are STABLE across loop iterations (`<stageId>~<index>` depends on nothing
   * that changes). Under first-write-wins, a looping fan-out would silently
   * keep executing iteration 1's branch charts forever — no crash, just a
   * wrong answer from the second iteration on. `registerBranchSubflow`
   * overwrites instead; this test is what fails if that ever regresses.
   */
  it('a second iteration runs the FRESH chart the factory returned, not the first one', async () => {
    interface LoopState {
      round?: number;
      chunks?: string[];
      reviews?: BranchState[];
      seenPerRound?: string[];
      [key: string]: unknown;
    }

    // Every call to the factory bakes a DIFFERENT answer into the chart it
    // returns. If the engine kept the first registration, round 2 would report
    // build #1's answer — silently, with no error anywhere.
    let buildCount = 0;
    const branch = (chunk: string, index: number) => {
      buildCount += 1;
      const stamp = `build${buildCount}`;
      return flowChart<BranchState>(
        'Score',
        (scope) => {
          scope.score = `${stamp}:${chunk}:${index}`;
        },
        'score',
      ).build();
    };

    const chart = flowChart<LoopState>(
      'Seed',
      (scope) => {
        scope.round = 0;
        scope.seenPerRound = [];
      },
      'seed',
    )
      .addFunction(
        'Next round',
        (scope) => {
          scope.round = (scope.round ?? 0) + 1;
          scope.chunks = ['x'];
        },
        'next-round',
      )
      .addParallelForEach('Review', 'review-chunks', {
        items: (scope) => scope.chunks ?? [],
        branch,
        maxBranches: 2,
        into: 'reviews',
      })
      .addFunction(
        'Collect',
        (scope) => {
          scope.seenPerRound = [...(scope.seenPerRound ?? []), String(scope.reviews?.[0]?.score)];
          if ((scope.round ?? 0) >= 2) scope.$break();
        },
        'collect',
      )
      .loopTo('next-round')
      .build();

    const seen = (await runChart(chart)).seenPerRound as string[];

    expect(buildCount).toBe(2); // the factory was asked once per iteration
    expect(seen).toHaveLength(2);
    // Under first-write-wins this would read ['build1:x:0', 'build1:x:0'].
    expect(seen).toEqual(['build1:x:0', 'build2:x:0']);
  });
});
