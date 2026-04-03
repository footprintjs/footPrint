/**
 * executor.resume() — 5-pattern tests.
 *
 * Tests resuming a paused flowchart from a checkpoint.
 * Flow: run() pauses → getCheckpoint() → resume(checkpoint, input) → continues.
 */
import { describe, expect, it } from 'vitest';

import type { PausableHandler } from '../../../src';
import { flowChart, FlowChartExecutor } from '../../../src';

// ── Helpers ─────────────────────────────────────────────────

interface TestState {
  value: string;
  approved?: boolean;
  step?: number;
  approver?: string;
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

describe('executor.resume() — unit', () => {
  it('resume calls resumeFn and continues to next stages', async () => {
    const executedStages: string[] = [];

    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        executedStages.push('seed');
        scope.value = 'init';
      },
      'seed',
    )
      .addPausableFunction(
        'Approve',
        {
          execute: async (scope) => {
            executedStages.push('approve-execute');
            scope.value = 'pending';
            return { pause: true, data: { question: 'OK?' } };
          },
          resume: async (scope, input) => {
            executedStages.push('approve-resume');
            scope.approved = (input as any).approved;
          },
        },
        'approve',
      )
      .addFunction(
        'Process',
        (scope) => {
          executedStages.push('process');
          scope.value = 'done';
        },
        'process',
      )
      .build();

    // First run — pauses
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(executor.isPaused()).toBe(true);
    executedStages.length = 0; // reset

    // Resume
    const checkpoint = executor.getCheckpoint()!;
    await executor.resume(checkpoint, { approved: true });

    expect(executor.isPaused()).toBe(false);
    expect(executedStages).toEqual(['approve-resume', 'process']);
  });

  it('resume restores sharedState from checkpoint', async () => {
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
            return { pause: true };
          },
          resume: async (scope) => {
            // After resume, scope should have the checkpoint's state
            scope.step = 3;
          },
        },
        'approve',
      )
      .addFunction(
        'Final',
        (scope) => {
          scope.value = `final-step-${scope.$getValue('step')}`;
        },
        'final',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const checkpoint = executor.getCheckpoint()!;
    expect(checkpoint.sharedState.step).toBe(2);

    await executor.resume(checkpoint);

    const snapshot = executor.getSnapshot();
    expect(snapshot.sharedState.step).toBe(3);
  });

  it('resume input is passed to resumeFn as 2nd argument', async () => {
    let receivedInput: unknown;

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
          execute: async () => ({ pause: true }),
          resume: async (_scope, input) => {
            receivedInput = input;
          },
        },
        'gate',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    await executor.resume(executor.getCheckpoint()!, { approved: true, note: 'LGTM' });
    expect(receivedInput).toEqual({ approved: true, note: 'LGTM' });
  });

  it('checkpoint.pausedStageId and subflowPath are populated', async () => {
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
    expect(cp.pausedStageId).toBe('gate');
    expect(cp.subflowPath).toEqual([]);
  });
});

// ── Boundary ────────────────────────────────────────────────

describe('executor.resume() — boundary', () => {
  it('resume with no input (undefined)', async () => {
    let resumeCalled = false;

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
          execute: async () => ({ pause: true }),
          resume: async () => {
            resumeCalled = true;
          },
        },
        'gate',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    // Resume with no input
    await executor.resume(executor.getCheckpoint()!);
    expect(resumeCalled).toBe(true);
  });

  it('resume throws if stage not found in chart', async () => {
    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.value = 'init';
      },
      'seed',
    ).build();

    const executor = new FlowChartExecutor(chart);
    const fakeCheckpoint = {
      sharedState: {},
      executionTree: {},
      pausedStageId: 'nonexistent-stage',
      subflowPath: [],
      pausedAt: Date.now(),
    };

    await expect(executor.resume(fakeCheckpoint)).rejects.toThrow('not found in flowchart');
  });

  it('resume throws if stage has no resumeFn', async () => {
    // Create a chart with a regular (non-pausable) stage
    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.value = 'init';
      },
      'seed',
    )
      .addFunction('Regular', () => {}, 'regular')
      .build();

    const executor = new FlowChartExecutor(chart);
    const fakeCheckpoint = {
      sharedState: {},
      executionTree: {},
      pausedStageId: 'regular',
      subflowPath: [],
      pausedAt: Date.now(),
    };

    await expect(executor.resume(fakeCheckpoint)).rejects.toThrow('no resumeFn');
  });

  it('resume from a serialized (JSON round-tripped) checkpoint', async () => {
    let resumeRan = false;

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
          execute: async () => ({ pause: true, data: { q: 'ok?' } }),
          resume: async () => {
            resumeRan = true;
          },
        },
        'gate',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    // Simulate persistence: serialize and deserialize
    const json = JSON.stringify(executor.getCheckpoint()!);
    const restored = JSON.parse(json);

    // Resume from deserialized checkpoint (possibly on a different executor)
    const executor2 = new FlowChartExecutor(chart);
    await executor2.resume(restored);
    expect(resumeRan).toBe(true);
  });
});

// ── Scenario ────────────────────────────────────────────────

describe('executor.resume() — scenario', () => {
  it('full approval pipeline: seed → prepare → approve(pause) → resume → process → notify', async () => {
    const executedStages: string[] = [];

    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        executedStages.push('seed');
        scope.value = 'order-789';
      },
      'seed',
    )
      .addFunction(
        'Prepare',
        (scope) => {
          executedStages.push('prepare');
          scope.step = 1;
        },
        'prepare',
      )
      .addPausableFunction(
        'Approve',
        {
          execute: async (scope) => {
            executedStages.push('approve-exec');
            scope.step = 2;
            return { pause: true, data: { question: `Approve order ${scope.$getValue('value')}?` } };
          },
          resume: async (scope, input) => {
            executedStages.push('approve-resume');
            scope.approved = (input as any).approved;
            scope.approver = (input as any).approver;
          },
        },
        'approve',
      )
      .addFunction(
        'Process',
        (scope) => {
          executedStages.push('process');
          scope.step = 3;
        },
        'process',
      )
      .addFunction(
        'Notify',
        (scope) => {
          executedStages.push('notify');
          scope.value = 'completed';
        },
        'notify',
      )
      .build();

    // Phase 1: Run until pause
    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(executor.isPaused()).toBe(true);
    expect(executedStages).toEqual(['seed', 'prepare', 'approve-exec']);
    const cp = executor.getCheckpoint()!;
    expect(cp.pauseData).toEqual({ question: 'Approve order order-789?' });

    // Phase 2: Resume with approval
    executedStages.length = 0;
    await executor.resume(cp, { approved: true, approver: 'Jane' });

    expect(executor.isPaused()).toBe(false);
    expect(executedStages).toEqual(['approve-resume', 'process', 'notify']);

    const final = executor.getSnapshot();
    expect(final.sharedState.approved).toBe(true);
    expect(final.sharedState.approver).toBe('Jane');
    expect(final.sharedState.value).toBe('completed');
    expect(final.sharedState.step).toBe(3);
  });

  it('double pause: approve → resume → review(pause) → resume → done', async () => {
    const stages: string[] = [];

    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        stages.push('seed');
        scope.value = 'init';
      },
      'seed',
    )
      .addPausableFunction(
        'Approve',
        {
          execute: async () => {
            stages.push('approve-exec');
            return { pause: true, data: 'approve?' };
          },
          resume: async (scope, input) => {
            stages.push('approve-resume');
            scope.approved = (input as any).yes;
          },
        },
        'approve',
      )
      .addPausableFunction(
        'Review',
        {
          execute: async () => {
            stages.push('review-exec');
            return { pause: true, data: 'review?' };
          },
          resume: async (scope, input) => {
            stages.push('review-resume');
            scope.value = (input as any).verdict;
          },
        },
        'review',
      )
      .addFunction(
        'Done',
        (scope) => {
          stages.push('done');
          scope.value = `final: ${scope.$getValue('value')}`;
        },
        'done',
      )
      .build();

    const executor = new FlowChartExecutor(chart);

    // Run → first pause at approve
    await executor.run();
    expect(executor.isPaused()).toBe(true);
    expect(executor.getCheckpoint()!.pausedStageId).toBe('approve');
    stages.length = 0;

    // Resume approve → second pause at review
    const cp1 = executor.getCheckpoint()!;
    await executor.resume(cp1, { yes: true });
    expect(executor.isPaused()).toBe(true);
    expect(executor.getCheckpoint()!.pausedStageId).toBe('review');
    expect(stages).toEqual(['approve-resume', 'review-exec']);
    stages.length = 0;

    // Resume review → done
    const cp2 = executor.getCheckpoint()!;
    await executor.resume(cp2, { verdict: 'approved' });
    expect(executor.isPaused()).toBe(false);
    expect(stages).toEqual(['review-resume', 'done']);

    const final = executor.getSnapshot();
    expect(final.sharedState.value).toBe('final: approved');
  });
});

// ── Property ────────────────────────────────────────────────

describe('executor.resume() — property', () => {
  it('sharedState from checkpoint is accessible in resume and subsequent stages', async () => {
    const observedValues: string[] = [];

    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.value = 'seed-value';
      },
      'seed',
    )
      .addPausableFunction(
        'Gate',
        {
          execute: async () => ({ pause: true }),
          resume: async (scope) => {
            observedValues.push(scope.$getValue('value') as string);
          },
        },
        'gate',
      )
      .addFunction(
        'Post',
        (scope) => {
          observedValues.push(scope.$getValue('value') as string);
        },
        'post',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    await executor.resume(executor.getCheckpoint()!);

    // Both the resume fn and the post stage should see the checkpointed value
    expect(observedValues).toEqual(['seed-value', 'seed-value']);
  });

  it('resume preserves writes from resumeFn in subsequent stages', async () => {
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
          execute: async () => ({ pause: true }),
          resume: async (scope) => {
            scope.value = 'resumed-value';
          },
        },
        'gate',
      )
      .addFunction(
        'Check',
        (scope) => {
          scope.step = scope.$getValue('value') === 'resumed-value' ? 99 : 0;
        },
        'check',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    await executor.resume(executor.getCheckpoint()!);

    const snapshot = executor.getSnapshot();
    expect(snapshot.sharedState.value).toBe('resumed-value');
    expect(snapshot.sharedState.step).toBe(99);
  });
});

// ── Security ────────────────────────────────────────────────

describe('executor.resume() — security', () => {
  it('checkpoint with invalid sharedState throws', async () => {
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

    await expect(
      executor.resume({ sharedState: null as any, pausedStageId: 'gate', subflowPath: [], pausedAt: 0 }),
    ).rejects.toThrow('sharedState must be a plain object');

    await expect(
      executor.resume({ sharedState: 'string' as any, pausedStageId: 'gate', subflowPath: [], pausedAt: 0 }),
    ).rejects.toThrow('sharedState must be a plain object');

    await expect(
      executor.resume({ sharedState: [1, 2] as any, pausedStageId: 'gate', subflowPath: [], pausedAt: 0 }),
    ).rejects.toThrow('sharedState must be a plain object');
  });

  it('checkpoint with invalid pausedStageId throws', async () => {
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

    await expect(
      executor.resume({ sharedState: {}, pausedStageId: '' as any, subflowPath: [], pausedAt: 0 }),
    ).rejects.toThrow('pausedStageId must be a non-empty string');

    await expect(
      executor.resume({ sharedState: {}, pausedStageId: 123 as any, subflowPath: [], pausedAt: 0 }),
    ).rejects.toThrow('pausedStageId must be a non-empty string');
  });

  it('checkpoint with invalid subflowPath throws', async () => {
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

    await expect(
      executor.resume({ sharedState: {}, pausedStageId: 'gate', subflowPath: 'bad' as any, pausedAt: 0 }),
    ).rejects.toThrow('subflowPath must be an array of strings');

    await expect(
      executor.resume({ sharedState: {}, pausedStageId: 'gate', subflowPath: [123] as any, pausedAt: 0 }),
    ).rejects.toThrow('subflowPath must be an array of strings');
  });

  it('tampered checkpoint with unknown stageId throws clear error', async () => {
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
    // Tamper with the checkpoint
    const tampered = { ...cp, pausedStageId: 'hacked-stage' };

    await expect(executor.resume(tampered)).rejects.toThrow('not found in flowchart');
  });

  it('errors in resumeFn propagate normally (not swallowed)', async () => {
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
          execute: async () => ({ pause: true }),
          resume: async () => {
            throw new Error('Resume failed!');
          },
        },
        'gate',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    await expect(executor.resume(executor.getCheckpoint()!)).rejects.toThrow('Resume failed!');
    expect(executor.isPaused()).toBe(false);
  });
});
