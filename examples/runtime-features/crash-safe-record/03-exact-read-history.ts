/** Save native read selections locally; no model, cloud or semantic-derivation claim. */
import { flowChart, FlowChartExecutor } from 'footprintjs';
import { fileSink, readRecordFile } from 'footprintjs/sinks';
import type { StoredCaptureResult } from 'footprintjs/trace';
import { readStoredCapture } from 'footprintjs/trace';

export async function exactReadHistoryExample(path: string): Promise<StoredCaptureResult> {
  const sink = fileSink(path);
  try {
    const chart = flowChart<{ count: number; observed?: number }>(
      'Increment',
      (scope) => {
        scope.count = scope.count + 1;
      },
      'increment',
    )
      .addFunction(
        'Observe',
        (scope) => {
          scope.observed = scope.count;
        },
        'observe',
      )
      .build();
    const executor = new FlowChartExecutor(chart, {
      initialContext: { count: 1 },
      readSources: true,
      captureCoverage: true,
      sink: { adapter: sink, capture: sink },
    });
    await executor.run();
    const file = readRecordFile(path);
    if (file.unreadable.length) throw new Error('Stored file has unreadable entries');
    // Native observations remain memory-only; the recovered receipt records storage acknowledgement.
    return await readStoredCapture(file.entries, { runId: executor.getSnapshot().runId! });
  } finally {
    await sink.close();
  }
}
