/**
 * Detach — Immediate Driver for Tests
 *
 * Demonstrates the contrast with microtaskBatchDriver: the immediate
 * driver advances the handle to `running` SYNCHRONOUSLY inside
 * `schedule()`. Useful in tests where you want to assert handle state
 * before the next async tick.
 *
 * Run: npx tsx examples/runtime-features/detach/04-immediate-for-tests.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { immediateDriver, microtaskBatchDriver } from 'footprintjs/detach';
import type { DetachHandle } from 'footprintjs/detach';

// ── A trivial child chart ─────────────────────────────────────────────

const tinyChart = flowChart('Tiny', async (scope) => {
  scope.$setValue('done', true);
  return true;
}, 'tiny').build();

// ── Main: snap two handles, compare initial status ────────────────────

let immediateHandle: DetachHandle | undefined;
let microtaskHandle: DetachHandle | undefined;
const initialStatusImmediate: string[] = [];
const initialStatusMicrotask: string[] = [];

const main = flowChart('Capture', async (scope) => {
  immediateHandle = scope.$detachAndJoinLater(immediateDriver, tinyChart, undefined);
  initialStatusImmediate.push(immediateHandle.status); // expect 'running'
  microtaskHandle = scope.$detachAndJoinLater(microtaskBatchDriver, tinyChart, undefined);
  initialStatusMicrotask.push(microtaskHandle.status); // expect 'queued'
}, 'capture').build();

(async () => {
  const exec = new FlowChartExecutor(main);
  await exec.run();

  await immediateHandle?.wait();
  await microtaskHandle?.wait();

  console.log(`Immediate driver initial status: ${initialStatusImmediate[0]}`);
  console.log(`Microtask driver initial status: ${initialStatusMicrotask[0]}`);
  console.log(`Both terminal? immediate=${immediateHandle?.status}, microtask=${microtaskHandle?.status}`);

  // ── Regression guards ──
  if (initialStatusImmediate[0] !== 'running') {
    console.error(`REGRESSION: immediate driver should snap to 'running' synchronously, got ${initialStatusImmediate[0]}.`);
    process.exit(1);
  }
  if (initialStatusMicrotask[0] !== 'queued') {
    console.error(`REGRESSION: microtask driver should remain 'queued' synchronously, got ${initialStatusMicrotask[0]}.`);
    process.exit(1);
  }
  if (immediateHandle?.status !== 'done' || microtaskHandle?.status !== 'done') {
    console.error('REGRESSION: at least one handle did not reach done.');
    process.exit(1);
  }

  console.log('OK — immediate vs microtask driver telescoping verified.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
