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
 *   - `unknownEffectError` — what a series whose last attempt's effect is unknown fails with, in place of the
 *     attempt's own error (its `cause`).
 */

import { UnknownEffectError } from './errors.js';
import { attemptNameProblem } from './name.js';
import { attemptCeiling } from './policy.js';
import type { AttemptEffect, AttemptOutcome, AttemptRecord, CallOptions, RetryPolicy, StageTouches } from './types.js';

/** The longest idempotency key — Stripe's limit, and well inside every header limit. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** Printable ASCII with no space: what a request header carries without escaping. */
const KEY_CHARACTERS = /^[\x21-\x7e]+$/;

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

/** `value` as an idempotency key, or a `TypeError` that names `where` (never the value). */
export function admitIdempotencyKey(where: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new TypeError(
      `${where}: idempotencyKey must be a string of 1–${MAX_IDEMPOTENCY_KEY_LENGTH} characters ` +
        '(derive it from the input or the state, never from model output)',
    );
  }
  if (!KEY_CHARACTERS.test(value)) {
    throw new TypeError(
      `${where}: idempotencyKey must be printable ASCII with no space or control character — it travels in a ` +
        'request header',
    );
  }
  return value;
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
 * What a touching series fails with when its last attempt's effect is unknown — never the attempt's own error,
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
