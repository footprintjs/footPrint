/**
 * Deferred Observers — Slow-listener bench: inline vs deferred (RFC-001)
 *
 * THE headline scenario. A recorder that spends ~5ms per event (think:
 * pretty-printing, schema validation, a sync metrics pipeline) attached to
 * an I/O-bound chart (each stage awaits ~10ms of simulated I/O).
 *
 *   INLINE:   the 5ms runs INSIDE the producing statement — every stage
 *             pays listener-time + I/O-time, serialized.
 *             wall ≈ N × (listener + io)
 *
 *   DEFERRED: capture is ~microseconds; the 5ms runs at the next microtask
 *             checkpoint, which lands in the window where the engine is
 *             idle awaiting I/O — observer work OVERLAPS the wait.
 *             wall ≈ N × max(listener, io)
 *
 * Same events, same record, same terminal completeness — the engine's hot
 * path just stops paying for observation.
 *
 * Run: npm run example -- examples/runtime-features/deferred-observers/04-slow-listener-bench.ts
 * (build first: npm run build)
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import type { AttachRecorderOptions } from 'footprintjs';

type Loose = Record<string, unknown>;

const ITERATIONS = 25;
const IO_MS = 10; // simulated downstream latency per stage
const LISTENER_MS = 5; // sync observer cost per event

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function busyWait(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* burn CPU — a deliberately expensive sync listener */
  }
}

const buildChart = () =>
  flowChart<Loose>(
    'Seed',
    async (scope) => {
      scope.$setValue('i', 0);
    },
    'seed',
  )
    .addFunction(
      'CallService',
      async (scope) => {
        const i = scope.$getValue('i') as number;
        scope.$setValue('payload', { attempt: i, body: `request-${i}` }); // ← observed event
        await sleep(IO_MS); // ← the stage's real work: I/O
        scope.$setValue('i', i + 1);
        if (i + 1 >= ITERATIONS) scope.$break();
      },
      'call-service',
    )
    .loopTo('call-service')
    .build();

async function timeRun(label: string, options?: AttachRecorderOptions): Promise<number> {
  let events = 0;
  const executor = new FlowChartExecutor(buildChart());
  executor.attachScopeRecorder(
    {
      id: 'slow-observer',
      onWrite: () => {
        events += 1;
        busyWait(LISTENER_MS);
      },
    },
    options,
  );
  const start = performance.now();
  await executor.run();
  const wall = performance.now() - start;
  const stats = executor.getSnapshot().observerStats;
  console.log(
    `${label.padEnd(10)} wall ${wall.toFixed(0).padStart(5)}ms  events ${events}` +
      (stats ? `  (flushes ${stats.flushes}, budgetExhausted ${stats.budgetExhausted}, drops ${stats.drops})` : ''),
  );
  return wall;
}

async function main() {
  console.log(
    `${ITERATIONS} stages × (${IO_MS}ms I/O + ${LISTENER_MS}ms-per-event listener), ` +
      'identical chart + recorder:\n',
  );
  const inlineWall = await timeRun('inline'); // no options bag = historical synchronous tier
  const deferredWall = await timeRun('deferred', { delivery: 'deferred' });

  const saved = inlineWall - deferredWall;
  console.log(
    `\ndeferred saved ${saved.toFixed(0)}ms (${((saved / inlineWall) * 100).toFixed(0)}% of wall) — ` +
      'observer work overlapped the I/O wait instead of serializing with it.',
  );
  // Each iteration produces 2 observed writes (payload + loop counter).
  const perIterListenerMs = 2 * LISTENER_MS;
  console.log(`theory: inline ≈ N×(io + events×listener) = ${ITERATIONS * (IO_MS + perIterListenerMs)}ms,`);
  console.log(
    `        deferred ≈ N×max(io, events×listener) = ${ITERATIONS * Math.max(IO_MS, perIterListenerMs)}ms ` +
      '(observer work hides in the I/O window)',
  );

  if (deferredWall >= inlineWall) {
    console.warn('note: on a heavily loaded machine the contrast can flatten — re-run for stable numbers.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
