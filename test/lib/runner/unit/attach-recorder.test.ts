/**
 * Tests for FlowChartExecutor.attachRecorder() — scope recorder attachment API.
 *
 * Verifies that scope recorders (MetricRecorder, DebugRecorder, custom) can be
 * attached to the executor with a one-liner, eliminating the need for custom
 * scopeFactory boilerplate.
 */
import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/lib/builder';
import { FlowChartExecutor } from '../../../../src/lib/runner';
import { DebugRecorder, MetricRecorder } from '../../../../src/lib/scope';
import type { Recorder } from '../../../../src/lib/scope/types';

function buildSimpleChart() {
  return flowChart(
    'Seed',
    (scope) => {
      scope.setValue('x', 1);
    },
    'seed',
  )
    .addFunction(
      'Process',
      (scope) => {
        const x = scope.getValue('x') as number;
        scope.setValue('y', x + 1);
      },
      'process',
    )
    .build();
}

describe('FlowChartExecutor.attachRecorder()', () => {
  it('MetricRecorder receives read/write events without custom scopeFactory', async () => {
    const chart = buildSimpleChart();
    const executor = new FlowChartExecutor(chart);
    const metrics = new MetricRecorder();

    executor.attachRecorder(metrics);
    await executor.run();

    const summary = metrics.getMetrics();
    expect(summary.totalWrites).toBeGreaterThanOrEqual(2); // x, y
    expect(summary.totalReads).toBeGreaterThanOrEqual(1); // x
  });

  it('DebugRecorder captures entries without custom scopeFactory', async () => {
    const chart = buildSimpleChart();
    const executor = new FlowChartExecutor(chart);
    const debug = new DebugRecorder({ verbosity: 'verbose' });

    executor.attachRecorder(debug);
    await executor.run();

    const entries = debug.getEntries();
    expect(entries.length).toBeGreaterThan(0);
    // DebugEntry.data contains { key, value }
    expect(entries.some((e) => e.type === 'write' && (e.data as any).key === 'x')).toBe(true);
  });

  it('custom Recorder receives onWrite/onRead hooks', async () => {
    const chart = buildSimpleChart();
    const executor = new FlowChartExecutor(chart);

    const writes: string[] = [];
    const reads: string[] = [];
    const custom: Recorder = {
      id: 'test-custom',
      onWrite(event) {
        writes.push(event.key);
      },
      onRead(event) {
        reads.push(event.key);
      },
    };

    executor.attachRecorder(custom);
    await executor.run();

    expect(writes).toContain('x');
    expect(writes).toContain('y');
    expect(reads).toContain('x');
  });

  it('multiple recorders all receive events', async () => {
    const chart = buildSimpleChart();
    const executor = new FlowChartExecutor(chart);

    const metrics = new MetricRecorder();
    const debug = new DebugRecorder({ verbosity: 'verbose' });

    executor.attachRecorder(metrics);
    executor.attachRecorder(debug);
    await executor.run();

    expect(metrics.getMetrics().totalWrites).toBeGreaterThanOrEqual(2);
    expect(debug.getEntries().length).toBeGreaterThan(0);
  });

  it('works alongside setEnableNarrative()', async () => {
    const chart = flowChart(
      'Seed',
      (scope) => {
        scope.setValue('x', 1);
      },
      'seed',
    )
      .setEnableNarrative()
      .build();

    const executor = new FlowChartExecutor(chart);
    const metrics = new MetricRecorder();
    executor.attachRecorder(metrics);

    await executor.run();

    // Narrative still works
    const narrative = executor.getNarrative();
    expect(narrative.length).toBeGreaterThan(0);
    // MetricRecorder also got events
    expect(metrics.getMetrics().totalWrites).toBeGreaterThanOrEqual(1);
  });

  it('works alongside attachFlowRecorder()', async () => {
    const chart = buildSimpleChart();
    const executor = new FlowChartExecutor(chart);
    const metrics = new MetricRecorder();

    const flowEvents: string[] = [];
    executor.attachRecorder(metrics);
    executor.attachFlowRecorder({
      id: 'test-flow',
      onStageExecuted(event) {
        flowEvents.push(event.stageName);
      },
    });

    await executor.run();

    expect(metrics.getMetrics().totalWrites).toBeGreaterThanOrEqual(2);
    expect(flowEvents).toContain('Seed');
    expect(flowEvents).toContain('Process');
  });

  it('works alongside redaction policy', async () => {
    const chart = flowChart(
      'Seed',
      (scope) => {
        scope.setValue('ssn', '123-45-6789');
        scope.setValue('name', 'Alice');
      },
      'seed',
    ).build();

    const executor = new FlowChartExecutor(chart);
    const debug = new DebugRecorder({ verbosity: 'verbose' });

    executor.attachRecorder(debug);
    executor.setRedactionPolicy({ keys: ['ssn'] });
    await executor.run();

    const entries = debug.getEntries();
    const ssnEntry = entries.find((e) => e.type === 'write' && (e.data as any).key === 'ssn');
    // Redacted value should not contain the raw SSN
    expect(ssnEntry).toBeDefined();
    expect(String((ssnEntry!.data as any).value)).not.toContain('123-45-6789');
  });

  it('detachRecorder removes by ID', () => {
    const chart = buildSimpleChart();
    const executor = new FlowChartExecutor(chart);
    const metrics = new MetricRecorder();

    executor.attachRecorder(metrics);
    expect(executor.getRecorders()).toHaveLength(1);

    executor.detachRecorder(metrics.id);
    expect(executor.getRecorders()).toHaveLength(0);
  });

  it('getRecorders returns defensive copy', () => {
    const chart = buildSimpleChart();
    const executor = new FlowChartExecutor(chart);
    const metrics = new MetricRecorder();

    executor.attachRecorder(metrics);
    const copy = executor.getRecorders();
    copy.length = 0; // mutate the copy

    expect(executor.getRecorders()).toHaveLength(1); // original unchanged
  });
});
