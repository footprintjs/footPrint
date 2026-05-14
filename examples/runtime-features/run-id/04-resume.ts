/**
 * runId — Resume from Checkpoint
 *
 * `executor.resume(checkpoint, ...)` is logically a NEW run — gets a
 * fresh runId. Recorders that scope state per-run will treat the
 * resume as a fresh context and reset transient bookkeeping.
 *
 * If a consumer needs to correlate the original-run runId with the
 * resume's runId, store it in the checkpoint's payload at pause time.
 *
 * Run: npx tsx examples/runtime-features/run-id/04-resume.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import type { FlowRecorder, PausableHandler } from 'footprintjs';

interface State { approved?: boolean }

// A pausable stage — returns data on first invocation (pause), then
// resumes on the second with consumer-supplied input.
const handler: PausableHandler<State> = {
  execute: () => ({ question: 'approve?' }),
  resume: (scope, input) => {
    scope.approved = (input as { approved: boolean }).approved;
  },
};

const chart = flowChart<State>('approve', handler, 'approve').build();

(async () => {
  const seenRunIds: string[] = [];
  const recorder: FlowRecorder = {
    id: 'runid-on-resume',
    onRunStart: (e) => {
      if (e.traversalContext?.runId) seenRunIds.push(`run:    ${e.traversalContext.runId}`);
    },
    onResume: (e) => {
      if (e.traversalContext?.runId) seenRunIds.push(`resume: ${e.traversalContext.runId}`);
    },
  };

  const executor = new FlowChartExecutor(chart);
  executor.attachFlowRecorder(recorder);

  await executor.run(); // pauses
  if (executor.isPaused()) {
    const checkpoint = executor.getCheckpoint()!;
    await executor.resume(checkpoint, { approved: true });
  }

  console.log('runIds observed:');
  for (const id of seenRunIds) console.log(`  ${id}`);

  // Output:
  //   run:    ...-0000000001            ← initial executor.run()
  //   resume: ...-0000000002            ← onResume fires for resume()
  //   run:    ...-0000000002            ← resume's traverser also fires onRunStart
  //                                       (with the SAME new runId — both events
  //                                       belong to the same logical resume run)
})();
