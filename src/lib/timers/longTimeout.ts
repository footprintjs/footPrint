/**
 * timers/longTimeout.ts — the ONE long-timer law: how the library arms a host timer for a limit of any length.
 *
 * A host timer holds at most 2^31 − 1 ms (about 24.8 days). Node turns a longer delay — `Infinity` included — into
 * 1 ms, with a `TimeoutOverflowWarning`, so a raw `setTimeout(fn, limit)` gives up at once exactly when the caller
 * asked to wait longest. Every wait of a caller-supplied length is armed here: an attempt's cap and the wait between
 * attempts (`attempt/runner.ts`), the run's deadline (`attempt/deadline.ts · armDeadline`,
 * `runner/deadline.ts · armRun`), the drains and flushes that wait at most a caller's `timeoutMs`
 * (`observer-queue/deferredDispatcher.ts · drain`, `detach/flush.ts · flushAllDetached`, `runner/recordSink.ts ·
 * flush`, `sinks/fileSink.ts`), the bounded reads (`sinks/indexedIO.ts`, `recorder/AttemptRecorder.ts`,
 * `runner/captureHistory.ts`) and the `setTimeout` detach driver. `test/architecture/timer-law.test.ts` refuses a raw
 * host timer — or any other way of reaching one — anywhere else in `src/`.
 *
 * THE LAW, by the limit:
 *   - `Infinity` — no limit: NO timer is armed and `fn` never runs, so nothing keeps the process alive on its account.
 *     The work the limit bounds decides when the wait ends.
 *   - a finite delay past 2^31 − 1 ms — waited in chunks of at most 2^31 − 1 ms, so it never fires early and never in
 *     1 ms: a 30-day deadline fires after 30 days.
 *   - anything else that is not a number > 0 (`0`, a negative, `-Infinity`, `NaN`) — already due: `fn` runs on the
 *     next timer turn, as the host runs `setTimeout(fn, 0)`.
 *
 * A LEAF in its own neutral folder (`timers/`, L0 in scripts/layering.config.cjs): it imports nothing, so any layer —
 * the observer queue (L1) as much as the engine — arms its limits with the one law.
 */

/** The longest delay a host timer honours (2^31 − 1 ms, ~24.8 days); Node fires a longer one after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/** How a long timer is armed. */
export interface LongTimeoutOptions {
  /**
   * Unref every host timer it arms (where the host has `unref`), so a timer that only BOUNDS a wait never keeps the
   * process alive on its own. Off by default: the engine's own limits keep a run alive while it waits.
   */
  readonly unref?: boolean;
}

/**
 * `setTimeout` for a limit of any length, by the law above. Returns the one call that cancels it — a no-op when no
 * timer was armed (`Infinity`).
 */
export function setLongTimeout(fn: () => void, ms: number, options?: LongTimeoutOptions): () => void {
  if (ms === Infinity) return () => undefined;
  const unref = options?.unref === true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const arm = (left: number) => {
    timer = setTimeout(() => {
      if (cancelled) return;
      if (left > MAX_TIMER_MS) arm(left - MAX_TIMER_MS);
      else fn();
    }, Math.min(left, MAX_TIMER_MS));
    if (unref) (timer as { unref?: () => void }).unref?.();
  };
  arm(ms > 0 ? ms : 0);
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
