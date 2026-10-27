import { memorySink } from 'foottrace/write';

import { flowChart, FlowChartExecutor } from '../../src/index.js';
import { historyDigest, historyEvidence } from '../../src/lib/capture/historyData.js';

export function ownershipChart() {
  return flowChart<{ n?: number; result?: number }>(
    'Seed',
    (scope) => {
      scope.n = 4;
    },
    'seed',
  )
    .addFunction(
      'Read',
      (scope) => {
        scope.result = scope.n;
      },
      'read',
    )
    .addFunction('No reads', () => {}, 'empty')
    .build();
}

/** The synthetic memory adapter is an explicit host assertion, never proof of real disk durability. */
export async function savedOwnership() {
  const sink = memorySink();
  const executor = new FlowChartExecutor(ownershipChart(), {
    captureCoverage: true,
    readSources: true,
    sink: { adapter: sink, capture: { acknowledge: async (target) => ({ ...target, durability: 'durable' }) } },
  });
  await executor.run();
  return { executor, snapshot: executor.getSnapshot(), entries: JSON.parse(JSON.stringify(sink.entries)) as any[] };
}

/** An unkeyed fingerprint is deliberately not treated as a signature in hostile-edit probes. */
export async function resignOwnership(entries: any[]) {
  const payload = entries.find((entry) => entry.note === 'capture-history').data;
  const opened = entries.find((entry) => entry.kind === 'opened');
  payload.target.digest = await historyDigest({
    evidence: historyEvidence(payload),
    record: {
      commitLog: entries.filter((entry) => entry.kind === 'commit').map((entry) => entry.bundle),
      ...(opened.initialState !== undefined && { initialState: opened.initialState }),
    },
  });
  entries.find((entry) => entry.note === 'capture-receipt').data.digest = payload.target.digest;
}
