/**
 * Resume continuity — 5-pattern tests.
 *
 * Tests that resume() continues from the existing runtime:
 * - Execution tree is continuous (pre-pause + resume + continuation)
 * - Narrative accumulates across pause/resume
 * - Snapshot reflects the full traversal path
 */
import { describe, expect, it } from 'vitest';

import type { PausableHandler } from '../../../src';
import { flowChart, FlowChartExecutor } from '../../../src';
import { MetricRecorder } from '../../../src/lib/scope/recorders/MetricRecorder';

// ── Helpers ─────────────────────────────────────────────────

interface TestState {
  value: string;
  approved?: boolean;
  step?: number;
  [key: string]: unknown;
}

function buildPipeline() {
  return flowChart<TestState>(
    'Receive',
    (scope) => {
      scope.value = 'received';
      scope.step = 1;
    },
    'receive',
  )
    .addPausableFunction(
      'Approve',
      {
        execute: async (scope) => {
          scope.step = 2;
          return { question: 'Approve?' };
        },
        resume: async (scope, input) => {
          scope.approved = (input as any)?.approved ?? true;
        },
      },
      'approve',
    )
    .addFunction(
      'Process',
      (scope) => {
        scope.step = 3;
        scope.value = 'processed';
      },
      'process',
    )
    .addFunction(
      'Notify',
      (scope) => {
        scope.step = 4;
        scope.value = 'notified';
      },
      'notify',
    )
    .build();
}

// Helper to walk execution tree and collect stage IDs
function collectTreeIds(node: any): string[] {
  const ids: string[] = [];
  let current = node;
  while (current) {
    if (current.id) ids.push(current.id);
    current = current.next;
  }
  return ids;
}

// ── Unit ────────────────────────────────────────────────────

describe('Resume continuity — unit', () => {
  it('execution tree after resume includes pre-pause AND post-resume stages', async () => {
    const chart = buildPipeline();
    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();

    await executor.run();
    const cp = executor.getCheckpoint()!;
    await executor.resume(cp, { approved: true });

    const snapshot = executor.getSnapshot();
    const stageIds = collectTreeIds(snapshot.executionTree);

    // Full path: receive → approve → (resume node) → process → notify
    expect(stageIds).toContain('receive');
    expect(stageIds).toContain('approve');
    expect(stageIds).toContain('process');
    expect(stageIds).toContain('notify');
  });

  it('narrative accumulates across pause/resume without duplication', async () => {
    const chart = buildPipeline();
    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();

    await executor.run();
    const pauseNarrative = executor.getNarrative();
    const pauseEntryCount = executor.getNarrativeEntries().length;

    const cp = executor.getCheckpoint()!;
    await executor.resume(cp, { approved: true });

    const fullNarrative = executor.getNarrative();
    const fullEntryCount = executor.getNarrativeEntries().length;

    // Full narrative is longer than pause-only narrative
    expect(fullNarrative.length).toBeGreaterThan(pauseNarrative.length);
    expect(fullEntryCount).toBeGreaterThan(pauseEntryCount);

    // No duplicates — pause entries appear once
    const pauseEntries = executor.getNarrativeEntries().filter((e) => e.type === 'pause');
    expect(pauseEntries).toHaveLength(1);
  });

  it('sharedState after resume reflects writes from ALL stages', async () => {
    const chart = buildPipeline();
    const executor = new FlowChartExecutor(chart);

    await executor.run();
    await executor.resume(executor.getCheckpoint()!, { approved: true });

    const snapshot = executor.getSnapshot();
    expect(snapshot.sharedState.value).toBe('notified');
    expect(snapshot.sharedState.step).toBe(4);
    expect(snapshot.sharedState.approved).toBe(true);
  });
});

// ── Boundary ────────────────────────────────────────────────

describe('Resume continuity — boundary', () => {
  it('double pause: execution tree shows all stages across both pauses', async () => {
    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.value = 'init';
      },
      'seed',
    )
      .addPausableFunction(
        'Gate1',
        {
          execute: async () => ({ q: 'first?' }),
          resume: async () => {},
        },
        'gate-1',
      )
      .addPausableFunction(
        'Gate2',
        {
          execute: async () => ({ q: 'second?' }),
          resume: async () => {},
        },
        'gate-2',
      )
      .addFunction(
        'Done',
        (scope) => {
          scope.value = 'done';
        },
        'done',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();

    // First pause
    await executor.run();
    expect(executor.getCheckpoint()!.pausedStageId).toBe('gate-1');

    // Resume → second pause
    await executor.resume(executor.getCheckpoint()!, {});
    expect(executor.getCheckpoint()!.pausedStageId).toBe('gate-2');

    // Resume → done
    await executor.resume(executor.getCheckpoint()!, {});
    expect(executor.isPaused()).toBe(false);

    const snapshot = executor.getSnapshot();
    const ids = collectTreeIds(snapshot.executionTree);
    expect(ids).toContain('seed');
    expect(ids).toContain('gate-1');
    expect(ids).toContain('gate-2');
    expect(ids).toContain('done');
  });

  it('resume with no next stage (pause is last stage)', async () => {
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
          execute: async () => ({ q: 'last?' }),
          resume: async (scope) => {
            scope.value = 'resumed';
          },
        },
        'gate',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    await executor.resume(executor.getCheckpoint()!, {});

    expect(executor.isPaused()).toBe(false);
    const snapshot = executor.getSnapshot();
    expect(snapshot.sharedState.value).toBe('resumed');

    const ids = collectTreeIds(snapshot.executionTree);
    expect(ids).toContain('seed');
    expect(ids).toContain('gate');
  });
});

// ── Scenario ────────────────────────────────────────────────

describe('Resume continuity — scenario', () => {
  it('full refund pipeline: receive → approve(pause) → resume → process → notify', async () => {
    const chart = buildPipeline();
    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();

    // Phase 1: run until pause
    await executor.run();
    expect(executor.isPaused()).toBe(true);

    // Verify partial tree
    const partialIds = collectTreeIds(executor.getSnapshot().executionTree);
    expect(partialIds).toContain('receive');
    expect(partialIds).toContain('approve');
    expect(partialIds).not.toContain('process');

    // Phase 2: resume
    await executor.resume(executor.getCheckpoint()!, { approved: true });

    // Verify full tree
    const fullIds = collectTreeIds(executor.getSnapshot().executionTree);
    expect(fullIds).toContain('receive');
    expect(fullIds).toContain('approve');
    expect(fullIds).toContain('process');
    expect(fullIds).toContain('notify');

    // Narrative shows full journey
    const entries = executor.getNarrativeEntries();
    const types = entries.map((e) => e.type);
    expect(types).toContain('pause');
    expect(types).toContain('resume');
    expect(types).toContain('stage');
  });
});

// ── Property ────────────────────────────────────────────────

describe('Resume continuity — property', () => {
  it('metrics accumulate across pause/resume', async () => {
    const chart = buildPipeline();
    const recorder = new MetricRecorder('test');
    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(recorder);

    await executor.run();

    const pauseMetrics = recorder.getMetrics();
    const pauseWrites = pauseMetrics.totalWrites;
    expect(pauseWrites).toBeGreaterThan(0);

    await executor.resume(executor.getCheckpoint()!, { approved: true });

    const fullMetrics = recorder.getMetrics();
    // More writes after resume (Process and Notify stages write)
    expect(fullMetrics.totalWrites).toBeGreaterThan(pauseWrites);
    expect(fullMetrics.totalPauses).toBe(1);
  });

  it('execution tree order matches traversal order', async () => {
    const chart = buildPipeline();
    const executor = new FlowChartExecutor(chart);

    await executor.run();
    await executor.resume(executor.getCheckpoint()!, { approved: true });

    const ids = collectTreeIds(executor.getSnapshot().executionTree);
    // receive comes before approve, approve before process, etc.
    const receiveIdx = ids.indexOf('receive');
    const approveIdx = ids.indexOf('approve');
    const processIdx = ids.indexOf('process');
    const notifyIdx = ids.indexOf('notify');

    expect(receiveIdx).toBeLessThan(approveIdx);
    expect(approveIdx).toBeLessThan(processIdx);
    expect(processIdx).toBeLessThan(notifyIdx);
  });
});

// ── Security ────────────────────────────────────────────────

describe('Resume continuity — security', () => {
  it('pre-pause state is not leaked after resume replaces values', async () => {
    const chart = flowChart<TestState>(
      'Seed',
      (scope) => {
        scope.value = 'secret-token-abc';
      },
      'seed',
    )
      .addPausableFunction(
        'Gate',
        {
          execute: async () => ({ q: 'ok?' }),
          resume: async (scope) => {
            scope.value = 'redacted'; // overwrite sensitive data on resume
          },
        },
        'gate',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    await executor.resume(executor.getCheckpoint()!, {});

    const snapshot = executor.getSnapshot();
    // Final state should have the overwritten value, not the original secret
    expect(snapshot.sharedState.value).toBe('redacted');
  });
});
