/**
 * Scenario test: Decider inside subflow — the root cause bug this refactor fixes.
 *
 * Before the factory refactor, SubflowExecutor had its own executeSubflowInternal()
 * which was a duplicated, incomplete copy of FlowchartTraverser.executeNode().
 * It was MISSING the decider phase: addDeciderFunction branches inside subflows
 * executed ALL branches instead of just the chosen one.
 *
 * The fix: SubflowExecutor delegates to a factory-created FlowchartTraverser
 * which uses the SAME 7-phase algorithm (including decider + selector phases).
 *
 * Tiers:
 * - unit:     decider inside subflow executes only the chosen branch
 * - boundary: default branch, all branches present, only one branch
 * - scenario: decider with output mapping, nested subflow with decider
 * - property: exactly one branch executes per decider call
 * - security: decider error does not crash parent, unknown branch handled
 */

import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartBuilder, FlowChartExecutor } from '../../../../src/index';

// ── Helpers ──────────────────────────────────────────────────────────────

interface DeciderState {
  route?: string;
  approved?: boolean;
  rejected?: boolean;
  reviewed?: boolean;
  result?: string;
}

interface ParentState {
  amount: number;
  route?: string;
  outcome?: string;
}

function buildDeciderSubflow(executionOrder: string[]) {
  return new FlowChartBuilder()
    .start(
      'Classify',
      (scope: any) => {
        executionOrder.push('Classify');
        const amount = scope.$getArgs?.()?.amount ?? scope.$getValue?.('amount') ?? 0;
        scope.$setValue('route', amount > 100 ? 'high' : 'low');
      },
      'classify',
    )
    .addDeciderFunction(
      'Route',
      (scope: any) => {
        executionOrder.push('Route');
        return scope.$getValue('route') ?? 'low';
      },
      'route',
    )
    .addFunctionBranch(
      'high',
      'Reject',
      (scope: any) => {
        executionOrder.push('Reject');
        scope.$setValue('rejected', true);
        scope.$setValue('result', 'rejected');
      },
      'reject',
    )
    .addFunctionBranch(
      'low',
      'Approve',
      (scope: any) => {
        executionOrder.push('Approve');
        scope.$setValue('approved', true);
        scope.$setValue('result', 'approved');
      },
      'approve',
    )
    .setDefault('low')
    .end()
    .build();
}

// ── Unit Tests ───────────────────────────────────────────────────────────

describe('Decider in subflow — unit', () => {
  it('executes only the chosen branch (low → Approve)', async () => {
    const order: string[] = [];
    const subflow = buildDeciderSubflow(order);

    const chart = flowChart(
      'Seed',
      (scope: any) => {
        scope.amount = 50;
      },
      'seed',
    )
      .addSubFlowChartNext('sf-decide', subflow, 'DecideSubflow', {
        inputMapper: (parent: any) => ({ amount: parent.amount }),
        outputMapper: (sf: any) => ({ outcome: sf.result }),
      })
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    // Only Approve branch should execute, not Reject
    expect(order).toEqual(['Classify', 'Route', 'Approve']);
    expect(order).not.toContain('Reject');

    const state = executor.getSnapshot()?.sharedState as any;
    expect(state.outcome).toBe('approved');
  });

  it('executes only the chosen branch (high → Reject)', async () => {
    const order: string[] = [];
    const subflow = buildDeciderSubflow(order);

    const chart = flowChart(
      'Seed',
      (scope: any) => {
        scope.amount = 200;
      },
      'seed',
    )
      .addSubFlowChartNext('sf-decide', subflow, 'DecideSubflow', {
        inputMapper: (parent: any) => ({ amount: parent.amount }),
        outputMapper: (sf: any) => ({ outcome: sf.result }),
      })
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(order).toEqual(['Classify', 'Route', 'Reject']);
    expect(order).not.toContain('Approve');

    const state = executor.getSnapshot()?.sharedState as any;
    expect(state.outcome).toBe('rejected');
  });
});

// ── Boundary Tests ───────────────────────────────────────────────────────

describe('Decider in subflow — boundary', () => {
  it('uses default branch when decider returns unknown value', async () => {
    const order: string[] = [];

    const subflow = new FlowChartBuilder()
      .start(
        'Setup',
        (scope: any) => {
          order.push('Setup');
        },
        'setup',
      )
      .addDeciderFunction(
        'Route',
        () => {
          order.push('Route');
          return 'nonexistent'; // no matching branch
        },
        'route',
      )
      .addFunctionBranch(
        'a',
        'BranchA',
        () => {
          order.push('BranchA');
        },
        'branch-a',
      )
      .addFunctionBranch(
        'b',
        'BranchB',
        () => {
          order.push('BranchB');
        },
        'branch-b',
      )
      .setDefault('a')
      .end()
      .build();

    const chart = flowChart('Root', () => {}, 'root')
      .addSubFlowChartNext('sf-default', subflow, 'DefaultSubflow')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    // Default branch 'a' should execute
    expect(order).toContain('BranchA');
    expect(order).not.toContain('BranchB');
  });

  it('decider with single branch works correctly', async () => {
    const order: string[] = [];

    const subflow = new FlowChartBuilder()
      .start(
        'Init',
        () => {
          order.push('Init');
        },
        'init',
      )
      .addDeciderFunction(
        'Decide',
        () => {
          order.push('Decide');
          return 'only';
        },
        'decide',
      )
      .addFunctionBranch(
        'only',
        'OnlyBranch',
        () => {
          order.push('OnlyBranch');
        },
        'only-branch',
      )
      .setDefault('only')
      .end()
      .build();

    const chart = flowChart('Root', () => {}, 'root')
      .addSubFlowChartNext('sf-single', subflow, 'SingleSubflow')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(order).toEqual(['Init', 'Decide', 'OnlyBranch']);
  });
});

// ── Scenario Tests ───────────────────────────────────────────────────────

describe('Decider in subflow — scenario', () => {
  it('decider result propagates through outputMapper to parent scope', async () => {
    const subflow = new FlowChartBuilder()
      .start(
        'Evaluate',
        (scope: any) => {
          scope.$setValue('score', 85);
          scope.$setValue('route', 'pass');
        },
        'evaluate',
      )
      .addDeciderFunction('PassFail', (scope: any) => scope.$getValue('route'), 'pass-fail')
      .addFunctionBranch(
        'pass',
        'MarkPass',
        (scope: any) => {
          scope.$setValue('grade', 'A');
        },
        'mark-pass',
      )
      .addFunctionBranch(
        'fail',
        'MarkFail',
        (scope: any) => {
          scope.$setValue('grade', 'F');
        },
        'mark-fail',
      )
      .setDefault('fail')
      .end()
      .build();

    const chart = flowChart(
      'StudentSeed',
      (scope: any) => {
        scope.studentId = 'S-1';
      },
      'student-seed',
    )
      .addSubFlowChartNext('sf-grading', subflow, 'GradingSubflow', {
        outputMapper: (sf: any) => ({ grade: sf.grade }),
      })
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const state = executor.getSnapshot()?.sharedState as any;
    expect(state.grade).toBe('A');
    expect(state.studentId).toBe('S-1');
  });

  it('selector inside subflow executes only selected children', async () => {
    const order: string[] = [];

    const subflow = new FlowChartBuilder()
      .start(
        'Init',
        () => {
          order.push('Init');
        },
        'init',
      )
      .addSelectorFunction(
        'Select',
        () => {
          order.push('Select');
          return ['chosen-id'];
        },
        'select',
      )
      .addFunctionBranch(
        'chosen-id',
        'Chosen',
        () => {
          order.push('Chosen');
        },
        'chosen',
      )
      .addFunctionBranch(
        'ignored-id',
        'Ignored',
        () => {
          order.push('Ignored');
        },
        'ignored',
      )
      .end()
      .build();

    const chart = flowChart('Root', () => {}, 'root')
      .addSubFlowChartNext('sf-selector', subflow, 'SelectorSubflow')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(order).toContain('Chosen');
    expect(order).not.toContain('Ignored');
  });

  it('narrative captures decider decision inside subflow', async () => {
    const subflow = new FlowChartBuilder()
      .start(
        'Setup',
        (scope: any) => {
          scope.$setValue('choice', 'yes');
        },
        'setup',
      )
      .addDeciderFunction('YesNo', (scope: any) => scope.$getValue('choice'), 'yes-no')
      .addFunctionBranch('yes', 'DoYes', () => {}, 'do-yes')
      .addFunctionBranch('no', 'DoNo', () => {}, 'do-no')
      .setDefault('no')
      .end()
      .build();

    const chart = flowChart('Root', () => {}, 'root')
      .addSubFlowChartNext('sf-narr', subflow, 'NarrSubflow')
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    await executor.run();

    const entries = executor.getNarrativeEntries();
    // Should have a condition entry for the decider
    const conditionEntry = entries.find((e) => e.type === 'condition');
    expect(conditionEntry).toBeDefined();
    // Narrative text contains the chosen branch name (may be prefixed in subflow context)
    expect(conditionEntry!.text).toContain('DoYes');
  });
});

// ── Property Tests ───────────────────────────────────────────────────────

describe('Decider in subflow — property', () => {
  it('exactly one branch executes for each decider invocation', async () => {
    const branchCounts = { a: 0, b: 0, c: 0 };

    for (const choice of ['a', 'b', 'c'] as const) {
      const subflow = new FlowChartBuilder()
        .start(
          'Pick',
          (scope: any) => {
            scope.$setValue('pick', choice);
          },
          'pick',
        )
        .addDeciderFunction('Router', (scope: any) => scope.$getValue('pick'), 'router')
        .addFunctionBranch(
          'a',
          'A',
          () => {
            branchCounts.a++;
          },
          'branch-a',
        )
        .addFunctionBranch(
          'b',
          'B',
          () => {
            branchCounts.b++;
          },
          'branch-b',
        )
        .addFunctionBranch(
          'c',
          'C',
          () => {
            branchCounts.c++;
          },
          'branch-c',
        )
        .setDefault('a')
        .end()
        .build();

      const chart = flowChart('Root', () => {}, 'root')
        .addSubFlowChartNext(`sf-prop-${choice}`, subflow, 'PropSubflow')
        .build();

      const executor = new FlowChartExecutor(chart);
      await executor.run();
    }

    // Each branch should have been called exactly once
    expect(branchCounts.a).toBe(1);
    expect(branchCounts.b).toBe(1);
    expect(branchCounts.c).toBe(1);
  });

  it('no branch executes twice per decider invocation', async () => {
    let callCount = 0;

    const subflow = new FlowChartBuilder()
      .start('Prep', () => {}, 'prep')
      .addDeciderFunction('Route', () => 'target', 'route')
      .addFunctionBranch(
        'target',
        'Target',
        () => {
          callCount++;
        },
        'target-branch',
      )
      .addFunctionBranch(
        'other',
        'Other',
        () => {
          callCount++;
        },
        'other-branch',
      )
      .setDefault('target')
      .end()
      .build();

    const chart = flowChart('Root', () => {}, 'root')
      .addSubFlowChartNext('sf-no-double', subflow, 'NoDoubleSubflow')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(callCount).toBe(1);
  });
});

// ── Security Tests ───────────────────────────────────────────────────────

describe('Decider in subflow — security', () => {
  it('decider error inside subflow propagates to parent', async () => {
    const subflow = new FlowChartBuilder()
      .start('Init', () => {}, 'init')
      .addDeciderFunction(
        'BadDecider',
        () => {
          throw new Error('decider crashed');
        },
        'bad-decider',
      )
      .addFunctionBranch('a', 'A', () => {}, 'a')
      .setDefault('a')
      .end()
      .build();

    const chart = flowChart('Root', () => {}, 'root')
      .addSubFlowChartNext('sf-error', subflow, 'ErrorSubflow')
      .build();

    const executor = new FlowChartExecutor(chart);
    await expect(executor.run()).rejects.toThrow('decider crashed');
  });

  it('loopTo() inside subflow works correctly (not broken by factory)', async () => {
    let iterations = 0;

    const subflow = new FlowChartBuilder()
      .start(
        'Process',
        (scope: any, breakPipeline: () => void) => {
          iterations++;
          if (iterations >= 3) {
            scope.$setValue('done', true);
            breakPipeline();
          }
        },
        'process',
      )
      .loopTo('process')
      .build();

    const chart = flowChart('Root', () => {}, 'root')
      .addSubFlowChartNext('sf-loop', subflow, 'LoopSubflow')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(iterations).toBe(3);
  });
});
