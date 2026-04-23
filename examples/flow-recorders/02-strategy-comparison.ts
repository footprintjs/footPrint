/**
 * FlowRecorder: Strategy Comparison
 *
 * Runs the same realistic flowchart with every built-in strategy and a custom one.
 * The chart models an API data-sync pipeline that retries failed batches:
 *
 *   FetchConfig -> PrepareBatches -> ProcessBatch ---+
 *                                      ^             | (loop if more batches)
 *                                      +-------------+
 *                                 -> Finalize
 *
 * Each stage has a description, so the narrative reads like prose.
 * Compare how each strategy summarizes the same 20-iteration loop differently.
 *
 * Run:  npm run fr:compare
 * Try it: https://footprintjs.github.io/footprint-playground/samples/strategy-comparison
 */

import {
  flowChart,
  
  FlowChartExecutor,
  NarrativeFlowRecorder,
  WindowedNarrativeFlowRecorder,
  SilentNarrativeFlowRecorder,
  AdaptiveNarrativeFlowRecorder,
  ProgressiveNarrativeFlowRecorder,
  MilestoneNarrativeFlowRecorder,
  RLENarrativeFlowRecorder,
  SeparateNarrativeFlowRecorder,
  type FlowRecorder,
  type FlowLoopEvent,
} from 'footprintjs';

const BATCH_COUNT = 20;

interface SyncState {
  batchesProcessed: number;
  totalBatches: number;
  errors: number;
  batchSize: number;
  summary: string;
}

function buildSyncChart(totalBatches: number) {
  return flowChart<SyncState>(
    'FetchConfig',
    async (scope) => {
      scope.batchesProcessed = 0;
      scope.totalBatches = totalBatches;
      scope.errors = 0;
    },
    'fetch-config',
    undefined,
    'fetch remote API configuration and credentials',
  )
    .addFunction(
      'PrepareBatches',
      async (scope) => {
        scope.batchSize = 100;
      },
      'prepare-batches',
      'split the dataset into batches of 100 records',
    )
    .addFunction(
      'ProcessBatch',
      async (scope) => {
        const processed = scope.batchesProcessed;
        scope.batchesProcessed = processed + 1;

        // Simulate occasional errors
        if ((processed + 1) % 7 === 0) {
          scope.errors = scope.errors + 1;
        }

        if (processed + 1 >= totalBatches) scope.$break();
      },
      'process-batch',
      'sync the next batch of records to the remote API',
    )
    .loopTo('process-batch')
    .addFunction(
      'Finalize',
      async (scope) => {
        const errors = scope.errors;
        scope.summary = `Synced ${totalBatches} batches with ${errors} failures`;
      },
      'finalize',
      'generate sync report and clean up resources',
    )
    .build();
}

// ── Custom Strategy: EveryFailureRecorder ────────────────────────────
// Demonstrates consumer power: a custom recorder that only narrates
// iterations where something went wrong (every 7th batch).

class EveryFailureRecorder extends NarrativeFlowRecorder {
  private suppressedCount = 0;

  constructor() {
    super('custom-failure-only');
  }

  override onLoop(event: FlowLoopEvent): void {
    // Only emit narrative for iterations that had errors (every 7th)
    if (event.iteration % 7 === 0) {
      super.onLoop(event);
    } else {
      this.suppressedCount++;
    }
  }

  getSuppressedCount(): number {
    return this.suppressedCount;
  }
}

// ── Run all strategies ───────────────────────────────────────────────

(async () => {
  console.log(
    `=== Strategy Comparison: API Batch Sync (${BATCH_COUNT} iterations) ===\n`,
  );
  console.log(
    'Each strategy observes the SAME execution but produces different narrative.\n',
  );

  const strategies: Array<{
    name: string;
    recorder: NarrativeFlowRecorder;
    note: string;
  }> = [
    {
      name: 'Default',
      recorder: new NarrativeFlowRecorder(),
      note: 'Every iteration, no compression',
    },
    {
      name: 'Windowed(3, 2)',
      recorder: new WindowedNarrativeFlowRecorder(3, 2),
      note: 'First 3 + last 2, skip the middle',
    },
    {
      name: 'Silent',
      recorder: new SilentNarrativeFlowRecorder(),
      note: 'No loop lines, just flow structure',
    },
    {
      name: 'Adaptive(3, 5)',
      recorder: new AdaptiveNarrativeFlowRecorder(3, 5),
      note: 'Full detail for 3, then every 5th',
    },
    {
      name: 'Progressive(2)',
      recorder: new ProgressiveNarrativeFlowRecorder(2),
      note: 'Exponential: pass 1, 2, 4, 8, 16',
    },
    {
      name: 'Milestone(5)',
      recorder: new MilestoneNarrativeFlowRecorder(5),
      note: 'Every 5th iteration only',
    },
    {
      name: 'RLE',
      recorder: new RLENarrativeFlowRecorder(),
      note: 'Run-length encoding: "Looped Nx through X"',
    },
    {
      name: 'Custom (failures only)',
      recorder: new EveryFailureRecorder(),
      note: 'Only narrates every 7th iteration (simulated failures)',
    },
  ];

  for (const { name, recorder, note } of strategies) {
    const executor = new FlowChartExecutor(
      buildSyncChart(BATCH_COUNT),
    );
    executor.attachFlowRecorder(recorder);
    await executor.run();

    const sentences = executor.getNarrativeEntries()
      .filter(e => e.type === 'step' || e.type === 'condition' || e.type === 'fork' || e.type === 'selector')
      .map(e => e.text);
    console.log(`── ${name} ── (${note})`);
    console.log(`   ${sentences.length} sentence(s):\n`);
    sentences.forEach((line) => console.log(`     ${line}`));
    console.log();
  }

  // ── Separate strategy needs special handling ─────────────────────
  console.log('── Separate ── (main narrative + dedicated loop channel)\n');
  const separate = new SeparateNarrativeFlowRecorder();
  const executor = new FlowChartExecutor(
    buildSyncChart(BATCH_COUNT),
  );
  executor.attachFlowRecorder(separate);
  await executor.run();

  const mainSentences = executor.getNarrativeEntries()
    .filter(e => e.type === 'step' || e.type === 'condition' || e.type === 'fork' || e.type === 'selector')
    .map(e => e.text);
  console.log(`   Main narrative (${mainSentences.length} sentences):`);
  mainSentences.forEach((line) => console.log(`     ${line}`));
  console.log(
    `\n   Loop channel: ${separate.getLoopSentences().length} sentences`,
  );
  console.log(
    `   Loop counts: ${JSON.stringify(Object.fromEntries(separate.getLoopCounts()))}`,
  );
})().catch(console.error);
