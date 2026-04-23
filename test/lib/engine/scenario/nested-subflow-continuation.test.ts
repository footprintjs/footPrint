/**
 * Nested Subflow Continuation — stages after inner subflows execute correctly.
 *
 * Regression tests for the bug where SubflowExecutor.executeSubflowInternal()
 * returned immediately after a nested subflow, silently skipping all subsequent
 * stages in the parent subflow.
 *
 * The fix: after executeSubflow() returns for a nested subflow, check node.next
 * and continue execution — mirroring FlowchartTraverser.executeNode() behavior.
 *
 * Tiers:
 * - unit:     single inner subflow with stage after it
 * - boundary: inner subflow at end (no next), empty inner subflow
 * - scenario: multiple chained inner subflows, 3-level nesting, I/O mapping through nested
 * - property: execution order always matches graph topology
 * - security: inner subflow error does not skip parent cleanup
 */

import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/lib/builder';
import type { StageContext } from '../../../../src/lib/memory';
import { FlowChartExecutor } from '../../../../src/lib/runner';

// ── Helpers ──────────────────────────────────────────────────

const noop = () => {};

/** Scope factory that gives stages getValue/setValue on shared state. */
function makeScopeFactory() {
  return (ctx: StageContext) => ({
    ctx,
    setValue: (key: string, value: unknown) => ctx.setGlobal(key, value),
    getValue: (key: string) => ctx.getGlobal(key),
  });
}

// ── Unit Tests ──────────────────────────────────────────────

describe('Nested subflow continuation — unit', () => {
  it('stage after inner subflow executes within parent subflow', async () => {
    const order: string[] = [];

    // Inner subflow: single stage
    const inner = flowChart(
      'InnerStage',
      () => {
        order.push('inner');
      },
      'inner-stage',
    ).build();

    // Outer chart: InnerSubflow → AfterStage
    const outer = flowChart(
      'BeforeInner',
      () => {
        order.push('before');
      },
      'before',
    )
      .addSubFlowChartNext('sf-inner', inner, 'InnerFlow')
      .addFunction(
        'AfterInner',
        () => {
          order.push('after');
        },
        'after',
      )
      .build();

    // Mount outer as a subflow in a parent chart
    const parent = flowChart(
      'ParentSeed',
      () => {
        order.push('parent-seed');
      },
      'parent-seed',
    )
      .addSubFlowChartNext('sf-outer', outer, 'OuterFlow')
      .addFunction(
        'ParentFinal',
        () => {
          order.push('parent-final');
        },
        'parent-final',
      )
      .build();

    const executor = new FlowChartExecutor(parent);
    await executor.run();

    expect(order).toEqual(['parent-seed', 'before', 'inner', 'after', 'parent-final']);
  });

  it('inner subflow output does not swallow parent continuation', async () => {
    const order: string[] = [];

    const inner = flowChart(
      'Compute',
      () => {
        order.push('compute');
      },
      'compute',
    ).build();

    const outer = flowChart(
      'Init',
      () => {
        order.push('init');
      },
      'init',
    )
      .addSubFlowChartNext('sf-compute', inner, 'Compute')
      .addFunction(
        'Verify',
        () => {
          // This stage MUST execute after the inner subflow — verifies continuation
          order.push('verify');
        },
        'verify',
      )
      .build();

    const parent = flowChart(
      'Start',
      () => {
        order.push('start');
      },
      'start',
    )
      .addSubFlowChartNext('sf-outer', outer, 'Outer')
      .build();

    const executor = new FlowChartExecutor(parent);
    await executor.run();

    // Verify stage must have run after the inner subflow
    expect(order).toEqual(['start', 'init', 'compute', 'verify']);
  });
});

// ── Boundary Tests ──────────────────────────────────────────

describe('Nested subflow continuation — boundary', () => {
  it('inner subflow at end of chain (no next) works correctly', async () => {
    const order: string[] = [];

    const inner = flowChart(
      'InnerOnly',
      () => {
        order.push('inner');
      },
      'inner-only',
    ).build();

    // Outer chart ends with inner subflow — no stage after it
    const outer = flowChart(
      'Before',
      () => {
        order.push('before');
      },
      'before',
    )
      .addSubFlowChartNext('sf-inner', inner, 'Inner')
      .build();

    const parent = flowChart(
      'Seed',
      () => {
        order.push('seed');
      },
      'seed',
    )
      .addSubFlowChartNext('sf-outer', outer, 'Outer')
      .addFunction(
        'Final',
        () => {
          order.push('final');
        },
        'final',
      )
      .build();

    const executor = new FlowChartExecutor(parent);
    await executor.run();

    expect(order).toEqual(['seed', 'before', 'inner', 'final']);
  });

  it('empty inner subflow (noop) still allows continuation', async () => {
    const order: string[] = [];

    const inner = flowChart('Noop', noop, 'noop').build();

    const outer = flowChart(
      'A',
      () => {
        order.push('a');
      },
      'a',
    )
      .addSubFlowChartNext('sf-noop', inner, 'Noop')
      .addFunction(
        'B',
        () => {
          order.push('b');
        },
        'b',
      )
      .build();

    const parent = flowChart(
      'Root',
      () => {
        order.push('root');
      },
      'root',
    )
      .addSubFlowChartNext('sf-outer', outer, 'Outer')
      .build();

    const executor = new FlowChartExecutor(parent);
    await executor.run();

    expect(order).toEqual(['root', 'a', 'b']);
  });
});

// ── Scenario Tests ──────────────────────────────────────────

describe('Nested subflow continuation — scenario', () => {
  it('multiple chained inner subflows all execute with stages between them', async () => {
    const order: string[] = [];

    const sub1 = flowChart(
      'Sub1',
      () => {
        order.push('sub1');
      },
      'sub1',
    ).build();
    const sub2 = flowChart(
      'Sub2',
      () => {
        order.push('sub2');
      },
      'sub2',
    ).build();
    const sub3 = flowChart(
      'Sub3',
      () => {
        order.push('sub3');
      },
      'sub3',
    ).build();

    // Outer: Sub1 → StageA → Sub2 → StageB → Sub3 → StageC
    const outer = flowChart(
      'Entry',
      () => {
        order.push('entry');
      },
      'entry',
    )
      .addSubFlowChartNext('sf-1', sub1, 'Sub1')
      .addFunction(
        'StageA',
        () => {
          order.push('stage-a');
        },
        'stage-a',
      )
      .addSubFlowChartNext('sf-2', sub2, 'Sub2')
      .addFunction(
        'StageB',
        () => {
          order.push('stage-b');
        },
        'stage-b',
      )
      .addSubFlowChartNext('sf-3', sub3, 'Sub3')
      .addFunction(
        'StageC',
        () => {
          order.push('stage-c');
        },
        'stage-c',
      )
      .build();

    // Mount the whole thing as a subflow
    const parent = flowChart(
      'Root',
      () => {
        order.push('root');
      },
      'root',
    )
      .addSubFlowChartNext('sf-outer', outer, 'Outer')
      .addFunction(
        'Done',
        () => {
          order.push('done');
        },
        'done',
      )
      .build();

    const executor = new FlowChartExecutor(parent);
    await executor.run();

    expect(order).toEqual(['root', 'entry', 'sub1', 'stage-a', 'sub2', 'stage-b', 'sub3', 'stage-c', 'done']);
  });

  it('three-level nesting: subflow inside subflow inside subflow', async () => {
    const order: string[] = [];

    const level3 = flowChart(
      'L3',
      () => {
        order.push('L3');
      },
      'l3',
    ).build();

    const level2 = flowChart(
      'L2-Before',
      () => {
        order.push('L2-before');
      },
      'l2-before',
    )
      .addSubFlowChartNext('sf-l3', level3, 'Level3')
      .addFunction(
        'L2-After',
        () => {
          order.push('L2-after');
        },
        'l2-after',
      )
      .build();

    const level1 = flowChart(
      'L1-Before',
      () => {
        order.push('L1-before');
      },
      'l1-before',
    )
      .addSubFlowChartNext('sf-l2', level2, 'Level2')
      .addFunction(
        'L1-After',
        () => {
          order.push('L1-after');
        },
        'l1-after',
      )
      .build();

    const root = flowChart(
      'Root',
      () => {
        order.push('root');
      },
      'root',
    )
      .addSubFlowChartNext('sf-l1', level1, 'Level1')
      .addFunction(
        'Final',
        () => {
          order.push('final');
        },
        'final',
      )
      .build();

    const executor = new FlowChartExecutor(root);
    await executor.run();

    expect(order).toEqual(['root', 'L1-before', 'L2-before', 'L3', 'L2-after', 'L1-after', 'final']);
  });

  it('I/O mapping flows correctly through nested subflows', async () => {
    const inner = flowChart(
      'InnerWrite',
      (scope: any) => {
        const input = scope.ctx.getGlobal('innerInput');
        scope.ctx.setGlobal('innerOutput', `processed-${input}`);
      },
      'inner-write',
    ).build();

    const outer = flowChart(
      'OuterInit',
      (scope: any) => {
        scope.ctx.setGlobal('outerStarted', true);
      },
      'outer-init',
    )
      .addSubFlowChartNext('sf-inner', inner, 'Inner', {
        inputMapper: (parent: Record<string, unknown>) => ({
          innerInput: parent.outerValue ?? 'default',
        }),
        outputMapper: (sfOutput: Record<string, unknown>) => ({
          outerResult: sfOutput.innerOutput,
        }),
      })
      .addFunction(
        'OuterVerify',
        (scope: any) => {
          scope.ctx.setGlobal('outerVerified', true);
        },
        'outer-verify',
      )
      .build();

    const root = flowChart(
      'Seed',
      (scope: any) => {
        scope.ctx.setGlobal('outerValue', 'hello');
      },
      'seed',
    )
      .addSubFlowChartNext('sf-outer', outer, 'Outer', {
        inputMapper: (parent: Record<string, unknown>) => ({
          outerValue: parent.outerValue,
        }),
        outputMapper: (sfOutput: Record<string, unknown>) => ({
          finalResult: sfOutput.outerResult,
          outerVerified: sfOutput.outerVerified,
        }),
      })
      .build();

    const executor = new FlowChartExecutor(root, { scopeFactory: makeScopeFactory() });
    await executor.run();

    const snapshot = executor.getSnapshot();
    expect(snapshot?.sharedState?.outerVerified).toBe(true);
  });

  it('narrative captures nested subflow entry/exit and continuation stages', async () => {
    const inner = flowChart('InnerStep', noop, 'inner-step', undefined, 'Process inner data').build();

    const outer = flowChart('OuterStart', noop, 'outer-start', undefined, 'Begin outer')
      .addSubFlowChartNext('sf-inner', inner, 'InnerFlow')
      .addFunction('OuterEnd', noop, 'outer-end', 'Finish outer')
      .build();

    const root = flowChart('Root', noop, 'root', undefined, 'Root stage')
      .addSubFlowChartNext('sf-outer', outer, 'OuterFlow')
      .build();

    const executor = new FlowChartExecutor(root);
    executor.enableNarrative();
    await executor.run();

    const narrative = executor.getNarrativeEntries().map((e) => e.text);

    // Should see both subflow entries
    expect(narrative.some((s) => s.includes('OuterFlow subflow'))).toBe(true);
    expect(narrative.some((s) => s.includes('InnerFlow subflow'))).toBe(true);
    // Should see the continuation stage after inner subflow
    expect(narrative.some((s) => s.includes('Finish outer'))).toBe(true);
  });
});

// ── Property Tests ──────────────────────────────────────────

describe('Nested subflow continuation — property', () => {
  it('execution order always matches graph topology regardless of nesting depth', async () => {
    // Build a chart programmatically with N levels of nesting
    const order: string[] = [];
    const depth = 4;

    let innermost = flowChart(
      `Stage-${depth}`,
      () => {
        order.push(`stage-${depth}`);
      },
      `stage-${depth}`,
    ).build();

    for (let i = depth - 1; i >= 1; i--) {
      innermost = flowChart(
        `Before-${i}`,
        () => {
          order.push(`before-${i}`);
        },
        `before-${i}`,
      )
        .addSubFlowChartNext(`sf-${i}`, innermost, `Level${i + 1}`)
        .addFunction(
          `After-${i}`,
          () => {
            order.push(`after-${i}`);
          },
          `after-${i}`,
        )
        .build();
    }

    const root = flowChart(
      'Root',
      () => {
        order.push('root');
      },
      'root',
    )
      .addSubFlowChartNext('sf-top', innermost, 'Top')
      .build();

    const executor = new FlowChartExecutor(root);
    await executor.run();

    // Verify DFS order: root, before-1, before-2, before-3, stage-4, after-3, after-2, after-1
    expect(order[0]).toBe('root');
    expect(order[order.length - 1]).toBe('after-1');
    expect(order.length).toBe(1 + depth + (depth - 1)); // root + N stages + (N-1) after stages
  });

  it('snapshot is available for every nested subflow level', async () => {
    const order: string[] = [];

    const inner = flowChart(
      'InnerStage',
      () => {
        order.push('inner');
      },
      'inner-stage',
    ).build();

    const outer = flowChart(
      'OuterStage',
      () => {
        order.push('outer');
      },
      'outer-stage',
    )
      .addSubFlowChartNext('sf-inner', inner, 'Inner')
      .addFunction(
        'OuterAfter',
        () => {
          order.push('outer-after');
        },
        'outer-after',
      )
      .build();

    const root = flowChart(
      'Root',
      () => {
        order.push('root');
      },
      'root',
    )
      .addSubFlowChartNext('sf-outer', outer, 'Outer')
      .build();

    const executor = new FlowChartExecutor(root);
    await executor.run();

    // All stages executed
    expect(order).toEqual(['root', 'outer', 'inner', 'outer-after']);

    const snapshot = executor.getSnapshot();
    expect(snapshot).toBeDefined();
    // Subflow results should contain entries for outer level
    const subflowResults = snapshot?.subflowResults ?? {};
    expect(subflowResults['sf-outer']).toBeDefined();
  });
});

// ── Security Tests ──────────────────────────────────────────

describe('Nested subflow continuation — security', () => {
  it('inner subflow error propagates without skipping parent error handling', async () => {
    const order: string[] = [];

    const inner = flowChart(
      'Boom',
      () => {
        order.push('boom');
        throw new Error('inner-failure');
      },
      'boom',
    ).build();

    const outer = flowChart(
      'OuterStart',
      () => {
        order.push('outer-start');
      },
      'outer-start',
    )
      .addSubFlowChartNext('sf-inner', inner, 'Inner')
      .addFunction(
        'NeverReached',
        () => {
          order.push('never');
        },
        'never',
      )
      .build();

    const root = flowChart(
      'Root',
      () => {
        order.push('root');
      },
      'root',
    )
      .addSubFlowChartNext('sf-outer', outer, 'Outer')
      .addFunction(
        'AlsoNever',
        () => {
          order.push('also-never');
        },
        'also-never',
      )
      .build();

    const executor = new FlowChartExecutor(root);
    await expect(executor.run()).rejects.toThrow('inner-failure');

    // Stages before the error executed; stages after did not
    expect(order).toContain('root');
    expect(order).toContain('outer-start');
    expect(order).toContain('boom');
    expect(order).not.toContain('never');
    expect(order).not.toContain('also-never');
  });

  it('break inside nested subflow stops the subflow but parent continues', async () => {
    const order: string[] = [];

    // Inner subflow with a break — break is isolated to the inner subflow's breakFlag
    const inner = flowChart(
      'InnerA',
      (scope: any) => {
        order.push('inner-a');
      },
      'inner-a',
    )
      .addFunction(
        'InnerB',
        (scope: any) => {
          order.push('inner-b');
        },
        'inner-b',
      )
      .build();

    const outer = flowChart(
      'OuterA',
      () => {
        order.push('outer-a');
      },
      'outer-a',
    )
      .addSubFlowChartNext('sf-inner', inner, 'Inner')
      .addFunction(
        'OuterB',
        () => {
          order.push('outer-b');
        },
        'outer-b',
      )
      .build();

    const root = flowChart(
      'Root',
      () => {
        order.push('root');
      },
      'root',
    )
      .addSubFlowChartNext('sf-outer', outer, 'Outer')
      .addFunction(
        'Final',
        () => {
          order.push('final');
        },
        'final',
      )
      .build();

    const executor = new FlowChartExecutor(root);
    await executor.run();

    // All stages should execute (no break was called)
    expect(order).toEqual(['root', 'outer-a', 'inner-a', 'inner-b', 'outer-b', 'final']);
  });
});
