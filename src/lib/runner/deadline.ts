/**
 * runner/deadline.ts — `armRun`: the run's ONE effective signal and its deadline (design §3.1, P1b).
 *
 * A run has three ways to be told to stop — `RunOptions.signal`, `env.signal`, and a deadline (`RunOptions.deadline`,
 * `now + RunOptions.timeoutMs`, or `env.deadline`; the earliest wins). Before 10.1 they did not compose: `timeoutMs`
 * was ignored beside a `signal`, and `env.signal` was readable but never raced. `armRun` composes all of them into
 * one signal the traverser races (and hands every subflow), and stamps the env a stage reads:
 *
 *   env.deadline = the deadline (epoch ms)      env.signal = the one composed signal
 *
 * — but only when there is something to stamp AND somewhere it was already going: a deadline always gives the run
 * an env; a signal is stamped onto an env the caller gave. A run with no deadline and no env keeps no env, so a
 * stage's `$getEnv()` stays `{}` and its commit carries no `'env'` mark — byte-identical to 10.0.
 *
 * At the deadline the signal aborts with a BRANDED reason (`attempt/deadline.ts`) carrying the message a run with
 * `timeoutMs` always rejected with, so the attempt runner reads it as "out of time" (`timeout` / `no-time-left`),
 * never as a cancellation.
 */

import { anySignal } from '../attempt/anySignal.js';
import { deadlineReason, isAbortSignal, readDeadline, setLongTimeout } from '../attempt/deadline.js';
import type { ExecutionEnv } from '../engine/types.js';

/** What `armRun` reads — the run's own options. */
export interface RunTiming {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly deadline?: number;
  readonly env?: ExecutionEnv;
}

/** The armed run: the signal the traverser races, the env stages read, and the one call that releases both. */
export interface ArmedRun {
  readonly signal: AbortSignal | undefined;
  readonly env: ExecutionEnv | undefined;
  /** The run's deadline, epoch ms — absent without one. */
  readonly deadline: number | undefined;
  /** Clear the deadline timer and remove every listener composition added. Idempotent. */
  dispose(): void;
}

/** Compose the run's signal and deadline from its options; `now` is the clock (epoch ms). */
export function armRun(timing: RunTiming, now: () => number = Date.now): ArmedRun {
  const startedAt = now();
  // Each input read ONCE: a getter on the env cannot stamp a deadline that was never armed.
  const env = timing.env;
  const envDeadline = env?.deadline;
  const envSignal = env?.signal;
  const deadline = earliestDeadline(timing, envDeadline, startedAt);

  const controller = deadline !== undefined ? new AbortController() : undefined;
  // `env.signal` was readable-only before 10.1: a value that is not a signal is still only readable, never raced.
  const sources = [timing.signal, isAbortSignal(envSignal) ? envSignal : undefined, controller?.signal].filter(
    (s): s is AbortSignal => s !== undefined,
  );
  // One source is used as it is (the caller's own signal, untouched); two or more are composed. Composed BEFORE
  // the timer is armed, so a composition that throws leaves no timer behind.
  const composed = sources.length > 1 ? anySignal(sources) : undefined;
  const signal = composed?.signal ?? sources[0];

  let cancelTimer: (() => void) | undefined;
  if (controller !== undefined && deadline !== undefined) {
    const reason = deadlineReason(deadlineMessage(timing, deadline, startedAt));
    const left = deadline - startedAt;
    if (left <= 0) controller.abort(reason);
    else cancelTimer = setLongTimeout(() => controller.abort(reason), left);
  }

  let disposed = false;
  return {
    signal,
    env: stampedEnv(env, envSignal, signal, deadline),
    deadline,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelTimer?.();
      composed?.dispose();
    },
  };
}

/** The earliest valid deadline of the three inputs. `timeoutMs` 0 (or not finite) arms nothing, as it never did. */
function earliestDeadline(timing: RunTiming, envDeadline: unknown, startedAt: number): number | undefined {
  const fromTimeout =
    typeof timing.timeoutMs === 'number' && Number.isFinite(timing.timeoutMs) && timing.timeoutMs !== 0
      ? startedAt + timing.timeoutMs
      : undefined;
  const candidates = [readDeadline(timing.deadline), fromTimeout, readDeadline(envDeadline)].filter(
    (d): d is number => d !== undefined,
  );
  return candidates.length > 0 ? Math.min(...candidates) : undefined;
}

/** The deadline's message: `timeoutMs`'s historical one when it set the deadline, else the deadline's own. */
function deadlineMessage(timing: RunTiming, deadline: number, startedAt: number): string {
  if (typeof timing.timeoutMs === 'number' && startedAt + timing.timeoutMs === deadline) {
    return `Execution timed out after ${timing.timeoutMs}ms`;
  }
  return `Execution passed its deadline (${deadline} epoch ms)`;
}

/** The env stages read: the caller's, plus the deadline and the one signal — only where there is one to stamp. */
function stampedEnv(
  env: ExecutionEnv | undefined,
  envSignal: unknown,
  signal: AbortSignal | undefined,
  deadline: number | undefined,
): ExecutionEnv | undefined {
  const hasEnv = env !== undefined && Object.keys(env).length > 0;
  if (deadline === undefined && (!hasEnv || signal === undefined || envSignal === signal)) return env;
  return {
    ...env,
    ...(signal !== undefined && { signal }),
    ...(deadline !== undefined && { deadline }),
  };
}
