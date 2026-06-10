/**
 * Long Loops — Flat-Stack Trampoline (10,000 iterations)
 *
 * The engine follows linear `next` hops and loop edges ITERATIVELY (a
 * trampoline driver), so the call stack stays flat no matter how long the
 * chain or the loop. The depth guard (`maxDepth`, default 500) now bounds
 * only TREE nesting — fork children, decider/selector branch dispatch —
 * not chain length or loop count.
 *
 * The binding constraint for loops is the per-node iteration limit
 * (default 1000). Raise it per run via `RunOptions.maxIterations` for
 * legitimately long loops — memory for state, commit log, and narrative
 * still grows per iteration, so it stays a deliberate opt-in.
 *
 * Pipeline: Init → Step (loop ×10,000, $break at target)
 *
 * Run: npx tsx examples/runtime-features/long-loops/01-flat-stack-10k.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';

interface CounterState {
  i: number;
}

const TARGET = 10_000;

const chart = flowChart<CounterState>(
  'Init',
  async (scope) => {
    scope.i = 0;
  },
  'init',
)
  .addFunction(
    'Step',
    async (scope) => {
      scope.i += 1;
      if (scope.i >= TARGET) scope.$break(`reached ${TARGET}`);
    },
    'step',
  )
  .loopTo('step')
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);

  const start = performance.now();
  // Default maxIterations is 1000 — opt in to the long loop explicitly.
  await executor.run({ maxIterations: TARGET + 1 });
  const ms = performance.now() - start;

  const snap = executor.getSnapshot();
  console.log(`Iterations: ${snap.sharedState?.i}`);
  console.log(`Wall time: ${ms.toFixed(0)}ms (${((ms * 1000) / TARGET).toFixed(0)}µs/iteration)`);
  console.log(`Commits recorded: ${snap.commitLog?.length}`);
  console.log('Flat stack: the whole loop ran inside one traversal frame.');
})().catch(console.error);
