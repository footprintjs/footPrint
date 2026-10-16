/**
 * attempt/deadline.ts — what the run's deadline IS, to everything that reads time (design §3.1, law 3).
 *
 * The deadline is one number, epoch milliseconds (`env.deadline`); the executor arms the run's signal to abort when
 * it passes (`runner/deadline.ts · armRun`). Reaching it is NOT a cancellation: an attempt the deadline cuts short
 * timed out (it had no answer in the time it had — law 4), and the series stops `no-time-left`, not `aborted`. So
 * the reason the run's signal aborts with at the deadline is BRANDED here, and the attempt runner tells the two
 * apart by the brand — never by the message, never by the clock.
 *
 * The brand is a module-private WeakSet: an ordinary `Error` (same message, same name a run with `timeoutMs` always
 * rejected with), recognisable only by identity.
 */

const DEADLINE_REASONS = new WeakSet<object>();

/** The reason the run's signal aborts with when its deadline passes — an `Error`, branded as the deadline's. */
export function deadlineReason(message: string): Error {
  const reason = new Error(message);
  DEADLINE_REASONS.add(reason);
  return reason;
}

/** Whether `reason` is the run's deadline (and not a cancellation). */
export function isDeadlineReason(reason: unknown): boolean {
  return typeof reason === 'object' && reason !== null && DEADLINE_REASONS.has(reason);
}

/** Whether the signal aborted for a reason OTHER than the deadline — a cancellation. */
export function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && !isDeadlineReason(signal.reason);
}

/** A deadline as the engine reads one: a finite number (epoch ms), else none. */
export function readDeadline(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The longest delay a host timer honours (2^31 − 1 ms, ~24.8 days); a longer one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * `setTimeout` for any delay: a delay past the host's limit is waited in chunks, so a 30-day deadline does not fire
 * in a millisecond. Returns the one call that cancels it.
 */
export function setLongTimeout(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const arm = (left: number) => {
    timer = setTimeout(() => {
      if (cancelled) return;
      if (left > MAX_TIMER_MS) arm(left - MAX_TIMER_MS);
      else fn();
    }, Math.min(left, MAX_TIMER_MS));
  };
  arm(Math.max(0, ms));
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

/** Whether `value` is an AbortSignal (structurally — a signal from another realm counts). */
export function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AbortSignal).aborted === 'boolean' &&
    typeof (value as AbortSignal).addEventListener === 'function' &&
    typeof (value as AbortSignal).removeEventListener === 'function'
  );
}
