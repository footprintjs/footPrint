/**
 * registry.ts
 *
 * WHY: Central registry for scope provider resolvers. Allows plugins to register
 * custom resolvers that can handle different input types (e.g., Zod schemas).
 *
 * RESPONSIBILITIES:
 * - Maintain a list of registered resolvers
 * - Resolve arbitrary inputs to ScopeProviders using registered resolvers
 * - Provide built-in resolution for classes extending BaseState and factory functions
 *
 * DESIGN DECISIONS:
 * - Resolvers are checked in registration order (first match wins)
 * - Built-in resolvers (class, factory) are checked last as fallback
 * - Test helper __clearScopeResolversForTests prevents cross-test pollution
 *
 * RELATED:
 * - {@link resolve.ts} - Public API that uses this registry
 * - {@link guards.ts} - Heuristics for detecting classes vs factories
 * - {@link providers.ts} - Factory functions for creating providers
 */

import { isSubclassOfStateScope, looksLikeClassCtor, looksLikeFactory } from './guards';
import { makeClassProvider, makeFactoryProvider } from './providers';
import type { ProviderResolver, ResolveOptions, ScopeProvider } from './types';

const resolvers: ProviderResolver[] = [];

export function registerScopeResolver(resolver: ProviderResolver) {
  resolvers.push(resolver);
}

// TEST-ONLY helper to avoid cross-test pollution
export function __clearScopeResolversForTests() {
  resolvers.splice(0, resolvers.length);
}

function resolveBuiltin<TScope>(input: unknown): ScopeProvider<TScope> | undefined {
  // Only allow classes that extend BaseState
  if (looksLikeClassCtor(input) && isSubclassOfStateScope(input)) {
    return makeClassProvider(input as any);
  }
  if (looksLikeFactory(input)) {
    return makeFactoryProvider(input as any);
  }
  return undefined;
}

export function resolveScopeProvider<TScope>(input: unknown, options?: ResolveOptions): ScopeProvider<TScope> {
  for (const r of resolvers) {
    if (r.canHandle(input)) return r.makeProvider(input, options);
  }
  const built = resolveBuiltin<TScope>(input);
  if (built) return built;

  throw new Error(
    'Unsupported scope input. Provide a factory function, a class extending BaseState, or register a resolver plugin.',
  );
}
