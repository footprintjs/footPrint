/**
 * Every mount's own log, on every path (design §3.5, packet P6; the code review's gaps).
 *
 * WHY: a subflow runs on its own isolated runtime and log, so the crash-safe record is only whole if EVERY mount —
 * eager, lazy, a `parallelForEach` branch, a mount inside a mount, a mount that paused — opens its own log at its
 * own address and closes it. And the failure mode is per leg: a loss in one leg must not stop a later resume.
 *
 * Test types: Scenario (a two-deep mount, a lazy mount, `parallelForEach` branches, a pause inside a subflow and its
 * same-executor resume, a mount after the pause in a resumed leg) · Boundary (`onFailure: 'fail'` across a resume).
 */
import { readStoredRecord } from 'foottrace';
import type { RecordEntry } from 'foottrace/write';
import { memorySink } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import type { PausableHandler } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor, RecordSinkError } from '../../../../src/index.js';

type S = Record<string, any>;

/** Every log the sink saw, as `drillPath joined → [kinds…]`. */
function logsOf(entries: readonly RecordEntry[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of entries) {
    const key = e.address.drillPath.join('/');
    out.set(key, [...(out.get(key) ?? []), e.kind === 'closed' ? `closed:${e.outcome}` : e.kind]);
  }
  return out;
}

const leaf = (id: string) =>
  flowChart<S>(
    'Leaf',
    (s) => {
      s[id] = 1;
    },
    id,
  ).build();

describe('every mount writes its own log, opened and closed', () => {
  it('a mount two deep: its log sits at [outer mount, inner mount]', async () => {
    const middle = flowChart<S>(
      'Middle',
      (s) => {
        s.m = 1;
      },
      'middle',
    )
      .addSubFlowChartNext('sf-leaf', leaf('deep'), 'Leaf', { inputMapper: () => ({}) })
      .build();
    const chart = flowChart<S>(
      'Top',
      (s) => {
        s.t = 1;
      },
      'top',
    )
      .addSubFlowChartNext('sf-middle', middle, 'Middle', { inputMapper: () => ({}) })
      .build();
    const sink = memorySink();
    const executor = new FlowChartExecutor(chart, { sink });
    await executor.run();
    const deep = sink.entries.filter((e) => e.address.drillPath.length === 2);
    expect(deep.map((e) => e.kind)).toEqual(['opened', 'commit', 'closed']);
    expect(deep[0].address.drillPath[0]).toMatch(/^sf-middle#\d+$/);
    expect(deep[0].address.drillPath[1]).toMatch(/^sf-middle\/sf-leaf#\d+$/);
    expect(deep.at(-1)).toMatchObject({ outcome: 'ok' });
    const logs = logsOf(sink.entries);
    for (const kinds of logs.values()) expect(kinds.at(-1)).toBe('closed:ok');
    // The stored record reads the deep mount at the same address the live snapshot names.
    const live = Object.values(executor.getSnapshot().subflowResults ?? {}).map((r: any) => r.treeContext.logAddress);
    for (const address of live) expect(readStoredRecord(sink.entries).log(address)?.complete).toBe(true);
  });

  it('a lazy mount and each parallelForEach branch get their own log, each closed ok', async () => {
    const chart = flowChart<S>(
      'Items',
      (s) => {
        s.items = [1, 2, 3];
      },
      'items',
    )
      .addLazySubFlowChartNext('lazy', () => leaf('lazyLeaf'), 'Lazy')
      .addParallelForEach('Each', 'each', {
        items: (s: S) => s.items,
        branch: () => leaf('b'),
        into: 'out',
        maxBranches: 3,
      })
      .build();
    const sink = memorySink();
    const executor = new FlowChartExecutor(chart, { sink });
    await executor.run();
    const logs = logsOf(sink.entries);
    const mounts = [...logs.keys()].filter((k) => k !== '');
    expect(mounts.some((k) => k.startsWith('lazy#'))).toBe(true);
    expect(mounts.filter((k) => k.startsWith('each~'))).toHaveLength(3);
    for (const k of mounts) expect(logs.get(k)?.at(-1)).toBe('closed:ok');
    expect(logs.get('')?.at(-1)).toBe('closed:ok');
  });

  it('a pause inside a subflow closes that mount paused; the resume re-enters on a NEW mount log, closed ok', async () => {
    const inner = flowChart<S>(
      'Ask',
      (s) => {
        s.asked = true;
      },
      'ask',
    )
      .addPausableFunction(
        'Approve',
        {
          execute: async () => ({ question: 'ok?' }),
          resume: async (s: S) => {
            s.ok = true;
          },
        } as PausableHandler<S, unknown>,
        'approve',
      )
      .build();
    const chart = flowChart<S>(
      'Start',
      (s) => {
        s.started = true;
      },
      'start',
    )
      .addSubFlowChartNext('sf', inner, 'Sf', { inputMapper: () => ({}) })
      .build();
    const sink = memorySink();
    const executor = new FlowChartExecutor(chart, { sink });
    await executor.run();
    const paused = logsOf(sink.entries);
    const firstMount = [...paused.keys()].find((k) => k !== '')!;
    expect(paused.get(firstMount)?.at(-1)).toBe('closed:paused');
    expect(paused.get('')?.at(-1)).toBe('closed:paused');

    await executor.resume(executor.getCheckpoint()!, {});
    const after = logsOf(sink.entries);
    const secondMount = [...after.keys()].find((k) => k !== '' && k !== firstMount)!;
    expect(secondMount).toBeDefined();
    expect(after.get(secondMount)?.at(-1)).toBe('closed:ok');
    expect(after.get('')?.at(-1)).toBe('closed:ok');
    const record = readStoredRecord(sink.entries);
    for (const log of record.logs.values()) expect(log.complete).toBe(true);
  });

  it("a mount in a same-executor resumed leg sits under the ROOT log's logRunId (the stored leg is one record)", async () => {
    // Named in the P6 addendum (#2): a PLAIN log binds lazily with the current leg's runId; with a sink, a mount's
    // address is its parent LOG's plus the mount, so readStoredRecord drills to it from the one stored root.
    const chart = flowChart<S>(
      'Receive',
      (s) => {
        s.step = 1;
      },
      'receive',
    )
      .addPausableFunction(
        'Approve',
        {
          execute: async () => ({ question: 'ok?' }),
          resume: async (s: S) => {
            s.ok = true;
          },
        } as PausableHandler<S, unknown>,
        'approve',
      )
      .addSubFlowChartNext('sf-after', leaf('after'), 'After', { inputMapper: () => ({}) })
      .build();
    const sink = memorySink();
    const executor = new FlowChartExecutor(chart, { sink });
    await executor.run();
    const firstRunId = executor.getSnapshot().runId;
    await executor.resume(executor.getCheckpoint()!, {});
    const mount = sink.entries.find((e) => e.address.drillPath.length === 1)!;
    expect(mount.address.logRunId).toBe(firstRunId);
    const root = readStoredRecord(sink.entries).root(firstRunId)!;
    expect(Object.keys(root.source().subflowResults ?? {})).toContain(mount.address.drillPath[0]);
  });
});

describe("onFailure: 'fail' is per leg", () => {
  it('a loss that failed the paused leg does not stop a later same-executor resume', async () => {
    let flushes = 0;
    const inner = memorySink();
    const adapter = {
      opened: (e: any) => inner.opened(e),
      commit: (e: any) => inner.commit(e),
      note: (e: any) => inner.note(e),
      closed: (e: any) => inner.closed(e),
      flush: () => (++flushes === 1 ? Promise.reject(new Error('first flush failed')) : Promise.resolve()),
    };
    const chart = flowChart<S>(
      'Receive',
      (s) => {
        s.step = 1;
      },
      'receive',
    )
      .addPausableFunction(
        'Approve',
        {
          execute: async () => ({ question: 'ok?' }),
          resume: async (s: S) => {
            s.ok = true;
          },
        } as PausableHandler<S, unknown>,
        'approve',
      )
      .build();
    const executor = new FlowChartExecutor(chart, { sink: { adapter, onFailure: 'fail' } });
    // Leg 1 paused, then its flush failed: the leg rejects (the checkpoint is still there to resume from).
    await expect(executor.run()).rejects.toBeInstanceOf(RecordSinkError);
    expect(executor.getCheckpoint()).toBeDefined();
    // Leg 2 runs under its own failure mode and finishes.
    await executor.resume(executor.getCheckpoint()!, {});
    expect(executor.getSnapshot().sharedState.ok).toBe(true);
    expect(executor.getSnapshot().sink).toMatchObject({ failed: 1 });
  });
});
