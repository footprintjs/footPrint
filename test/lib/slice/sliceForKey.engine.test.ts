/**
 * sliceForKey — the control-edge integration, which needs the engine.
 *
 * Moved verbatim from sliceForKey.test.ts in E1 (the record's tests run without the engine): the point
 * of this test is what the engine's own ControlDepRecorder observes while a chart runs — which decider
 * governed the writer — and that recorder is attached to the executor and fed by its flow events; a
 * record written through foottrace/write has no decider to observe.
 * (The one edit: the tree is typed as the record's `ExecutionTree`, not the frame's `StageSnapshot`.)
 */

import type { ExecutionTree } from 'foottrace';
import { keysReadFromExecutionTree, sliceForKey } from 'foottrace';
import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../src/lib/builder/FlowChartBuilder.js';
import { controlDepRecorder } from '../../../src/lib/recorder/ControlDepRecorder.js';
import { FlowChartExecutor } from '../../../src/lib/runner/FlowChartExecutor.js';

// ════════════════════════════════════════════════════════════════════════
// INTEGRATION — with ControlDepRecorder: the slice explains BOTH data
// lineage and "which decision allowed the writer to run".
// ════════════════════════════════════════════════════════════════════════

describe('sliceForKey — integration (control edges)', () => {
  interface S {
    score?: number;
    verdict?: string;
  }

  it('the writer stage carries a control edge to its governing decider', async () => {
    const chart = flowChart<S>(
      'Score',
      async (scope) => {
        scope.score = 750;
      },
      'score',
    )
      .addDeciderFunction('Route', async (scope) => (scope.score! > 700 ? 'good' : 'bad'), 'route')
      .addFunctionBranch('good', 'Approve', async (scope) => {
        scope.verdict = 'approved';
      })
      .addFunctionBranch('bad', 'Reject', async (scope) => {
        scope.verdict = 'rejected';
      })
      .setDefault('bad')
      .end()
      .build();

    const ctrl = controlDepRecorder();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(ctrl);
    await executor.run();
    const snapshot = executor.getSnapshot();

    const slice = sliceForKey(
      snapshot.commitLog,
      'verdict',
      keysReadFromExecutionTree(snapshot.executionTree as ExecutionTree),
      { controlDeps: ctrl.asLookup() },
    );

    expect(slice.writer?.stage).toBe('Approve');
    const controlEdge = slice.root!.parentEdges.find((e) => e.kind === 'control');
    expect(controlEdge).toBeDefined();
    expect(controlEdge!.parent.runtimeStageId).toMatch(/^route#/);
  });
});
