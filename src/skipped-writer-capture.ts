import { canonicalizeJson } from 'foottrace/canonical-json';
import { EventLog } from 'foottrace/write';

import { explain } from './explain.js';
import type { FlowChart } from './lib/builder/types.js';
import { createExplainCapture } from './lib/capture/explainCoverage.js';
import { markExplainOptions } from './lib/capture/explainOptions.js';
import { detachStageTopology } from './lib/engine/graph/detachTopology.js';
import { projectSkippedChart } from './lib/engine/graph/skippedProjection.js';
import type { StageNode } from './lib/engine/graph/StageNode.js';
import { canBindStoredControl, installStoredControl } from './lib/memory/storedControlEvidence.js';
import type { FlowChartExecutorOptions, PreparedStoredControl } from './lib/runner/options.js';
import type { Evaluator, LiveCapture } from './skipped-writer-state.js';

const CAPTURE_BYTES = 768 * 1024;
const CAPTURE_ENTRIES = 4_096;

function prepareStoredControl<TOut, TScope>(
  chart: FlowChart<TOut, TScope>,
  capability: Evaluator,
  writesOf: (placement: StageNode) => readonly string[] | undefined,
  bind: (snapshot: object, capture: LiveCapture) => void,
): PreparedStoredControl<TOut, TScope> | undefined {
  const detached = detachStageTopology(chart.root);
  if (!detached) return undefined;
  const stageMap = new Map(chart.stageMap);
  const projected = projectSkippedChart(detached.root, {
    hasStageFunction: (node) => stageMap.has(node.id),
    writesOf: (node) => writesOf(detached.authoredOf(node) ?? node),
  });
  if (projected.status !== 'ready') return undefined;

  const rows: string[] = [];
  let bytes = CAPTURE_BYTES;
  let gap: LiveCapture['gap'];
  const encoder = new TextEncoder();

  return {
    root: detached.root,
    stageMap,
    retain(entry) {
      if (gap || entry.address.drillPath.length > 0 || (entry.kind === 'note' && !entry.note.startsWith('run.')))
        return;
      try {
        const row =
          entry.kind === 'opened' || entry.kind === 'closed'
            ? (({ meta: _meta, ...position }) => position)(entry)
            : entry;
        if (rows.length === CAPTURE_ENTRIES || bytes === 0) {
          gap = 'truncated';
        } else {
          const text = canonicalizeJson(row, { maxBytes: bytes, maxNodes: 20_000, maxFields: 20_000 });
          bytes -= encoder.encode(text).length;
          rows.push(text);
        }
      } catch (error) {
        const code =
          error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
        gap =
          code === 'depth' ||
          code === 'nodes' ||
          code === 'fields' ||
          code === 'output-bytes' ||
          code === 'string-bytes' ||
          code === 'sort-work'
            ? 'truncated'
            : 'not-collected';
      }
      if (gap) rows.length = 0;
    },
    attach(runtime) {
      const log = runtime.executionHistory;
      if (!(log instanceof EventLog)) return;
      installStoredControl(log, async (runId) => {
        const address = log.address;
        if (
          !address ||
          address.drillPath.length ||
          runtime.capture?.runId !== runId ||
          !canBindStoredControl(log) ||
          runtime.rootStageContext.getRedactionRule()?.isInert() === false
        )
          return;
        try {
          const to = log.length;
          const evidence = { address, chart: projected.graph, from: 0, to };
          const { explanation, from: legFrom } = runtime.capture;
          if (explanation) {
            explanation.onWitness = (snapshot, witness) => {
              if (
                witness.boundary === 'completed' &&
                witness.runId === runId &&
                witness.logAddress.logRunId === address.logRunId &&
                witness.logAddress.drillPath.length === 0 &&
                witness.commits.from === legFrom &&
                witness.commits.to === to &&
                runtime.executionHistory === log &&
                runtime.rootStageContext.getRedactionRule()?.isInert() !== false
              )
                bind(snapshot, { evidence, rows, gap });
            };
          }
          const digest = await capability.savedChartDigest?.(projected.graph);
          if (digest === undefined) return undefined;
          return {
            skippedChart: {
              version: 'footprint.skipped-chart.v1',
              runId,
              address,
              from: 0,
              to,
              graph: projected.graph,
              digest,
            },
          };
        } catch {
          return undefined;
        }
      });
    },
  };
}

export function configureSkippedWriterCapture<TScope>(
  options: FlowChartExecutorOptions<TScope>,
  capability: Evaluator,
  writesOf: (placement: StageNode) => readonly string[] | undefined,
  bind: (snapshot: object, capture: LiveCapture) => void,
): FlowChartExecutorOptions<TScope> {
  return markExplainOptions(
    explain(true, options),
    Object.assign(createExplainCapture.bind(undefined), {
      prepareStoredControl: <TOut, Scope>(chart: FlowChart<TOut, Scope>) =>
        prepareStoredControl(chart, capability, writesOf, bind),
    }),
  );
}
