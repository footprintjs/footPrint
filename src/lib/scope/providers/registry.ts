/**
 * Registry — Central registry for scope provider resolvers
 *
 * Maintains a list of registered resolvers. Resolvers are checked in
 * registration order (first match wins). Built-in resolvers (class, factory)
 * are checked last as fallback.
 */

import { isSubclassOfScopeFacade, looksLikeClassCtor, looksLikeFactory } from './guards.js';
import { makeClassProvider, makeFactoryProvider } from './providers.js';
import type { ProviderResolver, ResolveOptions, ScopeProvider } from './types.js';

const resolvers: ProviderResolver[] = [];

export function registerScopeResolver(resolver: ProviderResolver) {
  resolvers.push(resolver);
}

export function __clearScopeResolversForTests() {
  resolvers.splice(0, resolvers.length);
}

function resolveBuiltin<TScope>(input: unknown): ScopeProvider<TScope> | undefined {
  if (looksLikeClassCtor(input) && isSubclassOfScopeFacade(input)) {
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
    'Unsupported scope input. Provide a factory function, a class extending ScopeFacade, or register a resolver plugin.',
  );
}
