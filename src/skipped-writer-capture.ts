import { canonicalizeJson } from 'foottrace/canonical-json';
import { normaliseStateKey } from 'foottrace/paths';
import { EventLog } from 'foottrace/write';

import { explain } from './explain.js';
import type { FlowChart } from './lib/builder/types.js';
import { createExplainCapture } from './lib/capture/explainCoverage.js';
import { markExplainOptions } from './lib/capture/explainOptions.js';
import { detachStageTopology } from './lib/engine/graph/detachTopology.js';
import { type SkippedChartProjection, projectSkippedChart } from './lib/engine/graph/skippedProjection.js';
import type { StageNode } from './lib/engine/graph/StageNode.js';
import { canBindStoredControl, installStoredControl } from './lib/memory/storedControlEvidence.js';
import type { FlowChartExecutorOptions, PreparedStoredControl } from './lib/runner/options.js';
import type { Evaluator, LiveCapture } from './skipped-writer-state.js';

const CAPTURE_BYTES = 768 * 1024;
const CAPTURE_ENTRIES = 4_096;
const RECORD_PATH_DELIMITER = normaliseStateKey(['', '']);

/**
 * A commit identifies the stage, so check it only when every placement declares its writes.
 * A parent declaration covers a nested write. A parent write can change siblings of a declared child.
 */
function declarationGap(stages: SkippedChartProjection['stages'], log: EventLog): LiveCapture['gap'] {
  const byStage = new Map<string, string[]>();
  const undeclared = new Set<string>();
  for (const { stageId, writes } of stages) {
    if (writes === undefined) {
      undeclared.add(stageId);
    } else {
      const paths = byStage.get(stageId) ?? [];
      for (const path of writes) paths.push(path);
      byStage.set(stageId, paths);
    }
  }
  for (const stageId of undeclared) byStage.delete(stageId);
  if (byStage.size === 0) return undefined;
  if (log.length > CAPTURE_ENTRIES) return 'truncated';

  let work = 100_000;
  for (const { stageId, trace } of log.recorded()) {
    const declared = byStage.get(stageId);
    if (!declared) continue;
    for (const { path } of trace) {
      if (--work < 0) return 'truncated';
      let covered = false;
      for (const prefix of declared) {
        if (--work < 0) return 'truncated';
        if (path === prefix || (path.charAt(prefix.length) === RECORD_PATH_DELIMITER && path.startsWith(prefix))) {
          covered = true;
          break;
        }
      }
      if (!covered) return 'declaration-mismatch';
    }
  }
  return undefined;
}

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
          const rejectedDeclaration = declarationGap(projected.graph.stages, log);
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
              ) {
                // The closed entry arrives after the seal, before the completed snapshot.
                const sealedGap = rejectedDeclaration ?? gap;
                bind(snapshot, { evidence, rows: Object.freeze(sealedGap ? [] : rows.slice()), gap: sealedGap });
              }
            };
          }
          if (rejectedDeclaration) return undefined;
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
