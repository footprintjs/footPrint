/**
 * Subflow-scope resume — 7-pattern tests.
 *
 * Until v4.16.0, a pause inside a subflow lost the subflow's isolated scope.
 * The PauseSignal carried only the subflow PATH; the inner `SharedMemory`
 * was garbage-collected before the checkpoint was built, so `sharedState`
 * on the checkpoint held only the OUTER scope. On resume, the nested
 * runtime was re-created empty, so the resume handler's reads of the
 * pre-pause scope (e.g., `scope.items`, `scope.history`) returned
 * `undefined` — failing composition-level HITL patterns like
 * `Sequence(Agent-that-pauses)`.
 *
 * The fix:
 *   1. `PauseSignal.captureSubflowScope(id, state)` — invoked by
 *      `SubflowExecutor` right before re-throw to snapshot the isolated
 *      `SharedMemory`.
 *   2. `FlowchartCheckpoint.subflowStates` — required field (always
 *      present, empty `{}` for root pauses) that serializes the
 *      captured scopes per subflow id.
 *   3. `HandlerDeps.subflowStatesForResume` → `SubflowExecutor` seeds
 *      each nested runtime from the map on resume and skips the
 *      inputMapper to preserve pre-pause state.
 *
 * 7 test patterns: Unit · Scenario · Integration · Property · Security ·
 * Performance · ROI.
 */
import { describe, expect, it } from 'vitest';

import type { PausableHandler } from '../../../src';
import { flowChart, FlowChartExecutor } from '../../../src';

// ── Fixtures ───────────────────────────────────────────────────────

interface OuterState {
  stage?: string;
  [key: string]: unknown;
}

interface InnerState {
  items?: string[];
  reviewedBy?: string;
  step?: number;
  [key: string]: unknown;
}

/**
 * Build an inner chart that:
 *   - on run: accumulates `items`, then pauses inside a pausable stage
 *   - on resume: reads pre-pause `items`, appends `reviewedBy`, writes `step`
 */
function buildInnerChart() {
  return flowChart<InnerState>(
    'Accumulate',
    (scope) => {
      // Built from input (the inputMapper passes `seedItem`).
      const args = scope.$getArgs<{ seedItem: string }>();
      scope.items = ['original', args.seedItem];
      scope.step = 1;
    },
    'accumulate',
  )
    .addPausableFunction(
      'Review',
      {
        execute: async (scope) => {
          scope.step = 2;
          return { question: 'Who reviewed?' };
        },
        resume: async (scope, input) => {
          // CRITICAL read: pre-pause `items` must be accessible here.
          const itemsBefore = scope.items as string[] | undefined;
          const reviewedBy = (input as { reviewedBy: string }).reviewedBy;
          scope.items = [...(itemsBefore ?? []), `reviewed-by-${reviewedBy}`];
          scope.reviewedBy = reviewedBy;
          scope.step = 3;
        },
      } as PausableHandler<InnerState, { reviewedBy: string }>,
      'review',
    )
    .addFunction(
      'Finalize',
      (scope) => {
        scope.step = 4;
      },
      'finalize',
    )
    .build();
}

/**
 * Build an outer chart that mounts the inner chart as a subflow.
 * outputMapper copies `items` and `reviewedBy` back to the parent scope.
 */
function buildOuterChart() {
  return flowChart<OuterState>(
    'OuterSeed',
    (scope) => {
      scope.stage = 'started';
    },
    'outer-seed',
  )
    .addSubFlowChartNext('sf-approval', buildInnerChart(), 'Approval', {
      inputMapper: () => ({ seedItem: 'from-outer' }),
      outputMapper: (sfOutput) => {
        const sf = sfOutput as InnerState;
        return { items: sf.items, reviewedBy: sf.reviewedBy };
      },
    })
    .addFunction(
      'OuterFinal',
      (scope) => {
        scope.stage = 'completed';
      },
      'outer-final',
    )
    .build();
}

// ── 1. Unit — PauseSignal captures subflow scope ───────────────────

describe('subflow-scope resume — unit', () => {
  it('checkpoint.subflowStates is present when paused inside a subflow', async () => {
    const executor = new FlowChartExecutor(buildOuterChart());
    await executor.run();
    const cp = executor.getCheckpoint()!;

    expect(cp.subflowPath).toEqual(['sf-approval']);
    expect(cp.subflowStates).toBeDefined();
    expect(cp.subflowStates!['sf-approval']).toBeDefined();
    // The inner subflow's pre-pause scope survived into the checkpoint
    expect(cp.subflowStates!['sf-approval'].items).toEqual(['original', 'from-outer']);
    expect(cp.subflowStates!['sf-approval'].step).toBe(2);
  });

  it('checkpoint.subflowStates is an empty object for root-level pauses (no nesting)', async () => {
    const chart = flowChart<InnerState>(
      'Pause',
      { execute: () => ({ q: '?' }), resume: () => {} } as PausableHandler<InnerState>,
      'pause-root',
    ).build();
    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const cp = executor.getCheckpoint()!;

    expect(cp.subflowPath).toEqual([]);
    // Always present, empty when no subflows were entered.
    expect(cp.subflowStates).toEqual({});
  });
});

// ── 2. Scenario — full round trip on same executor ─────────────────

describe('subflow-scope resume — scenario (same-executor)', () => {
  it('resume handler sees pre-pause subflow scope; outer chart finishes', async () => {
    const executor = new FlowChartExecutor(buildOuterChart());
    await executor.run();
    const cp = executor.getCheckpoint()!;
    await executor.resume(cp, { reviewedBy: 'Alice' });

    const snap = executor.getSnapshot();
    // Outer received the reviewed items via outputMapper
    expect(snap.sharedState.items).toEqual(['original', 'from-outer', 'reviewed-by-Alice']);
    expect(snap.sharedState.reviewedBy).toBe('Alice');
    expect(snap.sharedState.stage).toBe('completed');
  });
});

// ── 3. Integration — cross-executor resume across subflow boundary ─

describe('subflow-scope resume — integration (cross-executor)', () => {
  it('fresh executor + serialized checkpoint → resume succeeds across subflow boundary', async () => {
    const a = new FlowChartExecutor(buildOuterChart());
    await a.run();
    const cp = a.getCheckpoint()!;
    const wire = JSON.parse(JSON.stringify(cp));

    const b = new FlowChartExecutor(buildOuterChart());
    await b.resume(wire, { reviewedBy: 'Bob' });

    const snap = b.getSnapshot();
    expect(snap.sharedState.items).toEqual(['original', 'from-outer', 'reviewed-by-Bob']);
    expect(snap.sharedState.reviewedBy).toBe('Bob');
    expect(snap.sharedState.stage).toBe('completed');
  });
});

// ── 4. Property — resume is deterministic across executors ─────────

describe('subflow-scope resume — property', () => {
  it('same checkpoint + same input yields same final state on any executor', async () => {
    const orig = new FlowChartExecutor(buildOuterChart());
    await orig.run();
    const cp = orig.getCheckpoint()!;
    await orig.resume(cp, { reviewedBy: 'Same' });
    const origFinal = orig.getSnapshot().sharedState;

    const clone = new FlowChartExecutor(buildOuterChart());
    await clone.resume(JSON.parse(JSON.stringify(cp)), { reviewedBy: 'Same' });
    const cloneFinal = clone.getSnapshot().sharedState;

    expect(cloneFinal.items).toEqual(origFinal.items);
    expect(cloneFinal.reviewedBy).toEqual(origFinal.reviewedBy);
    expect(cloneFinal.stage).toEqual(origFinal.stage);
  });
});

// ── 5. Security — checkpoint validation ──

describe('subflow-scope resume — security (checkpoint validation)', () => {
  it('rejects malformed checkpoints with non-object sharedState even when subflow-nested', async () => {
    const a = new FlowChartExecutor(buildOuterChart());
    await a.run();
    const cp = a.getCheckpoint()!;
    const tampered = { ...cp, sharedState: 'not an object' };
    const b = new FlowChartExecutor(buildOuterChart());
    await expect(b.resume(tampered as never, {})).rejects.toThrow(/Invalid checkpoint/);
  });
});

// ── 6. Performance — subflow-scope round trip bounded ──────────────

describe('subflow-scope resume — performance', () => {
  it('pause + cross-executor resume completes in under 500ms (CI-safe)', async () => {
    const t0 = performance.now();
    const a = new FlowChartExecutor(buildOuterChart());
    await a.run();
    const cp = a.getCheckpoint()!;
    const b = new FlowChartExecutor(buildOuterChart());
    await b.resume(JSON.parse(JSON.stringify(cp)), { reviewedBy: 'P' });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(500);
  });
});

// ── 7. ROI — repeated pause/resume across independent executors ────

describe('subflow-scope resume — ROI', () => {
  it('20 independent fresh executors resume from one canonical subflow checkpoint', async () => {
    const seed = new FlowChartExecutor(buildOuterChart());
    await seed.run();
    const wire = JSON.stringify(seed.getCheckpoint()!);

    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      const fresh = new FlowChartExecutor(buildOuterChart());
      await fresh.resume(JSON.parse(wire), { reviewedBy: `R${i}` });
      seen.push(String(fresh.getSnapshot().sharedState.reviewedBy));
    }

    // Each resume saw its own input and produced deterministic results
    for (let i = 0; i < 20; i++) {
      expect(seen[i]).toBe(`R${i}`);
    }
  });
});
