/**
 * Registry — Central registry for scope provider resolvers
 *
 * Maintains a list of registered resolvers. Resolvers are checked in
 * registration order (first match wins). Built-in resolvers (class, factory)
 * are checked last as fallback.
 */
import type { ProviderResolver, ResolveOptions, ScopeProvider } from './types.js';
export declare function registerScopeResolver(resolver: ProviderResolver): void;
export declare function __clearScopeResolversForTests(): void;
export declare function resolveScopeProvider<TScope>(input: unknown, options?: ResolveOptions): ScopeProvider<TScope>;
