/**
 * Time Travel — a reader's cursor over a finished run
 *
 * Time travel in footprintjs is READ-TIME. The run is over; the commit log is
 * the Trace it left; the cursor is a reader moving over that Trace with a Fold
 * at each stop. Nothing here re-executes anything, and there is only ever ONE
 * cursor — `drill()` opens a separate one over a subflow's separate log.
 *
 * Four of the five laws are visible in the output below (the fifth — stops are
 * derived from the recorded log — is a property of the strategy, not of a run):
 *   1. one cursor            — `at()` is the only position
 *   2. a miss never moves    — a bad id returns a reason, the panel stays put
 *   3. a fold is detached    — `stateAt().state` is frozen, shares nothing
 *   4. marks live beside     — bookmarks never enter the commit log
 *
 * Run: npx tsx examples/post-execution/time-travel/01-a-readers-cursor.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { timeTravel } from 'footprintjs/trace';

interface CartState {
  items: string[];
  subtotal: number;
  discountPct: number;
  total: number;
}

const chart = flowChart<CartState>('LoadCart', async (scope) => {
  scope.items = ['mug', 'notebook'];
  scope.subtotal = 34;
}, 'load-cart')
  .addFunction('ApplyDiscount', async (scope) => {
    scope.discountPct = scope.subtotal > 30 ? 10 : 0;
  }, 'apply-discount')
  .addFunction('Total', async (scope) => {
    scope.total = Math.round(scope.subtotal * (1 - scope.discountPct / 100) * 100) / 100;
  }, 'total')
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  await executor.run();

  const cursor = timeTravel(executor.getSnapshot());

  // ── The axis ───────────────────────────────────────────────────────────
  console.log('=== Stops ===\n');
  for (const stop of cursor.stops) {
    console.log(`  ${stop.step}. [${stop.kind}] ${stop.label} (${stop.runtimeStageId || '—'})`);
  }
  //  0. [start] Run start (—)
  //  1. [commit] LoadCart (load-cart#0)
  //  2. [commit] ApplyDiscount (apply-discount#1)
  //  3. [commit] Total (total#2)
  //  4. [end] Run end (—)

  // ── Walking, with a fold at each stop ──────────────────────────────────
  console.log('\n=== Walking forward ===\n');
  cursor.first();
  do {
    const stop = cursor.at()!;
    console.log(`  after ${stop.label}: changed [${cursor.changedSince().join(', ')}]`);
    console.log(`    state = ${JSON.stringify(cursor.stateAt().state)}`);
  } while (cursor.next().moved);

  // ── Law 2: a miss never moves ──────────────────────────────────────────
  console.log('\n=== A miss never moves ===\n');
  cursor.jumpTo('apply-discount#1');
  const move = cursor.jumpTo('no-such-stage#9');
  if (!move.moved) {
    console.log(`  refused (${move.reason}); still at "${cursor.at()!.label}"`);
  }
  // refused (miss); still at "ApplyDiscount"

  // ── Law 3: a fold is detached and says how it was made ─────────────────
  const folded = cursor.stateAt();
  console.log(`\n  basis=${folded.basis} redacted=${folded.redacted} frozen=${Object.isFrozen(folded.state)}`);
  // basis=initial+log redacted=false frozen=true

  // ── Law 4: marks live beside the log ───────────────────────────────────
  cursor.mark('where the discount appeared');
  cursor.first();
  cursor.jumpToMark('where the discount appeared');
  console.log(`\n  jumped back to "${cursor.at()!.label}"; marks in the commit log: ${
    JSON.stringify(executor.getSnapshot().commitLog).includes('where the discount') ? 'yes' : 'no'
  }`);
  // jumped back to "ApplyDiscount"; marks in the commit log: no
})().catch(console.error);
