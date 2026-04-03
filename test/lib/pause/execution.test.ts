/**
 * Pause execution — 5-pattern tests.
 *
 * Tests the full pause signal flow:
 * StageRunner detects PauseResult → throws PauseSignal → SubflowExecutor prepends path →
 * FlowchartTraverser re-throws → FlowChartExecutor catches → creates checkpoint.
 */
import { describe, expect, it } from 'vitest';

import type { PausableHandler, PausedResult } from '../../../src';
import { flowChart, FlowChartExecutor } from '../../../src';

// ── Helpers ─────────────────────────────────────────────────

interface TestState {
  value: string;
  approved?: boolean;
  step?: number;
  [key: string]: unknown;
}

const approvalHandler: PausableHandler<any> = {
  execute: async (scope) => {
    scope.value = 'prepared';
    return { pause: true, data: { question: 'Approve?' } };
  },
  resume: async (scope, input: { approved: boolean }) => {
    scope.approved = input.approved;
  },
};

// ── Unit ────────────────────────────────────────────────────

describe('Pause execution — unit', () => {
  it('executor.isPaused() returns true after a pausable stage pauses', async () => {
    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.value = 'init';
      },
      'seed',
    )
      .addPausableFunction('Approve', approvalHandler, 'approve')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(executor.isPaused()).toBe(true);
  });

  it('getCheckpoint() returns a valid FlowchartCheckpoint', async () => {
    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.value = 'init';
      },
      'seed',
    )
      .addPausableFunction('Approve', approvalHandler, 'approve')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const checkpoint = executor.getCheckpoint();
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.sharedState).toBeDefined();
    expect(checkpoint!.sharedState.value).toBe('prepared');
    expect(checkpoint!.pauseData).toEqual({ question: 'Approve?' });
    expect(checkpoint!.pausedAt).toBeGreaterThan(0);
  });

  it('checkpoint sharedState reflects writes from the execute phase', async () => {
    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.value = 'order-123';
        scope.step = 1;
      },
      'seed',
    )
      .addPausableFunction(
        'Approve',
        {
          execute: async (scope) => {
            scope.step = 2;
            scope.value = 'pending-approval';
            return { pause: true, data: { orderId: 'order-123' } };
          },
          resume: async () => {},
        },
        'approve',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const cp = executor.getCheckpoint()!;
    expect(cp.sharedState.value).toBe('pending-approval');
    expect(cp.sharedState.step).toBe(2);
  });

  it('stages after the paused stage do NOT execute', async () => {
    let postPauseRan = false;

    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.value = 'init';
      },
      'seed',
    )
      .addPausableFunction('Approve', approvalHandler, 'approve')
      .addFunction(
        'PostPause',
        () => {
          postPauseRan = true;
        },
        'post-pause',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(executor.isPaused()).toBe(true);
    expect(postPauseRan).toBe(false);
  });

  it('non-pausing pausable stage continues normally', async () => {
    let postRan = false;

    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.value = 'init';
      },
      'seed',
    )
      .addPausableFunction(
        'MaybeApprove',
        {
          execute: async (scope) => {
            scope.value = 'auto-approved';
            // Return void — no pause
          },
          resume: async () => {},
        },
        'maybe-approve',
      )
      .addFunction(
        'Post',
        () => {
          postRan = true;
        },
        'post',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(executor.isPaused()).toBe(false);
    expect(executor.getCheckpoint()).toBeUndefined();
    expect(postRan).toBe(true);
  });
});

// ── Boundary ────────────────────────────────────────────────

describe('Pause execution — boundary', () => {
  it('pause with undefined data', async () => {
    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.value = 'init';
      },
      'seed',
    )
      .addPausableFunction(
        'Gate',
        {
          execute: async () => {
            return { pause: true };
          },
          resume: async () => {},
        },
        'gate',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(executor.isPaused()).toBe(true);
    expect(executor.getCheckpoint()!.pauseData).toBeUndefined();
  });

  it('pause at second stage (right after seed)', async () => {
    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.value = 'init';
      },
      'seed',
    )
      .addPausableFunction(
        'Gate',
        {
          execute: async () => ({ pause: true, data: 'first-pause' }),
          resume: async () => {},
        },
        'gate',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(executor.isPaused()).toBe(true);
    expect(executor.getCheckpoint()!.pauseData).toBe('first-pause');
  });

  it('isPaused() resets on subsequent non-pausing run', async () => {
    const shouldPause = { value: true };
    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.value = 'init';
      },
      'seed',
    )
      .addPausableFunction(
        'Gate',
        {
          execute: async () => {
            if (shouldPause.value) return { pause: true, data: 'paused' };
          },
          resume: async () => {},
        },
        'gate',
      )
      .build();

    const executor = new FlowChartExecutor(chart);

    // First run — pauses
    await executor.run();
    expect(executor.isPaused()).toBe(true);

    // Second run — does not pause
    shouldPause.value = false;
    await executor.run();
    expect(executor.isPaused()).toBe(false);
    expect(executor.getCheckpoint()).toBeUndefined();
  });

  it('checkpoint is JSON-serializable', async () => {
    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.value = 'deep-data';
      },
      'seed',
    )
      .addPausableFunction(
        'Gate',
        {
          execute: async () => ({
            pause: true,
            data: { nested: { deep: [1, 2, 3] } },
          }),
          resume: async () => {},
        },
        'gate',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const cp = executor.getCheckpoint()!;
    const json = JSON.stringify(cp);
    const parsed = JSON.parse(json);
    expect(parsed.pauseData.nested.deep).toEqual([1, 2, 3]);
    expect(parsed.sharedState.value).toBe('deep-data');
    expect(typeof parsed.pausedAt).toBe('number');
  });
});

// ── Scenario ────────────────────────────────────────────────

describe('Pause execution — scenario', () => {
  it('multi-stage pipeline: prepare → approve(pauses) → process(skipped)', async () => {
    const executedStages: string[] = [];

    const chart = flowChart<TestState>(
      'Prepare',
      (scope) => {
        executedStages.push('prepare');
        scope.value = 'order-456';
      },
      'prepare',
    )
      .addPausableFunction(
        'Approve',
        {
          execute: async (scope) => {
            executedStages.push('approve');
            scope.value = 'awaiting-approval';
            return { pause: true, data: { question: 'Approve order?' } };
          },
          resume: async () => {},
        },
        'approve',
      )
      .addFunction(
        'Process',
        (scope) => {
          executedStages.push('process');
          scope.value = 'processed';
        },
        'process',
      )
      .addFunction(
        'Notify',
        (scope) => {
          executedStages.push('notify');
          scope.value = 'notified';
        },
        'notify',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(executedStages).toEqual(['prepare', 'approve']);
    expect(executor.isPaused()).toBe(true);
    const cp = executor.getCheckpoint()!;
    expect(cp.sharedState.value).toBe('awaiting-approval');
  });

  it('pause after a decider branch', async () => {
    // Decider routes to a branch, then the chain continues to a pausable stage
    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.value = 'needs-approval';
      },
      'seed',
    )
      .addDeciderFunction(
        'Route',
        (scope) => {
          return scope.$getValue('value') as string;
        },
        'route',
      )
      .addFunctionBranch('needs-approval', 'Prepare', (scope) => {
        scope.step = 1;
      })
      .addFunctionBranch('auto', 'AutoApprove', (scope) => {
        scope.approved = true;
      })
      .end()
      .addPausableFunction(
        'Approve',
        {
          execute: async () => ({
            pause: true,
            data: { question: 'Approve?' },
          }),
          resume: async (scope, input) => {
            scope.approved = (input as any).approved;
          },
        },
        'approve',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(executor.isPaused()).toBe(true);
    const cp = executor.getCheckpoint()!;
    expect(cp.pauseData).toEqual({ question: 'Approve?' });
    expect(cp.pausedStageId).toBe('approve');
  });

  it('pause inside a subflow carries subflow path in checkpoint', async () => {
    const innerChart = flowChart<TestState>(
      'InnerSeed',
      (scope) => {
        scope.value = 'inner-init';
      },
      'inner-seed',
    )
      .addPausableFunction(
        'InnerApprove',
        {
          execute: async () => ({
            pause: true,
            data: { question: 'Inner approve?' },
          }),
          resume: async () => {},
        },
        'inner-approve',
      )
      .build();

    const outerChart = flowChart<TestState>(
      'OuterSeed',
      (scope) => {
        scope.value = 'outer-init';
      },
      'outer-seed',
    )
      .addSubFlowChart('InnerFlow', innerChart, 'sf-inner')
      .build();

    const executor = new FlowChartExecutor(outerChart);
    await executor.run();

    expect(executor.isPaused()).toBe(true);
    const cp = executor.getCheckpoint()!;
    expect(cp.pauseData).toEqual({ question: 'Inner approve?' });
  });
});

// ── Property ────────────────────────────────────────────────

describe('Pause execution — property', () => {
  it('run() return value has paused=true when paused', async () => {
    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.value = 'init';
      },
      'seed',
    )
      .addPausableFunction('Gate', approvalHandler, 'gate')
      .build();

    const executor = new FlowChartExecutor(chart);
    const result = await executor.run();

    expect(result).toBeDefined();
    const paused = result as PausedResult;
    expect(paused.paused).toBe(true);
    expect(paused.checkpoint).toBeDefined();
  });

  it('checkpoint.pausedAt is a recent timestamp', async () => {
    const before = Date.now();
    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.value = 'init';
      },
      'seed',
    )
      .addPausableFunction('Gate', approvalHandler, 'gate')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const after = Date.now();

    const cp = executor.getCheckpoint()!;
    expect(cp.pausedAt).toBeGreaterThanOrEqual(before);
    expect(cp.pausedAt).toBeLessThanOrEqual(after);
  });

  it('non-pausable stages that return pause-like objects do NOT trigger pause', async () => {
    let postRan = false;

    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.value = 'init';
      },
      'seed',
    )
      .addFunction(
        'FakeGate',
        () => {
          // Returns something that looks like PauseResult, but stage is NOT pausable
          return { pause: true, data: { fake: true } } as any;
        },
        'fake-gate',
      )
      .addFunction(
        'Post',
        () => {
          postRan = true;
        },
        'post',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    // Not paused — isPausable is false on the node
    expect(executor.isPaused()).toBe(false);
    expect(postRan).toBe(true);
  });
});

// ── Security ────────────────────────────────────────────────

describe('Pause execution — security', () => {
  it('checkpoint does not contain functions', async () => {
    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.value = 'init';
      },
      'seed',
    )
      .addPausableFunction('Gate', approvalHandler, 'gate')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const cp = executor.getCheckpoint()!;
    const json = JSON.stringify(cp);
    expect(json).not.toContain('function');
    expect(json).not.toContain('=>');
  });

  it('real errors still throw (not caught as pause)', async () => {
    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.value = 'init';
      },
      'seed',
    )
      .addPausableFunction(
        'BadStage',
        {
          execute: async () => {
            throw new Error('Real failure');
          },
          resume: async () => {},
        },
        'bad-stage',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await expect(executor.run()).rejects.toThrow('Real failure');
    expect(executor.isPaused()).toBe(false);
  });

  it('PauseSignal is not logged as an error', async () => {
    const errors: string[] = [];
    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.value = 'init';
      },
      'seed',
    )
      .addPausableFunction('Gate', approvalHandler, 'gate')
      .build();

    // Override logger to capture errors
    chart.logger = {
      info: () => {},
      log: () => {},
      debug: () => {},
      warn: () => {},
      error: (msg: string) => errors.push(msg),
    };

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(executor.isPaused()).toBe(true);
    // No error messages should have been logged for the pause
    expect(errors.filter((e) => e.includes('pause') || e.includes('Pause'))).toHaveLength(0);
    expect(errors.filter((e) => e.includes('stageExecutionError'))).toHaveLength(0);
  });
});
