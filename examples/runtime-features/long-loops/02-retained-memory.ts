/**
 * Long Loops — Retained Memory (staging state released at commit, #13b)
 *
 * The execution tree keeps one StageContext per executed stage for the
 * lifetime of the run — that is the audit trail. What it must NOT keep is
 * each stage's STAGING state: the transaction buffer (two full-state clones)
 * and the first-touch state view (a reference pinning one full committed-state
 * generation). `StageContext.commit()` releases both at its end, so a
 * long loop's retained memory is bounded by the commit log + snapshot
 * tracking — not by N full copies of an ever-growing state.
 *
 * Pipeline: Seed → Append (~1KB message to a growing history, loop ×500)
 *
 * Run:                npx tsx examples/runtime-features/long-loops/02-retained-memory.ts
 * With heap numbers:  NODE_OPTIONS=--expose-gc npx tsx examples/runtime-features/long-loops/02-retained-memory.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';

interface HistoryState {
  i: number;
  history: Array<{ role: string; idx: number; content: string }>;
}

const TARGET = 500;

const chart = flowChart<HistoryState>(
  'Seed',
  async (scope) => {
    scope.i = 0;
    scope.history = [];
  },
  'seed',
)
  .addFunction(
    'Append',
    async (scope) => {
      const i = scope.i;
      scope.$batchArray('history', (arr) => {
        arr.push({ role: i % 2 === 0 ? 'user' : 'assistant', idx: i, content: 'm'.repeat(900) });
      });
      scope.i = i + 1;
      if (scope.i >= TARGET) scope.$break(`reached ${TARGET}`);
    },
    'append',
  )
  .loopTo('append')
  .build();

(async () => {
  const gc = (globalThis as { gc?: () => void }).gc;
  const heap = () => {
    gc?.();
    gc?.();
    return process.memoryUsage().heapUsed;
  };

  const before = heap();
  const executor = new FlowChartExecutor(chart);
  await executor.run({ maxIterations: TARGET + 1 });
  const after = heap();

  const snap = executor.getSnapshot();
  console.log(`Iterations: ${snap.sharedState?.i}, history length: ${(snap.sharedState?.history as unknown[]).length}`);
  console.log(`Commits recorded: ${snap.commitLog?.length}`);
  if (gc) {
    console.log(`Retained heap with executor referenced: ${((after - before) / 1048576).toFixed(1)}MB`);
    console.log('Pre-#13b this chart retained ~849MB at N=500 (state generations + buffers);');
    console.log('post-#13b what remains is the commit log + stageReads/stageWrites tracking.');
  } else {
    console.log('(run with NODE_OPTIONS=--expose-gc for retained-heap numbers)');
  }
  console.log('Every StageContext released its buffer + state view at commit (#13b).');
})().catch(console.error);
