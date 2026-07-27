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
import type { CombinedRecorder } from '../../../../src/lib/recorder/CombinedRecorder.js';
import { InOutRecorder } from '../../../../src/lib/recorder/InOutRecorder.js';
import { TopologyRecorder } from '../../../../src/lib/recorder/TopologyRecorder.js';
import { FlowChartExecutor } from '../../../../src/lib/runner/FlowChartExecutor.js';
import type { ScopeRecorder } from '../../../../src/lib/scope/types.js';
import { manifest, metrics, narrative } from '../../../../src/recorders.js';

describe('ScopeRecorder snapshots in getSnapshot()', () => {
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

// ════════════════════════════════════════════════════════════════════════════
// One entry per recorder — a recorder that rides BOTH channels is still ONE
// row in `snapshot.recorders`.
//
// `onError` / `onPause` / `onResume` are declared on BOTH the scope and flow
// interfaces, so `attachCombinedRecorder` legitimately registers such a
// recorder on both inline lists (each channel calls the hook with its own
// payload variant — that IS the design). Serialization must not mistake that
// for two recorders. `metrics()` is the everyday case: a pure data-flow
// recorder whose `onPause` counts pauses.
// ════════════════════════════════════════════════════════════════════════════

describe('recorder snapshots — one entry per recorder id', () => {
  function twoStageChart() {
    return flowChart<{ value: number; result: string }>(
      'Seed',
      (scope) => {
        scope.value = 42;
      },
      'seed',
    )
      .addFunction(
        'Compute',
        (scope) => {
          scope.result = `v=${scope.value}`;
        },
        'compute',
      )
      .build();
  }

  it('metrics() attached as a combined recorder appears exactly once', async () => {
    const executor = new FlowChartExecutor(twoStageChart());
    const meter = metrics();
    executor.attachCombinedRecorder(meter);
    await executor.run();

    const rows = executor.getSnapshot().recorders!.filter((r) => r.id === meter.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Metrics');
  });

  it('a recorder with hooks on BOTH channels appears once', async () => {
    const both: CombinedRecorder = {
      id: 'audit',
      onWrite: () => {},
      onDecision: () => {},
      toSnapshot: () => ({ name: 'Audit', data: { ok: true } }),
    };

    const executor = new FlowChartExecutor(twoStageChart());
    executor.attachCombinedRecorder(both);
    await executor.run();

    expect(executor.getSnapshot().recorders!.filter((r) => r.id === 'audit')).toHaveLength(1);
  });

  it('the same recorder split across delivery tiers (inline scope + deferred flow) appears once', async () => {
    const spanning: CombinedRecorder = {
      id: 'spanning',
      onWrite: () => {},
      onStageExecuted: () => {},
      toSnapshot: () => ({ name: 'Spanning', data: 1 }),
    };

    const executor = new FlowChartExecutor(twoStageChart());
    executor.attachScopeRecorder(spanning as never);
    executor.attachFlowRecorder(spanning as never, { delivery: 'deferred' });
    await executor.run();

    expect(executor.getSnapshot().recorders!.filter((r) => r.id === 'spanning')).toHaveLength(1);
  });

  it('a recorder WITHOUT toSnapshot never shadows a same-id recorder that has one', async () => {
    const silent: ScopeRecorder = { id: 'shared-id', onWrite: () => {} };
    const speaking: FlowRecorder = {
      id: 'shared-id',
      onStageExecuted: () => {},
      toSnapshot: () => ({ name: 'Speaking', data: 'kept' }),
    };

    const executor = new FlowChartExecutor(twoStageChart());
    executor.attachScopeRecorder(silent);
    executor.attachFlowRecorder(speaking);
    await executor.run();

    const rows = executor.getSnapshot().recorders!.filter((r) => r.id === 'shared-id');
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toBe('kept');
  });

  it('property: ids are unique for ANY mix of built-in recorders', async () => {
    const executor = new FlowChartExecutor(twoStageChart());
    executor.attachCombinedRecorder(metrics());
    executor.attachCombinedRecorder(metrics());
    executor.attachCombinedRecorder(narrative());
    executor.attachCombinedRecorder(new InOutRecorder() as never);
    executor.attachCombinedRecorder(new TopologyRecorder() as never);
    executor.attachCombinedRecorder(manifest());
    await executor.run();

    const ids = executor.getSnapshot().recorders!.map((r) => r.id);
    expect(ids).toHaveLength(new Set(ids).size);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// `meta` — the recorder's own facts about the BUNDLE, carried to the consumer.
//
// A recorder that can emit more than one shape of bundle (a full one and a
// stripped one, say) needs somewhere to SAY which one this is. Before `meta`
// the only place was the prose in `description`, so every offline reader had
// to string-match a sentence — and a reader that didn't drew an empty panel
// instead of saying "this recording carries structure only".
//
// These fail on the old behavior: collection rebuilt the row field by field
// and had no `meta` line, so a recorder could return the field and watch it
// vanish between `toSnapshot()` and `getSnapshot()`.
// ════════════════════════════════════════════════════════════════════════════

describe('recorder snapshots — meta rides along', () => {
  const oneStage = () => flowChart('A', () => {}, 'a').build();

  it('meta from toSnapshot() reaches getSnapshot().recorders', async () => {
    const projecting: FlowRecorder = {
      id: 'projecting',
      toSnapshot: () => ({
        name: 'Projected',
        description: 'the stripped projection',
        data: [1, 2, 3],
        meta: { mode: 'lean', dropped: ['payload'] },
      }),
    };

    const executor = new FlowChartExecutor(oneStage());
    executor.attachFlowRecorder(projecting);
    await executor.run();

    const row = executor.getSnapshot().recorders!.find((r) => r.id === 'projecting')!;
    expect(row.meta).toEqual({ mode: 'lean', dropped: ['payload'] });
  });

  it('meta survives JSON — a stored recording can still branch on it', async () => {
    const projecting: FlowRecorder = {
      id: 'projecting',
      toSnapshot: () => ({ name: 'Projected', data: [], meta: { mode: 'lean' } }),
    };

    const executor = new FlowChartExecutor(oneStage());
    executor.attachFlowRecorder(projecting);
    await executor.run();

    const reloaded = JSON.parse(JSON.stringify(executor.getSnapshot())) as {
      recorders: { id: string; meta?: { mode?: string } }[];
    };
    expect(reloaded.recorders.find((r) => r.id === 'projecting')!.meta!.mode).toBe('lean');
  });

  it('a recorder that says nothing about its bundle stays undefined (no empty object)', async () => {
    const plain: FlowRecorder = {
      id: 'plain',
      toSnapshot: () => ({ name: 'Plain', data: 1 }),
    };

    const executor = new FlowChartExecutor(oneStage());
    executor.attachFlowRecorder(plain);
    await executor.run();

    expect(executor.getSnapshot().recorders!.find((r) => r.id === 'plain')!.meta).toBeUndefined();
  });

  it('meta is the recorder’s to fill, but the id stays the executor’s', async () => {
    // The row is rebuilt field by field precisely so a recorder cannot
    // rename itself in the snapshot — consumers index by `id`.
    const sneaky: FlowRecorder = {
      id: 'real-id',
      toSnapshot: () => ({ name: 'Sneaky', data: 1, id: 'spoofed', meta: { mode: 'full' } } as never),
    };

    const executor = new FlowChartExecutor(oneStage());
    executor.attachFlowRecorder(sneaky);
    await executor.run();

    const rows = executor.getSnapshot().recorders!;
    expect(rows.map((r) => r.id)).toEqual(['real-id']);
    expect(rows[0].meta).toEqual({ mode: 'full' });
  });
});
