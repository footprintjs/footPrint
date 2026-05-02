/**
 * Detach — Join-Later Fan-Out
 *
 * Fan out 5 parallel sub-evaluations using `$detachAndJoinLater`,
 * then await all of them in a downstream stage via `Promise.all`.
 *
 * Pipeline:
 *   Fanout (queue 5 detaches) → Join (await all handles)
 *
 * Run: npx tsx examples/runtime-features/detach/02-join-later-fanout.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { microtaskBatchDriver } from 'footprintjs/detach';
import type { DetachHandle } from 'footprintjs/detach';

// ── Sub-evaluation: pretend to score a prompt variant ─────────────────

const variantChart = flowChart('ScoreVariant', async (scope) => {
  const args = scope.$getArgs<{ variant: string }>();
  // Simulate variable work time per variant.
  await new Promise((r) => setTimeout(r, 5));
  // RETURN the score so it surfaces as the chart's run() result and
  // shows up on `handle.wait()`'s resolved `{ result }`.
  return args.variant.length;
}, 'score-variant').build();

// ── Main chart ────────────────────────────────────────────────────────

interface FanoutState {
  variants: string[];
  bestScore: number;
}

// Closure-local — handles must NOT live in scope state (see README gotcha).
const handles: DetachHandle[] = [];

const main = flowChart<FanoutState>('Init', async (scope) => {
  scope.variants = ['short', 'medium-len', 'a-much-longer-variant', 'tiny', 'middle'];
}, 'init')
  .addFunction('Fanout', async (scope) => {
    for (const variant of scope.variants) {
      handles.push(scope.$detachAndJoinLater(microtaskBatchDriver, variantChart, { variant }));
    }
    // Parent returns immediately — children are queued for microtask flush.
  }, 'fanout')
  .addFunction('Join', async (scope) => {
    // Await every handle in parallel.
    const settled = await Promise.allSettled(handles.map((h) => h.wait()));
    const scores = settled
      .map((r) => (r.status === 'fulfilled' ? (r.value.result as number) : 0));
    scope.bestScore = Math.max(...scores);
  }, 'join')
  .build();

// ── Run + inspect ─────────────────────────────────────────────────────

(async () => {
  const exec = new FlowChartExecutor(main);
  await exec.run();

  const snap = exec.getSnapshot();
  const bestScore = snap.sharedState.bestScore as number;
  console.log(`Variants scored: ${handles.length}`);
  console.log(`Statuses: ${handles.map((h) => h.status).join(', ')}`);
  console.log(`Best score: ${bestScore}`);

  // ── Regression guards ──
  if (handles.length !== 5) {
    console.error(`REGRESSION: expected 5 handles, got ${handles.length}.`);
    process.exit(1);
  }
  if (!handles.every((h) => h.status === 'done')) {
    console.error('REGRESSION: not all handles reached "done".', handles.map((h) => h.status));
    process.exit(1);
  }
  // 'a-much-longer-variant' = 21 chars — that's the best score.
  if (bestScore !== 21) {
    console.error(`REGRESSION: expected best score 21, got ${bestScore}.`);
    process.exit(1);
  }

  console.log('OK — fan-out + Promise.all pattern works end-to-end.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
