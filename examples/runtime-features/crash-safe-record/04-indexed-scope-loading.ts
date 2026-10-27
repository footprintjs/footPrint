/** Explicit file indexing and selected-scope I/O; no cloud, model or paid call. */
import { flowChart, FlowChartExecutor } from 'footprintjs';
import { fileSink, openIndexedRecordFile } from 'footprintjs/sinks';
import { controlDepRecorder, readStoredCapture } from 'footprintjs/trace';
import { readStoredRecord } from 'foottrace';
import { createStoredRecordGraph, explain } from 'foottrace/cause';

/** The hosting layer chooses an authorized private path, not an AI model or browser request. */
export async function indexedScopeExample(path: string) {
  const sink = fileSink(path);
  const chart = flowChart<{ value?: number }>(
    'Write',
    (scope) => {
      scope.value = 3;
    },
    'write',
  )
    .addFunction(
      'Read',
      (scope) => {
        const value = scope.value;
      },
      'read',
    )
    .build();
  const executor = new FlowChartExecutor(chart, {
    captureCoverage: true,
    writeProvenance: 'reads-prefix',
    sink: { adapter: sink, capture: sink },
  });
  executor.attachFlowRecorder(controlDepRecorder({ captureCoverage: true }));
  let runId: string;
  try {
    await executor.run();
    runId = executor.getSnapshot().runId;
    // A second run shares this archive, but is not authorized by the loader below.
    await new FlowChartExecutor(chart, { sink }).run();
  } finally {
    await sink.close();
  }
  const address = { logRunId: runId!, drillPath: [] };
  // ONE bounded whole-file preparation pass. Close writers first; later mutations invalidate the session.
  const opened = await openIndexedRecordFile(path, { allowedScopes: [address], maxBytes: 8 * 1024 * 1024 });
  if (opened.status !== 'ready') throw new Error('Index preparation unavailable');
  const reader = opened.reader;
  try {
    const selected = await reader.readScope(address);
    if (selected.status !== 'loaded') throw new Error('Selected bytes unavailable');
    // Byte selection is not record or receipt admission. Use the existing public readers.
    const record = readStoredRecord(selected.entries);
    const capture = await readStoredCapture(selected.entries, { runId: runId! });
    if (capture.status !== 'acknowledged') throw new Error('Saved capture remains unknown');
    const graph = createStoredRecordGraph({
      async loadLog(requested, context) {
        const result = await reader.readScope(requested, context);
        if (result.status !== 'loaded') throw new Error('Authorized scope unavailable');
        return { entries: result.entries };
      },
    });
    const controller = new AbortController();
    const nodes = await graph.openScope(address, { signal: controller.signal });
    const finding = await explain(graph, nodes[1]!, { maxNodes: 32, maxCalls: 64, timeoutMs: 1000 });
    // The raw-storage adapter has no admitted attention/control projection, so the finding stays incomplete.
    // An InvestigationPort can delegate its explain callback to this same canonical graph; it must not upgrade it.
    if (finding.confidence !== 'incomplete' || finding.rootCause !== undefined)
      throw new Error('Unproven coverage upgraded');
    return {
      capture: capture.status,
      scopes: record.logs.size,
      confidence: finding.confidence,
      preparationBytes: reader.stats.preparationBytes,
      selectedBytes: selected.bytesRead,
    };
  } finally {
    await reader.close();
  }
}
