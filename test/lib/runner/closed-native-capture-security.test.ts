import { memorySink } from 'foottrace/write';
import { afterEach, expect, it, vi } from 'vitest';

import { createRunLifecycle, flowChart, FlowChartExecutor } from '../../../src/index.js';
import { historyDigest, historyEvidence } from '../../../src/lib/capture/historyData.js';
import { controlDepRecorder, readStoredCapture } from '../../../src/trace.js';

const options = { captureCoverage: true, captureExtent: true, captureClosure: true };
const silent = { info() {}, log() {}, debug() {}, warn() {}, error() {} };
const plain = () =>
  flowChart('Work', () => undefined, 'work')
    .setLogger(silent)
    .build();
afterEach(() => vi.restoreAllMocks());

async function stored() {
  const adapter = memorySink();
  const original = new Error('original');
  const ex = new FlowChartExecutor(
    flowChart(
      'Fail',
      () => {
        throw original;
      },
      'fail',
    )
      .setLogger(silent)
      .build(),
    {
      ...options,
      sink: { adapter, capture: { acknowledge: async (t) => ({ ...t, durability: 'durable' }) } },
    },
  );
  ex.attachFlowRecorder(controlDepRecorder({ captureCoverage: true }));
  await expect(ex.run()).rejects.toBe(original);
  expect(ex.getClosedCapture().status).toBe('closed');
  return { ex, entries: JSON.parse(JSON.stringify(adapter.entries)) };
}

it.each([
  (closure: any) => {
    closure.version = 2;
  },
  (closure: any) => {
    closure.runId = 'other';
  },
  (closure: any) => {
    closure.commits.to++;
  },
  (closure: any) => {
    closure.selectedFailure.attemptId = 'fail#0@2';
  },
  (closure: any) => {
    closure.selectedFailure.kind = 'commit';
    delete closure.selectedFailure.attemptId;
  },
  (closure: any) => {
    delete closure.selectedFailure;
  },
  (closure: any) => {
    closure.boundary = 'completed';
    delete closure.selectedFailure;
  },
  (closure: any) => {
    closure.limitations.pop();
  },
])('refuses an inconsistent closure even after a coherent corruption-checksum rewrite (%#)', async (change) => {
  const { ex, entries } = await stored();
  const evidence = entries.find((e: any) => e.note === 'capture-history').data;
  change(evidence.closure);
  // Recompute against the admitted basis, so shape consistency—not the checksum—must detect this change.
  const original = ex.getClosedCapture();
  expect(original.status).toBe('closed');
  if (original.status !== 'closed') throw new Error('fixture');
  const correctDigest = await historyDigest({
    evidence: historyEvidence(evidence),
    record: {
      commitLog: original.record.commitLog,
      ...(original.record.initialState !== undefined && { initialState: original.record.initialState }),
    },
  });
  evidence.target.digest = correctDigest;
  entries.find((e: any) => e.note === 'capture-receipt').data.digest = correctDigest;
  expect(await readStoredCapture(entries, { runId: ex.getSnapshot().runId })).toEqual({
    status: 'unknown',
    reason: 'closure-evidence-refused',
  });
});

it('never executes a stored closure getter, and rejects a missing extent', async () => {
  const { ex, entries } = await stored();
  const evidence = entries.find((e: any) => e.note === 'capture-history').data;
  const read = vi.fn(() => 1);
  Object.defineProperty(evidence.closure, 'version', { get: read, enumerable: true });
  expect((await readStoredCapture(entries, { runId: ex.getSnapshot().runId })).status).toBe('unknown');
  expect(read).not.toHaveBeenCalled();
  const clean = await stored();
  delete clean.entries.find((e: any) => e.note === 'capture-history').data.captureExtent;
  expect((await readStoredCapture(clean.entries, { runId: clean.ex.getSnapshot().runId })).status).toBe('unknown');
});

it('a recorder snapshot refusal never replaces the native thrown object', async () => {
  const original = new Error('native');
  const ex = new FlowChartExecutor(
    flowChart(
      'Fail',
      () => {
        throw original;
      },
      'fail',
    )
      .setLogger(silent)
      .build(),
    options,
  );
  ex.attachFlowRecorder({
    id: 'broken',
    toSnapshot() {
      throw new Error('recorder');
    },
  });
  await expect(ex.run()).rejects.toBe(original);
  expect(ex.getClosedCapture()).toEqual({ status: 'unknown', reason: 'evidence-refused' });
});

it('retains privacy on the copied seed, tracked values and protocol fields', async () => {
  const ex = new FlowChartExecutor(
    flowChart<{ secret?: string; output?: string }>(
      'Read',
      (s) => {
        s.output = s.secret;
      },
      'read',
    )
      .setLogger(silent)
      .build(),
    {
      ...options,
      initialContext: { secret: 'PRIVATE_SEED' },
    },
  );
  ex.setRedactionPolicy({ keys: ['secret', 'output'] });
  await ex.run();
  const result = ex.getClosedCapture();
  expect(result.status).toBe('closed');
  expect(JSON.stringify(result)).not.toContain('PRIVATE_SEED');
  const masked = new FlowChartExecutor(plain(), options);
  masked.setRedactionPolicy({ keys: ['policy'] });
  await masked.run();
  expect(masked.getClosedCapture()).toMatchObject({ status: 'unknown', reason: 'closure-evidence-refused' });
});

it('does not confuse a failed owner body after finish with a failed native prefix', async () => {
  const adapter = memorySink();
  const owner = createRunLifecycle(plain(), {
    runnerId: 'closed-prefix-owner',
    executorOptions: {
      ...options,
      sink: { adapter, capture: { acknowledge: async (t) => ({ ...t, durability: 'durable' }) } },
    },
  });
  const original = new Error('owner body');
  await expect(
    owner.withRun(async (run) => {
      await run.execute({ kind: 'run' });
      await run.finish();
      throw original;
    }),
  ).rejects.toBe(original);
  const runId = owner.view()!.snapshot()!.runId;
  const result = await readStoredCapture(adapter.entries, { runId });
  expect(result.status).toBe('acknowledged');
  expect(result.history?.closure?.boundary).toBe('completed');
});

it('keeps default-off stream bytes and callback/microtask order unchanged', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1900000000000);
  const run = async (captureClosure?: boolean) => {
    const adapter = memorySink();
    const order: string[] = [];
    const ex = new FlowChartExecutor(
      flowChart(
        'Work',
        async () => {
          order.push('start');
          await Promise.resolve();
          order.push('end');
        },
        'work',
      )
        .setLogger(silent)
        .build(),
      {
        captureCoverage: true,
        captureExtent: true,
        sink: adapter,
        ...(captureClosure !== undefined && { captureClosure }),
      },
    );
    ex.attachFlowRecorder({ id: 'order', onStageExecuted: () => order.push('observed') });
    await ex.run();
    expect(ex.getClosedCapture()).toEqual({ status: 'unknown', reason: 'not-collected' });
    return { order, bytes: JSON.stringify(adapter.entries).replaceAll(ex.getSnapshot().runId, 'run') };
  };
  expect(await run(false)).toEqual(await run());
});

it('refuses child and fanout prefixes, even when every observed invocation settled', async () => {
  const charts = [
    flowChart('Root', () => undefined, 'root')
      .addSubFlowChartNext('child', plain(), 'Child')
      .build(),
    flowChart('Root', () => undefined, 'root')
      .addListOfFunction([{ id: 'child', name: 'Child', fn: () => undefined }])
      .build(),
  ];
  for (const chart of charts) {
    const ex = new FlowChartExecutor(chart, options);
    await ex.run();
    expect(ex.getSnapshot().captureExtent!.invocations.pending).toBe(0);
    expect(ex.getClosedCapture()).toEqual({ status: 'unknown', reason: 'native-prefix-unverified' });
  }
});

it('keeps paused and resumed captures unknown without changing their recorded outcomes', async () => {
  const chart = flowChart('Ask', { execute: () => 'question', resume: () => undefined }, 'ask')
    .setLogger(silent)
    .build();
  const ex = new FlowChartExecutor(chart, options);
  await ex.run();
  expect(ex.getSnapshot().capture?.boundary.status).toBe('paused');
  expect(ex.getClosedCapture()).toMatchObject({ status: 'unknown' });
  await ex.resume(ex.getCheckpoint()!);
  expect(ex.getSnapshot().capture?.boundary.status).toBe('completed');
  expect(ex.getClosedCapture()).toMatchObject({ status: 'unknown' });
});

it('does not promote disabled or missing channels merely because a prefix was copied', async () => {
  const ex = new FlowChartExecutor(plain(), { ...options, readTracking: 'off', writeTracking: 'off' });
  await ex.run();
  const result = ex.getClosedCapture();
  expect(result.status).toBe('closed');
  if (result.status !== 'closed') throw new Error('fixture');
  expect(result.record.capture.channels).toMatchObject({ reads: 'disabled', writes: 'disabled', control: 'unknown' });
});

it('copies a recorded failure only once, before its acknowledgement changes recorder state', async () => {
  const adapter = memorySink();
  let snapshots = 0;
  let value = 1;
  const original = new Error('native');
  const ex = new FlowChartExecutor(
    flowChart(
      'Fail',
      () => {
        throw original;
      },
      'fail',
    )
      .setLogger(silent)
      .build(),
    {
      ...options,
      sink: {
        adapter,
        capture: {
          acknowledge: async (t) => {
            value = 2;
            return { ...t, durability: 'durable' };
          },
        },
      },
    },
  );
  ex.attachFlowRecorder({
    id: 'cut',
    toSnapshot: () => {
      snapshots++;
      return { name: 'cut', data: { value } };
    },
  });
  await expect(ex.run()).rejects.toBe(original);
  expect(snapshots).toBe(1);
  const result = ex.getClosedCapture();
  expect(result.status).toBe('closed');
  if (result.status !== 'closed') throw new Error('fixture');
  const saved = await readStoredCapture(adapter.entries, { runId: result.record.closure.runId });
  expect(saved.history?.recorders).toEqual(result.record.recorders);
  expect(result.record.recorders?.[0]?.data).toEqual({ value: 1 });
});

it('does not retry a refused cut when the recorded failure passes through the outer catch', async () => {
  const adapter = memorySink();
  let snapshots = 0;
  const original = new Error('native');
  const ex = new FlowChartExecutor(
    flowChart(
      'Fail',
      () => {
        throw original;
      },
      'fail',
    )
      .setLogger(silent)
      .build(),
    {
      ...options,
      sink: { adapter, capture: { acknowledge: async (t) => ({ ...t, durability: 'durable' }) } },
    },
  );
  ex.attachFlowRecorder({
    id: 'once',
    toSnapshot: () => {
      if (++snapshots === 1) throw new Error('refused');
      return { name: 'once', data: {} };
    },
  });
  await expect(ex.run()).rejects.toBe(original);
  expect(snapshots).toBe(1);
  expect(ex.getClosedCapture()).toEqual({ status: 'unknown', reason: 'evidence-refused' });
});

it.each(['run', 'resume'])('a refused %s admission cannot reopen the previous native cut', async (kind) => {
  let snapshots = 0;
  const ex = new FlowChartExecutor(plain(), options);
  ex.attachFlowRecorder({ id: 'cut', toSnapshot: () => ({ name: 'cut', data: ++snapshots }) });
  await ex.run();
  const first = ex.getClosedCapture();
  expect(first.status).toBe('closed');
  expect(snapshots).toBe(1);
  if (kind === 'run') await expect(ex.run({ env: { traceparent: 'invalid' } })).rejects.toThrow();
  else await expect(ex.resume({} as any)).rejects.toThrow();
  expect(ex.getClosedCapture()).toBe(first);
  expect(snapshots).toBe(1);
});

it('adds no signal getter read that could replace the original synchronous error', async () => {
  const original = new Error('body');
  const getterError = new Error('signal getter');
  const run = async (captureClosure: boolean) => {
    let reads = 0;
    let calls = 0;
    const controller = new AbortController();
    Object.defineProperty(controller.signal, 'aborted', {
      get() {
        if (++reads === 3) throw getterError;
        return false;
      },
    });
    const ex = new FlowChartExecutor(
      flowChart(
        'Fail',
        () => {
          calls++;
          throw original;
        },
        'fail',
      )
        .setLogger(silent)
        .build(),
      {
        captureCoverage: true,
        captureExtent: true,
        captureClosure,
      },
    );
    await expect(ex.run({ signal: controller.signal })).rejects.toBe(original);
    return { reads, calls };
  };
  expect(await run(true)).toEqual(await run(false));
});

it('captures the original rejected Promise with a signal, without claiming race-helper errors', async () => {
  const original = new Error('body');
  const controller = new AbortController();
  const ex = new FlowChartExecutor(
    flowChart('Fail', () => Promise.reject(original), 'fail')
      .setLogger(silent)
      .build(),
    options,
  );
  await expect(ex.run({ signal: controller.signal })).rejects.toBe(original);
  const result = ex.getClosedCapture();
  expect(result.status).toBe('closed');
  if (result.status !== 'closed') throw new Error('fixture');
  expect(result.record.closure.selectedFailure?.attemptId).toBe('fail#0@1');
});
