/**
 * A failing sink never stops the run — unless the app asked it to (design §3.5, owner ruling Q3).
 *
 * WHY: the record's law is "the run goes on". A sink that throws, rejects, or cannot flush is counted on
 * `getSnapshot().sink` (with a dev-mode warning) and the run finishes as it would have. `onFailure: 'fail'` is the
 * opt-in for an app whose record IS the product: the first lost entry fails the run with a `RecordSinkError`.
 *
 * Test types: Boundary (a throwing method, a rejecting method, a rejecting flush, a flush that never settles, a
 * malformed sink option, the adapter's own `onFailure` throwing) · Functional (`'fail'` mid-run and at the end).
 */
import type { RecordEntry, RecordSink } from 'foottrace/write';
import { memorySink } from 'foottrace/write';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { disableDevMode, enableDevMode, flowChart, FlowChartExecutor, RecordSinkError } from '../../../../src/index.js';

type S = Record<string, any>;

function chart(stages = 2) {
  let builder = flowChart<S>(
    'S0',
    (s) => {
      s.n = 0;
    },
    's0',
  );
  for (let i = 1; i < stages; i++) {
    builder = builder.addFunction(
      `S${i}`,
      async (s) => {
        await Promise.resolve();
        s.n = i;
      },
      `s${i}`,
    );
  }
  return builder.build();
}

/** A memory sink whose `kind` method misbehaves as `how` says. */
function breaking(
  kind: RecordEntry['kind'],
  how: 'throw' | 'reject',
): RecordSink & { entries: readonly RecordEntry[] } {
  const inner = memorySink();
  const broken = (e: any) => {
    if (how === 'throw') throw new Error(`${kind} refused`);
    return Promise.reject(new Error(`${kind} refused`));
  };
  return {
    get entries() {
      return inner.entries;
    },
    opened: kind === 'opened' ? broken : (e) => inner.opened(e),
    commit: kind === 'commit' ? broken : (e) => inner.commit(e),
    note: kind === 'note' ? broken : (e) => inner.note(e),
    closed: kind === 'closed' ? broken : (e) => inner.closed(e),
    flush: () => inner.flush!(),
  };
}

afterEach(() => {
  disableDevMode();
  vi.restoreAllMocks();
});

describe("onFailure: 'report' (the default) — the run goes on", () => {
  it.each(['opened', 'commit', 'closed'] as const)('a %s that throws is counted, never thrown', async (kind) => {
    const executor = new FlowChartExecutor(chart(3), { sink: breaking(kind, 'throw') });
    const result = await executor.run();
    expect(result).toBeUndefined();
    expect(executor.getSnapshot().sharedState.n).toBe(2);
    const stats = executor.getSnapshot().sink!;
    expect(stats.failed).toBe(kind === 'commit' ? 3 : 1);
    expect(stats.lastError).toBe(`Error: ${kind} refused`);
  });

  it('a rejected promise is counted when it settles — by the time run() resolves', async () => {
    const executor = new FlowChartExecutor(chart(2), { sink: breaking('commit', 'reject') });
    await executor.run();
    expect(executor.getSnapshot().sink).toMatchObject({ failed: 2, lastError: 'Error: commit refused' });
  });

  it('a flush that rejects is counted; run() still resolves', async () => {
    const sink = { ...memorySink(), flush: () => Promise.reject(new Error('disk gone')) };
    const executor = new FlowChartExecutor(chart(2), { sink });
    await expect(executor.run()).resolves.toBeUndefined();
    expect(executor.getSnapshot().sink).toMatchObject({ failed: 1, lastError: 'Error: disk gone' });
  });

  it('dev mode warns ONCE per run, naming the failure, never the entry', async () => {
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const executor = new FlowChartExecutor(chart(3), { sink: breaking('commit', 'throw') });
    await executor.run();
    const sinkWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('record sink'));
    expect(sinkWarnings).toHaveLength(1);
    expect(String(sinkWarnings[0][0])).toContain('commit refused');
  });

  it("the adapter's own onFailure hears each loss; one that throws changes nothing", async () => {
    const heard: string[] = [];
    const sink = {
      ...breaking('commit', 'throw'),
      onFailure: ({ entry }: { entry: RecordEntry }) => {
        heard.push(entry.kind);
        throw new Error('listener broke');
      },
    };
    const executor = new FlowChartExecutor(chart(2), { sink });
    await executor.run();
    expect(heard).toEqual(['commit', 'commit']);
    expect(executor.getSnapshot().sink?.failed).toBe(2);
  });

  it('flushRecord({ timeoutMs }) reports a flush still pending at the deadline; the run itself never waits', async () => {
    const sink = { ...memorySink(), flush: () => new Promise<void>(() => {}) };
    const executor = new FlowChartExecutor(chart(2), { sink: { adapter: sink, flush: 'manual' } });
    await executor.run();
    await expect(executor.flushRecord({ timeoutMs: 20 })).resolves.toEqual({
      done: false,
      failed: false,
      pending: true,
    });
  });

  it('flushRecord() reports a rejected flush as failed, and counts it', async () => {
    const sink = { ...memorySink(), flush: () => Promise.reject(new Error('no space')) };
    const executor = new FlowChartExecutor(chart(1), { sink: { adapter: sink, flush: 'manual' } });
    await executor.run();
    await expect(executor.flushRecord()).resolves.toEqual({ done: false, failed: true, pending: false });
    expect(executor.getSnapshot().sink).toMatchObject({ failed: 1, lastError: 'Error: no space' });
  });
});

describe("onFailure: 'fail' — the first lost entry fails the run", () => {
  it('a commit that is lost mid-run rejects run() with a RecordSinkError carrying the cause', async () => {
    const executor = new FlowChartExecutor(chart(4), {
      sink: { adapter: breaking('commit', 'throw'), onFailure: 'fail' },
    });
    const error = await executor.run().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RecordSinkError);
    expect((error as RecordSinkError).cause).toBeInstanceOf(Error);
    expect(((error as RecordSinkError).cause as Error).message).toBe('commit refused');
    // The run stopped at the next stage boundary: not every stage ran.
    expect(executor.getSnapshot().sharedState.n).toBeLessThan(3);
  });

  it('a lost closing entry or a failed flush rejects the finished run', async () => {
    const closing = new FlowChartExecutor(chart(2), {
      sink: { adapter: breaking('closed', 'throw'), onFailure: 'fail' },
    });
    await expect(closing.run()).rejects.toBeInstanceOf(RecordSinkError);

    const flushing = new FlowChartExecutor(chart(2), {
      sink: { adapter: { ...memorySink(), flush: () => Promise.reject(new Error('fsync failed')) }, onFailure: 'fail' },
    });
    await expect(flushing.run()).rejects.toThrow(/fsync failed/);
  });

  it('a run that fails on its own keeps its own error', async () => {
    const failing = flowChart<S>(
      'Boom',
      () => {
        throw new Error('stage broke');
      },
      'boom',
    ).build();
    const executor = new FlowChartExecutor(failing, {
      sink: { adapter: breaking('closed', 'throw'), onFailure: 'fail' },
    });
    await expect(executor.run()).rejects.toThrow('stage broke');
  });
});

describe('the sink option is checked at construction', () => {
  it.each([
    ['null', null],
    ['a string', '/tmp/x'],
    ['missing methods', { opened() {}, commit() {} }],
    ['an adapter with a missing method', { adapter: { opened() {}, commit() {}, note() {} } }],
    ['an unknown failure mode', { adapter: memorySink(), onFailure: 'ignore' }],
    ['an unknown flush mode', { adapter: memorySink(), flush: 'never' }],
  ])('refuses %s with a TypeError', (_name, sink) => {
    expect(() => new FlowChartExecutor(chart(1), { sink: sink as never })).toThrow(TypeError);
  });
});
