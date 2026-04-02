/**
 * Tests for onCommit wiring — verifies that Recorder.onCommit fires after
 * StageContext.commit() applies patches.
 *
 * The fix: StageContext.commit() calls a registered observer. ScopeFacade
 * registers in its constructor and dispatches to Recorder.onCommit.
 *
 * Coverage: unit, boundary, scenario, property, security.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/lib/builder';
import { FlowChartExecutor } from '../../../../src/lib/runner';
import type { CommitEvent, Recorder } from '../../../../src/lib/scope/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

interface TestState {
  name?: string;
  count?: number;
  items?: string[];
}

function createCommitCounter(id = 'commit-counter') {
  const commits: CommitEvent[] = [];
  const recorder: Recorder = {
    id,
    onCommit(event: CommitEvent) {
      commits.push(event);
    },
  };
  return { recorder, commits };
}

// ── Unit: MetricRecorder.commitCount is 1 after a stage commits ─────────────

describe('onCommit wiring — unit', () => {
  it('onCommit fires once per stage commit', async () => {
    const { recorder, commits } = createCommitCounter();
    const chart = flowChart<TestState>(
      'Init',
      (scope) => {
        scope.name = 'Alice';
      },
      'init',
    ).build();

    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(recorder);
    await executor.run();

    // One stage = one commit
    expect(commits).toHaveLength(1);
    expect(commits[0].stageName).toBe('Init');
    expect(commits[0].mutations).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'name', value: 'Alice', operation: 'set' })]),
    );
  });

  it('onCommit carries correct pipelineId', async () => {
    const { recorder, commits } = createCommitCounter();
    const chart = flowChart<TestState>(
      'Init',
      (scope) => {
        scope.count = 42;
      },
      'init',
    ).build();

    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(recorder);
    await executor.run();

    expect(commits[0].pipelineId).toBeDefined();
    expect(typeof commits[0].pipelineId).toBe('string');
  });

  it('onCommit distinguishes set, update, and delete operations', async () => {
    const { recorder, commits } = createCommitCounter();
    const chart = flowChart<TestState>(
      'Init',
      (scope) => {
        scope.name = 'Alice'; // set
        scope.count = 10; // set
      },
      'init',
    )
      .addFunction(
        'Mutate',
        (scope) => {
          scope.$update('name', 'Bob'); // update
          scope.$delete('count'); // delete
        },
        'mutate',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(recorder);
    await executor.run();

    expect(commits).toHaveLength(2);

    // Init stage: two sets
    const initMutations = commits[0].mutations;
    expect(initMutations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'name', operation: 'set' }),
        expect.objectContaining({ key: 'count', operation: 'set' }),
      ]),
    );

    // Mutate stage: one update, one delete
    const mutateMutations = commits[1].mutations;
    const updateMutation = mutateMutations.find((m) => m.key === 'name');
    const deleteMutation = mutateMutations.find((m) => m.key === 'count');

    expect(updateMutation).toBeDefined();
    expect(updateMutation!.operation).toBe('update');

    expect(deleteMutation).toBeDefined();
    expect(deleteMutation!.operation).toBe('delete');
    expect(deleteMutation!.value).toBeUndefined();
  });
});

// ── Boundary: stage with no writes — onCommit fires with empty mutations ────

describe('onCommit wiring — boundary', () => {
  it('stage with no writes: onCommit fires with empty mutations', async () => {
    const { recorder, commits } = createCommitCounter();
    const chart = flowChart<TestState>(
      'NoOp',
      (_scope) => {
        // No writes
      },
      'noop',
    ).build();

    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(recorder);
    await executor.run();

    // Commit still fires (stage execution always commits)
    expect(commits).toHaveLength(1);
    expect(commits[0].mutations).toHaveLength(0);
  });

  it('stage with only reads: onCommit fires with empty mutations', async () => {
    const { recorder, commits } = createCommitCounter();
    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.name = 'Bob';
      },
      'seed',
    )
      .addFunction(
        'ReadOnly',
        (scope) => {
          const _name = scope.name; // read only, no writes
        },
        'read-only',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(recorder);
    await executor.run();

    // Two stages, two commits
    expect(commits).toHaveLength(2);
    // Seed had a write
    expect(commits[0].stageName).toBe('Seed');
    expect(commits[0].mutations.length).toBeGreaterThan(0);
    // ReadOnly had no writes
    expect(commits[1].stageName).toBe('ReadOnly');
    expect(commits[1].mutations).toHaveLength(0);
  });
});

// ── Scenario: multi-stage flow — commit counts per stage are accurate ───────

describe('onCommit wiring — scenario', () => {
  it('multi-stage flow: each stage fires one onCommit', async () => {
    const { recorder, commits } = createCommitCounter();
    const chart = flowChart<TestState>(
      'Stage1',
      (scope) => {
        scope.name = 'A';
      },
      'stage-1',
    )
      .addFunction(
        'Stage2',
        (scope) => {
          scope.count = 1;
        },
        'stage-2',
      )
      .addFunction(
        'Stage3',
        (scope) => {
          scope.items = ['x'];
        },
        'stage-3',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(recorder);
    await executor.run();

    expect(commits).toHaveLength(3);
    expect(commits[0].stageName).toBe('Stage1');
    expect(commits[1].stageName).toBe('Stage2');
    expect(commits[2].stageName).toBe('Stage3');
  });

  it('MetricRecorder tracks commit counts correctly', async () => {
    const { metrics } = await import('../../../../src/recorders');
    const m = metrics();

    const chart = flowChart<TestState>(
      'A',
      (scope) => {
        scope.name = 'x';
      },
      'a',
    )
      .addFunction(
        'B',
        (scope) => {
          scope.count = 1;
        },
        'b',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(m);
    await executor.run();

    expect(m.commits()).toBe(2);
    expect(m.stage('A')?.commitCount).toBe(1);
    expect(m.stage('B')?.commitCount).toBe(1);
  });
});

// ── Property: N writes → 1 onCommit call (not N) ───────────────────────────

describe('onCommit wiring — property', () => {
  it('for any number of writes, exactly 1 onCommit per stage', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 20 }), async (numWrites) => {
        const { recorder, commits } = createCommitCounter();
        const chart = flowChart<TestState>(
          'Writer',
          (scope) => {
            for (let i = 0; i < numWrites; i++) {
              scope.$setValue(`key_${i}`, `value_${i}`);
            }
          },
          'writer',
        ).build();

        const executor = new FlowChartExecutor(chart);
        executor.attachRecorder(recorder);
        await executor.run();

        // Always exactly 1 commit per stage, regardless of write count
        return commits.length === 1 && commits[0].mutations.length === numWrites;
      }),
      { numRuns: 15 },
    );
  });
});

// ── Security: redacted mutations have '[REDACTED]' values in CommitEvent ────

describe('onCommit wiring — security', () => {
  it('redacted keys have [REDACTED] values in CommitEvent mutations', async () => {
    const { recorder, commits } = createCommitCounter();
    const chart = flowChart<{ secret?: string; public?: string }>(
      'Init',
      (scope) => {
        scope.$setValue('secret', 'my-password', true); // redacted
        scope.public = 'visible';
      },
      'init',
    ).build();

    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(recorder);
    await executor.run();

    expect(commits).toHaveLength(1);
    const secretMutation = commits[0].mutations.find((m) => m.key === 'secret');
    const publicMutation = commits[0].mutations.find((m) => m.key === 'public');

    expect(secretMutation).toBeDefined();
    expect(secretMutation!.value).toBe('[REDACTED]');

    expect(publicMutation).toBeDefined();
    expect(publicMutation!.value).toBe('visible');
  });

  it('policy-redacted keys are also redacted in CommitEvent', async () => {
    const { recorder, commits } = createCommitCounter();
    const chart = flowChart<{ ssn?: string; name?: string }>(
      'Init',
      (scope) => {
        scope.ssn = '123-45-6789';
        scope.name = 'Alice';
      },
      'init',
    ).build();

    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(recorder);
    executor.setRedactionPolicy({ keys: ['ssn'] });
    await executor.run();

    expect(commits).toHaveLength(1);
    const ssnMutation = commits[0].mutations.find((m) => m.key === 'ssn');
    expect(ssnMutation).toBeDefined();
    expect(ssnMutation!.value).toBe('[REDACTED]');

    const nameMutation = commits[0].mutations.find((m) => m.key === 'name');
    expect(nameMutation).toBeDefined();
    expect(nameMutation!.value).toBe('Alice');
  });

  it('policy-redacted keys updated via $update are redacted in CommitEvent and snapshot', async () => {
    const { recorder, commits } = createCommitCounter();
    const chart = flowChart<{ ssn?: string; name?: string }>(
      'Seed',
      (scope) => {
        scope.ssn = '000-00-0000';
        scope.name = 'Alice';
      },
      'seed',
    )
      .addFunction(
        'Update',
        (scope) => {
          scope.$update('ssn', '123-45-6789');
          scope.$update('name', 'Bob');
        },
        'update',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(recorder);
    executor.setRedactionPolicy({ keys: ['ssn'] });
    await executor.run();

    // Verify the Update stage commit has redacted ssn
    expect(commits).toHaveLength(2);
    const updateCommit = commits[1];
    expect(updateCommit.stageName).toBe('Update');

    const ssnMutation = updateCommit.mutations.find((m) => m.key === 'ssn');
    expect(ssnMutation).toBeDefined();
    expect(ssnMutation!.value).toBe('[REDACTED]');
    expect(ssnMutation!.operation).toBe('update');

    const nameMutation = updateCommit.mutations.find((m) => m.key === 'name');
    expect(nameMutation).toBeDefined();
    expect(nameMutation!.value).toBe('Bob');

    // Verify snapshot also redacts the updated key
    const snapshot = executor.getSnapshot();
    const updateStage = snapshot.executionTree.next; // second stage
    expect(updateStage?.name).toBe('Update');
    if (updateStage?.stageWrites) {
      expect(updateStage.stageWrites.ssn).toBe('[REDACTED]');
      expect(updateStage.stageWrites.name).toBe('Bob');
    }
  });
});
