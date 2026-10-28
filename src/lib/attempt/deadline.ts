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

import { anySignal } from './anySignal.js';
import { setLongTimeout } from './longTimeout.js';

const DEADLINE_REASONS = new WeakSet<object>();

/** The reason the run's signal aborts with when its deadline passes — an `Error`, branded as the deadline's. */
export function deadlineReason(message: string): Error {
  const reason = new Error(message);
  DEADLINE_REASONS.add(reason);
  return reason;
}

/**
 * Brand `reason` as a time limit — what an attempt's own cap aborts with (P2). An attempt's cap is the deadline of
 * every call made inside it (`attempt/call.ts`), so a call it cuts ran out of time: `'timeout'`, never `'aborted'`.
 * The run's own signal never aborts with it, so a stage attempt reads nothing new.
 */
export function markTimeLimit<T extends object>(reason: T): T {
  DEADLINE_REASONS.add(reason);
  return reason;
}

/** Whether `reason` is the run's deadline or an attempt's cap — a time limit, not a cancellation. */
export function isDeadlineReason(reason: unknown): boolean {
  return typeof reason === 'object' && reason !== null && DEADLINE_REASONS.has(reason);
}

/** Whether the signal aborted for a reason OTHER than a time limit — a cancellation. */
export function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && !isDeadlineReason(signal.reason);
}

/** A deadline as the engine reads one: a finite number (epoch ms), else none. */
export function readDeadline(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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

/** A signal that aborts at a deadline (or with its input), and the one call that releases both. */
export interface ArmedDeadline {
  readonly signal: AbortSignal | undefined;
  dispose(): void;
}

/**
 * Compose `signal` with a timer that aborts at `deadline` (epoch ms) with a branded {@link deadlineReason} — so the
 * attempt runner's reading holds: the signal it is handed aborts at the deadline, as the run's does (`armRun`). A
 * deadline already past aborts at once; without a deadline the signal is handed back as it is.
 */
export function armDeadline(
  signal: AbortSignal | undefined,
  deadline: number | undefined,
  message: string,
  now: () => number = Date.now,
): ArmedDeadline {
  if (deadline === undefined) return { signal, dispose: () => undefined };
  const timer = new AbortController();
  const composed = anySignal([signal, timer.signal]);
  const reason = deadlineReason(message);
  const left = deadline - now();
  let cancel: () => void = () => undefined;
  if (left <= 0) timer.abort(reason);
  else cancel = setLongTimeout(() => timer.abort(reason), left);
  return {
    signal: composed.signal,
    dispose: () => {
      cancel();
      composed.dispose();
    },
  };
}
