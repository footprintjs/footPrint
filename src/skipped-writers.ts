/** Prototype opt-in for exact native skipped-writer control evidence. */
import { savedChartDigest } from 'foottrace/cause';

import { explain } from './explain.js';
import type { FlowChart } from './lib/builder/types.js';
import { createExplainCapture, type ExplainCapture } from './lib/capture/explainCoverage.js';
import { markExplainOptions } from './lib/capture/explainOptions.js';
import { detachStageTopology } from './lib/engine/graph/detachTopology.js';
import type { StageNode } from './lib/engine/graph/StageNode.js';
import { projectSkippedChart, type SkippedChartProjection } from './lib/engine/graph/skippedProjection.js';
import { canBindStoredControl, installStoredControl } from './lib/memory/storedControlEvidence.js';
import type { FlowChartExecutorOptions, PreparedStoredControl } from './lib/runner/options.js';

const declarations = new WeakMap<object, readonly string[]>();
const liveCharts = new WeakMap<object, SkippedChartProjection>();

/** @internal Exact live chart admission for the future native reader. */
export function liveSkippedChartOf(snapshot: object): SkippedChartProjection | undefined {
  return liveCharts.get(snapshot);
}

function observeCompletedChart(
  explanation: ExplainCapture,
  graph: SkippedChartProjection,
  runId: string,
  to: number,
): void {
  explanation.onWitness = (snapshot, witness) => {
    if (
      witness.boundary === 'completed' &&
      witness.runId === runId &&
      witness.logAddress.logRunId === runId &&
      witness.logAddress.drillPath.length === 0 &&
      witness.commits.from === 0 &&
      witness.commits.to === to
    ) {
      liveCharts.set(snapshot, graph);
    }
  };
}

/** @internal An exhaustive write declaration for this exact authored placement. */
export function declareSkippedWriterPaths(placement: StageNode, paths: readonly string[]): void {
  declarations.set(placement, Object.freeze([...paths]));
}

function prepareStoredControl<TOut, TScope>(
  chart: FlowChart<TOut, TScope>,
): PreparedStoredControl<TOut, TScope> | undefined {
  const detached = detachStageTopology(chart.root);
  if (!detached) return undefined;
  const stageMap = new Map(chart.stageMap);
  const projected = projectSkippedChart(detached.root, {
    hasStageFunction: (node) => stageMap.has(node.id),
    writesOf: (node) => declarations.get(detached.authoredOf(node) ?? node),
  });
  if (projected.status !== 'ready') return undefined;
  return {
    root: detached.root,
    stageMap,
    attach(runtime) {
      const log = runtime.executionHistory;
      installStoredControl(log, async (runId) => {
        const address = log.address;
        if (
          !address ||
          address.logRunId !== runId ||
          address.drillPath.length ||
          !canBindStoredControl(log) ||
          runtime.rootStageContext.getRedactionRule()?.isInert() === false
        )
          return;
        try {
          const to = log.length;
          const digest = await savedChartDigest(projected.graph);
          const explanation = runtime.capture?.explanation;
          if (explanation) observeCompletedChart(explanation, projected.graph, runId, to);
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
          // A projection that cannot be digested supplies no binding.
          return undefined;
        }
      });
    },
  };
}

const skippedWriterCapture = Object.assign(
  (...args: Parameters<typeof createExplainCapture>) => createExplainCapture(...args),
  { prepareStoredControl },
);

/** @internal Capture a detached native chart. No authority is returned from this option. */
export function skippedWriterCaptureOptions<TScope>(
  options: FlowChartExecutorOptions<TScope> = {},
): FlowChartExecutorOptions<TScope> {
  return markExplainOptions(explain(true, options), skippedWriterCapture);
}
