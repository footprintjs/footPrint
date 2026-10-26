/** Real-engine saved-history proofs. Source selection is not semantic derivation or a root-cause verdict. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseAttemptId } from 'foottrace';
import { memorySink } from 'foottrace/write';
import { expect, it } from 'vitest';

import { type FlowChart, type FlowChartExecutorOptions, flowChart, FlowChartExecutor } from '../../../src/index.js';
import type { EngineReadSources } from '../../../src/lib/capture/readSources.js';
import { fileSink, readRecordFile } from '../../../src/sinks.js';
import { type StoredCaptureHistory, readStoredCapture } from '../../../src/trace.js';

type State = { n?: number; out?: number; missing?: number; secret?: string };

const sequential = () =>
  flowChart<State>(
    'Increment',
    (s) => {
      s.n = s.n! + 1;
    },
    'increment',
  )
    .addFunction(
      'Consume',
      (s) => {
        s.out = s.n;
      },
      'consume',
    )
    .build();

const sources = (history: StoredCaptureHistory) =>
  (history as StoredCaptureHistory & { readonly readSources?: EngineReadSources }).readSources!;

async function save(
  flow: FlowChart = sequential(),
  options: FlowChartExecutorOptions = {},
  configure?: (executor: FlowChartExecutor) => void,
  failure?: string,
) {
  const directory = mkdtempSync(join(tmpdir(), 'durable-source-proof-'));
  const sink = fileSink(join(directory, 'run.jsonl'));
  const executor = new FlowChartExecutor(flow, {
    initialContext: { n: 4 },
    captureCoverage: true,
    readSources: true,
    writeProvenance: 'reads-prefix',
    ...options,
    sink: { adapter: sink, capture: sink },
  });
  try {
    configure?.(executor);
    if (failure) await expect(executor.run()).rejects.toThrow(failure);
    else await executor.run();
    const snapshot = executor.getSnapshot();
    await sink.close();
    const loaded = readRecordFile(sink.path);
    expect(loaded.unreadable).toEqual([]);
    // The reader receives only plain stored JSON, not the executor or its live source book.
    const entries = JSON.parse(JSON.stringify(loaded.entries)) as any[];
    const result = await readStoredCapture(entries, { runId: snapshot.runId });
    return { entries, result, snapshot, runId: snapshot.runId };
  } finally {
    await sink.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

it('reloads exact base and committed reads from a real file, with a separate durable receipt', async () => {
  const { result, snapshot } = await save();
  expect(snapshot.sharedState.out).toBe(5);
  expect(result.status).toBe('acknowledged');
  const history = result.history!;
  const evidence = sources(history);
  expect(evidence).toEqual(snapshot.readSources);
  expect(evidence.persistence).toBe('memory-only');
  expect(history.capture.persistence).toBe('memory-only');
  expect(history.capture).toMatchObject({ version: 2, channels: { readSources: 'captured' } });
  expect(history.receipt.durability).toBe('durable');
  expect(evidence.record!.occurrences.map((row) => row.source.kind)).toEqual(['base', 'committed']);
  expect(evidence.record!.occurrences[1]!.source).toEqual({ kind: 'committed', commitIdx: 0 });
  expect(history.initialState!.n).toBe(4);
  expect(history.commitLog[0]!.overwrite.n).toBe(5);
});

it('keeps the failed boundary and its actual failed-step identity alongside the received committed source', async () => {
  const failure = 'synthetic downstream refusal';
  const flow = flowChart<State>(
    'Prepare',
    (s) => {
      s.n = s.n! + 1;
    },
    'prepare',
  )
    .addFunction(
      'Reject',
      (s) => {
        const n = s.n;
        throw new Error(failure);
      },
      'reject',
    )
    .build();
  const { result, snapshot, runId } = await save(flow, {}, undefined, failure);
  expect(snapshot.sharedState.n).toBe(5);
  expect(result.status).toBe('acknowledged');
  const evidence = sources(result.history!);
  const received = evidence.record!.occurrences[1]!;
  expect(received.source).toEqual({ kind: 'committed', commitIdx: 0 });
  expect(result.history!.capture.boundary).toMatchObject({
    status: 'failed',
    failure: { stage: { runId, runtimeStageId: received.runtimeStageId } },
  });
  // A durably stored failure is still failed. Receiving a value is not proof it caused that failure.
});

it('does not turn a closed file prefix into storage proof when its receipt is missing', async () => {
  const { entries, runId } = await save();
  const withoutReceipt = entries.filter((entry) => !(entry.kind === 'note' && entry.note === 'capture-receipt'));
  expect(await readStoredCapture(withoutReceipt, { runId })).toEqual({ status: 'unknown', reason: 'receipt-missing' });
});

it('does not call durable acknowledgement when source evidence delivery failed', async () => {
  const memory = memorySink();
  let acknowledgements = 0;
  const adapter = {
    ...memory,
    note: (entry: Parameters<typeof memory.note>[0]) => {
      if (entry.kind === 'capture-history') throw new Error('synthetic evidence delivery loss');
      memory.note(entry);
    },
  };
  const executor = new FlowChartExecutor(sequential(), {
    initialContext: { n: 4 },
    captureCoverage: true,
    readSources: true,
    sink: {
      adapter,
      capture: {
        acknowledge: async (target) => {
          acknowledgements++;
          return { ...target, durability: 'durable' };
        },
      },
    },
  });
  await executor.run();
  expect(executor.getSnapshot().sharedState.out).toBe(5);
  expect(executor.getSnapshot().sink!.capture!.status).toBe('unknown');
  expect(acknowledgements).toBe(0);
  const restored = await readStoredCapture(JSON.parse(JSON.stringify(memory.entries)), {
    runId: executor.getSnapshot().runId,
  });
  expect(restored.status).toBe('unknown');
  expect(restored).not.toHaveProperty('history');
});

it.each(['missing-commit', 'missing-evidence', 'crash-prefix', 'reader-limit'])(
  'keeps %s incomplete after reload',
  async (missing) => {
    const { entries, runId } = await save();
    const changed =
      missing === 'missing-commit'
        ? entries.filter((entry) => entry.kind !== 'commit')
        : missing === 'missing-evidence'
        ? entries.filter((entry) => !(entry.kind === 'note' && entry.note === 'capture-history'))
        : missing === 'crash-prefix'
        ? entries.slice(
            0,
            entries.findIndex((entry) => entry.kind === 'closed'),
          )
        : entries;
    const result = await readStoredCapture(changed, {
      runId,
      ...(missing === 'reader-limit' && { limits: { entries: 2 } }),
    });
    expect(result.status).toBe('unknown');
    expect(result).not.toHaveProperty('history');
  },
);

it('keeps an absent read and write, without inventing an exact source for the absent read', async () => {
  const flow = flowChart<State>(
    'Missing',
    (s) => {
      s.out = s.missing ?? 0;
      s.missing = undefined;
    },
    'missing',
  ).build();
  const { result, snapshot } = await save(flow);
  expect(snapshot.sharedState.out).toBe(0);
  expect(result.status, JSON.stringify({ result, sink: snapshot.sink })).toBe('acknowledged');
  expect(result.history!.absent).toEqual([
    ['executionTree', 'stageReads', 'missing'],
    ['executionTree', 'stageWrites', 'missing'],
  ]);
  expect(sources(result.history!).status).toBe('partial');
  expect(sources(result.history!).record!.occurrences[0]!.source).toEqual({
    kind: 'unavailable',
    reason: 'undefined-presence-unknown',
  });
});

it('keeps actual retry attempt identities when the first attempt was discarded', async () => {
  let calls = 0;
  const flow = flowChart<State>(
    'Retry',
    (s) => {
      const n = s.n;
      if (++calls === 1) throw new Error('synthetic first attempt');
      s.out = n;
    },
    'retry',
  )
    .retry({ attempts: 2 })
    .build();
  const { result, snapshot } = await save(flow);
  expect(calls).toBe(2);
  expect(snapshot.executionTree.readSourceCounts).toMatchObject({ observed: 2, retained: 2 });
  expect(result.history!.executionTree.readSourceCounts).toEqual(snapshot.executionTree.readSourceCounts);
  expect(snapshot.sharedState.out).toBe(4);
  expect(result.status).toBe('acknowledged');
  const rows = sources(result.history!).record!.occurrences;
  expect(rows.map((row) => parseAttemptId(row.attemptId!)?.attempt)).toEqual([1, 2]);
  expect(rows.map((row) => row.disposition)).toEqual(['discarded', 'released']);
  expect(rows.map((row) => row.source.kind)).toEqual(['base', 'base']);
});

it('preserves a source-budget omission without calling the shortened record complete', async () => {
  const { result } = await save(sequential(), { readSources: { limits: { maxOccurrences: 1 } } });
  expect(result.status).toBe('acknowledged');
  const evidence = sources(result.history!);
  expect(evidence.status).toBe('partial');
  expect(evidence.record!.occurrences).toHaveLength(1);
  expect(evidence.record!.gaps).toContainEqual({ reason: 'budget-exhausted', count: 1, exact: true });
  expect(result.history!.capture.channels.readSources).toBe('partial');
});

it('persists the privacy gap while keeping the unrelated public read precise', async () => {
  const flow = flowChart<State>(
    'Read',
    (s) => {
      s.out = s.n;
      const secret = s.secret;
    },
    'read',
  ).build();
  const { result, entries } = await save(
    flow,
    { initialContext: { n: 4, secret: 'SYNTHETIC-PRIVATE-VALUE' } },
    (executor) => executor.setRedactionPolicy({ keys: ['secret'] }),
  );
  expect(result.status).toBe('acknowledged');
  const evidence = sources(result.history!);
  expect(evidence.status).toBe('partial');
  expect(evidence.record!.occurrences.find((row) => row.key === 'n')!.source.kind).toBe('base');
  expect(evidence.record!.occurrences.find((row) => row.key === 'secret')!.source).toEqual({
    kind: 'unavailable',
    reason: 'redacted',
  });
  expect(JSON.stringify(entries)).not.toContain('SYNTHETIC-PRIVATE-VALUE');
});

it.each(['changed-source', 'changed-run', 'removed-source', 'reordered-reads'])(
  'withholds the stored history after %s changes under the old receipt',
  async (mutation) => {
    const { result, entries, runId } = await save();
    expect(result.status).toBe('acknowledged');
    const payload = entries.find((entry) => entry.kind === 'note' && entry.note === 'capture-history').data;
    if (mutation === 'changed-source') payload.readSources.record.occurrences[1].source.commitIdx = 999;
    if (mutation === 'changed-run') payload.readSources.runId = 'another-run';
    if (mutation === 'removed-source') delete payload.readSources;
    if (mutation === 'reordered-reads') payload.readSources.record.occurrences.reverse();
    const refused = await readStoredCapture(entries, { runId });
    expect(refused.status).toBe('unknown');
    expect(refused).not.toHaveProperty('history');
  },
);

it('returns detached immutable source metadata rather than aliases into the loaded entries', async () => {
  const { result, entries } = await save();
  expect(result.status).toBe('acknowledged');
  const evidence = sources(result.history!);
  const before = JSON.stringify(evidence);
  entries.find(
    (entry) => entry.kind === 'note' && entry.note === 'capture-history',
  ).data.readSources.record.occurrences[0].source.kind = 'forged';
  expect(JSON.stringify(evidence)).toBe(before);
  expect(Object.isFrozen(evidence)).toBe(true);
  expect(Object.isFrozen(evidence.record)).toBe(true);
  expect(Object.isFrozen(evidence.record!.occurrences)).toBe(true);
  expect(Object.isFrozen(evidence.record!.occurrences[0]!.source)).toBe(true);
});

it('keeps a read source when the following write is an unrelated constant', async () => {
  const flow = flowChart<State>(
    'Ignore',
    (s) => {
      const n = s.n;
      s.out = 123;
    },
    'ignore',
  ).build();
  for (const n of [4, 91]) {
    const { result, snapshot } = await save(flow, { initialContext: { n } });
    expect(snapshot.sharedState.out).toBe(123);
    expect(result.status).toBe('acknowledged');
    expect(sources(result.history!).record!.occurrences[0]!.source.kind).toBe('base');
    expect(result.history!.initialState!.n).toBe(n);
    // This test establishes the received version only. No derivation or causal edge is manufactured here.
  }
});

it('saves only the root source scope; a child cannot borrow the root book', async () => {
  const child = flowChart<State>(
    'Child',
    (s) => {
      s.n = 44;
    },
    'child-write',
  )
    .addFunction(
      'Child read',
      (s) => {
        s.out = s.n;
      },
      'child-read',
    )
    .build();
  const flow = flowChart<State>(
    'Root',
    (s) => {
      const n = s.n;
    },
    'root',
  )
    .addSubFlowChartNext('child', child, 'Child')
    .build();
  const { result, snapshot } = await save(flow);
  expect(result.status).toBe('acknowledged');
  const evidence = sources(result.history!);
  expect(evidence.record!.address.drillPath).toEqual([]);
  expect(evidence.record!.occurrences).toHaveLength(1);
  expect(evidence.record!.occurrences[0]!.key).toBe('n');
  expect(evidence.record!.occurrences[0]!.source.kind).toBe('base');
  const children = Object.values(snapshot.subflowResults!) as { treeContext: { readSources: EngineReadSources } }[];
  expect(children.length).toBeGreaterThan(0);
  for (const child of children) {
    expect(child.treeContext.readSources).toMatchObject({
      status: 'unknown',
      limitations: ['child-source-ownership'],
    });
    expect(child.treeContext.readSources).not.toHaveProperty('record');
  }
});

it.each([false, true])(
  'does not recover prior read-source ownership from a lean checkpoint (same=%s)',
  async (same) => {
    const directory = mkdtempSync(join(tmpdir(), 'source-resume-proof-'));
    const sink = fileSink(join(directory, 'run.jsonl'));
    const flow = flowChart<State>(
      'Read',
      (s) => {
        const n = s.n;
      },
      'read',
    )
      .addPausableFunction(
        'Ask',
        {
          execute: () => 'continue',
          resume: (s) => {
            const n = s.n;
          },
        },
        'ask',
      )
      .build();
    const options: FlowChartExecutorOptions = {
      initialContext: { n: 4 },
      captureCoverage: true,
      readSources: true,
      sink: { adapter: sink, capture: sink },
    };
    const executor = new FlowChartExecutor(flow, options);
    try {
      await executor.run();
      const pausedRun = executor.getSnapshot().runId;
      const checkpoint = JSON.parse(JSON.stringify(executor.getCheckpoint()));
      expect(checkpoint).not.toHaveProperty('readSources');
      expect(checkpoint.capture.channels.readSources).toBe('unknown');
      expect(checkpoint.capture.limitations).toContain('source-history-not-included');
      const resumed = same ? executor : new FlowChartExecutor(flow, options);
      await resumed.resume(checkpoint, true);
      const resumedSnapshot = resumed.getSnapshot();
      expect(resumedSnapshot.readSources).toMatchObject({
        status: 'unknown',
        limitations: ['resumed-source-ownership'],
      });
      expect(resumedSnapshot.readSources).not.toHaveProperty('record');
      await sink.close();
      const loaded = readRecordFile(sink.path);
      const restored = await readStoredCapture(loaded.entries, { runId: resumedSnapshot.runId });
      expect(restored.status).toBe('unknown');
      if (!same) {
        const paused = await readStoredCapture(loaded.entries, { runId: pausedRun });
        expect(paused.status).toBe('acknowledged');
        expect(paused.history!.capture.boundary.status).toBe('paused');
        expect(sources(paused.history!).record!.occurrences).toHaveLength(1);
      }
    } finally {
      await sink.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
