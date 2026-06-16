/**
 * loopIteration on TraversalContext — the engine now POPULATES the long-declared
 * `TraversalContext.loopIteration` field (previously declared but never set by the
 * traverser; only the narrative recorder computed its own private copy).
 *
 * Semantics (mirrors the narrative recorder's "pass N"):
 *   - absent on the first execution of a stage,
 *   - 1 on the first loop-back, 2 on the next, … (i.e. visitCount - 1),
 *   - keyed per stageId, run-scoped (resets each run()/resume()),
 *   - monotonic across subflow re-mounts (shared visit-count map),
 *   - populated for EVERY stage kind (any node can be a loop target).
 *
 * Convention-3 coverage: unit · functional · integration · property · security ·
 * performance · load (sections below).
 */
import { describe, expect, it } from 'vitest';

import type { FlowRecorder, FlowStageEvent, PausableHandler, TraversalContext } from '../../../../src';
import { decide, flowChart, FlowChartExecutor } from '../../../../src';

/** Capture (stageId, loopIteration) off every onStageExecuted event. */
function captureLoopIterations(): {
  recorder: FlowRecorder;
  rows: Array<{ stageId?: string; runtimeStageId?: string; loopIteration?: number }>;
} {
  const rows: Array<{ stageId?: string; runtimeStageId?: string; loopIteration?: number }> = [];
  const recorder: FlowRecorder = {
    id: 'capture-loop-iter',
    onStageExecuted(event: FlowStageEvent) {
      const tc: TraversalContext | undefined = event.traversalContext;
      rows.push({ stageId: tc?.stageId, runtimeStageId: tc?.runtimeStageId, loopIteration: tc?.loopIteration });
    },
  };
  return { recorder, rows };
}

/** A → B → loopTo(A), breaking after `breakAt` visits of A. */
function buildLoopChart(breakAt: number) {
  return flowChart(
    'StepA',
    (scope: any) => {
      scope.count = ((scope.count as number) ?? 0) + 1;
    },
    'step-a',
  )
    .addFunction(
      'StepB',
      (scope: any) => {
        if ((scope.count as number) >= breakAt) scope.$break();
      },
      'step-b',
    )
    .loopTo('step-a')
    .build();
}

// ─── 1. UNIT + 2. FUNCTIONAL ─────────────────────────────────────────
describe('loopIteration — basic loop sequence', () => {
  it('is absent on first visit, then 1, 2, … on each loop-back', async () => {
    const { recorder, rows } = captureLoopIterations();
    const executor = new FlowChartExecutor(buildLoopChart(3));
    executor.attachFlowRecorder(recorder);
    await executor.run({ input: {} });

    const a = rows.filter((r) => r.stageId === 'step-a').map((r) => r.loopIteration);
    const b = rows.filter((r) => r.stageId === 'step-b').map((r) => r.loopIteration);
    // step-a runs 3 times: first (absent), then 1, 2. step-b runs 3 times too.
    expect(a).toEqual([undefined, 1, 2]);
    expect(b).toEqual([undefined, 1, 2]);
  });

  it('a non-looping chart never carries loopIteration (field stays absent)', async () => {
    const { recorder, rows } = captureLoopIterations();
    const chart = flowChart(
      'A',
      (s: any) => {
        s.x = 1;
      },
      'a',
    )
      .addFunction(
        'B',
        (s: any) => {
          s.y = 2;
        },
        'b',
      )
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(recorder);
    await executor.run({ input: {} });

    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.loopIteration).toBeUndefined();
  });
});

// ─── 3. INTEGRATION — matches narrative "pass N" + run-scoping ─────────
describe('loopIteration — integration with narrative + run scoping', () => {
  it('agrees with the narrative recorder\'s "pass N" rendering', async () => {
    const { recorder, rows } = captureLoopIterations();
    const executor = new FlowChartExecutor(buildLoopChart(3));
    executor.enableNarrative();
    executor.attachFlowRecorder(recorder);
    await executor.run({ input: {} });

    // The narrative renders "(pass N)" for loop-backs; the context's
    // loopIteration must equal that N for the same stage executions.
    const narrative = executor.getNarrativeEntries();
    const passLines = narrative.filter((e) => /pass \d+/.test((e as any).text ?? ''));
    const passNumbers = passLines.map((e) => Number(/pass (\d+)/.exec((e as any).text)![1]));
    const ctxLoopBacks = rows
      .map((r) => r.loopIteration)
      .filter((n): n is number => n !== undefined)
      .sort();
    // Every rendered pass-N has a matching context loopIteration value.
    for (const n of passNumbers) expect(ctxLoopBacks).toContain(n);
  });

  it('is run-scoped — resets to the same sequence on a second run()', async () => {
    const executor = new FlowChartExecutor(buildLoopChart(2));
    const run1 = captureLoopIterations();
    executor.attachFlowRecorder(run1.recorder);
    await executor.run({ input: {} });

    const run2 = captureLoopIterations();
    executor.attachFlowRecorder(run2.recorder); // same id replaces — fresh capture
    await executor.run({ input: {} });

    const seq = (rows: typeof run1.rows) => rows.filter((r) => r.stageId === 'step-a').map((r) => r.loopIteration);
    expect(seq(run1.rows)).toEqual([undefined, 1]);
    expect(seq(run2.rows)).toEqual([undefined, 1]); // NOT [2, 3] — counts reset per run
  });
});

// ─── 4. PROPERTY ─────────────────────────────────────────────────────
describe('loopIteration — property', () => {
  it('for any N iterations, the k-th visit carries loopIteration === k-1 (undefined at k=1)', async () => {
    for (const N of [1, 2, 5, 8]) {
      const { recorder, rows } = captureLoopIterations();
      const executor = new FlowChartExecutor(buildLoopChart(N));
      executor.attachFlowRecorder(recorder);
      await executor.run({ input: {} });

      const a = rows.filter((r) => r.stageId === 'step-a').map((r) => r.loopIteration);
      expect(a.length).toBe(N);
      const expected = Array.from({ length: N }, (_, k) => (k === 0 ? undefined : k));
      expect(a).toEqual(expected);
    }
  });
});

// ─── 5. SECURITY / robustness — all stage kinds, looped decider ───────
describe('loopIteration — every stage kind (looped decider)', () => {
  it('a decider that is looped back to also carries loopIteration', async () => {
    const { recorder, rows } = captureLoopIterations();
    // seed → route(decider) → step → loopTo(route); break after a few passes.
    const chart = flowChart(
      'Seed',
      (s: any) => {
        s.count = 0;
      },
      'seed',
    )
      .addDeciderFunction(
        'Route',
        (scope: any) => decide(scope, [{ when: (s: any) => s.count >= 2, then: 'stop' }], 'go'),
        'route',
      )
      .addFunctionBranch('go', 'Step', (s: any) => {
        s.count += 1;
      })
      .addFunctionBranch('stop', 'Done', (s: any) => {
        s.$break();
      })
      .setDefault('go')
      .end()
      .loopTo('route')
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(recorder);
    await executor.run({ input: {} });

    const route = rows.filter((r) => r.stageId === 'route').map((r) => r.loopIteration);
    // route is a NON-linear (decider) stage and still gets loopIteration on re-entry.
    expect(route[0]).toBeUndefined();
    expect(route.slice(1)).toEqual(route.slice(1).map((_, i) => i + 1));
    expect(route.length).toBeGreaterThan(1);
  });
});

// ─── 3b. INTEGRATION — resume CONTINUES the count (twin of executionIndex) ──
describe('loopIteration — pause/resume continuity', () => {
  it('continues across same-executor resume — does NOT reset (mirrors executionCounter)', async () => {
    interface S {
      pass?: number;
      approved?: boolean;
    }
    // seed → A(linear) → P(pausable) → loopTo(A). A breaks after 3 passes.
    // P pauses on the first execute; after resume (approved) it continues.
    const handler: PausableHandler<S> = {
      execute: async (scope) => (scope.approved ? undefined : { question: 'approve?' }),
      resume: async (scope, input) => {
        scope.approved = (input as { approved: boolean }).approved;
      },
    };
    const chart = flowChart<S>(
      'Seed',
      (s) => {
        if (s.pass === undefined) s.pass = 0;
      },
      'seed',
    )
      .addFunction(
        'A',
        (s) => {
          s.pass = (s.pass ?? 0) + 1;
          if ((s.pass ?? 0) >= 3) s.$break();
        },
        'step-a',
      )
      .addPausableFunction('P', handler, 'gate')
      .loopTo('step-a')
      .build();

    const { recorder, rows } = captureLoopIterations();
    const executor = new FlowChartExecutor(chart);
    executor.attachFlowRecorder(recorder);

    await executor.run({ input: {} });
    expect(executor.isPaused()).toBe(true);
    // Before pause: A ran once → loopIteration absent.
    expect(rows.filter((r) => r.stageId === 'step-a').map((r) => r.loopIteration)).toEqual([undefined]);

    await executor.resume(executor.getCheckpoint()!, { approved: true });

    // After resume A re-runs; its count must CONTINUE (1, 2 …) not restart at undefined.
    const a = rows.filter((r) => r.stageId === 'step-a').map((r) => r.loopIteration);
    expect(a).toEqual([undefined, 1, 2]); // NOT [undefined, undefined, 1] — counts survive resume
  });
});

// ─── 6. PERFORMANCE + 7. LOAD ────────────────────────────────────────
describe('loopIteration — performance & load', () => {
  it('a long loop (200 iterations) stays correct and fast', async () => {
    const { recorder, rows } = captureLoopIterations();
    const executor = new FlowChartExecutor(buildLoopChart(200));
    executor.attachFlowRecorder(recorder);
    const t0 = performance.now();
    await executor.run({ input: {} });
    const elapsed = performance.now() - t0;

    const a = rows.filter((r) => r.stageId === 'step-a').map((r) => r.loopIteration);
    expect(a.length).toBe(200);
    expect(a[0]).toBeUndefined();
    expect(a[199]).toBe(199);
    expect(elapsed).toBeLessThan(2000);
  });
});
