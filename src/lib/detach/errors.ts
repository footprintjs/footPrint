/**
 * The one rule every detach driver uses to turn a thrown value into the
 * `Error` a failed handle carries. It never throws: a value that cannot even
 * be described (a null-prototype object, a hostile or revoked Proxy) still
 * settles the handle as failed.
 */

import { extractErrorInfo } from '../errors/errorInfo.js';

export function asError(error: unknown): Error {
  try {
    if (error instanceof Error) return error;
    return new Error(extractErrorInfo(error).message);
  } catch {
    // Even classification can invoke user code (for example a revoked
    // or stateful Proxy). Describing a refusal must not prevent it from
    // settling the handle. Do not inspect the thrown value again here.
    return new Error('Detached work failed; its thrown value could not be described.');
  }
}
