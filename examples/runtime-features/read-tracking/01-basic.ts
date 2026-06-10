/**
 * readTracking — the cost dial for StageSnapshot.stageReads (#14)
 *
 * Default 'full' clones every tracked read value into the stage snapshot —
 * great for debugging, but a stage that reads a large value pays a deep
 * clone PER READ. The policy makes that cost opt-out:
 *
 *   'full'    — historical behavior (default). Values cloned into stageReads.
 *   'summary' — cheap { __readSummary, type, size, preview } marker per read.
 *   'off'     — no stageReads at all; reads of any size are ~free.
 *
 * Narrative and ScopeRecorder.onRead are IDENTICAL in every mode — the
 * policy scopes only the snapshot payload. Caveat: under 'off' a stage's
 * snapshot is indistinguishable from one that read nothing; auditing
 * consumers that need "did it read?" should prefer 'summary'.
 *
 * Run: npx tsx examples/runtime-features/read-tracking/01-basic.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import type { StageSnapshot } from 'footprintjs/advanced';

interface State {
  catalog: { sku: string; price: number }[];
  total?: number;
}

// A chart whose second stage READS the big value but never writes it.
const buildChart = () =>
  flowChart<State>(
    'Seed',
    async (scope) => {
      scope.catalog = Array.from({ length: 50_000 }, (_, i) => ({
        sku: `sku-${i}`,
        price: i % 97,
      }));
    },
    'seed',
  )
    .addFunction(
      'Price',
      async (scope) => {
        scope.total = scope.catalog.reduce((sum, item) => sum + item.price, 0);
      },
      'price',
    )
    .build();

function priceStageReads(snapshot: StageSnapshot): unknown {
  // seed → next: price. The execution tree mirrors the chain.
  return snapshot.next?.stageReads;
}

(async () => {
  for (const mode of ['full', 'summary', 'off'] as const) {
    const executor = new FlowChartExecutor(buildChart(), { readTracking: mode });
    const startedAt = performance.now();
    await executor.run();
    const elapsed = (performance.now() - startedAt).toFixed(1);

    const reads = priceStageReads(executor.getSnapshot().executionTree);
    const shape =
      reads === undefined
        ? '(absent — indistinguishable from a stage that read nothing)'
        : JSON.stringify(reads).slice(0, 100);
    console.log(`readTracking: '${mode}' — run ${elapsed}ms`);
    console.log(`  price.stageReads = ${shape}\n`);
  }
})();
