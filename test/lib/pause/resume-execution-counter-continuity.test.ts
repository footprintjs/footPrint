/**
 * Regression: the shared execution counter + per-stage visit counts must survive
 * a CROSS-EXECUTOR resume, not just a same-executor one.
 *
 * INVARIANT (CLAUDE.md): "executionIndex globally monotonic per run; continues
 * across resume", and `runtimeStageId` (`stageId#executionIndex`) uniqueness is
 * the foundation of the whole event-correlation model.
 *
 * This HOLDS for same-executor resume — `_executionCounter`/`_visitCounts` are
 * instance fields the traverser shares by reference, so the counter keeps
 * climbing across the pause/resume cycle. It BREAKS for the documented
 * cross-executor pattern (`new FlowChartExecutor(chart); await ex.resume(cp)`):
 * a fresh executor starts `_executionCounter = { value: 0 }` and an empty
 * `_visitCounts`, and the checkpoint carried NEITHER — so post-resume stages
 * re-used pre-pause `runtimeStageId`s (silently overwriting recorder store
 * entries) and loop iterations mislabelled (restarting at 0).
 *
 * THE FIX: the checkpoint now carries `executionCount` + `visitCounts`, and
 * `resume()` seeds both (by mutation — the traverser holds them by reference)
 * before rebuilding the cursor.
 *
 * Test types: Unit (counter monotonic) · Scenario (resume-cursor label) ·
 * Integration (same-executor unchanged) · Back-compat (old checkpoint) ·
 * Loop-continuity (visitCounts → loopIteration).
 */
import type { FlowRecorder, PausableHandler } from 'footprintjs';
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';

// ── Helpers ─────────────────────────────────────────────────

interface LinearState {
  trail?: string[];
  approved?: boolean;
  done?: boolean;
  [key: string]: unknown;
}

/** 2 plain stages → 1 pausable → 1 plain (the shape the task prescribes). */
function buildLinearChart() {
  return flowChart<LinearState>(
    'Alpha',
    (scope) => {
      scope.trail = ['alpha'];
    },
    'alpha',
  )
    .addFunction(
      'Beta',
      (scope) => {
        scope.trail = [...(scope.trail ?? []), 'beta'];
      },
      'beta',
    )
    .addPausableFunction(
      'Gate',
      {
        execute: async () => ({ question: 'Approve?' }),
        resume: async (scope, input) => {
          scope.approved = (input as { approved?: boolean } | undefined)?.approved ?? true;
          scope.trail = [...(scope.trail ?? []), 'gate'];
        },
      } as PausableHandler<LinearState, { approved: boolean }>,
      'gate',
    )
    .addFunction(
      'Omega',
      (scope) => {
        scope.trail = [...(scope.trail ?? []), 'omega'];
        scope.done = true;
      },
      'omega',
    )
    .build();
}

/** The executionIndex encoded in a `stageId#index` runtimeStageId. */
function idxOf(runtimeStageId: string): number {
  return Number(runtimeStageId.split('#').pop());
}

/**
 * A FlowRecorder that records the `runtimeStageId` of every stage the engine
 * actually executes — via `onStageExecuted` (linear/decider/etc.), plus
 * `onPause` (the paused stage never reaches onStageExecuted) so the paused
 * stage's index is counted too.
 */
function idRecorder(id: string): {
  rec: FlowRecorder;
  executed: string[];
  paused: string[];
  ticks: { stageId?: string; loopIteration?: number }[];
} {
  const executed: string[] = [];
  const paused: string[] = [];
  const ticks: { stageId?: string; loopIteration?: number }[] = [];
  const rec: FlowRecorder = {
    id,
    onStageExecuted: (e) => {
      const rsid = e.traversalContext?.runtimeStageId;
      if (rsid) executed.push(rsid);
      ticks.push({
        stageId: e.traversalContext?.stageId,
        loopIteration: e.traversalContext?.loopIteration,
      });
    },
    onPause: (e) => {
      const rsid = e.traversalContext?.runtimeStageId;
      if (rsid) paused.push(rsid);
    },
  };
  return { rec, executed, paused, ticks };
}

// ── 1. Unit — counter monotonic + no runtimeStageId reuse ─────────────

describe('cross-executor resume — execution counter continuity', () => {
  it('post-resume runtimeStageIds are unique vs pre-pause AND indexes keep climbing', async () => {
    // Executor A: run to pause, capturing every pre-pause runtimeStageId.
    const executorA = new FlowChartExecutor(buildLinearChart());
    const a = idRecorder('A');
    executorA.attachFlowRecorder(a.rec);
    await executorA.run();
    expect(executorA.isPaused()).toBe(true);

    const prePauseIds = [...a.executed, ...a.paused]; // alpha#0, beta#1, gate#2
    const prePauseMaxIdx = Math.max(...prePauseIds.map(idxOf));

    const checkpoint = executorA.getCheckpoint()!;

    // Fresh executor B (simulates a new process reconstructing from storage).
    const executorB = new FlowChartExecutor(buildLinearChart());
    const b = idRecorder('B');
    executorB.attachFlowRecorder(b.rec);
    await executorB.resume(checkpoint, { approved: true });
    expect(executorB.isPaused()).toBe(false);

    const postResumeIds = b.executed; // fix: gate#3, omega#4 — bug: gate#0, omega#1

    // (a) No runtimeStageId is reused across the pause boundary.
    const union = [...prePauseIds, ...postResumeIds];
    expect(new Set(union).size).toBe(union.length);

    // (b) Every post-resume executionIndex is strictly greater than the
    //     highest pre-pause index — the counter continued, it did not restart.
    for (const rsid of postResumeIds) {
      expect(idxOf(rsid)).toBeGreaterThan(prePauseMaxIdx);
    }
  });
});

// ── 2. Scenario — resume-cursor label matches same-executor ───────────

describe('cross-executor resume — cursor label', () => {
  it("the resumed stage's #index equals the index it gets on same-executor resume", async () => {
    // Same-executor baseline: run then resume on the SAME instance.
    const same = new FlowChartExecutor(buildLinearChart());
    const sameRec = idRecorder('same');
    same.attachFlowRecorder(sameRec.rec);
    await same.run();
    await same.resume(same.getCheckpoint()!, { approved: true });
    const sameGateResumeIdx = idxOf(sameRec.executed.find((r) => r.startsWith('gate#'))!);

    // Cross-executor: run on A, resume on a fresh B.
    const crossA = new FlowChartExecutor(buildLinearChart());
    await crossA.run();
    const crossB = new FlowChartExecutor(buildLinearChart());
    const crossRec = idRecorder('cross');
    crossB.attachFlowRecorder(crossRec.rec);
    await crossB.resume(crossA.getCheckpoint()!, { approved: true });
    const crossGateResumeIdx = idxOf(crossRec.executed.find((r) => r.startsWith('gate#'))!);

    expect(crossGateResumeIdx).toBe(sameGateResumeIdx);
  });
});

// ── 3. Integration — same-executor resume is NOT regressed ────────────

describe('same-executor resume — counter continuity (unchanged)', () => {
  it('same-executor resume keeps runtimeStageIds unique and indexes monotonic', async () => {
    const executor = new FlowChartExecutor(buildLinearChart());
    const rec = idRecorder('same-exec');
    executor.attachFlowRecorder(rec.rec);

    await executor.run();
    const preIds = [...rec.executed, ...rec.paused];
    const preMaxIdx = Math.max(...preIds.map(idxOf));
    const preExecutedCount = rec.executed.length;

    await executor.resume(executor.getCheckpoint()!, { approved: true });
    expect(executor.isPaused()).toBe(false);

    const postIds = rec.executed.slice(preExecutedCount);
    const allIds = [...preIds, ...postIds];
    expect(new Set(allIds).size).toBe(allIds.length);
    for (const rsid of postIds) {
      expect(idxOf(rsid)).toBeGreaterThan(preMaxIdx);
    }
  });
});

// ── 4. Back-compat — a checkpoint WITHOUT the new fields still resumes ──

describe('cross-executor resume — back-compat with pre-fix checkpoints', () => {
  it('an old checkpoint (no executionCount/visitCounts) resumes without throwing', async () => {
    const executorA = new FlowChartExecutor(buildLinearChart());
    await executorA.run();
    const checkpoint = executorA.getCheckpoint()!;

    // Simulate a checkpoint persisted before the fix shipped: strip the fields.
    const legacy = { ...checkpoint };
    delete (legacy as { executionCount?: number }).executionCount;
    delete (legacy as { visitCounts?: Record<string, number> }).visitCounts;

    const executorB = new FlowChartExecutor(buildLinearChart());
    // Must not throw — old checkpoints resume with today's (degraded) behavior.
    await executorB.resume(legacy, { approved: true });
    expect(executorB.isPaused()).toBe(false);
    const snap = executorB.getSnapshot();
    expect(snap.sharedState.done).toBe(true);
    expect(snap.sharedState.approved).toBe(true);
  });
});

// ── 5. Loop continuity — visitCounts drive loopIteration across resume ──

interface LoopState {
  pass?: number;
  approved?: boolean;
  done?: boolean;
  [key: string]: unknown;
}

/**
 * ReAct-shaped loop: `tick` (loop target) → `route` decider → pausable `gate`
 * branch that loops back to `tick`, or `done` terminal. The gate pauses ONLY on
 * the 2nd pass (mid-loop), so at pause `tick` already has visitCount 2.
 */
function buildLoopChart() {
  const gate: PausableHandler<LoopState, { approved: boolean }> = {
    execute: async (scope) => {
      // Pause mid-loop (on the 2nd pass); otherwise continue → loop back.
      if (scope.pass === 2) return { question: 'Approve iteration 2?' };
    },
    resume: async (scope, input) => {
      scope.approved = (input as { approved?: boolean } | undefined)?.approved ?? true;
    },
  };
  return flowChart<LoopState>(
    'Tick',
    (scope) => {
      scope.pass = (scope.pass ?? 0) + 1;
    },
    'tick',
  )
    .addDeciderFunction('Route', (scope) => ((scope.pass ?? 0) < 3 ? 'again' : 'done'), 'route')
    .addPausableFunctionBranch('again', 'Gate', gate, 'Human approval gate', { loopTo: 'tick' })
    .addFunctionBranch('done', 'Done', async (scope) => {
      scope.done = true;
    })
    .setDefault('done')
    .end()
    .build();
}

describe('cross-executor resume — loop iteration continuity', () => {
  it('loopIteration continues (not restarting) after a cross-executor resume mid-loop', async () => {
    const executorA = new FlowChartExecutor(buildLoopChart());
    await executorA.run({ input: {} });
    expect(executorA.isPaused()).toBe(true);
    // First run looped once: tick(pass1) → route → gate(continue) → tick(pass2) → route → gate(PAUSE).
    expect((executorA.getSnapshot().sharedState as LoopState).pass).toBe(2);

    const checkpoint = JSON.parse(JSON.stringify(executorA.getCheckpoint()!));

    const executorB = new FlowChartExecutor(buildLoopChart());
    const b = idRecorder('loop-B');
    executorB.attachFlowRecorder(b.rec);
    await executorB.resume(checkpoint, { approved: true });

    // Run completes: approve → loop back into tick (pass 3) → route('done') → done.
    expect(executorB.isPaused()).toBe(false);
    const final = executorB.getSnapshot().sharedState as LoopState;
    expect(final.approved).toBe(true);
    expect(final.done).toBe(true);
    expect(final.pass).toBe(3);

    // The post-resume `tick` is its 3rd visit overall — loopIteration must
    // continue at 2, NOT restart at 0/undefined (that is the bug's signature).
    const tickTick = b.ticks.find((t) => t.stageId === 'tick');
    expect(tickTick).toBeDefined();
    expect(tickTick!.loopIteration).toBe(2);
  });
});
