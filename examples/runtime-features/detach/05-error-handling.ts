/**
 * Detach — Error Handling
 *
 * A child throws. We show:
 *  1) `wait()` rejects with the original Error
 *  2) `handle.status === 'failed'` and `handle.error` is set
 *  3) Sibling detaches in the same batch are NOT poisoned
 *
 * Run: npx tsx examples/runtime-features/detach/05-error-handling.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { createMicrotaskBatchDriver } from 'footprintjs/detach';
import type { DetachHandle } from 'footprintjs/detach';

// ── A child runner that fails for one input value ─────────────────────

const failingDriver = createMicrotaskBatchDriver(async (_chart, input) => {
  if (input === 'bad') throw new Error('vendor 503: temporarily unavailable');
  return `ok:${input}`;
});

// Stand-in chart — driver doesn't actually execute it (we replaced runChild).
const dummyChart = flowChart('dummy', async () => {}, 'dummy').build();

// ── Main: fire 3 detaches; the middle one will fail ───────────────────

let okHandleA: DetachHandle | undefined;
let badHandle: DetachHandle | undefined;
let okHandleC: DetachHandle | undefined;

const main = flowChart('Trigger', async (scope) => {
  okHandleA = scope.$detachAndJoinLater(failingDriver, dummyChart, 'first');
  badHandle = scope.$detachAndJoinLater(failingDriver, dummyChart, 'bad');
  okHandleC = scope.$detachAndJoinLater(failingDriver, dummyChart, 'third');
}, 'trigger').build();

(async () => {
  const exec = new FlowChartExecutor(main);
  await exec.run();

  // Await each handle independently so one failure doesn't short-circuit.
  let captured: Error | undefined;
  try {
    await badHandle?.wait();
  } catch (e) {
    captured = e as Error;
  }

  const a = await okHandleA?.wait();
  const c = await okHandleC?.wait();

  console.log(`Sibling A: status=${okHandleA?.status}, result=${JSON.stringify(a)}`);
  console.log(`Failing:   status=${badHandle?.status}, error=${badHandle?.error?.message}`);
  console.log(`Sibling C: status=${okHandleC?.status}, result=${JSON.stringify(c)}`);
  console.log(`Captured via catch: ${captured?.message}`);

  // ── Regression guards ──
  if (okHandleA?.status !== 'done' || (a?.result as string) !== 'ok:first') {
    console.error('REGRESSION: sibling A did not complete cleanly.');
    process.exit(1);
  }
  if (badHandle?.status !== 'failed' || badHandle.error?.message !== 'vendor 503: temporarily unavailable') {
    console.error('REGRESSION: failing handle should have status=failed with the original Error.');
    process.exit(1);
  }
  if (okHandleC?.status !== 'done' || (c?.result as string) !== 'ok:third') {
    console.error('REGRESSION: sibling C did not complete (sibling failure poisoned the batch?).');
    process.exit(1);
  }
  if (!captured || captured.message !== 'vendor 503: temporarily unavailable') {
    console.error('REGRESSION: wait() did not reject with the original Error.');
    process.exit(1);
  }

  console.log('OK — error containment + sibling-isolation invariants hold.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
