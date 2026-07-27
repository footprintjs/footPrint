/**
 * Snapshot — Recorders Ride the Snapshot
 *
 * `getSnapshot().recorders` is the hand-off to anyone who does NOT have the
 * executor: a trace viewer, an exported run, a UI panel fed a frozen JSON
 * blob. Two guarantees this example demonstrates end to end:
 *
 *   1. ONE row per attached recorder. `metrics()` implements `onPause`, a
 *      hook name that belongs to BOTH the data-flow and control-flow
 *      interfaces, so it is legitimately registered on both channels — and
 *      still shows up exactly once.
 *   2. The narrative is on the snapshot. Attach `narrative()` and the run's
 *      plain-English story travels with the snapshot instead of living only
 *      behind `executor.getNarrativeEntries()`.
 *
 * The whole `recorders` array survives `structuredClone` / `JSON.stringify`,
 * so it can be posted, persisted, or handed to a browser as-is.
 *
 * Run: npx tsx examples/post-execution/snapshot/05-recorders-on-the-snapshot.ts
 */

import { flowChart, FlowChartExecutor, narrative } from 'footprintjs';
import { metrics } from 'footprintjs/recorders';

interface OrderState {
  amount: number;
  fee: number;
  receipt: string;
}

const chart = flowChart<OrderState>(
  'Intake',
  (scope) => {
    scope.amount = 120;
  },
  'intake',
)
  .addFunction(
    'Price',
    (scope) => {
      scope.fee = Math.round(scope.amount * 0.03);
    },
    'price',
  )
  .addFunction(
    'Receipt',
    (scope) => {
      scope.receipt = `charged ${scope.amount + scope.fee}`;
    },
    'receipt',
  )
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  const story = narrative();
  const meter = metrics();

  executor.attachCombinedRecorder(story);
  executor.attachCombinedRecorder(meter);
  await executor.run();

  const snap = executor.getSnapshot();
  const rows = snap.recorders ?? [];

  // 1. One row per recorder — no id appears twice.
  console.log(
    'Recorders on the snapshot:',
    rows.map((r) => `${r.id} → ${r.name}`),
  );
  const ids = rows.map((r) => r.id);
  console.log('All ids unique:', ids.length === new Set(ids).size);

  // 2. The narrative travelled with the snapshot.
  const narrativeRow = rows.find((r) => r.name === 'Narrative');
  const entries = (narrativeRow?.data ?? []) as Array<{ text: string; depth: number }>;
  console.log(`\nStory carried by the snapshot (${entries.length} entries):`);
  for (const entry of entries) console.log(`${'  '.repeat(entry.depth)}${entry.text}`);

  // 3. Shareable as-is: no live references, no clone hazards.
  const exported = JSON.parse(JSON.stringify(rows));
  console.log('\nJSON round-trip preserved every row:', exported.length === rows.length);
})().catch(console.error);
