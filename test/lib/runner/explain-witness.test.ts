import assert from 'node:assert/strict';

import { expect, it } from 'vitest';

import { captureWitnessOf, explain } from '../../../src/explain.js';
import { type RuntimeSnapshot, flowChart, FlowChartExecutor } from '../../../src/index.js';

function nestedChart() {
  const leaf = flowChart<{ count: number }>(
    'Count',
    (scope) => {
      scope.count = 1;
    },
    'count',
  ).build();
  const child = flowChart('Start child', () => undefined, 'child-start')
    .addSubFlowChartNext('leaf-mount', leaf)
    .build();
  return flowChart('Start root', () => undefined, 'root-start')
    .addSubFlowChartNext('child-mount', child)
    .build();
}

function mounts(snapshot: RuntimeSnapshot) {
  return Object.entries(snapshot.subflowResults ?? {}).filter(([id]) => id.includes('#'));
}

it('binds live witnesses to the actual root and each mounted log, including redacted copies', async () => {
  const executor = new FlowChartExecutor(nestedChart(), explain(true));
  await executor.run();
  const plain = executor.getSnapshot();
  const redacted = executor.getSnapshot({ redact: true });

  const outer = mounts(plain).find(([, result]) => result.treeContext.logAddress?.drillPath.length === 1);
  const inner = mounts(plain).find(([, result]) => result.treeContext.logAddress?.drillPath.length === 2);
  assert(outer && inner);
  const [outerId] = outer;
  const [innerId] = inner;

  for (const snapshot of [plain, redacted]) {
    const witness = captureWitnessOf(snapshot);
    expect(witness).toStrictEqual({
      logAddress: { logRunId: snapshot.runId, drillPath: [] },
      runId: snapshot.runId,
      commits: { from: 0, to: snapshot.commitLog.length },
      boundary: 'completed',
      source: 'live',
    });
    assert(witness);
    expect(Object.isFrozen(witness)).toBe(true);
    expect(Object.isFrozen(witness.logAddress)).toBe(true);
    expect(Object.isFrozen(witness.logAddress.drillPath)).toBe(true);
    expect(Object.isFrozen(witness.commits)).toBe(true);

    for (const [id, drillPath] of [
      [outerId, [outerId]],
      [innerId, [outerId, innerId]],
    ] as const) {
      const child = snapshot.subflowResults?.[id]?.treeContext;
      assert(child);
      expect(captureWitnessOf(child)).toStrictEqual({
        logAddress: { logRunId: snapshot.runId, drillPath },
        runId: snapshot.runId,
        commits: { from: 0, to: child.history.length },
        boundary: 'completed',
        source: 'live',
      });
      expect(child.logAddress).toEqual({ logRunId: snapshot.runId, drillPath });
    }
  }
  expect(redacted.subflowResults?.[innerId]?.treeContext).not.toBe(plain.subflowResults?.[innerId]?.treeContext);
});

it('finds no live witness on plain, legacy, copied, JSON or saved-shaped records', async () => {
  for (const options of [{}, { captureCoverage: true }]) {
    const executor = new FlowChartExecutor(nestedChart(), options);
    await executor.run();
    const snapshot = executor.getSnapshot();
    expect(captureWitnessOf(snapshot)).toBeUndefined();
    for (const [, { treeContext }] of mounts(snapshot)) expect(captureWitnessOf(treeContext)).toBeUndefined();
  }

  const executor = new FlowChartExecutor(nestedChart(), explain(true));
  await executor.run();
  const snapshot = executor.getSnapshot();
  const [mount] = mounts(snapshot);
  assert(mount);
  const child = mount[1].treeContext;
  expect(captureWitnessOf(snapshot)).toBeDefined();
  expect(captureWitnessOf(child)).toBeDefined();
  for (const record of [snapshot, child]) {
    expect(captureWitnessOf({ ...record })).toBeUndefined();
    expect(captureWitnessOf(structuredClone(record))).toBeUndefined();
    expect(captureWitnessOf(JSON.parse(JSON.stringify(record)))).toBeUndefined();
  }
  expect(
    captureWitnessOf({
      runId: snapshot.runId,
      logAddress: snapshot.logAddress,
      capture: snapshot.capture,
      commitLog: snapshot.commitLog,
      receipt: { durability: 'durable' },
    }),
  ).toBeUndefined();
});

it.each(['runId', 'logRunId', 'drillPath', 'capture'])(
  'hides the root and child witness when redaction selects %s',
  async (key) => {
    const executor = new FlowChartExecutor(nestedChart(), explain(true));
    executor.setRedactionPolicy({ keys: [key] });
    await executor.run();
    const plain = executor.getSnapshot();
    const redacted = executor.getSnapshot({ redact: true });
    expect(captureWitnessOf(plain)).toBeDefined();
    expect(captureWitnessOf(redacted)).toBeUndefined();
    expect(mounts(plain)).toHaveLength(2);
    for (const [id, { treeContext }] of mounts(plain)) {
      const child = redacted.subflowResults?.[id]?.treeContext;
      assert(child);
      expect(captureWitnessOf(treeContext)).toBeDefined();
      expect(captureWitnessOf(child)).toBeUndefined();
    }
  },
);

it('uses the new leg and interval after a same-executor resume on the same log', async () => {
  const chart = flowChart<{ count: number }>(
    'Start',
    (scope) => {
      scope.count = 1;
    },
    'start',
  )
    .addPausableFunction('Wait', { execute: () => ({ question: 'Continue?' }), resume: () => undefined }, 'wait')
    .addFunction(
      'Count',
      (scope) => {
        scope.count++;
      },
      'count',
    )
    .build();
  const executor = new FlowChartExecutor(chart, explain(true));
  await executor.run();
  const paused = executor.getSnapshot();
  const pauseWitness = {
    logAddress: { logRunId: paused.runId, drillPath: [] },
    runId: paused.runId,
    commits: { from: 0, to: paused.commitLog.length },
    boundary: 'paused',
    source: 'live',
  };
  expect(captureWitnessOf(paused)).toStrictEqual(pauseWitness);

  const checkpoint = executor.getCheckpoint();
  assert(checkpoint);
  await executor.resume(checkpoint);
  const resumed = executor.getSnapshot();
  expect(resumed.runId).not.toBe(paused.runId);
  expect(resumed.commitLog.length).toBeGreaterThan(paused.commitLog.length);
  expect(captureWitnessOf(resumed)).toStrictEqual({
    logAddress: { logRunId: paused.runId, drillPath: [] },
    runId: resumed.runId,
    commits: { from: paused.commitLog.length, to: resumed.commitLog.length },
    boundary: 'completed',
    source: 'live',
  });
  expect(captureWitnessOf(paused)).toStrictEqual(pauseWitness);
});
