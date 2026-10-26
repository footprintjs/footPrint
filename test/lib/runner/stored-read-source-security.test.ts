import { memorySink } from 'foottrace/write';
import { describe, expect, it, vi } from 'vitest';

import type { CaptureHistoryTarget } from '../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { historyDigest, historyEvidence } from '../../../src/lib/capture/historyData.js';
import { DEFAULT_RUN_POLICY } from '../../../src/lib/memory/runPolicy.js';
import { ExecutionRuntime } from '../../../src/lib/runner/ExecutionRuntime.js';
import { readStoredCapture } from '../../../src/trace.js';

async function saved() {
  const adapter = memorySink();
  const executor = new FlowChartExecutor(
    flowChart<{ n: number }>(
      'Write',
      (scope) => {
        scope.n = scope.n + 1;
      },
      'write',
    )
      .addFunction(
        'Read',
        (scope) => {
          const n = scope.n;
        },
        'read',
      )
      .build(),
    {
      initialContext: { n: 1 },
      readSources: true,
      captureCoverage: true,
      sink: { adapter, capture: { acknowledge: async (target) => ({ ...target, durability: 'durable' }) } },
    },
  );
  await executor.run();
  expect(executor.getSnapshot().sink?.capture).toEqual({ status: 'acknowledged' });
  return { entries: JSON.parse(JSON.stringify(adapter.entries)) as any[], runId: executor.getSnapshot().runId! };
}

// A trusted storage owner can recompute an integrity hash; admission must still refuse malformed claims.
async function resign(entries: any[]) {
  const payload = entries.find((entry) => entry.note === 'capture-history').data;
  const { target } = payload;
  const evidence = historyEvidence(payload);
  const opened = entries.find((entry) => entry.kind === 'opened');
  const record = {
    commitLog: entries.filter((entry) => entry.kind === 'commit').map((entry) => entry.bundle),
    ...(opened.initialState !== undefined && { initialState: opened.initialState }),
  };
  target.digest = await historyDigest({ evidence, record });
  entries.find((entry) => entry.note === 'capture-receipt').data.digest = target.digest;
}

describe('stored exact source admission', () => {
  it.each(['report', 'fail'] as const)(
    'preserves %s sink handling for an unsupported array root',
    async (onFailure) => {
      const memory = memorySink();
      let executed = 0;
      const executor = new FlowChartExecutor(
        flowChart(
          'Work',
          () => {
            executed++;
          },
          'work',
        ).build(),
        {
          initialContext: [1],
          defaultValuesForContext: [2],
          readSources: true,
          sink: { adapter: memory, onFailure },
        },
      );
      if (onFailure === 'report') await executor.run();
      else await expect(executor.run()).rejects.toThrow('record sink');
      expect(executed).toBe(onFailure === 'report' ? 1 : 0);
      expect(executor.getSnapshot().sink?.failed).toBe(1);
      expect(executor.getSnapshot().readSources).toMatchObject({
        status: 'unknown',
        limitations: ['sink-source-unsupported'],
      });
      expect(executor.getSnapshot().readSources).not.toHaveProperty('record');
    },
  );
  it.each(['readTracking', 'scope', 'readSources'])(
    'preserves version-1 producer acknowledgement when %s is masked',
    async (key) => {
      const memory = memorySink();
      const acknowledge = vi.fn(async (target: CaptureHistoryTarget) => ({
        ...target,
        durability: 'durable' as const,
      }));
      const executor = new FlowChartExecutor(flowChart('Work', () => {}, 'work').build(), {
        captureCoverage: true,
        sink: { adapter: memory, capture: { acknowledge } },
      });
      executor.setRedactionPolicy({ keys: [key] });
      await executor.run();
      expect(acknowledge).toHaveBeenCalledTimes(1);
      expect(executor.getSnapshot().sink?.capture).toEqual({ status: 'acknowledged' });
      expect(memory.entries.filter((entry) => entry.kind === 'note').map((entry) => entry.note)).toEqual([
        'capture-history',
        'capture-receipt',
      ]);
      expect((await readStoredCapture(memory.entries, { runId: executor.getSnapshot().runId! })).status).toBe(
        'unknown',
      );
    },
  );
  it.each(['report', 'fail'] as const)('hands the sink its own mutable opened metadata under %s', async (onFailure) => {
    const memory = memorySink();
    let frozenAtDelivery: boolean | undefined;
    const adapter = {
      ...memory,
      opened(entry: Parameters<typeof memory.opened>[0]) {
        const correlation = entry.meta?.correlation as { operationId: string };
        frozenAtDelivery = Object.isFrozen(correlation);
        correlation.operationId = 'sink-owned-copy';
        memory.opened(entry);
      },
    };
    const env = { traceId: 'trace-one', operationId: 'operation-one' };
    const executor = new FlowChartExecutor(
      flowChart<{ ok?: boolean }>(
        'Work',
        (scope) => {
          scope.ok = true;
        },
        'work',
      ).build(),
      {
        readSources: true,
        sink: { adapter, onFailure },
      },
    );
    await executor.run({ env });
    expect(executor.getSnapshot().sharedState.ok).toBe(true);
    expect(executor.getSnapshot().sink?.failed).toBe(0);
    expect(frozenAtDelivery).toBe(false);
    expect(env.operationId).toBe('operation-one');
  });
  it('counts a metadata-copy loss, still sends opened, and withholds storage acknowledgement', async () => {
    const adapter = memorySink();
    const clone = structuredClone;
    const fault = vi.spyOn(globalThis, 'structuredClone').mockImplementation((value, options) => {
      if ((value as any)?.correlation?.operationId === 'copy-failure') throw new Error('synthetic metadata loss');
      return clone(value, options);
    });
    try {
      const executor = new FlowChartExecutor(
        flowChart<{ ok?: boolean }>(
          'Work',
          (scope) => {
            scope.ok = true;
          },
          'work',
        ).build(),
        {
          readSources: true,
          captureCoverage: true,
          sink: { adapter, capture: { acknowledge: async (target) => ({ ...target, durability: 'durable' }) } },
        },
      );
      await executor.run({ env: { traceId: 'trace-one', operationId: 'copy-failure' } });
      expect(executor.getSnapshot().sharedState.ok).toBe(true);
      expect(executor.getSnapshot().sink?.failed).toBe(1);
      expect(executor.getSnapshot().sink?.capture).toEqual({ status: 'unknown', reason: 'prior-delivery-failed' });
      expect(adapter.entries.filter((entry) => entry.kind === 'opened')).toHaveLength(1);
      expect(adapter.entries.find((entry) => entry.kind === 'opened')).not.toHaveProperty('meta');
    } finally {
      fault.mockRestore();
    }
  });

  it.each(['native', 'own-then', 'throwing-thenable'] as const)(
    'isolates a %s rejection from a raw sink failure reporter',
    async (kind) => {
      const memory = memorySink();
      let calls = 0;
      let thenReads = 0;
      const sink = {
        ...memory,
        onFailure() {
          calls++;
          if (kind === 'throwing-thenable')
            return Object.defineProperty({}, 'then', {
              get() {
                thenReads++;
                throw new Error('reporter getter');
              },
            }) as Promise<void>;
          const rejected = Promise.reject(new Error('synthetic rejected reporter'));
          if (kind === 'own-then')
            Object.defineProperty(rejected, 'then', {
              get() {
                thenReads++;
                throw new Error('own then');
              },
            });
          return rejected;
        },
      };
      new ExecutionRuntime(
        'Root',
        'root',
        {},
        {},
        { ...DEFAULT_RUN_POLICY, readSources: true },
        {
          sink,
          address: { logRunId: 'source-run', drillPath: [] },
          meta: { invalid: () => {} },
        },
        { runId: 'source-run' },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toBe(1);
      expect(memory.entries.filter((entry) => entry.kind === 'opened')).toHaveLength(1);
      expect(thenReads).toBe(kind === 'throwing-thenable' ? 1 : 0);
    },
  );

  it('admits a correctly recomputed digest before exercising malformed claims', async () => {
    const { entries, runId } = await saved();
    await resign(entries);
    expect((await readStoredCapture(entries, { runId })).status).toBe('acknowledged');
  });
  it.each([
    [
      'different run',
      (s: any) => {
        s.runId = 'other-run';
      },
    ],
    [
      'different log',
      (s: any) => {
        s.record.address.logRunId = 'other-log';
      },
    ],
    [
      'child scope',
      (s: any) => {
        s.record.address.drillPath = ['child'];
      },
    ],
    [
      'different interval',
      (s: any) => {
        s.commits.to++;
      },
    ],
    [
      'false status',
      (s: any) => {
        s.status = 'partial';
      },
    ],
    [
      'storage authority in the note',
      (s: any) => {
        s.persistence = 'durable';
      },
    ],
    [
      'out-of-range row',
      (s: any) => {
        s.record.occurrences[1].source.commitIdx = 999;
      },
    ],
    [
      'wrong written key',
      (s: any) => {
        s.record.occurrences[1].key = 'not-written';
      },
    ],
    [
      'unknown fields',
      (s: any) => {
        s.extra = 'untrusted';
      },
    ],
    [
      'unknown source fields',
      (s: any) => {
        s.record.occurrences[0].source.value = 'untrusted';
      },
    ],
    [
      'unknown limitation',
      (s: any) => {
        s.limitations.push('made-up');
      },
    ],
  ] as const)('refuses %s even with a matching integrity digest', async (_name, mutate) => {
    const { entries, runId } = await saved();
    mutate(entries.find((entry) => entry.note === 'capture-history').data.readSources);
    await resign(entries);
    expect(await readStoredCapture(entries, { runId })).toMatchObject({ status: 'unknown' });
  });

  it('refuses a version-2 capture with its source envelope removed', async () => {
    const { entries, runId } = await saved();
    delete entries.find((entry) => entry.note === 'capture-history').data.readSources;
    await resign(entries);
    expect(await readStoredCapture(entries, { runId })).toMatchObject({ status: 'unknown' });
  });

  it('does not invoke stored source accessors or toJSON', async () => {
    const { entries, runId } = await saved();
    let calls = 0;
    const sources = entries.find((entry) => entry.note === 'capture-history').data.readSources;
    Object.defineProperty(sources, 'record', {
      enumerable: true,
      get() {
        calls++;
        throw new Error('executed');
      },
    });
    sources.toJSON = () => {
      calls++;
      throw new Error('executed');
    };
    expect(await readStoredCapture(entries, { runId })).toMatchObject({ status: 'unknown' });
    expect(calls).toBe(0);
  });
});
