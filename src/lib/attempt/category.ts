/**
 * attempt/category.ts — `errorCategory`, the ONE failure classifier (design §3.9).
 *
 * Seven fixed values, so every recorder — the narrative, the metric layer, an agent's own — breaks failures down
 * the same way; a recorder never invents a category of its own. Borrowed from agentfootprint's
 * `classifyRetryReason` and widened, so its decorators adopt this one rather than keep theirs.
 *
 * Category is EVIDENCE, never policy: the default `retryOn` retries every category. A chart that wants "never
 * retry a permanent failure" says so: `retryOn: (e) => errorCategory(e) !== 'permanent'`.
 *
 * Precedence — what the failure LOOKED like wins over what it declares:
 *   1. the attempt's own timer (outcome `'timeout'`, or our `AttemptTimeoutError`)  → timeout
 *   2. the run's signal ended it (outcome `'aborted'`)                              → unknown
 *   3. status 429, or a declared `retryAfterMs` / `retryAfterSeconds`               → rate-limited
 *   4. status 5xx                                                                   → server
 *   5. status 401 / 403                                                             → auth
 *   6. any other 4xx                                                                → permanent
 *   7. `retryable: false`, or a validation error                                    → permanent
 *   8. a transport failure (a socket code on the error or its cause, a fetch
 *      `TypeError`, an `AbortError` / `TimeoutError` that was not the run's)        → network
 *   9. anything else                                                                → unknown
 *
 * A status is a NUMBER (`status` or `statusCode`); a numeric string is not read as one. Total: a value whose
 * reads throw (a hostile Proxy) is `'unknown'`, never a second throw from an error path.
 */

import { InputValidationError } from '../schema/errors.js';
import { AttemptTimeoutError, UnknownEffectError } from './errors.js';
import type { AttemptCategory, AttemptOutcome } from './types.js';

/** Socket-level codes a transport failure carries (Node's `errno` names). */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
]);

/** The messages runtimes give a `fetch` that never reached the server (Node, Chromium, Firefox, Safari). */
const FETCH_FAILURE = /^(fetch failed|failed to fetch|networkerror when attempting to fetch resource\.?|load failed)$/i;

/** Error names that say a validation failed — retrying the same input cannot succeed. */
const VALIDATION_NAMES: ReadonlySet<string> = new Set(['ValidationError', 'ZodError', 'InputValidationError']);

/** Error names of an abort or a timeout that some OTHER signal raised (the run's own ends as outcome `'aborted'`). */
const TRANSPORT_ABORT_NAMES: ReadonlySet<string> = new Set(['AbortError', 'TimeoutError']);

/**
 * The category of an attempt's failure. `outcome` is how the attempt ended (default `'failed'`): it decides
 * `'timeout'` (the attempt's own timer) and `'unknown'` (the run's signal) before the error is read.
 */
export function errorCategory(error: unknown, outcome: AttemptOutcome = 'failed'): AttemptCategory {
  if (outcome === 'timeout') return 'timeout';
  if (outcome === 'aborted') return 'unknown';
  try {
    return categoryOf(error);
  } catch {
    return 'unknown';
  }
}

/**
 * @internal Terminal ownership preserves a producer's known category. An
 * unresolved effect is unknown, never the category of its physical cause.
 * This does not rewrite historical attempt categories or re-read a known one.
 */
export function terminalCategory(error: unknown, known?: AttemptCategory): AttemptCategory {
  try {
    if (error instanceof UnknownEffectError) return 'unknown';
  } catch {
    return known ?? 'unknown';
  }
  return known ?? errorCategory(error);
}

function categoryOf(error: unknown): AttemptCategory {
  if (error instanceof AttemptTimeoutError) return 'timeout';
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return 'unknown';
  const fields = error as Record<string, unknown>;

  const status = numberField(fields, 'status') ?? numberField(fields, 'statusCode');
  const declaresRetryAfter = isWait(fields.retryAfterMs) || isWait(fields.retryAfterSeconds);
  if (status === 429 || declaresRetryAfter) return 'rate-limited';
  if (status !== undefined && status >= 500 && status <= 599) return 'server';
  if (status === 401 || status === 403) return 'auth';
  if (status !== undefined && status >= 400 && status <= 499) return 'permanent';

  if (fields.retryable === false) return 'permanent';
  if (error instanceof InputValidationError) return 'permanent';
  const name = typeof fields.name === 'string' ? fields.name : undefined;
  if (name !== undefined && VALIDATION_NAMES.has(name)) return 'permanent';

  if (status === undefined && isTransportFailure(fields, name)) return 'network';
  return 'unknown';
}

function isTransportFailure(fields: Record<string, unknown>, name: string | undefined): boolean {
  if (hasNetworkCode(fields.code)) return true;
  const cause = fields.cause;
  if (cause !== null && typeof cause === 'object' && hasNetworkCode((cause as Record<string, unknown>).code)) {
    return true;
  }
  if (name !== undefined && TRANSPORT_ABORT_NAMES.has(name)) return true;
  return fields instanceof TypeError && typeof fields.message === 'string' && FETCH_FAILURE.test(fields.message);
}

function hasNetworkCode(code: unknown): boolean {
  return typeof code === 'string' && NETWORK_CODES.has(code);
}

function numberField(fields: Record<string, unknown>, key: 'status' | 'statusCode'): number | undefined {
  const value = fields[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isWait(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
