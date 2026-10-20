/** Native-producer / public Foottrace consumer proof. No new admission API or graph algorithm. */
import { createRecordGraph, explain } from 'foottrace/cause';
import { expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { controlDepRecorder } from '../../../src/trace.js';

it('a vouchable one-step captured prefix supports a recorded root; identical unattested evidence does not', async () => {
  const ex = new FlowChartExecutor(
    flowChart<{ n: number }>(
      'Reject',
      (s) => {
        s.n = 1;
        throw new Error('synthetic');
      },
      'reject',
    ).build(),
    {
      captureCoverage: true,
      writeProvenance: 'reads-prefix',
    },
  );
  ex.attachFlowRecorder(controlDepRecorder({ captureCoverage: true }));
  await expect(ex.run()).rejects.toThrow('synthetic');
  const snapshot = ex.getSnapshot();
  const note = JSON.parse(JSON.stringify(snapshot.capture));
  const stage = snapshot.executionTree;
  const address = note.logAddress;
  // This test host vouches only for its known, one-node fixture. This is NOT general saved-record admission.
  expect(note.runId).toBe(snapshot.runId);
  expect(note.commits).toEqual({ from: 0, to: 1 });
  expect(note.boundary.status).toBe('failed');
  expect(note.channels).toMatchObject({
    reads: 'captured',
    writes: 'captured',
    control: 'captured',
    attention: 'captured',
  });
  for (const assured of [false, true]) {
    const graph = createRecordGraph([
      {
        address,
        commitLog: snapshot.commitLog,
        reads: { [stage.runtimeStageId!]: [] },
        controlDeps: {},
        attention: { [stage.runtimeStageId!]: stage.attention! },
        complete: assured,
      },
    ]);
    const id = graph.nodeId(address, { runtimeStageId: stage.runtimeStageId! });
    const result = await explain(graph, id);
    if (assured) {
      expect(result.gaps).toEqual([]);
      expect(result.attention).toHaveLength(1);
      expect(result.rootCause).toBe(id);
    } else {
      expect(result.rootCause).toBeUndefined();
      expect(result.confidence).toBe('incomplete');
    }
  }
});
