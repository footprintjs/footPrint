/**
 * Detach — Graceful Shutdown via `flushAllDetached`
 *
 * Simulates a server that scheduled 20 telemetry events via
 * `detachAndForget` and now needs to drain them all before
 * "process.exit". Without `flushAllDetached`, exiting immediately
 * would lose any not-yet-flushed events.
 *
 * Run: npx tsx examples/runtime-features/detach/07-graceful-shutdown.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { flushAllDetached, microtaskBatchDriver } from 'footprintjs/detach';

// ── Side-effect chart — yields so the drain matters ──────────────────

const drained: number[] = [];

const telemetryChart = flowChart('Ship', async (scope) => {
  const seq = scope.$getArgs<{ seq: number }>().seq;
  // Model an asynchronous network round-trip.
  await new Promise<void>((resolve) => setImmediate(resolve));
  drained.push(seq);
}, 'ship').build();

// ── Main — schedule a burst of 20 detaches, then drain ────────────────

const main = flowChart('Burst', async (scope) => {
  for (let seq = 0; seq < 20; seq++) {
    scope.$detachAndForget(microtaskBatchDriver, telemetryChart, { seq });
  }
}, 'burst').build();

(async () => {
  const exec = new FlowChartExecutor(main);
  await exec.run();

  // At this point, 20 detaches are in flight. Without flushAllDetached,
  // exiting now would lose most of them.
  console.log(`Detaches in flight after main run: ${20 - drained.length}`);

  // The simulated sends need one turn. The timeout bounds a stalled shutdown.
  const stats = await flushAllDetached({ timeoutMs: 5_000 });
  console.log(`After flush: drained=${drained.length}, stats=${JSON.stringify(stats)}`);

  // ── Regression guards ──
  if (drained.length !== 20) {
    console.error(`REGRESSION: expected 20 telemetry events drained, got ${drained.length}.`);
    process.exit(1);
  }
  if (stats.pending !== 0) {
    console.error(`REGRESSION: expected pending=0 after successful drain, got ${stats.pending}.`);
    process.exit(1);
  }
  // The drain ran to completion, no leftover work.
  console.log('OK — graceful shutdown drained every in-flight detach.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
