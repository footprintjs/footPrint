/**
 * Compose a KeyedStore<T> for a per-stage metric recorder.
 *
 * The KeyedStore stores 1:1 — one record per runtimeStageId. Use for
 * per-step metrics (token counts, durations, snapshots).
 *
 * Run: npx tsx examples/recorders/02-compose-keyed-store.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { KeyedStore } from 'footprintjs/trace';
import type { ScopeRecorder } from 'footprintjs';

interface StageMetrics {
  runtimeStageId: string;
  durationMs: number;
}

class DurationRecorder implements ScopeRecorder {
  readonly id = 'duration';
  private readonly store = new KeyedStore<StageMetrics>();
  private startTimes = new Map<string, number>();

  onStageStart(event: { runtimeStageId: string }) {
    this.startTimes.set(event.runtimeStageId, performance.now());
  }
  onStageEnd(event: { runtimeStageId: string }) {
    const start = this.startTimes.get(event.runtimeStageId);
    if (start === undefined) return;
    this.store.set(event.runtimeStageId, {
      runtimeStageId: event.runtimeStageId,
      durationMs: Math.round(performance.now() - start),
    });
    this.startTimes.delete(event.runtimeStageId);
  }

  getDuration(rid: string) { return this.store.get(rid)?.durationMs; }
  getTotalMs() { return this.store.aggregate((sum, e) => sum + e.durationMs, 0); }
  clear() { this.store.clear(); this.startTimes.clear(); }
}

const chart = flowChart('a', () => null, 'a')
  .addFunction('B', () => null, 'b')
  .addFunction('C', () => null, 'c')
  .build();

(async () => {
  const dur = new DurationRecorder();
  const executor = new FlowChartExecutor(chart);
  executor.attachScopeRecorder(dur);
  await executor.run();

  console.log(`total: ${dur.getTotalMs()}ms`);
})();
