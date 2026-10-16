/**
 * The crash-safe record, wired (design §3.5, packet P6) — what a run hands its sink, log by log.
 *
 * WHY: an in-memory log dies with its process, and the record of a run that never finished is exactly the one
 * that goes missing. With `new FlowChartExecutor(chart, { sink })` every log of the run — the root and each
 * subflow mount — hands its entries to the sink AS THEY LAND (foottrace 1.1.0's port): `opened` with its base,
 * `commit` per bundle, `note` per attempt that ended, `closed` with how it ended. `readStoredRecord` reads them back
 * into the same log the live snapshot holds.
 *
 * Test types: Scenario (a linear run, a subflow (deeper mounts: record-sink-mounts.test.ts), a failing run, a pause with a same-executor and a fresh-
 * executor resume, a retried stage and a `$call`, read back through `readStoredRecord`) · Functional (the lifecycle
 * meta, `getSnapshot().sink`, the flush modes and `flushRecord`) · Boundary (no sink → no key, byte-identical log).
 */
import { readStoredRecord, stateAt } from 'foottrace';
import type { RecordEntry, RecordSink } from 'foottrace/write';
import { memorySink } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import type { PausableHandler } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';

type S = Record<string, any>;

const kinds = (entries: readonly RecordEntry[]) => entries.map((e) => e.kind);
const ofLog = (entries: readonly RecordEntry[], drillPath: readonly string[]) =>
  entries.filter((e) => JSON.stringify(e.address.drillPath) === JSON.stringify(drillPath));

function linearChart() {
  return flowChart<S>(
    'Seed',
    (s) => {
      s.n = 1;
      s.items = ['a'];
    },
    'seed',
  )
    .addFunction(
      'Grow',
      (s) => {
        s.n = s.n + 1;
        s.items = [...s.items, 'b'];
      },
      'grow',
    )
    .build();
}

function innerChart() {
  return flowChart<S>(
    'Inner',
    (s) => {
      s.inner = (s.seed ?? 0) + 1;
    },
    'inner',
  ).build();
}

function mountingChart() {
  return flowChart<S>(
    'Start',
    (s) => {
      s.seed = 41;
    },
    'start',
  )
    .addSubFlowChartNext('sf-inner', innerChart(), 'Inner flow', {
      inputMapper: (p: S) => ({ seed: p.seed }),
      outputMapper: (o: S) => ({ fromInner: o.inner }),
    })
    .build();
}

function pauseChart() {
  return flowChart<S>(
    'Receive',
    (s) => {
      s.step = 1;
    },
    'receive',
  )
    .addPausableFunction(
      'Approve',
      {
        execute: async () => ({ question: 'Approve?' }),
        resume: async (s: S, input: unknown) => {
          s.approved = (input as { approved: boolean }).approved;
        },
      } as PausableHandler<S, { approved: boolean }>,
      'approve',
    )
    .addFunction(
      'Process',
      (s) => {
        s.done = true;
      },
      'process',
    )
    .build();
}

describe('the record sink — a linear run', () => {
  it('opens the root log with the run, lands each commit, closes it ok — and reads back as the live log', async () => {
    const sink = memorySink();
    const executor = new FlowChartExecutor(linearChart(), { sink });
    await executor.run();
    const snapshot = executor.getSnapshot();
    const entries = sink.entries;

    expect(kinds(entries)).toEqual(['opened', 'commit', 'commit', 'closed']);
    const opened = entries[0] as Extract<RecordEntry, { kind: 'opened' }>;
    expect(opened.address).toEqual({ logRunId: snapshot.runId, drillPath: [] });
    expect(opened.meta).toEqual({ runId: snapshot.runId, chart: { id: 'seed', name: 'Seed' } });
    const closed = entries[3] as Extract<RecordEntry, { kind: 'closed' }>;
    expect(closed.outcome).toBe('ok');
    expect(closed.commits).toBe(2);
    expect(closed.meta).toEqual({ runId: snapshot.runId });

    // The address the sink was told is the log's own: the snapshot names the same one.
    expect(snapshot.logAddress).toEqual(opened.address);

    const stored = readStoredRecord(entries).root(snapshot.runId)!;
    expect(stored.complete).toBe(true);
    expect(stored.outcome).toBe('ok');
    expect(stored.gaps).toEqual([]);
    expect(JSON.parse(JSON.stringify(stored.commitLog))).toEqual(JSON.parse(JSON.stringify(snapshot.commitLog)));
    expect(stateAt(stored.source(), stored.commitLog.length - 1).state).toEqual(snapshot.sharedState);
  });

  it('getSnapshot().sink counts what the sink was handed; absent without a sink', async () => {
    const executor = new FlowChartExecutor(linearChart(), { sink: memorySink() });
    expect(executor.getSnapshot().sink).toBeUndefined(); // nothing ran yet
    await executor.run();
    expect(executor.getSnapshot().sink).toEqual({ entries: 4, failed: 0 });

    const plain = new FlowChartExecutor(linearChart());
    await plain.run();
    expect(Object.hasOwn(plain.getSnapshot(), 'sink')).toBe(false);
  });

  it('a run with a sink records the same log and tree bytes as one without', async () => {
    // The clock is the one thing two runs never share: a flow message's `timestamp` is settled, nothing else.
    const strip = (snap: ReturnType<FlowChartExecutor['getSnapshot']>) =>
      JSON.parse(
        JSON.stringify({ log: snap.commitLog, tree: snap.executionTree, state: snap.sharedState }, (key, value) =>
          key === 'timestamp' ? '«time»' : value,
        ),
      );
    const withSink = new FlowChartExecutor(linearChart(), { sink: memorySink() });
    await withSink.run();
    const without = new FlowChartExecutor(linearChart());
    await without.run();
    expect(strip(withSink.getSnapshot())).toEqual(strip(without.getSnapshot()));
  });

  it('a fresh run() opens a new root log under its own runId', async () => {
    const sink = memorySink();
    const executor = new FlowChartExecutor(linearChart(), { sink });
    await executor.run();
    const first = executor.getSnapshot().runId;
    await executor.run();
    const second = executor.getSnapshot().runId;
    const record = readStoredRecord(sink.entries);
    expect(record.root(first)?.complete).toBe(true);
    expect(record.root(second)?.complete).toBe(true);
    expect(executor.getSnapshot().sink).toEqual({ entries: 4, failed: 0 }); // per run
  });
});

describe('the record sink — subflows', () => {
  it('each mount writes its own log at [mount runtimeStageId], opened and closed, read back as the live mount', async () => {
    const sink = memorySink();
    const executor = new FlowChartExecutor(mountingChart(), { sink });
    await executor.run();
    const snapshot = executor.getSnapshot();
    const mountId = Object.keys(snapshot.subflowResults!).find((k) => k.includes('#'))!;
    const live = (snapshot.subflowResults![mountId] as any).treeContext;

    const nested = ofLog(sink.entries, [mountId]);
    expect(kinds(nested)).toEqual(['opened', 'commit', 'commit', 'closed']);
    expect(nested[0].address).toEqual({ logRunId: snapshot.runId, drillPath: [mountId] });
    expect(live.logAddress).toEqual(nested[0].address);
    expect((nested[0] as any).meta).toEqual({ subflowId: 'sf-inner' });
    expect((nested[3] as any).outcome).toBe('ok');

    const record = readStoredRecord(sink.entries);
    const storedMount = record.log({ logRunId: snapshot.runId, drillPath: [mountId] })!;
    expect(storedMount.complete).toBe(true);
    expect(JSON.parse(JSON.stringify(storedMount.commitLog))).toEqual(JSON.parse(JSON.stringify(live.history)));
    // The root's own log closes last, after its mount's.
    expect(sink.entries[sink.entries.length - 1]).toMatchObject({ kind: 'closed', address: { drillPath: [] } });
  });
});

describe('the record sink — how a run ends', () => {
  it('a failing run closes its log failed, with the served error; a failing mount closes failed too', async () => {
    const failing = flowChart<S>(
      'Start',
      (s) => {
        s.a = 1;
      },
      'start',
    )
      .addSubFlowChartNext(
        'sf-bad',
        flowChart<S>(
          'Bad',
          () => {
            throw new Error('inner broke');
          },
          'bad',
        ).build(),
        'Bad flow',
      )
      .build();
    const sink = memorySink();
    const executor = new FlowChartExecutor(failing, { sink, throttlingErrorChecker: () => false });
    await expect(executor.run()).rejects.toThrow('inner broke');
    const runId = executor.getSnapshot().runId;
    const record = readStoredRecord(sink.entries);
    const root = record.root(runId)!;
    expect(root.complete).toBe(true);
    expect(root.outcome).toBe('failed');
    expect(root.meta.closed).toEqual({ runId, error: { name: 'Error', message: 'inner broke' } });
    const mount = [...record.logs.values()].find((l) => l.address.drillPath.length === 1)!;
    expect(mount.outcome).toBe('failed');
  });

  it('a run refused after its root log opened (a bad maxDepth) closes that log failed — never left looking crashed', async () => {
    const sink = memorySink();
    const executor = new FlowChartExecutor(linearChart(), { sink });
    await expect(executor.run({ maxDepth: 0 })).rejects.toThrow(/maxDepth/);
    const [root] = [...readStoredRecord(sink.entries).logs.values()];
    expect(root.complete).toBe(true);
    expect(root.outcome).toBe('failed');
    expect(root.commitLog).toHaveLength(0);
  });

  it('a pause closes the log paused; a same-executor resume continues the SAME log, notes the leg, closes ok', async () => {
    const sink = memorySink();
    const executor = new FlowChartExecutor(pauseChart(), { sink });
    await executor.run();
    const pausedRunId = executor.getSnapshot().runId;
    expect(readStoredRecord(sink.entries).root(pausedRunId)?.outcome).toBe('paused');

    await executor.resume(executor.getCheckpoint()!, { approved: true });
    const snapshot = executor.getSnapshot();
    const resumedRunId = snapshot.runId;
    expect(resumedRunId).not.toBe(pausedRunId);

    const root = readStoredRecord(sink.entries).root(pausedRunId)!;
    expect(root.complete).toBe(true);
    expect(root.outcome).toBe('ok');
    expect(root.meta.closed).toEqual({ runId: resumedRunId });
    expect(root.notes.map((n) => n.kind)).toEqual(['resume']);
    expect(root.notes[0].data).toEqual({ runId: resumedRunId, resumedFrom: pausedRunId });
    expect(JSON.parse(JSON.stringify(root.commitLog))).toEqual(JSON.parse(JSON.stringify(snapshot.commitLog)));
    expect(stateAt(root.source(), root.commitLog.length - 1).state).toEqual(snapshot.sharedState);
    // One log, one address: the resumed leg opened nothing new.
    expect(sink.entries.filter((e) => e.kind === 'opened')).toHaveLength(1);
  });

  it('a fresh-executor resume opens a NEW root log under its own runId, naming the run it resumed', async () => {
    const first = new FlowChartExecutor(pauseChart(), { sink: memorySink() });
    await first.run();
    const checkpoint = first.getCheckpoint()!;
    const pausedRunId = first.getSnapshot().runId;

    const sink = memorySink();
    const second = new FlowChartExecutor(pauseChart(), { sink });
    await second.resume(checkpoint, { approved: true });
    const runId = second.getSnapshot().runId;
    const root = readStoredRecord(sink.entries).root(runId)!;
    expect(root.complete).toBe(true);
    expect(root.meta.opened).toEqual({
      runId,
      chart: { id: 'receive', name: 'Receive' },
      resumedFrom: pausedRunId,
    });
    expect(root.initialState).toEqual(checkpoint.sharedState);
  });
});

describe('the record sink — attempts are noted as each one ends', () => {
  it("a retried stage's attempts and a $call's attempts land as 'attempt' notes, in order, before the commit", async () => {
    let tries = 0;
    const chart = flowChart<S>(
      'Fetch',
      async (s) => {
        tries += 1;
        if (tries < 3) throw Object.assign(new Error(`busy ${tries}`), { status: 503 });
        s.rate = await s.$call('rates.lookup', () => 1.09);
      },
      'fetch',
    )
      .retry({ attempts: 3, backoffMs: 0 })
      .build();
    const sink = memorySink();
    const executor = new FlowChartExecutor(chart, { sink });
    await executor.run();
    const snapshot = executor.getSnapshot();
    const tree = snapshot.executionTree as any;

    const root = readStoredRecord(sink.entries).root(snapshot.runId)!;
    const noted = root.notes.filter((n) => n.kind === 'attempt').map((n) => (n.data as any).record);
    // Every record the tree keeps, noted once each — the stage's three and its one call.
    expect(noted).toHaveLength(tree.attempts.length);
    expect(noted.map((r: any) => [r.kind, r.attempt, r.outcome])).toEqual(
      tree.attempts.map((r: any) => [r.kind, r.attempt, r.outcome]),
    );
    expect(JSON.parse(JSON.stringify(noted))).toEqual(JSON.parse(JSON.stringify(tree.attempts)));
    // The notes land as the attempts end — every one before the stage's commit.
    const order = ofLog(sink.entries, []).map((e) => e.kind);
    expect(order.lastIndexOf('note')).toBeLessThan(order.indexOf('commit'));
  });

  it('without a sink, nothing is noted and the tree is unchanged', async () => {
    const chart = flowChart<S>(
      'Once',
      (s) => {
        s.ok = true;
      },
      'once',
    )
      .retry({ attempts: 2 })
      .build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect((executor.getSnapshot().executionTree as any).attempts).toHaveLength(1);
  });
});

describe('the record sink — flushing', () => {
  function countingSink(): RecordSink & { flushes: number; entries: RecordEntry[] } {
    const inner = memorySink();
    const out = {
      flushes: 0,
      get entries() {
        return inner.entries as RecordEntry[];
      },
      opened: (e: any) => inner.opened(e),
      commit: (e: any) => inner.commit(e),
      note: (e: any) => inner.note(e),
      closed: (e: any) => inner.closed(e),
      flush: async () => {
        out.flushes += 1;
      },
    };
    return out;
  }

  it('run() awaits the adapter’s flush once, after the closing entry (the default)', async () => {
    const sink = countingSink();
    const executor = new FlowChartExecutor(linearChart(), { sink });
    await executor.run();
    expect(sink.flushes).toBe(1);
  });

  it("flush: 'manual' leaves it to flushRecord()", async () => {
    const sink = countingSink();
    const executor = new FlowChartExecutor(linearChart(), { sink: { adapter: sink, flush: 'manual' } });
    await executor.run();
    expect(sink.flushes).toBe(0);
    await expect(executor.flushRecord()).resolves.toEqual({ done: true, failed: false, pending: false });
    expect(sink.flushes).toBe(1);
  });

  it('flushRecord() without a sink, or with an adapter that has no flush, is done at once', async () => {
    const plain = new FlowChartExecutor(linearChart());
    await expect(plain.flushRecord()).resolves.toEqual({ done: true, failed: false, pending: false });
    const bare = memorySink() as RecordSink;
    const executor = new FlowChartExecutor(linearChart(), { sink: { ...bare, flush: undefined } as RecordSink });
    await executor.run();
    await expect(executor.flushRecord()).resolves.toEqual({ done: true, failed: false, pending: false });
  });
});
