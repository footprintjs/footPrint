/**
 * Time Travel — a stored recording, typed honestly, with no cast
 *
 * A recording arrives as parsed JSON. A careful consumer types its rows as
 * `readonly unknown[]` — it will not claim that what came back off disk is a
 * `CommitBundle`. Since 9.18.0 `TimeTravelSource.commitLog` accepts exactly
 * that, and the narrowing happens PER ROW where the fold reads one. A row that
 * is not a bundle becomes a GAP: it keeps its index (so every `commitIdx` still
 * addresses the same position), contributes no state, gets no stop, and is
 * reported in `FoldedState.skipped` with the index and a reason.
 *
 * Run: npx tsx examples/post-execution/time-travel/05-a-stored-recording-needs-no-cast.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { stateAt, timeTravel } from 'footprintjs/trace';

/** How a consumer really types what it read back: unvalidated rows. */
interface StoredRecording {
  readonly commitLog: readonly unknown[];
  readonly initialState?: Record<string, unknown>;
}

const chart = flowChart<any>(
  'Collect',
  async (scope: any) => {
    scope.events = ['collected'];
  },
  'collect',
)
  .addFunction(
    'Decide',
    async (scope: any) => {
      scope.verdict = scope.tenant.plan === 'enterprise' ? 'allow' : 'review';
    },
    'decide',
  )
  .addFunction(
    'Report',
    async (scope: any) => {
      scope.report = `${scope.verdict}/${scope.events.length}`;
    },
    'report',
  )
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart, {
    initialContext: { tenant: { id: 'T-1', plan: 'enterprise' } },
  } as any);
  await executor.run();
  const live = executor.getSnapshot();

  // Through JSON and back, typed as the consumer would type it. NO CAST below.
  const stored: StoredRecording = JSON.parse(JSON.stringify({ commitLog: live.commitLog, initialState: live.initialState }));

  console.log('=== A clean recording ===\n');
  const cursor = timeTravel(stored);
  cursor.last();
  console.log(`  stops: ${cursor.stops.map((s) => s.stageId || s.kind).join(' → ')}`);
  console.log(`  final state matches live: ${JSON.stringify(cursor.stateAt().state) === JSON.stringify(live.sharedState)}`);
  console.log(`  skipped: ${String(cursor.stateAt().skipped)}   ← absent on a clean log, the 9.17.0 shape exactly`);

  // ── One corrupt row ────────────────────────────────────────────────────
  console.log('\n=== Row 1 replaced by whatever came off disk ===\n');
  const corrupted: StoredRecording = { ...stored, commitLog: [stored.commitLog[0], null, stored.commitLog[2]] };
  const damaged = timeTravel(corrupted);
  console.log(`  stops: ${damaged.stops.map((s) => `${s.stageId || s.kind}@${s.commitIdx}`).join(' → ')}`);
  // 'report' is STILL at commitIdx 2 — the gap held its index.

  const folded = stateAt(corrupted, 2);
  console.log(`  fold through 2: verdict=${String(folded.state.verdict)}  events=${JSON.stringify(folded.state.events)}`);
  console.log(`  skipped: ${JSON.stringify(folded.skipped)}`);
  // The lost row's write is honestly absent; the readable rows still fold.
})().catch(console.error);
