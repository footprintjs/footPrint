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
import { microtaskBatchDriver } from 'footprintjs/detach';

// ── Side-effect chart: a single stage that records the event ──────────

const telemetryEvents: unknown[] = [];

const telemetryChart = flowChart('ShipTelemetry', async (scope) => {
  // In real life this would POST to a telemetry endpoint. For the example
  // we just push to an array so the test can verify it ran.
  telemetryEvents.push(scope.$getArgs());
}, 'ship-telemetry').build();

// ── Main chart: process an order, fire telemetry, return ──────────────

interface OrderState {
  orderId: string;
  parentReturnedAt: number;
}

const main = flowChart<OrderState>('ProcessOrder', async (scope) => {
  scope.orderId = 'order-42';
  // Fire-and-forget — driver schedules the work, we don't wait.
  scope.$detachAndForget(microtaskBatchDriver, telemetryChart, {
    event: 'order.processed',
    orderId: scope.orderId,
  });
  scope.parentReturnedAt = performance.now();
}, 'process-order').build();

// ── Run + inspect ─────────────────────────────────────────────────────

(async () => {
  const exec = new FlowChartExecutor(main);
  const t0 = performance.now();
  await exec.run();
  const parentRunWall = performance.now() - t0;

  // At this point: parent has returned, but the telemetry microtask may
  // not have flushed yet. Yield twice to give it a chance.
  await Promise.resolve();
  await Promise.resolve();

  console.log(`Parent run wall: ${parentRunWall.toFixed(2)}ms`);
  console.log(`Telemetry events shipped: ${telemetryEvents.length}`);
  console.log(`First event: ${JSON.stringify(telemetryEvents[0])}`);

  // ── Regression guards ──
  if (telemetryEvents.length !== 1) {
    console.error(`REGRESSION: expected 1 telemetry event, got ${telemetryEvents.length}.`);
    process.exit(1);
  }
  const evt = telemetryEvents[0] as { event: string; orderId: string };
  if (evt.event !== 'order.processed' || evt.orderId !== 'order-42') {
    console.error('REGRESSION: telemetry payload wrong.', evt);
    process.exit(1);
  }
  // Parent should have returned fast — definitely under 50ms.
  if (parentRunWall > 50) {
    console.error(`REGRESSION: parent run wall too high (${parentRunWall}ms) — detach should not block.`);
    process.exit(1);
  }

  console.log('OK — fire-and-forget telemetry flushed cleanly.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
