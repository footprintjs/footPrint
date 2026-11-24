import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { causalChain, formatCausalChain, readStoredRecord, stateAt } from 'foottrace';
import { expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { fileSink, readRecordFile } from '../../../../src/sinks.js';

it.each(['full', 'delta'] as const)(
  'keeps outside evidence through a real %s file-sink round trip',
  async (encoding) => {
    const chart = flowChart<{ price: number; quote: number; approved: boolean }>(
      'Set price',
      (scope) => {
        scope.price = 2;
      },
      'price',
    )
      .addFunction(
        'Get quote',
        async (scope) => {
          scope.quote = scope.price + (await scope.$call('quote.service', () => 4));
        },
        'quote',
      )
      .outside('clock')
      .addFunction(
        'Approve',
        (scope) => {
          scope.approved = scope.quote === 6;
        },
        'approve',
      )
      .build();
    const directory = mkdtempSync(join(tmpdir(), 'fp-outside-inputs-'));
    try {
      const sink = fileSink(join(directory, 'run.jsonl'));
      try {
        const executor = new FlowChartExecutor(chart, {
          commitValues: encoding,
          sink,
          writeProvenance: 'reads-prefix',
        });
        executor.setReadTracking('full');
        await executor.run();
        expect(await executor.flushRecord()).toEqual({ done: true, failed: false, pending: false });
        const live = executor.getSnapshot();
        const { entries, unreadable } = readRecordFile(sink.path);
        const record = readStoredRecord(entries);
        const stored = record.root(live.runId);
        expect(unreadable).toEqual([]);
        expect(record.unread).toEqual([]);
        if (!stored) throw new Error('Stored root is missing');
        expect(stored.complete).toBe(true);
        expect(stored.gaps).toEqual([]);
        expect(stored.commitLog).toEqual(JSON.parse(JSON.stringify(live.commitLog)));
        expect(stateAt(stored.source(), 2).state).toEqual(live.sharedState);

        const log = [...stored.commitLog];
        const walk = causalChain(log, 'approve#2', (id) =>
          log
            .filter(({ runtimeStageId }) => id === runtimeStageId)
            .flatMap(({ trace }) => trace.flatMap((row) => row.readKeys ?? [])),
        );
        expect(walk?.parents[0]).toMatchObject({
          runtimeStageId: 'quote#1',
          outsideInputs: { declared: ['clock'], call: { targets: ['quote.service'] } },
          parentEdges: [{ kind: 'data', key: 'price', parent: { runtimeStageId: 'price#0' } }],
        });
        const explanation = walk && formatCausalChain(walk);
        expect(explanation).toContain('outside: clock');
        expect(explanation).toContain('outside: call (quote.service)');

        // Lose the owner bundle alone, keeping the attempts and later commit as a retained store would.
        const retained = readStoredRecord(
          stored.entries.filter((row) => row.kind !== 'commit' || row.bundle.idx !== 1),
        );
        const sparse = retained.root(live.runId);
        if (!sparse) throw new Error('Retained root is missing');
        expect(sparse.notes.some((note) => note.kind === 'attempt')).toBe(true);
        expect(sparse.commitLog[2].runtimeStageId).toBe('approve#2');
        expect(sparse.commitLog.every((bundle) => bundle.outsideInputs === undefined)).toBe(true);
        expect(sparse.gaps).toHaveLength(1);
        expect(stateAt(sparse.source(), 2).skipped).toEqual(sparse.gaps);
      } finally {
        await sink.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
