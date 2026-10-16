/**
 * attempt/call.ts — a call made INSIDE a stage attempt: `scope.$call(target, fn, policy?)` (design §3.6, §3.8,
 * packet P2).
 *
 * The same loop as a stage's retry (`runAttempts`, law 1), kind `'call'`, its `target` on every record — and a
 * record even for a single call (`attempts: 1`): timing and outcome evidence with no retry. Its series is the
 * call level of foottrace's attempt-id grammar ({@link callSeries}).
 *
 * THE LAW — a call lives within the attempt that made it. The host (the stage's scope) hands it that attempt's
 * signal and its end as the call's deadline, so the call is capped by the time its stage attempt has left, and is
 * cut when the stage attempt is cut (a time limit, so `'timeout'`; a cancellation, so `'aborted'`). Following the
 * P1b fence:
 *   - the record of a call attempt cut BY its stage attempt's end lands — the cut is evidence;
 *   - any other record that arrives once the stage attempt has ended (it threw while the call was in flight, or its
 *     frame committed) is REFUSED: noted by name (`host.refused`), never kept, never fired; and the series stops —
 *     no further attempt of an outside call starts after the attempt that made it is over;
 *   - a call never starts under a signal already aborted (the host's signal is its ONE deadline source, so past the
 *     deadline it has aborted): no attempt, no record.
 * What the call's function does after its attempt ended cannot be trapped — it should RETURN its answer, not write
 * the stage's scope (the scope's own fence still refuses a write from an ended stage attempt).
 *
 * A LEAF of the engine (L5): the host is a port, so nothing here names the scope.
 */

import type { StructuredErrorInfo } from '../errors/errorInfo.js';
import { anySignal } from './anySignal.js';
import { armDeadline } from './deadline.js';
import { runAttempts } from './runner.js';
import type { AttemptContext, AttemptRecord, ObservedAttempt, RetryPolicy } from './types.js';

/**
 * The series of the `ordinal`-th call (1-based) made during attempt `stageAttempt` of the stage execution
 * `runtimeStageId`: `<runtimeStageId>@<n>.<k>` — so the id of the call's attempt `m` is `<series>@<m>`, foottrace's
 * `buildAttemptId(runtimeStageId, n, { ordinal: k, attempt: m })` (design §3.4). Written here, in this one place,
 * until the engine adopts foottrace 1.1.0's codec (P6); the bytes are the grammar's.
 */
export function callSeries(runtimeStageId: string, stageAttempt: number, ordinal: number): string {
  return `${runtimeStageId}@${stageAttempt}.${ordinal}`;
}

/** What the attempt that makes a call gives it — the scope implements it. */
export interface CallHost {
  /** The call's series ({@link callSeries}). */
  readonly series: string;
  /**
   * The stage attempt's signal: the run's cancellation, the run's deadline and the attempt's own cap. When given, it
   * is the call's ONE deadline source — it must abort at {@link deadline}, with a time-limit reason
   * (`deadline.ts · markTimeLimit` / `deadlineReason`); the call arms no timer of its own.
   */
  readonly signal?: AbortSignal;
  /**
   * When the stage attempt must end, epoch ms — the call's deadline, capping each attempt by the time left. Absent
   * for an uncapped attempt. Without a {@link signal}, the call arms the one timer that ends it here.
   */
  readonly deadline?: number;
  /** The clock (default `Date.now`). */
  readonly now?: () => number;
  /**
   * May a record of the call land on the stage now? `cut`: the call attempt was ended BY the stage attempt's own
   * end, so its record is the evidence of that cut.
   */
  admits(cut: boolean): boolean;
  /** The served form of an attempt's error — the run's redaction rule. */
  serve(error: unknown): StructuredErrorInfo;
  /** A record that may land: onto the stage, and the run's `onAttempt`. */
  report(record: AttemptRecord, structuredError: StructuredErrorInfo | undefined): void;
  /** A record that may not — the call outlived the attempt that made it. A name is noted; nothing is kept. */
  refused(): void;
  /** An observed report made through the call's own attempt context (`ended`: that call attempt was over). */
  observe(report: ObservedAttempt, at: { readonly attempt: number; readonly ended: boolean }): void;
}

/**
 * Run `fn` as the call `target` under `policy` (already admitted — `policy.ts · admitCallPolicy`) for `host`.
 * Resolves with the answer, or rejects with the last attempt's own error.
 */
export function runCall<T>(
  target: string,
  fn: (attempt: AttemptContext) => Promise<T> | T,
  policy: RetryPolicy,
  host: CallHost,
): Promise<T> {
  const hostSignal = host.signal;
  // Started under an aborted signal: no attempt starts, nothing is recorded — the caller learns why.
  if (hostSignal?.aborted) return Promise.reject(hostSignal.reason);
  const stop = new AbortController();
  // ONE deadline source. A host's signal aborts at the host's deadline (its attempt's cap, or the run's deadline),
  // so a second timer for the same instant could only race it — and, firing first, end the call with a reason of
  // its own and fail the stage instead of timing it out. A host with a deadline and no signal gets the one timer.
  const own =
    hostSignal === undefined
      ? armDeadline(undefined, host.deadline, lateCallMessage(target, host.series, 'ran out of time'), host.now)
      : undefined;
  const composed = anySignal([hostSignal, own?.signal, stop.signal]);
  const release = () => {
    own?.dispose();
    composed.dispose();
  };
  if (composed.signal.aborted) {
    release();
    return Promise.reject(composed.signal.reason);
  }

  /** Call attempts ended BY the stage attempt's end — their records are the evidence of the cut. */
  const cut = new Set<number>();
  const ended = () => new Error(lateCallMessage(target, host.series, 'cannot continue'));
  const series = runAttempts<T>(
    (_attempt, context) => {
      // The attempt that made this call is over: no further attempt of an outside call starts.
      if (!host.admits(false)) {
        const reason = ended();
        stop.abort(reason);
        throw reason;
      }
      return fn(context);
    },
    policy,
    {
      series: host.series,
      kind: 'call',
      target,
      signal: composed.signal,
      ...(host.deadline !== undefined && { deadline: host.deadline }),
      ...(host.now !== undefined && { now: host.now }),
      serve: (error) => host.serve(error),
      // Synchronous at the abort: the stage attempt's signal aborting is what cut this call attempt.
      onAbandon: (attempt) => {
        if (hostSignal?.aborted) cut.add(attempt);
      },
      onAttempt: (record, structuredError) => {
        if (host.admits(cut.has(record.attempt))) {
          host.report(record, structuredError);
          return;
        }
        host.refused();
        // Nothing follows a refused record: a wait ends now and the series stops `aborted`.
        if (!stop.signal.aborted) stop.abort(ended());
      },
      observe: (report, at) => host.observe(report, at),
    },
  );
  return series.finally(release);
}

/** Why a call stopped or could not go on — its target and series are names; no value is in the message. */
function lateCallMessage(target: string, series: string, what: string): string {
  return (
    `[footprint] $call "${target}" (${series}) ${what}: the attempt that made this call has ended — no further ` +
    'attempt of it starts, and nothing it records lands on the stage.'
  );
}
