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
 * Why `retry` is refused, or `undefined` when it is a valid policy: `attempts` must be a whole number ≥ 1.
 * `attempts: 1` is valid on purpose — a policy declared but switched off.
 */
export function retryPolicyProblem(retry: Pick<RetryPolicy, 'attempts'>): string | undefined {
  const { attempts } = retry;
  if (typeof attempts === 'number' && Number.isInteger(attempts) && attempts >= 1) return undefined;
  return (
    `retry.attempts must be a whole number >= 1 (got ${String(attempts)}). ` +
    'It counts TOTAL runs including the first, so `attempts: 3` means one run plus up to two retries; ' +
    '`attempts: 1` means the policy is declared but currently off.'
  );
}
