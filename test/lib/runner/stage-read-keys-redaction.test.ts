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

it.each(['full', 'summary'] as const)(
  'masks an earlier unset read after a later whole mark in %s mode',
  async (readTracking) => {
    const observed: unknown[] = [];
    const chart = flowChart<{ k?: string }>(
      'Read unset k',
      (scope) => {
        observed.push(scope.k);
      },
      'read-unset',
    )
      .addFunction('Mark k whole', (scope) => scope.$setValue('k', 'new value', true), 'mark-whole')
      .build();
    const sink = memorySink();
    const executor = new FlowChartExecutor(chart, {
      readTracking,
      captureCoverage: true,
      sink: {
        adapter: sink,
        capture: { acknowledge: async (target) => ({ ...target, durability: 'durable' }) },
      },
    });
    executor.setRedactionPolicy({});
    await executor.run();

    const plain = executor.getSnapshot();
    const redacted = executor.getSnapshot({ redact: true });
    const reopen = (snapshot: typeof plain): typeof plain => JSON.parse(JSON.stringify(snapshot));
    const stored = await readStoredCapture(JSON.parse(JSON.stringify(sink.entries)), { runId: plain.runId });
    assert(stored.status === 'acknowledged', 'Expected the stored capture to be acknowledged');

    expect(observed).toEqual([undefined]);
    expect(plain.sharedState.k).toBe('new value');
    expect(redacted.sharedState.k).toBe('REDACTED');
    for (const [route, stage, placeholder] of [
      ['plain', plain.executionTree, '[REDACTED]'],
      ['redacted', redacted.executionTree, '[REDACTED]'],
      ['plain JSON', reopen(plain).executionTree, '[REDACTED]'],
      ['redacted JSON', reopen(redacted).executionTree, '[REDACTED]'],
      ['stored capture', stored.history.executionTree, 'REDACTED'],
    ] as const) {
      expect(stage.stageReads?.k, route).toBe(placeholder);
      expect(stage.undefinedReadKeys ?? [], route).not.toContain('k');
      expect(readKeysOf(stage), route).toEqual(['k']);
    }
    expect(stored.history.absent).toBeUndefined();
  },
);

it('uses the resumed rule when serving an earlier frame on the same executor', async () => {
  const chart = flowChart<{ k?: string }>(
    'Read unset k',
    (scope) => {
      expect(scope.k).toBeUndefined();
    },
    'read-before-pause',
  )
    .addPausableFunction(
      'Mark on resume',
      {
        execute: async () => ({ question: 'Resume?' }),
        resume: async (scope) => scope.$setValue('k', 'after pause', true),
      },
      'pause',
    )
    .build();
  const executor = new FlowChartExecutor(chart);
  executor.setRedactionPolicy({});
  await executor.run();
  const checkpoint = executor.getCheckpoint();
  assert(checkpoint, 'Expected a pause checkpoint');
  const before = executor.getSnapshot().executionTree;
  expect(before.undefinedReadKeys).toEqual(['k']);

  await executor.resume(checkpoint, 'continue');
  const after = executor.getSnapshot({ redact: true }).executionTree;
  expect(after.stageReads?.k).toBe('[REDACTED]');
  expect(after.undefinedReadKeys).toBeUndefined();
  expect(readKeysOf(after)).toEqual(['k']);
  expect(before.stageReads).toEqual({ k: undefined });
  expect(before.undefinedReadKeys).toEqual(['k']);
});
