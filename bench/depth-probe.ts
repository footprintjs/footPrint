/**
 * Depth Probe — regression guard for the #15 trampoline (backlog #12d
 * originally measured the pre-trampoline depth walls this work removed).
 *
 * Run: npx tsx bench/depth-probe.ts
 *
 * POST-TRAMPOLINE MODEL: `executeNode` is an iterative driver — linear
 * `next` hops and loop edges are followed in a flat loop, so neither the
 * engine's guard counter (`_executeDepth`, checked against
 * MAX_EXECUTE_DEPTH = 500) nor the retained promise chain grows with loop
 * iterations. Depth counts TREE nesting only (fork children, decider
 * branch dispatch with a decider-level continuation, subflow mount frames).
 * The loop-iteration limit (default 1000 in ContinuationResolver, tunable
 * via `RunOptions.maxIterations`) is now the binding constraint for loops.
 *
 * The probe monkey-patches `FlowchartTraverser.prototype.executeNode` and
 * runs a representative agent-style loop chart
 * (Context → [sf-tools subflow] → Decide → loopTo Context). It reports:
 *   - frames per loop iteration (driver invocations — ~1/iter: the subflow
 *     mount's fresh traverser; the root loop itself adds none)
 *   - guard depth + chain depth slopes (BOTH must stay ~0.0/iteration —
 *     any positive slope is a trampoline regression)
 *   - a long-run completion check FAR past the old wall (10,000 iterations;
 *     pre-trampoline the guard fired at iteration 249 on this chart)
 *   - the limit that now stops a runaway loop (iteration limit, with its
 *     own error — pre-trampoline the depth guard always fired first)
 *
 * PRE-TRAMPOLINE BASELINE (v8.1.0–v8.3.0, for history): guard slope
 * 2.0/iter, chain slope 3.0/iter, empirical wall at iteration 249;
 * full-featured agent chart (agentfootprint): ~7.0 frames/iter, wall ≈ 71.
 *
 * Reusable: import { instrumentDepth, buildAgentLoopChart } from this file
 * to probe any chart / any iteration count.
 */

import type { FlowChart } from '../src/index';
import { flowChart, FlowChartExecutor } from '../src/index';
import { FlowchartTraverser } from '../src/lib/engine/traversal/FlowchartTraverser';
import { type BenchResult, formatNum, printHeader, printTable, writeResultsJson } from './util';

// ─── Instrumentation ───

export interface DepthStats {
  /** Total executeNode (driver) invocations across ALL traversers (root + subflows). */
  frames: number;
  /** Peak of the engine's own `_executeDepth` within a single traverser —
   *  the quantity the MAX_EXECUTE_DEPTH guard checks. Post-trampoline this
   *  counts TREE nesting only and must stay flat across loop iterations. */
  peakGuardDepth: number;
  /** Peak retained nesting of un-resolved executeNode frames within a single
   *  traverser — the awaited-chain growth the #15 trampoline eliminated.
   *  Must stay flat (driver hops replace recursive tail calls). */
  peakChainDepth: number;
}

/**
 * Monkey-patch FlowchartTraverser.prototype.executeNode with depth counters.
 * Patch BEFORE creating the executor: the traverser binds executeNode at
 * construction time (`this.executeNode.bind(this)` in its constructor).
 * Always call `restore()` (try/finally) to un-patch.
 */
export function instrumentDepth(): { stats: DepthStats; restore: () => void } {
  const proto = FlowchartTraverser.prototype as unknown as Record<string, unknown>;
  const original = proto.executeNode as (...args: unknown[]) => Promise<unknown>;
  const stats: DepthStats = { frames: 0, peakGuardDepth: 0, peakChainDepth: 0 };
  const chainDepths = new WeakMap<object, number>(); // per-traverser retained nesting

  proto.executeNode = async function (this: object, ...args: unknown[]) {
    stats.frames++;

    // Engine's guard counter — sample what ++_executeDepth is about to become.
    const guardDepth = (((this as Record<string, unknown>)._executeDepth as number) ?? 0) + 1;
    if (guardDepth > stats.peakGuardDepth) stats.peakGuardDepth = guardDepth;

    // True retained chain — decremented only when THIS frame resolves.
    const chainDepth = (chainDepths.get(this) ?? 0) + 1;
    chainDepths.set(this, chainDepth);
    if (chainDepth > stats.peakChainDepth) stats.peakChainDepth = chainDepth;

    try {
      return await original.apply(this, args);
    } finally {
      chainDepths.set(this, (chainDepths.get(this) ?? 1) - 1);
    }
  };

  return {
    stats,
    restore: () => {
      proto.executeNode = original;
    },
  };
}

// ─── Representative agent-style loop chart ───

type LooseState = Record<string, unknown>;

/**
 * ReAct-shaped loop: Context (assemble history) → sf-tools subflow (2 stages)
 * → Decide (break or loop back to Context). `onIteration` fires once per loop
 * pass so callers can correlate iteration count with depth.
 */
export function buildAgentLoopChart(target: number, onIteration: () => void): FlowChart<any, any> {
  const toolsSub = flowChart<LooseState>(
    'PrepareTool',
    async (scope) => {
      scope.$setValue('toolPrepared', true);
    },
    'prepare-tool',
  )
    .addFunction(
      'ExecuteTool',
      async (scope) => {
        scope.$setValue('toolResult', `result-${scope.$getValue('i')}`);
      },
      'execute-tool',
    )
    .build();

  return flowChart<LooseState>(
    'Seed',
    async (scope) => {
      scope.$setValue('i', 0);
      scope.$setValue('history', []);
    },
    'seed',
  )
    .addFunction(
      'Context',
      async (scope) => {
        onIteration();
        const i = scope.$getValue('i') as number;
        scope.$batchArray('history', (arr) => {
          arr.push({ role: 'user', idx: i });
        });
      },
      'context',
    )
    .addSubFlowChartNext('sf-tools', toolsSub, 'Tools')
    .addFunction(
      'Decide',
      async (scope) => {
        const i = (scope.$getValue('i') as number) + 1;
        scope.$setValue('i', i);
        if (i >= target) scope.$break();
      },
      'decide',
    )
    .loopTo('context')
    .build();
}

/**
 * Same loop SHAPE as `buildAgentLoopChart` (Context → sf-tools subflow →
 * Decide → loopTo) but with SCALAR state only — no per-iteration `history`
 * append. Used for the LONG-RUN probes: appending to a tracked array makes
 * the retained commit log grow O(N²) (each commit records the full changed
 * array), which OOMs near ~2,000 iterations on an 8 GB machine. That memory
 * bound is real and documented — but it is orthogonal to the DEPTH behavior
 * this probe guards, so the long-run probes use scalar state.
 */
export function buildScalarLoopChart(target: number, onIteration: () => void): FlowChart<any, any> {
  const toolsSub = flowChart<LooseState>(
    'PrepareTool',
    async (scope) => {
      scope.$setValue('toolPrepared', true);
    },
    'prepare-tool',
  )
    .addFunction(
      'ExecuteTool',
      async (scope) => {
        scope.$setValue('toolResult', `result-${scope.$getValue('i')}`);
      },
      'execute-tool',
    )
    .build();

  return flowChart<LooseState>(
    'Seed',
    async (scope) => {
      scope.$setValue('i', 0);
    },
    'seed',
  )
    .addFunction(
      'Context',
      async (scope) => {
        onIteration();
        scope.$setValue('lastTouched', scope.$getValue('i'));
      },
      'context',
    )
    .addSubFlowChartNext('sf-tools', toolsSub, 'Tools')
    .addFunction(
      'Decide',
      async (scope) => {
        const i = (scope.$getValue('i') as number) + 1;
        scope.$setValue('i', i);
        if (i >= target) scope.$break();
      },
      'decide',
    )
    .loopTo('context')
    .build();
}

// ─── Probe runs ───

interface ProbeResult {
  iterations: number;
  frames: number;
  peakGuardDepth: number;
  peakChainDepth: number;
}

/** Run the chart to `target` iterations under instrumentation (default maxDepth,
 *  iteration limit raised to let the target complete). */
async function probeAt(target: number): Promise<ProbeResult> {
  let iterations = 0;
  const chart = buildAgentLoopChart(target, () => {
    iterations++;
  });
  const { stats, restore } = instrumentDepth();
  try {
    await new FlowChartExecutor(chart).run({ maxIterations: target + 1 });
  } finally {
    restore();
  }
  return {
    iterations,
    frames: stats.frames,
    peakGuardDepth: stats.peakGuardDepth,
    peakChainDepth: stats.peakChainDepth,
  };
}

/** Long-run completion check FAR past the old depth wall (iteration 249):
 *  10,000 iterations at DEFAULT maxDepth. Reports wall time + peak depths. */
async function probeLongRun(target: number): Promise<ProbeResult & { wallMs: number }> {
  let iterations = 0;
  const chart = buildScalarLoopChart(target, () => {
    iterations++;
  });
  const { stats, restore } = instrumentDepth();
  const start = performance.now();
  try {
    await new FlowChartExecutor(chart).run({ maxIterations: target + 1 });
  } finally {
    restore();
  }
  return {
    iterations,
    frames: stats.frames,
    peakGuardDepth: stats.peakGuardDepth,
    peakChainDepth: stats.peakChainDepth,
    wallMs: performance.now() - start,
  };
}

/** Run with ALL defaults and never break — report which limit stops the loop.
 *  Post-trampoline this must be the ITERATION limit (own error), never the
 *  depth guard. */
async function probeBindingLimit(): Promise<{ iteration: number; error: string }> {
  let iterations = 0;
  const chart = buildScalarLoopChart(Number.MAX_SAFE_INTEGER, () => {
    iterations++;
  });
  try {
    await new FlowChartExecutor(chart).run(); // default maxDepth AND maxIterations
    return { iteration: -1, error: 'no limit fired (unexpected)' };
  } catch (err) {
    return { iteration: iterations, error: String(err).split('.')[0] };
  }
}

// ─── Runner ───

async function main() {
  printHeader('FootPrint Depth Probe (backlog #12d / #15 trampoline guard)');
  console.log(`\nMAX_EXECUTE_DEPTH = ${FlowchartTraverser.MAX_EXECUTE_DEPTH}`);

  const p10 = await probeAt(10);
  const p50 = await probeAt(50);

  // Post-trampoline, depth slopes must be flat; frames grow ~1/iteration
  // (the subflow mount's fresh traverser).
  const iterSpan = p50.iterations - p10.iterations;
  const frameSlope = (p50.frames - p10.frames) / iterSpan;
  const guardSlope = (p50.peakGuardDepth - p10.peakGuardDepth) / iterSpan;
  const chainSlope = (p50.peakChainDepth - p10.peakChainDepth) / iterSpan;
  const flat = guardSlope === 0 && chainSlope === 0;

  const longRun = await probeLongRun(10_000);
  const limit = await probeBindingLimit();

  const rows: BenchResult[] = [
    {
      name: `Probe @ ${p10.iterations} iterations`,
      value: `guard ${p10.peakGuardDepth}`,
      detail: `chain ${p10.peakChainDepth}, ${formatNum(p10.frames)} frames`,
    },
    {
      name: `Probe @ ${p50.iterations} iterations`,
      value: `guard ${p50.peakGuardDepth}`,
      detail: `chain ${p50.peakChainDepth}, ${formatNum(p50.frames)} frames`,
    },
    {
      name: 'Frames per loop iteration',
      value: frameSlope.toFixed(1),
      detail: 'driver invocations across all traversers',
      num: frameSlope,
      unit: 'count',
    },
    {
      name: 'Guard depth per iteration',
      value: guardSlope.toFixed(1),
      detail: 'engine _executeDepth slope — MUST be 0.0 (trampoline regression guard)',
      num: guardSlope,
      unit: 'count',
    },
    {
      name: 'Chain depth per iteration',
      value: chainSlope.toFixed(1),
      detail: 'retained awaited-frame slope — MUST be 0.0 (trampoline regression guard)',
      num: chainSlope,
      unit: 'count',
    },
    {
      name: 'Depth wall',
      value: flat ? 'none (flat)' : 'REGRESSION',
      detail: flat
        ? 'loop iterations no longer consume depth (pre-trampoline wall: iteration 249)'
        : 'positive depth slope — the trampoline regressed!',
    },
    {
      name: `Long run: ${formatNum(longRun.iterations)} iterations`,
      value: `${longRun.wallMs.toFixed(0)}ms`,
      detail: `default maxDepth; peak guard ${longRun.peakGuardDepth}, peak chain ${longRun.peakChainDepth}, ${(
        (longRun.wallMs * 1000) /
        longRun.iterations
      ).toFixed(0)}µs/iter`,
      num: longRun.wallMs,
      unit: 'ms',
    },
    {
      name: 'Binding limit (all defaults)',
      value: `iteration ${formatNum(limit.iteration)}`,
      detail: limit.error,
    },
  ];

  printTable('Agent-style loopTo chart (Context → sf-tools → Decide → loop)', rows);

  // Machine mirror (fp-bench/1) — merged into bench/results/latest.json.
  writeResultsJson([{ section: 'D-depth-probe', rows }]);

  console.log('\n---\n');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
