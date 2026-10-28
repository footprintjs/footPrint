/**
 * attempt/backoff.ts — deterministic builders of a `RetryPolicy.backoffMs` function.
 *
 * WHY: every retry loop needs the same few lines — an exponential ceiling and some jitter — and every hand copy of them
 * drifts: a different base, a different jitter, a stated `Retry-After` honoured in one loop and not the next. These
 * helpers build the FUNCTION `RetryPolicy.backoffMs` already takes, so the policy keeps its one shape and the runner
 * keeps its one law: it asks the function once per retry, caps the answer at `maxBackoffMs`, stops a series whose wait
 * would outlast the run's deadline (`no-time-left`), and records the wait it chose (`AttemptRecord.delayMs`,
 * `onStageRetry`'s `delayMs`). The trace explains every wait as it was waited; nothing is redrawn to explain it.
 *
 *   exponentialBackoff({ baseDelayMs, multiplier = 2, jitter = 'none', random = Math.random })
 *     the wait after failed attempt n, under its ceiling c = baseDelayMs × multiplier^(n − 1):
 *       'none'  → c                   deterministic: `random` is never called
 *       'equal' → c/2 + r × c/2       half fixed, half random (r = random(), in [0, 1])
 *       'full'  → r × c
 *   statedWaitFirst(readStatedWaitMs, inner)
 *     a wait the outside system STATED (a `Retry-After`, read off the error) wins; otherwise `inner` decides.
 *
 * The cap is the policy's `maxBackoffMs`, never the helper's: the runner enforces it on every wait, and the static
 * time budget counts a function backoff at that ceiling without calling it — one cap, visible to both. A ceiling
 * saturates at `Number.MAX_SAFE_INTEGER` ms, so no attempt number makes a wait `Infinity` or `NaN`.
 *
 * Refused when built, with an error naming the field: a `baseDelayMs` that is not a finite number >= 0, a `multiplier`
 * that is not a finite number >= 1, an unknown `jitter`, a `random` or a reader that is not a function, an `inner`
 * that is neither a function nor a finite number >= 0. A `random()` answering outside [0, 1] throws when asked; the
 * runner reads a throwing backoff as no wait (`resolveBackoffMs`), so the record shows `delayMs: 0`.
 */

import type { RetryPolicy } from './types.js';

/** How much of an exponential wait is random: none of it, half of it, or all of it. */
export type BackoffJitter = 'none' | 'equal' | 'full';

/** The schedule {@link exponentialBackoff} builds a `RetryPolicy.backoffMs` function from. */
export interface BackoffSpec {
  /** The ceiling of the first wait (after attempt 1), in milliseconds — a finite number >= 0. */
  readonly baseDelayMs: number;
  /** How much each ceiling grows over the one before — a finite number >= 1. Default `2`. */
  readonly multiplier?: number;
  /** How much of each wait is random. Default `'none'`: the wait IS the ceiling. */
  readonly jitter?: BackoffJitter;
  /** The jitter's random source, answering in [0, 1]. Default `Math.random`; a fixed one makes a test exact. */
  readonly random?: () => number;
}

/** A `RetryPolicy.backoffMs` function: the wait in milliseconds after failed attempt `attempt` (1-based). */
export type BackoffFunction = (attempt: number, error?: unknown) => number;

/** Reads the wait an error states (a parsed `Retry-After`), in milliseconds, or `undefined` when it states none. */
export type StatedWaitReader = (error: unknown) => number | undefined;

const JITTERS: readonly BackoffJitter[] = ['none', 'equal', 'full'];

/** Where a ceiling saturates: a wait is never `Infinity` and never `NaN`. */
const MAX_WAIT_MS = Number.MAX_SAFE_INTEGER;

/**
 * A `RetryPolicy.backoffMs` function for an exponential schedule: the wait after failed attempt `n` is drawn under the
 * ceiling `baseDelayMs × multiplier^(n − 1)` by the declared jitter. Cap it with the policy's `maxBackoffMs`.
 *
 * @example
 * ```ts
 * .retry({ attempts: 4, backoffMs: exponentialBackoff({ baseDelayMs: 200, jitter: 'equal' }), maxBackoffMs: 5_000 })
 * ```
 */
export function exponentialBackoff(spec: BackoffSpec): BackoffFunction {
  const { baseDelayMs, multiplier, jitter, random } = readSpec(spec);
  return (attempt: number): number => {
    const ceiling = ceilingOf(baseDelayMs, multiplier, stepOf(attempt));
    if (jitter === 'none') return ceiling;
    const r = draw(random);
    // Never above the ceiling, rounding included: halving a subnormal ceiling is inexact and can round up.
    return jitter === 'equal' ? Math.min(ceiling, ceiling / 2 + (r * ceiling) / 2) : r * ceiling;
  };
}

/**
 * A `RetryPolicy.backoffMs` function that honours a wait the outside system stated: when `readStatedWaitMs(error)`
 * answers a finite number >= 0, that is the wait; otherwise `inner` (a backoff function, or a fixed number of
 * milliseconds) decides. A reader that throws or answers anything else states nothing — a malformed `Retry-After`
 * falls back to the schedule rather than to a wrong wait. The runner still caps the stated wait at `maxBackoffMs` and
 * stops the series when it would outlast the run's deadline.
 *
 * @example
 * ```ts
 * const retryAfterMs = (error: unknown) => (error as { retryAfterMs?: number }).retryAfterMs;
 * .retry({ attempts: 3, backoffMs: statedWaitFirst(retryAfterMs, exponentialBackoff({ baseDelayMs: 100 })), maxBackoffMs: 10_000 })
 * ```
 */
export function statedWaitFirst(
  readStatedWaitMs: StatedWaitReader,
  inner: NonNullable<RetryPolicy['backoffMs']>,
): BackoffFunction {
  if (typeof readStatedWaitMs !== 'function') {
    throw new TypeError(`statedWaitFirst: readStatedWaitMs must be a function (got ${shown(readStatedWaitMs)})`);
  }
  if (typeof inner !== 'function') {
    checkNumber('statedWaitFirst: inner', inner, 0, 'a backoff function or a finite number >= 0');
  }
  return (attempt: number, error?: unknown): number => {
    const stated = statedWaitOf(readStatedWaitMs, error);
    if (stated !== undefined) return stated;
    return typeof inner === 'function' ? inner(attempt, error) : inner;
  };
}

/** Each field read ONCE, then checked: what is checked is exactly what the function keeps (a getter cannot differ). */
function readSpec(spec: BackoffSpec): Required<BackoffSpec> {
  if (spec === null || typeof spec !== 'object') {
    const shape = '{ baseDelayMs, multiplier?, jitter?, random? }';
    throw new TypeError(`exponentialBackoff: the spec must be an object (${shape}) (got ${shown(spec)})`);
  }
  const { baseDelayMs, multiplier = 2, jitter = 'none', random = Math.random } = spec;
  checkNumber('exponentialBackoff: baseDelayMs', baseDelayMs, 0, 'a finite number >= 0');
  checkNumber('exponentialBackoff: multiplier', multiplier, 1, 'a finite number >= 1');
  if (!JITTERS.includes(jitter)) {
    throw new RangeError(`exponentialBackoff: jitter must be 'none', 'equal' or 'full' (got ${shown(jitter)})`);
  }
  if (typeof random !== 'function') {
    throw new TypeError(`exponentialBackoff: random must be a function answering in [0, 1] (got ${shown(random)})`);
  }
  return { baseDelayMs, multiplier, jitter, random };
}

/** A finite number >= `min`, or the error that names `field`: a `TypeError` for a non-number, else a `RangeError`. */
function checkNumber(field: string, value: unknown, min: number, rule: string): void {
  if (typeof value !== 'number') throw new TypeError(`${field} must be ${rule} (got ${shown(value)})`);
  if (!Number.isFinite(value) || value < min) throw new RangeError(`${field} must be ${rule} (got ${shown(value)})`);
}

/** The attempt as a schedule step: its whole part, at least 1 (anything that is not a finite number reads as 1). */
function stepOf(attempt: unknown): number {
  return typeof attempt === 'number' && Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
}

/** `baseDelayMs × multiplier^(step − 1)`, saturating at {@link MAX_WAIT_MS}. */
function ceilingOf(baseDelayMs: number, multiplier: number, step: number): number {
  if (baseDelayMs === 0) return 0;
  const ceiling = baseDelayMs * multiplier ** (step - 1);
  return ceiling < MAX_WAIT_MS ? ceiling : MAX_WAIT_MS;
}

/** One draw from the random source, which must answer a number in [0, 1]. */
function draw(random: () => number): number {
  const r: unknown = random();
  if (typeof r !== 'number' || !(r >= 0 && r <= 1)) {
    throw new RangeError(`exponentialBackoff: random() must answer a number in [0, 1] (got ${shown(r)})`);
  }
  return r;
}

/** The wait `error` states, read once — none when the reader throws or answers anything but a finite number >= 0. */
function statedWaitOf(read: StatedWaitReader, error: unknown): number | undefined {
  let value: unknown;
  try {
    value = read(error);
  } catch {
    return undefined;
  }
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A value as an error message may show it: a number or a short string as itself, anything else by its type. */
function shown(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value.length > 32 ? `${value.slice(0, 32)}…` : value);
  return value === null ? 'null' : typeof value;
}
