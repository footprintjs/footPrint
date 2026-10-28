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
 *   exponentialBackoff({ baseDelayMs, multiplier = 2, maxDelayMs?, jitter = 'none', random = Math.random })
 *     the wait after failed attempt n, under its ceiling c = min(maxDelayMs, baseDelayMs × multiplier^(n − 1)):
 *       'none'  → c                   deterministic: `random` is never called
 *       'equal' → c/2 + r × c/2       half fixed, half random (r = random(), in [0, 1])
 *       'full'  → r × c
 *   statedWaitFirst(readStatedWaitMs, inner)
 *     a wait the outside system STATED (a `Retry-After`, read off the error) wins; otherwise `inner` decides.
 *
 * TWO CAPS, two jobs:
 *   - `BackoffSpec.maxDelayMs` caps the SCHEDULE: it bounds the ceiling BEFORE the draw, so a capped schedule keeps its
 *     jitter. Capping after the draw instead would flatten every jittered wait to one constant once the schedule
 *     passes twice the cap — a fleet would retry in lockstep, which is what jitter is for preventing.
 *   - `RetryPolicy.maxBackoffMs` caps EVERY wait, a stated one included, after the draw; the runner enforces it and the
 *     static time budget counts a function backoff at it without calling it.
 * A stated wait is never capped by the inner schedule's `maxDelayMs` — only `maxBackoffMs` and the deadline bound it.
 * Without `maxDelayMs` a ceiling saturates at `Number.MAX_SAFE_INTEGER` ms, so no attempt makes a wait `Infinity`.
 *
 * THE SERVER CHOOSES A STATED WAIT. `statedWaitFirst` hands the wait to the outside system — a broken or hostile one
 * can ask for an hour. Whenever the wait comes from the server, declare the policy's `maxBackoffMs` (the runner caps
 * every wait at it) or run under a deadline (the runner stops a series whose wait would outlast it).
 *
 * Refused when built — by the field's name and the shape it needs, NEVER the value it was given (a field can hold a
 * secret): a `TypeError` for a wrong type (`'100'` included), a `RangeError` for a number out of range. The rules: a
 * `baseDelayMs` that is a finite number >= 0, a `multiplier` >= 1, a `maxDelayMs` >= `baseDelayMs`, a `jitter` of the
 * three names, a `random` or a reader that is a function, an `inner` that is a function or a finite number >= 0.
 *
 * A DRAW IS NOT TRUSTED BLINDLY: a `random()` that answers anything but a number in [0, 1] — or throws — makes that
 * wait the ceiling `c`, the longest the schedule allows. Never 0: a broken source cannot make every jittered retry
 * fire at once. The default source is `Math.random`, looked up at each draw (so a spy installed later takes effect).
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
  /**
   * The most a ceiling may grow to, in milliseconds — a finite number >= `baseDelayMs`. It caps the SCHEDULE before
   * the jitter is drawn, so waits at the cap still spread (`'equal'` between `maxDelayMs / 2` and `maxDelayMs`). It
   * is not `RetryPolicy.maxBackoffMs`, which caps every wait after the draw, a stated one included. Absent: the
   * ceiling grows until it saturates at `Number.MAX_SAFE_INTEGER`.
   */
  readonly maxDelayMs?: number;
  /** How much of each wait is random. Default `'none'`: the wait IS the ceiling. */
  readonly jitter?: BackoffJitter;
  /**
   * The jitter's random source, answering in [0, 1]. Default `Math.random`, looked up at each draw; a fixed one makes a
   * test exact. A draw outside [0, 1] (or a throw) makes that wait the ceiling — never 0.
   */
  readonly random?: () => number;
}

/** A `RetryPolicy.backoffMs` function: the wait in milliseconds after failed attempt `attempt` (1-based). */
export type BackoffFunction = (attempt: number, error?: unknown) => number;

/** Reads the wait an error states (a parsed `Retry-After`), in milliseconds, or `undefined` when it states none. */
export type StatedWaitReader = (error: unknown) => number | undefined;

const JITTERS: readonly BackoffJitter[] = ['none', 'equal', 'full'];

/** Where a ceiling saturates: a wait is never `Infinity` and never `NaN`. */
const MAX_WAIT_MS = Number.MAX_SAFE_INTEGER;

/** The default random source: `Math.random`, looked up at each draw — so a spy installed after building takes effect. */
const drawMathRandom = (): number => Math.random();

/**
 * A `RetryPolicy.backoffMs` function for an exponential schedule: the wait after failed attempt `n` is drawn under the
 * ceiling `min(maxDelayMs, baseDelayMs × multiplier^(n − 1))` by the declared jitter — the schedule is capped BEFORE
 * the draw, so it keeps its spread. The policy's `maxBackoffMs` still caps every wait after it.
 *
 * @example
 * ```ts
 * .retry({ attempts: 6, backoffMs: exponentialBackoff({ baseDelayMs: 200, maxDelayMs: 2_000, jitter: 'equal' }), maxBackoffMs: 5_000 })
 * ```
 */
export function exponentialBackoff(spec: BackoffSpec): BackoffFunction {
  const { baseDelayMs, multiplier, maxDelayMs, jitter, random } = readSpec(spec);
  return (attempt: number): number => {
    const ceiling = ceilingOf(baseDelayMs, multiplier, maxDelayMs, stepOf(attempt));
    if (jitter === 'none') return ceiling;
    const r = draw(random);
    // An untrusted draw waits the ceiling — never 0, so a broken source cannot fire every jittered retry at once.
    if (r === undefined) return ceiling;
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
 * The outside system chooses this wait, and a broken or hostile one can ask for an hour: whenever the wait comes from
 * the server, declare the policy's `maxBackoffMs` (or run under a deadline).
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
    throw new TypeError('statedWaitFirst: readStatedWaitMs must be a function');
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
    throw new TypeError(
      'exponentialBackoff: the spec must be an object ({ baseDelayMs, multiplier?, maxDelayMs?, jitter?, random? })',
    );
  }
  const { baseDelayMs, multiplier = 2, maxDelayMs, jitter = 'none', random = drawMathRandom } = spec;
  checkNumber('exponentialBackoff: baseDelayMs', baseDelayMs, 0, 'a finite number >= 0');
  checkNumber('exponentialBackoff: multiplier', multiplier, 1, 'a finite number >= 1');
  // At least the base: a cap below it would make every wait the cap — a fixed schedule written as an exponential one.
  if (maxDelayMs !== undefined) {
    checkNumber('exponentialBackoff: maxDelayMs', maxDelayMs, baseDelayMs, 'a finite number >= baseDelayMs');
  }
  const jitterRule = "exponentialBackoff: jitter must be 'none', 'equal' or 'full'";
  if (typeof jitter !== 'string') throw new TypeError(jitterRule);
  if (!JITTERS.includes(jitter)) throw new RangeError(jitterRule);
  if (typeof random !== 'function') {
    throw new TypeError('exponentialBackoff: random must be a function answering a number in [0, 1]');
  }
  return { baseDelayMs, multiplier, maxDelayMs: maxDelayMs ?? MAX_WAIT_MS, jitter, random };
}

/**
 * A finite number >= `min`, or the error that names `field` and the shape it needs — never the value it was given (a
 * field can hold a secret): a `TypeError` for a non-number, a `RangeError` for a number out of range.
 */
function checkNumber(field: string, value: unknown, min: number, rule: string): void {
  if (typeof value !== 'number') throw new TypeError(`${field} must be ${rule}`);
  if (!Number.isFinite(value) || value < min) throw new RangeError(`${field} must be ${rule}`);
}

/** The attempt as a schedule step: its whole part, at least 1 (anything that is not a finite number reads as 1). */
function stepOf(attempt: unknown): number {
  return typeof attempt === 'number' && Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
}

/**
 * `min(maxDelayMs, baseDelayMs × multiplier^(step − 1))` — the schedule's cap, applied BEFORE any jitter is drawn
 * (`maxDelayMs` is {@link MAX_WAIT_MS} when none was declared, so the ceiling saturates rather than overflows).
 */
function ceilingOf(baseDelayMs: number, multiplier: number, maxDelayMs: number, step: number): number {
  if (baseDelayMs === 0) return 0;
  const ceiling = baseDelayMs * multiplier ** (step - 1);
  return ceiling < maxDelayMs ? ceiling : maxDelayMs;
}

/**
 * One draw from the random source: a number in [0, 1] (`-0` reads as `0`), or `undefined` when the source answers
 * anything else or throws — an untrusted draw, which the caller turns into the ceiling.
 */
function draw(random: () => number): number | undefined {
  let r: unknown;
  try {
    r = random();
  } catch {
    return undefined;
  }
  if (typeof r !== 'number' || !(r >= 0 && r <= 1)) return undefined;
  return r === 0 ? 0 : r;
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
