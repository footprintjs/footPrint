/**
 * attempt/standalone.ts — `attempt(fn, policy?, options?)`: the attempt runner with no scope and no run (design §3.6,
 * packet P2).
 *
 * The same loop, the same record (law 1) for code that is not a stage — a provider decorator, a client wrapper, a
 * script. There is no run, so there is no execution tree and no hook: every record goes to `options.onAttempt`, the
 * caller's own, as each attempt ends. There is no redaction rule either: the record holds the error's named fields
 * (never the thrown value), and the caller's callback decides what to keep.
 *
 * Time and cancellation are the caller's: `deadline` caps every attempt by the time left (and a wait that would
 * outlast it is never started — `no-time-left`); `signal` cancels. A deadline already past, or a signal already
 * aborted, starts no attempt and records nothing.
 *
 * ```typescript
 * const res = await attempt((t) => fetch(url, { signal: t.signal }), { attempts: 3, timeoutMs: 5_000 }, {
 *   target: 'inventory.lookup',
 *   deadline: Date.now() + 20_000,
 *   onAttempt: (record) => log.info(record),
 * });
 * ```
 */

import { isDevMode } from '../devMode.js';
import { extractErrorInfo } from '../errors/errorInfo.js';
import { armDeadline, isAbortSignal } from './deadline.js';
import { admitAttemptName } from './name.js';
import { observedRecord, ObservedSeriesBook, readObservedReport } from './observed.js';
import { admitCallPolicy } from './policy.js';
import { runAttempts } from './runner.js';
import type { AttemptContext, AttemptRecord, ObservedAttempt, RetryPolicy } from './types.js';

const WHERE = 'attempt()';

/** How a standalone attempt series is named, timed and reported. */
export interface AttemptOptions {
  /** The outside target — a name from code (1–128 characters, no control character), stamped on every record. */
  readonly target?: string;
  /**
   * The series every record names — the caller's name for this one operation (an order id, a request id), so two
   * operations can be told apart. Default: the target, else `'attempt'`.
   */
  readonly series?: string;
  /** The deadline, epoch milliseconds: every attempt is capped by the time left before it. */
  readonly deadline?: number;
  /** Cancels the series: the attempt in flight is cut (`aborted`), a wait ends, and no attempt follows. */
  readonly signal?: AbortSignal;
  /**
   * Every attempt, at its end — the only place a standalone record goes. A throw from it is isolated: it never
   * changes the call's outcome (dev mode warns).
   */
  readonly onAttempt?: (record: AttemptRecord) => void;
}

/**
 * Run `fn` under `policy` (none = one attempt, still recorded) and resolve with its answer, or reject with the LAST
 * attempt's own error. `fn` gets the attempt's `AttemptContext`: pass `signal` to the work, read `timeLeftMs()`,
 * and report an SDK's own retries with `observed()`.
 */
export function attempt<T>(
  fn: (attempt: AttemptContext) => Promise<T> | T,
  policy?: RetryPolicy,
  options: AttemptOptions = {},
): Promise<T> {
  if (typeof fn !== 'function') throw new TypeError(`${WHERE}: fn must be a function`);
  const admitted = admitCallPolicy(WHERE, policy);
  const read = readOptions(options);
  const armed = armDeadline(
    read.signal,
    read.deadline,
    `${WHERE} passed its deadline (${String(read.deadline)} epoch ms)`,
  );
  if (armed.signal?.aborted) {
    armed.dispose();
    return Promise.reject(armed.signal.reason);
  }
  const deliver = (record: AttemptRecord) => {
    if (read.onAttempt === undefined) return;
    try {
      read.onAttempt(record);
    } catch (error) {
      if (isDevMode()) {
        // eslint-disable-next-line no-console
        console.warn(`[footprint] ${WHERE}: onAttempt threw; the record was still made`, error);
      }
    }
  };
  const observing = new ObservedOwner(read.series, deliver);
  return runAttempts<T>((_attempt, context) => fn(context), admitted, {
    series: read.series,
    kind: 'call',
    ...(read.target !== undefined && { target: read.target }),
    ...(armed.signal !== undefined && { signal: armed.signal }),
    ...(read.deadline !== undefined && { deadline: read.deadline }),
    onAttempt: (record) => deliver(record),
    observe: (report, at) => observing.observe(report, at),
  }).finally(() => armed.dispose());
}

/** The options as read: each once, validated (a `TypeError` naming the field). */
function readOptions(options: AttemptOptions): {
  target?: string;
  series: string;
  deadline?: number;
  signal?: AbortSignal;
  onAttempt?: (record: AttemptRecord) => void;
} {
  if (options === null || typeof options !== 'object') throw new TypeError(`${WHERE}: options must be an object`);
  const { target, series, deadline, signal, onAttempt } = options;
  const name = target === undefined ? undefined : admitAttemptName(WHERE, 'target', target);
  const named = series === undefined ? name ?? 'attempt' : admitAttemptName(WHERE, 'series', series);
  if (deadline !== undefined && (typeof deadline !== 'number' || Number.isNaN(deadline))) {
    throw new TypeError(`${WHERE}: deadline must be a number (epoch ms)`);
  }
  if (signal !== undefined && !isAbortSignal(signal)) throw new TypeError(`${WHERE}: signal must be an AbortSignal`);
  if (onAttempt !== undefined && typeof onAttempt !== 'function') {
    throw new TypeError(`${WHERE}: onAttempt must be a function`);
  }
  // `-Infinity` is a deadline long past (no attempt starts); `Infinity` is none.
  const at = deadline === -Infinity ? 0 : deadline;
  return {
    ...(name !== undefined && { target: name }),
    series: named,
    ...(at !== undefined && Number.isFinite(at) && { deadline: at }),
    ...(signal !== undefined && { signal }),
    ...(onAttempt !== undefined && { onAttempt }),
  };
}

/**
 * The observed reports of a standalone series: each attempt `m` opens its own call level, `<series>@<m>.<k>` — the
 * shape a stage attempt's calls have, rooted at the caller's series. A report after its attempt ended is dropped.
 */
class ObservedOwner {
  private current?: { readonly attempt: number; readonly book: ObservedSeriesBook };

  constructor(private readonly series: string, private readonly deliver: (record: AttemptRecord) => void) {}

  observe(report: ObservedAttempt, at: { readonly attempt: number; readonly ended: boolean }): void {
    const read = readObservedReport(report);
    // After its attempt ended: dropped, never thrown — an SDK's own callback may fire late, and an observed attempt
    // never changes control flow.
    if (at.ended) return;
    if (this.current?.attempt !== at.attempt) {
      let ordinal = 0;
      const prefix = `${this.series}@${at.attempt}`;
      this.current = { attempt: at.attempt, book: new ObservedSeriesBook(() => `${prefix}.${++ordinal}`) };
    }
    const { record } = observedRecord(read, {
      series: this.current.book.seriesFor(read),
      now: Date.now,
      // No run, no rule: the error's structured info (the record keeps its named fields only).
      serve: extractErrorInfo,
    });
    this.deliver(record);
  }
}
