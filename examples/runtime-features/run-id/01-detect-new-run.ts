/**
 * runId — Detect New Run
 *
 * Every `executor.run()` (and `executor.resume()`) generates a fresh
 * `runId` that's threaded into every event's `traversalContext`.
 * Recorders detect "new run" by watching for `runId` change.
 *
 * Two consecutive runs of the SAME executor instance produce
 * DIFFERENT runIds — the counter never resets across runs.
 *
 * Run: npx tsx examples/runtime-features/run-id/01-detect-new-run.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import type { FlowRecorder } from 'footprintjs';

const chart = flowChart('start', () => 'hello', 'stage').build();

(async () => {
  // Recorder that observes runId changes. Real consumers reset
  // transient state (fork tracking, sibling-handoff bookkeeping, etc.)
  // when the runId flips.
  let lastRunId: string | undefined;
  const recorder: FlowRecorder = {
    id: 'new-run-detector',
    onRunStart: (event) => {
      const runId = event.traversalContext?.runId;
      if (!runId) return;
      if (runId !== lastRunId) {
        console.log(`new run detected: ${runId}`);
        lastRunId = runId;
      }
    },
  };

  const executor = new FlowChartExecutor(chart);
  executor.attachFlowRecorder(recorder);

  // Run the same executor TWICE — second run gets a different runId.
  await executor.run();
  await executor.run();

  // Output:
  //   new run detected: 1778396038107-0000000001
  //   new run detected: 1778396038108-0000000002
})();
