import { memorySink } from 'foottrace/write';
import { assert, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor, readKeysOf } from '../../../src/index.js';
import { readStoredCapture } from '../../../src/trace.js';

it('keeps a whole-policy undefined read and write masked on every snapshot route', async () => {
  const observed: unknown[] = [];
  const chart = flowChart<{ k?: string }>(
    'Read and write k',
    (scope) => {
      observed.push(scope.k);
      scope.k = undefined;
    },
    'read-and-write',
  ).build();
  const sink = memorySink();
  const executor = new FlowChartExecutor(chart, {
    captureCoverage: true,
    sink: {
      adapter: sink,
      capture: { acknowledge: async (target) => ({ ...target, durability: 'durable' }) },
    },
  });
  executor.setRedactionPolicy({ keys: ['k'] });
  await executor.run();

  const plain = executor.getSnapshot();
  const redacted = executor.getSnapshot({ redact: true });
  const reopen = (snapshot: typeof plain): typeof plain => JSON.parse(JSON.stringify(snapshot));
  const stored = await readStoredCapture(JSON.parse(JSON.stringify(sink.entries)), { runId: plain.runId });
  assert(stored.status === 'acknowledged', 'Expected the stored capture to be acknowledged');

  expect(observed).toEqual([undefined]);
  expect(plain.sharedState.k).toBeUndefined();
  for (const [route, stage, placeholder] of [
    ['plain', plain.executionTree, '[REDACTED]'],
    ['redacted', redacted.executionTree, '[REDACTED]'],
    ['plain JSON', reopen(plain).executionTree, '[REDACTED]'],
    ['redacted JSON', reopen(redacted).executionTree, '[REDACTED]'],
    ['stored capture', stored.history.executionTree, 'REDACTED'],
  ] as const) {
    expect(stage.stageReads?.k, route).toBe(placeholder);
    expect(stage.stageWrites?.k, route).toBe(placeholder);
    expect(stage.undefinedReadKeys ?? [], route).not.toContain('k');
    expect(readKeysOf(stage), route).toEqual(['k']);
  }
  expect(stored.history.absent).toBeUndefined();
});
