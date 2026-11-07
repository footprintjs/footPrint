import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { memorySink } from 'foottrace/write';
import { afterEach, expect, it, vi } from 'vitest';

import { registerScopeRuntime } from '../../../src/advanced.js';
import { flushAllDetached, immediateDriver } from '../../../src/detach.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { fileSink, readRecordFile } from '../../../src/sinks.js';
import { readStoredCapture } from '../../../src/trace.js';

const enabled = { captureCoverage: true, captureExtent: true };
const silent = { info() {}, log() {}, debug() {}, warn() {}, error() {} };
const plain = () =>
  flowChart('Work', () => undefined, 'work')
    .setLogger(silent)
    .build();
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

it('requires an explicit plain-data extent opt-in and captureCoverage', () => {
  expect(() => new FlowChartExecutor(plain(), { captureExtent: true })).toThrow(
    'captureExtent requires captureCoverage',
  );
  expect(() => new FlowChartExecutor(plain(), { captureExtent: 'yes' as any })).toThrow(
    'captureExtent must be a boolean',
  );
  const getter = vi.fn(() => true);
  expect(() => new FlowChartExecutor(plain(), Object.defineProperty({}, 'captureExtent', { get: getter }))).toThrow(
    'captureExtent must be plain data',
  );
  expect(getter).not.toHaveBeenCalled();
});

it('keeps default/off record bytes, callbacks and invocation scheduling identical', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000);
  const run = async (extent?: boolean) => {
    const order: string[] = [];
    const adapter = memorySink();
    const ex = new FlowChartExecutor(
      flowChart(
        'Work',
        async () => {
          order.push('body');
          await Promise.resolve();
          order.push('answer');
        },
        'work',
      )
        .setLogger(silent)
        .build(),
      {
        captureCoverage: true,
        ...(extent !== undefined && { captureExtent: extent }),
        sink: adapter,
      },
    );
    ex.attachFlowRecorder({
      id: 'count',
      onStageExecuted: () => order.push('stage'),
      onRunFailed: () => order.push('failed'),
    });
    await ex.run();
    expect(ex.getSnapshot()).not.toHaveProperty('captureExtent');
    const bytes = JSON.stringify(adapter.entries).replaceAll(ex.getSnapshot().runId, 'run');
    return { bytes, order };
  };
  expect(await run(false)).toEqual(await run());
});

it.each([false, true])('reuses one original Promise race handler with extent %s', async (captureExtent) => {
  const held = gate();
  const entered = gate();
  const then = vi.spyOn(held.promise, 'then');
  let calls = 0;
  const body = () => {
    calls++;
    entered.resolve();
    return held.promise;
  };
  const ex = new FlowChartExecutor(flowChart('Wait', body, 'wait').setLogger(silent).build(), {
    captureCoverage: true,
    captureExtent,
  });
  const running = ex.run({ signal: new AbortController().signal });
  await entered.promise;
  held.resolve();
  await running;
  expect(calls).toBe(1);
  expect(then).toHaveBeenCalledOnce();
});

it.each(['fulfilled', 'rejected', 'catch-throws', 'then-throws'])(
  'preserves the pre-aborted real Promise catch route for %s with extent enabled or off',
  async (outcome) => {
    const abortReason = new Error('abort');
    const sentinel = new Error('overridden method');
    const sourceFailure = new Error('original Promise rejection');
    const run = async (captureExtent: boolean) => {
      const controller = new AbortController();
      const calls = { body: 0, catch: 0, then: 0, fulfilled: 0, rejected: 0 };
      const answer = outcome === 'rejected' ? Promise.reject(sourceFailure) : Promise.resolve();
      Object.defineProperties(answer, {
        catch: {
          value(this: Promise<void>, onRejected: (reason: unknown) => unknown) {
            calls.catch++;
            if (outcome === 'catch-throws') throw sentinel;
            return Promise.prototype.catch.call(this, onRejected);
          },
        },
        then: {
          value(this: Promise<void>, onFulfilled: any, onRejected: any) {
            calls.then++;
            if (outcome === 'then-throws') throw sentinel;
            return Promise.prototype.then.call(
              this,
              typeof onFulfilled === 'function'
                ? (value: unknown) => {
                    calls.fulfilled++;
                    return onFulfilled(value);
                  }
                : undefined,
              typeof onRejected === 'function'
                ? (reason: unknown) => {
                    calls.rejected++;
                    return onRejected(reason);
                  }
                : undefined,
            );
          },
        },
      });
      const ex = new FlowChartExecutor(
        flowChart(
          'Abort then answer',
          () => {
            calls.body++;
            controller.abort(abortReason);
            return answer;
          },
          'abort',
        )
          .setLogger(silent)
          .build(),
        { captureCoverage: true, captureExtent },
      );
      const expected = outcome.endsWith('throws') ? sentinel : abortReason;
      await expect(ex.run({ signal: controller.signal })).rejects.toBe(expected);
      expect(calls).toEqual({
        body: 1,
        catch: 1,
        then: outcome === 'catch-throws' ? 0 : 1,
        fulfilled: 0,
        rejected: outcome === 'rejected' ? 1 : 0,
      });
      if (captureExtent)
        expect(ex.getSnapshot().captureExtent?.invocations).toEqual({
          started: 1,
          settled: outcome === 'rejected' ? 1 : 0,
          pending: outcome === 'rejected' ? 0 : 1,
          abandoned: 1,
        });
      return calls;
    };
    expect(await run(true)).toEqual(await run(false));
  },
);

it('preserves existing plain thenable assimilation without new bookkeeping callbacks', async () => {
  const sentinel = new Error('plain thenable');
  const run = async (captureExtent: boolean) => {
    let calls = 0;
    const answer = {
      then(_resolve: unknown, reject: (reason: unknown) => void) {
        calls++;
        reject(sentinel);
      },
    };
    const ex = new FlowChartExecutor(
      flowChart('Thenable', () => answer, 'thenable')
        .setLogger(silent)
        .build(),
      {
        captureCoverage: true,
        captureExtent,
      },
    );
    await expect(ex.run()).rejects.toBe(sentinel);
    expect(calls).toBe(1);
    return calls;
  };
  expect(await run(true)).toBe(await run(false));
});

it('counts settlement when the existing continuation observes an already-fulfilled Promise', async () => {
  const answer = Promise.resolve();
  const ex = new FlowChartExecutor(
    flowChart('Answer', () => answer, 'answer')
      .setLogger(silent)
      .build(),
    enabled,
  );
  const running = ex.run();
  // The Promise is already fulfilled; its existing await continuation has not run at this cut.
  expect(ex.getSnapshot().captureExtent?.invocations).toEqual({ started: 1, settled: 0, pending: 1, abandoned: 0 });
  await running;
  expect(ex.getSnapshot().captureExtent?.invocations).toEqual({ started: 1, settled: 1, pending: 0, abandoned: 0 });
});

it.each(['sync', 'promise'])(
  'freezes a %s failure observation and preserves the original business error',
  async (kind) => {
    const original = Object.assign(new Error('PRIVATE'), { code: 'PRIVATE_CODE', cause: new Error('PRIVATE_CAUSE') });
    const stack = original.stack;
    const cause = original.cause;
    const callback = vi.fn(() => {
      if (kind === 'promise') return Promise.reject(original);
      throw original;
    });
    const ex = new FlowChartExecutor(flowChart('Fail', callback, 'fail').setLogger(silent).build(), enabled);
    expect(ex.getSnapshot()).not.toHaveProperty('captureExtent');
    await expect(ex.run()).rejects.toBe(original);
    const snapshot = ex.getSnapshot();
    expect(snapshot.capture?.boundary.status).toBe('failed');
    expect(snapshot.captureExtent).toMatchObject({
      version: 1,
      extentId: snapshot.runId,
      runId: snapshot.runId,
      scope: 'root-log',
      status: 'unverified',
      logAddress: { logRunId: snapshot.runId, drillPath: [] },
      commits: { from: 0, to: 1 },
      invocations: { started: 1, settled: 1, pending: 0, abandoned: 0 },
    });
    expect(snapshot.captureExtent?.limitations).toContain('closure-not-attested');
    expect(snapshot.captureExtent?.limitations).toContain('channels-not-fenced');
    expect(Object.isFrozen(snapshot.captureExtent)).toBe(true);
    expect(Object.isFrozen(snapshot.captureExtent?.invocations)).toBe(true);
    expect(JSON.stringify(snapshot.captureExtent)).not.toContain('PRIVATE');
    expect(ex.getSnapshot().captureExtent).toBe(snapshot.captureExtent);
    expect(callback).toHaveBeenCalledOnce();
    expect(original.code).toBe('PRIVATE_CODE');
    expect(original.cause).toBe(cause);
    expect(original.stack).toBe(stack);
  },
);

it('counts every actual retry invocation without treating a failed retry as pending work', async () => {
  let calls = 0;
  const original = new Error('retry');
  const ex = new FlowChartExecutor(
    flowChart(
      'Retry',
      () => {
        if (++calls <= 2) throw original;
      },
      'retry',
    )
      .retry({ attempts: 2 })
      .setLogger(silent)
      .build(),
    enabled,
  );
  await expect(ex.run()).rejects.toBe(original);
  expect(ex.getSnapshot().captureExtent?.invocations).toEqual({ started: 2, settled: 2, pending: 0, abandoned: 0 });
});

it('separates an abort-race abandonment from the still-pending original Promise and a later run', async () => {
  vi.useFakeTimers();
  const held = gate();
  const entered = gate();
  let calls = 0;
  const ex = new FlowChartExecutor(
    flowChart(
      'Wait',
      () => {
        if (++calls !== 1) return;
        entered.resolve();
        return held.promise;
      },
      'wait',
    )
      .setLogger(silent)
      .build(),
    enabled,
  );
  const running = ex.run({ timeoutMs: 10 });
  const rejected = expect(running).rejects.toThrow();
  await entered.promise;
  expect(ex.getSnapshot().captureExtent).toMatchObject({ status: 'running', invocations: { started: 1, pending: 1 } });
  await vi.advanceTimersByTimeAsync(10);
  await rejected;
  const first = ex.getSnapshot().captureExtent!;
  expect(first.invocations).toEqual({ started: 1, settled: 0, pending: 1, abandoned: 1 });
  expect(first.limitations).toContain('pending-native-invocations');
  expect(first.limitations).toContain('abandoned-native-invocations');
  await ex.run();
  const second = ex.getSnapshot().captureExtent!;
  expect(second.runId).not.toBe(first.runId);
  held.resolve();
  await held.promise;
  await Promise.resolve();
  expect(ex.getSnapshot().captureExtent).toBe(second);
  expect(first.invocations).toEqual({ started: 1, settled: 0, pending: 1, abandoned: 1 });
  expect(second.invocations).toEqual({ started: 1, settled: 1, pending: 0, abandoned: 0 });
});

it('marks child logs, custom scopes, fanout, detach and resumed segments when observed', async () => {
  const child = plain();
  const mounted = new FlowChartExecutor(
    flowChart('Seed', () => undefined, 'seed')
      .addSubFlowChartNext('child', child, 'Child')
      .setLogger(silent)
      .build(),
    enabled,
  );
  await mounted.run();
  expect(mounted.getSnapshot().captureExtent?.limitations).toContain('child-work-not-tracked');
  const perItem = new FlowChartExecutor(
    flowChart('Seed', () => undefined, 'seed')
      .addParallelForEach('Each', 'each', {
        items: () => [1, 2],
        branch: () => child,
        into: 'results',
        maxBranches: 2,
      })
      .setLogger(silent)
      .build(),
    enabled,
  );
  await perItem.run();
  expect(perItem.getSnapshot().captureExtent?.limitations).toEqual(
    expect.arrayContaining(['child-work-not-tracked', 'fanout-work-not-attested']),
  );
  const fanout = new FlowChartExecutor(
    flowChart('Seed', () => undefined, 'seed')
      .addListOfFunction([{ id: 'one', name: 'One', fn: () => undefined }])
      .setLogger(silent)
      .build(),
    enabled,
  );
  await fanout.run();
  expect(fanout.getSnapshot().captureExtent?.limitations).toContain('fanout-work-not-attested');
  const custom = new FlowChartExecutor(plain(), {
    ...enabled,
    scopeFactory: () => registerScopeRuntime({}, { target: {}, handlesAssignments: true }),
  });
  await custom.run();
  expect(custom.getSnapshot().captureExtent?.limitations).toContain('custom-scope');
  const detached = new FlowChartExecutor(
    flowChart('Detach', (s) => s.$detachAndForget(immediateDriver, child), 'detach')
      .setLogger(silent)
      .build(),
    enabled,
  );
  await detached.run();
  await flushAllDetached();
  expect(detached.getSnapshot().captureExtent?.limitations).toContain('detached-work-not-tracked');
  const paused = new FlowChartExecutor(
    flowChart('Ask', { execute: () => 'ask', resume: () => undefined }, 'ask')
      .setLogger(silent)
      .build(),
    enabled,
  );
  await paused.run();
  await paused.resume(paused.getCheckpoint()!);
  expect(paused.getSnapshot().captureExtent?.limitations).toContain('resumed-segment');
});

it('freezes a pending failFast sibling cut without stopping its existing continuation', async () => {
  const entered = gate();
  const held = gate();
  const original = new Error('first');
  const chart = flowChart('Parent', () => undefined, 'parent')
    .addListOfFunction(
      [
        {
          id: 'fast',
          name: 'Fast',
          fn: async () => {
            await entered.promise;
            throw original;
          },
        },
        {
          id: 'slow',
          name: 'Slow',
          fn: () => {
            entered.resolve();
            return held.promise;
          },
        },
      ],
      { failFast: true },
    )
    .setLogger(silent)
    .build();
  const ex = new FlowChartExecutor(chart, enabled);
  await expect(ex.run()).rejects.toBe(original);
  const terminal = ex.getSnapshot().captureExtent!;
  expect(terminal.invocations).toEqual({ started: 3, settled: 2, pending: 1, abandoned: 0 });
  expect(terminal.limitations).toContain('fanout-work-not-attested');
  held.resolve();
  await held.promise;
  // Let the existing child commit/continuation tail settle; the attested counter cut must not move.
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(ex.getSnapshot().captureExtent).toBe(terminal);
  expect(ex.getSnapshot().commitLog.length).toBeGreaterThan(terminal.commits.to);
});

it('keeps value-free snapshot identity/count exposure consistent and refuses masked stored protocol fields', async () => {
  const sink = memorySink();
  const acknowledge = vi.fn(async (r) => ({ ...r, durability: 'durable' as const }));
  const ex = new FlowChartExecutor(plain(), { ...enabled, sink: { adapter: sink, capture: { acknowledge } } });
  ex.setRedactionPolicy({ keys: ['extentId'] });
  await ex.run();
  expect(ex.getSnapshot({ redact: true }).captureExtent).toEqual(ex.getSnapshot().captureExtent);
  expect(ex.getSnapshot().sink?.capture).toEqual({ status: 'unknown', reason: 'extent-evidence-refused' });
  expect(acknowledge).not.toHaveBeenCalled();
  expect(sink.entries.some((entry) => entry.kind === 'note' && entry.note === 'capture-receipt')).toBe(false);
});

it('persists the exact unverified sidecar through real file durability and JSON reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fp-extent-'));
  const sink = fileSink(join(directory, 'record.jsonl'));
  try {
    const original = new Error('failure');
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
        ...enabled,
        sink: { adapter: sink, capture: sink },
      },
    );
    await expect(ex.run()).rejects.toBe(original);
    expect(ex.getSnapshot().sink?.capture?.status).toBe('acknowledged');
    const { entries, unreadable } = readRecordFile(sink.path);
    expect(unreadable).toEqual([]);
    const result = await readStoredCapture(JSON.parse(JSON.stringify(entries)), { runId: ex.getSnapshot().runId });
    expect(result.status).toBe('acknowledged');
    expect(result.history?.captureExtent).toEqual(ex.getSnapshot().captureExtent);
    expect(result.history?.captureExtent?.status).toBe('unverified');
    expect(result.history?.capture.boundary.status).toBe('failed');
    const changed = JSON.parse(JSON.stringify(entries));
    changed.find((entry: any) => entry.note === 'capture-history').data.captureExtent.extentId = 'other';
    expect(await readStoredCapture(changed, { runId: ex.getSnapshot().runId })).toEqual({
      status: 'unknown',
      reason: 'evidence-mismatch',
    });
  } finally {
    await sink.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
