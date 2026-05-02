/**
 * Detach — Builder-Native Composition
 *
 * Demonstrates `addDetachAndForget` (fire-and-forget as a chart stage)
 * and `addDetachAndJoinLater` with `onHandle` callback pattern.
 *
 * Pipeline:
 *   Seed → [DetachAndForget: telemetry]
 *        → [DetachAndJoinLater: eval-a] (handle pushed to closure)
 *        → [DetachAndJoinLater: eval-b] (handle pushed to closure)
 *        → Join (await Promise.all)
 *
 * Run: npx tsx examples/runtime-features/detach/08-builder-native.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { createMicrotaskBatchDriver } from 'footprintjs/detach';
import type { DetachHandle } from 'footprintjs/detach';

// ── Side-effect chart: telemetry ──────────────────────────────────────

const telemetryShipped: unknown[] = [];

const telemetryChart = flowChart('ShipTelemetry', async (scope) => {
  telemetryShipped.push(scope.$getArgs());
}, 'ship-telemetry').build();

// ── Eval chart: returns the input × 2 (just for demonstration) ────────

const evalChart = flowChart('ScoreVariant', async (scope) => {
  const input = scope.$getArgs<{ value: number }>().value;
  await new Promise((r) => setTimeout(r, 5));
  return input * 2;
}, 'score-variant').build();

// ── Closure-local handle bag (see "Concurrency note" in the .md) ──────

const evalHandles: DetachHandle[] = [];

// ── Driver: build a fresh one so the example is hermetic ──────────────

const driver = createMicrotaskBatchDriver();

// ── Main chart with builder-native detach stages ──────────────────────

interface MainState {
  orderId: string;
  configA: number;
  configB: number;
  evalSum?: number;
}

const main = flowChart<MainState>('Seed', async (scope) => {
  scope.orderId = 'order-99';
  scope.configA = 7;
  scope.configB = 13;
}, 'seed')
  .addDetachAndForget('telemetry', telemetryChart, {
    driver,
    inputMapper: (scope) => ({ event: 'order.created', orderId: scope.orderId }),
  })
  .addDetachAndJoinLater('eval-a', evalChart, {
    driver,
    inputMapper: (scope) => ({ value: scope.configA }),
    onHandle: (h) => evalHandles.push(h),
  })
  .addDetachAndJoinLater('eval-b', evalChart, {
    driver,
    inputMapper: (scope) => ({ value: scope.configB }),
    onHandle: (h) => evalHandles.push(h),
  })
  .addFunction('Join', async (scope) => {
    const settled = await Promise.all(evalHandles.map((h) => h.wait()));
    scope.evalSum = settled.reduce((acc, r) => acc + (r.result as number), 0);
  }, 'join')
  .build();

(async () => {
  const exec = new FlowChartExecutor(main);
  await exec.run();

  // Yield so the forget-detach has a chance to flush.
  await Promise.resolve();
  await Promise.resolve();

  const snap = exec.getSnapshot();
  const evalSum = snap.sharedState.evalSum as number;

  console.log(`Telemetry shipped: ${telemetryShipped.length}, payload: ${JSON.stringify(telemetryShipped[0])}`);
  console.log(`Eval handles created: ${evalHandles.length}`);
  console.log(`Eval handle statuses: ${evalHandles.map((h) => h.status).join(', ')}`);
  console.log(`Eval sum: ${evalSum} (expected: ${(7 + 13) * 2})`);

  // ── Regression guards ──
  if (telemetryShipped.length !== 1) {
    console.error(`REGRESSION: expected 1 telemetry event, got ${telemetryShipped.length}.`);
    process.exit(1);
  }
  const evt = telemetryShipped[0] as { event: string; orderId: string };
  if (evt.event !== 'order.created' || evt.orderId !== 'order-99') {
    console.error('REGRESSION: telemetry payload wrong.', evt);
    process.exit(1);
  }
  if (evalHandles.length !== 2) {
    console.error(`REGRESSION: expected 2 eval handles, got ${evalHandles.length}.`);
    process.exit(1);
  }
  if (!evalHandles.every((h) => h.status === 'done')) {
    console.error('REGRESSION: not every eval handle reached done.', evalHandles.map((h) => h.status));
    process.exit(1);
  }
  if (evalSum !== 40) {
    console.error(`REGRESSION: expected eval sum 40, got ${evalSum}.`);
    process.exit(1);
  }

  console.log('OK — builder-native detach stages compose cleanly with downstream join.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
