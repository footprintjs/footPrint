/**
 * attempt/effect.ts — side-effect safety (design §3.3, packet P3): the ONE reading of what an attempt did to an
 * outside system, and the ONE rule for a touching target.
 *
 *   - `touchesProblem` — the build law, asked at every door a touching declaration enters: the builder
 *     (`FlowChartBuilder · applyTouches` / `applyRetryPolicy`), the traverser for a StageNode a stage returns at run
 *     time (`FlowchartTraverser · admitDynamicNodes`), and the stage itself (`FlowchartTraverser · executeStage`, for
 *     a chart edited after `build()`). A touching target that may retry without an idempotency key is refused: a
 *     retry of a non-idempotent effect without one can apply it twice.
 *   - `callTouches` — the same law for `scope.$call(target, fn, policy, { touches, idempotencyKey })`.
 *   - `admitIdempotencyKey` — the key's format: 1–255 printable ASCII characters, no space. It travels in a request
 *     header (`Idempotency-Key`), so a control character could forge one; the refusal names the field, never the
 *     value.
 *   - `effectOf` — `ok → 'applied'`; a failure whose error declares `effect: 'none'` → `'none'`; anything else →
 *     `'unknown'`. A timeout is the absence of an answer (law 4), so it is never `'none'`.
 *   - `unknownEffectError` — what a series that ends without an answer after ANY attempt of unknown effect fails
 *     with, in place of the attempt's own error (its `cause`).
 *   - `interruptProblem` — a keyless touching stage may not be re-run by an `interrupt()` resume.
 */

import { idempotencyKeyProblem } from '../ids/idempotencyKey.js';
import { UnknownEffectError } from './errors.js';
import { attemptNameProblem } from './name.js';
import { attemptCeiling } from './policy.js';
import type { AttemptEffect, AttemptOutcome, AttemptRecord, CallOptions, RetryPolicy, StageTouches } from './types.js';

export { MAX_IDEMPOTENCY_KEY_LENGTH } from '../ids/idempotencyKey.js';

/**
 * What a touching runner series is told (`AttemptRunOptions.effect`): the system, the REAL key the attempts are made
 * under, and the key as records carry it (the run's served form; the real one when no rule applies).
 */
export interface EffectTarget {
  readonly system: string;
  readonly idempotencyKey?: string;
  readonly recordedKey?: string;
}

/** Why `retry` with `touches` breaks the law — the shared words of every door. */
function retriedWithoutKey(system: string, attempts: number): string {
  return (
    `touches "${system}" and may retry (attempts: ${attempts}) but declares no idempotencyKey — a retry of an ` +
    'outside effect without a key can apply it twice. Declare the key rule ' +
    `(.touches('${system}', { idempotencyKey: ({ args }) => \`order-\${args.orderId}\` })), or retry once.`
  );
}

/**
 * Why a touching declaration is refused, or `undefined` when it is admitted: `touches` must be `{ system,
 * idempotencyKey? }` with `system` a name and the key rule a function; and a target that may retry (`retry`'s
 * ceiling above 1) must declare the key rule.
 */
export function touchesProblem(touches: unknown, retry: Pick<RetryPolicy, 'attempts'> | undefined): string | undefined {
  if (touches === null || typeof touches !== 'object') {
    return 'touches must be { system, idempotencyKey? } — the outside system and the key rule';
  }
  const { system, idempotencyKey } = touches as Partial<StageTouches>;
  const nameProblem = attemptNameProblem(system);
  if (nameProblem !== undefined) return `touches.system ${nameProblem} — it is a name from code, never a value`;
  if (idempotencyKey !== undefined && typeof idempotencyKey !== 'function') {
    return (
      'touches.idempotencyKey must be a function of the execution ((ctx) => string) — a constant key would make ' +
      'every run one operation'
    );
  }
  const attempts = attemptCeiling(retry?.attempts);
  if (attempts > 1 && idempotencyKey === undefined) return retriedWithoutKey(system as string, attempts);
  return undefined;
}

/** `value` as an idempotency key (`ids/idempotencyKey.ts`, the one rule), or a `TypeError` that names `where`. */
export function admitIdempotencyKey(where: string, value: unknown): string {
  const problem = idempotencyKeyProblem(value);
  if (problem !== undefined) {
    throw new TypeError(
      `${where}: idempotencyKey ${problem} (derive it from the input or the state, never from model output)`,
    );
  }
  return value as string;
}

/**
 * A `$call`'s side-effect declaration, admitted: `undefined` when it touches nothing; otherwise the system and the
 * key, refused with a `TypeError` naming `where` when malformed, when a key comes without a system, or when the
 * call may retry with no key — before anything is sent.
 */
export function callTouches(
  where: string,
  options: unknown,
  policy: Pick<RetryPolicy, 'attempts'>,
): { readonly system: string; readonly idempotencyKey?: string } | undefined {
  if (options === undefined) return undefined;
  if (options === null || typeof options !== 'object') {
    throw new TypeError(`${where}: options must be { touches?, idempotencyKey? }`);
  }
  const { touches, idempotencyKey } = options as CallOptions;
  if (touches === undefined) {
    if (idempotencyKey !== undefined) {
      throw new TypeError(`${where}: an idempotencyKey names an effect — declare the system it touches (touches)`);
    }
    return undefined;
  }
  const nameProblem = attemptNameProblem(touches);
  if (nameProblem !== undefined) {
    throw new TypeError(`${where}: touches ${nameProblem} — it is a name from code, never a value`);
  }
  const key = idempotencyKey === undefined ? undefined : admitIdempotencyKey(where, idempotencyKey);
  const attempts = attemptCeiling(policy.attempts);
  if (attempts > 1 && key === undefined) throw new TypeError(`${where}: ${retriedWithoutKey(touches, attempts)}`);
  return { system: touches, ...(key !== undefined && { idempotencyKey: key }) };
}

/** What an attempt that ended `outcome` (with `error`, when it failed) did to the outside system. */
export function effectOf(outcome: AttemptOutcome, error: unknown): AttemptEffect {
  if (outcome === 'ok') return 'applied';
  if (outcome === 'failed' && declaresNoEffect(error)) return 'none';
  return 'unknown';
}

/** The error itself says nothing was sent — `effect: 'none'`, read once; a value that cannot be read says nothing. */
function declaresNoEffect(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  try {
    return (error as { effect?: unknown }).effect === 'none';
  } catch {
    return false;
  }
}

/**
 * What a touching series fails with when any of its attempts left the effect unknown — never the attempt's own error,
 * which a caller would read as a failure and retry. The key is the RECORDED one: under a redaction rule that names
 * it, the error carries the placeholder, as every record does.
 */
export function unknownEffectError(target: EffectTarget, record: AttemptRecord, cause: unknown): UnknownEffectError {
  return new UnknownEffectError({
    system: target.system,
    ...(recordedKeyOf(target) !== undefined && { idempotencyKey: recordedKeyOf(target) }),
    attempts: record.attempt,
    cause,
  });
}

/** The key as records carry it: the served form when the caller gave one, else the key itself. */
export function recordedKeyOf(target: EffectTarget): string | undefined {
  return target.recordedKey ?? target.idempotencyKey;
}

/** The runner's refusal of a touching series that may retry with no key — the law, at the last door. */
export function refuseKeylessRetry(target: EffectTarget, attempts: number): void {
  if (attempts > 1 && target.idempotencyKey === undefined) {
    throw new TypeError(`[footprint] ${retriedWithoutKey(target.system, attempts)}`);
  }
}

/**
 * Why a touching stage may not be RE-RUN by an `interrupt()` resume, or `undefined` when it may (P3). A resume
 * re-runs the stage's function from its top — a second attempt of its effect — so the law that refuses a keyless
 * retry refuses a keyless re-run too. Asked when the stage interrupts (`StageRunner`) and when a checkpoint is
 * resumed (`runner/resume.ts · planResume`, for a checkpoint made by another version of the chart).
 */
export function interruptProblem(touches: StageTouches | undefined): string | undefined {
  if (touches === undefined || touches.idempotencyKey !== undefined) return undefined;
  return (
    `touches "${touches.system}" with no idempotencyKey, and a resume after interrupt() re-runs the stage from its ` +
    'top — a second attempt of the effect without a key. Declare the key rule, or interrupt in a stage of its own.'
  );
}

/** The touching declarations `resume()` builds around a key a checkpoint carried (`carriedTouches`). */
const CARRIED = new WeakSet<object>();

/**
 * The stand-in's declaration on a resume (P3): the paused stage's system, answering the key its checkpoint carried —
 * the OPERATIONAL value, real (checkpoints are exempt from redaction by law). It is marked, so the run serves it
 * like a key of unknown sources: under any state rule the records carry the placeholder (`isCarriedTouches`) — the
 * resumed leg no longer holds the input the key was made of, so it cannot tell whether the key was masked.
 */
export function carriedTouches(system: string, key: string): StageTouches {
  const touches = Object.freeze({ system, idempotencyKey: () => key });
  CARRIED.add(touches);
  return touches;
}

/** The declaration answers a key a checkpoint carried ({@link carriedTouches}). */
export function isCarriedTouches(touches: unknown): boolean {
  return typeof touches === 'object' && touches !== null && CARRIED.has(touches);
}
