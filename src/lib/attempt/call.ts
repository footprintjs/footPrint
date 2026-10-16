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
 * cut when the stage attempt is cut (a time limit, so `'timeout'`; a cancellation, so `'aborted'`); and an `ended`
 * signal that aborts when the attempt is over however it ended (it returned, threw, or its frame committed), so a
 * call never outlives it. Following the P1b fence:
 *   - the record of a call attempt cut BY its stage attempt's own abort lands — the cut is evidence;
 *   - any other record that arrives once the stage attempt is over is REFUSED: noted by name (`host.refused`), never
 *     kept, never fired; the call stops (its in-flight attempt is cut, a wait ends) and no further attempt of an
 *     outside call starts — and the library-made rejection of such an orphan never surfaces as an unhandled one;
 *   - a call never starts under a signal already aborted, nor past its deadline while that signal is still due (a
 *     busy event loop fires timers late): no attempt, no record — the host's signal is its ONE deadline source.
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
  /**
   * The call's series ({@link callSeries}) — asked once, only when the call starts, so a call refused before it
   * starts takes no ordinal and leaves no gap.
   */
  openSeries(): string;
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
   * Aborts when the attempt that makes the call is over — however it ended — and when its frame commits: the call
   * stops (its in-flight attempt is cut, a wait ends, no attempt follows) and its records are refused. No call
   * outlives the attempt that made it.
   */
  readonly ended?: AbortSignal;
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
  const now = host.now ?? Date.now;
  // Started under an aborted signal, or after the attempt that makes it ended: no attempt, no record.
  for (const signal of [hostSignal, host.ended]) if (signal?.aborted) return Promise.reject(signal.reason);
  const stop = new AbortController();
  // ONE deadline source. A host's signal aborts at the host's deadline (its attempt's cap, or the run's deadline),
  // so a second timer for the same instant could only race it — and, firing first, end the call with a reason of
  // its own and fail the stage instead of timing it out. A host with a deadline and no signal gets the one timer.
  const own =
    hostSignal === undefined
      ? armDeadline(undefined, host.deadline, lateCallMessage(target, undefined, 'ran out of time'), now)
      : undefined;
  const composed = anySignal([hostSignal, host.ended, own?.signal, stop.signal]);
  // An orphan — a call still running when the attempt that made it ended — is stopped by the library, so its
  // rejection must not surface as an unhandled one; whoever awaits it still gets it.
  let result: Promise<T> | undefined;
  const quiet = () => {
    result?.catch(() => undefined);
  };
  host.ended?.addEventListener('abort', quiet, { once: true });
  const release = () => {
    host.ended?.removeEventListener('abort', quiet);
    own?.dispose();
    composed.dispose();
  };
  if (composed.signal.aborted) {
    release();
    return Promise.reject(composed.signal.reason);
  }
  // Past the deadline while its signal is still due (a busy event loop fires timers late): nothing is sent — the
  // call ends, with no record, when that signal aborts.
  if (host.deadline !== undefined && now() >= host.deadline) {
    result = new Promise<T>((_resolve, reject) => {
      composed.signal.addEventListener(
        'abort',
        () => {
          release();
          reject(composed.signal.reason);
        },
        { once: true },
      );
    });
    return result;
  }

  const seriesName = host.openSeries();
  /** Call attempts ended BY the stage attempt's end — their records are the evidence of the cut. */
  const cut = new Set<number>();
  const ended = () => new Error(lateCallMessage(target, seriesName, 'cannot continue'));
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
      series: seriesName,
      kind: 'call',
      target,
      signal: composed.signal,
      ...(host.deadline !== undefined && { deadline: host.deadline }),
      now,
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
  result = series.finally(release);
  return result;
}

/** Why a call stopped or could not go on — its target and series are names; no value is in the message. */
function lateCallMessage(target: string, series: string | undefined, what: string): string {
  return (
    `[footprint] $call "${target}"${series === undefined ? '' : ` (${series})`} ${what}: the attempt that made this ` +
    'call has ended — no further attempt of it starts, and nothing it records lands on the stage.'
  );
}
