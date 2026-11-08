import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { memorySink } from 'foottrace/write';
import { afterEach, expect, it, vi } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { fileSink, readRecordFile } from '../../../src/sinks.js';
import { controlDepRecorder, readStoredCapture } from '../../../src/trace.js';

const enabled = { captureCoverage: true, captureExtent: true, captureClosure: true };
const silent = { info() {}, log() {}, debug() {}, warn() {}, error() {} };
const build = (fn: (scope: any) => any) => flowChart('Work', fn, 'work').setLogger(silent).build();
const closed = (ex: FlowChartExecutor) => (ex as any).getClosedCapture();
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('requires an explicit own-data closure opt-in and both existing capture options', () => {
  expect(
    () =>
      new FlowChartExecutor(
        build(() => undefined),
        { captureClosure: true } as any,
      ),
  ).toThrow('captureClosure requires');
  expect(
    () =>
      new FlowChartExecutor(
        build(() => undefined),
        { ...enabled, captureClosure: 1 } as any,
      ),
  ).toThrow('captureClosure must be a boolean');
  const getter = vi.fn(() => true);
  expect(
    () =>
      new FlowChartExecutor(
        build(() => undefined),
        Object.defineProperty({}, 'captureClosure', { get: getter }),
      ),
  ).toThrow('captureClosure must be plain data');
  expect(getter).not.toHaveBeenCalled();
});

it.each(['sync', 'promise'])(
  'serves a separately frozen %s failed prefix and the exact actual-entry attempt',
  async (kind) => {
    const original = Object.assign(new Error('PRIVATE_ERROR'), {
      code: 'PRIVATE_CODE',
      cause: new Error('PRIVATE_CAUSE'),
    });
    const body = vi.fn((s: any) => {
      s.value = 3;
      if (kind === 'promise') return Promise.reject(original);
      throw original;
    });
    const ex = new FlowChartExecutor(build(body), enabled as any);
    ex.attachFlowRecorder(controlDepRecorder({ captureCoverage: true }));
    expect(closed(ex)).toMatchObject({ status: 'unknown' });
    await expect(ex.run()).rejects.toBe(original);
    const result = closed(ex);
    expect(result.status).toBe('closed');
    expect(result.record.capture.boundary.status).toBe('failed');
    expect(result.record.closure).toMatchObject({
      status: 'closed',
      boundary: 'failed',
      selectedFailure: {
        kind: 'invocation',
        runId: ex.getSnapshot().runId,
        runtimeStageId: 'work#0',
        attemptId: 'work#0@1',
      },
    });
    expect(result.record.captureExtent.status).toBe('unverified');
    expect(result.record.commitLog).toHaveLength(1);
    expect(result.record).not.toHaveProperty('sharedState');
    expect(ex.getSnapshot()).not.toHaveProperty('closure');
    expect(Object.isFrozen(result.record.executionTree)).toBe(true);
    expect(Object.isFrozen(result.record.closure)).toBe(true);
    expect(JSON.stringify(result.record.closure)).not.toContain('PRIVATE_ERROR');
    expect(body).toHaveBeenCalledOnce();
  },
);

it('uses the final real retry invocation, and success never carries a recovered failure', async () => {
  const original = new Error('retry');
  const run = async (recover: boolean) => {
    let attempts = 0;
    const ex = new FlowChartExecutor(
      flowChart(
        'Retry',
        () => {
          if (++attempts < 2 || !recover) throw original;
        },
        'retry',
      )
        .retry({ attempts: 2 })
        .setLogger(silent)
        .build(),
      enabled as any,
    );
    if (recover) await ex.run();
    else await expect(ex.run()).rejects.toBe(original);
    return closed(ex);
  };
  expect((await run(false)).record.closure.selectedFailure.attemptId).toBe('retry#0@2');
  expect((await run(true)).record.closure).not.toHaveProperty('selectedFailure');
});

it('does not reopen a frozen cut for later reads, diagnostics, or a later run', async () => {
  let late!: () => void;
  const ex = new FlowChartExecutor(
    build((s) => {
      s.value = 7;
      late = () => {
        s.$log(String(s.value));
      };
    }),
    enabled as any,
  );
  await ex.run();
  const first = closed(ex);
  expect(first.status).toBe('closed');
  const bytes = JSON.stringify(first);
  late();
  expect(closed(ex)).toBe(first);
  expect(JSON.stringify(first)).toBe(bytes);
  await ex.run();
  expect(closed(ex).record.closure.runId).not.toBe(first.record.closure.runId);
  expect(JSON.stringify(first)).toBe(bytes);
});

it('leaves helper-call work unknown even when the stage returned without awaiting it', async () => {
  const held = gate();
  let work: Promise<unknown> | undefined;
  const ex = new FlowChartExecutor(
    build((s) => {
      work = s.$call('service', () => held.promise);
    }),
    enabled as any,
  );
  await ex.run();
  expect(closed(ex)).toMatchObject({ status: 'unknown', reason: 'helper-work-not-attested' });
  held.resolve();
  await work?.catch(() => undefined);
  expect(closed(ex).status).toBe('unknown');
});

it('keeps an abandoned Promise unknown after timeout and after its late settlement', async () => {
  vi.useFakeTimers();
  const held = gate();
  const entered = gate();
  const ex = new FlowChartExecutor(
    build(() => {
      entered.resolve();
      return held.promise;
    }),
    enabled as any,
  );
  const pending = ex.run({ timeoutMs: 20 });
  const rejected = expect(pending).rejects.toThrow();
  await entered.promise;
  await vi.advanceTimersByTimeAsync(20);
  await rejected;
  const first = closed(ex);
  expect(first.status).toBe('unknown');
  held.resolve();
  await held.promise;
  expect(closed(ex)).toBe(first);
});

it('does not borrow the function invocation when commit cloning replaces its error', async () => {
  const original = new Error('business');
  const ex = new FlowChartExecutor(
    build((s) => {
      s.bad = () => 1;
      throw original;
    }),
    enabled as any,
  );
  await expect(ex.run()).rejects.not.toBe(original);
  expect(closed(ex)).toMatchObject({ status: 'unknown' });
});

it('refuses bounded copy failure without replacing the original thrown value', async () => {
  const original = new Error('original');
  const ex = new FlowChartExecutor(
    build(() => {
      throw original;
    }),
    enabled as any,
  );
  ex.attachFlowRecorder({
    id: 'oversized',
    toSnapshot: () => ({ name: 'oversized', data: 'x'.repeat(1024 * 1024 + 1) }),
  });
  await expect(ex.run()).rejects.toBe(original);
  expect(closed(ex)).toMatchObject({ status: 'unknown', reason: 'evidence-too-large' });
});

it('persists exactly the frozen failed evidence through real file durability and JSON reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fp-closed-prefix-'));
  const sink = fileSink(join(directory, 'record.jsonl'));
  try {
    const original = new Error('no answer');
    const ex = new FlowChartExecutor(
      build((s) => {
        s.value = s.missing ?? 0;
        throw original;
      }),
      {
        ...enabled,
        readSources: true,
        sink: { adapter: sink, capture: sink },
      } as any,
    );
    ex.attachFlowRecorder(controlDepRecorder({ captureCoverage: true }));
    await expect(ex.run()).rejects.toBe(original);
    expect(closed(ex).status, JSON.stringify(closed(ex))).toBe('closed');
    expect(ex.getSnapshot().sink?.capture).toEqual({ status: 'acknowledged' });
    const result = await readStoredCapture(JSON.parse(JSON.stringify(readRecordFile(sink.path).entries)), {
      runId: ex.getSnapshot().runId,
    });
    expect(result.status).toBe('acknowledged');
    expect((result.history as any).closure).toEqual(closed(ex).record.closure);
    expect(result.history?.executionTree).toEqual(closed(ex).record.executionTree);
    expect(result.history?.capture.boundary.status).toBe('failed');
    expect((result.history as any).absent).toEqual(closed(ex).record.absent);
  } finally {
    await sink.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('does not persist a fresh mutable snapshot when its closure was refused', async () => {
  const adapter = memorySink();
  const acknowledge = vi.fn(async (target) => ({ ...target, durability: 'durable' as const }));
  const ex = new FlowChartExecutor(
    build((s) => s.$call('service', () => undefined)),
    {
      ...enabled,
      sink: { adapter, capture: { acknowledge } },
    } as any,
  );
  await ex.run();
  expect(closed(ex).status).toBe('unknown');
  expect(acknowledge).not.toHaveBeenCalled();
  expect(ex.getSnapshot().sink?.capture?.status).toBe('unknown');
});
