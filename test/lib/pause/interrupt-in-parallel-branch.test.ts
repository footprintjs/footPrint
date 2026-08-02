/**
 * THE HONEST LIMITATION — an `interrupt()` inside a `parallelForEach` branch
 * pauses correctly, but cannot be resumed, and says so.
 *
 * Design: docs/design/execution-control.md (D1 + D3). This is documented and
 * pinned rather than hidden, because the alternative failure mode is far
 * worse than a refusal.
 *
 * WHY IT CANNOT RESUME. A branch is a subflow the run GENERATED from the
 * payload; it exists in the traverser's live registry, never in the static
 * chart. `resume()` rebuilds its cursor from `pausedStageId + subflowPath`
 * against the CURRENT chart (M2's invariant: "the chart graph is static and
 * id-stable"), and a generated branch is by definition neither. This is the
 * pre-existing behaviour of EVERY dynamically-registered subflow, not
 * something this feature introduced.
 *
 * WHY THAT IS THE RIGHT FAILURE. The refusal comes from the shipped
 * `findNodeInGraph` miss — no code anywhere special-cases the marker to
 * produce it. A silent partial resume (re-running the fan-out and hoping the
 * factory rebuilds an identical branch) would be the "would not crash, would
 * silently corrupt" class the whole design is built to avoid.
 *
 * Test types: Scenario (pause from inside a branch) · Functional (the
 * checkpoint names the generated segment) · Security (the refusal is loud,
 * with an actionable message) · Regression (no marker special-casing crept in).
 */
import { describe, expect, it } from 'vitest';

import type { FlowchartCheckpoint } from '../../../src/index.js';
import { flowChart, FlowChartExecutor, interrupt } from '../../../src/index.js';

interface State {
  items?: string[];
  results?: unknown[];
  [key: string]: unknown;
}

function buildChart() {
  return flowChart<State>(
    'Seed',
    (scope) => {
      scope.items = ['a'];
    },
    'seed',
  )
    .addParallelForEach('Review', 'review', {
      items: (scope) => scope.items ?? [],
      branch: () =>
        flowChart<{ ok?: boolean; [key: string]: unknown }>(
          'Ask',
          (scope) => {
            const answer = interrupt<{ ok: boolean }>(scope, { reason: 'inside a branch?' });
            scope.ok = answer.ok;
          },
          'ask',
        ).build(),
      maxBranches: 4,
      into: 'results',
    })
    .build();
}

describe('interrupt inside a parallelForEach branch', () => {
  it('pauses the whole run — the signal bubbles out of the branch like any subflow pause', async () => {
    const result = await new FlowChartExecutor(buildChart()).run();

    expect((result as { paused?: boolean }).paused).toBe(true);
    const checkpoint = (result as { checkpoint: FlowchartCheckpoint }).checkpoint;
    expect(checkpoint.pauseData).toEqual({ reason: 'inside a branch?' });
    expect(checkpoint.pausedBy).toBe('interrupt');
  });

  it('the checkpoint NAMES the generated segment in its subflowPath — nothing is hidden', async () => {
    const result = await new FlowChartExecutor(buildChart()).run();
    const checkpoint = (result as { checkpoint: FlowchartCheckpoint }).checkpoint;

    expect(checkpoint.subflowPath).toEqual(['review~0']);
    expect(checkpoint.pausedStageId).toBe('review~0/ask');
  });

  it('REFUSES to resume, with the shipped not-found message (no marker special-casing)', async () => {
    const executor = new FlowChartExecutor(buildChart());
    const result = await executor.run();
    const checkpoint = (result as { checkpoint: FlowchartCheckpoint }).checkpoint;

    await expect(executor.resume(checkpoint, { ok: true })).rejects.toThrow(
      /Cannot resume: stage 'review~0\/ask' not found in flowchart/,
    );
  });

  it('the refusal is the same on a fresh executor (cross-process restore)', async () => {
    const first = new FlowChartExecutor(buildChart());
    const result = await first.run();
    const wire = JSON.parse(JSON.stringify((result as { checkpoint: FlowchartCheckpoint }).checkpoint));

    await expect(new FlowChartExecutor(buildChart()).resume(wire, { ok: true })).rejects.toThrow(
      /not found in flowchart/,
    );
  });

  it('a chart that interrupts OUTSIDE the fan-out resumes normally, fan-out and all', async () => {
    // The limitation is scoped to the branch body — the same chart pausing
    // before or after the fan-out has none of it.
    const chart = flowChart<State>(
      'Seed',
      (scope) => {
        scope.items = ['a', 'b'];
        const go = interrupt<{ go: boolean }>(scope, { reason: 'start the fan-out?' });
        scope.approved = go.go;
      },
      'seed',
    )
      .addParallelForEach('Review', 'review', {
        items: (scope) => scope.items ?? [],
        branch: (item: string) =>
          flowChart<{ echoed?: string; [key: string]: unknown }>(
            'Echo',
            (scope) => {
              scope.echoed = item;
            },
            'echo',
          ).build(),
        maxBranches: 4,
        into: 'results',
      })
      .build();

    const executor = new FlowChartExecutor(chart);
    const paused = await executor.run();
    await executor.resume((paused as { checkpoint: FlowchartCheckpoint }).checkpoint, { go: true });

    const state = executor.getSnapshot().sharedState as State;
    expect(state.approved).toBe(true);
    expect((state.results as Array<{ echoed?: string }>).map((r) => r.echoed)).toEqual(['a', 'b']);
  });
});
