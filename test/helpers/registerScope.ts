import type { ScopeRuntimeTarget } from '../../src/lib/scope/runtime';
import { registerScopeRuntime } from '../../src/lib/scope/runtime';

/** Plain legacy test fixtures explicitly expose their existing method port. */
export function registerTestScope<T extends object>(scope: T): T {
  return registerScopeRuntime(scope, { target: scope as T & ScopeRuntimeTarget, handlesAssignments: false });
}
