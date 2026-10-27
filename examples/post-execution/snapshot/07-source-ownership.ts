/** Native ownership survives a real saved history; no model or remote service. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { fileSink, readRecordFile } from 'footprintjs/sinks';
import { readStoredCapture } from 'footprintjs/trace';

(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ownership-example-'));
  const sink = fileSink(join(directory, 'run.jsonl'));
  try {
    const chart = flowChart<{ n: number }>(
      'Read',
      (scope) => {
        const n = scope.n;
      },
      'read',
    )
      .addFunction('No reads', () => {}, 'empty')
      .build();
    const executor = new FlowChartExecutor(chart, {
      initialContext: { n: 4 },
      readSources: true,
      captureCoverage: true,
      sink: { adapter: sink, capture: sink },
    });
    await executor.run();
    await sink.close();
    const loaded = await readStoredCapture(readRecordFile(sink.path).entries, { runId: executor.getSnapshot().runId });
    const source = loaded.history?.readSources;
    if (source?.version !== 2 || source.status !== 'captured' || source.ownership.status !== 'captured')
      throw new Error('Source ownership is unknown');
    console.log('Native owners:', source.ownership.executions.length);
    console.log('Zero-read owner:', source.ownership.executions[1].attemptIds.length === 1);
    // These producer facts do not independently authorize a consumer, attest a child or prove a root cause.
  } finally {
    await sink.close();
    rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
