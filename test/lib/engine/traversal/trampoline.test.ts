/**
 * Trampoline tests — flat-stack linear chains and loop continuations.
 *
 * `executeNode` is an iterative driver: linear `next` hops, loop edges
 * (`loopTo` / dynamic next), and flat decider branch dispatch return
 * `ContinuationHop`s consumed by a loop — the call stack and the retained
 * promise chain stay O(1) regardless of chain length or loop count.
 *
 * What these tests pin down:
 *   - scenario: a 10,000-iteration `loopTo` chart completes at the DEFAULT
 *     maxDepth (pre-trampoline the depth guard fired at iteration ~249),
 *     with the engine's peak nesting depth provably flat
 *   - scenario: a 5,000-stage linear chain completes at the default maxDepth
 *   - scenario: a decider-routed loop (branch-sourced loopTo, the agent
 *     ReAct shape) also runs flat
 *   - boundary: the ContinuationResolver iteration limit (default 1000) is
 *     now REACHABLE and fires with its own error (pre-trampoline the depth
 *     guard always fired first), and `RunOptions.maxIterations` tunes it
 *   - functional: pause INSIDE a long loop at iteration ~600 (past the old
 *     depth wall) → checkpoint → resume → run completes
 *   - functional: narrative ordering on a small loop chart is IDENTICAL to
 *     the pre-trampoline sequence (hardcoded expected entries)
 */

import type { PausableHandler } from '../../../../src/index';
import { flowChart, FlowChartExecutor } from '../../../../src/index';
import { FlowchartTraverser } from '../../../../src/lib/engine/traversal/FlowchartTraverser';

// ─── Instrumentation: peak engine nesting depth across all traversers ───
// Same monkey-patch approach as bench/depth-probe.ts: wrap the driver and
// sample `_executeDepth` on entry. Patch BEFORE creating the executor
// (handlers bind executeNode at traverser construction).
function instrumentPeakDepth(): { stats: { peak: number }; restore: () => void } {
  const proto = FlowchartTraverser.prototype as unknown as Record<string, unknown>;
  const original = proto.executeNode as (...args: unknown[]) => Promise<unknown>;
  const stats = { peak: 0 };
  proto.executeNode = async function (this: object, ...args: unknown[]) {
    const depth = (((this as Record<string, unknown>)._executeDepth as number) ?? 0) + 1;
    if (depth > stats.peak) stats.peak = depth;
    return original.apply(this, args);
  };
  return {
    stats,
    restore: () => {
      proto.executeNode = original;
    },
  };
}

describe('Trampoline — scenario: 10,000-iteration loopTo chart (flat stack)', () => {
  it('completes at the DEFAULT maxDepth and never exceeds a handful of nesting levels', async () => {
    const TARGET = 10_000;
    let iterations = 0;

    const chart = flowChart<any>(
      'Seed',
      async (scope) => {
        scope.$setValue('i', 0);
      },
      'seed',
    )
      .addFunction(
        'Work',
        async () => {
          iterations++;
        },
        'work',
      )
      .addFunction(
        'Check',
        async (scope) => {
          const i = (scope.$getValue('i') as number) + 1;
          scope.$setValue('i', i);
          if (i >= TARGET) scope.$break();
        },
        'check',
      )
      .loopTo('work')
      .build();

    const { stats, restore } = instrumentPeakDepth();
    let commitCount = 0;
    try {
      // DEFAULT maxDepth (500) — pre-trampoline this chart's guard fired at
      // iteration ~249. Only the loop-iteration limit needs raising.
      const executor = new FlowChartExecutor(chart);
      await executor.run({ maxIterations: TARGET + 1 });
      // The execution tree is now ~20,000 levels deep — getSnapshot() must
      // survive it (iterative serializer; the recursive one overflowed).
      const snapshot = executor.getSnapshot();
      commitCount = (snapshot.commitLog as unknown[]).length;
    } finally {
      restore();
    }

    expect(iterations).toBe(TARGET);
    expect(commitCount).toBeGreaterThan(TARGET); // one commit per executed stage
    // Flat stack: the whole loop runs inside ONE driver invocation. A small
    // constant bound (root driver + a nested dispatch or two) — nowhere near
    // MAX_EXECUTE_DEPTH, and emphatically not O(iterations).
    expect(stats.peak).toBeLessThan(10);
    expect(stats.peak).toBeLessThan(FlowchartTraverser.MAX_EXECUTE_DEPTH);
  }, 60_000);
});

describe('Trampoline — scenario: 5,000-stage linear chain (flat stack)', () => {
  it('completes at the DEFAULT maxDepth', async () => {
    const TOTAL = 5_000;
    let executed = 0;
    let lastIdx = -1;

    let builder = flowChart<any>(
      'Stage_0',
      async () => {
        executed++;
        lastIdx = 0;
      },
      's0',
    );
    for (let i = 1; i < TOTAL; i++) {
      const idx = i;
      builder = builder.addFunction(
        `Stage_${idx}`,
        async () => {
          executed++;
          lastIdx = idx;
        },
        `s${idx}`,
      ) as any;
    }
    const chart = builder.build();

    const { stats, restore } = instrumentPeakDepth();
    try {
      await new FlowChartExecutor(chart).run(); // default maxDepth
    } finally {
      restore();
    }

    expect(executed).toBe(TOTAL);
    expect(lastIdx).toBe(TOTAL - 1);
    expect(stats.peak).toBeLessThan(10);
  }, 60_000);
});

describe('Trampoline — scenario: decider-routed loop (branch-sourced loopTo) runs flat', () => {
  it('a 2,000-iteration decider loop completes at the default maxDepth', async () => {
    // The agent ReAct shape: Decide routes 'continue' → Tick, whose branch
    // loops back to Decide; 'done' is a terminal leaf. The decider has no
    // continuation of its own, so its dispatch is a flat trampoline hop —
    // pre-trampoline each iteration retained decider + branch frames.
    const TARGET = 2_000;
    let ticks = 0;

    const chart = flowChart<any>(
      'Seed',
      async (scope) => {
        scope.$setValue('i', 0);
      },
      'seed',
    )
      .addDeciderFunction(
        'Decide',
        async (scope) => ((scope.$getValue('i') as number) < TARGET ? 'continue' : 'done'),
        'decide',
      )
      .addFunctionBranch(
        'continue',
        'Tick',
        async (scope: any) => {
          ticks++;
          scope.$setValue('i', (scope.$getValue('i') as number) + 1);
        },
        undefined,
        { loopTo: 'decide' },
      )
      .addFunctionBranch('done', 'Final', async (scope: any) => {
        scope.$setValue('final', true);
      })
      .end()
      .build();

    const { stats, restore } = instrumentPeakDepth();
    let snapshotState: Record<string, unknown>;
    try {
      const executor = new FlowChartExecutor(chart);
      await executor.run({ maxIterations: TARGET + 1 });
      snapshotState = executor.getSnapshot().sharedState as Record<string, unknown>;
    } finally {
      restore();
    }

    expect(ticks).toBe(TARGET);
    expect(snapshotState.final).toBe(true);
    expect(stats.peak).toBeLessThan(10);
  }, 60_000);
});

describe('Trampoline — boundary: the loop-iteration limit is now the binding constraint', () => {
  it('the DEFAULT 1000-iteration limit fires with the ContinuationResolver error (reachable at default maxDepth)', async () => {
    // Pre-trampoline, the depth guard (500, ~2 depth/iteration on multi-stage
    // loop charts) fired around iteration 249 — the documented 1000-iteration
    // limit was unreachable. Now the loop runs flat and the iteration limit
    // is what stops a runaway loop, with its own actionable error.
    let iterations = 0;
    const chart = flowChart<any>(
      'Spin',
      async () => {
        iterations++;
      },
      'spin',
    )
      .addFunction('Hop', async () => {}, 'hop')
      .loopTo('spin')
      .build();

    const executor = new FlowChartExecutor(chart);
    await expect(executor.run()).rejects.toThrow(/Maximum loop iterations \(1000\) exceeded/);
    // The loop genuinely reached the documented limit (not the depth wall).
    expect(iterations).toBe(1001); // first pass + 1000 loop-backs
  }, 60_000);

  it('RunOptions.maxIterations tunes the limit (fires fast at a custom value)', async () => {
    let iterations = 0;
    const chart = flowChart<any>(
      'Spin',
      async () => {
        iterations++;
      },
      'spin',
    )
      .addFunction('Hop', async () => {}, 'hop')
      .loopTo('spin')
      .build();

    const executor = new FlowChartExecutor(chart);
    await expect(executor.run({ maxIterations: 50 })).rejects.toThrow(/Maximum loop iterations \(50\) exceeded/);
    expect(iterations).toBe(51);
  });

  it('maxIterations < 1 is rejected', async () => {
    const chart = flowChart<any>('A', async () => {}, 'a').build();
    const executor = new FlowChartExecutor(chart);
    await expect(executor.run({ maxIterations: 0 })).rejects.toThrow(/maxIterations must be >= 1/);
  });
});

describe('Trampoline — functional: pause inside a long loop, past the old depth wall', () => {
  it('pauses at iteration ~600, checkpoints, resumes, and completes', async () => {
    // Pre-trampoline the depth guard fired around iteration 249 on
    // loop-charts of this shape — a pause at iteration 600 was unreachable.
    const PAUSE_AT = 600;
    const TARGET = 700;

    const gate: PausableHandler<any> = {
      execute: async (scope) => {
        const i = (scope.$getValue('i') as number) ?? 0;
        if (i === PAUSE_AT && !scope.$getValue('resumed')) {
          return { question: `continue past iteration ${i}?` };
        }
      },
      resume: async (scope, input: any) => {
        scope.$setValue('resumed', true);
        scope.$setValue('resumeNote', input.note);
      },
    };

    let ticks = 0;
    const chart = flowChart<any>(
      'Seed',
      async (scope) => {
        scope.$setValue('i', 0);
      },
      'seed',
    )
      .addPausableFunction('Gate', gate, 'gate')
      .addFunction(
        'Tick',
        async (scope) => {
          ticks++;
          const i = (scope.$getValue('i') as number) + 1;
          scope.$setValue('i', i);
          if (i >= TARGET) scope.$break();
        },
        'tick',
      )
      .loopTo('gate')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run(); // default maxDepth AND default maxIterations

    expect(executor.isPaused()).toBe(true);
    expect(ticks).toBe(PAUSE_AT); // paused before tick #601
    const checkpoint = executor.getCheckpoint()!;
    expect(checkpoint.pausedStageId).toBe('gate');
    expect((checkpoint.pauseData as any).question).toBe(`continue past iteration ${PAUSE_AT}?`);
    expect(checkpoint.sharedState.i).toBe(PAUSE_AT);

    // Resume on the SAME executor — loop continues to TARGET.
    await executor.resume(checkpoint, { note: 'approved' });

    expect(executor.isPaused()).toBe(false);
    expect(ticks).toBe(TARGET);
    const state = executor.getSnapshot().sharedState as Record<string, unknown>;
    expect(state.i).toBe(TARGET);
    expect(state.resumed).toBe(true);
    expect(state.resumeNote).toBe('approved');
  }, 60_000);
});

describe('Trampoline — functional: narrative ordering is unchanged on a loop chart', () => {
  it('produces the exact pre-trampoline entry sequence', async () => {
    // Hardcoded expected sequence captured from the PRE-trampoline engine
    // (v8.3.0) on this exact chart — types, stage attribution, depths and
    // rendered text must all match byte-for-byte.
    const chart = flowChart<any>(
      'Seed',
      async (scope) => {
        scope.$setValue('i', 0);
      },
      'seed',
    )
      .addFunction(
        'Work',
        async (scope) => {
          const i = scope.$getValue('i') as number;
          scope.$setValue('value', `v-${i}`);
        },
        'work',
      )
      .addFunction(
        'Check',
        async (scope) => {
          const i = (scope.$getValue('i') as number) + 1;
          scope.$setValue('i', i);
          if (i >= 3) scope.$break('done after 3');
        },
        'check',
      )
      .loopTo('work')
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    await executor.run({ input: {} });

    const entries = executor.getNarrativeEntries().map((e: any) => ({
      type: e.type,
      stageName: e.stageName,
      stageId: e.stageId,
      depth: e.depth,
      text: e.text,
    }));

    expect(entries).toEqual([
      { type: 'stage', stageName: 'Seed', stageId: 'seed', depth: 0, text: 'Stage 1: The process began with Seed.' },
      { type: 'step', stageName: 'Seed', stageId: 'seed', depth: 1, text: 'Step 1: Write i = 0' },
      { type: 'stage', stageName: 'Work', stageId: 'work', depth: 0, text: 'Stage 2: Next, it moved on to Work.' },
      { type: 'step', stageName: 'Work', stageId: 'work', depth: 1, text: 'Step 1: Read i = 0' },
      { type: 'step', stageName: 'Work', stageId: 'work', depth: 1, text: 'Step 2: Write value = "v-0"' },
      { type: 'stage', stageName: 'Check', stageId: 'check', depth: 0, text: 'Stage 3: Next, it moved on to Check.' },
      { type: 'step', stageName: 'Check', stageId: 'check', depth: 1, text: 'Step 1: Read i = 0' },
      { type: 'step', stageName: 'Check', stageId: 'check', depth: 1, text: 'Step 2: Write i = 1' },
      { type: 'loop', stageName: undefined, stageId: 'check', depth: 0, text: 'On pass 1 through Work.' },
      { type: 'stage', stageName: 'Work', stageId: 'work', depth: 0, text: 'Stage 4: Looped back to Work (pass 1).' },
      { type: 'step', stageName: 'Work', stageId: 'work', depth: 1, text: 'Step 1: Read i = 1' },
      { type: 'step', stageName: 'Work', stageId: 'work', depth: 1, text: 'Step 2: Write value = "v-1"' },
      {
        type: 'stage',
        stageName: 'Check',
        stageId: 'check',
        depth: 0,
        text: 'Stage 5: Looped back to Check (pass 1).',
      },
      { type: 'step', stageName: 'Check', stageId: 'check', depth: 1, text: 'Step 1: Read i = 1' },
      { type: 'step', stageName: 'Check', stageId: 'check', depth: 1, text: 'Step 2: Write i = 2' },
      { type: 'loop', stageName: undefined, stageId: 'check', depth: 0, text: 'On pass 2 through Work.' },
      { type: 'stage', stageName: 'Work', stageId: 'work', depth: 0, text: 'Stage 6: Looped back to Work (pass 2).' },
      { type: 'step', stageName: 'Work', stageId: 'work', depth: 1, text: 'Step 1: Read i = 2' },
      { type: 'step', stageName: 'Work', stageId: 'work', depth: 1, text: 'Step 2: Write value = "v-2"' },
      {
        type: 'stage',
        stageName: 'Check',
        stageId: 'check',
        depth: 0,
        text: 'Stage 7: Looped back to Check (pass 2).',
      },
      { type: 'step', stageName: 'Check', stageId: 'check', depth: 1, text: 'Step 1: Read i = 2' },
      { type: 'step', stageName: 'Check', stageId: 'check', depth: 1, text: 'Step 2: Write i = 3' },
      { type: 'break', stageName: 'Check', stageId: 'check', depth: 0, text: 'Execution stopped at Check.' },
    ]);
  });
});
