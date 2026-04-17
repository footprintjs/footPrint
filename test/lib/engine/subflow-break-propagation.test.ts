/**
 * 5-pattern tests for subflow-break-propagation + $break(reason).
 *
 * What's under test:
 *
 *   - `scope.$break(reason?)` accepts an optional reason string.
 *   - `FlowBreakEvent.reason` carries it to recorders.
 *   - `SubflowMountOptions.propagateBreak: true` causes an inner
 *     subflow's `$break(reason)` to propagate to the parent's break flag,
 *     terminating the outer loop.
 *   - Without `propagateBreak`, the inner break is locally scoped to the
 *     subflow (current default; backward-compat).
 *   - Recorder sees BOTH the inner originating break AND a propagated
 *     outer break event with `propagatedFromSubflow` identifying the
 *     subflow id.
 *
 * Patterns: unit, boundary, scenario, property, security.
 */

import { describe, expect, it } from 'vitest';

import type { CombinedRecorder, FlowBreakEvent } from '../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';

// ── Shared fixtures ────────────────────────────────────────────────────────

interface ParentState {
  phase: string;
  innerResult: string;
  outerResult: string;
}

interface InnerState {
  innerResult: string;
}

/** Inner subflow: has two stages; first one breaks with a reason. */
function buildBreakingInner(reason?: string) {
  const handler = (scope: any) => {
    scope.innerResult = 'first-stage-ran';
    if (reason !== undefined) scope.$break(reason);
    else scope.$break();
  };
  return flowChart<InnerState>('First', handler, 'inner-first')
    .addFunction(
      'Second',
      (scope) => {
        // Should be skipped when the first stage broke.
        scope.innerResult = 'second-stage-ran';
      },
      'inner-second',
    )
    .build();
}

/** Inner subflow: runs to completion without breaking. */
function buildNonBreakingInner() {
  return flowChart<InnerState>(
    'OnlyStage',
    (scope) => {
      scope.innerResult = 'completed';
    },
    'inner-only',
  ).build();
}

/** A FlowRecorder that captures every onBreak event for assertion. */
function captureBreaks(): {
  recorder: CombinedRecorder;
  events: FlowBreakEvent[];
} {
  const events: FlowBreakEvent[] = [];
  return {
    events,
    recorder: {
      id: 'break-capture',
      onBreak: (e: FlowBreakEvent) => {
        events.push(e);
      },
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. UNIT — $break(reason?) signature accepts optional reason
// ════════════════════════════════════════════════════════════════════════════

describe('$break(reason?) — unit', () => {
  it('$break() with no reason produces a break event with no `reason` field', async () => {
    const chart = flowChart<{ x: number }>(
      'Seed',
      (scope) => {
        scope.x = 1;
        scope.$break();
      },
      'seed',
    ).build();

    const { recorder, events } = captureBreaks();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(recorder);
    await executor.run();

    expect(events).toHaveLength(1);
    expect(events[0].reason).toBeUndefined();
    expect(events[0].stageName).toBe('Seed');
  });

  it('$break(reason) forwards the reason to the onBreak event', async () => {
    const chart = flowChart<{ x: number }>(
      'Seed',
      (scope) => {
        scope.x = 1;
        scope.$break('done early');
      },
      'seed',
    ).build();

    const { recorder, events } = captureBreaks();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(recorder);
    await executor.run();

    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe('done early');
  });

  it('propagatedFromSubflow is absent on originating (non-propagated) break events', async () => {
    const chart = flowChart<{ x: number }>('Seed', (scope) => scope.$break('x'), 'seed').build();

    const { recorder, events } = captureBreaks();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(recorder);
    await executor.run();

    expect(events[0].propagatedFromSubflow).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. BOUNDARY — propagateBreak not set, $break without reason, empty subflow
// ════════════════════════════════════════════════════════════════════════════

describe('subflow break propagation — boundary', () => {
  it('default (propagateBreak unset): inner $break stops ONLY the subflow; parent continues', async () => {
    const inner = buildBreakingInner('inner-done');
    const chart = flowChart<ParentState>(
      'Seed',
      (scope) => {
        scope.phase = 'seed';
      },
      'seed',
    )
      .addSubFlowChartNext('sf-inner', inner, 'Inner', {
        inputMapper: () => ({}),
        outputMapper: (sf: { innerResult?: string }) => ({ innerResult: sf.innerResult ?? '' }),
        // propagateBreak NOT set — default false
      })
      .addFunction(
        'After',
        (scope) => {
          scope.outerResult = 'after-ran';
        },
        'after',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const state = executor.getSnapshot()?.sharedState as Partial<ParentState>;
    // Subflow broke early → its second stage did NOT run.
    expect(state.innerResult).toBe('first-stage-ran');
    // BUT the parent continued past the subflow — `After` stage ran.
    expect(state.outerResult).toBe('after-ran');
  });

  it('propagateBreak=true but subflow does NOT break: parent continues normally', async () => {
    const inner = buildNonBreakingInner();
    const chart = flowChart<ParentState>(
      'Seed',
      (scope) => {
        scope.phase = 'seed';
      },
      'seed',
    )
      .addSubFlowChartNext('sf-inner', inner, 'Inner', {
        inputMapper: () => ({}),
        outputMapper: (sf: { innerResult?: string }) => ({ innerResult: sf.innerResult ?? '' }),
        propagateBreak: true,
      })
      .addFunction(
        'After',
        (scope) => {
          scope.outerResult = 'after-ran';
        },
        'after',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const state = executor.getSnapshot()?.sharedState as Partial<ParentState>;
    expect(state.innerResult).toBe('completed');
    // No inner break → propagateBreak is a no-op → After ran normally.
    expect(state.outerResult).toBe('after-ran');
  });

  it('subflow breaks with NO reason: parent breaks but reason is undefined', async () => {
    const inner = buildBreakingInner(/* no reason */);
    const chart = flowChart<ParentState>(
      'Seed',
      (scope) => {
        scope.phase = 'seed';
      },
      'seed',
    )
      .addSubFlowChartNext('sf-inner', inner, 'Inner', {
        outputMapper: (sf: { innerResult?: string }) => ({ innerResult: sf.innerResult ?? '' }),
        propagateBreak: true,
      })
      .build();

    const { recorder, events } = captureBreaks();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(recorder);
    await executor.run();

    // At least one propagated event with no reason.
    const propagated = events.filter((e) => e.propagatedFromSubflow === 'sf-inner');
    expect(propagated.length).toBeGreaterThanOrEqual(1);
    expect(propagated[0].reason).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. SCENARIO — full escalation-gate shape (linear chain, terminal subflow)
// ════════════════════════════════════════════════════════════════════════════

describe('subflow break propagation — scenario', () => {
  it('linear chain, propagateBreak=true, inner $break(reason): parent breaks with reason, later stage never runs', async () => {
    const inner = buildBreakingInner('escalated-to-human');
    const chart = flowChart<ParentState>(
      'Seed',
      (scope) => {
        scope.phase = 'seed';
      },
      'seed',
    )
      .addSubFlowChartNext('sf-escalate', inner, 'Escalate', {
        outputMapper: (sf: { innerResult?: string }) => ({ innerResult: sf.innerResult ?? '' }),
        propagateBreak: true,
      })
      .addFunction(
        'NeverRuns',
        (scope) => {
          scope.outerResult = 'SHOULD-NOT-BE-SET';
        },
        'never-runs',
      )
      .build();

    const { recorder, events } = captureBreaks();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(recorder);
    await executor.run();
    const state = executor.getSnapshot()?.sharedState as Partial<ParentState>;

    // Subflow ran its first stage, then broke.
    expect(state.innerResult).toBe('first-stage-ran');
    // Parent's `NeverRuns` did NOT execute.
    expect(state.outerResult).toBeUndefined();

    // Recorder sees TWO onBreak events: the inner originator + the propagated outer.
    expect(events.length).toBeGreaterThanOrEqual(2);
    // Tight assertion: inner break originates at the subflow's 'First'
    // stage. The builder prefixes subflow stage names with the mount id,
    // so the stageName is `sf-escalate/First` (not bare 'First').
    const inners = events.filter(
      (e) => e.propagatedFromSubflow === undefined && typeof e.stageName === 'string' && e.stageName.endsWith('First'),
    );
    const propagated = events.filter((e) => e.propagatedFromSubflow === 'sf-escalate');
    expect(inners.length).toBe(1);
    expect(inners[0].reason).toBe('escalated-to-human');
    expect(propagated.length).toBe(1);
    // Reason flowed all the way through.
    expect(propagated[0].reason).toBe('escalated-to-human');
    expect(propagated[0].stageName).toBe('Escalate');
  });

  it('narrative shows break with reason at parent level', async () => {
    const inner = buildBreakingInner('task-complete');
    const chart = flowChart<ParentState>(
      'Seed',
      (scope) => {
        scope.phase = 'seed';
      },
      'seed',
    )
      .addSubFlowChartNext('sf-finish', inner, 'Finish', {
        outputMapper: (sf: { innerResult?: string }) => ({ innerResult: sf.innerResult ?? '' }),
        propagateBreak: true,
      })
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    await executor.run();

    const lines = executor.getNarrative();
    // At least one entry should reference the break — default narrative
    // renderer may include text like "Execution stopped at X". We don't
    // assert exact wording (renderer implementation detail), only that a
    // break was narrated.
    const narrativeText = lines.join('\n');
    expect(narrativeText.toLowerCase()).toMatch(/stop|broke|break/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3b. SCENARIO — advanced shapes (nested chain, decider branch, partial write)
// ════════════════════════════════════════════════════════════════════════════

describe('subflow break propagation — advanced scenarios', () => {
  it('nested propagateBreak chain: inner breaks → middle propagates → outer propagates', async () => {
    // Three layers. Innermost stage calls $break('deepest-done'). Both
    // middle and outer mounts opt in to propagation. The reason should
    // survive two hops and the outermost stage after the top mount should
    // NOT run.
    const innermost = flowChart<InnerState>(
      'Deepest',
      (scope) => {
        scope.innerResult = 'deepest-ran';
        scope.$break('deepest-done');
      },
      'deepest',
    ).build();

    const middle = flowChart<InnerState>(
      'MiddleSeed',
      (scope) => {
        scope.innerResult = 'middle-seed';
      },
      'middle-seed',
    )
      .addSubFlowChartNext('sf-innermost', innermost, 'Innermost', {
        outputMapper: (sf: { innerResult?: string }) => ({
          innerResult: sf.innerResult ?? '',
        }),
        propagateBreak: true,
      })
      .addFunction(
        'MiddleAfter',
        (scope) => {
          scope.innerResult = 'middle-after-ran'; // should NOT run
        },
        'middle-after',
      )
      .build();

    const outer = flowChart<ParentState>(
      'Seed',
      (scope) => {
        scope.phase = 'seed';
      },
      'seed',
    )
      .addSubFlowChartNext('sf-middle', middle, 'Middle', {
        outputMapper: (sf: { innerResult?: string }) => ({
          innerResult: sf.innerResult ?? '',
        }),
        propagateBreak: true,
      })
      .addFunction(
        'Outermost',
        (scope) => {
          scope.outerResult = 'outermost-ran'; // should NOT run
        },
        'outermost',
      )
      .build();

    const { recorder, events } = captureBreaks();
    const executor = new FlowChartExecutor(outer);
    executor.attachCombinedRecorder(recorder);
    await executor.run();
    const state = executor.getSnapshot()?.sharedState as Partial<ParentState>;

    // Middle's MiddleAfter and outer's Outermost did NOT run.
    expect(state.outerResult).toBeUndefined();
    // Reason survived two propagation hops. Subflow IDs get prefixed by
    // the mount hierarchy (sf-innermost becomes sf-middle/sf-innermost
    // inside outer), so we match via `endsWith`.
    const propagatedFromInnermost = events.filter(
      (e) => typeof e.propagatedFromSubflow === 'string' && e.propagatedFromSubflow.endsWith('sf-innermost'),
    );
    const propagatedFromMiddle = events.filter((e) => e.propagatedFromSubflow === 'sf-middle');
    expect(propagatedFromInnermost.length).toBeGreaterThanOrEqual(1);
    expect(propagatedFromInnermost[0].reason).toBe('deepest-done');
    expect(propagatedFromMiddle.length).toBeGreaterThanOrEqual(1);
    expect(propagatedFromMiddle[0].reason).toBe('deepest-done');
  });

  it('partial scope writes BEFORE $break(reason) still commit to parent via outputMapper', async () => {
    // Documents the intentional "outputMapper runs even on propagated
    // break" semantic — consumers rely on this for escalation patterns
    // where the subflow writes its final answer AND then breaks.
    const inner = flowChart<InnerState>(
      'WriteThenBreak',
      (scope) => {
        scope.innerResult = 'partial-answer';
        scope.$break('done');
      },
      'write-then-break',
    ).build();

    const chart = flowChart<ParentState>(
      'Seed',
      (scope) => {
        scope.phase = 'seed';
      },
      'seed',
    )
      .addSubFlowChartNext('sf-r', inner, 'R', {
        outputMapper: (sf: { innerResult?: string }) => ({ innerResult: sf.innerResult ?? '' }),
        propagateBreak: true,
      })
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const state = executor.getSnapshot()?.sharedState as Partial<ParentState>;

    // The partial write reached the parent scope via outputMapper, even
    // though the subflow's break caused the parent to terminate.
    expect(state.innerResult).toBe('partial-answer');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. PROPERTY — invariants across reason variations and propagateBreak on/off
// ════════════════════════════════════════════════════════════════════════════

describe('subflow break propagation — property', () => {
  it('for every reason string tried, the propagated parent event carries it unchanged', async () => {
    const reasons = ['', 'simple', 'with spaces', 'unicode 🚀', 'newline\nhere'];

    for (const reason of reasons) {
      const inner = buildBreakingInner(reason);
      const chart = flowChart<ParentState>(
        'Seed',
        (scope) => {
          scope.phase = 'seed';
        },
        'seed',
      )
        .addSubFlowChartNext('sf-r', inner, 'R', {
          outputMapper: (sf: { innerResult?: string }) => ({ innerResult: sf.innerResult ?? '' }),
          propagateBreak: true,
        })
        .build();

      const { recorder, events } = captureBreaks();
      const executor = new FlowChartExecutor(chart);
      executor.attachCombinedRecorder(recorder);
      await executor.run();

      const propagated = events.filter((e) => e.propagatedFromSubflow === 'sf-r');
      expect(propagated.length).toBeGreaterThanOrEqual(1);
      expect(propagated[0].reason).toBe(reason);
    }
  });

  it('toggling propagateBreak on/off gives opposite outer-stage-ran outcomes', async () => {
    const runWithFlag = async (propagate: boolean) => {
      const inner = buildBreakingInner('x');
      const chart = flowChart<ParentState>(
        'Seed',
        (scope) => {
          scope.phase = 'seed';
        },
        'seed',
      )
        .addSubFlowChartNext('sf-r', inner, 'R', {
          outputMapper: (sf: { innerResult?: string }) => ({ innerResult: sf.innerResult ?? '' }),
          propagateBreak: propagate,
        })
        .addFunction(
          'After',
          (scope) => {
            scope.outerResult = 'after-ran';
          },
          'after',
        )
        .build();

      const executor = new FlowChartExecutor(chart);
      await executor.run();
      return (executor.getSnapshot()?.sharedState as Partial<ParentState>).outerResult;
    };

    expect(await runWithFlag(false)).toBe('after-ran');
    expect(await runWithFlag(true)).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. SECURITY — reason is opaque string, no code injection path
// ════════════════════════════════════════════════════════════════════════════

describe('subflow break propagation — security', () => {
  it('reason is passed verbatim to recorders — no evaluation, no interpolation', async () => {
    const maliciousReason = '"><script>alert("xss")</script>';
    const inner = buildBreakingInner(maliciousReason);
    const chart = flowChart<ParentState>(
      'Seed',
      (scope) => {
        scope.phase = 'seed';
      },
      'seed',
    )
      .addSubFlowChartNext('sf-r', inner, 'R', {
        outputMapper: (sf: { innerResult?: string }) => ({ innerResult: sf.innerResult ?? '' }),
        propagateBreak: true,
      })
      .build();

    const { recorder, events } = captureBreaks();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(recorder);
    await executor.run();

    const propagated = events.filter((e) => e.propagatedFromSubflow === 'sf-r');
    expect(propagated[0].reason).toBe(maliciousReason);
    // Library does not escape, template, or sanitize. That's the contract —
    // consumers rendering reason to HTML/logs are responsible for escaping
    // at their output boundary.
  });

  it('a throwing recorder.onBreak does not crash the executor', async () => {
    const inner = buildBreakingInner('x');
    const chart = flowChart<ParentState>(
      'Seed',
      (scope) => {
        scope.phase = 'seed';
      },
      'seed',
    )
      .addSubFlowChartNext('sf-r', inner, 'R', {
        outputMapper: (sf: { innerResult?: string }) => ({ innerResult: sf.innerResult ?? '' }),
        propagateBreak: true,
      })
      .build();

    const badRecorder: CombinedRecorder = {
      id: 'bad',
      onBreak: () => {
        throw new Error('recorder bomb');
      },
    };
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(badRecorder);

    // Recorder error isolation: the executor MUST NOT propagate handler errors.
    await expect(executor.run()).resolves.not.toThrow();
  });
});
