import { memorySink } from 'foottrace/write';

import { flowChart, FlowChartExecutor } from '../../src/index.js';
import type { CaptureHistoryOptions } from '../../src/lib/capture/historyTypes.js';
import { controlDepRecorder } from '../../src/trace.js';

export const historyChart = () =>
  flowChart<{ value?: number }>(
    'Seed',
    (s) => {
      s.value = 3;
    },
    'seed',
  )
    .addFunction(
      'Read',
      (s) => {
        const value = s.value;
      },
      'read',
    )
    .build();

/** Synthetic host assertion only; memorySink itself makes no durability claim. */
export async function savedFixture() {
  const adapter = memorySink();
  const capture: CaptureHistoryOptions = { acknowledge: async (target) => ({ ...target, durability: 'durable' }) };
  const executor = new FlowChartExecutor(historyChart(), {
    captureCoverage: true,
    writeProvenance: 'reads-prefix',
    sink: { adapter, capture },
  });
  executor.attachFlowRecorder(controlDepRecorder({ captureCoverage: true }));
  await executor.run();
  return {
    executor,
    runId: executor.getSnapshot().runId,
    entries: JSON.parse(JSON.stringify(adapter.entries)) as any[],
  };
}
