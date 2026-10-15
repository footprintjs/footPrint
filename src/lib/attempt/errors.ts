/**
 * attempt/errors.ts — the errors the attempt contract throws (design §3.3).
 *
 * - `AttemptTimeoutError` — the attempt's OWN timer ended it (`RetryPolicy.timeoutMs` / the run's deadline). A
 *   timeout is the absence of an answer, not a failure of the outside system (law 4); `errorCategory` reads it
 *   as `'timeout'`.
 * - `UnknownEffectError` — a side-effecting target's last attempt ended with no answer, so nobody knows whether
 *   the effect happened. "Reconcile, do not retry blindly" is on the error, not in prose.
 *
 * The idempotency key is a VALUE: it rides the error as a field (a redaction rule selects it by name) and is
 * never spelled in a message.
 */

/** The attempt's own time cap ran out before it answered. */
export class AttemptTimeoutError extends Error {
  /** The attempt that ran out of time, 1-based. */
  readonly attempt: number;
  /** The cap it ran under, in milliseconds. */
  readonly timeoutMs: number;

  constructor(attempt: number, timeoutMs: number, options?: { readonly cause?: unknown }) {
    super(`attempt ${attempt} ran out of its ${timeoutMs}ms before it answered`);
    this.name = 'AttemptTimeoutError';
    this.attempt = attempt;
    this.timeoutMs = timeoutMs;
    if (options && Object.prototype.hasOwnProperty.call(options, 'cause')) this.cause = options.cause;
  }
}

/** What an `UnknownEffectError` names. */
export interface UnknownEffectInit {
  /** The outside system the stage touches — a name, never a value. */
  readonly system: string;
  /** The key the effect was attempted under — a value, kept as a field and never put in the message. */
  readonly idempotencyKey?: string;
  /** How many attempts ran. */
  readonly attempts: number;
  /** The last attempt's own error. */
  readonly cause?: unknown;
}

/** A side-effecting target's last attempt ended with no answer: whether the effect happened is unknown. */
export class UnknownEffectError extends Error {
  readonly system: string;
  /** Absent (not `undefined`) when no key was given — `declare`, so no class field is emitted for it. */
  declare readonly idempotencyKey?: string;
  readonly attempts: number;

  constructor(init: UnknownEffectInit) {
    super(
      `"${init.system}": the effect of attempt ${init.attempts} is unknown — reconcile with the system ` +
        '(look the operation up by its idempotency key) before trying again',
    );
    this.name = 'UnknownEffectError';
    this.system = init.system;
    if (init.idempotencyKey !== undefined) this.idempotencyKey = init.idempotencyKey;
    this.attempts = init.attempts;
    if (Object.prototype.hasOwnProperty.call(init, 'cause')) this.cause = init.cause;
  }
}
