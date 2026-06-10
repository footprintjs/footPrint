/**
 * Deferred Observers — Backpressure with honest accounting (RFC-001)
 *
 * The deferred queue is BOUNDED (`maxQueue`, default 10 000). When a stage
 * bursts more events than the bound between two checkpoints, the overflow
 * policy decides what happens — and every loss is COUNTED, never silent:
 *
 *   - 'drop-oldest' (default): evict the oldest queued event. Lost events
 *     increment `observerStats.drops` and leave visible gaps in what your
 *     listener receives (and seq gaps inside the queue — loss is part of
 *     the record).
 *   - 'sample': under saturation, admit 1 in `sampleEvery` arrivals.
 *   - 'block': refuse to lose anything — the overflow event is delivered
 *     synchronously INLINE instead (you explicitly buy back blocking
 *     delivery for zero loss; counted in `inlineDeliveries`).
 *
 * Run: npm run example -- examples/runtime-features/deferred-observers/02-backpressure.ts
 * (build first: npm run build)
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import type { WriteEvent } from 'footprintjs';

type Loose = Record<string, unknown>;

const BURST = 40; // events produced in ONE stage (one sync slice — no checkpoint between)
const MAX_QUEUE = 8;

const buildBurstChart = () =>
  flowChart<Loose>(
    'Burst',
    async (scope) => {
      for (let i = 0; i < BURST; i++) scope.$setValue(`metric-${String(i).padStart(2, '0')}`, i);
    },
    'burst',
  ).build();

async function run(overflow: 'drop-oldest' | 'block') {
  const received: string[] = [];
  const executor = new FlowChartExecutor(buildBurstChart());
  executor.attachScopeRecorder(
    { id: 'meter', onWrite: (e: WriteEvent) => received.push(e.key) },
    { delivery: 'deferred', capture: 'clone', maxQueue: MAX_QUEUE, overflow },
  );
  await executor.run();
  const stats = executor.getSnapshot().observerStats!;

  console.log(`\n── overflow: '${overflow}' (maxQueue ${MAX_QUEUE}, burst ${BURST}) ──`);
  console.log(`received ${received.length}/${BURST} events`);
  console.log(`stats: drops=${stats.drops} inlineDeliveries=${stats.inlineDeliveries} depth=${stats.depth}`);
  if (overflow === 'drop-oldest') {
    // The gap is VISIBLE: the oldest events of the burst are missing, the
    // freshest survived — and the drop counter owns up to every loss.
    console.log(`first survivor: ${received[0]} (everything older was dropped — a visible gap)`);
    console.log(`conservation: received(${received.length}) + drops(${stats.drops}) = ${BURST}`);
  } else {
    console.log('zero loss: every overflow event was delivered synchronously inline instead');
  }
  return { received, stats };
}

async function main() {
  const lossy = await run('drop-oldest');
  if (lossy.stats.drops === 0) throw new Error('expected drops under drop-oldest saturation');
  if (lossy.received.length + lossy.stats.drops !== BURST) throw new Error('loss accounting must conserve');

  const lossless = await run('block');
  if (lossless.received.length !== BURST) throw new Error("'block' must lose nothing");
  if (lossless.stats.inlineDeliveries === 0) throw new Error("'block' overflow must count inline deliveries");

  console.log('\nbackpressure is a policy with honest accounting — never an OOM, never a silent stall.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
