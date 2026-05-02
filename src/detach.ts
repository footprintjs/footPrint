/**
 * footprintjs/detach — Fire-and-forget child flowchart execution.
 *
 * A library of scheduling drivers that lets you detach work from the
 * parent stage's hot path. The parent stage returns immediately; the
 * child runs on whichever driver you pick (microtask, immediate, plus
 * setImmediate / setTimeout / sendBeacon / worker-thread in v4.17.1+).
 *
 * Two shapes:
 *
 *   - `detachAndJoinLater(driver, child, input)` — returns a `DetachHandle`
 *     you can `wait()` on (Promise) or read `.status` from (sync).
 *   - `detachAndForget(driver, child, input)` — discards the handle.
 *     Use for fire-and-forget telemetry where the caller never needs to
 *     know how the child finished.
 *
 * Two entry points:
 *
 *   - `scope.$detachAndJoinLater(driver, child, input)` — from inside a
 *     stage. refIds are minted from the calling stage's runtimeStageId
 *     for diagnostic correlation.
 *   - `executor.detachAndJoinLater(driver, child, input)` — from outside
 *     any chart (consumer code). refIds use the synthetic `__executor__`
 *     prefix.
 *
 * @example
 * ```typescript
 * import { microtaskBatchDriver } from 'footprintjs/detach';
 * import { flowChart, FlowChartExecutor } from 'footprintjs';
 *
 * const telemetry = flowChart('telemetry', async (scope) => {
 *   await fetch('/log', { method: 'POST', body: JSON.stringify(scope.$getArgs()) });
 * }, 'telemetry').build();
 *
 * const main = flowChart('process', async (scope) => {
 *   scope.result = await heavyWork();
 *   // Fire telemetry without blocking the parent.
 *   scope.$detachAndForget(microtaskBatchDriver, telemetry, { event: 'processed' });
 * }, 'process').build();
 *
 * await new FlowChartExecutor(main).run();
 * ```
 */

// ─── Types ───────────────────────────────────────────────────────────
export type {
  DetachDriver,
  DetachHandle,
  DetachPollResult,
  DetachWaitResult,
  DriverCapabilities,
} from './lib/detach/types.js';

// ─── Driver factories + default singletons ───────────────────────────
export { createImmediateDriver, immediateDriver } from './lib/detach/drivers/immediate.js';
export { createMicrotaskBatchDriver, microtaskBatchDriver } from './lib/detach/drivers/microtaskBatch.js';
export type { SendBeaconDriverOptions } from './lib/detach/drivers/sendBeacon.js';
export { createSendBeaconDriver } from './lib/detach/drivers/sendBeacon.js';
export { createSetImmediateDriver, setImmediateDriver } from './lib/detach/drivers/setImmediate.js';
export type { SetTimeoutDriverOptions } from './lib/detach/drivers/setTimeout.js';
export { createSetTimeoutDriver, setTimeoutDriver } from './lib/detach/drivers/setTimeout.js';
export type { WorkerThreadDriverOptions } from './lib/detach/drivers/workerThread.js';
export { createWorkerThreadDriver } from './lib/detach/drivers/workerThread.js';

// ─── Handle factory + helpers (for custom-driver authors) ────────────
export { asImpl, createHandle, HandleImpl } from './lib/detach/handle.js';
export type { ChildRunner } from './lib/detach/runChild.js';
export { defaultRunChild } from './lib/detach/runChild.js';

// ─── Registry — diagnostic surface ───────────────────────────────────
export {
  size as detachedCount,
  ids as listDetachedIds,
  lookup as lookupDetachedHandle,
} from './lib/detach/registry.js';

// ─── Flush — graceful-shutdown helper ────────────────────────────────
export type { FlushOptions, FlushResult } from './lib/detach/flush.js';
export { flushAllDetached } from './lib/detach/flush.js';
