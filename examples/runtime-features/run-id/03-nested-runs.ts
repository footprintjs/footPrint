/**
 * runId — Nested Runs (Subflows Inherit, Nested Executors Don't)
 *
 * Subflows mounted via `addSubFlowChart` run as part of the parent
 * traverser — they SHARE the parent's runId. All events from one
 * `executor.run()` carry one runId.
 *
 * Compare with NESTED EXECUTORS — when a stage calls `subRunner.run()`
 * on a different executor instance, that nested executor generates
 * its OWN runId. Each `executor.run()` is its own logical run.
 *
 * Run: npx tsx examples/runtime-features/run-id/03-nested-runs.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import type { FlowRecorder } from 'footprintjs';

const inner = flowChart('inner', () => 'inner-result', 'inner-stage').build();

const outer = flowChart('seed', () => null, 'seed-stage')
  .addSubFlowChart('sf-1', inner, 'sf-1', {
    inputMapper: () => ({}),
    outputMapper: () => ({}),
  })
  .addSubFlowChart('sf-2', inner, 'sf-2', {
    inputMapper: () => ({}),
    outputMapper: () => ({}),
  })
  .build();

(async () => {
  const seenRunIds = new Set<string>();
  const recorder: FlowRecorder = {
    id: 'runid-collector',
    onSubflowEntry: (e) => {
      if (e.traversalContext?.runId) seenRunIds.add(e.traversalContext.runId);
    },
    onStageExecuted: (e) => {
      if (e.traversalContext?.runId) seenRunIds.add(e.traversalContext.runId);
    },
  };

  const executor = new FlowChartExecutor(outer);
  executor.attachFlowRecorder(recorder);
  await executor.run();

  console.log(`distinct runIds across one run with 2 subflows: ${seenRunIds.size}`);
  // Output: 1 — all events of one executor.run() share one runId,
  // even when traversal enters subflows.
})();
