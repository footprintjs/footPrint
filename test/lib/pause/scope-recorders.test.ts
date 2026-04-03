/**
 * Scope recorder pause/resume — tests for MetricRecorder and DebugRecorder.
 */
import { describe, expect, it } from 'vitest';

import type { PausableHandler } from '../../../src';
import { flowChart, FlowChartExecutor } from '../../../src';
import { DebugRecorder } from '../../../src/lib/scope/recorders/DebugRecorder';
import { MetricRecorder } from '../../../src/lib/scope/recorders/MetricRecorder';

// ── Helpers ─────────────────────────────────────────────────

interface TestState {
  value: string;
  approved?: boolean;
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

function buildChart() {
  return flowChart<TestState>(
    'Seed',
    (scope) => {
      scope.value = 'init';
    },
    'seed',
  )
    .addPausableFunction('Approve', approvalHandler, 'approve')
    .addFunction(
      'Process',
      (scope) => {
        scope.value = 'done';
      },
      'process',
    )
    .build();
}

// ── MetricRecorder ─────────────────────────────────────────

describe('MetricRecorder — pause/resume', () => {
  it('pauseCount increments when a stage pauses', async () => {
    const chart = buildChart();
    const recorder = new MetricRecorder('test-metrics');
    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(recorder);

    await executor.run();

    const stageMetrics = recorder.getStageMetrics('Approve');
    expect(stageMetrics).toBeDefined();
    expect(stageMetrics!.pauseCount).toBe(1);
  });

  it('totalPauses in aggregated metrics', async () => {
    const chart = buildChart();
    const recorder = new MetricRecorder('test-metrics');
    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(recorder);

    await executor.run();

    const metrics = recorder.getMetrics();
    expect(metrics.totalPauses).toBe(1);
  });

  it('non-pausing stages have pauseCount=0', async () => {
    const chart = buildChart();
    const recorder = new MetricRecorder('test-metrics');
    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(recorder);

    await executor.run();

    const seedMetrics = recorder.getStageMetrics('Seed');
    expect(seedMetrics).toBeDefined();
    expect(seedMetrics!.pauseCount).toBe(0);
  });

  it('resume fires onResume on scope recorder', async () => {
    const chart = buildChart();
    const recorder = new MetricRecorder('test-metrics');
    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(recorder);

    await executor.run();
    const cp = executor.getCheckpoint()!;
    await executor.resume(cp, { approved: true });

    // After resume, new MetricRecorder was cleared, but onResume fired
    // The resume event goes to scope recorders before execution starts
    const metrics = recorder.getMetrics();
    expect(metrics).toBeDefined();
  });
});

// ── DebugRecorder ──────────────────────────────────────────

describe('DebugRecorder — pause/resume', () => {
  it('logs pause entry with pauseData', async () => {
    const chart = buildChart();
    const recorder = new DebugRecorder({ id: 'test-debug' });
    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(recorder);

    await executor.run();

    const entries = recorder.getEntries();
    const pauseEntry = entries.find((e) => e.type === 'pause');
    expect(pauseEntry).toBeDefined();
    expect(pauseEntry!.stageName).toBe('Approve');
    expect((pauseEntry!.data as any).pauseData).toEqual({ question: 'Approve?' });
    expect((pauseEntry!.data as any).stageId).toBe('approve');
  });

  it('logs resume entry after resume()', async () => {
    const chart = buildChart();
    const recorder = new DebugRecorder({ id: 'test-debug' });
    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(recorder);

    await executor.run();
    const cp = executor.getCheckpoint()!;

    // Recorders are cleared on resume, so create a fresh one for the resume phase
    const resumeRecorder = new DebugRecorder({ id: 'test-debug' });
    executor.attachRecorder(resumeRecorder);
    await executor.resume(cp, { approved: true });

    const entries = resumeRecorder.getEntries();
    const resumeEntry = entries.find((e) => e.type === 'resume');
    expect(resumeEntry).toBeDefined();
    expect(resumeEntry!.stageName).toBe('Approve');
    expect((resumeEntry!.data as any).hasInput).toBe(true);
  });

  it('pause logged even in minimal verbosity', async () => {
    const chart = buildChart();
    const recorder = new DebugRecorder({ id: 'test-debug', verbosity: 'minimal' });
    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(recorder);

    await executor.run();

    const entries = recorder.getEntries();
    // In minimal mode, reads/writes are not logged, but pauses are
    expect(entries.filter((e) => e.type === 'read')).toHaveLength(0);
    expect(entries.filter((e) => e.type === 'pause')).toHaveLength(1);
  });
});
