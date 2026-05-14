/**
 * Compose a BoundaryStateStore<T> for live in-flight state.
 *
 * Boundaries are matched event pairs `[start, stop]`. Between them,
 * intermediate events evolve the boundary's transient state. On stop,
 * state clears. Use for "what's happening RIGHT NOW inside this LLM
 * call?" type questions.
 *
 * Run: npx tsx examples/recorders/03-compose-boundary-state.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { BoundaryStateStore } from 'footprintjs/trace';
import type { CombinedRecorder, EmitEvent } from 'footprintjs';

interface UploadProgress {
  bytes: number;
  filename: string;
}

class UploadProgressTracker implements CombinedRecorder {
  readonly id = 'upload-progress';
  private readonly store = new BoundaryStateStore<UploadProgress>('upload');

  onEmit(event: EmitEvent): void {
    const rid = event.runtimeStageId;
    if (!rid) return;
    if (event.name === 'upload.start') {
      const p = event.payload as { filename: string };
      this.store.start(rid, { bytes: 0, filename: p.filename });
    } else if (event.name === 'upload.chunk') {
      const p = event.payload as { bytes: number };
      this.store.update(rid, (prev) => ({ ...prev, bytes: prev.bytes + p.bytes }));
    } else if (event.name === 'upload.end') {
      this.store.stop(rid);
    }
  }

  isUploading() { return this.store.hasActive; }
  getProgress(rid: string) { return this.store.get(rid); }
  clear() { this.store.clear(); }
}

const chart = flowChart('upload', async (scope: any) => {
  scope.$emit('upload.start', { filename: 'data.csv' });
  scope.$emit('upload.chunk', { bytes: 1024 });
  scope.$emit('upload.chunk', { bytes: 2048 });
  // ...realistic uploads would be async and observable mid-flight
  scope.$emit('upload.end', {});
}, 'upload-stage').build();

(async () => {
  const tracker = new UploadProgressTracker();
  const executor = new FlowChartExecutor(chart);
  executor.attachCombinedRecorder(tracker);
  await executor.run();

  console.log(`uploading after run: ${tracker.isUploading()}`); // false — stop fired
})();
