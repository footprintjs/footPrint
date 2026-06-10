/**
 * writeTracking — the cost dial for StageSnapshot.stageWrites (#13c-A)
 *
 * Default 'full' clones every tracked write value into the stage snapshot —
 * great for debugging, but a stage that writes a large value pays a deep
 * clone PER WRITE on top of the commit-path clone. The policy makes the
 * tracking half opt-out (the sibling of #14's readTracking):
 *
 *   'full'    — historical behavior (default). Values cloned into stageWrites.
 *   'summary' — cheap { __writeSummary, type, size, preview } marker per write.
 *   'off'     — no stageWrites at all; the tracking clone disappears.
 *
 * What the dial does NOT touch: the write itself. Shared state, the
 * transaction buffer, and the COMMIT LOG are identical in every mode
 * (commitLog values keep full payloads — #13c-B's delta verb), and
 * ScopeRecorder.onWrite fires with the live value regardless — so narrative
 * is identical too. What it DOES also govern besides the snapshot: the
 * ScopeRecorder.onCommit mutations payload (markers under 'summary', empty
 * under 'off'). Redaction beats the dial: redacted writes store '[REDACTED]'
 * under 'full'/'summary', nothing under 'off'.
 *
 * Run: npx tsx examples/runtime-features/write-tracking/01-basic.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import type { StageSnapshot } from 'footprintjs/advanced';

interface State {
  catalog: { sku: string; price: number }[];
  total?: number;
}

// A chart whose second stage WRITES the big value it derived.
const buildChart = () =>
  flowChart<State>(
    'Seed',
    async (scope) => {
      scope.total = 0;
    },
    'seed',
  )
    .addFunction(
      'BuildCatalog',
      async (scope) => {
        scope.catalog = Array.from({ length: 50_000 }, (_, i) => ({
          sku: `sku-${i}`,
          price: i % 97,
        }));
      },
      'build-catalog',
    )
    .build();

function catalogStageWrites(snapshot: StageSnapshot): unknown {
  // seed → next: build-catalog. The execution tree mirrors the chain.
  return snapshot.next?.stageWrites;
}

(async () => {
  for (const mode of ['full', 'summary', 'off'] as const) {
    const executor = new FlowChartExecutor(buildChart(), { writeTracking: mode });
    const startedAt = performance.now();
    await executor.run();
    const elapsed = (performance.now() - startedAt).toFixed(1);

    const snapshot = executor.getSnapshot();
    const writes = catalogStageWrites(snapshot.executionTree);
    const shape =
      writes === undefined
        ? '(absent — but the commitLog still records the write, unlike reads)'
        : JSON.stringify(writes).slice(0, 100);
    const committed = (snapshot.sharedState.catalog as State['catalog']).length;
    console.log(`writeTracking: '${mode}' — run ${elapsed}ms`);
    console.log(`  build-catalog.stageWrites = ${shape}`);
    console.log(`  sharedState.catalog.length = ${committed} (the write itself is untouched in every mode)\n`);
  }
})();
