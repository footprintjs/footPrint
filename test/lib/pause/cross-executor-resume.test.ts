/**
 * Cross-executor resume — 7-pattern tests.
 *
 * Until v4.16.0, `FlowChartExecutor.resume()` implicitly required same-executor
 * continuity: the resume path always reused the constructor-time runtime,
 * silently discarding `checkpoint.sharedState`. Fresh executors (constructed
 * after a checkpoint was serialized to external storage) came back with an
 * empty SharedMemory and resume handlers couldn't read pre-pause scope.
 *
 * The fix: `_hasRunBefore` — `run()` flips it, `resume()` branches on it.
 *   - `_hasRunBefore === true`  → reuse existingRuntime (same-executor path)
 *   - `_hasRunBefore === false` → seed a new runtime from `checkpoint.sharedState`
 *                                 (cross-executor / cross-process path)
 *
 * The 7 test patterns exercise: Unit · Scenario · Integration · Property ·
 * Security · Performance · ROI (reuse-over-time).
 */
import { describe, expect, it } from 'vitest';

import type { PausableHandler } from '../../../src';
import { flowChart, FlowChartExecutor } from '../../../src';

// ── Shared fixtures ────────────────────────────────────────────────

interface State {
  value?: string;
  step?: number;
  approved?: boolean;
  notes?: string[];
  [key: string]: unknown;
}

function buildChart() {
  return flowChart<State>(
    'Receive',
    (scope) => {
      scope.value = 'received';
      scope.step = 1;
      scope.notes = ['seeded'];
    },
    'receive',
  )
    .addPausableFunction(
      'Approve',
      {
        execute: async (scope) => {
          scope.step = 2;
          return { question: 'Approve?' };
        },
        resume: async (scope, input) => {
          const prior = (scope.notes as string[] | undefined) ?? [];
          scope.notes = [...prior, 'resumed'];
          scope.approved = (input as { approved?: boolean }).approved ?? false;
          scope.step = 3;
        },
      } as PausableHandler<State, { approved: boolean }>,
      'approve',
    )
    .addFunction(
      'Process',
      (scope) => {
        scope.value = scope.approved ? 'processed' : 'rejected';
        scope.step = 4;
      },
      'process',
    )
    .build();
}

// ── 1. Unit — flag lifecycle ───────────────────────────────────────

describe('cross-executor resume — unit', () => {
  it('a brand new executor that only ever calls resume() hydrates sharedState from the checkpoint', async () => {
    const originalExecutor = new FlowChartExecutor(buildChart());
    await originalExecutor.run();
    const checkpoint = originalExecutor.getCheckpoint()!;
    expect(checkpoint).toBeDefined();
    expect(checkpoint.sharedState.notes).toEqual(['seeded']);

    // Fresh executor — simulates a new process reconstructing from stored checkpoint
    const freshExecutor = new FlowChartExecutor(buildChart());
    await freshExecutor.resume(checkpoint, { approved: true });

    const snap = freshExecutor.getSnapshot();
    expect(snap.sharedState.value).toBe('processed');
    expect(snap.sharedState.step).toBe(4);
    expect(snap.sharedState.approved).toBe(true);
    // Pre-pause note preserved, resume appended its own note
    expect(snap.sharedState.notes).toEqual(['seeded', 'resumed']);
  });
});

// ── 2. Scenario — full Redis-style round trip ──────────────────────

describe('cross-executor resume — scenario', () => {
  it('checkpoint survives JSON serialize/deserialize and resumes cleanly on a new executor', async () => {
    const executorA = new FlowChartExecutor(buildChart());
    await executorA.run();
    const cpA = executorA.getCheckpoint()!;

    // Serialize (simulates Redis.set) + deserialize (simulates Redis.get in another process).
    const wire = JSON.stringify(cpA);
    const cpB = JSON.parse(wire);

    const executorB = new FlowChartExecutor(buildChart());
    await executorB.resume(cpB, { approved: false });

    const snap = executorB.getSnapshot();
    expect(snap.sharedState.value).toBe('rejected');
    expect(snap.sharedState.step).toBe(4);
    expect(snap.sharedState.notes).toEqual(['seeded', 'resumed']);
  });
});

// ── 3. Integration — same-executor resume is NOT regressed ─────────

describe('cross-executor resume — integration (same-executor path unchanged)', () => {
  it('same executor run() then resume() still preserves execution-tree continuity', async () => {
    const executor = new FlowChartExecutor(buildChart());
    executor.enableNarrative();
    await executor.run();
    const cp = executor.getCheckpoint()!;
    await executor.resume(cp, { approved: true });

    const snap = executor.getSnapshot();
    expect(snap.sharedState.value).toBe('processed');
    expect(snap.sharedState.notes).toEqual(['seeded', 'resumed']);
    // Execution tree accumulated across pause/resume (existing contract)
    expect(snap.executionTree).toBeDefined();
  });
});

// ── 4. Property — fresh-executor resume is independent of same-executor ──

describe('cross-executor resume — property', () => {
  it('fresh executors produce the same final state as the original for a given checkpoint + input', async () => {
    const originalExecutor = new FlowChartExecutor(buildChart());
    await originalExecutor.run();
    const checkpoint = originalExecutor.getCheckpoint()!;

    // Drive the original to completion
    await originalExecutor.resume(checkpoint, { approved: true });
    const originalFinal = originalExecutor.getSnapshot().sharedState;

    // Drive a fresh executor with the exact same checkpoint + input
    const freshExecutor = new FlowChartExecutor(buildChart());
    await freshExecutor.resume(JSON.parse(JSON.stringify(checkpoint)), { approved: true });
    const freshFinal = freshExecutor.getSnapshot().sharedState;

    // Same input → same final state (ignoring ephemeral timestamps)
    expect(freshFinal.value).toEqual(originalFinal.value);
    expect(freshFinal.approved).toEqual(originalFinal.approved);
    expect(freshFinal.step).toEqual(originalFinal.step);
    expect(freshFinal.notes).toEqual(originalFinal.notes);
  });
});

// ── 5. Security — hostile/malformed checkpoint rejected cleanly ────

describe('cross-executor resume — security', () => {
  it('rejects checkpoints with non-object sharedState even on fresh executors', async () => {
    const fresh = new FlowChartExecutor(buildChart());
    const bad = {
      sharedState: 'not an object',
      executionTree: null,
      pausedStageId: 'approve',
      subflowPath: [],
      pausedAt: 0,
    };
    await expect(fresh.resume(bad as never, {})).rejects.toThrow(/Invalid checkpoint/);
  });

  it('rejects checkpoints referencing a nonexistent stageId on fresh executors', async () => {
    const fresh = new FlowChartExecutor(buildChart());
    const bad = {
      sharedState: {},
      executionTree: null,
      pausedStageId: 'no-such-stage',
      subflowPath: [],
      pausedAt: 0,
    };
    await expect(fresh.resume(bad as never, {})).rejects.toThrow();
  });
});

// ── 6. Performance — cross-executor resume is bounded ──────────────

describe('cross-executor resume — performance', () => {
  it('fresh-executor resume completes within a reasonable CI budget', async () => {
    const originalExecutor = new FlowChartExecutor(buildChart());
    await originalExecutor.run();
    const checkpoint = originalExecutor.getCheckpoint()!;

    const t0 = performance.now();
    const fresh = new FlowChartExecutor(buildChart());
    await fresh.resume(checkpoint, { approved: true });
    const ms = performance.now() - t0;

    // CI-safe ceiling. Regression would look like seconds, not sub-100ms.
    expect(ms).toBeLessThan(500);
  });
});

// ── 7. ROI — many cross-executor resumes on independent executors ──

describe('cross-executor resume — ROI (long-lived fleet)', () => {
  it('20 independent fresh executors each successfully resume from a shared checkpoint', async () => {
    const original = new FlowChartExecutor(buildChart());
    await original.run();
    const cp = original.getCheckpoint()!;
    const wire = JSON.stringify(cp); // one canonical serialized form

    const results: unknown[] = [];
    for (let i = 0; i < 20; i++) {
      const fresh = new FlowChartExecutor(buildChart());
      await fresh.resume(JSON.parse(wire), { approved: i % 2 === 0 });
      results.push(fresh.getSnapshot().sharedState.value);
    }

    // Alternates processed/rejected exactly. No cross-executor contamination.
    const expected: string[] = [];
    for (let i = 0; i < 20; i++) {
      expected.push(i % 2 === 0 ? 'processed' : 'rejected');
    }
    expect(results).toEqual(expected);
  });
});
