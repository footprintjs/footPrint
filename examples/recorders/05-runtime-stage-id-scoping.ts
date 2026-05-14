/**
 * Cross-run-safe lookups via composite keys (runId + runtimeStageId).
 *
 * For long-lived executors that run many times, recorder state must
 * be scoped by `runId` to avoid aliasing across runs. This example
 * shows the pattern: compose key as `${runId}:${runtimeStageId}` so
 * lookups and aggregations stay scoped to the correct run.
 *
 * Run: npx tsx examples/recorders/05-runtime-stage-id-scoping.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { KeyedStore } from 'footprintjs/trace';
import type { FlowRecorder } from 'footprintjs';

interface StageRecord {
  runId: string;
  runtimeStageId: string;
  stageName: string;
}

class CrossRunSafeRecorder implements FlowRecorder {
  readonly id = 'cross-run-safe';
  // KeyedStore keyed by composite `${runId}:${runtimeStageId}`. Two
  // consecutive runs of the same executor have IDENTICAL
  // runtimeStageIds (counter resets), but DIFFERENT runIds — so the
  // composite key never collides.
  private readonly store = new KeyedStore<StageRecord>();

  onStageExecuted(event: any) {
    const ctx = event.traversalContext;
    if (!ctx?.runId || !ctx?.runtimeStageId) return;
    const key = `${ctx.runId}:${ctx.runtimeStageId}`;
    this.store.set(key, {
      runId: ctx.runId,
      runtimeStageId: ctx.runtimeStageId,
      stageName: event.stageName ?? '',
    });
  }

  /** Per-run query — filter by runId. */
  getRunStages(runId: string): StageRecord[] {
    return this.store.values().filter((s) => s.runId === runId);
  }
  /** Cross-run aggregate — count distinct runs observed. */
  getRunCount(): number {
    return new Set(this.store.values().map((s) => s.runId)).size;
  }
  // NOTE: NO clear() method here — by NOT implementing it, the
  // executor's "reset recorders before each run" hook is a no-op for
  // this recorder, so the store's data survives across runs. That's
  // the whole point — we want to ACCUMULATE across runs and use runId
  // to disambiguate. Recorders that DO want per-run reset implement
  // `clear()` (the default for most recorders).
}

const chart = flowChart('a', () => null, 'a').build();

(async () => {
  const rec = new CrossRunSafeRecorder();
  const executor = new FlowChartExecutor(chart);
  executor.attachFlowRecorder(rec);

  await executor.run();
  await executor.run();
  await executor.run();

  console.log(`runs observed: ${rec.getRunCount()}`); // 3 — correctly distinguishes
})();
