import { createRecordGraph, explain } from 'foottrace/cause';
import { memorySink } from 'foottrace/write';
import { expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { controlDepRecorder, readStoredCapture } from '../../../src/trace.js';

it('a stored assured one-node prefix supports the canonical root rule; missing storage evidence does not', async () => {
  const sink = memorySink();
  const ex = new FlowChartExecutor(
    flowChart(
      'Reject',
      () => {
        throw new Error('synthetic rejection');
      },
      'reject',
    ).build(),
    {
      captureCoverage: true,
      writeProvenance: 'reads-prefix',
      sink: { adapter: sink, capture: { acknowledge: async (r) => ({ ...r, durability: 'durable' }) } },
    },
  );
  ex.attachFlowRecorder(controlDepRecorder({ captureCoverage: true }));
  await expect(ex.run()).rejects.toThrow('synthetic rejection');
  const result = await readStoredCapture(JSON.parse(JSON.stringify(sink.entries)), { runId: ex.getSnapshot().runId });
  expect(result.status).toBe('acknowledged');
  const history = result.history!;
  const stage = history.executionTree;
  expect(history.capture.channels).toMatchObject({
    reads: 'captured',
    writes: 'captured',
    attention: 'captured',
    control: 'captured',
  });
  // Host vouches ONLY for this known one-node prefix; no general app admission or second causal walker.
  for (const complete of [false, true]) {
    const graph = createRecordGraph([
      {
        address: history.capture.logAddress,
        commitLog: history.commitLog,
        reads: { [stage.runtimeStageId!]: [] },
        controlDeps: {},
        attention: { [stage.runtimeStageId!]: stage.attention! },
        complete,
      },
    ]);
    const id = graph.nodeId(history.capture.logAddress, { runtimeStageId: stage.runtimeStageId! });
    const finding = await explain(graph, id);
    if (complete) expect(finding.rootCause).toBe(id);
    else expect(finding.rootCause).toBeUndefined();
  }
});
