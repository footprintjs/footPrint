/**
 * Detach — Status Polling (Synchronous Property Reads)
 *
 * The handle is NOT Promise-shaped. Reading `handle.status` is a plain
 * property access — useful for backpressure checks, status banners, and
 * "still in flight?" gates that shouldn't depend on async.
 *
 * This example fires 10 detaches with random work durations, then polls
 * `.status` until they're all terminal — without ever calling `wait()`.
 *
 * Run: npx tsx examples/runtime-features/detach/06-status-polling.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { createMicrotaskBatchDriver } from 'footprintjs/detach';
import type { DetachHandle } from 'footprintjs/detach';

// ── A child runner with variable work duration ────────────────────────

const driver = createMicrotaskBatchDriver(async (_chart, input) => {
  // Pretend each unit takes 5–25ms.
  const ms = 5 + ((input as number) % 5) * 5;
  await new Promise((r) => setTimeout(r, ms));
  return input;
});

const dummyChart = flowChart('dummy', async () => {}, 'dummy').build();

// ── Main: fire 10 detaches, then poll ─────────────────────────────────

const handles: DetachHandle[] = [];

const main = flowChart('Fire', async (scope) => {
  for (let i = 0; i < 10; i++) {
    handles.push(scope.$detachAndJoinLater(driver, dummyChart, i));
  }
}, 'fire').build();

function inFlightCount(): number {
  return handles.filter((h) => h.status === 'queued' || h.status === 'running').length;
}

(async () => {
  const exec = new FlowChartExecutor(main);
  await exec.run();

  // Snap initial status (right after schedule but before microtask flush).
  const initialInFlight = inFlightCount();
  console.log(`Initial in-flight: ${initialInFlight}`);

  // Poll loop — no await on any handle, just status property.
  let pollCount = 0;
  while (inFlightCount() > 0) {
    pollCount += 1;
    await new Promise((r) => setTimeout(r, 5));
    if (pollCount > 200) {
      console.error('REGRESSION: handles never terminated within 1s.');
      process.exit(1);
    }
  }

  const doneCount = handles.filter((h) => h.status === 'done').length;
  const failedCount = handles.filter((h) => h.status === 'failed').length;

  console.log(`Poll cycles: ${pollCount}`);
  console.log(`Final: done=${doneCount}, failed=${failedCount}`);
  console.log(`Sample results: ${handles.slice(0, 3).map((h) => String(h.result)).join(', ')}`);

  // ── Regression guards ──
  if (initialInFlight !== 10) {
    console.error(`REGRESSION: expected 10 initial in-flight handles, got ${initialInFlight}.`);
    process.exit(1);
  }
  if (doneCount !== 10) {
    console.error(`REGRESSION: expected 10 done, got ${doneCount}.`);
    process.exit(1);
  }
  if (failedCount !== 0) {
    console.error(`REGRESSION: expected 0 failed, got ${failedCount}.`);
    process.exit(1);
  }

  console.log('OK — sync status polling pattern works without any wait() calls.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
