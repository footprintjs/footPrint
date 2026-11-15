/** Nonempty retained-error surfaces; operational state and the raw rejection stay separate. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RedactionPolicy } from '../../src/index.js';
import { FlowChartExecutor } from '../../src/index.js';
import { fileSink } from '../../src/sinks.js';

export async function stageErrorSurfaces(
  chart: any,
  policy?: RedactionPolicy,
  input?: unknown,
  scopeFactory?: any,
  options: { captureClosure?: boolean; captureExtent?: boolean } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'fp-error-sources-'));
  const path = join(directory, 'record.jsonl');
  const sink = fileSink(path);
  const logs: unknown[][] = [];
  const logger = {
    info: () => undefined,
    log: () => undefined,
    debug: () => undefined,
    warn: (...parts: unknown[]) => logs.push(parts),
    error: (...parts: unknown[]) => logs.push(parts),
  };
  const executor = new FlowChartExecutor(
    { ...chart, logger },
    {
      captureCoverage: true,
      sink: { adapter: sink, capture: sink },
      ...(scopeFactory ? { scopeFactory } : {}),
      ...options,
    },
  );
  if (policy) executor.setRedactionPolicy(policy);
  executor.enableNarrative();
  const events: any[] = [];
  const deferred: any[] = [];
  const recorder = (out: any[], id: string) => ({
    id,
    onError: (event: any) => out.push({ kind: 'error', event }),
    onAttempt: (event: any) => out.push({ kind: 'attempt', event }),
    onRunFailed: (event: any) => out.push({ kind: 'failed', event }),
    onRunEnd: (event: any) => out.push({ kind: 'end', event }),
  });
  executor.attachFlowRecorder(recorder(events, 'error-inline'));
  executor.attachFlowRecorder(recorder(deferred, 'error-deferred'), { delivery: 'deferred' });
  let rejected: unknown;
  let output: any;
  try {
    output = await executor.run(input === undefined ? undefined : { input });
  } catch (error) {
    rejected = error;
  }
  try {
    await executor.drainObservers();
    const snapshot = executor.getSnapshot({ redact: true });
    await sink.close();
    const disk = readFileSync(path, 'utf8');
    const entries = disk
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return {
      executor,
      rejected,
      output,
      events,
      deferred,
      entries,
      retained: {
        events: JSON.stringify(events),
        deferred: JSON.stringify(deferred),
        narrative: JSON.stringify(executor.getNarrativeEntries()),
        tree: JSON.stringify(snapshot.executionTree),
        logger: JSON.stringify(logs, (_key, value) =>
          value instanceof Error
            ? { message: value.message, name: value.name, code: (value as any).code, cause: value.cause }
            : value,
        ),
        disk,
      },
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
