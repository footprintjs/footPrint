/**
 * `interrupt(scope, { reason, expects? })` — pause from inside any stage body.
 *
 * Design: docs/design/execution-control.md — Round B test 5 (all four clauses)
 * plus the laws D3 states.
 *
 * The four clauses the doc asks for, each with its own test below:
 *   • the payload survives the checkpoint round trip;
 *   • resume re-enters the stage from its TOP;
 *   • a pause under a decider keeps its InvokerStamp;
 *   • executionIndex monotonicity holds across the resume.
 *
 * Test types: Unit (signal + one-shot answer) · Functional (round trip,
 * re-entry, decider/selector stages) · Integration (cross-executor resume
 * through a serialized checkpoint) · Scenario (subflow-nested interrupt) ·
 * Security (payload is carried verbatim, not interpreted; a swallowed signal
 * cannot silently continue past a pause) · Regression (invoker + counter).
 */
import { describe, expect, it } from 'vitest';

import type { FlowchartCheckpoint, FlowRecorder } from '../../../src/index.js';
import { flowChart, FlowChartExecutor, interrupt } from '../../../src/index.js';
import { InterruptSignal, isInterruptSignal } from '../../../src/lib/pause/interrupt.js';

interface RefundState {
  amount?: number;
  approved?: boolean;
  approver?: string;
  trail?: string[];
  done?: boolean;
  [key: string]: unknown;
}

function isPaused(result: unknown): result is { paused: true; checkpoint: FlowchartCheckpoint } {
  return typeof result === 'object' && result !== null && (result as { paused?: boolean }).paused === true;
}

/** Refund chart: a stage that stops mid-body to ask, then a follow-up stage. */
function buildRefundChart(onEnter?: () => void) {
  return flowChart<RefundState>(
    'Refund',
    (scope) => {
      onEnter?.();
      scope.amount = 4200;
      const answer = interrupt<{ approved: boolean; approver: string }>(scope, {
        reason: `Approve a $${scope.amount} refund?`,
        expects: { approved: 'boolean', approver: 'string' },
      });
      scope.approved = answer.approved;
      scope.approver = answer.approver;
    },
    'refund',
  )
    .addFunction(
      'Finish',
      (scope) => {
        scope.done = true;
      },
      'finish',
    )
    .build();
}

// ════════════════════════════════════════════════════════════════════════
// UNIT — the signal and the one-shot answer
// ════════════════════════════════════════════════════════════════════════

describe('InterruptSignal', () => {
  it('carries the payload and identifies itself across realms', () => {
    const signal = new InterruptSignal({ reason: 'why' });
    expect(signal.payload).toEqual({ reason: 'why' });
    expect(signal.name).toBe('InterruptSignal');
    expect(isInterruptSignal(signal)).toBe(true);
    expect(isInterruptSignal(new Error('nope'))).toBe(false);
    expect(isInterruptSignal({ name: 'InterruptSignal', payload: {} })).toBe(false);
  });

  it('interrupt() throws when no answer is pending', () => {
    expect(() => interrupt({}, { reason: 'ask' })).toThrow(InterruptSignal);
  });
});

// ════════════════════════════════════════════════════════════════════════
// FUNCTIONAL — the round trip
// ════════════════════════════════════════════════════════════════════════

describe('interrupt — checkpoint round trip', () => {
  it('pauses the run and puts the PAYLOAD in the checkpoint verbatim', async () => {
    const executor = new FlowChartExecutor(buildRefundChart());
    const result = await executor.run();

    expect(isPaused(result)).toBe(true);
    const checkpoint = (result as { checkpoint: FlowchartCheckpoint }).checkpoint;

    expect(checkpoint.pausedStageId).toBe('refund');
    expect(checkpoint.pauseData).toEqual({
      reason: 'Approve a $4200 refund?',
      expects: { approved: 'boolean', approver: 'string' },
    });
    expect(checkpoint.pausedBy).toBe('interrupt');
  });

  it('commits the writes made BEFORE the interrupt (that is why the resumed stage sees them)', async () => {
    const executor = new FlowChartExecutor(buildRefundChart());
    const result = await executor.run();
    const checkpoint = (result as { checkpoint: FlowchartCheckpoint }).checkpoint;

    expect(checkpoint.sharedState.amount).toBe(4200);
    expect(checkpoint.sharedState.approved).toBeUndefined();
  });

  it('the checkpoint survives JSON — it is one detached, serializable shape', async () => {
    const executor = new FlowChartExecutor(buildRefundChart());
    const result = await executor.run();
    const checkpoint = (result as { checkpoint: FlowchartCheckpoint }).checkpoint;

    const roundTripped = JSON.parse(JSON.stringify(checkpoint)) as FlowchartCheckpoint;
    expect(roundTripped.pauseData).toEqual(checkpoint.pauseData);
    expect(roundTripped.pausedBy).toBe('interrupt');
  });

  it('resume() hands the answer back OUT of the interrupt() call, and the run finishes', async () => {
    const executor = new FlowChartExecutor(buildRefundChart());
    const paused = await executor.run();
    const checkpoint = (paused as { checkpoint: FlowchartCheckpoint }).checkpoint;

    await executor.resume(checkpoint, { approved: true, approver: 'Jane' });
    const state = executor.getSnapshot().sharedState as RefundState;

    expect(state.approved).toBe(true);
    expect(state.approver).toBe('Jane');
    expect(state.done).toBe(true); // the continuation ran too
  });

  it('RESUME RE-ENTERS THE STAGE FROM ITS TOP — stages are atomic', async () => {
    let entries = 0;
    const executor = new FlowChartExecutor(buildRefundChart(() => (entries += 1)));

    const paused = await executor.run();
    expect(entries).toBe(1);

    await executor.resume((paused as { checkpoint: FlowchartCheckpoint }).checkpoint, {
      approved: false,
      approver: 'Sam',
    });
    // The body ran a SECOND time — the half before the interrupt is re-done.
    // This is the law consumers must design around, so it is pinned here.
    expect(entries).toBe(2);
    expect((executor.getSnapshot().sharedState as RefundState).approved).toBe(false);
  });

  it('works CROSS-EXECUTOR, from a serialized checkpoint on a fresh executor', async () => {
    const first = new FlowChartExecutor(buildRefundChart());
    const paused = await first.run();
    const wire = JSON.parse(JSON.stringify((paused as { checkpoint: FlowchartCheckpoint }).checkpoint));

    const second = new FlowChartExecutor(buildRefundChart());
    await second.resume(wire, { approved: true, approver: 'Ada' });

    const state = second.getSnapshot().sharedState as RefundState;
    expect(state.approved).toBe(true);
    expect(state.approver).toBe('Ada');
    expect(state.done).toBe(true);
  });

  it('a second interrupt in the same stage pauses AGAIN — one question, one answer', async () => {
    let asks = 0;
    const chart = flowChart<RefundState>(
      'Two questions',
      (scope) => {
        const first = interrupt<string>(scope, { reason: `q${(asks += 1)}` });
        scope.trail = [...(scope.trail ?? []), first];
        const second = interrupt<string>(scope, { reason: 'q2' });
        scope.trail = [...(scope.trail ?? []), second];
      },
      'ask',
    ).build();

    const executor = new FlowChartExecutor(chart);
    const first = await executor.run();
    expect(isPaused(first)).toBe(true);

    const second = await executor.resume((first as { checkpoint: FlowchartCheckpoint }).checkpoint, 'answer-1');
    // The FIRST interrupt consumed the answer; the second one asked its own.
    expect(isPaused(second)).toBe(true);
    expect((second as { checkpoint: FlowchartCheckpoint }).checkpoint.pauseData).toEqual({ reason: 'q2' });

    await executor.resume((second as { checkpoint: FlowchartCheckpoint }).checkpoint, 'answer-2');
    // The body re-ran from the top each time, so trail holds the LAST pass.
    expect((executor.getSnapshot().sharedState as RefundState).trail).toEqual(['answer-1', 'answer-2']);
  });
});

// ════════════════════════════════════════════════════════════════════════
// THE INVOKER + COUNTER INVARIANTS (doc test 5, clauses 3 and 4)
// ════════════════════════════════════════════════════════════════════════

describe('interrupt — engine invariants hold across the new entry path', () => {
  /** decider → branch stage that interrupts → decider's continuation. */
  function buildDeciderChart() {
    return flowChart<RefundState>(
      'Seed',
      (scope) => {
        scope.amount = 100;
      },
      'seed',
    )
      .addDeciderFunction('Route', () => 'needs-approval', 'route')
      .addFunctionBranch('needs-approval', 'Approve', (scope) => {
        const answer = interrupt<{ approved: boolean }>(scope, { reason: 'ok?' });
        scope.approved = answer.approved;
      })
      .addFunctionBranch('auto', 'Auto', (scope) => {
        scope.approved = true;
      })
      .end()
      .addFunction(
        'Finish',
        (scope) => {
          scope.done = true;
        },
        'finish',
      )
      .build();
  }

  it('interrupt WORKS inside a decider-dispatched branch stage (not just linear stages)', async () => {
    const executor = new FlowChartExecutor(buildDeciderChart());
    const result = await executor.run();

    expect(isPaused(result)).toBe(true);
    expect((result as { checkpoint: FlowchartCheckpoint }).checkpoint.pausedStageId).toBe('needs-approval');
  });

  it('A PAUSE UNDER A DECIDER KEEPS ITS INVOKER — without it resume terminates early', async () => {
    const executor = new FlowChartExecutor(buildDeciderChart());
    const result = await executor.run();
    const checkpoint = (result as { checkpoint: FlowchartCheckpoint }).checkpoint;

    // Stamped during bubble-up by the decider dispatch — the branch child has
    // no `.next` of its own, so this is the only route back to 'finish'.
    expect(checkpoint.invokerStageId).toBe('route');
    expect(checkpoint.continuationStageId).toBe('finish');

    await executor.resume(checkpoint, { approved: true });
    const state = executor.getSnapshot().sharedState as RefundState;
    expect(state.approved).toBe(true);
    expect(state.done).toBe(true); // reached the invoker's continuation
  });

  it('EXECUTIONINDEX STAYS MONOTONIC across the resume (no runtimeStageId is reused)', async () => {
    const seenIds: string[] = [];
    const recorder: FlowRecorder = {
      id: 'ids',
      onStageExecuted: (e) => {
        if (e.traversalContext?.runtimeStageId) seenIds.push(e.traversalContext.runtimeStageId);
      },
    };

    const executor = new FlowChartExecutor(buildRefundChart());
    executor.attachFlowRecorder(recorder);

    const paused = await executor.run();
    await executor.resume((paused as { checkpoint: FlowchartCheckpoint }).checkpoint, {
      approved: true,
      approver: 'Jane',
    });

    expect(seenIds.length).toBeGreaterThan(1);
    expect(new Set(seenIds).size).toBe(seenIds.length); // no reuse
    const indices = seenIds.map((id) => Number(id.slice(id.lastIndexOf('#') + 1)));
    expect([...indices].sort((a, b) => a - b)).toEqual(indices); // monotonic
  });

  it('the checkpoint carries the counter forward, so a cross-executor resume keeps climbing', async () => {
    const first = new FlowChartExecutor(buildRefundChart());
    const paused = await first.run();
    const checkpoint = (paused as { checkpoint: FlowchartCheckpoint }).checkpoint;
    expect(checkpoint.executionCount).toBeGreaterThan(0);

    const seenIds: string[] = [];
    const second = new FlowChartExecutor(buildRefundChart());
    second.attachFlowRecorder({
      id: 'ids',
      onStageExecuted: (e) => {
        if (e.traversalContext?.runtimeStageId) seenIds.push(e.traversalContext.runtimeStageId);
      },
    });
    await second.resume(JSON.parse(JSON.stringify(checkpoint)), { approved: true, approver: 'Ada' });

    for (const id of seenIds) {
      expect(Number(id.slice(id.lastIndexOf('#') + 1))).toBeGreaterThanOrEqual(checkpoint.executionCount!);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// SUBFLOW + RECORDER BEHAVIOUR
// ════════════════════════════════════════════════════════════════════════

describe('interrupt — inside a subflow', () => {
  it('pauses through the mount and resumes through it', async () => {
    const inner = flowChart<RefundState>(
      'Ask',
      (scope) => {
        const answer = interrupt<{ approved: boolean }>(scope, { reason: 'inner?' });
        scope.approved = answer.approved;
      },
      'ask',
    ).build();

    const chart = flowChart<RefundState>(
      'Seed',
      (scope) => {
        scope.amount = 7;
      },
      'seed',
    )
      .addSubFlowChartNext('sf-approval', inner, 'Approval', {
        inputMapper: (parent: RefundState) => ({ amount: parent.amount }),
        outputMapper: (sub: RefundState) => ({ approved: sub.approved }),
      })
      .build();

    const executor = new FlowChartExecutor(chart);
    const result = await executor.run();

    expect(isPaused(result)).toBe(true);
    const checkpoint = (result as { checkpoint: FlowchartCheckpoint }).checkpoint;
    expect(checkpoint.subflowPath).toEqual(['sf-approval']);
    expect(checkpoint.pauseData).toEqual({ reason: 'inner?' });
    expect(checkpoint.pausedBy).toBe('interrupt');

    await executor.resume(checkpoint, { approved: true });
    expect((executor.getSnapshot().sharedState as RefundState).approved).toBe(true);
  });
});

describe('interrupt — recorder-visible behaviour', () => {
  it('fires onPause, and does NOT fire onStageEnd (the stage did not return)', async () => {
    const events: string[] = [];
    const executor = new FlowChartExecutor(buildRefundChart());
    executor.attachFlowRecorder({
      id: 'flow',
      onPause: () => events.push('flow:onPause'),
    });
    executor.attachScopeRecorder({
      id: 'scope',
      onStageStart: () => events.push('scope:onStageStart'),
      onStageEnd: () => events.push('scope:onStageEnd'),
      onPause: () => events.push('scope:onPause'),
    });

    await executor.run();

    expect(events).toContain('scope:onStageStart');
    expect(events).toContain('scope:onPause');
    expect(events).toContain('flow:onPause');
    // The same asymmetry the ERROR path has: a stage that did not return does
    // not report an end. (`addPausableFunction` DOES fire it — there the
    // function returned and the engine turned its value into a pause.)
    expect(events).not.toContain('scope:onStageEnd');
  });
});

// ════════════════════════════════════════════════════════════════════════
// REFUSALS — honest, and never silent
// ════════════════════════════════════════════════════════════════════════

describe('interrupt — refusals', () => {
  it('resuming a NON-interrupt checkpoint on a stage with no resumeFn still refuses, naming both routes', async () => {
    const executor = new FlowChartExecutor(buildRefundChart());
    const paused = await executor.run();
    const checkpoint = (paused as { checkpoint: FlowchartCheckpoint }).checkpoint;

    // Strip the discriminant — this is what an old (pre-9.14.0) checkpoint for
    // a non-pausable stage would look like, and it must not resume silently.
    const stripped = { ...checkpoint, pausedBy: undefined };
    await expect(new FlowChartExecutor(buildRefundChart()).resume(stripped, {})).rejects.toThrow(
      /has no resumeFn.*addPausableFunction\(\), or stages that paused via interrupt\(\)/s,
    );
  });

  it('refuses when the chart no longer contains the interrupted stage', async () => {
    const executor = new FlowChartExecutor(buildRefundChart());
    const paused = await executor.run();
    const checkpoint = (paused as { checkpoint: FlowchartCheckpoint }).checkpoint;

    const differentChart = flowChart<RefundState>('Other', () => undefined, 'other').build();
    await expect(new FlowChartExecutor(differentChart).resume(checkpoint, {})).rejects.toThrow(
      /Cannot resume: stage 'refund' not found in flowchart/,
    );
  });

  it('carries the payload VERBATIM — the engine never interprets `expects`', async () => {
    const weird = { reason: 'r', expects: { nested: [1, { deep: true }], n: 0 } };
    const chart = flowChart<RefundState>('Ask', (scope) => interrupt(scope, weird), 'ask').build();

    const result = await new FlowChartExecutor(chart).run();
    expect((result as { checkpoint: FlowchartCheckpoint }).checkpoint.pauseData).toEqual(weird);
  });
});
