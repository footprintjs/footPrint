/**
 * Depth Probe — how fast a loopTo chart eats the executeNode depth budget
 * (backlog #12d; seed of the cross-repo limits test #17 and the regression
 * guard for #15 trampoline).
 *
 * Run: npx tsx bench/depth-probe.ts
 *
 * Each loop iteration of a loopTo chart deepens the awaited executeNode chain
 * of its OWN traverser — depth is NOT released between iterations. The guard
 * `MAX_EXECUTE_DEPTH = 500` (FlowchartTraverser.ts) caps that chain within ONE
 * traverser; subflow mounts get a FRESH traverser (own budget), but the mount
 * still costs frames in the parent. The loop-iteration limit (1000, in
 * ContinuationResolver) is independent — for loop-heavy charts the depth guard
 * fires first.
 *
 * The probe monkey-patches `FlowchartTraverser.prototype.executeNode` and runs
 * a representative agent-style loop chart
 * (Context → [sf-tools subflow] → Decide → loopTo Context). It reports:
 *   - frames per loop iteration
 *   - TWO per-traverser depths at N iterations (they differ — see below)
 *   - the iteration at which MAX_EXECUTE_DEPTH fires
 *     (predicted from the guard-depth growth AND verified empirically by
 *      letting the guard actually fire)
 *
 * TWO DEPTHS (probe finding — verified against the engine):
 *   - guard depth  = the engine's `_executeDepth`, which the 500-cap checks.
 *     Loop edges route through `return this.continuationResolver.resolve(...)`
 *     WITHOUT await (FlowchartTraverser.ts Phase 6), so the `finally`
 *     decrements before the loop target runs — an accidental partial
 *     tail-release. Net: the guard sees ~2 depth/iteration on this chart.
 *   - chain depth  = true retained nesting of un-resolved executeNode frames
 *     (each `return await this.executeNode(next)` holds its frame until the
 *     whole downstream chain resolves). ~3/iteration on this chart — this is
 *     the memory/await-chain growth #15's trampoline eliminates.
 *
 * Prior measurement on a full-featured agent chart (agentfootprint): ~7.0
 * frames/iteration, peak depth 352 at 50 iterations, wall ≈ iteration 71.
 * This in-repo representative chart is smaller, so its slopes are lower —
 * track the SLOPE over time, not the absolute match to that chart.
 *
 * Reusable: import { instrumentDepth, buildAgentLoopChart } from this file
 * to probe any chart / any iteration count.
 */

import { flowChart, FlowChartExecutor } from '../src/index';
import type { FlowChart } from '../src/index';
import { FlowchartTraverser } from '../src/lib/engine/traversal/FlowchartTraverser';
import { type BenchResult, formatNum, printHeader, printTable } from './util';

// ─── Instrumentation ───

export interface DepthStats {
  /** Total executeNode invocations across ALL traversers (root + subflows). */
  frames: number;
  /** Peak of the engine's own `_executeDepth` within a single traverser —
   *  the quantity the MAX_EXECUTE_DEPTH guard checks. Released early on
   *  loop edges (un-awaited continuationResolver return — see file header). */
  peakGuardDepth: number;
  /** Peak retained nesting of un-resolved executeNode frames within a single
   *  traverser — the true awaited-chain growth (#15 trampoline target). */
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

// ─── Probe runs ───

interface ProbeResult {
  iterations: number;
  frames: number;
  peakGuardDepth: number;
  peakChainDepth: number;
}

/** Run the chart to `target` iterations under instrumentation (guard disabled). */
async function probeAt(target: number): Promise<ProbeResult> {
  let iterations = 0;
  const chart = buildAgentLoopChart(target, () => {
    iterations++;
  });
  const { stats, restore } = instrumentDepth();
  try {
    await new FlowChartExecutor(chart).run({ maxDepth: 1_000_000 });
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

/** Let the DEFAULT MAX_EXECUTE_DEPTH guard actually fire; report the iteration. */
async function probeWall(): Promise<{ iteration: number; error: string }> {
  let iterations = 0;
  const chart = buildAgentLoopChart(Number.MAX_SAFE_INTEGER, () => {
    iterations++;
  });
  try {
    await new FlowChartExecutor(chart).run(); // default maxDepth = 500
    return { iteration: -1, error: 'guard never fired (unexpected)' };
  } catch (err) {
    return { iteration: iterations, error: String(err).split('.')[0] };
  }
}

// ─── Runner ───

async function main() {
  printHeader('FootPrint Depth Probe (backlog #12d)');
  console.log(`\nMAX_EXECUTE_DEPTH = ${FlowchartTraverser.MAX_EXECUTE_DEPTH}`);

  const p10 = await probeAt(10);
  const p50 = await probeAt(50);

  // Depths and frames grow linearly with iterations within the root traverser.
  const iterSpan = p50.iterations - p10.iterations;
  const frameSlope = (p50.frames - p10.frames) / iterSpan;
  const guardSlope = (p50.peakGuardDepth - p10.peakGuardDepth) / iterSpan;
  const chainSlope = (p50.peakChainDepth - p10.peakChainDepth) / iterSpan;
  const guardIntercept = p10.peakGuardDepth - guardSlope * p10.iterations;
  const predictedWall = Math.ceil((FlowchartTraverser.MAX_EXECUTE_DEPTH - guardIntercept) / guardSlope);

  const wall = await probeWall();

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
    { name: 'Frames per loop iteration', value: frameSlope.toFixed(1), detail: 'slope across all traversers' },
    {
      name: 'Guard depth per iteration',
      value: guardSlope.toFixed(1),
      detail: `engine _executeDepth slope — what the ${FlowchartTraverser.MAX_EXECUTE_DEPTH}-cap checks`,
    },
    {
      name: 'Chain depth per iteration',
      value: chainSlope.toFixed(1),
      detail: 'retained awaited-frame slope — #15 trampoline target',
    },
    {
      name: 'Predicted wall iteration',
      value: `~${predictedWall}`,
      detail: `first iteration where guard depth > ${FlowchartTraverser.MAX_EXECUTE_DEPTH}`,
    },
    { name: 'Empirical wall iteration', value: `${wall.iteration}`, detail: wall.error },
  ];

  printTable('Agent-style loopTo chart (Context → sf-tools → Decide → loop)', rows);
  console.log('\n---\n');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
