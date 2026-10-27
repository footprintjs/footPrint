import { memorySink } from 'foottrace/write';
import { describe, expect, it, vi } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import type { SubflowResult } from '../../../src/lib/engine/types.js';
import { readStoredCapture } from '../../../src/trace.js';
import { ownershipChart, resignOwnership, savedOwnership } from '../../helpers/sourceOwnership.js';

describe('ownership coverage boundaries', () => {
  it('reads legacy source envelopes without granting them ownership evidence', async () => {
    const { entries, snapshot } = await savedOwnership();
    const payload = entries.find((entry) => entry.note === 'capture-history').data;
    payload.readSources.version = 1;
    delete payload.readSources.ownership;
    await resignOwnership(entries);
    const result = await readStoredCapture(entries, { runId: snapshot.runId! });
    expect(result.status).toBe('acknowledged');
    expect(result.history!.readSources!.version).toBe(1);
    expect(result.history!.readSources).not.toHaveProperty('ownership');
  });

  it.each([1, 3])('refuses a v%i envelope carrying an ownership claim', async (version) => {
    const { entries, snapshot } = await savedOwnership();
    entries.find((entry) => entry.note === 'capture-history').data.readSources.version = version;
    await resignOwnership(entries);
    expect(await readStoredCapture(entries, { runId: snapshot.runId! })).toEqual({
      status: 'unknown',
      reason: 'source-evidence-refused',
    });
  });

  it('never invokes hidden code attached to a stored ownership field', async () => {
    const { entries, snapshot } = await savedOwnership();
    let calls = 0;
    const payload = entries.find((entry) => entry.note === 'capture-history').data;
    Object.defineProperty(payload.readSources, 'ownership', {
      enumerable: true,
      get() {
        calls++;
        throw Error('PRIVATE-OWNER');
      },
    });
    const result = await readStoredCapture(entries, { runId: snapshot.runId! });
    expect(result.status).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain('PRIVATE-OWNER');
    expect(calls).toBe(0);
  });

  it('does not alter records or snapshots with collection off', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const snapshots = [];
    try {
      for (const options of [{}, { readSources: false }]) {
        const executor = new FlowChartExecutor(ownershipChart(), options);
        await executor.run();
        const snapshot = executor.getSnapshot();
        expect(snapshot).not.toHaveProperty('readSources');
        expect(JSON.stringify(snapshot.executionTree)).not.toContain('readSourceInvocations');
        snapshots.push({ commitLog: snapshot.commitLog, executionTree: snapshot.executionTree });
      }
      expect(JSON.stringify(snapshots[0])).toBe(JSON.stringify(snapshots[1]));
    } finally {
      clock.mockRestore();
    }
  });

  it('preserves parallel fallback reads while withholding unproven selected-address ownership', async () => {
    const sink = memorySink();
    const chart = flowChart<{ n: number }>('Start', () => {}, 'start')
      .addListOfFunction([
        {
          id: 'left',
          name: 'Left',
          fn: async (scope) => {
            await Promise.resolve();
            const n = scope.n;
          },
        },
        {
          id: 'right',
          name: 'Right',
          fn: async (scope) => {
            await Promise.resolve();
            const n = scope.n;
          },
        },
      ])
      .build();
    const executor = new FlowChartExecutor(chart, {
      initialContext: { n: 4 },
      readSources: true,
      captureCoverage: true,
      sink: { adapter: sink, capture: { acknowledge: async (target) => ({ ...target, durability: 'durable' }) } },
    });
    await executor.run();
    const snapshot = executor.getSnapshot();
    const source = snapshot.readSources as any;
    expect(source.status).toBe('captured');
    expect(source.record.occurrences).toHaveLength(2);
    expect(source.ownership.status).toBe('unknown');
    expect(source.ownership.limitations).toContain('source-address-unproven');
    expect(source.ownership.executions.filter((owner: any) => owner.stateAddress.length)).toHaveLength(2);
    expect(source.record.occurrences.every((row: any) => row.stateAddress.length === 0)).toBe(true);
    const restored = await readStoredCapture(sink.entries, { runId: snapshot.runId! });
    expect(restored.status).toBe('acknowledged');
    expect((restored.history!.readSources as any).ownership.status).toBe('unknown');
  });

  it('never restores ownership from a lean checkpoint or lends an old book to same-executor resume', async () => {
    const chart = flowChart<{ n: number }>(
      'Seed',
      (scope) => {
        scope.n = 4;
      },
      'seed',
    )
      .addPausableFunction(
        'Ask',
        {
          execute: () => ({}),
          resume: (scope) => {
            const n = scope.n;
          },
        },
        'ask',
      )
      .build();
    const previous = new FlowChartExecutor(chart, { readSources: true, captureCoverage: true });
    await previous.run();
    const checkpoint = JSON.parse(JSON.stringify(previous.getCheckpoint()));
    expect(JSON.stringify(checkpoint)).not.toContain('ownership');
    expect(checkpoint).not.toHaveProperty('readSources');
    await previous.resume(checkpoint, true);
    expect(previous.getSnapshot().readSources).toMatchObject({
      status: 'unknown',
      limitations: ['resumed-source-ownership'],
    });
    expect(previous.getSnapshot().readSources).not.toHaveProperty('ownership');
    const fresh = new FlowChartExecutor(chart, { readSources: true, captureCoverage: true });
    await fresh.resume(checkpoint, true);
    expect(fresh.getSnapshot().readSources).toMatchObject({
      version: 2,
      status: 'partial',
      limitations: ['source-history-not-included'],
    });
    expect(fresh.getSnapshot().capture!.limitations).toContain('resumed-segment');
  });

  it('keeps independently observed child scope identities separate from a root history receipt', async () => {
    const sink = memorySink();
    const chart = flowChart('Root', () => {}, 'root')
      .addSubFlowChartNext('child', ownershipChart(), 'Child')
      .build();
    const executor = new FlowChartExecutor(chart, {
      readSources: true,
      captureCoverage: true,
      sink: { adapter: sink, capture: { acknowledge: async (target) => ({ ...target, durability: 'durable' }) } },
    });
    await executor.run();
    const snapshot = executor.getSnapshot();
    const child = Object.entries(snapshot.subflowResults!).find(([key]) => key.includes('#'))![1] as SubflowResult;
    const ownership = (child.treeContext.readSources as any).ownership;
    expect(ownership.logAddress.drillPath).toHaveLength(1);
    expect(ownership.logAddress).not.toEqual((snapshot.readSources as any).ownership.logAddress);
    const loaded = await readStoredCapture(sink.entries, { runId: snapshot.runId! });
    expect(loaded.status).toBe('acknowledged');
    expect(loaded.history).not.toHaveProperty('subflowResults');
    expect((loaded.history!.readSources as any).ownership.logAddress.drillPath).toEqual([]);
  });
});
