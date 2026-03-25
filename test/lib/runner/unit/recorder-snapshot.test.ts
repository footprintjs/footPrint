/**
 * Unit tests for recorder snapshot auto-detection in getSnapshot().
 *
 * Validates that FlowChartExecutor.getSnapshot() collects data from
 * FlowRecorders that implement toSnapshot(), enabling UI auto-discovery.
 */

import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/lib/builder/index.js';
import { ManifestFlowRecorder } from '../../../../src/lib/engine/narrative/recorders/ManifestFlowRecorder.js';
import type { FlowRecorder } from '../../../../src/lib/engine/narrative/types.js';
import { FlowChartExecutor } from '../../../../src/lib/runner/FlowChartExecutor.js';

describe('Recorder snapshots in getSnapshot()', () => {
  it('snapshot includes no recorders field when none implement toSnapshot', async () => {
    const noopRecorder: FlowRecorder = { id: 'noop' };

    const chart = flowChart('A', () => {}, 'a').build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(noopRecorder);
    await executor.run();

    const snapshot = executor.getSnapshot();
    expect(snapshot.recorders).toBeUndefined();
  });

  it('snapshot includes recorder data from FlowRecorders with toSnapshot', async () => {
    const customRecorder: FlowRecorder = {
      id: 'my-recorder',
      toSnapshot: () => ({ name: 'Custom Data', data: { foo: 42 } }),
    };

    const chart = flowChart('A', () => {}, 'a').build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(customRecorder);
    await executor.run();

    const snapshot = executor.getSnapshot();
    expect(snapshot.recorders).toBeDefined();
    expect(snapshot.recorders).toHaveLength(1);
    expect(snapshot.recorders![0]).toEqual({
      id: 'my-recorder',
      name: 'Custom Data',
      data: { foo: 42 },
    });
  });

  it('ManifestFlowRecorder is auto-collected via toSnapshot', async () => {
    const subChart = flowChart('Inner', () => {}, 'inner').build();

    const chart = flowChart('Outer', () => {}, 'outer')
      .addSubFlowChartNext('sf-test', subChart, 'TestSub')
      .build();

    const manifest = new ManifestFlowRecorder();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(manifest);
    await executor.run();

    const snapshot = executor.getSnapshot();
    expect(snapshot.recorders).toBeDefined();

    const manifestSnapshot = snapshot.recorders!.find((r) => r.id === 'manifest');
    expect(manifestSnapshot).toBeDefined();
    expect(manifestSnapshot!.name).toBe('Manifest');
    expect(Array.isArray(manifestSnapshot!.data)).toBe(true);
  });

  it('multiple recorders with toSnapshot are all collected', async () => {
    const r1: FlowRecorder = {
      id: 'alpha',
      toSnapshot: () => ({ name: 'Alpha', data: 'a' }),
    };
    const r2: FlowRecorder = {
      id: 'beta',
      toSnapshot: () => ({ name: 'Beta', data: 'b' }),
    };
    const r3: FlowRecorder = { id: 'gamma' }; // no toSnapshot

    const chart = flowChart('A', () => {}, 'a').build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(r1);
    executor.attachFlowRecorder(r2);
    executor.attachFlowRecorder(r3);
    await executor.run();

    const snapshot = executor.getSnapshot();
    expect(snapshot.recorders).toHaveLength(2);
    expect(snapshot.recorders!.map((r) => r.id)).toEqual(['alpha', 'beta']);
  });
});
