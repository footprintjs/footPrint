/**
 * attempt/record.ts — how an `AttemptRecord` holds what it holds: frozen to its leaves, and an error only as the run
 * SERVES it, named fields only. One owner, so a record the runner makes (`runner.ts`) and a record an adapter
 * reports (`observed.ts`) can never differ in what they keep.
 */

import type { StructuredErrorInfo } from '../errors/errorInfo.js';
import type { AttemptError } from './types.js';

/** The record's copy of a served error: its named fields only — never `raw`, never an extra own key. */
export function recordedError(served: StructuredErrorInfo): AttemptError {
  return {
    message: served.message,
    ...(served.name !== undefined && { name: served.name }),
    ...(served.code !== undefined && { code: served.code }),
    ...(served.issues !== undefined && { issues: served.issues.map((issue) => ({ ...issue, path: [...issue.path] })) }),
  };
}

/** Freeze a record built of plain objects and arrays, to its leaves. */
export function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) freezeDeep((value as Record<string, unknown>)[key]);
  }
  return value;
}
