/** Shared English sentence bodies, with no event capture or recorder state. */
import type { AttemptRecord } from '../../../attempt/types.js';
import type { ValidationIssue } from '../../../schema/errors.js';
import type {
  BreakRenderContext,
  DecisionRenderContext,
  ErrorRenderContext,
  ForkRenderContext,
  LoopRenderContext,
  StageRenderContext,
} from '../narrativeTypes.js';
import type { FlowResumeEvent } from '../types.js';

export function nextStageSentence(ctx: Pick<StageRenderContext, 'stageName' | 'description'>): string {
  return ctx.description ? `Next step: ${ctx.description}.` : `Next, it moved on to ${ctx.stageName}.`;
}

/** Evidence takes precedence at the Combined recorder; this is only its fallback. */
export function decisionSentence(ctx: Pick<DecisionRenderContext, 'chosen' | 'description' | 'rationale'>): string {
  const branchName = ctx.chosen;
  if (ctx.description && ctx.rationale) {
    return `It ${ctx.description}: ${ctx.rationale}, so it chose ${branchName}.`;
  }
  if (ctx.description) return `It ${ctx.description} and chose ${branchName}.`;
  if (ctx.rationale) return `A decision was made: ${ctx.rationale}, so the path taken was ${branchName}.`;
  return `A decision was made, and the path taken was ${branchName}.`;
}

export function forkSentence(ctx: ForkRenderContext): string {
  const names = ctx.children.join(', ');
  return `Forking into ${ctx.children.length} parallel paths: ${names}.`;
}

export function loopSentence(ctx: LoopRenderContext): string {
  return ctx.description
    ? `On pass ${ctx.iteration}: ${ctx.description} again.`
    : `On pass ${ctx.iteration} through ${ctx.target}.`;
}

export function breakSentence(ctx: BreakRenderContext): string {
  return `Execution stopped at ${ctx.stageName}.`;
}

export function pauseSentence(ctx: Pick<BreakRenderContext, 'stageName'>): string {
  return `Execution paused at ${ctx.stageName}.`;
}

export function resumeSentence(ctx: Pick<FlowResumeEvent, 'stageName' | 'hasInput'>): string {
  const suffix = ctx.hasInput ? ' with input.' : '.';
  return `Execution resumed at ${ctx.stageName}${suffix}`;
}

export function validationDetails(issues: readonly ValidationIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

export function errorSentence(ctx: Pick<ErrorRenderContext, 'stageName' | 'message'>): string {
  return `An error occurred at ${ctx.stageName}: ${ctx.message}.`;
}

/** Callers retain their distinct rules for whether to display empty details. */
export function validationSentence(details: string): string {
  return ` Validation issues: ${details}.`;
}

/**
 * Whether the narrative tells an attempt (P1b). A STAGE series of ONE attempt — a stage run on the attempt runner
 * only because of a `timeoutMs` or the run's deadline — that succeeded or paused says nothing the stage's own line
 * does not, so it is not told (its record is still on the tree and the hook). Every other attempt is — every call
 * and every observed attempt too (P2): the stage's own line never mentions them.
 */
export function isAttemptTold(record: AttemptRecord): boolean {
  return record.kind !== 'stage' || record.of !== 1 || (record.outcome !== 'ok' && record.outcome !== 'paused');
}

/**
 * One attempt of a retried stage, as one sentence (10.1): its outcome and duration, the cause of a failure
 * (`category: message`, the category left out when it is `unknown`), and the decision — the wait before a retry,
 * or why the series stopped. The error is the record's SERVED message, so a redacted error reads redacted here.
 * Under a run deadline the decision also says the time left (P1b).
 *
 *   Attempt 1 of 3 at Fetch rate failed in 812ms (rate-limited: 429), retrying in 4s.
 *   Attempt 3 of 3 at Fetch rate succeeded in 31ms.
 *   Attempt 1 of 4 at Charge card failed in 120ms (permanent: card declined); stopped: retryOn declined.
 *   Attempt 2 of 3 at Fetch rate timed out after 40s, retrying in 2s (70s left).
 *   Attempt 2 of 4 at Charge card timed out after 20s; stopped: no time left (300ms left, next wait 2s).
 */
export function attemptSentence(stageName: string, record: AttemptRecord): string {
  if (record.kind === 'call') return callSentence(record);
  if (record.kind === 'observed') return observedSentence(record);
  const ceiling = record.of !== undefined ? ` of ${record.of}` : '';
  return `Attempt ${record.attempt}${ceiling} at ${stageName} ${attemptOutcome(record)}${effectClause(
    record,
  )}${attemptDecision(record)}.`;
}

/**
 * One attempt of a call a stage made (`scope.$call`, P2), by its target — a single call (`attempts: 1`) says only
 * how it went, since "attempt 1 of 1" and "no attempts left" add nothing:
 *
 *   Call inventory.lookup succeeded in 12ms.
 *   Call stripe.quotes.create, attempt 1 of 3, failed in 812ms (rate-limited: 429), retrying in 4s.
 */
function callSentence(record: AttemptRecord): string {
  const target = record.target ?? 'call';
  if (record.of === 1) {
    const decision = record.reason === 'exhausted' ? '' : attemptDecision(record);
    return `Call ${target} ${attemptOutcome(record)}${effectClause(record)}${decision}.`;
  }
  const ceiling = record.of !== undefined ? ` of ${record.of}` : '';
  return `Call ${target}, attempt ${record.attempt}${ceiling}, ${attemptOutcome(record)}${effectClause(
    record,
  )}${attemptDecision(record)}.`;
}

/**
 * One attempt an outside system ran on its own, as its adapter reported it (`observed()`, P2). No decision clause:
 * the system decided what followed, not the library.
 *
 *   Observed: the stripe SDK made attempt 2 of 3, failed in 600ms (server: busy).
 */
function observedSentence(record: AttemptRecord): string {
  const who =
    record.source === undefined || record.source === 'sdk'
      ? `the ${record.target ?? 'outside'} SDK`
      : `${record.target ?? 'outside'} (${record.source})`;
  const ceiling = record.of !== undefined ? ` of ${record.of}` : '';
  return `Observed: ${who} made attempt ${record.attempt}${ceiling}, ${attemptOutcome(record)}.`;
}

function attemptOutcome(record: AttemptRecord): string {
  const took = formatDuration(record.durationMs);
  switch (record.outcome) {
    case 'ok':
      return `succeeded in ${took}`;
    case 'timeout':
      return `timed out after ${took}`;
    case 'paused':
      return `paused after ${took}`;
    case 'aborted':
      return `was aborted after ${took}${record.error ? ` (${record.error.message})` : ''}`;
    default:
      return `failed in ${took}${attemptCause(record)}`;
  }
}

/**
 * A touching attempt whose effect is unknown says so (P3) — the outcome alone ("failed", "timed out") would read as
 * "nothing happened", and nothing may be retried blindly on that reading. `applied` and `none` add nothing the
 * outcome does not say. Absent on a target that touches nothing (byte identity).
 *
 *   Attempt 2 of 2 at Charge card timed out after 20s, effect on stripe unknown; stopped: no attempts left.
 */
function effectClause(record: AttemptRecord): string {
  return record.effect === 'unknown' && record.system !== undefined ? `, effect on ${record.system} unknown` : '';
}

function attemptCause(record: AttemptRecord): string {
  if (!record.error) return '';
  const category = record.category && record.category !== 'unknown' ? `${record.category}: ` : '';
  return ` (${category}${record.error.message})`;
}

function attemptDecision(record: AttemptRecord): string {
  if (record.next === 'retry') {
    const left = record.timeLeftMs !== undefined ? ` (${formatDuration(Math.max(0, record.timeLeftMs))} left)` : '';
    return (record.delayMs ? `, retrying in ${formatDuration(record.delayMs)}` : ', retrying immediately') + left;
  }
  if (record.next === 'done') return '';
  switch (record.reason) {
    case 'exhausted':
      return '; stopped: no attempts left';
    case 'declined':
      // A throwing predicate is "do not retry" too — but it is a broken predicate, not a verdict.
      return record.retryOnThrew ? '; stopped: retryOn threw' : '; stopped: retryOn declined';
    case 'no-time-left': {
      const facts = [
        ...(record.timeLeftMs !== undefined ? [`${formatDuration(Math.max(0, record.timeLeftMs))} left`] : []),
        ...(record.delayMs !== undefined ? [`next wait ${formatDuration(record.delayMs)}`] : []),
      ];
      return `; stopped: no time left${facts.length > 0 ? ` (${facts.join(', ')})` : ''}`;
    }
    case 'aborted':
      // An attempt that threw the abort's own reason already says it ("was aborted"); an attempt that failed on
      // its own while the run aborted says its failure, then why the series stopped.
      return record.outcome === 'aborted' ? '' : '; stopped: the run was aborted';
    case 'paused':
      // The outcome already says it.
      return '';
    default:
      return `; stopped: ${record.reason}`;
  }
}

/** A duration as the narrative says it: whole milliseconds under a second, seconds (one decimal at most) above. */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  return `${Number((ms / 1_000).toFixed(1))}s`;
}
