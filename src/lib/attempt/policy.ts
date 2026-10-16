/**
 * attempt/policy.ts — the ONE reading of a `RetryPolicy`'s ceiling, and the ONE rule for a valid policy.
 *
 * `attemptCeiling` is how many attempts a policy allows. Three readers ask it, so they can never disagree about a
 * stage: the engine's gate (`FlowchartTraverser · executeStage` — does this stage retry at all?), the runner
 * (`runAttempts` — every record's `of`) and the rule table (`retryRules` — rule 4's threshold).
 *
 * `retryPolicyProblem` says why a declared policy is refused. Two doors ask it, with the same words: the builder
 * at build (`FlowChartBuilder · applyRetryPolicy`), and the traverser for a StageNode a stage returns at run time
 * (`FlowchartTraverser · admitDynamicNodes`), which the builder never saw.
 */

import type { RetryPolicy } from './types.js';

/**
 * The attempts a policy allows: its whole number (a fraction is floored, as the 9.15 loop read it), and never
 * fewer than one. Anything that is not a finite number of at least one — `NaN`, `Infinity`, `0`, a negative, a
 * non-number — is `1`: a broken ceiling never loops.
 */
export function attemptCeiling(attempts: unknown): number {
  const whole = typeof attempts === 'number' ? Math.floor(attempts) : NaN;
  return Number.isFinite(whole) && whole >= 1 ? whole : 1;
}

/**
 * Why `retry` is refused, or `undefined` when it is a valid policy: `attempts` must be a whole number ≥ 1, a
 * declared `timeoutMs` a finite number > 0, and a declared `maxBackoffMs` a finite number ≥ 0. `attempts: 1` is
 * valid on purpose — a policy declared but switched off (or, with a `timeoutMs`, a timeout with no retry).
 */
export function retryPolicyProblem(
  retry: Pick<RetryPolicy, 'attempts' | 'timeoutMs' | 'maxBackoffMs'>,
): string | undefined {
  const { attempts, timeoutMs, maxBackoffMs } = retry;
  if (!(typeof attempts === 'number' && Number.isInteger(attempts) && attempts >= 1)) {
    return (
      `retry.attempts must be a whole number >= 1 (got ${String(attempts)}). ` +
      'It counts TOTAL runs including the first, so `attempts: 3` means one run plus up to two retries; ' +
      '`attempts: 1` means the policy is declared but currently off.'
    );
  }
  if (timeoutMs !== undefined && attemptTimeoutMs(timeoutMs) === undefined) {
    return (
      `retry.timeoutMs must be a finite number of milliseconds > 0 (got ${String(timeoutMs)}). ` +
      'It caps ONE attempt; leave it out for an uncapped attempt.'
    );
  }
  if (maxBackoffMs !== undefined && backoffCeilingMs(maxBackoffMs) === undefined) {
    return (
      `retry.maxBackoffMs must be a finite number of milliseconds >= 0 (got ${String(maxBackoffMs)}). ` +
      'It caps every wait between attempts; leave it out for an uncapped wait.'
    );
  }
  return undefined;
}

/**
 * The ceiling a policy puts on ONE wait (`maxBackoffMs`): a finite number ≥ 0, else none. The runner caps every
 * wait at it (`waitAfter`), and the static budget check counts each wait at it — one reading, so the check's bound
 * is the runner's law.
 */
export function backoffCeilingMs(maxBackoffMs: unknown): number | undefined {
  return typeof maxBackoffMs === 'number' && Number.isFinite(maxBackoffMs) && maxBackoffMs >= 0
    ? maxBackoffMs
    : undefined;
}

/** A wait the policy's `backoffMs` answered (already defended, `resolveBackoffMs`), capped at its declared ceiling. */
export function cappedWaitMs(waitMs: number, maxBackoffMs: unknown): number {
  const ceiling = backoffCeilingMs(maxBackoffMs);
  return ceiling === undefined ? waitMs : Math.min(waitMs, ceiling);
}

/**
 * The cap a policy puts on one attempt: a finite number > 0, else none. The one reading the engine's gate and the
 * runner share (the builder refuses any other declared value, `retryPolicyProblem`).
 */
export function attemptTimeoutMs(timeoutMs: unknown): number | undefined {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined;
}

/** The policy of a call made with none: one attempt — still recorded (a single call is evidence too). */
export const SINGLE_CALL: RetryPolicy = Object.freeze({ attempts: 1 });

/**
 * A `$call` / `attempt()` policy as the caller handed it: absent means {@link SINGLE_CALL}; anything else must be a
 * valid `RetryPolicy` (`retryPolicyProblem`) or it is refused with a `TypeError` naming `where` — at the call,
 * before anything runs.
 */
export function admitCallPolicy(where: string, policy: unknown): RetryPolicy {
  if (policy === undefined) return SINGLE_CALL;
  if (policy === null || typeof policy !== 'object') {
    throw new TypeError(
      `${where}: the policy must be a RetryPolicy object ({ attempts, timeoutMs?, backoffMs?, retryOn? })`,
    );
  }
  const problem = retryPolicyProblem(policy as RetryPolicy);
  if (problem !== undefined) throw new TypeError(`${where}: ${problem}`);
  return policy as RetryPolicy;
}
