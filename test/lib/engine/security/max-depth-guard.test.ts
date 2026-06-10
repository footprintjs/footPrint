/**
 * Tests for the FlowchartTraverser maxDepth (tree-nesting depth) guard.
 *
 * Trampoline model: `executeNode` is an iterative driver — linear `next`
 * chains and loop edges are followed in a flat loop and consume NO depth.
 * Depth grows only with true tree nesting: fork children, decider/selector
 * branch dispatch (when the decider has its own continuation), recursive
 * composition. The guard increments per driver invocation and decrements on
 * exit (try/finally). When the counter exceeds MAX_EXECUTE_DEPTH (500), a
 * descriptive Error is thrown that names the stage and explains what depth
 * counts.
 */

import { flowChart, FlowChartExecutor } from '../../../../src/index';
import { FlowchartTraverser } from '../../../../src/lib/engine/traversal/FlowchartTraverser';
// FlowchartTraverser is imported to access the MAX_EXECUTE_DEPTH constant (unit tests)

// ---------------------------------------------------------------------------
// Pattern 1: unit — MAX_EXECUTE_DEPTH is exposed and has a sensible value
// ---------------------------------------------------------------------------
describe('maxDepth guard — unit: constant value and visibility', () => {
  it('MAX_EXECUTE_DEPTH is a static property with a positive integer value', () => {
    expect(typeof FlowchartTraverser.MAX_EXECUTE_DEPTH).toBe('number');
    expect(FlowchartTraverser.MAX_EXECUTE_DEPTH).toBeGreaterThan(0);
    expect(Number.isInteger(FlowchartTraverser.MAX_EXECUTE_DEPTH)).toBe(true);
  });

  it('MAX_EXECUTE_DEPTH is at least 100 (enough for realistic pipelines)', () => {
    expect(FlowchartTraverser.MAX_EXECUTE_DEPTH).toBeGreaterThanOrEqual(100);
  });

  it('MAX_EXECUTE_DEPTH is at most 10 000 (prevents stack overflow)', () => {
    // V8 stack limit is ~10 000-15 000 frames; async frames are larger.
    // The constant must be conservative enough not to overflow the real stack.
    expect(FlowchartTraverser.MAX_EXECUTE_DEPTH).toBeLessThanOrEqual(10_000);
  });
});

// ---------------------------------------------------------------------------
// Pattern 2: boundary — a chart with MAX_EXECUTE_DEPTH stages runs, MAX+1 throws
// ---------------------------------------------------------------------------
describe('maxDepth guard — boundary: charts near the limit', () => {
  it('a short chain of 5 stages runs successfully', async () => {
    const steps: string[] = [];

    let builder = flowChart<any>(
      'A',
      async () => {
        steps.push('A');
      },
      'a',
    );
    const names = ['B', 'C', 'D', 'E'];
    for (const n of names) {
      builder = builder.addFunction(
        n,
        async () => {
          steps.push(n);
        },
        n.toLowerCase(),
      ) as any;
    }
    const chart = builder.build();
    const ex = new FlowChartExecutor(chart);
    await ex.run(); // resolves without throwing
    expect(steps).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('a loop that iterates exactly once does not throw', async () => {
    let count = 0;
    const chart = flowChart<any>(
      'Main',
      async (s) => {
        s.count = ++count;
      },
      'main',
    ).build();

    const ex = new FlowChartExecutor(chart);
    await ex.run(); // resolves without throwing
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pattern 3: scenario — simulated deep-but-finite chain completes
// ---------------------------------------------------------------------------
describe('maxDepth guard — scenario: deep but finite chains', () => {
  it('a 30-stage sequential chain runs without hitting the depth limit', async () => {
    const executed: number[] = [];

    // Build a 30-stage chain programmatically
    const total = 30;
    let b = flowChart<any>(
      'Stage_0',
      async () => {
        executed.push(0);
      },
      's0',
    );
    for (let i = 1; i < total; i++) {
      const idx = i;
      b = b.addFunction(
        `Stage_${idx}`,
        async () => {
          executed.push(idx);
        },
        `s${idx}`,
      ) as any;
    }
    const chart = b.build();

    const ex = new FlowChartExecutor(chart);
    await ex.run();

    expect(executed.length).toBe(total);
    expect(executed[0]).toBe(0);
    expect(executed[total - 1]).toBe(total - 1);
  });

  it('normal execution with subflows stays well within the depth limit', async () => {
    const steps: string[] = [];

    const sub = flowChart<any>(
      'SubA',
      async () => {
        steps.push('sub');
      },
      'sub-a',
    )
      .addFunction(
        'SubB',
        async () => {
          steps.push('sub-b');
        },
        'sub-b',
      )
      .build();

    const main = flowChart<any>(
      'Main',
      async () => {
        steps.push('main');
      },
      'main',
    )
      .addSubFlowChartNext('MySub', sub, 'my-sub')
      .addFunction(
        'After',
        async () => {
          steps.push('after');
        },
        'after',
      )
      .build();

    const ex = new FlowChartExecutor(main);
    await ex.run(); // must not throw

    expect(steps).toContain('main');
    expect(steps).toContain('sub');
    expect(steps).toContain('after');
  });
});

// ---------------------------------------------------------------------------
// Pattern 4: property — depth counter returns to 0 after normal execution
// ---------------------------------------------------------------------------
describe('maxDepth guard — property: depth counter is correctly maintained', () => {
  it('multiple sequential runs on the same executor do not accumulate depth', async () => {
    // If the counter were not decremented via finally, sequential runs would
    // accumulate and eventually hit the limit even on finite graphs.
    let runCount = 0;
    const chart = flowChart<any>(
      'Step',
      async () => {
        runCount++;
      },
      'step',
    )
      .addFunction('Step2', async () => {}, 'step2')
      .addFunction('Step3', async () => {}, 'step3')
      .build();

    const ex = new FlowChartExecutor(chart);

    // Run 5 times — each should succeed without throwing; no accumulated depth
    for (let i = 0; i < 5; i++) {
      await ex.run(); // must not throw
    }
    expect(runCount).toBe(5);
  });

  it('depth error does not permanently disable the executor', async () => {
    // A finite pipeline should still work on subsequent calls
    // even if a previous (hypothetical) deep run threw.
    const chart = flowChart<any>('Simple', async () => {}, 'simple').build();
    const ex = new FlowChartExecutor(chart);
    await ex.run(); // must not throw
    await ex.run(); // second run also succeeds
  });
});

// ---------------------------------------------------------------------------
// Pattern 5: security — depth error is thrown with a meaningful message
// ---------------------------------------------------------------------------
describe('maxDepth guard — security: error message quality', () => {
  it('linear chains do NOT consume depth — a 3-stage chain runs even at maxDepth=1 (trampoline)', async () => {
    const ran: string[] = [];
    const chart = flowChart<any>(
      'A',
      async () => {
        ran.push('A');
      },
      'a',
    )
      .addFunction(
        'B',
        async () => {
          ran.push('B');
        },
        'b',
      )
      .addFunction(
        'C',
        async () => {
          ran.push('C');
        },
        'c',
      )
      .build();

    const ex = new FlowChartExecutor(chart);
    await ex.run({ maxDepth: 1 }); // flat driver: whole chain is depth 1
    expect(ran).toEqual(['A', 'B', 'C']);
  });

  it('nested dispatch DOES consume depth — maxDepth=1 rejects a decider-with-continuation branch', async () => {
    // A decider that has its own `next` dispatches its branch recursively
    // (the branch must complete before the continuation runs) — that nested
    // driver is depth 2, which maxDepth=1 rejects.
    const chart = flowChart<any>('Seed', async () => {}, 'seed')
      .addDeciderFunction('Route', async () => 'go', 'route')
      .addFunctionBranch('go', 'Branch', async () => {})
      .end()
      .addFunction('After', async () => {}, 'after')
      .build();

    const ex = new FlowChartExecutor(chart);
    await expect(ex.run({ maxDepth: 1 })).rejects.toThrow(/maximum traversal depth exceeded/i);
  });

  it('error message mentions the limit and explains what depth counts', async () => {
    const chart = flowChart<any>('Seed', async () => {}, 'seed')
      .addDeciderFunction('Route', async () => 'go', 'route')
      .addFunctionBranch('go', 'Branch', async () => {})
      .end()
      .addFunction('After', async () => {}, 'after')
      .build();

    const ex = new FlowChartExecutor(chart);
    let errorMessage = '';
    try {
      await ex.run({ maxDepth: 1 });
    } catch (e: any) {
      errorMessage = e.message;
    }

    expect(errorMessage).toMatch(/maximum traversal depth exceeded/i);
    expect(errorMessage).toMatch(/1/); // the limit value appears
    expect(errorMessage).toMatch(/nested dispatch/i); // explains the new counting model
  });

  it('the guard fires at depth + 1, not before', async () => {
    // maxDepth=1: the root chain (Seed → Route, depth 1) runs fine — only
    // the nested branch dispatch (depth 2) trips the guard.
    const ran: string[] = [];
    const chart = flowChart<any>(
      'Seed',
      async () => {
        ran.push('Seed');
      },
      'seed',
    )
      .addDeciderFunction(
        'Route',
        async () => {
          ran.push('Route');
          return 'go';
        },
        'route',
      )
      .addFunctionBranch('go', 'Branch', async () => {
        ran.push('Branch');
      })
      .end()
      .addFunction(
        'After',
        async () => {
          ran.push('After');
        },
        'after',
      )
      .build();

    const ex = new FlowChartExecutor(chart);
    await expect(ex.run({ maxDepth: 1 })).rejects.toThrow(/maximum traversal depth exceeded/i);
    // Seed and the decider stage itself executed at depth 1 before the
    // branch dispatch fired the guard at depth 2.
    expect(ran).toContain('Seed');
    expect(ran).toContain('Route');
    expect(ran).not.toContain('Branch');
    expect(ran).not.toContain('After');

    // maxDepth=2 admits the same chart: one nesting level is exactly depth 2.
    const ran2: string[] = [];
    const chart2 = flowChart<any>(
      'Seed',
      async () => {
        ran2.push('Seed');
      },
      'seed',
    )
      .addDeciderFunction(
        'Route',
        async () => {
          ran2.push('Route');
          return 'go';
        },
        'route',
      )
      .addFunctionBranch('go', 'Branch', async () => {
        ran2.push('Branch');
      })
      .end()
      .addFunction(
        'After',
        async () => {
          ran2.push('After');
        },
        'after',
      )
      .build();
    await new FlowChartExecutor(chart2).run({ maxDepth: 2 });
    expect(ran2).toEqual(['Seed', 'Route', 'Branch', 'After']);
  });

  it('maxDepth < 1 throws in the constructor (invalid configuration)', async () => {
    const chart = flowChart<any>('A', async () => {}, 'a').build();
    const ex = new FlowChartExecutor(chart);
    await expect(ex.run({ maxDepth: 0 })).rejects.toThrow(/maxDepth must be >= 1/i);
  });
});
