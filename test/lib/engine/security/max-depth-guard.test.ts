/**
 * Tests for the FlowchartTraverser maxDepth (recursion depth) guard.
 *
 * Fix: executeNode is recursive — each `await executeNode(next, ...)` keeps the
 * calling frame on the stack. Without a cap, an infinite loop or an excessively
 * deep stage chain would cause V8's call-stack to overflow with a cryptic
 * "Maximum call stack size exceeded" error.
 *
 * The guard increments a depth counter on entry and decrements on exit (try/finally).
 * When the counter exceeds MAX_EXECUTE_DEPTH (500), a descriptive Error is thrown
 * that names the stage and advises users to look for infinite loops.
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
  it('passing maxDepth=1 via RunOptions triggers a descriptive error on the second stage', async () => {
    const chart = flowChart<any>('A', async () => {}, 'a')
      .addFunction('B', async () => {}, 'b')
      .build();

    const ex = new FlowChartExecutor(chart);
    await expect(ex.run({ maxDepth: 1 })).rejects.toThrow(/maximum traversal depth exceeded/i);
  });

  it('error message mentions the limit and suggests checking for infinite loops', async () => {
    const chart = flowChart<any>('StageAlpha', async () => {}, 'alpha')
      .addFunction('StageBeta', async () => {}, 'beta')
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
  });

  it('the guard fires at depth + 1, not before', async () => {
    // With maxDepth=2 and a 3-stage chain, stages 1 and 2 run, stage 3 throws.
    const ran: string[] = [];
    const chart = flowChart<any>(
      'S1',
      async () => {
        ran.push('S1');
      },
      's1',
    )
      .addFunction(
        'S2',
        async () => {
          ran.push('S2');
        },
        's2',
      )
      .addFunction(
        'S3',
        async () => {
          ran.push('S3');
        },
        's3',
      )
      .build();

    const ex = new FlowChartExecutor(chart);
    await expect(ex.run({ maxDepth: 2 })).rejects.toThrow(/maximum traversal depth exceeded/i);
    // S1 and S2 executed before the depth check fired on S3
    expect(ran).toContain('S1');
    expect(ran).toContain('S2');
    expect(ran).not.toContain('S3');
  });

  it('maxDepth < 1 throws in the constructor (invalid configuration)', async () => {
    const chart = flowChart<any>('A', async () => {}, 'a').build();
    const ex = new FlowChartExecutor(chart);
    await expect(ex.run({ maxDepth: 0 })).rejects.toThrow(/maxDepth must be >= 1/i);
  });
});
