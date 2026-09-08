/**
 * Time Travel — a pause and its resume, read as ONE axis
 *
 * A cross-executor resume (persist the checkpoint, pick it up on a fresh
 * executor) produces TWO snapshots. The second one has a fresh runtime: its
 * `commitLog` starts again at index 0 and holds only the post-resume commits.
 * Read alone, it is half a story.
 *
 * `timeTravel([paused, resumed])` reads both as one axis. The honest bit is on
 * every stop: commit indices are RUN-LOCAL, so `commitIdx` still indexes its
 * own source and `sourceIdx` says which one; only the STEPS run across the
 * seam. A chain that is not in run order, or not from one lineage, is refused
 * with a reason — never guessed at.
 *
 * Run: npx tsx examples/post-execution/time-travel/04-chain-a-pause-and-resume.ts
 */

import type { PausableHandler } from 'footprintjs';
import { flowChart, FlowChartExecutor } from 'footprintjs';
import { timeTravel } from 'footprintjs/trace';

interface ApprovalState {
  trail: string[];
  approved: boolean;
  done: boolean;
}

const gate: PausableHandler<any> = {
  execute: async () => ({ question: 'Approve?' }),
  resume: async (scope: any, input: unknown) => {
    scope.approved = (input as { approved: boolean }).approved;
    scope.trail = [...scope.trail, 'gate'];
  },
};

const chart = flowChart<ApprovalState>(
  'Seed',
  async (scope) => {
    scope.trail = ['seed'];
  },
  'seed',
)
  .addFunction(
    'Prepare',
    async (scope) => {
      scope.trail = [...scope.trail, 'prepare'];
    },
    'prepare',
  )
  .addPausableFunction('Gate', gate, 'gate')
  .addFunction(
    'Finish',
    async (scope) => {
      scope.trail = [...scope.trail, 'finish'];
      scope.done = true;
    },
    'finish',
  )
  .build();

(async () => {
  // ── Pause on one executor, resume on a fresh one ───────────────────────
  const before = new FlowChartExecutor(chart);
  await before.run();
  const checkpoint = before.getCheckpoint();
  const paused = before.getSnapshot();

  const after = new FlowChartExecutor(chart);
  await after.resume(checkpoint!, { approved: true });
  const resumed = after.getSnapshot();

  console.log('=== Two logs, two index spaces ===\n');
  console.log(`  paused : ${paused.commitLog.map((b) => `${b.runtimeStageId}@${b.idx}`).join(' ')}`);
  console.log(`  resumed: ${resumed.commitLog.map((b) => `${b.runtimeStageId}@${b.idx}`).join(' ')}`);
  // The execution counter (#n) continued; the commit index (@n) restarted.

  // ── One axis ───────────────────────────────────────────────────────────
  console.log('\n=== Chained ===\n');
  const cursor = timeTravel([paused, resumed]);
  console.log(`  sourceCount=${cursor.sourceCount}  stops=${cursor.stops.length}`);
  for (const stop of cursor.stops) {
    console.log(`  ${stop.step}. [${stop.kind}] ${stop.label}  source=${stop.sourceIdx}  commitIdx=${stop.commitIdx}`);
  }

  // ── prev/next cross the seam; stateAt folds in the right source ────────
  console.log('\n=== Across the seam ===\n');
  cursor.jumpTo('gate#2');
  console.log(`  at ${cursor.at()?.runtimeStageId} (source ${cursor.at()?.sourceIdx}): approved=${String(cursor.stateAt().state.approved)}`);
  cursor.next();
  console.log(`  at ${cursor.at()?.runtimeStageId} (source ${cursor.at()?.sourceIdx}): approved=${String(cursor.stateAt().state.approved)}`);
  cursor.last();
  console.log(`  at ${cursor.at()?.label}: trail=${JSON.stringify(cursor.stateAt().state.trail)}  fold.sourceIdx=${cursor.stateAt().sourceIdx}`);
  console.log(`  changedSince(gate#2 → end): ${cursor.changedSince(cursor.stops[3]).join(', ')}`);

  // ── A chain that is not one is refused ─────────────────────────────────
  console.log('\n=== Refused ===\n');
  try {
    timeTravel([resumed, paused]);
  } catch (error) {
    console.log(`  backwards: ${(error as Error).message.split('.')[0]}.`);
  }
  const unrelated = new FlowChartExecutor(chart);
  await unrelated.run();
  try {
    timeTravel([paused, unrelated.getSnapshot()]);
  } catch (error) {
    console.log(`  other run: ${(error as Error).message.split('.')[0]}.`);
  }
})().catch(console.error);
