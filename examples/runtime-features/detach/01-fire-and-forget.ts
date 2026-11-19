/**
 * Detach — Fire-and-Forget Telemetry
 *
 * The parent stage processes an order, then fires a telemetry chart via
 * `microtaskBatchDriver`. The handle is discarded — caller never waits.
 *
 * Pipeline:
 *   ProcessOrder → (commits + returns)
 *                       │
 *                       └─► driver flushes ─► TelemetryChart
 *
 * Run: npx tsx examples/runtime-features/detach/01-fire-and-forget.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { flushAllDetached, microtaskBatchDriver } from 'footprintjs/detach';

// ── Side-effect chart: a single stage that records the event ──────────

const telemetryEvents: unknown[] = [];

const telemetryChart = flowChart('ShipTelemetry', async (scope) => {
  // Model an asynchronous POST with a turn of the event loop.
  await new Promise<void>((resolve) => setImmediate(resolve));
  telemetryEvents.push(scope.$getArgs());
}, 'ship-telemetry').build();

// ── Main chart: process an order, fire telemetry, return ──────────────

interface OrderState {
  orderId: string;
}

const main = flowChart<OrderState>('ProcessOrder', async (scope) => {
  scope.orderId = 'order-42';
  // Fire-and-forget — driver schedules the work, we don't wait.
  scope.$detachAndForget(microtaskBatchDriver, telemetryChart, {
    event: 'order.processed',
    orderId: scope.orderId,
  });
}, 'process-order').build();

// ── Run + inspect ─────────────────────────────────────────────────────

(async () => {
  const exec = new FlowChartExecutor(main);
  const t0 = performance.now();
  await exec.run();
  const parentRunWall = performance.now() - t0;
  console.log(`Parent run wall: ${parentRunWall.toFixed(2)}ms`);

  if (telemetryEvents.length > 0) {
    throw new Error('REGRESSION: telemetry finished before the parent returned.');
  }

  // The handle was discarded, so drain every in-flight detached run.
  const flushed = await flushAllDetached({ timeoutMs: Infinity });
  console.log(`Telemetry events shipped: ${telemetryEvents.length}`);
  console.log(`First event: ${JSON.stringify(telemetryEvents[0])}`);

  // ── Regression guards ──
  if (flushed.pending !== 0) {
    console.error(`REGRESSION: ${flushed.pending} detached run(s) still pending after flush.`);
    process.exit(1);
  }
  if (telemetryEvents.length !== 1) {
    console.error(`REGRESSION: expected 1 telemetry event, got ${telemetryEvents.length}.`);
    process.exit(1);
  }
  const evt = telemetryEvents[0] as { event: string; orderId: string };
  if (evt.event !== 'order.processed' || evt.orderId !== 'order-42') {
    console.error('REGRESSION: telemetry payload wrong.', evt);
    process.exit(1);
  }
  console.log('OK — fire-and-forget telemetry flushed cleanly.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
