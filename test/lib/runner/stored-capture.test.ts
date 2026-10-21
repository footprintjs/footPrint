import { memorySink } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { controlDepRecorder, readStoredCapture } from '../../../src/trace.js';

const chart = () =>
  flowChart<{ value?: number }>(
    'Seed',
    (s) => {
      s.value = 3;
    },
    'seed',
  )
    .addFunction(
      'Read',
      (s) => {
        const value = s.value;
      },
      'read',
    )
    .build();

function setup(overrides: Record<string, unknown> = {}) {
  const adapter = memorySink();
  let calls = 0;
  const capture = {
    acknowledge: async (request: any) => {
      calls++;
      return { ...request, durability: 'durable' };
    },
    ...overrides,
  };
  const executor = new FlowChartExecutor(chart(), {
    captureCoverage: true,
    writeProvenance: 'reads-prefix',
    sink: { adapter, capture },
  });
  executor.attachFlowRecorder(controlDepRecorder({ captureCoverage: true }));
  return { adapter, executor, calls: () => calls };
}

it('persists native capture evidence and an exact adapter acknowledgement through JSON', async () => {
  const { adapter, executor, calls } = setup();
  await executor.run();
  const result = await readStoredCapture(JSON.parse(JSON.stringify(adapter.entries)), {
    runId: executor.getSnapshot().runId,
  });
  expect(calls()).toBe(1);
  expect(result.status).toBe('acknowledged');
  expect(result.history!.capture).toEqual(executor.getSnapshot().capture);
  expect(result.history!.executionTree).toEqual(executor.getSnapshot().executionTree);
  expect(result.history!.recorders).toEqual(JSON.parse(JSON.stringify(executor.getSnapshot().recorders)));
  expect(result.history!.capture.persistence).toBe('memory-only');
  expect(executor.getSnapshot().sink!.capture!.status).toBe('acknowledged');
});

it('an ordinary flush never implies durable capture and the default sink stream is unchanged', async () => {
  const adapter = memorySink();
  const executor = new FlowChartExecutor(chart(), { captureCoverage: true, sink: adapter });
  await executor.run();
  expect(adapter.entries.map((e) => e.kind)).toEqual(['opened', 'commit', 'commit', 'closed']);
  expect(executor.getSnapshot().sink).not.toHaveProperty('capture');
  expect((await readStoredCapture(adapter.entries, { runId: executor.getSnapshot().runId })).status).toBe('unknown');
});

it('refuses a missing acknowledgement marker rather than borrowing the closed entry', async () => {
  const { adapter, executor } = setup();
  await executor.run();
  const entries = adapter.entries.filter((e) => !(e.kind === 'note' && e.note === 'capture-receipt'));
  expect(await readStoredCapture(entries, { runId: executor.getSnapshot().runId })).toMatchObject({
    status: 'unknown',
    reason: 'receipt-missing',
  });
});

it.each(['runId', 'evidenceId', 'commits'])('refuses an adapter receipt with a different %s', async (field) => {
  const { executor, adapter } = setup({
    acknowledge: async (request: any) => ({
      ...request,
      durability: 'durable',
      [field]: field === 'commits' ? { from: 0, to: 999 } : 'other',
    }),
  });
  await executor.run();
  expect(executor.getSnapshot().sink!.capture!.status).toBe('unknown');
  expect((await readStoredCapture(adapter.entries, { runId: executor.getSnapshot().runId })).status).toBe('unknown');
});

it('bounds an acknowledgement that never settles without changing a completed business result', async () => {
  const { executor, adapter } = setup({ timeoutMs: 5, acknowledge: () => new Promise(() => {}) });
  await executor.run();
  expect(executor.getSnapshot().capture!.boundary.status).toBe('completed');
  expect(executor.getSnapshot().sink!.capture).toMatchObject({ status: 'unknown', reason: 'acknowledgement-timeout' });
  expect(adapter.entries.some((e) => e.kind === 'note' && e.note === 'capture-receipt')).toBe(false);
});

it('refuses oversized evidence whole, before calling the adapter', async () => {
  const { executor, calls } = setup({ maxBytes: 64 });
  await executor.run();
  expect(calls()).toBe(0);
  expect(executor.getSnapshot().sink!.capture).toMatchObject({ status: 'unknown', reason: 'evidence-refused' });
});

it('refuses a missing commit, duplicate receipt and truncated reader', async () => {
  const { executor, adapter } = setup();
  await executor.run();
  const runId = executor.getSnapshot().runId;
  expect(
    (
      await readStoredCapture(
        adapter.entries.filter((e) => e.kind !== 'commit'),
        { runId },
      )
    ).status,
  ).toBe('unknown');
  expect(
    (await readStoredCapture([...adapter.entries, structuredClone(adapter.entries.at(-1))], { runId })).status,
  ).toBe('unknown');
  expect((await readStoredCapture(adapter.entries, { runId, limits: { entries: 2 } })).status).toBe('unknown');
});

describe('configuration', () => {
  it('requires native capture opt-in and an explicit acknowledgement method', () => {
    expect(() => new FlowChartExecutor(chart(), { sink: { adapter: memorySink(), capture: {} as any } })).toThrow();
    expect(
      () =>
        new FlowChartExecutor(chart(), {
          sink: {
            adapter: memorySink(),
            capture: { acknowledge: async (r: any) => ({ ...r, durability: 'durable' }) },
          },
        }),
    ).toThrow('captureCoverage');
  });
});
