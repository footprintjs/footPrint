/**
 * Report a tool-declared failure when its native settlement commits.
 * @module footprintjs/declared-attempts
 */
import { declaredFailureScope, declaredWriteObserver } from './lib/attempt/declared.js';
import type { DeclaredFailures } from './lib/attempt/types.js';
import { hasNativeRunTarget, scopeRuntimeFor } from './lib/scope/runtime.js';
import type { ScopeFacade } from './lib/scope/ScopeFacade.js';

export type { DeclaredDispatch, DeclaredFailures, DeclaredSettlement } from './lib/attempt/types.js';

const scopes = new WeakMap<ScopeFacade, DeclaredFailures>();

/** Bind declared tool failures to writes made by this native stage invocation. */
export function declaredFailures(scope: unknown): DeclaredFailures {
  const target = scopeRuntimeFor(scope)?.target as ScopeFacade | undefined;
  if (!target || typeof target.declaredFailureOwner !== 'function')
    throw new TypeError('declaredFailures: a native stage scope is required');
  const existing = scopes.get(target);
  if (existing) return existing;
  const owner = target.declaredFailureOwner();
  if (!hasNativeRunTarget(target, owner.context))
    throw new TypeError('declaredFailures: a native stage scope is required');
  const observer = declaredWriteObserver();
  const failures = declaredFailureScope({
    ...owner,
    stage(key, value, writes) {
      owner.context.useDeclaredWrites(observer);
      owner.stage(key, value, writes);
    },
  });
  scopes.set(target, failures);
  return failures;
}
