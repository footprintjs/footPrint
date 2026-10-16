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
