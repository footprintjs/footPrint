/** Local file example: no cloud, model or paid call. Run with tsx and a private output path. */
import { flowChart, FlowChartExecutor } from 'footprintjs';
import { fileSink, readRecordFile } from 'footprintjs/sinks';
import { controlDepRecorder, readStoredCapture } from 'footprintjs/trace';

export async function captureHistoryExample(path: string): Promise<void> {
  const sink = fileSink(path);
  try {
    const chart = flowChart<{ count?: number }>(
      'Count',
      (scope) => {
        scope.count = 1;
      },
      'count',
    ).build();
    const executor = new FlowChartExecutor(chart, {
      captureCoverage: true,
      writeProvenance: 'reads-prefix',
      sink: { adapter: sink, capture: sink },
    });
    executor.attachFlowRecorder(controlDepRecorder({ captureCoverage: true }));
    await executor.run();
    const file = readRecordFile(path);
    if (file.unreadable.length) throw new Error('Stored file has unreadable entries');
    const result = await readStoredCapture(file.entries, { runId: executor.getSnapshot().runId });
    console.log(result.status); // acknowledged; original native capture remains memory-only
  } finally {
    await sink.close();
  }
}
