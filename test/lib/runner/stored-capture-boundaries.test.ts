import { memorySink } from 'foottrace/write';
import { expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { controlDepRecorder, readStoredCapture } from '../../../src/trace.js';
import { historyChart, savedFixture } from '../../helpers/storedCapture.js';

const ack = { acknowledge: async (r: any) => ({ ...r, durability: 'durable' }) };
const captured = (flow: any = historyChart(), extra: any = {}, adapter = memorySink()) => {
  const ex = new FlowChartExecutor(flow, { captureCoverage: true, sink: { adapter, capture: ack }, ...extra });
  ex.attachFlowRecorder(controlDepRecorder({ captureCoverage: true }));
  return { ex, adapter };
};

it.each(['paused', 'failed', 'cancelled'] as const)(
  'persists the actual %s execution prefix, never normal completion',
  async (boundary) => {
    const stop = new AbortController();
    const reason = new Error('synthetic cancellation');
    const flow =
      boundary === 'paused'
        ? flowChart('Ask', { execute: () => 'question', resume: () => undefined }, 'ask').build()
        : flowChart(
            'Work',
            () => {
              if (boundary === 'cancelled') stop.abort(reason);
              throw reason;
            },
            'work',
          ).build();
    const { ex, adapter } = captured(flow);
    if (boundary === 'paused') await ex.run();
    else await expect(ex.run({ signal: stop.signal })).rejects.toBe(reason);
    const result = await readStoredCapture(adapter.entries, { runId: ex.getSnapshot().runId });
    expect(result.status).toBe('acknowledged');
    expect(result.history!.capture.boundary.status).toBe(boundary);
  },
);

it.each(['off', 'summary', 'full'] as const)('keeps %s retention and exact channel observations', async (mode) => {
  const { ex, adapter } = captured(undefined, { readTracking: mode, writeTracking: mode });
  await ex.run();
  const result = await readStoredCapture(adapter.entries, { runId: ex.getSnapshot().runId });
  expect(result.status).toBe('acknowledged');
  expect(result.history!.capture).toEqual(ex.getSnapshot().capture);
  expect(result.history!.capture.channels.readSources).toBe('not-collected');
});

it('never enables capture from a checkpoint or joins resumed segments into a completed scope', async () => {
  const flow = flowChart('Ask', { execute: () => 'question', resume: () => undefined }, 'ask').build();
  const { ex, adapter } = captured(flow);
  await ex.run();
  const before = ex.getSnapshot().runId;
  await ex.resume(JSON.parse(JSON.stringify(ex.getCheckpoint())));
  expect(ex.getSnapshot().capture!.limitations).toContain('resumed-segment');
  expect((await readStoredCapture(adapter.entries, { runId: before })).status).toBe('unknown');
  expect((await readStoredCapture(adapter.entries, { runId: ex.getSnapshot().runId })).status).toBe('unknown');
});

it('holds the execution guard until acknowledgement completes and isolates subsequent invocations', async () => {
  const adapter = memorySink();
  let release!: () => void;
  let entered!: () => void;
  const seen = new Promise<void>((resolve) => (entered = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  const ex = new FlowChartExecutor(historyChart(), {
    captureCoverage: true,
    sink: {
      adapter,
      capture: {
        acknowledge: async (r) => {
          entered();
          await held;
          return { ...r, durability: 'durable' };
        },
      },
    },
  });
  const running = ex.run();
  await seen;
  await expect(ex.run()).rejects.toThrow('in flight');
  release();
  await running;
  const first = ex.getSnapshot().runId;
  await ex.run();
  const second = ex.getSnapshot().runId;
  expect(first).not.toBe(second);
  expect((await readStoredCapture(adapter.entries, { runId: first })).status).toBe('acknowledged');
  expect((await readStoredCapture(adapter.entries, { runId: second })).status).toBe('acknowledged');
});

it.each(['to', 'body', 'commit', 'base', 'close', 'order', 'duplicate'])(
  'refuses %s modifications rather than carrying an old claim',
  async (mutation) => {
    const { entries, runId } = await savedFixture();
    const evidence = entries.find((e) => e.note === 'capture-history');
    if (mutation === 'to') evidence.data.target.commits.to++;
    if (mutation === 'body') evidence.data.executionTree = {};
    if (mutation === 'commit') entries.find((e) => e.kind === 'commit').bundle.overwrite.value = 999;
    if (mutation === 'base') entries.find((e) => e.kind === 'opened').initialState.changed = true;
    if (mutation === 'close') entries.find((e) => e.kind === 'closed').meta.runId = 'another';
    if (mutation === 'order') {
      const receipt = entries.pop();
      entries.unshift(receipt);
    }
    if (mutation === 'duplicate') entries.push(structuredClone(evidence));
    expect((await readStoredCapture(entries, { runId })).status).toBe('unknown');
  },
);

it('returns detached immutable evidence even if the original stored array changes after admission', async () => {
  const { entries, runId } = await savedFixture();
  const result = await readStoredCapture(entries, { runId });
  entries.find((e) => e.kind === 'commit').bundle.overwrite.value = 91;
  expect(Object.isFrozen(result.history!.executionTree)).toBe(true);
  expect(Object.isFrozen(result.history!.commitLog)).toBe(true);
  expect(result.history!.commitLog[0]!.overwrite.value).toBe(3);
});

it.each([0, -1, 1.5, Infinity, 8 * 1024 * 1024 + 1])('refuses invalid evidence byte cap %s at setup', (maxBytes) => {
  expect(() => captured(undefined, { sink: { adapter: memorySink(), capture: { ...ack, maxBytes } } })).toThrow(
    'maxBytes',
  );
});

it('never treats unresolved commit promises as acknowledged even when ordinary flush returns', async () => {
  const sink = memorySink();
  let calls = 0;
  const adapter = { ...sink, commit: () => new Promise<void>(() => {}), flush: async () => {} };
  const { ex } = captured(undefined, {
    sink: {
      adapter,
      capture: {
        acknowledge: async (r) => {
          calls++;
          return { ...r, durability: 'durable' };
        },
      },
    },
  });
  await ex.run();
  expect(calls).toBe(0);
  expect(ex.getSnapshot().sink!.capture!.status).toBe('unknown');
});

it.each(['evidence', 'receipt', 'commit', 'flush'])('never acknowledges a failed %s delivery', async (phase) => {
  const sink = memorySink();
  let callbacks = 0;
  let flushes = 0;
  const adapter = {
    opened: sink.opened,
    closed: sink.closed,
    commit: (entry: any) => {
      if (phase === 'commit') throw new Error('synthetic delivery loss');
      sink.commit(entry);
    },
    note: (entry: any) => {
      if (entry.kind === (phase === 'evidence' ? 'capture-history' : phase === 'receipt' ? 'capture-receipt' : 'never'))
        throw new Error('synthetic note loss');
      sink.note(entry);
    },
    flush: async () => {
      if (phase === 'flush' && ++flushes === 2) throw new Error('synthetic flush loss');
    },
  };
  const ex = new FlowChartExecutor(historyChart(), {
    captureCoverage: true,
    sink: {
      adapter,
      capture: {
        acknowledge: async (r) => {
          callbacks++;
          return { ...r, durability: 'durable' };
        },
      },
    },
  });
  await ex.run();
  expect(ex.getSnapshot().sink!.capture!.status).toBe('unknown');
  if (phase !== 'receipt') expect(callbacks).toBe(0);
});

it('discloses serialization failure without changing a completed native boundary', async () => {
  const { ex } = captured();
  ex.attachFlowRecorder({
    id: 'bad',
    toSnapshot() {
      throw new Error('private serialization error');
    },
  });
  await ex.run();
  expect(ex.getFailureContext()).toBeUndefined();
});

it.each(['evidence', 'receipt', 'evidence-flush', 'receipt-flush'])(
  'publishes a rejected-leg diagnostic for required %s delivery loss without rewriting execution history',
  async (phase) => {
    const sink = memorySink();
    let flushes = 0;
    const adapter = {
      ...sink,
      note: (entry: any) => {
        if (
          entry.kind === (phase === 'evidence' ? 'capture-history' : phase === 'receipt' ? 'capture-receipt' : 'never')
        )
          throw new Error('synthetic required delivery loss');
        sink.note(entry);
      },
      flush: async () => {
        flushes++;
        if (flushes === (phase === 'evidence-flush' ? 2 : phase === 'receipt-flush' ? 3 : -1))
          throw new Error('synthetic required flush loss');
      },
    };
    const ex = new FlowChartExecutor(historyChart(), {
      captureCoverage: true,
      sink: { adapter, capture: ack, onFailure: 'fail' },
    });
    await expect(ex.run()).rejects.toMatchObject({ name: 'RecordSinkError' });
    // The rejection belongs to storage, not a successful native stage.
    expect(ex.getFailureContext()).toEqual({ category: 'unknown' });
    expect(ex.getSnapshot().sink!.capture!.status).toBe('unknown');
    // This immutable note describes the execution prefix observed before persistence failed.
    expect(ex.getSnapshot().capture!.boundary.status).toBe('completed');
  },
);
