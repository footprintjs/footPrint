import { memorySink } from 'foottrace/write';
import { describe, expect, it, vi } from 'vitest';

import type { CaptureHistoryTarget, FlowChartExecutorOptions } from '../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { historyDigest, historyEvidence } from '../../../src/lib/capture/historyData.js';
import { DEFAULT_RUN_POLICY } from '../../../src/lib/memory/runPolicy.js';
import { ExecutionRuntime } from '../../../src/lib/runner/ExecutionRuntime.js';
import { readStoredCapture } from '../../../src/trace.js';

async function saved(options: Pick<FlowChartExecutorOptions, 'readSources' | 'readTracking'> = {}) {
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
          const again = scope.n;
          scope.n = 7;
        },
        'read',
      )
      .addFunction(
        'LaterWrite',
        (scope) => {
          scope.n = 9;
        },
        'later',
      )
      .build(),
    {
      initialContext: { n: 1 },
      readSources: true,
      captureCoverage: true,
      sink: { adapter, capture: { acknowledge: async (target) => ({ ...target, durability: 'durable' }) } },
      ...options,
    },
  );
  await executor.run();
  expect(executor.getSnapshot().sink?.capture).toEqual({ status: 'acknowledged' });
  return {
    entries: JSON.parse(JSON.stringify(adapter.entries)) as any[],
    runId: executor.getSnapshot().runId!,
    snapshot: executor.getSnapshot(),
  };
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
      expect(memory.entries.flatMap((entry) => (entry.kind === 'note' ? [entry.note] : []))).toEqual([
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

  it.each([1, 2])('refuses a re-signed source at/after its reading execution commit (source=%s)', async (commitIdx) => {
    const { entries, runId } = await saved();
    const row = entries.find((entry) => entry.note === 'capture-history').data.readSources.record.occurrences[1];
    expect(row.source).toEqual({ kind: 'committed', commitIdx: 0 });
    row.source = { kind: 'committed', commitIdx };
    await resign(entries);
    expect(await readStoredCapture(entries, { runId })).toMatchObject({
      status: 'unknown',
      reason: 'source-evidence-refused',
    });
  });

  it.each(['base', 'committed'] as const)('refuses a re-signed composite upgraded to %s', async (kind) => {
    const adapter = memorySink();
    const executor = new FlowChartExecutor(
      flowChart<{ item: { n: number } }>(
        'Write',
        (scope) => {
          scope.item = { n: 2 };
        },
        'write',
      )
        .addFunction(
          'Read',
          (scope) => {
            const item = scope.item;
          },
          'read',
        )
        .build(),
      {
        initialContext: { item: { n: 1 } },
        readSources: true,
        captureCoverage: true,
        sink: { adapter, capture: { acknowledge: async (target) => ({ ...target, durability: 'durable' }) } },
      },
    );
    await executor.run();
    const entries = JSON.parse(JSON.stringify(adapter.entries));
    const row = entries.find((entry: any) => entry.note === 'capture-history').data.readSources.record.occurrences[0];
    expect(row.source).toMatchObject({ kind: 'unavailable', reason: 'composite-unsupported' });
    row.source = kind === 'base' ? { kind, base: 1 } : { kind, commitIdx: 0 };
    await resign(entries);
    expect(await readStoredCapture(entries, { runId: executor.getSnapshot().runId! })).toMatchObject({
      status: 'unknown',
      reason: 'source-evidence-refused',
    });
  });

  it.each([true, { limits: { maxOccurrences: 2 } }] as const)(
    'detects a dropped retained tail in full or partial capture (%j)',
    async (readSources) => {
      const { entries, runId } = await saved({ readSources });
      const rows = entries.find((entry) => entry.note === 'capture-history').data.readSources.record.occurrences;
      expect(rows.length).toBe(readSources === true ? 3 : 2);
      rows.pop();
      await resign(entries);
      expect(await readStoredCapture(entries, { runId })).toMatchObject({
        status: 'unknown',
        reason: 'source-evidence-refused',
      });
    },
  );

  it('counts repeated reads independently of final read retention', async () => {
    const { entries, runId, snapshot } = await saved({ readTracking: 'off' });
    expect(snapshot.executionTree.next).not.toHaveProperty('stageReads');
    expect(snapshot.executionTree.next?.readSourceCounts).toMatchObject({
      observed: 2,
      retained: 2,
      kinds: { base: 0, committed: 2, staged: 0, unavailable: 0 },
    });
    const result = await readStoredCapture(entries, { runId });
    expect(result.status).toBe('acknowledged');
    expect(result.history!.executionTree.next?.readSourceCounts).toEqual(snapshot.executionTree.next?.readSourceCounts);
  });

  it('refuses a capture-channel status mismatch even when the source envelope is self-consistent', async () => {
    const { entries, runId } = await saved();
    const payload = entries.find((entry) => entry.note === 'capture-history').data;
    expect(payload.readSources.status).toBe('captured');
    expect(payload.readSources.record.status).toBe('captured');
    payload.capture.channels.readSources = 'partial';
    await resign(entries);
    expect(await readStoredCapture(entries, { runId })).toMatchObject({
      status: 'unknown',
      reason: 'source-evidence-refused',
    });
  });

  it('refuses a re-signed redacted committed value relabelled exact', async () => {
    const adapter = memorySink();
    const executor = new FlowChartExecutor(
      flowChart<{ n: number }>(
        'Write',
        (scope) => {
          scope.n = 2;
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
    executor.setRedactionPolicy({ keys: ['n'] });
    await executor.run();
    const entries = JSON.parse(JSON.stringify(adapter.entries));
    const row = entries.find((entry: any) => entry.note === 'capture-history').data.readSources.record.occurrences[0];
    expect(row.source).toEqual({ kind: 'unavailable', reason: 'redacted' });
    row.source = { kind: 'committed', commitIdx: 0 };
    await resign(entries);
    expect(await readStoredCapture(entries, { runId: executor.getSnapshot().runId! })).toMatchObject({
      status: 'unknown',
      reason: 'source-evidence-refused',
    });
  });

  it.each(['full', 'delta'] as const)('admits scalar merge sources with %s commit encoding', async (commitValues) => {
    const adapter = memorySink();
    const executor = new FlowChartExecutor(
      flowChart<{ n: number }>(
        'Write',
        (scope) => {
          scope.$update('n', 2);
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
        commitValues,
        readSources: true,
        captureCoverage: true,
        sink: { adapter, capture: { acknowledge: async (target) => ({ ...target, durability: 'durable' }) } },
      },
    );
    await executor.run();
    expect(executor.getSnapshot().sharedState.n).toBe(2);
    expect(executor.getSnapshot().readSources?.record?.occurrences[0]?.source).toEqual({
      kind: 'committed',
      commitIdx: 0,
    });
    expect((await readStoredCapture(adapter.entries, { runId: executor.getSnapshot().runId! })).status).toBe(
      'acknowledged',
    );
  });

  it.each([
    [
      'absent',
      (node: any) => {
        delete node.readSourceCounts;
      },
    ],
    [
      'fractional',
      (node: any) => {
        node.readSourceCounts.observed = 1.5;
      },
    ],
    [
      'negative',
      (node: any) => {
        node.readSourceCounts.retained = -1;
      },
    ],
    [
      'overflow',
      (node: any) => {
        node.readSourceCounts.observed = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      'more retained than observed',
      (node: any) => {
        node.readSourceCounts.retained = 3;
      },
    ],
    [
      'extra field',
      (node: any) => {
        node.readSourceCounts.extra = true;
      },
    ],
    [
      'wrong owner',
      (node: any) => {
        node.runtimeStageId = 'unrelated#1';
      },
    ],
  ] as const)('refuses %s native read-count evidence after the digest is recomputed', async (_name, mutate) => {
    const { entries, runId } = await saved();
    mutate(entries.find((entry) => entry.note === 'capture-history').data.executionTree.next);
    await resign(entries);
    expect(await readStoredCapture(entries, { runId })).toMatchObject({
      status: 'unknown',
      reason: 'source-evidence-refused',
    });
  });

  it('does not extend native read counts after source capture is sealed', () => {
    const runtime = new ExecutionRuntime(
      'Read',
      'read',
      {},
      { n: 1 },
      { ...DEFAULT_RUN_POLICY, readSources: true },
      undefined,
      { runId: 'sealed-counts' },
    );
    const context = runtime.rootStageContext;
    context.runtimeStageId = 'read#1';
    context.bindFailureIdentity('sealed-counts', 'read#1');
    expect(context.getValue([], 'n')).toBe(1);
    runtime.readSources!.seal(runtime.executionHistory.length);
    const before = runtime.getSnapshot();
    expect(context.getValue([], 'n')).toBe(1);
    const after = runtime.getSnapshot();
    expect(before.executionTree.readSourceCounts).toMatchObject({
      observed: 1,
      retained: 1,
      kinds: { base: 1, committed: 0, staged: 0, unavailable: 0 },
    });
    expect(after.executionTree.readSourceCounts).toEqual(before.executionTree.readSourceCounts);
    expect(after.readSources).toEqual(before.readSources);
  });

  it('refuses a re-signed redacted base label promoted to exact', async () => {
    const adapter = memorySink();
    const executor = new FlowChartExecutor(
      flowChart<{ n: number }>(
        'Read',
        (scope) => {
          const n = scope.n;
        },
        'read',
      ).build(),
      {
        initialContext: { n: 3 },
        readSources: true,
        captureCoverage: true,
        sink: { adapter, capture: { acknowledge: async (target) => ({ ...target, durability: 'durable' }) } },
      },
    );
    executor.setRedactionPolicy({ keys: ['n'] });
    await executor.run();
    const entries = JSON.parse(JSON.stringify(adapter.entries));
    const payload = entries.find((entry: any) => entry.note === 'capture-history').data;
    expect(payload.executionTree.readSourceCounts.kinds).toEqual({ base: 0, committed: 0, staged: 0, unavailable: 1 });
    expect(payload.readSources.record.occurrences[0].source).toEqual({ kind: 'unavailable', reason: 'redacted' });
    payload.readSources.record.occurrences[0].source = { kind: 'base', base: payload.readSources.record.segment };
    await resign(entries);
    expect(await readStoredCapture(entries, { runId: executor.getSnapshot().runId! })).toMatchObject({
      status: 'unknown',
      reason: 'source-evidence-refused',
    });
  });

  it.each(['object-base', 'object-commit', 'redacted-commit'] as const)(
    'refuses %s even when source-kind counters agree',
    async (change) => {
      const { entries, runId } = await saved();
      if (change === 'object-base') entries.find((entry) => entry.kind === 'opened').initialState.n = { value: 1 };
      else {
        const bundle = entries.find((entry) => entry.kind === 'commit').bundle;
        if (change === 'object-commit') bundle.overwrite.n = { value: 2 };
        else bundle.redactedPaths = ['n'];
      }
      await resign(entries);
      expect(await readStoredCapture(entries, { runId })).toMatchObject({
        status: 'unknown',
        reason: 'source-evidence-refused',
      });
    },
  );

  it.each([
    { keys: 1500, padding: 0, maxBytes: 1024 * 1024 },
    { keys: 80, padding: 1_100_000, maxBytes: 2 * 1024 * 1024 },
  ])('refuses reference validation above the row/byte work cap (%j)', async ({ keys, padding, maxBytes }) => {
    const adapter = memorySink();
    const acknowledge = vi.fn(async (target: CaptureHistoryTarget) => ({ ...target, durability: 'durable' as const }));
    const executor = new FlowChartExecutor(
      flowChart<Record<string, number>>(
        'Write',
        (scope) => {
          for (let i = 0; i < keys; i++) scope.$setValue('key' + i, i);
        },
        'write',
      )
        .addFunction(
          'Read',
          (scope) => {
            for (let i = 0; i < keys; i++) scope.$getValue('key' + i);
          },
          'read',
        )
        .build(),
      {
        readSources: { limits: { maxPerExecution: 4096 } },
        captureCoverage: true,
        ...(padding && { initialContext: { padding: 'x'.repeat(padding) } }),
        sink: { adapter, capture: { acknowledge, maxBytes } },
      },
    );
    await executor.run();
    expect(executor.getSnapshot().readSources?.record?.occurrences).toHaveLength(keys);
    expect(executor.getSnapshot().executionTree.next?.readSourceCounts).toMatchObject({
      observed: keys,
      retained: keys,
    });
    expect(executor.getSnapshot().sink?.capture).toEqual({ status: 'unknown', reason: 'source-validation-limit' });
    expect(acknowledge).not.toHaveBeenCalled();
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
