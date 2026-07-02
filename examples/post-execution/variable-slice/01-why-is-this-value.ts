/**
 * Variable Slice — "why is this value what it is?"
 *
 * THE headline: zero setup. No recorder attached, no options — the finished
 * run's snapshot already contains everything a backward slice needs (reads
 * live in the execution tree under the default `readTracking`; writes live
 * in the commit log). This is the exact query a UI runs when a user clicks
 * a key, and the exact query an LLM `backtrack` tool runs on a follow-up
 * question — one contract, same answer everywhere.
 *
 * Pipeline: Seed → Process → Format, then: sliceForKey('output').
 *
 * Run: npx tsx examples/post-execution/variable-slice/01-why-is-this-value.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { formatCausalChain, keysReadFromExecutionTree, sliceForKey } from 'footprintjs/trace';

interface State { input: string; processed?: string; output?: string }

const chart = flowChart<State>('Seed', async (scope) => {
  scope.input = 'hello';
}, 'seed')
  .addFunction('Process', async (scope) => {
    scope.processed = scope.input.toUpperCase();
  }, 'process')
  .addFunction('Format', async (scope) => {
    scope.output = `[${scope.processed}]`;
  }, 'format')
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  await executor.run();
  const snapshot = executor.getSnapshot();

  // Variable in → slice out. Reads come straight from the snapshot.
  const slice = sliceForKey(
    snapshot.commitLog,
    'output',
    keysReadFromExecutionTree(snapshot.executionTree),
  );

  console.log(`why is 'output' what it is?  (reads via: ${slice.keysReadKind})\n`);
  console.log(formatCausalChain(slice.root!));
  // Format (format#2) [wrote: output]
  //   Process (process#1) ← via processed [wrote: processed]
  //     Seed (seed#0) ← via input [wrote: input]

  // Honest absence is a result, not an error:
  const ghost = sliceForKey(snapshot.commitLog, 'neverSet', keysReadFromExecutionTree(snapshot.executionTree));
  console.log(`\nwhy is 'neverSet' what it is? → missing: ${ghost.missing}`);
  // 'never-written' — came from initial state / args / a closure; the log can't see those.
})().catch(console.error);
